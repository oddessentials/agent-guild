import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { folderPickTarget, createFolderPicker } from '../src/manager/folder-picker.mjs';
import { SessionManager } from '../src/manager/session-manager.mjs';
import { createManagerServer } from '../src/manager/server.mjs';

const resolveCwd = (cwd) => SessionManager.prototype.resolveCwd(cwd);
const windows = { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, release: '', fileExists: () => true };
const linux = { platform: 'linux', env: { PATH: '/usr/bin', DISPLAY: ':0' }, release: 'linux', fileExists: () => true };
const mac = { platform: 'darwin', env: {}, release: '', fileExists: () => true };
const wsl = { platform: 'linux', env: { PATH: '/usr/bin:/mnt/c/ps', WSL_DISTRO_NAME: 'Ubuntu', WSLENV: 'OTHER' }, release: 'microsoft', fileExists: () => true };

/** Each reply is `{ out, code }` for one helper process, or `{ stay: true }` for one that runs until killed. */
function helper(...replies) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const reply = replies[calls.length] || {};
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() { return this; } });
    child.kill = () => { child.killed = true; child.emit('close', null); };
    calls.push({ command, args, options, child });
    if (!reply.stay) queueMicrotask(() => {
      if (reply.out) child.stdout.emit('data', reply.out);
      child.emit('close', reply.code ?? 0);
    });
    return child;
  };
  return { calls, spawnImpl };
}

function folder(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'guild-pick-folder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('each platform has its own folder dialog, and reports why when it has none', () => {
  assert.equal(folderPickTarget(windows).command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(folderPickTarget(mac).command, '/usr/bin/osascript');
  assert.deepEqual([folderPickTarget(wsl).command, folderPickTarget(wsl).translate], ['/usr/bin/powershell.exe', '/usr/bin/wslpath']);
  assert.equal(folderPickTarget(linux).kind, 'zenity');
  assert.equal(folderPickTarget({ ...linux, fileExists: (file) => file.endsWith('kdialog') }).command, '/usr/bin/kdialog');
  for (const options of [
    { ...linux, env: { PATH: '/usr/bin' } },
    { ...linux, fileExists: () => false },
    { ...wsl, fileExists: () => false },
    { platform: 'freebsd', env: {} },
  ]) {
    const target = folderPickTarget(options);
    assert.equal(target.available, false);
    assert.ok(target.reason);
  }
});

test('Windows passes the start folder in the environment and returns the chosen folder', async (t) => {
  const dir = folder(t);
  const fake = helper({ out: dir });
  const picker = createFolderPicker({ resolveCwd, ...windows, ...fake });
  assert.equal(await picker.pick(dir), dir);
  const { command, args, options } = fake.calls[0];
  assert.equal(command, folderPickTarget(windows).command);
  assert.equal(args.at(-2), '-EncodedCommand');
  assert.match(Buffer.from(args.at(-1), 'base64').toString('utf16le'), /GuildFolderPicker/);
  assert.equal(options.env.AGENT_GUILD_PICK_START, dir);
  assert.equal(options.shell, false);
  assert.deepEqual(picker.describe(), { available: true, reason: null });
});

test('WSL hands Windows a translated start folder and translates the answer back', async (t) => {
  const dir = folder(t);
  const fake = helper({ out: 'C:\\picked\r\n' }, { out: `${dir}\n` });
  assert.equal(await createFolderPicker({ resolveCwd, ...wsl, ...fake }).pick(dir), dir);
  assert.equal(fake.calls[0].options.env.WSLENV, 'OTHER:AGENT_GUILD_PICK_START/p:AGENT_GUILD_PICK_TITLE');
  assert.deepEqual([fake.calls[1].command, fake.calls[1].args], ['/usr/bin/wslpath', ['-u', 'C:\\picked']]);
});

test('macOS and Linux dialogs open at the start folder, and a missing one falls back to home', async (t) => {
  const dir = folder(t);
  const home = fs.realpathSync(os.homedir());
  const onMac = helper({ out: `${dir}/\n` });
  assert.equal(await createFolderPicker({ resolveCwd, ...mac, ...onMac }).pick(path.join(dir, 'missing')), dir);
  assert.equal(fs.realpathSync(onMac.calls[0].args.at(-1)), home);
  const zenity = helper({ out: `${dir}\n` });
  assert.equal(await createFolderPicker({ resolveCwd, ...linux, ...zenity }).pick(dir), dir);
  assert.ok(zenity.calls[0].args.includes(`--filename=${dir}${path.sep}`));
  const kdialog = helper({ out: `${dir}\n` });
  await createFolderPicker({ resolveCwd, ...linux, fileExists: (file) => file.endsWith('kdialog'), ...kdialog }).pick(dir);
  assert.equal(kdialog.calls[0].args.at(-1), dir);
});

test('a cancelled dialog chooses nothing; failures and unusable answers are errors', async (t) => {
  const dir = folder(t);
  const file = path.join(dir, 'file.txt');
  fs.writeFileSync(file, 'file');
  for (const [platform, reply] of [[windows, {}], [mac, {}], [linux, { code: 1 }]]) {
    assert.equal(await createFolderPicker({ resolveCwd, ...platform, ...helper(reply) }).pick(dir), null);
  }
  for (const [platform, reply] of [[windows, { code: 1 }], [mac, { code: 1 }], [linux, { code: 5 }], [windows, { out: file }], [windows, { out: path.join(dir, 'missing') }]]) {
    await assert.rejects(createFolderPicker({ resolveCwd, ...platform, ...helper(reply) }).pick(dir), { status: 409, code: 'folder_pick_failed' });
  }
  await assert.rejects(createFolderPicker({ resolveCwd, ...windows, spawnImpl() { throw new Error('failed'); } }).pick(dir), { code: 'folder_pick_failed' });
  const unused = helper();
  for (const input of [null, {}, 7, 'a\nb']) {
    await assert.rejects(createFolderPicker({ resolveCwd, ...windows, ...unused }).pick(input), { status: 400, code: 'bad_cwd' });
  }
  await assert.rejects(createFolderPicker({ resolveCwd, ...linux, env: {}, ...unused }).pick(dir), { code: 'folder_pick_unavailable' });
  assert.equal(unused.calls.length, 0);
});

test('one dialog at a time, closed when the page that asked goes away', async (t) => {
  const dir = folder(t);
  const fake = helper({ stay: true }, { out: dir });
  const picker = createFolderPicker({ resolveCwd, ...windows, ...fake });
  const gone = new AbortController();
  const pending = picker.pick(dir, { signal: gone.signal });
  await assert.rejects(picker.pick(dir), { status: 409, code: 'folder_pick_busy' });
  gone.abort();
  assert.equal(await pending, null);
  assert.equal(fake.calls[0].child.killed, true);
  assert.equal(await picker.pick(dir), dir);
});

test('the pick API requires the manager token and advertises its capability', { timeout: 10000 }, async (t) => {
  const dir = folder(t);
  const fake = helper({ out: dir }, {});
  const folderPicker = createFolderPicker({ resolveCwd, ...windows, ...fake });
  const manager = Object.assign(new EventEmitter(), { list: () => [], resolveCwd });
  const registry = Object.assign(new EventEmitter(), { warnings: [] });
  const api = createManagerServer({ manager, registry, folderPicker, token: 'test-manager-token', webDir: fileURLToPath(new URL('../web', import.meta.url)) });
  await api.listen();
  t.after(() => api.close());
  const request = (headers = {}) => fetch(`${api.url}/api/v1/pick-folder`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ cwd: dir }),
  });
  const auth = { Authorization: 'Bearer test-manager-token' };
  assert.equal((await request()).status, 401);
  assert.equal((await request({ ...auth, Origin: 'https://example.com' })).status, 403);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(await (await request(auth)).json(), { path: dir });
  assert.deepEqual(await (await request(auth)).json(), { path: null });
  const info = await (await fetch(`${api.url}/api/v1/info`, { headers: auth })).json();
  assert.deepEqual(info.folderPicker, { available: true, reason: null });
});
