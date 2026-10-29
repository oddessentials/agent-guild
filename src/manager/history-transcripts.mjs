// Saved conversations for the History preview, newest page first, in whole visible messages.
// A cursor checks the file's first bytes and those around its offset, so appends keep it valid.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { antigravityUserConversation } from '../report/hooks.mjs';
import { historyError, transcriptFile, transcriptMessage } from './antigravity-transcript.mjs';

export const PAGE_LIMITS = {
  messages: 40,
  scanBytes: 8 * 1024 * 1024,
  maxScanBytes: 32 * 1024 * 1024,
  maxLineBytes: 16 * 1024 * 1024,
  maxDecodedBytes: 64 * 1024 * 1024,
  chunkBytes: 256 * 1024,
};
const ANCHOR_BYTES = 4096;
const MAX_CURSOR = 2048;
/** The wrappers Claude Code puts around text it inserted as a user record, in records from before `origin`. */
const CLAUDE_INSERTED = /^<(command-name|local-command-stdout|bash-input|bash-stdout|bash-stderr)>/;

const changed = () => historyError(409, 'history_changed', 'The conversation changed. Refresh to read it again.');
const badCursor = () => historyError(400, 'bad_history_cursor', 'Invalid conversation page.');
const unavailable = () => historyError(404, 'history_unavailable', 'This conversation transcript is unavailable.');
const tooLarge = () => historyError(413, 'history_too_large', 'This compressed conversation is too large to preview.');

/** Codex compresses rollouts at level 3, whose window is 2 MiB; a frame asking for more than 8 MiB is refused. */
export function zstdDecoder() {
  return zlib.createZstdDecompress({ params: { [zlib.constants.ZSTD_d_windowLogMax]: 23 } });
}

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 24);
}

function safeInteger(value, min = 0) {
  return Number.isSafeInteger(value) && value >= min;
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(cursor, source, id) {
  if (typeof cursor !== 'string' || !cursor || cursor.length > MAX_CURSOR) throw badCursor();
  let value;
  try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { /* invalid below */ }
  if (!value || value.v !== 1 || value.s !== source || value.i !== id || typeof value.st !== 'object' || value.st === null) throw badCursor();
  return value;
}

/** Reject a file outside the tool's folder, or one reached through a link below it. */
export async function checkedFile(root, file) {
  let current;
  try { current = await fs.promises.realpath(root); } catch { throw unavailable(); }
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw unavailable();
  const parts = rel.split(path.sep);
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part);
    let stat;
    try { stat = await fs.promises.lstat(current); } catch { throw unavailable(); }
    if (stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw unavailable();
  }
  return current;
}

// ---- byte sources -------------------------------------------------------------

async function plainSource(file) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    return {
      size,
      async read(position, length) {
        const buffer = Buffer.alloc(Math.max(0, length));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        return buffer.subarray(0, bytesRead);
      },
      close: () => handle.close(),
    };
  } catch (err) {
    await handle.close();
    throw err;
  }
}

/**
 * A compressed rollout is decoded to a private temporary file, removed when the page is read; offsets address the
 * decoded JSONL. Decoding stops once it passes the limit.
 */
async function openSource(file, limits) {
  let target = file;
  try { await fs.promises.access(target); } catch {
    // Codex compresses a cold rollout, and decompresses one to resume it, under the other name.
    const other = target.endsWith('.zst') ? target.slice(0, -4) : `${target}.zst`;
    try { await fs.promises.access(other); target = other; } catch { throw unavailable(); }
  }
  if (!target.endsWith('.zst')) return plainSource(target).catch(() => { throw unavailable(); });
  if (typeof zlib.createZstdDecompress !== 'function') throw unavailable();
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-guild-rollout-'));
  const remove = () => fs.promises.rm(dir, { recursive: true, force: true });
  try {
    const decoded = path.join(dir, 'rollout.jsonl');
    const bounded = async function* (chunks) {
      let size = 0;
      for await (const chunk of chunks) {
        size += chunk.length;
        if (size > limits.maxDecodedBytes) throw tooLarge();
        yield chunk;
      }
    };
    await pipeline(fs.createReadStream(target), zstdDecoder(), bounded, fs.createWriteStream(decoded, { flags: 'wx', mode: 0o600 }));
    const source = await plainSource(decoded);
    return { ...source, close: async () => { try { await source.close(); } finally { await remove(); } } };
  } catch (err) {
    await remove();
    throw err.code === 'history_too_large' ? err : unavailable();
  }
}

async function anchors(source, offset, end) {
  const hl = Math.min(ANCHOR_BYTES, source.size);
  const as = Math.max(0, offset - ANCHOR_BYTES);
  const ae = Math.min(end, offset + ANCHOR_BYTES);
  return { hl, hh: digest(await source.read(0, hl)), as, ae, ah: digest(await source.read(as, ae - as)) };
}

async function verify(source, cursor) {
  if (!safeInteger(cursor.o) || !safeInteger(cursor.as) || !safeInteger(cursor.ae) || !safeInteger(cursor.hl)
    || typeof cursor.hh !== 'string' || typeof cursor.ah !== 'string' || cursor.as > cursor.o || cursor.ae < cursor.o) throw badCursor();
  if (source.size < cursor.ae || source.size < cursor.hl) throw changed();
  if (digest(await source.read(0, cursor.hl)) !== cursor.hh) throw changed();
  if (digest(await source.read(cursor.as, cursor.ae - cursor.as)) !== cursor.ah) throw changed();
}

/** Where the last whole line ends, or null when the partial line after it is already too long to read. */
async function lastLineEnd(source, limits) {
  let position = source.size;
  while (position > 0) {
    if (source.size - position > limits.maxLineBytes) return null;
    const length = Math.min(limits.chunkBytes, position);
    const chunk = await source.read(position - length, length);
    const newline = chunk.lastIndexOf(10);
    if (newline >= 0) {
      const end = position - length + newline + 1;
      return source.size - end > limits.maxLineBytes ? null : end;
    }
    position -= length;
  }
  return source.size > limits.maxLineBytes ? null : 0;
}

/** Lines before `end`, newest first. A line longer than the limit ends them, with `bytes` null, before more of it is read. */
async function* linesBackward(source, end, limits) {
  let position = end;
  let tail = [];
  let tailSize = 0;
  while (position > 0) {
    const length = Math.min(limits.chunkBytes, position);
    position -= length;
    const chunk = await source.read(position, length);
    let lineEnd = chunk.length;
    for (let i = chunk.lastIndexOf(10, lineEnd - 1); i >= 0; i = lineEnd > 0 ? chunk.lastIndexOf(10, lineEnd - 1) : -1) {
      const size = lineEnd - i - 1 + tailSize;
      if (size > limits.maxLineBytes) {
        yield { offset: null, size, bytes: null };
        return;
      }
      yield { offset: position + i + 1, size, bytes: Buffer.concat([chunk.subarray(i + 1, lineEnd), ...tail]) };
      tail = [];
      tailSize = 0;
      lineEnd = i;
    }
    tailSize += lineEnd;
    if (tailSize > limits.maxLineBytes) {
      yield { offset: null, size: tailSize, bytes: null };
      return;
    }
    tail.unshift(chunk.subarray(0, lineEnd));
  }
  if (tailSize > 0) yield { offset: 0, size: tailSize, bytes: Buffer.concat(tail) };
}

async function readFirstRecord(source, limits) {
  const head = await source.read(0, Math.min(source.size, limits.maxLineBytes));
  const newline = head.indexOf(10);
  try { return JSON.parse(head.subarray(0, newline < 0 ? head.length : newline).toString('utf8')); } catch { return null; }
}

/**
 * One page of a JSONL transcript, read backwards from the cursor. A reader turns
 * records into messages, newest first:
 * - `starts(state, record)`: the record begins a message, so the page may stop before it;
 * - `take(state, record)`: consume it;
 * - `open(state)`: a message is unfinished, so the page may not stop;
 * - `flush(state, atStart)`: finish the open message;
 * - `done(state)`: nothing older belongs to the conversation; `failed` says it cannot be shown truthfully;
 * - `cursor(state)`: what the next page needs;
 * - `skipsCorrupt`: a record that is not JSON is passed over, as the tool passes over it, instead of ending the history.
 * A line too long to read, or a message that does not end within the most a page reads, ends the readable history
 * there: the unfinished message is dropped and the page says it is `truncated`.
 */
export async function readJsonlPage({ source: kind, id, file, cursor, reader, firstRecord = null, limits = PAGE_LIMITS, open = openSource }) {
  const saved = cursor ? decodeCursor(cursor, kind, id) : null;
  const source = await open(file, limits);
  try {
    if (firstRecord && !firstRecord(await readFirstRecord(source, limits))) throw unavailable();
    let end, incomplete = false;
    if (saved) {
      await verify(source, saved);
      end = saved.o;
    } else {
      end = await lastLineEnd(source, limits);
      if (end === null) return { id, messages: [], nextCursor: null, incomplete: true, omitted: false, truncated: true };
      incomplete = end < source.size;
    }
    const before = await anchors(source, end, end);
    const state = { messages: [], omitted: false, failed: false, ...reader.start(saved?.st ?? null) };
    let last = end, scanned = 0, more = false, truncated = false;
    for await (const line of linesBackward(source, end, limits)) {
      const unfinished = reader.open(state);
      if (line.bytes === null || (unfinished && scanned >= limits.maxScanBytes)) {
        truncated = true;
        break;
      }
      if (!line.size) { last = line.offset; continue; }
      let record = null, parsed = true;
      try { record = JSON.parse(line.bytes.toString('utf8')); } catch { parsed = false; }
      if (typeof record !== 'object') record = null;
      if ((!unfinished && scanned >= limits.scanBytes)
        || (record && reader.starts(state, record) && (state.messages.length >= limits.messages || scanned >= limits.scanBytes))) {
        more = true;
        break;
      }
      if (!parsed) {
        state.omitted = true;
        if (!reader.skipsCorrupt) {
          truncated = true;
          break;
        }
      } else if (record) reader.take(state, record);
      scanned += line.size + 1;
      last = line.offset;
      if (reader.done(state)) break;
    }
    if (!truncated) reader.flush(state, !more);
    if (state.failed) throw unavailable();
    if (more && last >= end) throw unavailable();
    const after = await anchors(source, end, end);
    if (after.hh !== before.hh || after.ah !== before.ah) throw changed();
    const nextCursor = more ? encodeCursor({ v: 1, s: kind, i: id, o: last, ...(await anchors(source, last, end)), st: reader.cursor(state) }) : null;
    if (nextCursor && nextCursor.length > MAX_CURSOR) throw unavailable();
    return { id, messages: state.messages.reverse(), nextCursor, incomplete, omitted: state.omitted, truncated };
  } finally {
    await source.close();
  }
}

function clean(text) {
  return typeof text === 'string' ? text.trim() : '';
}

// ---- Claude Code ----------------------------------------------------------------

/** The text of a prompt the user wrote, or null for any other record. */
export function claudePrompt(record) {
  if (record?.type !== 'user' || record.isMeta === true || record.isCompactSummary === true) return null;
  const origin = record.origin && typeof record.origin === 'object' ? record.origin.kind : undefined;
  if (origin !== undefined && origin !== 'human') return null;
  const content = record.message?.content;
  let text;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content) && !content.some((part) => part?.type === 'tool_result')) {
    text = content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
  } else return null;
  const value = clean(text);
  if (origin === undefined && CLAUDE_INSERTED.test(value)) return null;
  return value && !value.startsWith('[Request interrupted by user') ? value : null;
}

function claudeReplyText(record) {
  const content = record.message?.content;
  if (typeof content === 'string') return clean(content);
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text.trim()).filter(Boolean).join('\n\n');
}

function claudeMessageId(record) {
  return record.type === 'assistant' && typeof record.message?.id === 'string' ? record.message.id : null;
}

/**
 * Claude Code keeps every branch in one file. The conversation it resumes runs
 * from the newest message back through `parentUuid`, and across a compaction
 * through `logicalParentUuid`; records off that chain were rewound away. One
 * reply is several records sharing `message.id`.
 */
export const claudeReader = {
  skipsCorrupt: true,
  start: (saved) => ({ leaf: saved?.f === true, expected: typeof saved?.u === 'string' ? saved.u : null, root: false, reply: null }),
  onChain(s, record) {
    if (record.isSidechain === true || typeof record.uuid !== 'string') return false;
    return s.leaf ? record.uuid === s.expected : record.type === 'user' || record.type === 'assistant';
  },
  starts(s, record) {
    if (!s.leaf) return record.type === 'last-prompt' || this.onChain(s, record);
    if (!this.onChain(s, record)) return false;
    if (claudePrompt(record) !== null) return true;
    const messageId = claudeMessageId(record);
    return messageId !== null && messageId !== s.reply?.id;
  },
  take(s, record) {
    if (!s.leaf) {
      if (record.type === 'last-prompt' && typeof record.leafUuid === 'string') {
        s.leaf = true;
        s.expected = record.leafUuid;
        return;
      }
      if (!this.onChain(s, record)) return;
      s.leaf = true;
      s.expected = record.uuid;
    }
    if (!this.onChain(s, record)) return;
    s.expected = record.parentUuid || record.logicalParentUuid || null;
    s.root = s.expected === null;
    const prompt = claudePrompt(record);
    if (prompt !== null) {
      this.flush(s);
      s.messages.push({ role: 'user', text: prompt });
      return;
    }
    const messageId = claudeMessageId(record);
    if (messageId === null) return;
    if (s.reply?.id !== messageId) {
      this.flush(s);
      s.reply = { id: messageId, parts: [] };
    }
    const text = claudeReplyText(record);
    if (text) s.reply.parts.unshift(text);
  },
  open: (s) => s.reply !== null,
  flush(s, atStart = false) {
    // A chain that never reaches its root lost a record: the reply waiting on it may be missing a part.
    if (atStart && s.leaf && !s.root && s.expected !== null) s.omitted = true;
    else if (s.reply?.parts.length) s.messages.push({ role: 'assistant', text: s.reply.parts.join('\n\n') });
    s.reply = null;
  },
  done: (s) => s.root,
  cursor: (s) => ({ f: s.leaf, u: s.expected }),
};

// ---- Codex CLI --------------------------------------------------------------------

/**
 * A message as Codex shows it: older rollouts carry `user_message` and `agent_message` events, newer ones
 * `item_completed` items. The `response_item` copies also hold the context Codex inserts, so they are never read.
 */
export function codexMessage(record) {
  const payload = record?.type === 'event_msg' ? record.payload : null;
  if (!payload || typeof payload !== 'object') return null;
  if (payload.type === 'user_message') return { role: 'user', text: clean(payload.message) };
  if (payload.type === 'agent_message') return { role: 'assistant', text: clean(payload.message) };
  if (payload.type !== 'item_completed') return null;
  const item = payload.item;
  const text = Array.isArray(item?.content) ? item.content.filter((part) => typeof part?.text === 'string').map((part) => part.text).join('\n') : '';
  if (item?.type === 'UserMessage') return { role: 'user', text: clean(text) };
  if (item?.type === 'AgentMessage') return { role: 'assistant', text: clean(text) };
  return null;
}

function codexRollback(record) {
  return record.type === 'event_msg' && record.payload?.type === 'thread_rolled_back';
}

/** One rollout has one kind of message. A legacy `thread_rolled_back` dropped the user turns before it. */
export const codexReader = {
  skipsCorrupt: true,
  start: (saved) => ({ drop: safeInteger(saved?.d) ? saved.d : 0 }),
  starts: (s, record) => codexRollback(record) || codexMessage(record) !== null,
  take(s, record) {
    if (codexRollback(record)) {
      if (safeInteger(record.payload.num_turns)) s.drop += record.payload.num_turns;
      return;
    }
    const message = codexMessage(record);
    if (!message) return;
    if (s.drop > 0) {
      if (message.role === 'user') s.drop--;
      return;
    }
    if (message.text) s.messages.push(message);
  },
  open: () => false,
  flush: () => {},
  done: () => false,
  cursor: (s) => (s.drop ? { d: s.drop } : {}),
};

// ---- Grok Build -------------------------------------------------------------------

function grokUpdate(record) {
  const update = record?.params?.update;
  return update && typeof update === 'object' ? update : null;
}

/** What a turn does after its prompt; read backwards, any of it ends the turn before. */
export const GROK_TURN_ACTIVITY = new Set(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'turn_completed', 'rewind_marker']);

/**
 * A chunk of a prompt: the key its chunks share, whether text or image, its index, whether the prompt is one Grok
 * Build hides or ran itself, and its text if it has any. Grok Build 1.0.70 numbers chunks with promptIndex; earlier
 * versions gave them a promptId.
 */
export function grokPromptChunk(record) {
  const update = grokUpdate(record);
  if (update?.sessionUpdate !== 'user_message_chunk') return null;
  return {
    key: update._meta?.promptIndex ?? record.params._meta?.promptId ?? null,
    index: update._meta?.promptIndex,
    hidden: Boolean(update.content?._meta?.bash_command) || update._meta?.host_turn === true || update._meta?.hideFromScrollback === true,
    text: update.content?.type === 'text' && typeof update.content.text === 'string' ? update.content.text : null,
  };
}

/**
 * A turn is the user's prompt and the replies after it; a tool call ends a reply, and only text shows. Records such
 * as `image_dropped` can sit between a prompt's chunks. A rewind leaves the old turns in `updates.jsonl` and appends
 * a `rewind_marker`: read backwards, every turn at or above the lowest target passed so far was discarded. A record
 * that is not JSON may have been a rewind or part of a prompt, so it ends the history.
 */
export const grokReader = {
  skipsCorrupt: false,
  start: (saved) => ({ cut: safeInteger(saved?.c) ? saved.c : null, turn: null }),
  continues: (s, record, update) => {
    const chunk = grokPromptChunk(record);
    return chunk ? chunk.key === s.turn.key : !GROK_TURN_ACTIVITY.has(update.sessionUpdate);
  },
  starts(s, record) {
    const update = grokUpdate(record);
    if (!update) return false;
    if (!s.turn) return true;
    return s.turn.user && (update.sessionUpdate === 'rewind_marker' || !this.continues(s, record, update));
  },
  take(s, record) {
    const update = grokUpdate(record);
    if (!update) return;
    if (s.turn?.user && !this.continues(s, record, update)) this.flush(s);
    if (update.sessionUpdate === 'rewind_marker') {
      if (safeInteger(update.target_prompt_index)) s.cut = s.cut === null ? update.target_prompt_index : Math.min(s.cut, update.target_prompt_index);
      return;
    }
    s.turn ??= { user: false, key: null, index: undefined, hidden: false, prompt: [], replies: [], reply: null };
    const turn = s.turn;
    const chunk = grokPromptChunk(record);
    if (chunk) {
      turn.user = true;
      turn.reply = null;
      turn.key = chunk.key;
      turn.index = chunk.index;
      if (chunk.hidden) turn.hidden = true;
      else if (chunk.text !== null) turn.prompt.unshift(chunk.text);
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      turn.reply = null;
    } else if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      if (!turn.reply) {
        turn.reply = [];
        turn.replies.unshift(turn.reply);
      }
      turn.reply.unshift(update.content.text);
    }
  },
  open: (s) => s.turn !== null,
  flush(s) {
    const turn = s.turn;
    s.turn = null;
    if (!turn) return;
    const replies = turn.replies.map((parts) => clean(parts.join(''))).filter(Boolean);
    const prompt = turn.hidden ? '' : clean(turn.prompt.join(''));
    if (!replies.length && !prompt) return;
    if (s.cut !== null) {
      if (!safeInteger(turn.index)) { s.failed = true; return; }
      if (turn.index >= s.cut) return;
    }
    for (const text of replies.reverse()) s.messages.push({ role: 'assistant', text });
    if (prompt) s.messages.push({ role: 'user', text: prompt });
  },
  done: (s) => s.failed,
  cursor: (s) => (s.cut !== null ? { c: s.cut } : {}),
};

// ---- Antigravity CLI ----------------------------------------------------------------

export const antigravityReader = {
  skipsCorrupt: true,
  start: () => ({}),
  starts: (s, record) => transcriptMessage(record) !== null,
  take(s, record) {
    const message = transcriptMessage(record);
    if (message) s.messages.push(message);
  },
  open: () => false,
  flush: () => {},
  done: () => false,
  cursor: () => ({}),
};

export const JSONL_READERS = {
  claude: { reader: claudeReader },
  codex: { reader: codexReader },
  grok: { reader: grokReader },
  antigravity: { reader: antigravityReader, firstRecord: antigravityUserConversation },
};

export async function readAntigravityTranscript(dir, id, cursor = null, limits = PAGE_LIMITS) {
  return readJsonlPage({ source: 'antigravity', id, file: await transcriptFile(dir, id), cursor, ...JSONL_READERS.antigravity, limits });
}

// ---- Docker Agent -------------------------------------------------------------------

/**
 * Docker Agent's own VisibleExchanges rule, worked out by SQLite: 1 for a message row that is not implicit, from the
 * user or the assistant, with no tool calls and text content; 0 for any other row; null for a row that might be shown
 * but is larger than `$max`. CASE stops at the first match, so no JSON function sees a row larger than `$max`.
 */
export const DOCKER_VISIBLE = `case
    when implicit or subsession_id is not null or message_json is null then 0
    when octet_length(message_json) > $max then null
    when not json_valid(message_json) then 0
    when coalesce(json_extract(message_json, '$.role') not in ('user', 'assistant'), 1) then 0
    when coalesce(json_array_length(message_json, '$.tool_calls'), 0) <> 0 then 0
    else coalesce(json_type(message_json, '$.content') = 'text', 0) end`;
const DOCKER_PAGE_SQL = (after) => `
  select id, position, octet_length(message_json) as size, visible,
    case when visible then json_extract(message_json, '$.role') end as role,
    case when visible then json_extract(message_json, '$.content') end as content
  from (select id, position, message_json, ${DOCKER_VISIBLE} as visible from session_items
    where session_id = $session and item_type = 'message'${after ? ' and position < $after' : ''})
  order by position desc`;

/** A page of a Docker Agent session, newest first, within the page's message and scan limits. */
export async function readDockerConversation({ dir, id, cursor, loadSqlite, limits = PAGE_LIMITS }) {
  const saved = cursor ? decodeCursor(cursor, 'docker', id) : null;
  if (saved && (!safeInteger(saved.p) || !safeInteger(saved.r, 1))) throw badCursor();
  const { DatabaseSync } = await loadSqlite();
  let db;
  try {
    try { db = new DatabaseSync(path.join(dir, 'session.db'), { readOnly: true }); } catch { throw unavailable(); }
    if (saved && db.prepare('select id from session_items where session_id = ? and position = ?').get(id, saved.p)?.id !== saved.r) throw changed();
    const messages = [];
    let last = null, scanned = 0, more = false, truncated = false;
    const params = { max: limits.maxLineBytes, session: id, ...(saved ? { after: saved.p } : {}) };
    for (const row of db.prepare(DOCKER_PAGE_SQL(saved)).iterate(params)) {
      if (last && (scanned >= limits.scanBytes || (row.visible && messages.length >= limits.messages))) {
        more = true;
        break;
      }
      if (row.visible === null) {
        truncated = true;
        break;
      }
      last = row;
      scanned += row.size ?? 0;
      if (row.visible && clean(row.content)) messages.push({ role: row.role, text: clean(row.content) });
    }
    return {
      id,
      messages: messages.reverse(),
      nextCursor: more ? encodeCursor({ v: 1, s: 'docker', i: id, p: last.position, r: last.id, st: {} }) : null,
      incomplete: false,
      omitted: false,
      truncated,
    };
  } catch (err) {
    if (err.status) throw err;
    throw unavailable();
  } finally {
    db?.close();
  }
}
