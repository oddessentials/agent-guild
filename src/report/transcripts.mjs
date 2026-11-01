import fs from 'node:fs';
import { antigravityReply, claudeCompactBoundary } from './hooks.mjs';

const MAX_FIRST_LINE = 1024 * 1024;
const COMPACTION_TAIL_BYTES = 1024 * 1024;
const REPLY_WINDOW_BYTES = 256 * 1024;
const MAX_REPLY_WINDOW_BYTES = 64 * 1024 * 1024;
// Claude Code writes the compaction record a moment after its PostCompact hook starts.
const COMPACTION_WAIT_MS = 3000;
const COMPACTION_STEP_MS = 250;

const parseJson = (raw) => { try { return JSON.parse(raw); } catch { return null; } };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openFile(file) {
  if (typeof file !== 'string' || !file) return null;
  try {
    if (!(await fs.promises.stat(file)).isFile()) return null;
    // Non-blocking, in case the path became a FIFO after the check: opening one would wait for a writer.
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close();
      return null;
    }
    return { handle, size: stat.size };
  } catch {
    return null;
  }
}

async function readRecords(handle, start, end) {
  const buffer = Buffer.alloc(end - start);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
  const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
  // A window that starts mid-file starts mid-line.
  if (start > 0) lines.shift();
  return lines.map(parseJson);
}

/** The first JSON record of a JSONL file, or null. */
export async function firstRecord(file) {
  const opened = await openFile(file);
  if (!opened) return null;
  try {
    const length = Math.min(opened.size, MAX_FIRST_LINE);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await opened.handle.read(buffer, 0, length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    return parseJson(buffer.subarray(0, end === -1 ? bytesRead : end).toString('utf8'));
  } catch {
    return null;
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

export async function tailRecords(file, bytes) {
  const opened = await openFile(file);
  if (!opened) return [];
  try {
    return await readRecords(opened.handle, Math.max(0, opened.size - bytes), opened.size);
  } catch {
    return [];
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/** The last response of an Antigravity CLI turn, read back from the end of its transcript. */
export async function antigravityTranscriptReply(file) {
  const opened = await openFile(file);
  if (!opened) return null;
  try {
    for (let bytes = REPLY_WINDOW_BYTES; ; bytes *= 4) {
      const start = Math.max(0, opened.size - bytes);
      const reply = antigravityReply(await readRecords(opened.handle, start, opened.size));
      if (reply !== undefined || start === 0 || bytes >= MAX_REPLY_WINDOW_BYTES) return reply ?? null;
    }
  } catch {
    return null;
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

export async function claudeCompaction(file, since, { sleep = wait } = {}) {
  if (typeof file !== 'string' || !file) return null;
  for (let waited = 0; waited <= COMPACTION_WAIT_MS; waited += COMPACTION_STEP_MS) {
    if (waited) await sleep(COMPACTION_STEP_MS);
    const key = claudeCompactBoundary(await tailRecords(file, COMPACTION_TAIL_BYTES), since);
    if (key) return key;
  }
  return null;
}
