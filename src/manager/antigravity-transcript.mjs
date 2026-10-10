// Antigravity CLI 1.3.1's readable transcript. Never expose thinking, tool payloads,
// or the binary conversation/implicit stores as conversation text.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { antigravityUserConversation } from '../report/hooks.mjs';

export const ANTIGRAVITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TRANSCRIPT_PAGE_BYTES = 256 * 1024;

export function historyError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/** Reject links below the provider home, including a linked conversation or logs folder. */
export async function transcriptFile(dir, id) {
  if (!ANTIGRAVITY_ID.test(id)) throw historyError(400, 'bad_history_id', 'Invalid conversation id.');
  let file = await fs.promises.realpath(dir);
  const parts = ['brain', id, '.system_generated', 'logs', 'transcript.jsonl'];
  for (const [i, part] of parts.entries()) {
    file = path.join(file, part);
    const stat = await fs.promises.lstat(file);
    if (stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw historyError(404, 'history_unavailable', 'This conversation transcript is unavailable.');
    }
  }
  return file;
}

export function transcriptMessage(record) {
  if (typeof record?.content !== 'string') return null;
  let role, text;
  if (antigravityUserConversation(record)) {
    role = 'user';
    text = record.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/)?.[1];
  } else if (record.source === 'MODEL' && record.type === 'PLANNER_RESPONSE') {
    role = 'assistant';
    text = record.content;
  }
  return text?.trim() ? { role, text: text.trim() } : null;
}

/** One bounded byte page. A cursor pins the file revision; partial final lines wait for Refresh. */
export async function readAntigravityTranscript(dir, id, cursor = null) {
  let handle;
  try {
    handle = await fs.promises.open(await transcriptFile(dir, id), 'r');
    const stat = await handle.stat();
    const revision = createHash('sha256').update(`${id}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`).digest('hex').slice(0, 24);
    let offset = 0, skipping = false;
    if (cursor) {
      if (typeof cursor !== 'string' || cursor.length > 256) {
        throw historyError(400, 'bad_history_cursor', 'Invalid conversation page.');
      }
      let value;
      try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { /* invalid below */ }
      if (!value || !Number.isSafeInteger(value.offset)
        || value.offset < 0 || typeof value.skipping !== 'boolean' || typeof value.revision !== 'string') {
        throw historyError(400, 'bad_history_cursor', 'Invalid conversation page.');
      }
      if (value.revision !== revision) throw historyError(409, 'history_changed', 'The conversation changed. Refresh to read it again.');
      if (value.offset > stat.size) throw historyError(400, 'bad_history_cursor', 'Invalid conversation page.');
      ({ offset, skipping } = value);
    }
    // Check the first record on every request, including requests using a supplied cursor.
    const head = Buffer.alloc(Math.min(stat.size, TRANSCRIPT_PAGE_BYTES));
    const firstRead = await handle.read(head, 0, head.length, 0);
    const headEnd = head.subarray(0, firstRead.bytesRead).indexOf(10);
    let first;
    try { first = JSON.parse(head.subarray(0, headEnd < 0 ? firstRead.bytesRead : headEnd).toString('utf8')); } catch { /* unavailable */ }
    if (!antigravityUserConversation(first)) throw historyError(404, 'history_unavailable', 'This conversation transcript is unavailable.');
    const buffer = offset === 0 ? head : Buffer.alloc(Math.min(stat.size - offset, TRANSCRIPT_PAGE_BYTES));
    const bytesRead = offset === 0 ? firstRead.bytesRead : (await handle.read(buffer, 0, buffer.length, offset)).bytesRead;
    const data = buffer.subarray(0, bytesRead);
    const messages = [];
    let start = 0, omitted = false;
    for (let end; (end = data.indexOf(10, start)) >= 0;) {
      if (skipping) { skipping = false; omitted = true; }
      else if (end > start) {
        try {
          const message = transcriptMessage(JSON.parse(data.subarray(start, end).toString('utf8')));
          if (message) messages.push(message);
        } catch { omitted = true; }
      }
      start = end + 1;
    }
    const atEnd = offset + bytesRead >= stat.size;
    const incomplete = atEnd && start < bytesRead;
    // Leave a split record for the next page. An oversized record is skipped in bounded pieces.
    if (!atEnd && start === 0) { start = bytesRead; skipping = true; omitted = true; }
    const nextCursor = !atEnd && bytesRead > 0
      ? Buffer.from(JSON.stringify({ offset: offset + start, skipping, revision })).toString('base64url') : null;
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw historyError(409, 'history_changed', 'The conversation changed. Refresh to read it again.');
    }
    return { id, messages, nextCursor, incomplete, omitted };
  } catch (err) {
    if (err.status) throw err;
    throw historyError(404, 'history_unavailable', 'This conversation transcript is unavailable.');
  } finally {
    await handle?.close();
  }
}
