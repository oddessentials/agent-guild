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
  maxLineBytes: 4 * 1024 * 1024,
  chunkBytes: 256 * 1024,
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

/** A compressed rollout is decoded to a private temporary file, removed when the page is read; offsets address the decoded JSONL. */
async function openSource(file) {
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
    await pipeline(fs.createReadStream(target), zlib.createZstdDecompress(), fs.createWriteStream(decoded, { flags: 'wx', mode: 0o600 }));
    const source = await plainSource(decoded);
    return { ...source, close: async () => { try { await source.close(); } finally { await remove(); } } };
  } catch {
    await remove();
    throw unavailable();
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

async function lastLineEnd(source, limits) {
  let position = source.size;
  while (position > 0 && source.size - position < limits.maxScanBytes) {
    const length = Math.min(limits.chunkBytes, position);
    const chunk = await source.read(position - length, length);
    const newline = chunk.lastIndexOf(10);
    if (newline >= 0) return position - length + newline + 1;
    position -= length;
  }
  return 0;
}

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
      yield { offset: position + i + 1, size, bytes: size > limits.maxLineBytes ? null : Buffer.concat([chunk.subarray(i + 1, lineEnd), ...tail]) };
      tail = [];
      tailSize = 0;
      lineEnd = i;
    }
    tailSize += lineEnd;
    if (tailSize <= limits.maxLineBytes) tail.unshift(chunk.subarray(0, lineEnd));
  }
  if (tailSize > 0) yield { offset: 0, size: tailSize, bytes: tailSize > limits.maxLineBytes ? null : Buffer.concat(tail) };
}

const OUTLINE_PATHS = new Set(['type', 'uuid', 'parentUuid', 'logicalParentUuid', 'isSidechain', 'isMeta', 'isCompactSummary',
  'message.id', 'message.content.[].type', 'source', 'payload.type', 'payload.item.type', 'params.update.sessionUpdate',
  'params.update.content.type', 'params.update.content._meta.bash_command', 'params.update._meta.promptIndex', 'params.update._meta.host_turn']);
const MAX_OUTLINE_VALUE = 512;

/**
 * The fields readers need from a record too large to keep, in one pass over its
 * bytes: only the paths above, never its text. Null unless the record is one
 * whole JSON object.
 */
async function outline(source, offset, size, limits) {
  const frames = [];
  const found = new Map();
  let inString = false, escape = false, buffer = null, bufferLimit = 0, kind = null, path = null, literal = null, closed = false;
  const current = () => frames.map((frame) => (frame.array ? '[]' : frame.key)).join('.');
  const wanted = (at) => OUTLINE_PATHS.has(at) && !found.has(at);
  const valueStarts = () => {
    if (closed || (frames.length && !frames.at(-1).array && frames.at(-1).key === null)) return false;
    return true;
  };
  const endLiteral = () => {
    if (literal && literal.bytes) {
      try { found.set(literal.path, JSON.parse(Buffer.from(literal.bytes).toString('utf8'))); } catch { /* not a scalar */ }
    }
    literal = null;
  };
  for (let at = offset; at < offset + size; at += limits.chunkBytes) {
    const chunk = await source.read(at, Math.min(limits.chunkBytes, offset + size - at));
    for (const b of chunk) {
      if (inString) {
        if (escape) escape = false;
        else if (b === 92) escape = true;
        else if (b === 34) {
          inString = false;
          const text = buffer && buffer.length <= bufferLimit ? Buffer.from(buffer) : null;
          if (kind === 'key') {
            frames.at(-1).key = text ? text.toString('utf8') : '';
          } else if (text && path) {
            try { found.set(path, JSON.parse(`"${text.toString('utf8')}"`)); } catch { /* malformed escape */ }
          }
          buffer = null;
          continue;
        }
        if (buffer && buffer.length <= bufferLimit) buffer.push(b);
        continue;
      }
      if (literal && (b === 44 || b === 125 || b === 93 || b === 32 || b === 9 || b === 13 || b === 10)) endLiteral();
      else if (literal) {
        if (literal.bytes && literal.bytes.length < 32) literal.bytes.push(b);
        continue;
      }
      if (b === 32 || b === 9 || b === 13 || b === 10 || b === 58) continue;
      if (b === 44) {
        if (frames.length && !frames.at(-1).array) frames.at(-1).key = null;
        continue;
      }
      if (b === 123 || b === 91) {
        if (!valueStarts() || (!frames.length && b !== 123)) return null;
        frames.push({ array: b === 91, key: null });
        continue;
      }
      if (b === 125 || b === 93) {
        const frame = frames.pop();
        if (!frame || frame.array !== (b === 93)) return null;
        if (!frames.length) closed = true;
        continue;
      }
      if (!frames.length || closed) return null;
      const top = frames.at(-1);
      if (b === 34) {
        inString = true;
        if (!top.array && top.key === null) {
          kind = 'key';
          buffer = [];
          bufferLimit = 64;
        } else {
          kind = 'value';
          const at = current();
          path = wanted(at) ? at : null;
          buffer = path ? [] : null;
          bufferLimit = MAX_OUTLINE_VALUE;
        }
        continue;
      }
      if (!top.array && top.key === null) return null;
      const at = current();
      literal = { path: at, bytes: wanted(at) ? [b] : null };
    }
  }
  if (literal) endLiteral();
  if (!closed || inString) return null;
  const record = {};
  for (const [at, value] of found) {
    let node = record;
    const parts = at.split('.');
    parts.forEach((part, i) => {
      if (part === '[]') return;
      if (i === parts.length - 1) node[part] = value;
      else if (parts[i + 1] === '[]') {
        node[part] = [{}];
        node = node[part][0];
      } else node = node[part] ??= {};
    });
  }
  return record;
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
 * - `corrupt(state)`: a record could not be read at all;
 * - `done(state)`: nothing older belongs to the conversation; `failed` says it cannot be shown truthfully;
 * - `cursor(state)`: what the next page needs.
 * A record too large to keep reaches `take` as its outline, marked `withheld`: the message it belongs to is left out whole.
 */
export async function readJsonlPage({ source: kind, id, file, cursor, reader, firstRecord = null, limits = PAGE_LIMITS }) {
  const saved = cursor ? decodeCursor(cursor, kind, id) : null;
  const source = await openSource(file);
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
      if (!line.size) { last = line.offset; continue; }
      let record = null, corrupt = false;
      if (line.bytes === null) {
        record = await outline(source, line.offset, line.size, limits);
        if (record) record.withheld = true;
        else corrupt = true;
      } else {
        try { record = JSON.parse(line.bytes.toString('utf8')); } catch { corrupt = true; }
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
      if (corrupt) {
        state.omitted = true;
        reader.corrupt(state);
      } else if (record && typeof record === 'object') reader.take(state, record);
      scanned += line.size + 1;
      last = line.offset;
      if (reader.done(state)) { more = false; break; }
    }
    reader.flush(state, !more);
    if (state.failed) throw unavailable();
    if (more && last >= end) throw unavailable();
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

function visiblePrompt(text) {
  const value = clean(text);
  return value && !TAG_RE.test(value) ? value : '';
}

// ---- Claude Code ----------------------------------------------------------------

const WITHHELD = Symbol('withheld');

function claudePrompt(record) {
  if (record.type !== 'user' || record.isMeta === true || record.isCompactSummary === true) return null;
  const content = record.message?.content;
  if (record.withheld) return Array.isArray(content) && content[0]?.type === 'tool_result' ? null : WITHHELD;
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
      if (prompt === WITHHELD) s.omitted = true;
      else s.messages.push({ role: 'user', text: prompt });
      return;
    }
    const messageId = claudeMessageId(record);
    if (messageId === null) return;
    if (messageId === s.skipId) return;
    s.skipId = null;
    if (s.reply?.id !== messageId) {
      this.flush(s);
      s.reply = { id: messageId, parts: [], withheld: false };
    }
    if (record.withheld) s.reply.withheld = true;
    const text = claudeReplyText(record);
    if (text) s.reply.parts.unshift(text);
  },
  open: (s) => s.reply !== null,
  flush(s, atStart = false) {
    // A chain that never reaches its root lost a record: the reply waiting on it may be missing a part.
    const unresolved = atStart && s.leaf && !s.root && s.expected !== null;
    if (unresolved || s.reply?.withheld) s.omitted = true;
    else if (s.reply?.parts.length) s.messages.push({ role: 'assistant', text: s.reply.parts.join('\n\n') });
    s.reply = null;
  },
  corrupt: () => {},
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
  start: (saved) => ({ drop: safeInteger(saved?.d) ? saved.d : 0, stopped: false }),
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
    if (record.withheld) s.omitted = true;
    else if (message.text) s.messages.push(message);
  },
  open: () => false,
  flush: () => {},
  abandon: () => {},
  corrupt: (s) => { s.stopped = true; },
  done: (s) => s.stopped,
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
  start: (saved) => ({ cut: safeInteger(saved?.c) ? saved.c : null, skip: saved?.k === true, skipPrompt: safeInteger(saved?.p) ? saved.p : null, turn: null, stopped: false }),
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
    s.turn ??= { user: false, key: null, index: undefined, hidden: false, prompt: [], promptWithheld: false, replies: [], reply: null };
    const turn = s.turn;
    if (grokUserChunk(update)) {
      turn.user = true;
      turn.reply = null;
      turn.key = grokPromptKey(record, update);
      turn.index = update._meta?.promptIndex;
      if (update.content._meta?.bash_command || update._meta?.host_turn === true) turn.hidden = true;
      else if (record.withheld) turn.promptWithheld = true;
      else turn.prompt.unshift(update.content.text);
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      turn.reply = null;
    } else if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && !s.skip) {
      if (!turn.reply) {
        turn.reply = [];
        turn.replies.unshift(turn.reply);
      }
      if (record.withheld) turn.reply.withheld = true;
      else turn.reply.unshift(update.content.text);
    }
  },
  open: (s) => s.turn !== null,
  flush(s) {
    const turn = s.turn;
    s.turn = null;
    if (!turn) return;
    s.skip = false;
    if (turn.promptWithheld || turn.replies.some((parts) => parts.withheld)) s.omitted = true;
    const replies = turn.replies.filter((parts) => !parts.withheld).map((parts) => clean(parts.join(''))).filter(Boolean);
    const prompt = turn.hidden || turn.promptWithheld ? '' : visiblePrompt(turn.prompt.join(''));
    if (!replies.length && !prompt) return;
    if (s.cut !== null) {
      if (!safeInteger(turn.index)) { s.failed = true; return; }
      if (turn.index >= s.cut) return;
    }
    for (const text of replies.reverse()) s.messages.push({ role: 'assistant', text });
    if (prompt) s.messages.push({ role: 'user', text: prompt });
  },
  abandon(s) {
    if (s.turn?.user && safeInteger(s.turn.index)) s.skipPrompt = s.turn.index;
    else s.skip = true;
    s.turn = null;
  },
  corrupt(s) {
    s.turn = null;
    s.stopped = true;
  },
  done: (s) => s.failed || s.stopped,
  cursor: (s) => ({ ...(s.cut !== null ? { c: s.cut } : {}), ...(s.skip ? { k: true } : {}), ...(s.skipPrompt !== null ? { p: s.skipPrompt } : {}) }),
};

// ---- Antigravity CLI ----------------------------------------------------------------

export const antigravityReader = {
  start: () => ({}),
  starts: (s, record) => transcriptMessage(record) !== null,
  take(s, record) {
    if (record.withheld) {
      if (antigravityUserConversation(record) || (record.source === 'MODEL' && record.type === 'PLANNER_RESPONSE')) s.omitted = true;
      return;
    }
    const message = transcriptMessage(record);
    if (message) s.messages.push(message);
  },
  open: () => false,
  flush: () => {},
  abandon: () => {},
  corrupt: () => {},
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

/** Docker Agent's own VisibleExchanges rule. */
function dockerMessage(row) {
  if (row.implicit || row.subsession_id) return null;
  let message;
  try { message = JSON.parse(row.message_json); } catch { return null; }
  if (!message || (message.role !== 'user' && message.role !== 'assistant')) return null;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) return null;
  const text = clean(typeof message.content === 'string' ? message.content : '');
  return text ? { role: message.role, text } : null;
}

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
