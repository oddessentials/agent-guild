// One notepad for every browser signed in to this manager.
// A missing file means notes were never stored. An empty string is a notepad
// the user cleared; those two must stay distinct so an old browser cannot
// put cleared notes back.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const NOTES_LIMIT = 100000;
/** Larger than the API's usual 64 KiB body, and enough for a full notepad after JSON escaping. */
export const NOTES_BODY_LIMIT = 1024 * 1024;
const NOTES_FILE_LIMIT = 2 * 1024 * 1024;

function notesError(code, message, status, notes) {
  // The store reports an unreadable file once, so the server does not log every request that hits it.
  const error = Object.assign(new Error(message), { code, status, logged: code === 'notes_unreadable' });
  if (notes) error.notes = notes;
  return error;
}

/** @returns {{ revision: string, text: string } | null} null when the file is not there yet */
function readNotes(file) {
  let stat;
  try { stat = fs.statSync(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw notesError('notes_unreadable', 'Notes could not be read.', 500);
  }
  if (!stat.isFile() || stat.size > NOTES_FILE_LIMIT) throw notesError('notes_unreadable', 'Notes could not be read.', 500);
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    throw notesError('notes_unreadable', 'Notes could not be read.', 500);
  }
  if (!value || value.version !== 1 || typeof value.revision !== 'string' || !value.revision || value.revision.length > 100
    || typeof value.text !== 'string' || value.text.length > NOTES_LIMIT) {
    throw notesError('notes_unreadable', 'Notes could not be read.', 500);
  }
  return { revision: value.revision, text: value.text };
}

function writeNotes(file, notes) {
  const contents = `${JSON.stringify({ version: 1, revision: notes.revision, text: notes.text }, null, 2)}\n`;
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
 * @param {string} [file] omit for an in-memory store (tests). The real manager passes its notes file.
 * @param {{ warn?: (message: string) => void }} [options] where the one line about an unreadable file goes
 */
export function createNotesStore(file, { warn = (message) => console.warn(message) } = {}) {
  let current = { revision: null, text: '' };
  let loaded = !file;
  let warned = false;

  /** An unreadable file is read again next time, so fixing or removing it needs no restart. */
  function ensure() {
    if (loaded) return;
    let read;
    try { read = readNotes(file); } catch (error) {
      if (!warned) warn(`[notes] ${file} cannot be read, so notes are not shared until it is fixed or removed.`);
      warned = true;
      throw error;
    }
    warned = false;
    current = read ?? { revision: null, text: '' };
    loaded = true;
  }

  function snapshot() {
    ensure();
    return { revision: current.revision, text: current.text };
  }

  function save(body) {
    ensure();
    if (!body || typeof body.text !== 'string') throw notesError('bad_notes', 'Notes must be text.', 400);
    if (body.text.length > NOTES_LIMIT) {
      throw notesError('notes_too_long', `Notes hold up to ${NOTES_LIMIT.toLocaleString('en-US')} characters.`, 400);
    }
    const revision = body.revision ?? null;
    if (revision !== null && (typeof revision !== 'string' || !revision || revision.length > 100)) {
      throw notesError('bad_notes', 'Notes must be text.', 400);
    }
    if (revision !== current.revision) {
      throw notesError('stale_notes', 'Notes changed in another browser.', 409, { revision: current.revision, text: current.text });
    }
    const next = { revision: randomUUID(), text: body.text };
    if (file) writeNotes(file, next);
    current = next;
    loaded = true;
    return { revision: next.revision, text: next.text };
  }

  return {
    snapshot,
    save,
    /** `{ known: false }` when the file cannot be read, so a client does not treat that as an empty notepad. */
    helloRevision() {
      try {
        return { known: true, revision: snapshot().revision };
      } catch {
        return { known: false };
      }
    },
  };
}
