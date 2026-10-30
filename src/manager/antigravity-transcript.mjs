// Antigravity CLI 1.3.1's readable transcript. Never expose thinking, tool payloads,
// or the binary conversation/implicit stores as conversation text.
import fs from 'node:fs';
import path from 'node:path';
import { antigravityUserConversation } from '../report/hooks.mjs';

export const ANTIGRAVITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function historyError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/** Reject links below the provider home, including a linked conversation or logs folder. */
export async function transcriptFile(dir, id) {
  if (!ANTIGRAVITY_ID.test(id)) throw historyError(400, 'bad_history_id', 'Invalid conversation id.');
  const unavailable = () => historyError(404, 'history_unavailable', 'This conversation transcript is unavailable.');
  let file = await fs.promises.realpath(dir).catch(() => { throw unavailable(); });
  const parts = ['brain', id, '.system_generated', 'logs', 'transcript.jsonl'];
  for (const [i, part] of parts.entries()) {
    file = path.join(file, part);
    const stat = await fs.promises.lstat(file).catch(() => { throw unavailable(); });
    if (stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw unavailable();
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
