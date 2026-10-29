// The names people give cards, kept by provider, account and the tool's own
// session id, so History shows them and a resumed card gets its name back.
// Only explicit names are kept; a card named after its tool has none.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const CARD_NAMES_LIMIT = 5000;
const FILE_LIMIT = 4 * 1024 * 1024;

const key = (providerId, accountId, toolSessionId) => `${providerId}\0${accountId}\0${toolSessionId}`;

function readNames(file) {
  let stat;
  try { stat = fs.statSync(file); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (!stat.isFile() || stat.size > FILE_LIMIT) throw new Error('not a names file');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value?.version !== 1 || !Array.isArray(value.names)) throw new Error('not a names file');
  return value.names.filter((n) => n && typeof n.provider === 'string' && typeof n.account === 'string' && typeof n.id === 'string'
    && typeof n.name === 'string' && n.name && typeof n.at === 'string');
}

function writeNames(file, names) {
  const contents = `${JSON.stringify({ version: 1, names }, null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const next = `${file}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(next, 'wx', 0o600);
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(next, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(next); } catch { /* renamed, or never created */ }
  }
  try { fs.chmodSync(file, 0o600); } catch { /* not supported on Windows */ }
}

/**
 * @param {string} [file] omit for an in-memory store (tests). The real manager passes its names file.
 * @param {{ limit?: number, warn?: (message: string) => void, now?: () => string }} [options]
 */
export function createCardNames(file, { limit = CARD_NAMES_LIMIT, warn = (message) => console.warn(message), now = () => new Date().toISOString() } = {}) {
  let names = null;
  let warned = false;

  /** An unreadable file is read again next time and never overwritten, so fixing or removing it needs no restart. */
  function load() {
    if (names) return names;
    if (!file) return (names = new Map());
    try {
      names = new Map(readNames(file).map((n) => [key(n.provider, n.account, n.id), n]));
      warned = false;
    } catch {
      if (!warned) warn(`[names] ${file} cannot be read, so card names are not kept until it is fixed or removed.`);
      warned = true;
      return null;
    }
    return names;
  }

  function save(current) {
    if (!file) return;
    try {
      writeNames(file, [...current.values()]);
    } catch (err) {
      warn(`[names] could not save card names: ${err.message}`);
    }
  }

  return {
    get(providerId, accountId, toolSessionId) {
      return load()?.get(key(providerId, accountId, toolSessionId))?.name ?? null;
    },
    set(providerId, accountId, toolSessionId, name) {
      const current = load();
      if (!current) return;
      const k = key(providerId, accountId, toolSessionId);
      if (current.get(k)?.name === name) return;
      // Newest last, so the oldest are dropped first.
      current.delete(k);
      current.set(k, { provider: providerId, account: accountId, id: toolSessionId, name, at: now() });
      while (current.size > limit) current.delete(current.keys().next().value);
      save(current);
    },
    delete(providerId, accountId, toolSessionId) {
      const current = load();
      if (current?.delete(key(providerId, accountId, toolSessionId))) save(current);
    },
  };
}
