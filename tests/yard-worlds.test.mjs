import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { writeArchive } from '../src/manager/yard-art.mjs';
import { YardWorlds, environmentId } from '../src/manager/yard-worlds.mjs';
import { createFolderBrowser } from '../src/manager/folder-browser.mjs';
import { createManagerServer } from '../src/manager/server.mjs';

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

function webp(width = 4, height = 4) {
  const b = Buffer.alloc(32);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBP', 8, 'latin1');
  b.write('VP8 ', 12, 'latin1');
  b.writeUInt16LE(width, 26);
  b.writeUInt16LE(height, 28);
  return b;
}
const hdr = (width = 2, height = 2, pixels = width * height * 4) => Buffer.concat([Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`, 'latin1'), Buffer.alloc(pixels, 1)]);

const PLATES = ['light', 'dark'].flatMap((theme) => ['base-0-0', 'base-1-0', 'detail-0-0', 'detail-1-0', 'close-0-0'].map((tile) => `web/${theme}-${tile}.webp`));

function content() {
  return new Map([...PLATES.map((name) => [name, webp()]), ['web/sky-light.hdr', hdr()], ['web/sky-dark.hdr', hdr()], ['preview.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])]]);
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-worlds-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let made = 0;
  const pack = async ({ meta = {}, change = () => {}, name = `w${++made}.agworld` } = {}) => {
    const body = content();
    change(body);
    const dir = fs.mkdtempSync(path.join(root, 'pack-'));
    const manifest = {
      format: 1, kind: 'yard-environment', title: 'Lakeside', base: 'gnomeland', environment: environmentId(), generator: 1,
      lights: { light: { sun: 1, hemi: 2 }, dark: { sun: 3, hemi: 4 } },
      files: Object.fromEntries([...body].map(([file, bytes]) => [file, { size: bytes.length, sha256: sha256(bytes) }])),
      ...meta,
    };
    const json = Buffer.from(JSON.stringify(manifest));
    const write = (file, bytes) => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), bytes);
    };
    write('world.json', json);
    for (const [file, bytes] of body) write(file, bytes);
    const listing = [['world.json', json], ...body].map(([file, bytes]) => ({ path: file, size: bytes.length, sha256: sha256(bytes) }));
    const out = path.join(root, name);
    await writeArchive(dir, listing, out);
    return out;
  };
  return { root, pack, dir: path.join(root, 'worlds') };
}

const refused = (reason) => ({ status: 400, code: 'world_invalid', message: reason });

test('a world file replaces its Yard, and restoring deletes it', async (t) => {
  const { pack, dir } = setup(t);
  const worlds = new YardWorlds({ dir });
  const events = [];
  worlds.on('updated', (state) => events.push(Object.keys(state)));
  const snapshot = await worlds.replace('guild', await pack());
  assert.equal(snapshot.guild.title, 'Lakeside');
  assert.deepEqual(snapshot.guild.lights.dark, { sun: 3, hemi: 4 });
  assert.equal(fs.readFileSync(worlds.file('guild', 'light-base-0-0.webp')).length, webp().length);
  const reopened = new YardWorlds({ dir }).snapshot();
  assert.deepEqual(reopened, snapshot);
  await worlds.restore('guild');
  assert.deepEqual(worlds.snapshot(), {});
  assert.equal(fs.existsSync(path.join(dir, 'guild')), false);
  assert.deepEqual(events, [['guild'], []]);
});

test('a bad file is refused with the reason and the Yard keeps what it had', async (t) => {
  const { root, pack, dir } = setup(t);
  const worlds = new YardWorlds({ dir });
  const before = await worlds.replace('guild', await pack({ meta: { title: 'Before' } }));
  const bytes = fs.readFileSync(await pack());
  const tar = zlib.gunzipSync(bytes);
  const write = (name, data) => { const file = path.join(root, name); fs.writeFileSync(file, data); return file; };
  const flipped = Buffer.from(tar);
  flipped[512 + Math.ceil(parseInt(tar.toString('latin1', 124, 135), 8) / 512) * 512 + 512] ^= 0xff;
  const link = Buffer.from(tar);
  link[512 + Math.ceil(parseInt(tar.toString('latin1', 124, 135), 8) / 512) * 512 + 156] = 0x32;
  const big = path.join(root, 'big.agworld');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, 64 * 1024 * 1024 + 1);
  const cases = [
    ['a different extension', write('world.zip', bytes), /Choose an \.agworld/],
    ['a relative path', 'world.agworld', /Choose an \.agworld/],
    ['a missing file', path.join(root, 'none.agworld'), /can’t be read/],
    ['not gzip', write('text.agworld', 'hello'), /isn’t a world file/],
    ['too large a file', big, /larger than a world/],
    ['too large when unpacked', write('bomb.agworld', zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1))), /unpacks to more/],
    ['a changed byte', write('flip.agworld', zlib.gzipSync(flipped)), /damaged/],
    ['a link entry', write('link.agworld', zlib.gzipSync(link)), /damaged/],
    ['a newer format', await pack({ meta: { format: 2 } }), /newer Agent Guild/],
    ['another kind', await pack({ meta: { kind: 'other' } }), /isn’t a Yard environment/],
    ['another layout', await pack({ meta: { environment: '0000000000000000' } }), /different Yard layout/],
    ['a long title', await pack({ meta: { title: 'x'.repeat(129) } }), /title/],
    ['a control character in the title', await pack({ meta: { title: 'a\nb' } }), /title/],
    ['bad light colours', await pack({ meta: { lights: { light: { sun: -1, hemi: 0 } } } }), /light colours/],
    ['an unlisted name', await pack({ change: (body) => body.set('web/page.html', Buffer.from('<script>')) }), /doesn’t belong/],
    ['a climbing name', await pack({ meta: { files: { '../../evil.webp': { size: 1, sha256: '0'.repeat(64) } } } }), /doesn’t belong/],
    ['a missing plate', await pack({ change: (body) => body.delete('web/dark-close-0-0.webp') }), /is missing/],
    ['a plate that is not WebP', await pack({ change: (body) => body.set('web/light-base-0-0.webp', Buffer.from('<svg onload=alert(1)>')) }), /isn’t a WebP/],
    ['a huge plate', await pack({ change: (body) => body.set('web/light-base-0-0.webp', webp(4097, 4)) }), /unsafe image size/],
    ['a sky with a false size', await pack({ change: (body) => body.set('web/sky-dark.hdr', hdr(4000, 4000, 16)) }), /isn’t a sky/],
  ];
  for (const [label, file, reason] of cases) {
    await assert.rejects(worlds.replace('guild', file), refused(reason), label);
    assert.deepEqual(worlds.snapshot(), before, label);
    assert.deepEqual(fs.readdirSync(dir), ['guild'], label);
  }
  await assert.rejects(worlds.replace('nowhere', cases[0][1]), { status: 404, code: 'unknown_yard' });
  await assert.rejects(worlds.restore('constructor'), { status: 404, code: 'unknown_yard' });
});

test('a world damaged on disk, or made for another layout, is reported and can be restored', async (t) => {
  const { pack, dir } = setup(t);
  const worlds = new YardWorlds({ dir });
  await worlds.replace('grove', await pack());
  await worlds.replace('orbital', await pack());
  fs.rmSync(path.join(dir, 'grove', 'web', 'dark-close-0-0.webp'));
  const manifest = path.join(dir, 'orbital', 'world.json');
  fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, 'utf8')), environment: 'old' }));
  const reopened = new YardWorlds({ dir });
  assert.match(reopened.snapshot().grove.problem, /Lakeside is damaged: web\/dark-close-0-0\.webp/);
  assert.match(reopened.snapshot().orbital.problem, /different Yard layout/);
  assert.equal(reopened.snapshot().grove.revision, undefined);
  await reopened.restore('grove');
  assert.equal(reopened.snapshot().grove, undefined);
});

test('a replacement stopped between its two renames brings the old world back', async (t) => {
  const { pack, dir } = setup(t);
  const worlds = new YardWorlds({ dir });
  await worlds.replace('guild', await pack());
  fs.renameSync(path.join(dir, 'guild'), path.join(dir, '.guild.old'));
  fs.mkdirSync(path.join(dir, '.guild.staging'));
  assert.equal(new YardWorlds({ dir }).snapshot().guild.title, 'Lakeside');
  assert.deepEqual(fs.readdirSync(dir), ['guild']);
});

test('the API installs a chosen file, lists world files and serves only plates and skies', async (t) => {
  const { root, pack, dir } = setup(t);
  const file = await pack({ name: 'Mine.AGWORLD' });
  const manager = Object.assign(new EventEmitter(), { list: () => [], listExiting: () => [], resolveCwd: (cwd) => cwd });
  const registry = Object.assign(new EventEmitter(), { list: () => [], warnings: [], platform: process.platform, get: () => null });
  const api = createManagerServer({ manager, registry, folderBrowser: createFolderBrowser({ home: root }), yardWorlds: new YardWorlds({ dir }),
    token: 'test-manager-token', webDir: fileURLToPath(new URL('../web', import.meta.url)) });
  await api.listen();
  t.after(() => api.close());
  const call = (method, route, body) => fetch(`${api.url}${route}`, { method, headers: { Authorization: 'Bearer test-manager-token', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const listing = await (await call('GET', `/api/v1/folders?path=${encodeURIComponent(root)}&files=agworld`)).json();
  assert.deepEqual(listing.files, [{ name: 'Mine.AGWORLD', path: file }]);
  assert.equal((await (await call('GET', `/api/v1/folders?path=${encodeURIComponent(root)}`)).json()).files, undefined);
  const unauthenticated = await fetch(`${api.url}/api/v1/yard-worlds/guild`, { method: 'PUT', body: JSON.stringify({ path: file }) });
  assert.equal(unauthenticated.status, 401);
  const { yardWorlds } = await (await call('PUT', '/api/v1/yard-worlds/guild', { path: file })).json();
  assert.equal(yardWorlds.guild.title, 'Lakeside');
  const plate = await fetch(`${api.url}/yard/worlds/guild/light-base-0-0.webp`);
  assert.equal(plate.status, 200);
  assert.equal(plate.headers.get('content-type'), 'image/webp');
  assert.equal(plate.headers.get('x-content-type-options'), 'nosniff');
  await plate.arrayBuffer();
  for (const route of ['/yard/worlds/guild/world.json', '/yard/worlds/guild/preview.jpg', '/yard/worlds/guild/web/light-base-0-0.webp', '/yard/worlds/nowhere/light-base-0-0.webp', '/yard/worlds/guild/..%2Fworld.json']) {
    const response = await fetch(`${api.url}${route}`);
    assert.equal(response.status, 404, route);
    await response.arrayBuffer();
  }
  const bad = await call('PUT', '/api/v1/yard-worlds/guild', { path: 'no.txt' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'world_invalid');
  assert.deepEqual((await (await call('DELETE', '/api/v1/yard-worlds/guild')).json()).yardWorlds, {});
});
