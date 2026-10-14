import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { YardArt, contentId, listArt, writeArchive } from '../src/manager/yard-art.mjs';

const ends = new Set(['ready', 'failed', 'cancelled']);
const settle = (art) => new Promise((resolve) => {
  const seen = (status) => { if (ends.has(status.state)) { art.off('updated', seen); resolve(status); } };
  art.on('updated', seen);
});

/** A package's web folder with art.json for `files`, and the pack the release would hold. */
async function release(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-yard-art-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, 'assets');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(assets, rel)), { recursive: true });
    fs.writeFileSync(path.join(assets, rel), body);
  }
  const list = await listArt(assets);
  const id = contentId(list);
  const pack = path.join(root, 'pack.tar.gz');
  const archive = await writeArchive(assets, list, pack);
  const web = path.join(root, 'web');
  fs.mkdirSync(path.join(web, 'yard'), { recursive: true });
  const serve = async (handler) => {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    fs.writeFileSync(path.join(web, 'yard', 'art.json'), JSON.stringify({ id, archive: { ...archive, name: 'pack.tar.gz', url: `https://example.test/pack.tar.gz` }, files: list }));
    return `http://127.0.0.1:${server.address().port}/pack.tar.gz`;
  };
  return { root, web, id, list, bytes: fs.readFileSync(pack), serve };
}

// The manifest names an https URL; tests redirect it to their local server.
const via = (url, counter = { requests: 0 }) => Object.assign((_url, options) => { counter.requests++; return fetch(url, options); }, { counter });

test('the content id names the art, not the archive, and the same art packs to the same bytes', async (t) => {
  const a = await release(t, { 'guild.glb': 'one', 'maps/guild-0.webp': 'two' });
  const b = await release(t, { 'maps/guild-0.webp': 'two', 'guild.glb': 'one' });
  const c = await release(t, { 'guild.glb': 'one', 'maps/guild-0.webp': 'three' });
  assert.equal(a.id, b.id);
  assert.deepEqual(a.bytes, b.bytes);
  assert.notEqual(a.id, c.id);
});

test('the first download installs the art, which is then reused offline without a request', async (t) => {
  const pack = await release(t, { 'guild.glb': 'model', 'guild/plates.json': '{}', 'maps/guild-0.webp': Buffer.alloc(70000, 7) });
  const url = await pack.serve((req, res) => res.end(pack.bytes));
  const dir = path.join(pack.root, 'data');
  const art = new YardArt({ webDir: pack.web, dir, fetch: via(url) });
  assert.equal(art.snapshot().state, 'missing');
  assert.equal(art.assetsDir(), null);
  const done = settle(art);
  art.start();
  assert.equal((await done).state, 'ready');
  assert.equal(fs.readFileSync(path.join(art.assetsDir(), 'guild', 'plates.json'), 'utf8'), '{}');
  assert.deepEqual(fs.readdirSync(dir), [pack.id]);

  const offline = via('http://127.0.0.1:1/unreachable');
  const again = new YardArt({ webDir: pack.web, dir, fetch: offline });
  assert.equal(again.snapshot().state, 'ready');
  assert.equal(again.start().state, 'ready');
  assert.equal(offline.counter.requests, 0);
});

test('an interrupted download and one that fails its check install nothing, and Retry recovers', async (t) => {
  const pack = await release(t, { 'guild.glb': crypto.randomBytes(200000) });
  let mode = 'cut';
  const url = await pack.serve((req, res) => {
    if (mode === 'cut') { res.writeHead(200, { 'Content-Length': pack.bytes.length }); res.write(pack.bytes.subarray(0, 1000)); res.destroy(); return; }
    if (mode === 'damaged') { const bytes = Buffer.from(pack.bytes); bytes[bytes.length - 20] ^= 0xff; res.end(bytes); return; }
    res.end(pack.bytes);
  });
  const dir = path.join(pack.root, 'data');
  const art = new YardArt({ webDir: pack.web, dir, fetch: via(url) });

  for (const [next, message] of [['cut', /terminated|aborted|closed|socket/i], ['damaged', /did not match/]]) {
    mode = next;
    const done = settle(art);
    art.start();
    const status = await done;
    assert.equal(status.state, 'failed', next);
    assert.match(status.error, message, next);
    assert.equal(art.assetsDir(), null, next);
    assert.deepEqual(fs.readdirSync(dir), [], next);
  }

  mode = 'whole';
  const done = settle(art);
  art.start();
  assert.equal((await done).state, 'ready');
});

test('one download serves every request for the art, and Cancel stops it for all of them', async (t) => {
  const pack = await release(t, { 'guild.glb': crypto.randomBytes(200000) });
  let reached;
  const requested = new Promise((resolve) => { reached = resolve; });
  const url = await pack.serve((req, res) => {
    res.writeHead(200, { 'Content-Length': pack.bytes.length });
    res.write(pack.bytes.subarray(0, 1000), reached);
  });
  const fetcher = via(url);
  const art = new YardArt({ webDir: pack.web, dir: path.join(pack.root, 'data'), fetch: fetcher });
  art.start();
  art.start();
  await requested;
  assert.equal(fetcher.counter.requests, 1);
  assert.equal(art.start().state, 'downloading');
  const done = settle(art);
  art.cancel();
  assert.equal((await done).state, 'cancelled');
  assert.deepEqual(fs.readdirSync(path.join(pack.root, 'data')), []);
});

test('a download that stops making progress fails', async (t) => {
  const pack = await release(t, { 'guild.glb': crypto.randomBytes(200000) });
  const url = await pack.serve((req, res) => { res.writeHead(200, { 'Content-Length': pack.bytes.length }); res.write(pack.bytes.subarray(0, 1000)); });
  const art = new YardArt({ webDir: pack.web, dir: path.join(pack.root, 'data'), fetch: via(url), stallMs: 50 });
  const done = settle(art);
  art.start();
  const status = await done;
  assert.equal(status.state, 'failed');
  assert.match(status.error, /stopped making progress/);
});

test('an upgrade keeps the art it has until the new art is installed, then removes it', async (t) => {
  const old = await release(t, { 'guild.glb': 'old' });
  const dir = path.join(old.root, 'data');
  const first = new YardArt({ webDir: old.web, dir, fetch: via(await old.serve((req, res) => res.end(old.bytes))) });
  const installed = settle(first);
  first.start();
  assert.equal((await installed).state, 'ready');

  const next = await release(t, { 'guild.glb': 'new' });
  let up = false;
  const url = await next.serve((req, res) => { if (up) res.end(next.bytes); else { res.statusCode = 503; res.end(); } });
  const upgraded = new YardArt({ webDir: next.web, dir, fetch: via(url) });
  assert.equal(upgraded.snapshot().state, 'missing');
  let done = settle(upgraded);
  upgraded.start();
  assert.match((await done).error, /503/);
  assert.deepEqual(fs.readdirSync(dir), [old.id]);

  up = true;
  done = settle(upgraded);
  upgraded.start();
  assert.equal((await done).state, 'ready');
  assert.deepEqual(fs.readdirSync(dir), [next.id]);
  assert.equal(fs.readFileSync(path.join(upgraded.assetsDir(), 'guild.glb'), 'utf8'), 'new');
});

test('a checkout serves its own art with no manifest and no download', () => {
  const art = new YardArt({ webDir: path.resolve('web'), dir: null, fetch: () => assert.fail('no download') });
  assert.deepEqual(art.snapshot(), { state: 'ready', source: 'checkout' });
  assert.equal(art.assetsDir(), path.resolve('web', 'yard', 'assets'));
});
