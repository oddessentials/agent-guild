// Saved conversations for the History preview, newest page first. A page holds
// whole visible messages only: prompts and replies, never thinking, tool calls
// or results, injected context, or turns the tool discarded. Each tool keeps
// its own records, so each has a reader; the JSONL ones share the backward
// paging here. A cursor checks the bytes around its offset and the file's first
// bytes, so appends keep it valid while a rewrite, a truncation or a replaced
// file refuses it.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { antigravityUserConversation } from '../report/hooks.mjs';
import { historyError, transcriptFile, transcriptMessage } from './antigravity-transcript.mjs';

export const PAGE_LIMITS = {
  messages: 40,
  /** Bytes read before a page stops at the next message. */
  scanBytes: 8 * 1024 * 1024,
  /** A message still unfinished after this many bytes is left out. */
  maxScanBytes: 32 * 1024 * 1024,
  /** Longer records are left out unparsed. */
  maxLineBytes: 4 * 1024 * 1024,
  chunkBytes: 256 * 1024,
  /** Docker Agent rows read for one page. */
  rows: 2000,
};
const ANCHOR_BYTES = 4096;
const MAX_CURSOR = 2048;
const TAG_RE = /^<[a-z][a-z0-9_-]*[\s>]/i;

const changed = () => historyError(409, 'history_changed', 'The conversation changed. Refresh to read it again.');
const badCursor = () => historyError(400, 'bad_history_cursor', 'Invalid conversation page.');
const unavailable = () => historyError(404, 'history_unavailable', 'This conversation transcript is unavailable.');

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
      floor: 0,
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
 * A zstd rollout, decoded as a stream. Offsets address the decoded JSONL, so a
 * cursor survives Codex swapping a file between `.jsonl` and `.jsonl.zst`.
 * Only the first bytes and a window before `stop` are kept; `floor` is where
 * that window starts.
 */
async function zstdSource(file, stop, window) {
  if (typeof zlib.createZstdDecompress !== 'function') throw unavailable();
  const head = [];
  let headSize = 0;
  const kept = [];
  let keptStart = 0, keptSize = 0, size = 0;
  const input = fs.createReadStream(file);
  try {
    for await (const chunk of input.pipe(zlib.createZstdDecompress())) {
      if (headSize < ANCHOR_BYTES) { head.push(chunk); headSize += chunk.length; }
      kept.push(chunk);
      keptSize += chunk.length;
      size += chunk.length;
      while (kept.length > 1 && keptSize - kept[0].length >= window) {
        keptStart += kept[0].length;
        keptSize -= kept[0].length;
        kept.shift();
      }
      if (stop !== null && size >= stop + ANCHOR_BYTES) break;
    }
  } catch {
    throw unavailable();
  } finally {
    input.destroy();
  }
  const first = Buffer.concat(head);
  const data = Buffer.concat(kept);
  return {
    size,
    floor: keptStart,
    async read(position, length) {
      if (position + length <= first.length) return first.subarray(position, position + length);
      return data.subarray(position - keptStart, position + length - keptStart);
    },
    close: async () => {},
  };
}

async function openSource(file, stop, limits) {
  let target = file;
  try { await fs.promises.access(target); } catch {
    // Codex compresses a cold rollout, and decompresses one to resume it, under the other name.
    const other = target.endsWith('.zst') ? target.slice(0, -4) : `${target}.zst`;
    try { await fs.promises.access(other); target = other; } catch { throw unavailable(); }
  }
  try {
    return target.endsWith('.zst') ? await zstdSource(target, stop, limits.maxScanBytes + 2 * ANCHOR_BYTES) : await plainSource(target);
  } catch (err) {
    if (err.status) throw err;
    throw unavailable();
  }
}

/** The bytes a cursor depends on: the file's first bytes and those around its offset, never past `end`. */
async function anchors(source, offset, end) {
  const hl = Math.min(ANCHOR_BYTES, source.size);
  const as = Math.max(source.floor, offset - ANCHOR_BYTES);
  const ae = Math.min(end, offset + ANCHOR_BYTES);
  return { hl, hh: digest(await source.read(0, hl)), as, ae, ah: digest(await source.read(as, ae - as)) };
}

async function verify(source, cursor) {
  if (!safeInteger(cursor.o) || !safeInteger(cursor.as) || !safeInteger(cursor.ae) || !safeInteger(cursor.hl)
    || typeof cursor.hh !== 'string' || typeof cursor.ah !== 'string' || cursor.as > cursor.o || cursor.ae < cursor.o) throw badCursor();
  if (source.size < cursor.ae || source.size < cursor.hl || cursor.as < source.floor) throw changed();
  if (digest(await source.read(0, cursor.hl)) !== cursor.hh) throw changed();
  if (digest(await source.read(cursor.as, cursor.ae - cursor.as)) !== cursor.ah) throw changed();
}

/** Where the newest complete line ends. A partial line after it is still being written. */
async function lastLineEnd(source, limits) {
  let position = source.size;
  while (position > source.floor && source.size - position < limits.maxScanBytes) {
    const length = Math.min(limits.chunkBytes, position - source.floor);
    const chunk = await source.read(position - length, length);
    const newline = chunk.lastIndexOf(10);
    if (newline >= 0) return position - length + newline + 1;
    position -= length;
  }
  return source.floor;
}

/** Lines ending at `end`, newest first, each with the offset it starts at; `floor` marks the end of a zstd window. */
async function* linesBackward(source, end, limits) {
  let position = end;
  let tail = [];
  let tailSize = 0;
  while (position > source.floor) {
    const length = Math.min(limits.chunkBytes, position - source.floor);
    position -= length;
    const chunk = await source.read(position, length);
    let lineEnd = chunk.length;
    for (let i = chunk.lastIndexOf(10, lineEnd - 1); i >= 0; i = lineEnd > 0 ? chunk.lastIndexOf(10, lineEnd - 1) : -1) {
      const size = lineEnd - i - 1 + tailSize;
      yield { offset: position + i + 1, size, bytes: size > limits.maxLineBytes ? null : Buffer.concat([chunk.subarray(i + 1, lineEnd), ...tail]) };
      tail = [];
      tailSize = 0;
      lineEnd = i;
    }
    tailSize += lineEnd;
    if (tailSize <= limits.maxLineBytes) tail.unshift(chunk.subarray(0, lineEnd));
  }
  if (source.floor > 0) yield { floor: true };
  else if (tailSize > 0) yield { offset: 0, size: tailSize, bytes: tailSize > limits.maxLineBytes ? null : Buffer.concat(tail) };
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
 * - `flush(state)`: finish the open message;
 * - `abandon(state)`: give up a message too long to finish, leaving the rest of it for the next page to skip;
 * - `done(state)`: nothing older belongs to the conversation; `failed` says it cannot be shown truthfully;
 * - `cursor(state)`: what the next page needs.
 */
export async function readJsonlPage({ source: kind, id, file, cursor, reader, firstRecord = null, limits = PAGE_LIMITS }) {
  const saved = cursor ? decodeCursor(cursor, kind, id) : null;
  const source = await openSource(file, saved && safeInteger(saved.ae) ? saved.ae : null, limits);
  try {
    if (firstRecord && !firstRecord(await readFirstRecord(source, limits))) throw unavailable();
    let end, incomplete = false;
    if (saved) {
      await verify(source, saved);
      end = saved.o;
    } else {
      end = await lastLineEnd(source, limits);
      incomplete = end < source.size;
    }
    const before = await anchors(source, end, end);
    const state = { messages: [], omitted: false, failed: false, ...reader.start(saved?.st ?? null) };
    let last = end, scanned = 0, more = false;
    for await (const line of linesBackward(source, end, limits)) {
      if (line.floor) { more = true; break; }
      if (!line.size) { last = line.offset; continue; }
      let record = null;
      if (line.bytes === null) state.omitted = true;
      else {
        try { record = JSON.parse(line.bytes.toString('utf8')); } catch { state.omitted = true; }
      }
      const open = reader.open(state);
      if ((!open && scanned >= limits.scanBytes)
        || (record && reader.starts(state, record) && (state.messages.length >= limits.messages || scanned >= limits.scanBytes))) {
        more = true;
        break;
      }
      if (open && scanned >= limits.maxScanBytes) {
        reader.abandon(state);
        state.omitted = true;
        more = true;
        break;
      }
      if (record && typeof record === 'object') reader.take(state, record);
      scanned += line.size + 1;
      last = line.offset;
      if (reader.done(state)) { more = false; break; }
    }
    reader.flush(state);
    if (state.failed) throw unavailable();
    const after = await anchors(source, end, end);
    if (after.hh !== before.hh || after.ah !== before.ah) throw changed();
    const nextCursor = more ? encodeCursor({ v: 1, s: kind, i: id, o: last, ...(await anchors(source, last, end)), st: reader.cursor(state) }) : null;
    if (nextCursor && nextCursor.length > MAX_CURSOR) throw unavailable();
    return { id, messages: state.messages.reverse(), nextCursor, incomplete, omitted: state.omitted };
  } finally {
    await source.close();
  }
}

function clean(text) {
  return typeof text === 'string' ? text.trim() : '';
}

/** A prompt the user typed; text that opens with a tag was inserted by the tool. */
function visiblePrompt(text) {
  const value = clean(text);
  return value && !TAG_RE.test(value) ? value : '';
}

// ---- Claude Code ----------------------------------------------------------------

function claudePrompt(record) {
  if (record.type !== 'user' || record.isMeta === true || record.isCompactSummary === true) return null;
  const content = record.message?.content;
  let text;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content) && !content.some((part) => part?.type === 'tool_result')) {
    text = content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
  } else return null;
  const value = visiblePrompt(text);
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
  start: (saved) => ({
    // Before the first record of the chain is found, the newest `last-prompt` or message names it.
    leaf: Boolean(saved), expected: typeof saved?.u === 'string' ? saved.u : null,
    skipId: typeof saved?.k === 'string' ? saved.k : null, root: false, reply: null,
  }),
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
      s.skipId = null;
      s.messages.push({ role: 'user', text: prompt });
      return;
    }
    const messageId = claudeMessageId(record);
    if (messageId === null) return;
    if (messageId === s.skipId) return;
    s.skipId = null;
    if (s.reply?.id !== messageId) {
      this.flush(s);
      s.reply = { id: messageId, parts: [] };
    }
    const text = claudeReplyText(record);
    if (text) s.reply.parts.unshift(text);
  },
  open: (s) => s.reply !== null,
  flush(s) {
    if (s.reply?.parts.length) s.messages.push({ role: 'assistant', text: s.reply.parts.join('\n\n') });
    s.reply = null;
  },
  abandon(s) {
    s.skipId = s.reply?.id ?? null;
    s.reply = null;
  },
  done: (s) => s.root,
  cursor: (s) => ({ u: s.expected, ...(s.skipId ? { k: s.skipId } : {}) }),
};

// ---- Codex CLI --------------------------------------------------------------------

function codexMessage(record) {
  const payload = record.type === 'event_msg' ? record.payload : null;
  if (!payload || typeof payload !== 'object') return null;
  if (payload.type === 'user_message') return { role: 'user', text: visiblePrompt(payload.message) };
  if (payload.type === 'agent_message') return { role: 'assistant', text: clean(payload.message) };
  if (payload.type !== 'item_completed') return null;
  const item = payload.item;
  const text = Array.isArray(item?.content) ? item.content.filter((part) => typeof part?.text === 'string').map((part) => part.text).join('\n') : '';
  if (item?.type === 'UserMessage') return { role: 'user', text: visiblePrompt(text) };
  if (item?.type === 'AgentMessage') return { role: 'assistant', text: clean(text) };
  return null;
}

function codexRollback(record) {
  return record.type === 'event_msg' && record.payload?.type === 'thread_rolled_back';
}

/**
 * Older rollouts carry `user_message` and `agent_message` events, newer ones
 * `item_completed` items; one rollout has one kind. A legacy
 * `thread_rolled_back` dropped the user turns before it.
 */
export const codexReader = {
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
  abandon: () => {},
  done: () => false,
  cursor: (s) => (s.drop ? { d: s.drop } : {}),
};

// ---- Grok Build -------------------------------------------------------------------

function grokUpdate(record) {
  const update = record.params?.update;
  return update && typeof update === 'object' ? update : null;
}

function grokUserChunk(update) {
  return update.sessionUpdate === 'user_message_chunk' && update.content?.type === 'text';
}

/** Grok Build 1.0.70 numbers a prompt's chunks with promptIndex; earlier versions gave them a promptId. */
function grokPromptKey(record, update) {
  return update._meta?.promptIndex ?? record.params._meta?.promptId ?? null;
}

/**
 * A turn is the user's prompt, whose chunks share `promptIndex`, and the
 * replies after it; a tool call ends a reply. A rewind leaves the old turns in
 * `updates.jsonl` and appends a `rewind_marker`: read backwards, every turn at
 * or above the lowest target passed so far was discarded.
 */
export const grokReader = {
  start: (saved) => ({ cut: safeInteger(saved?.c) ? saved.c : null, skip: saved?.k === true, skipPrompt: safeInteger(saved?.p) ? saved.p : null, turn: null }),
  continues: (s, record, update) => grokUserChunk(update) && grokPromptKey(record, update) === s.turn.key,
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
    if (s.skipPrompt !== null) {
      if (grokUserChunk(update) && update._meta?.promptIndex === s.skipPrompt) return;
      s.skipPrompt = null;
    }
    s.turn ??= { user: false, key: null, index: undefined, hidden: false, prompt: [], replies: [], reply: null };
    const turn = s.turn;
    if (grokUserChunk(update)) {
      turn.user = true;
      turn.reply = null;
      turn.key = grokPromptKey(record, update);
      turn.index = update._meta?.promptIndex;
      if (update.content._meta?.bash_command || update._meta?.host_turn === true) turn.hidden = true;
      else turn.prompt.unshift(update.content.text);
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      turn.reply = null;
    } else if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && !s.skip) {
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
    s.skip = false;
    const replies = turn.replies.map((parts) => clean(parts.join(''))).filter(Boolean);
    const prompt = turn.hidden ? '' : visiblePrompt(turn.prompt.join(''));
    if (!replies.length && !prompt) return;
    if (s.cut !== null) {
      if (!safeInteger(turn.index)) { s.failed = true; return; }
      if (turn.index >= s.cut) return;
    }
    for (const text of replies.reverse()) s.messages.push({ role: 'assistant', text });
    if (prompt) s.messages.push({ role: 'user', text: prompt });
  },
  abandon(s) {
    // A turn too long to finish is left out: before its prompt, the next page skips the rest of its replies
    // and still shows the prompt; within its prompt, the next page skips the rest of the prompt.
    if (s.turn?.user && safeInteger(s.turn.index)) s.skipPrompt = s.turn.index;
    else s.skip = true;
    s.turn = null;
  },
  done: (s) => s.failed,
  cursor: (s) => ({ ...(s.cut !== null ? { c: s.cut } : {}), ...(s.skip ? { k: true } : {}), ...(s.skipPrompt !== null ? { p: s.skipPrompt } : {}) }),
};

// ---- Antigravity CLI ----------------------------------------------------------------

export const antigravityReader = {
  start: () => ({}),
  starts: (s, record) => transcriptMessage(record) !== null,
  take(s, record) {
    const message = transcriptMessage(record);
    if (message) s.messages.push(message);
  },
  open: () => false,
  flush: () => {},
  abandon: () => {},
  done: () => false,
  cursor: () => ({}),
};

export const JSONL_READERS = {
  claude: { reader: claudeReader },
  codex: { reader: codexReader },
  grok: { reader: grokReader },
  antigravity: { reader: antigravityReader, firstRecord: antigravityUserConversation },
};

/** A page of an Antigravity CLI conversation; a sub-agent's, which starts with its parent's message, is unavailable. */
export async function readAntigravityTranscript(dir, id, cursor = null, limits = PAGE_LIMITS) {
  return readJsonlPage({ source: 'antigravity', id, file: await transcriptFile(dir, id), cursor, ...JSONL_READERS.antigravity, limits });
}

// ---- Docker Agent -------------------------------------------------------------------

/** Docker Agent's own rule for what the user saw: real messages and final replies. */
function dockerMessage(row) {
  if (row.implicit || row.subsession_id) return null;
  let message;
  try { message = JSON.parse(row.message_json); } catch { return null; }
  if (!message || (message.role !== 'user' && message.role !== 'assistant')) return null;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) return null;
  const text = clean(typeof message.content === 'string' ? message.content : '');
  return text ? { role: message.role, text } : null;
}

/** A page of a Docker Agent session, by row position; the row a cursor stopped at must still be there. */
export async function readDockerConversation({ dir, id, cursor, loadSqlite, limits = PAGE_LIMITS }) {
  const saved = cursor ? decodeCursor(cursor, 'docker', id) : null;
  if (saved && (!safeInteger(saved.p) || !safeInteger(saved.r, 1))) throw badCursor();
  const { DatabaseSync } = await loadSqlite();
  let db;
  try {
    try { db = new DatabaseSync(path.join(dir, 'session.db'), { readOnly: true }); } catch { throw unavailable(); }
    if (saved && db.prepare('select id from session_items where session_id = ? and position = ?').get(id, saved.p)?.id !== saved.r) throw changed();
    const rows = db.prepare(`select id, position, implicit, subsession_id, message_json from session_items
      where session_id = ? and item_type = 'message'${saved ? ' and position < ?' : ''} order by position desc limit ?`)
      .all(...(saved ? [id, saved.p] : [id]), limits.rows + 1);
    const messages = [];
    let used = 0;
    for (const row of rows.slice(0, limits.rows)) {
      const message = dockerMessage(row);
      if (message && messages.length >= limits.messages) break;
      used++;
      if (message) messages.push(message);
    }
    const last = rows[used - 1];
    return {
      id,
      messages: messages.reverse(),
      nextCursor: used < rows.length ? encodeCursor({ v: 1, s: 'docker', i: id, p: last.position, r: last.id, st: {} }) : null,
      incomplete: false,
      omitted: false,
    };
  } catch (err) {
    if (err.status) throw err;
    throw unavailable();
  } finally {
    db?.close();
  }
}
