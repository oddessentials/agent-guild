import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  WINDOWS_APPROVED_KEY,
  WINDOWS_RUN_KEY,
  WINDOWS_VALUE,
  approvedDisabled,
  createAutostart,
  desktopArg,
  desktopEntry,
  desktopEntryEnabled,
  launchAgentPlist,
  windowsRunCommand,
  windowsWrapper,
} from '../src/manager/autostart.mjs';
import { createManagerServer } from '../src/manager/server.mjs';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-autostart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** reg.exe over an in-memory registry: `values` maps "key\0name" to { type, data }. */
function fakeReg({ failAdd = false } = {}) {
  const values = new Map();
  const calls = [];
  const reg = async (args) => {
    calls.push(args);
    const [verb, key, , name] = args;
    const id = `${key}\0${name}`;
    if (verb === 'query') {
      const v = values.get(id);
      return v ? { status: 0, stdout: `\r\n${key}\r\n    ${name}    ${v.type}    ${v.data}\r\n\r\n`, stderr: '' } : { status: 1, stdout: '', stderr: 'ERROR: not found' };
    }
    if (verb === 'add') {
      if (failAdd) return { status: 1, stdout: '', stderr: 'ERROR: Access is denied.' };
      values.set(id, { type: args[args.indexOf('/t') + 1], data: args[args.indexOf('/d') + 1] });
      return { status: 0, stdout: '', stderr: '' };
    }
    if (verb === 'delete') return values.delete(id) ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: 'ERROR: not found' };
    throw new Error(`unexpected reg ${verb}`);
  };
  return { reg, values, calls };
}

test('the Windows wrapper runs the launcher hidden and keeps any path intact in an ASCII file', () => {
  const execPath = 'C:\\Program Files\\nodejs\\node.exe';
  const script = 'C:\\Users\\Zoë 中\\AppData\\Roaming\\npm\\node_modules\\@oddessentials\\agent-guild\\bin\\agent-guild.mjs';
  const text = windowsWrapper({ execPath, script });
  assert.match(text, /^[\x00-\x7f]*$/);
  const literal = text.match(/\.Run\((".*"), 0, false\);/)[1];
  assert.equal(JSON.parse(literal), `"${execPath}" "${script}" open --no-browser`);
  assert.equal(
    windowsRunCommand({ env: { SystemRoot: 'C:\\Windows' }, wrapper: 'C:\\Users\\Zoë\\AppData\\Roaming\\AgentGuild\\autostart.js' }),
    '"C:\\Windows\\System32\\wscript.exe" //B //NoLogo "C:\\Users\\Zoë\\AppData\\Roaming\\AgentGuild\\autostart.js"',
  );
});

test('the LaunchAgent runs at load, escapes its paths and outlives the launching command', () => {
  const text = launchAgentPlist({ execPath: '/opt/node & co/bin/node', script: '/Users/a/<guild>/bin/agent-guild.mjs' });
  assert.match(text, /<string>\/opt\/node &amp; co\/bin\/node<\/string>\s*<string>\/Users\/a\/&lt;guild&gt;\/bin\/agent-guild\.mjs<\/string>\s*<string>open<\/string>\s*<string>--no-browser<\/string>/);
  assert.match(text, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(text, /<key>AbandonProcessGroup<\/key><true\/>/);
  assert.doesNotMatch(text, /KeepAlive/);
});

test('desktop entry arguments follow the quoting and string escape rules', () => {
  assert.equal(desktopArg('/home/a b/50%$x'), '"/home/a b/50%%\\\\$x"');
  assert.equal(desktopArg('/a"b`c\\d'), '"/a\\\\"b\\\\`c\\\\\\\\d"');
  assert.match(desktopEntry({ execPath: '/usr/bin/node', script: '/opt/guild/bin/agent-guild.mjs' }), /^Exec="\/usr\/bin\/node" "\/opt\/guild\/bin\/agent-guild\.mjs" open --no-browser$/m);
  assert.equal(desktopEntryEnabled('[Desktop Entry]\nX-GNOME-Autostart-enabled=true\n'), true);
  assert.equal(desktopEntryEnabled('[Desktop Entry]\nHidden=true\n'), false);
  assert.equal(desktopEntryEnabled('[Desktop Entry]\nX-GNOME-Autostart-enabled=false\n'), false);
});

test('a Task Manager "Disabled" is read from the StartupApproved flags', () => {
  const row = (hex) => `\r\nHKEY_CURRENT_USER\\...\\Run\r\n    AgentGuild    REG_BINARY    ${hex}\r\n`;
  assert.equal(approvedDisabled(row('020000000000000000000000')), false);
  assert.equal(approvedDisabled(row('03000000D2C2B1E0A73FDB01')), true);
  assert.equal(approvedDisabled(row('07000000D2C2B1E0A73FDB01')), true);
  assert.equal(approvedDisabled(''), false);
});

for (const platform of ['linux', 'darwin']) {
  test(`${platform}: the entry is added, kept current at start, and removed`, async (t) => {
    const home = tempDir(t);
    const file = platform === 'darwin'
      ? path.join(home, 'Library', 'LaunchAgents', 'com.oddessentials.agent-guild.plist')
      : path.join(home, 'xdg', 'autostart', 'agent-guild.desktop');
    const options = { platform, home, release: '6.8.0', env: { XDG_CONFIG_HOME: path.join(home, 'xdg') }, script: '/pkg/bin/agent-guild.mjs', dataDir: home };
    const autostart = createAutostart({ ...options, execPath: '/old/node' });
    assert.deepEqual(await autostart.describe(), { available: true, enabled: false, reason: null });
    await autostart.refresh();
    assert.equal(fs.existsSync(file), false, 'refresh never turns it on');

    assert.deepEqual(await autostart.set(true), { available: true, enabled: true, reason: null });
    assert.match(fs.readFileSync(file, 'utf8'), /\/old\/node/);

    await createAutostart({ ...options, execPath: '/new/node' }).refresh();
    assert.match(fs.readFileSync(file, 'utf8'), /\/new\/node/);

    assert.deepEqual(await autostart.set(false), { available: true, enabled: false, reason: null });
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(await autostart.set(false), { available: true, enabled: false, reason: null }, 'turning off twice is fine');
  });
}

test('linux: an entry a desktop turned off reads as off and is left alone', async (t) => {
  const home = tempDir(t);
  const file = path.join(home, '.config', 'autostart', 'agent-guild.desktop');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const disabled = '[Desktop Entry]\nExec=/old/node x\nX-GNOME-Autostart-enabled=false\n';
  fs.writeFileSync(file, disabled);
  const autostart = createAutostart({ platform: 'linux', home, release: '6.8.0', env: {}, execPath: '/new/node', script: '/pkg/bin/agent-guild.mjs', dataDir: home });
  assert.equal((await autostart.describe()).enabled, false);
  await autostart.refresh();
  assert.equal(fs.readFileSync(file, 'utf8'), disabled);
  await autostart.set(true);
  assert.equal(desktopEntryEnabled(fs.readFileSync(file, 'utf8')), true);
});

test('WSL, other systems and a custom data folder are unavailable and refuse changes', async () => {
  const base = { home: '/home/a', env: {}, script: '/pkg/bin/agent-guild.mjs', dataDir: '/data' };
  const cases = [
    [{ platform: 'linux', release: '5.15.153.1-microsoft-standard-WSL2' }, /WSL/],
    [{ platform: 'linux', release: '6.8.0', env: { WSL_DISTRO_NAME: 'Ubuntu' } }, /WSL/],
    [{ platform: 'freebsd', release: '14.0' }, /operating system/],
    [{ platform: 'linux', release: '6.8.0', unavailable: 'Not available while AGENT_GUILD_HOME sets the data folder.' }, /AGENT_GUILD_HOME/],
  ];
  for (const [options, reason] of cases) {
    const autostart = createAutostart({ ...base, ...options });
    const described = await autostart.describe();
    assert.equal(described.available, false);
    assert.equal(described.enabled, false);
    assert.match(described.reason, reason);
    await assert.rejects(autostart.set(true), (err) => err.status === 409 && err.code === 'autostart_unavailable');
    await autostart.refresh();
  }
});

test('Windows: the Run value starts the wrapper, clears a Task Manager "Disabled", and is removed with it', async (t) => {
  const dataDir = tempDir(t);
  const wrapper = path.join(dataDir, 'autostart.js');
  const { reg, values } = fakeReg();
  const options = { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, home: dataDir, script: 'C:\\pkg\\bin\\agent-guild.mjs', dataDir, reg };
  const autostart = createAutostart({ ...options, execPath: 'C:\\old\\node.exe' });
  assert.deepEqual(await autostart.describe(), { available: true, enabled: false, reason: null });

  values.set(`${WINDOWS_APPROVED_KEY}\0${WINDOWS_VALUE}`, { type: 'REG_BINARY', data: '03000000D2C2B1E0A73FDB01' });
  assert.deepEqual(await autostart.set(true), { available: true, enabled: true, reason: null });
  assert.deepEqual(values.get(`${WINDOWS_RUN_KEY}\0${WINDOWS_VALUE}`), { type: 'REG_SZ', data: windowsRunCommand({ env: options.env, wrapper }) });
  assert.equal(values.has(`${WINDOWS_APPROVED_KEY}\0${WINDOWS_VALUE}`), false);
  assert.match(fs.readFileSync(wrapper, 'utf8'), /old\\\\node\.exe/);

  await createAutostart({ ...options, execPath: 'C:\\new\\node.exe' }).refresh();
  assert.match(fs.readFileSync(wrapper, 'utf8'), /new\\\\node\.exe/);

  // Turned off in Task Manager: off here, and a start does not rewrite it.
  values.set(`${WINDOWS_APPROVED_KEY}\0${WINDOWS_VALUE}`, { type: 'REG_BINARY', data: '03000000D2C2B1E0A73FDB01' });
  assert.equal((await autostart.describe()).enabled, false);
  await createAutostart({ ...options, execPath: 'C:\\other\\node.exe' }).refresh();
  assert.match(fs.readFileSync(wrapper, 'utf8'), /new\\\\node\.exe/);

  assert.deepEqual(await autostart.set(false), { available: true, enabled: false, reason: null });
  assert.equal(values.size, 0);
  assert.equal(fs.existsSync(wrapper), false);
});

test('Windows: a refused registry change is reported and leaves it off', async (t) => {
  const dataDir = tempDir(t);
  const { reg } = fakeReg({ failAdd: true });
  const autostart = createAutostart({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, home: dataDir, execPath: 'C:\\node.exe', script: 'C:\\pkg\\bin\\agent-guild.mjs', dataDir, reg });
  await assert.rejects(autostart.set(true), (err) => err.status === 500 && err.code === 'autostart_failed' && /Access is denied/.test(err.message));
  assert.equal((await autostart.describe()).enabled, false);
});

test('the autostart API needs the manager token and a boolean', { timeout: 10000 }, async (t) => {
  let enabled = false;
  const autostart = {
    describe: async () => ({ available: true, enabled, reason: null }),
    set: async (value) => { enabled = value; return { available: true, enabled, reason: null }; },
  };
  const manager = Object.assign(new EventEmitter(), { list: () => [] });
  const registry = Object.assign(new EventEmitter(), { warnings: [] });
  const api = createManagerServer({ manager, registry, autostart, token: 'test-manager-token', webDir: fileURLToPath(new URL('../web', import.meta.url)) });
  await api.listen();
  t.after(() => api.close());
  const send = (method, body, token = 'test-manager-token') => fetch(`${api.url}/api/v1/autostart`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal((await send('GET', undefined, 'wrong')).status, 401);
  assert.equal((await send('PUT', { enabled: true }, 'wrong')).status, 401);
  assert.equal(enabled, false);
  assert.deepEqual(await (await send('GET')).json(), { autostart: { available: true, enabled: false, reason: null } });
  const bad = await send('PUT', { enabled: 'yes' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'bad_request');
  assert.deepEqual(await (await send('PUT', { enabled: true })).json(), { autostart: { available: true, enabled: true, reason: null } });
  assert.equal(enabled, true);
});

test('a manager without autostart answers 404, which hides the setting', { timeout: 10000 }, async (t) => {
  const manager = Object.assign(new EventEmitter(), { list: () => [] });
  const registry = Object.assign(new EventEmitter(), { warnings: [] });
  const api = createManagerServer({ manager, registry, token: 't', webDir: fileURLToPath(new URL('../web', import.meta.url)) });
  await api.listen();
  t.after(() => api.close());
  assert.equal((await fetch(`${api.url}/api/v1/autostart`, { headers: { Authorization: 'Bearer t' } })).status, 404);
});
