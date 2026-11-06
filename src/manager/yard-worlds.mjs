import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { WORLDS, CAMERA, SUN, STAGING } from '../../web/yard/model.mjs';
import { extractArchive, renameRetrying } from './yard-art.mjs';

const gunzip = promisify(zlib.gunzip);
const MANIFEST = 'world.json';
const FORMAT = 1;
const KIND = 'yard-environment';
const MAX_PACKAGE = 64 * 1024 * 1024;
const MAX_UNPACKED = 64 * 1024 * 1024;
const MAX_ENTRY = 16 * 1024 * 1024;
const MAX_RATIO = 20;
const RATIO_FROM = 8 * 1024 * 1024;
const MAX_SIDE = 4096;
const THEMES = ['light', 'dark'];
const TILES = ['base-0-0', 'base-1-0', 'detail-0-0', 'detail-1-0', 'close-0-0'];
const REQUIRED = [...THEMES.flatMap((theme) => TILES.map((tile) => `web/${theme}-${tile}.webp`)), 'web/sky-light.hdr', 'web/sky-dark.hdr'];
const ALLOWED = new Set([...REQUIRED, 'preview.jpg']);
const SERVED = new Set(REQUIRED.map((name) => name.slice('web/'.length)));

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });
const invalid = (message) => failure(400, 'world_invalid', message);

export function environmentId() {
  return sha256(JSON.stringify([CAMERA, SUN, STAGING.plaza])).slice(0, 16);
}

function checkManifest(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw invalid('This world’s details can’t be read.');
  if (!Number.isInteger(meta.format) || meta.format < 1) throw invalid('This world’s format is missing.');
  if (meta.format > FORMAT) throw invalid('This world needs a newer Agent Guild.');
  if (meta.kind !== KIND) throw invalid('This isn’t a Yard environment.');
  const title = typeof meta.title === 'string' ? meta.title.trim() : '';
  if (!title || title.length > 128 || /\p{Cc}/u.test(title)) throw invalid('This world’s title is missing or too long.');
  if (meta.environment !== environmentId()) throw invalid('This world was made for a different Yard layout, so it wouldn’t line up.');
  if (!meta.files || typeof meta.files !== 'object' || Array.isArray(meta.files)) throw invalid('This world’s list of files is missing.');
  let total = 0;
  for (const [name, file] of Object.entries(meta.files)) {
    if (!ALLOWED.has(name)) throw invalid(`${name} doesn’t belong in a world file.`);
    if (!Number.isSafeInteger(file?.size) || file.size < 0 || file.size > MAX_ENTRY || !/^[0-9a-f]{64}$/.test(file.sha256)) throw invalid(`${name} has invalid details.`);
    total += file.size;
  }
  if (total > MAX_UNPACKED) throw invalid('This world unpacks to more than a world may.');
  for (const name of REQUIRED) if (!Object.hasOwn(meta.files, name)) throw invalid(`${name} is missing.`);
  if (meta.lights !== undefined) {
    const colour = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffff;
    if (!THEMES.every((theme) => colour(meta.lights?.[theme]?.sun) && colour(meta.lights?.[theme]?.hemi))) throw invalid('This world’s light colours aren’t valid.');
  }
  return { title, lights: meta.lights ?? null };
}

function webpSize(b) {
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8 ' && b.length >= 30) return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  if (chunk === 'VP8L' && b.length >= 25) {
    const v = b.readUInt32LE(21);
    return [(v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1];
  }
  if (chunk === 'VP8X' && b.length >= 30) return [b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1];
  return [0, 0];
}

function checkContent(name, b) {
  if (name.endsWith('.webp')) {
    if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') throw invalid(`${name} isn’t a WebP image.`);
    if (webpSize(b).some((side) => side <= 0 || side > MAX_SIDE)) throw invalid(`${name} has an unsafe image size.`);
  } else if (name.endsWith('.hdr')) {
    const header = /^#\?RADIANCE\n(?:[^\n]*\n)*?\n-Y (\d{1,5}) \+X (\d{1,5})\n/.exec(b.toString('latin1', 0, 256));
    const [height, width] = header ? [Number(header[1]), Number(header[2])] : [0, 0];
    if (!header || !width || !height || width > MAX_SIDE || height > MAX_SIDE || b.length !== header[0].length + width * height * 4) throw invalid(`${name} isn’t a sky image.`);
  } else if (b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) throw invalid(`${name} isn’t a JPEG image.`);
}

async function readPackage(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0') || !file.toLowerCase().endsWith('.agworld')) throw invalid('Choose an .agworld file.');
  let raw;
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw invalid('Choose an .agworld file.');
    if (stat.size > MAX_PACKAGE) throw invalid('This file is larger than a world can be.');
    raw = await fsp.readFile(file);
  } catch (err) {
    if (err.status) throw err;
    throw invalid('This file can’t be read.');
  }
  let tar;
  try { tar = await gunzip(raw, { maxOutputLength: MAX_UNPACKED + 1 }); } catch (err) {
    throw invalid(err.code === 'ERR_BUFFER_TOO_LARGE' ? 'This world unpacks to more than a world may.' : 'This isn’t a world file.');
  }
  if (tar.length > MAX_UNPACKED) throw invalid('This world unpacks to more than a world may.');
  if (tar.length > RATIO_FROM && tar.length / raw.length > MAX_RATIO) throw invalid('This file expands far more than a world should.');
  const name = tar.toString('utf8', 0, 100).replace(/\0.*$/s, '');
  const size = parseInt(tar.toString('latin1', 124, 136).replace(/\0.*$/s, '').trim(), 8);
  const type = tar[156] === 0 ? '0' : String.fromCharCode(tar[156]);
  if (name !== MANIFEST || type !== '0' || !Number.isSafeInteger(size) || size > MAX_ENTRY || 512 + size > tar.length) throw invalid('This isn’t a world file.');
  const bytes = tar.subarray(512, 512 + size);
  let meta;
  try { meta = JSON.parse(bytes.toString('utf8')); } catch { throw invalid('This world’s details can’t be read.'); }
  checkManifest(meta);
  const files = [{ path: MANIFEST, size, sha256: sha256(bytes) }, ...Object.entries(meta.files).map(([entry, details]) => ({ path: entry, size: details.size, sha256: details.sha256 }))];
  return { files, meta };
}

export class YardWorlds extends EventEmitter {
  constructor({ dir = null } = {}) {
    super();
    this.dir = dir;
    this.worlds = {};
    this.busy = false;
    if (!dir || !fs.existsSync(dir)) return;
    for (const skin of Object.keys(WORLDS)) {
      const previous = path.join(dir, `.${skin}.old`);
      if (fs.existsSync(previous) && !fs.existsSync(path.join(dir, skin))) fs.renameSync(previous, path.join(dir, skin));
      this.read(skin);
    }
    for (const name of fs.readdirSync(dir)) if (name.startsWith('.')) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }

  snapshot() { return this.worlds; }

  file(skin, name) {
    return this.dir && Object.hasOwn(WORLDS, skin) && SERVED.has(name) ? path.join(this.dir, skin, 'web', name) : null;
  }

  read(skin) {
    const folder = path.join(this.dir, skin);
    if (!fs.existsSync(folder)) { delete this.worlds[skin]; return; }
    let title;
    try {
      const bytes = fs.readFileSync(path.join(folder, MANIFEST));
      const meta = JSON.parse(bytes.toString('utf8'));
      const checked = checkManifest(meta);
      title = checked.title;
      for (const [name, details] of Object.entries(meta.files)) {
        let content;
        try { content = fs.readFileSync(path.join(folder, ...name.split('/'))); } catch { content = null; }
        if (!content || content.length !== details.size || sha256(content) !== details.sha256) throw new Error(`${title} is damaged: ${name} is missing or changed.`);
      }
      this.worlds[skin] = { title, revision: sha256(bytes).slice(0, 16), lights: checked.lights };
    } catch (err) {
      this.worlds[skin] = { title: title ?? null, problem: err.status || title ? err.message : 'This Yard’s world is damaged.' };
    }
  }

  async exclusive(skin, work) {
    if (!Object.hasOwn(WORLDS, skin)) throw failure(404, 'unknown_yard', 'There is no such Yard.');
    if (!this.dir) throw failure(409, 'worlds_unsupported', 'This manager has no data folder to keep worlds in.');
    if (this.busy) throw failure(409, 'world_busy', 'Another world is being installed. Try again when it finishes.');
    this.busy = true;
    try {
      await work();
      this.read(skin);
      this.emit('updated', this.snapshot());
      return this.snapshot();
    } catch (err) {
      if (err.status) throw err;
      throw failure(500, 'world_unwritable', `Agent Guild cannot write to its data folder: ${err.message}`);
    } finally { this.busy = false; }
  }

  replace(skin, file) {
    return this.exclusive(skin, async () => {
      const { files } = await readPackage(file);
      const target = path.join(this.dir, skin), staging = path.join(this.dir, `.${skin}.staging`), previous = path.join(this.dir, `.${skin}.old`);
      await fsp.mkdir(this.dir, { recursive: true });
      await fsp.rm(staging, { recursive: true, force: true });
      try {
        try { await extractArchive(file, files, staging); } catch (err) {
          if (['ENOSPC', 'EACCES', 'EPERM', 'EBUSY', 'EROFS'].includes(err.code)) throw err;
          throw invalid(`This world file is damaged: ${err.message}.`);
        }
        for (const { path: name } of files) if (name !== MANIFEST) checkContent(name, await fsp.readFile(path.join(staging, ...name.split('/'))));
        const had = fs.existsSync(target);
        if (had) await renameRetrying(target, previous);
        try { await renameRetrying(staging, target); } catch (err) {
          if (had) await renameRetrying(previous, target);
          throw err;
        }
      } finally { await fsp.rm(staging, { recursive: true, force: true }); }
      await fsp.rm(previous, { recursive: true, force: true, maxRetries: 5 });
    });
  }

  restore(skin) {
    return this.exclusive(skin, () => fsp.rm(path.join(this.dir, skin), { recursive: true, force: true, maxRetries: 5 }));
  }
}
