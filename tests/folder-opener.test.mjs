import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { folderOpenTarget, createFolderOpener } from '../src/manager/folder-opener.mjs';
import { SessionManager } from '../src/manager/session-manager.mjs';
import { createManagerServer } from '../src/manager/server.mjs';

const resolveCwd = (cwd) => SessionManager.prototype.resolveCwd(cwd);
const windows = { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, release: '', fileExists: () => true };
const linux = { platform: 'linux', env: { PATH: '/usr/bin', DISPLAY: ':0' }, release: 'linux', fileExists: () => true };
const mac = { platform: 'darwin', env: {}, release: '', fileExists: () => true };

function launcher({ exitCode = 0, error, stay = false } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.unref = () => { child.unreffed = true; };
    calls.push({ command, args, options, child });
    queueMicrotask(() => {
      if (error) child.emit('error', error);
      else {
        child.emit('spawn');
        if (!stay) child.emit('exit', exitCode);
      }
    });
    return child;
  };
  return { calls, spawnImpl };
}

function folders(t) {
  // Match promises.realpath in the opener, including Windows short-name expansion.
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'guild-open-folder-'));
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync.native(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dir = path.join(root, "Project & notes, 100% $value '中'");
  fs.mkdirSync(dir);
  return { root, dir: fs.realpathSync.native(dir) };
}

test('native folder targets use system utilities and detect WSL separately from desktop Linux', () => {
  assert.equal(folderOpenTarget(windows).command, 'C:\\Windows\\explorer.exe');
  assert.equal(folderOpenTarget(mac).label, 'Finder');
  assert.equal(folderOpenTarget(linux).command, '/usr/bin/xdg-open');
  const wsl = folderOpenTarget({ platform: 'linux', release: '5.15-microsoft-standard-WSL2',
    env: { PATH: '.:relative:/mnt/c/Windows', DISPLAY: ':0' }, fileExists: (file) => file === '/mnt/c/Windows/explorer.exe' });
  assert.deepEqual([wsl.command, wsl.kind, wsl.available], ['/mnt/c/Windows/explorer.exe', 'explorer', true]);
  assert.equal(folderOpenTarget({ ...linux, env: { PATH: '.:relative', DISPLAY: ':0' } }).available, false);
  assert.equal(folderOpenTarget({ ...linux, env: { PATH: '/usr/bin', WAYLAND_DISPLAY: 'wayland-0' } }).available, true);
});

test('headless, missing utilities, unsupported platforms and WSL without interoperability are unavailable', () => {
  for (const options of [
    { ...linux, env: { PATH: '/usr/bin' } },
    { ...linux, fileExists: () => false },
    { ...windows, fileExists: () => false },
    { platform: 'freebsd', env: {} },
    { ...linux, env: { WSL_DISTRO_NAME: 'Ubuntu', PATH: '' } },
  ]) {
    const target = folderOpenTarget(options);
    assert.equal(target.available, false);
    assert.ok(target.reason);
  }
});

test('Windows opens a validated folder as the working directory with a fixed argument', async (t) => {
  const { dir } = folders(t);
  const fake = launcher({ exitCode: 1 });
  const opener = createFolderOpener({ resolveCwd, ...windows, ...fake });
  await opener.open(dir);
  const { command, args, options, child } = fake.calls[0];
  assert.equal(command, 'C:\\Windows\\explorer.exe');
  assert.deepEqual(args, ['.']);
  assert.equal(options.cwd, dir);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, false);
  assert.equal(child.unreffed, true);
  assert.deepEqual(opener.describe(), { available: true, label: 'File Explorer', reason: null });
});

test('Linux receives one absolute directory argument, preserving special characters', async (t) => {
  const { dir } = folders(t);
  const fake = launcher();
  await createFolderOpener({ resolveCwd, ...linux, ...fake }).open(dir);
  assert.deepEqual(fake.calls[0].args, [dir]);
  assert.equal(fake.calls[0].options.shell, false);
});

test('Finder is targeted explicitly and application packages are revealed without launching', async (t) => {
  const { root, dir } = folders(t);
  const fake = launcher();
  const opener = createFolderOpener({ resolveCwd, ...mac, ...fake, cooldownMs: 0 });
  await opener.open(dir);
  assert.deepEqual(fake.calls[0].args, ['-a', '/System/Library/CoreServices/Finder.app', dir]);
  const app = path.join(root, 'Example.APP');
  fs.mkdirSync(app);
  await opener.open(app);
  assert.deepEqual(fake.calls[1].args, ['-R', fs.realpathSync.native(app)]);
});

test('blank, tilde and relative paths match session folder resolution', async (t) => {
  const { dir } = folders(t);
  const fake = launcher();
  const opener = createFolderOpener({ resolveCwd, ...windows, ...fake, cooldownMs: 0 });
  for (const input of [undefined, '', '   ', '~']) await opener.open(input);
  for (const call of fake.calls) assert.equal(call.options.cwd, fs.realpathSync.native(os.homedir()));
  await opener.open(path.relative(process.cwd(), dir));
  assert.equal(fake.calls.at(-1).options.cwd, dir);
});

test('invalid inputs, missing directories, files and URLs never launch a process', async (t) => {
  const { root } = folders(t);
  const file = path.join(root, 'file.txt');
  fs.writeFileSync(file, 'file');
  const fake = launcher();
  const opener = createFolderOpener({ resolveCwd, ...windows, ...fake, cooldownMs: 0 });
  for (const input of [null, {}, [], 7, 'a\0b', 'a\nb', 'a\rb', 'https://example.com', 'file:///tmp', file, path.join(root, 'missing')]) {
    await assert.rejects(opener.open(input), { status: 400, code: 'bad_cwd' });
  }
  assert.equal(fake.calls.length, 0);
});

test('launch errors and unsuccessful exits are reported without leaking process details', async (t) => {
  const { dir } = folders(t);
  for (const options of [{ error: new Error('sensitive process details') }, { exitCode: 3 }, { exitCode: null }]) {
    const fake = launcher(options);
    await assert.rejects(createFolderOpener({ resolveCwd, ...linux, ...fake }).open(dir), (error) => {
      assert.equal(error.code, 'folder_open_failed');
      assert.doesNotMatch(error.message, /sensitive/);
      return true;
    });
  }
  await assert.rejects(createFolderOpener({ resolveCwd, ...windows, spawnImpl() { throw new Error('failed'); } }).open(dir), { code: 'folder_open_failed' });
});

test('a long-lived file manager releases the request; concurrent and rapid opens are throttled', async (t) => {
  const { dir } = folders(t);
  const fake = launcher({ stay: true });
  const opener = createFolderOpener({ resolveCwd, ...linux, ...fake, handoffMs: 10, cooldownMs: 10000 });
  const pending = opener.open(dir);
  await assert.rejects(opener.open(dir), { status: 429, code: 'folder_open_busy' });
  await pending;
  assert.equal(fake.calls[0].child.unreffed, true);
  await assert.rejects(opener.open(dir), { code: 'folder_open_busy' });
  fake.calls[0].child.emit('error', new Error('late failure'));
  assert.equal(fake.calls.length, 1);
});

test('unavailable desktops do not attempt to resolve or open a folder', async () => {
  await assert.rejects(createFolderOpener({ ...linux, env: {}, resolveCwd() { assert.fail('must not resolve'); } }).open(''), { code: 'folder_open_unavailable' });
});

test('the folder API requires the manager token and trusted source, and advertises its capability', { timeout: 10000 }, async (t) => {
  const { dir } = folders(t);
  const fake = launcher();
  const folderOpener = createFolderOpener({ resolveCwd, ...windows, ...fake, cooldownMs: 0 });
  const manager = Object.assign(new EventEmitter(), { list: () => [], resolveCwd });
  const registry = Object.assign(new EventEmitter(), { warnings: [] });
  const api = createManagerServer({ manager, registry, folderOpener, token: 'test-manager-token', webDir: fileURLToPath(new URL('../web', import.meta.url)) });
  await api.listen();
  t.after(() => api.close());
  const request = (headers = {}, method = 'POST', body = { cwd: dir }) => fetch(`${api.url}/api/v1/open-folder`, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
  const auth = { Authorization: 'Bearer test-manager-token' };
  for (const headers of [{}, { Authorization: 'Bearer wrong' }, { 'X-Agent-Guild-Report-Token': 'session-token' }]) {
    assert.equal((await request(headers)).status, 401);
  }
  for (const headers of [{ Origin: 'https://example.com' }, { Origin: 'null' }]) {
    assert.equal((await request({ ...auth, ...headers })).status, 403);
  }
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const req = http.request(`${api.url}/api/v1/open-folder`, { method: 'POST', headers: { ...auth, Host: 'evil.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end(JSON.stringify({ cwd: dir }));
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await request(auth, 'GET')).status, 404);
  assert.equal((await request(auth, 'POST', { cwd: {} })).status, 400);
  assert.equal(fake.calls.length, 0);
  const response = await request({ ...auth, Origin: api.url });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(fake.calls.length, 1);
  const info = await (await fetch(`${api.url}/api/v1/info`, { headers: auth })).json();
  assert.deepEqual(info.folderOpener, folderOpener.describe());
  const ws = new WebSocket(`${api.url.replace('http:', 'ws:')}/api/v1/events?token=test-manager-token`);
  t.after(() => ws.terminate());
  const hello = await new Promise((resolve, reject) => { ws.once('message', (data) => resolve(JSON.parse(data))); ws.once('error', reject); });
  assert.deepEqual(hello.folderOpener, folderOpener.describe());
  assert.equal(hello.platform, process.platform);
});

test('opening folders is local-only: remote clients see it unavailable and are refused', { timeout: 10000 }, async (t) => {
  const { dir } = folders(t);
  const fake = launcher();
  const folderOpener = createFolderOpener({ resolveCwd, ...windows, ...fake, cooldownMs: 0 });
  const manager = Object.assign(new EventEmitter(), { list: () => [], resolveCwd });
  const registry = Object.assign(new EventEmitter(), { warnings: [] });
  const host = 'guild.example.ts.net';
  const api = createManagerServer({ manager, registry, folderOpener, extraHosts: [host], token: 'test-manager-token', webDir: fileURLToPath(new URL('../web', import.meta.url)) });
  await api.listen();
  t.after(() => api.close());
  const auth = { Authorization: 'Bearer test-manager-token' };
  const send = (method, route, headers, body) => new Promise((resolve, reject) => {
    const req = http.request(`${api.url}/api/v1${route}`, { method, headers: { 'Content-Type': 'application/json', ...auth, ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (chunk) => { text += chunk; }).on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const reason = 'Only available on the computer running Agent Guild.';
  const refused = await send('POST', '/open-folder', { Host: host }, { cwd: dir });
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.body.error, { code: 'local_only', message: reason });
  assert.equal(fake.calls.length, 0);
  assert.deepEqual((await send('GET', '/info', { Host: host })).body.folderOpener, { ...folderOpener.describe(), available: false, reason });
  assert.deepEqual((await send('GET', '/info', {})).body.folderOpener, folderOpener.describe());
  for (const local of ['localhost', '127.0.0.1', '[::1]']) {
    assert.equal((await send('POST', '/open-folder', { Host: `${local}:${api.port}` }, { cwd: dir })).status, 200);
  }
  assert.equal(fake.calls.length, 3);
  const ws = new WebSocket(`${api.url.replace('http:', 'ws:')}/api/v1/events?token=test-manager-token`, { headers: { Host: host } });
  t.after(() => ws.terminate());
  const hello = await new Promise((resolve, reject) => { ws.once('message', (data) => resolve(JSON.parse(data))); ws.once('error', reject); });
  assert.deepEqual(hello.folderOpener, { ...folderOpener.describe(), available: false, reason });
});
