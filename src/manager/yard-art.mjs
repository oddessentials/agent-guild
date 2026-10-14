// The Yard's models and textures. A checkout serves web/yard/assets as it is.
// An installed package carries only web/yard/art.json, which names the art
// pack on the GitHub release; the manager downloads it once, checks it, and
// keeps it in the data folder under its content id, so an upgrade with the
// same art reuses it and the Yard works offline afterwards.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const SAFE_PATH = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*\/)*[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const ID = /^[0-9a-f]{64}$/;
const STALL_MS = 60000;
const PROGRESS_MS = 200;

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** Every file under `dir`, sorted by path, with its size and SHA-256. */
export async function listArt(dir) {
  const files = [];
  const walk = async (folder, prefix) => {
    for (const entry of await fsp.readdir(folder, { withFileTypes: true })) {
      const rel = prefix + entry.name;
      if (entry.isDirectory()) await walk(path.join(folder, entry.name), rel + '/');
      else if (entry.isFile()) {
        if (!SAFE_PATH.test(rel) || Buffer.byteLength(rel) > 100) throw new Error(`${rel} cannot go in the art pack: use a short name of letters, digits, dots, dashes and underscores`);
        const body = await fsp.readFile(path.join(folder, entry.name));
        files.push({ path: rel, size: body.length, sha256: sha256(body) });
      } else throw new Error(`${rel} is not a file or folder`);
    }
  };
  await walk(dir, '');
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The art's identity: its sorted paths and their hashes, independent of how the archive was written. */
export function contentId(files) {
  return sha256(JSON.stringify(files.map((file) => [file.path, file.sha256])));
}

function tarHeader(name, size) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100, 8, 'latin1');
  block.write('0000000\0', 108, 8, 'latin1');
  block.write('0000000\0', 116, 8, 'latin1');
  block.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'latin1');
  block.write('00000000000\0', 136, 12, 'latin1');
  block.fill(0x20, 148, 156);
  block.write('0', 156, 1, 'latin1');
  block.write('ustar\u000000', 257, 8, 'latin1');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
  return block;
}

/**
 * Writes `files` from `dir` as a gzipped tar with fixed times, owners and modes,
 * so the same art and Node.js release give the same bytes.
 */
export async function writeArchive(dir, files, out) {
  async function* entries() {
    for (const file of files) {
      const body = await fsp.readFile(path.join(dir, ...file.path.split('/')));
      if (body.length !== file.size || sha256(body) !== file.sha256) throw new Error(`${file.path} changed while the pack was written`);
      yield tarHeader(file.path, body.length);
      yield body;
      if (body.length % 512) yield Buffer.alloc(512 - (body.length % 512));
    }
    yield Buffer.alloc(1024);
  }
  let first = true;
  // zlib records the operating system in the gzip header; name none.
  const portable = new Transform({ transform(chunk, _enc, done) { if (first && chunk.length > 9) { chunk[9] = 0xff; first = false; } done(null, chunk); } });
  const hash = crypto.createHash('sha256');
  let size = 0;
  const count = new Transform({ transform(chunk, _enc, done) { hash.update(chunk); size += chunk.length; done(null, chunk); } });
  await pipeline(Readable.from(entries()), zlib.createGzip({ level: 6 }), portable, count, fs.createWriteStream(out));
  return { size, sha256: hash.digest('hex') };
}

/**
 * Unpacks a pack into `into`, which must not exist, accepting exactly the
 * manifest's files with their sizes and hashes.
 */
export async function extractArchive(file, files, into, { signal } = {}) {
  const expected = new Map(files.map((entry) => [entry.path, entry]));
  const seen = new Set();
  await fsp.mkdir(into);
  let pending = [], pendingLength = 0, need = 512, header = null, ended = false;
  const take = (n) => {
    const all = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingLength);
    pending = all.length > n ? [all.subarray(n)] : [];
    pendingLength = all.length - n;
    return all.subarray(0, n);
  };
  const sink = new Writable({
    async write(chunk, _enc, done) {
      try {
        if (signal?.aborted) throw signal.reason;
        pending.push(chunk);
        pendingLength += chunk.length;
        while (!ended && pendingLength >= need) {
          if (!header) {
            const block = take(512);
            if (block.every((byte) => byte === 0)) { ended = true; break; }
            const field = (start, length) => { const raw = block.subarray(start, start + length); const end = raw.indexOf(0); return raw.toString('utf8', 0, end === -1 ? length : end); };
            const name = field(0, 100), size = parseInt(field(124, 12).trim() || '0', 8), type = field(156, 1) || '0';
            const want = expected.get(name);
            if (type !== '0') throw new Error(`the pack holds ${name || 'an entry'} that is not a plain file`);
            if (!want) throw new Error(`the pack holds ${name}, which the manifest does not list`);
            if (seen.has(name)) throw new Error(`the pack holds ${name} twice`);
            if (size !== want.size) throw new Error(`${name} is ${size} bytes in the pack, not ${want.size}`);
            header = { name, size, want };
            need = Math.ceil(size / 512) * 512;
          } else {
            const body = take(need).subarray(0, header.size);
            if (sha256(body) !== header.want.sha256) throw new Error(`${header.name} does not match the manifest`);
            const target = path.join(into, ...header.name.split('/'));
            await fsp.mkdir(path.dirname(target), { recursive: true });
            await fsp.writeFile(target, body);
            seen.add(header.name);
            header = null;
            need = 512;
          }
        }
        done();
      } catch (err) { done(err); }
    },
  });
  await pipeline(fs.createReadStream(file), zlib.createGunzip(), sink, { signal });
  if (header) throw new Error(`the pack ends inside ${header.name}`);
  const missing = files.filter((entry) => !seen.has(entry.path));
  if (missing.length) throw new Error(`the pack is missing ${missing.length === 1 ? missing[0].path : `${missing.length} files`}`);
}

export function readManifest(file) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`${file} is not readable: ${err.message}`);
  }
  const { id, archive, files } = manifest;
  const valid = ID.test(id) && archive && typeof archive.url === 'string' && /^https:\/\//.test(archive.url) && /^[0-9a-f]{64}$/.test(archive.sha256) && Number.isSafeInteger(archive.size) &&
    Array.isArray(files) && files.length > 0 && files.every((entry) => SAFE_PATH.test(entry?.path) && Number.isSafeInteger(entry.size) && /^[0-9a-f]{64}$/.test(entry.sha256)) && contentId(files) === id;
  if (!valid) throw new Error(`${file} does not describe an art pack`);
  return manifest;
}

const failure = (err) => {
  if (err.code === 'ENOSPC') return 'There is not enough free disk space for the Yard’s art.';
  if (err.code === 'EACCES' || err.code === 'EPERM') return `Agent Guild cannot write to its data folder: ${err.message}`;
  if (err.message === 'fetch failed') return `The Yard’s art could not be downloaded (${err.cause?.code || err.cause?.message || 'no connection'}). Check the internet connection.`;
  return err.message;
};

/**
 * One manager-owned download per content id. States: ready, missing,
 * downloading, installing, failed, cancelled, unavailable.
 */
export class YardArt extends EventEmitter {
  constructor({ webDir, dir = null, fetch = globalThis.fetch, stallMs = STALL_MS }) {
    super();
    this.checkout = path.join(webDir, 'yard', 'assets');
    this.dir = dir;
    this.fetch = fetch;
    this.stallMs = stallMs;
    this.job = null;
    this.lastProgress = 0;
    if (fs.existsSync(this.checkout)) {
      this.manifest = null;
      this.status = { state: 'ready', source: 'checkout' };
      return;
    }
    try {
      this.manifest = readManifest(path.join(webDir, 'yard', 'art.json'));
    } catch (err) {
      this.manifest = null;
      this.status = { state: 'unavailable', error: err.message };
      return;
    }
    if (!this.manifest || !dir) {
      this.manifest = null;
      this.status = { state: 'unavailable', error: 'This copy of Agent Guild has no Yard art.' };
      return;
    }
    this.active = path.join(dir, this.manifest.id);
    this.status = fs.existsSync(this.active) ? { state: 'ready', source: 'pack' } : { state: 'missing' };
  }

  /** The folder /yard/assets/ is served from, or null until the art is installed. */
  assetsDir() {
    if (this.status.source === 'checkout') return this.checkout;
    return this.status.state === 'ready' ? this.active : null;
  }

  snapshot() {
    const total = this.manifest ? { size: this.manifest.archive.size } : {};
    return { ...total, ...this.status };
  }

  set(status, { force = true } = {}) {
    const now = Date.now();
    if (!force && now - this.lastProgress < PROGRESS_MS) { this.status = status; return; }
    this.lastProgress = now;
    this.status = status;
    this.emit('updated', this.snapshot());
  }

  /** Starts the download unless one is running or the art is installed. */
  start() {
    if (this.job || !this.manifest || this.status.state === 'ready') return this.snapshot();
    const controller = new AbortController();
    const job = { controller, cancelled: false };
    this.job = job;
    this.set({ state: 'downloading', received: 0 });
    // The job ends before its outcome is announced, so a Retry that answers it starts a new one.
    job.done = this.install(job).then(() => ({ state: 'ready', source: 'pack' }), (err) => (job.cancelled ? { state: 'cancelled' } : { state: 'failed', error: failure(err) }))
      .then((status) => { this.job = null; this.set(status); });
    return this.snapshot();
  }

  cancel() {
    if (this.job) {
      this.job.cancelled = true;
      this.job.controller.abort(new Error('cancelled'));
    }
    return this.snapshot();
  }

  async install(job) {
    const { id, archive, files } = this.manifest;
    const { signal } = job.controller;
    await fsp.mkdir(this.dir, { recursive: true });
    // Leftovers of an interrupted run; installed packs stay until this one is active.
    for (const name of await fsp.readdir(this.dir)) {
      if (name.startsWith('.')) await fsp.rm(path.join(this.dir, name), { recursive: true, force: true });
    }
    const part = path.join(this.dir, `.${id}.part`);
    const staging = path.join(this.dir, `.${id}.staging`);
    try {
      let timer;
      const stalled = () => { clearTimeout(timer); timer = setTimeout(() => job.controller.abort(new Error('The download stopped making progress.')), this.stallMs); };
      stalled();
      try {
        const response = await this.fetch(archive.url, { signal, redirect: 'follow' });
        if (!response.ok) throw new Error(`The download failed: the server answered ${response.status}.`);
        const hash = crypto.createHash('sha256');
        let received = 0;
        const count = new Transform({
          transform: (chunk, _enc, done) => {
            stalled();
            received += chunk.length;
            if (received > archive.size) return done(new Error('The download is larger than the Yard’s art.'));
            hash.update(chunk);
            this.set({ state: 'downloading', received }, { force: false });
            done(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(response.body), count, fs.createWriteStream(part), { signal });
        if (received !== archive.size || hash.digest('hex') !== archive.sha256) throw new Error('The download did not match the Yard’s art. It may have been damaged on the way.');
      } catch (err) {
        throw signal.aborted && !job.cancelled ? signal.reason : err;
      } finally { clearTimeout(timer); }
      this.set({ state: 'installing' });
      await extractArchive(part, files, staging, { signal });
      if (signal.aborted) throw signal.reason;
      await renameRetrying(staging, this.active);
    } finally {
      await fsp.rm(part, { force: true });
      await fsp.rm(staging, { recursive: true, force: true });
    }
    for (const name of await fsp.readdir(this.dir)) {
      if (name !== id && ID.test(name)) await fsp.rm(path.join(this.dir, name), { recursive: true, force: true }).catch(() => {});
    }
  }
}

// Windows can hold a just-written folder briefly (indexing, antivirus).
async function renameRetrying(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return await fsp.rename(from, to); } catch (err) {
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
