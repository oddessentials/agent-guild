import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { WORLDS, PROVIDER_ORDER } from '../../web/yard/model.mjs';
import { renameRetrying } from './yard-art.mjs';
import { checkModels, LIMITS } from './yard-piece-check.mjs';

const MANIFEST = 'piece.json';
const INSTALL = 'install.json';
const MAX_MANIFEST = 16 * 1024;
export const SLOTS = [...PROVIDER_ORDER, 'companion'];
const KIND = (slot) => (slot === 'companion' ? 'companion' : 'character');
export const MODELS = { character: ['character.glb'], companion: ['companion_0.glb', 'companion_1.glb', 'companion_2.glb', 'companion_3.glb'] };

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });
const invalid = (message) => failure(400, 'piece_invalid', message);

function checkManifest(meta, kind) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw invalid('This piece’s details can’t be read.');
  if (meta.format !== 1) throw invalid(Number.isInteger(meta.format) && meta.format > 1 ? 'This piece needs a newer Agent Guild.' : 'This piece’s format is missing.');
  if (meta.kind !== 'character' && meta.kind !== 'companion') throw invalid('This isn’t a character or companion piece.');
  if (meta.kind !== kind) throw invalid(kind === 'character' ? 'This is a companion piece, not a character.' : 'This is a character piece, not a companion.');
  if (meta.title !== undefined && (typeof meta.title !== 'string' || meta.title.length > 128 || /\p{Cc}/u.test(meta.title))) throw invalid('This piece’s title is too long or unreadable.');
  return typeof meta.title === 'string' ? meta.title.trim() : '';
}

export function readManifest(bytes, kind = null) {
  let meta;
  try { meta = JSON.parse(bytes.toString('utf8')); } catch { throw invalid('This piece’s details can’t be read.'); }
  return { kind: meta?.kind, title: checkManifest(meta, kind ?? meta?.kind) };
}

async function readSource(folder, name, most) {
  const file = path.join(folder, name);
  let stat;
  try { stat = await fsp.lstat(file); } catch { throw invalid(`${name} is missing.`); }
  if (!stat.isFile()) throw invalid(`${name} isn’t a plain file.`);
  if (stat.size > most) throw invalid(`${name} is larger than a piece may be.`);
  try { return await fsp.readFile(file); } catch { throw invalid(`${name} can’t be read.`); }
}

export class YardPieces extends EventEmitter {
  constructor({ dir = null, remove = (folder) => fsp.rm(folder, { recursive: true, force: true, maxRetries: 5 }), check = checkModels } = {}) {
    super();
    this.dir = dir;
    this.pieces = {};
    this.busy = false;
    this.remove = remove;
    this.check = check;
    this.swept = Promise.resolve();
    if (!dir) return;
    for (const skin of Object.keys(WORLDS)) for (const slot of SLOTS) this.read(skin, slot);
    this.swept = this.sweep();
  }

  snapshot() { return this.pieces; }

  discard(folder) { return this.remove(folder).catch(() => {}); }

  async sweep() {
    const names = await fsp.readdir(this.dir).catch(() => []);
    await Promise.all(names.filter((name) => name.startsWith('.')).map(async (name) => {
      const [, skin, slot, , kind] = name.split('.');
      const target = Object.hasOwn(WORLDS, skin) && SLOTS.includes(slot) ? path.join(this.dir, skin, slot) : null;
      if (kind === 'old' && target && !fs.existsSync(target)) {
        try {
          await renameRetrying(path.join(this.dir, name), target);
          this.read(skin, slot);
          this.emit('updated', this.snapshot());
          return;
        } catch {}
      }
      let folder = path.join(this.dir, name);
      if (kind === 'old' && target && fs.existsSync(target)) {
        const removed = this.aside(skin, slot, 'removed');
        try { await renameRetrying(folder, removed); folder = removed; } catch { return; }
      }
      await this.discard(folder);
    }));
  }

  aside(skin, slot, kind) { return path.join(this.dir, `.${skin}.${slot}.${crypto.randomUUID()}.${kind}`); }

  file(skin, slot, name) {
    return this.dir && Object.hasOwn(WORLDS, skin) && SLOTS.includes(slot) && MODELS[KIND(slot)].includes(name) && this.pieces[skin]?.[slot]?.revision
      ? path.join(this.dir, skin, slot, name) : null;
  }

  set(skin, slot, value) {
    if (value) (this.pieces[skin] ??= {})[slot] = value;
    else if (this.pieces[skin]) {
      delete this.pieces[skin][slot];
      if (!Object.keys(this.pieces[skin]).length) delete this.pieces[skin];
    }
  }

  read(skin, slot) {
    const folder = path.join(this.dir, skin, slot);
    if (!fs.existsSync(folder)) return this.set(skin, slot, null);
    let title = null;
    try {
      const kind = KIND(slot);
      title = readManifest(fs.readFileSync(path.join(folder, MANIFEST)), kind).title;
      const bytes = fs.readFileSync(path.join(folder, INSTALL));
      const install = JSON.parse(bytes.toString('utf8'));
      title = install.title;
      for (const name of [MANIFEST, ...MODELS[kind]]) {
        const details = install.files?.[name];
        let content;
        try { content = fs.readFileSync(path.join(folder, name)); } catch { content = null; }
        if (!details || !content || content.length !== details.size || sha256(content) !== details.sha256) throw invalid(`${title} is damaged: ${name} is missing or changed.`);
      }
      this.set(skin, slot, { title, revision: sha256(bytes).slice(0, 16) });
    } catch (err) {
      this.set(skin, slot, { title: title || null, problem: err.status ? err.message : `${title || 'This piece'} is damaged.` });
    }
  }

  async exclusive(skin, slot, work) {
    if (!Object.hasOwn(WORLDS, skin)) throw failure(404, 'unknown_yard', 'There is no such Yard.');
    if (!SLOTS.includes(slot)) throw failure(404, 'unknown_slot', 'There is no such character or companion.');
    if (!this.dir) throw failure(409, 'pieces_unsupported', 'This manager has no data folder to keep pieces in.');
    if (this.busy) throw failure(409, 'piece_busy', 'Another piece is being changed. Try again when it finishes.');
    this.busy = true;
    let before;
    try {
      await this.swept;
      before = JSON.stringify(this.pieces[skin]?.[slot] ?? null);
      await work();
    } catch (err) {
      if (err.status) throw err;
      throw failure(500, 'piece_unwritable', `Agent Guild cannot write to its data folder: ${err.message}`);
    } finally {
      this.read(skin, slot);
      this.busy = false;
      if (JSON.stringify(this.pieces[skin]?.[slot] ?? null) !== before) this.emit('updated', this.snapshot());
    }
    return this.snapshot();
  }

  replace(skin, slot, folder) {
    return this.exclusive(skin, slot, async () => {
      const kind = KIND(slot);
      if (typeof folder !== 'string' || !path.isAbsolute(folder) || folder.includes('\0')) throw invalid('Choose a piece folder.');
      try {
        if (!(await fsp.stat(folder)).isDirectory()) throw invalid('Choose a piece folder.');
      } catch (err) {
        throw err.status ? err : invalid('This folder can’t be read.');
      }
      const manifest = await readSource(folder, MANIFEST, MAX_MANIFEST);
      const title = readManifest(manifest, kind).title || path.basename(folder);
      const files = new Map([[MANIFEST, manifest]]);
      for (const name of MODELS[kind]) files.set(name, await readSource(folder, name, LIMITS[kind].bytes));
      const target = path.join(this.dir, skin, slot), staging = this.aside(skin, slot, 'staging'), previous = this.aside(skin, slot, 'old');
      await fsp.mkdir(path.join(this.dir, skin), { recursive: true });
      try {
        await fsp.mkdir(staging);
        for (const [name, bytes] of files) await fsp.writeFile(path.join(staging, name), bytes);
        await this.check(MODELS[kind].map((name) => ({ path: path.join(staging, name), name })), kind);
        const install = { id: crypto.randomUUID(), title, files: Object.fromEntries([...files].map(([name, bytes]) => [name, { size: bytes.length, sha256: sha256(bytes) }])) };
        await fsp.writeFile(path.join(staging, INSTALL), JSON.stringify(install));
        const had = fs.existsSync(target);
        if (had) await renameRetrying(target, previous);
        try { await renameRetrying(staging, target); } catch (err) {
          if (had) await renameRetrying(previous, target);
          throw err;
        }
        if (had) await renameRetrying(previous, this.aside(skin, slot, 'removed')).catch(() => {});
      } finally { await this.discard(staging); }
      await this.sweep();
    });
  }

  restore(skin, slot) {
    return this.exclusive(skin, slot, async () => {
      const target = path.join(this.dir, skin, slot);
      const names = await fsp.readdir(this.dir).catch(err => { if (err.code === 'ENOENT') return []; throw err; });
      for (const name of names) if (name.startsWith(`.${skin}.${slot}.`) && name.endsWith('.old')) {
        await renameRetrying(path.join(this.dir, name), this.aside(skin, slot, 'removed'));
      }
      if (fs.existsSync(target)) await renameRetrying(target, this.aside(skin, slot, 'removed'));
      await this.sweep();
    });
  }
}
