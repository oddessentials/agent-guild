import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  WINDOWS_APPROVED_KEY,
  WINDOWS_RUN_KEY,
  WINDOWS_VALUE,
  LAUNCH_AGENT_LABEL,
  POSIX_LAUNCH,
  approvedDisabled,
  createAutostart,
  desktopArg,
  desktopEntry,
  desktopEntryEnabled,
  launchAgentPlist,
  launchAgentDisabled,
  stableExecPath,
  windowsRunCommand,
  windowsWrapper,
} from '../src/manager/autostart.mjs';
import { createManagerServer } from '../src/manager/server.mjs';

/** Reads an Exec value back as a desktop would: the string escapes, then the quoting, then `%%`. */
function desktopExecArgs(value) {
  const text = value.replace(/\\(.)/g, (_, c) => (c === '\\' ? '\\' : `\\${c}`));
  const args = [];
  for (const [, quoted, bare] of text.matchAll(/"((?:\\.|[^"\\])*)"|(\S+)/g)) {
    args.push((quoted !== undefined ? quoted.replace(/\\(.)/g, '$1') : bare).replace(/%%/g, '%'));
  }
  return args;
}

/** A module that records its arguments in `ran`, standing in for bin/agent-guild.mjs. */
const probe = (ran) => `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(ran)}, JSON.stringify({ args: process.argv.slice(2), port: process.env.AGENT_GUILD_PORT }));\n`;

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

function fakeLaunchctl() {
  const state = { disabled: false, failPrint: false, failEnable: false, refuseEnable: false };
  const calls = [];
  const launchctl = async (args) => {
    calls.push(args);
    const [verb, target] = args;
    assert.equal(target, verb === 'print-disabled' ? 'gui/501' : `gui/501/${LAUNCH_AGENT_LABEL}`);
    if (verb === 'print-disabled') return state.failPrint
      ? { status: 1, stdout: '', stderr: 'Could not find domain' }
      : { status: 0, stdout: `disabled services = {\n "${LAUNCH_AGENT_LABEL}" => ${state.disabled ? 'disabled' : 'enabled'}\n}`, stderr: '' };
    assert.equal(verb, 'enable');
    if (state.failEnable) return { status: 1, stdout: '', stderr: 'Operation not permitted' };
    if (!state.refuseEnable) state.disabled = false;
    return { status: 0, stdout: '', stderr: '' };
  };
  return { state, calls, launchctl };
}

test('the Windows wrapper runs the launcher hidden and keeps any path intact in an ASCII file', () => {
  const execPath = 'C:\\Program Files\\nodejs\\node.exe';
  const script = 'C:\\Users\\Zoë 中\\AppData\\Roaming\\npm\\node_modules\\@oddessentials\\agent-guild\\bin\\agent-guild.mjs';
  const text = windowsWrapper({ execPath, script, port: 51234 });
  assert.match(text, /shell\.Environment\("Process"\)\("AGENT_GUILD_PORT"\) = "51234";/);
  assert.match(text, /^[\x00-\x7f]*$/);
  const literal = text.match(/\.Run\((".*"), 0, false\);/)[1];
  assert.equal(JSON.parse(literal), `"${execPath}" "${script}" open --no-browser`);
  assert.equal(
    windowsRunCommand({ env: { SystemRoot: 'C:\\Windows' }, wrapper: 'C:\\Users\\Zoë\\AppData\\Roaming\\AgentGuild\\autostart.js' }),
    '"C:\\Windows\\System32\\wscript.exe" //B //NoLogo "C:\\Users\\Zoë\\AppData\\Roaming\\AgentGuild\\autostart.js"',
  );
});

test('the LaunchAgent runs at load, escapes its paths and outlives the launching command', () => {
  const text = launchAgentPlist({ execPath: '/opt/node & co/bin/node', script: '/Users/a/<guild>/bin/agent-guild.mjs', file: '/Users/a/Library/LaunchAgents/x.plist', port: 51234, log: '/Users/a/.agent-guild/manager.log' });
  const args = [...text.matchAll(/<string>([^<]*)<\/string>/g)].slice(1).map((m) => m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  assert.deepEqual(args, ['/bin/sh', '-c', POSIX_LAUNCH, '/opt/node & co/bin/node', '/Users/a/<guild>/bin/agent-guild.mjs', '/Users/a/Library/LaunchAgents/x.plist', '51234', '/Users/a/.agent-guild/manager.log']);
  assert.match(text, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(text, /<key>AbandonProcessGroup<\/key><true\/>/);
  assert.doesNotMatch(text, /KeepAlive/);
});

test('desktop entry arguments follow the quoting and string escape rules', () => {
  assert.equal(desktopArg('/home/a b/50%$x'), '"/home/a b/50%%\\\\$x"');
  assert.equal(desktopArg('/a"b`c\\d'), '"/a\\\\"b\\\\`c\\\\\\\\d"');
  const paths = { execPath: '/opt/my node/bin/node', script: '/home/a/50% "guild"/bin/agent-guild.mjs', file: '/home/a/.config/autostart/agent-guild.desktop', log: '/home/a/$HOME/manager.log' };
  const exec = desktopEntry(paths).match(/^Exec=(.*)$/m)[1];
  assert.deepEqual(desktopExecArgs(exec), ['/bin/sh', '-c', POSIX_LAUNCH, paths.execPath, paths.script, paths.file, '47821', paths.log]);
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
    const options = { platform, home, release: '6.8.0', env: { XDG_CONFIG_HOME: path.join(home, 'xdg') }, script: '/pkg/bin/agent-guild.mjs', dataDir: home, uid: 501, launchctl: fakeLaunchctl().launchctl };
    const autostart = createAutostart({ ...options, execPath: '/old/node' });
    assert.deepEqual(await autostart.describe(), { available: true, enabled: false, reason: null });
    await autostart.refresh();
    assert.equal(fs.existsSync(file), false, 'refresh never turns it on');

    assert.deepEqual(await autostart.set(true), { available: true, enabled: true, reason: null });
    assert.match(fs.readFileSync(file, 'utf8'), /\/old\/node/);

    await createAutostart({ ...options, execPath: '/new/node', getPort: () => 51234 }).refresh();
    assert.match(fs.readFileSync(file, 'utf8'), /\/new\/node/);
    assert.match(fs.readFileSync(file, 'utf8'), /51234/);

    assert.deepEqual(await autostart.set(false), { available: true, enabled: false, reason: null });
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(await autostart.set(false), { available: true, enabled: false, reason: null }, 'turning off twice is fine');
  });
}

test('launchd overrides recognize both output formats and reject unknown state', () => {
  const output = (value) => `disabled services = {\n "${LAUNCH_AGENT_LABEL}" => ${value}\n}`;
  for (const value of ['true', 'disabled']) assert.equal(launchAgentDisabled(output(value)), true);
  for (const value of ['false', 'enabled']) assert.equal(launchAgentDisabled(output(value)), false);
  assert.equal(launchAgentDisabled('disabled services = {\n}'), false);
  assert.equal(launchAgentDisabled(`disabled services = {\n "${LAUNCH_AGENT_LABEL}.other" => disabled\n}`), false);
  for (const value of ['', 'unrecognized output', output('unknown')]) assert.throws(() => launchAgentDisabled(value));
});

test('macOS: a persistent disablement survives refresh and off/on explicitly restores startup', async (t) => {
  const home = tempDir(t);
  const file = path.join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
  const { state, calls, launchctl } = fakeLaunchctl();
  const options = { platform: 'darwin', home, script: '/pkg/bin/agent-guild.mjs', dataDir: home, uid: 501, launchctl };
  const autostart = createAutostart({ ...options, execPath: '/old/node' });
  await autostart.set(true);
  state.disabled = true;
  calls.length = 0;
  const before = fs.readFileSync(file, 'utf8');
  assert.equal((await autostart.describe()).enabled, false);
  await createAutostart({ ...options, execPath: '/new/node', getPort: () => 51234 }).refresh();
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.ok(calls.every(([verb]) => verb === 'print-disabled'), 'reading and refreshing never enable');
  await autostart.set(false);
  assert.equal(state.disabled, true);
  assert.deepEqual(await autostart.set(true), { available: true, enabled: true, reason: null });
  assert.equal(state.disabled, false);
});

test('macOS: lookup and enable failures are reported without leaving a newly installed plist', async (t) => {
  const home = tempDir(t);
  const file = path.join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
  const { state, launchctl } = fakeLaunchctl();
  const options = { platform: 'darwin', home, execPath: '/old/node', script: '/pkg/bin/agent-guild.mjs', dataDir: home, uid: 501, launchctl };
  const autostart = createAutostart(options);
  state.failEnable = true;
  await assert.rejects(autostart.set(true), /Operation not permitted/);
  assert.equal(fs.existsSync(file), false);
  state.failEnable = false;
  await autostart.set(true);
  const before = fs.readFileSync(file, 'utf8');
  state.failPrint = true;
  const unavailable = await autostart.describe();
  assert.equal(unavailable.available, false);
  assert.match(unavailable.reason, /Could not find domain/);
  await assert.rejects(autostart.refresh(), /Could not find domain/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  state.failPrint = false;
  assert.match((await autostart.describe()).reason, /Could not update the sign-in entry/);
  state.failEnable = true;
  state.disabled = true;
  await assert.rejects(createAutostart({ ...options, execPath: '/new/node' }).set(true), /Operation not permitted/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal((await autostart.describe()).enabled, false);
  state.failEnable = false;
  state.refuseEnable = true;
  await assert.rejects(autostart.set(true), /startup setting/);
  assert.equal((await autostart.describe()).enabled, false);
});

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

  await createAutostart({ ...options, execPath: 'C:\\new\\node.exe', getPort: () => 51234 }).refresh();
  assert.match(fs.readFileSync(wrapper, 'utf8'), /new\\\\node\.exe/);
  assert.match(fs.readFileSync(wrapper, 'utf8'), /"AGENT_GUILD_PORT"\) = "51234"/);

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

test('startup entries require a concrete valid port', () => {
  const paths = { execPath: '/node', script: '/pkg/bin/agent-guild.mjs', file: '/entry', log: '/manager.log' };
  for (const build of [windowsWrapper, launchAgentPlist, desktopEntry]) {
    for (const port of [0, -1, 65536, NaN, '51234']) assert.throws(() => build({ ...paths, port }), /listening/);
    for (const port of [1, 65535]) assert.ok(build({ ...paths, port }).includes(String(port)));
  }
});

test('a failed refresh is visible and a subsequent change clears the warning', async (t) => {
  const home = tempDir(t);
  let port = 47821;
  const autostart = createAutostart({ platform: 'linux', home, env: {}, release: '6.8.0', script: '/pkg/bin/agent-guild.mjs', dataDir: home, getPort: () => port });
  await autostart.set(true);
  port = 0;
  await assert.rejects(autostart.refresh(), /listening/);
  const state = await autostart.describe();
  assert.equal(state.available, true, 'the user can still turn it off');
  assert.equal(state.enabled, true);
  assert.match(state.reason, /Could not update the sign-in entry/);
  await autostart.set(false);
  port = 51234;
  assert.deepEqual(await autostart.set(true), { available: true, enabled: true, reason: null });
});

test('the API saves the actual bound port in every platform entry after listening on port zero', async (t) => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const home = tempDir(t);
    let api;
    const autostart = createAutostart({
      platform, home, env: {}, release: '6.8.0', dataDir: home, script: '/pkg/bin/agent-guild.mjs',
      getPort: () => api.port, uid: 501, launchctl: fakeLaunchctl().launchctl, reg: fakeReg().reg,
    });
    assert.equal((await autostart.describe()).enabled, false, 'reading does not need a listening server');
    api = createManagerServer({
      manager: Object.assign(new EventEmitter(), { list: () => [] }),
      registry: Object.assign(new EventEmitter(), { warnings: [] }),
      autostart, port: 0, token: 'test', webDir: fileURLToPath(new URL('../web', import.meta.url)),
    });
    await api.listen();
    t.after(() => api.close());
    assert.ok(api.port > 0);
    const res = await fetch(`${api.url}/api/v1/autostart`, {
      method: 'PUT', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).autostart.enabled, true);
    const file = platform === 'win32' ? path.join(home, 'autostart.js')
      : platform === 'darwin' ? path.join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`)
        : path.join(home, '.config', 'autostart', 'agent-guild.desktop');
    const saved = fs.readFileSync(file, 'utf8');
    if (platform === 'win32') assert.ok(saved.includes(`("AGENT_GUILD_PORT") = "${api.port}"`));
    else if (platform === 'darwin') assert.ok(saved.includes(`<string>${api.port}</string>`));
    else assert.equal(desktopExecArgs(saved.match(/^Exec=(.*)$/m)[1]).at(-2), String(api.port));
  }
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

test('a macOS or Linux entry starts the manager while the package is there, and removes itself once it is gone', { skip: process.platform === 'win32' && 'sh entries run on macOS and Linux' }, (t) => {
  const dir = tempDir(t);
  const script = path.join(dir, 'pkg', 'agent guild "$x".mjs');
  const entry = path.join(dir, 'entry $1.desktop');
  const ran = path.join(dir, 'ran.json');
  fs.mkdirSync(path.dirname(script));
  fs.writeFileSync(script, probe(ran));
  fs.writeFileSync(entry, 'entry');
  const log = path.join(dir, 'no folder', 'manager.log');
  const run = (env) => execFileSync('/bin/sh', ['-c', POSIX_LAUNCH, process.execPath, script, entry, '51234', log], { env });
  for (const inherited of [undefined, '47821']) {
    const env = { ...process.env };
    if (inherited === undefined) delete env.AGENT_GUILD_PORT;
    else env.AGENT_GUILD_PORT = inherited;
    run(env);
    assert.deepEqual(JSON.parse(fs.readFileSync(ran, 'utf8')), { args: ['open', '--no-browser'], port: '51234' });
  }
  assert.equal(fs.existsSync(entry), true);
  fs.rmSync(path.dirname(script), { recursive: true });
  fs.rmSync(ran);
  run();
  assert.equal(fs.existsSync(entry), false);
  assert.equal(fs.existsSync(ran), false);
});

test('the Windows wrapper starts the manager while the package is there, and removes its entry once it is gone', { skip: process.platform !== 'win32' && 'wscript runs on Windows' }, (t) => {
  const dir = tempDir(t);
  const reg = path.join(process.env.SystemRoot, 'System32', 'reg.exe');
  const base = `HKCU\\Software\\AgentGuildAutostartTest-${process.pid}`;
  const runKey = `${base}\\Run`;
  const approvedKey = `${base}\\Approved`;
  t.after(() => { try { execFileSync(reg, ['delete', base, '/f'], { stdio: 'ignore' }); } catch { /* removed */ } });
  const script = path.join(dir, 'pkg ü', 'agent-guild.mjs');
  const wrapper = path.join(dir, 'autostart.js');
  const ran = path.join(dir, 'ran.json');
  fs.mkdirSync(path.dirname(script));
  fs.writeFileSync(script, probe(ran));
  fs.writeFileSync(wrapper, windowsWrapper({ execPath: process.execPath, script, runKey, approvedKey, port: 51234 }));
  const has = (key) => { try { execFileSync(reg, ['query', key, '/v', WINDOWS_VALUE], { stdio: 'ignore' }); return true; } catch { return false; } };
  execFileSync(reg, ['add', runKey, '/v', WINDOWS_VALUE, '/t', 'REG_SZ', '/d', 'x', '/f'], { stdio: 'ignore' });
  execFileSync(reg, ['add', approvedKey, '/v', WINDOWS_VALUE, '/t', 'REG_BINARY', '/d', '03000000', '/f'], { stdio: 'ignore' });
  const wscript = () => execFileSync(path.join(process.env.SystemRoot, 'System32', 'wscript.exe'), ['//B', '//NoLogo', wrapper], { env: { ...process.env, AGENT_GUILD_PORT: '47821' } });

  wscript();
  for (let i = 0; i < 80 && !fs.existsSync(ran); i++) execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 100)']);
  assert.deepEqual(JSON.parse(fs.readFileSync(ran, 'utf8')), { args: ['open', '--no-browser'], port: '51234' });
  assert.equal(has(runKey) && has(approvedKey) && fs.existsSync(wrapper), true);

  fs.rmSync(path.dirname(script), { recursive: true });
  wscript();
  assert.equal(has(runKey), false);
  assert.equal(has(approvedKey), false);
  assert.equal(fs.existsSync(wrapper), false);
});

test('Homebrew\'s Node.js is named by its opt link, which an upgrade keeps', async (t) => {
  const prefix = tempDir(t);
  const cellar = (version) => path.join(prefix, 'Cellar', 'node', version, 'bin', 'node');
  for (const version of ['25.8.1', '25.9.0']) {
    fs.mkdirSync(path.dirname(cellar(version)), { recursive: true });
    fs.writeFileSync(cellar(version), '');
  }
  fs.mkdirSync(path.join(prefix, 'opt'));
  fs.symlinkSync('../Cellar/node/25.8.1', path.join(prefix, 'opt', 'node'));
  const opt = path.join(prefix, 'opt', 'node', 'bin', 'node');
  assert.equal(stableExecPath(cellar('25.8.1')), opt);
  assert.equal(stableExecPath(cellar('25.9.0')), cellar('25.9.0'), 'an opt link to another version is not used');
  assert.equal(stableExecPath(path.join(prefix, 'Cellar', 'node@22', '22.1.0', 'bin', 'node')), path.join(prefix, 'Cellar', 'node@22', '22.1.0', 'bin', 'node'), 'a formula with no opt link keeps its path');
  assert.equal(stableExecPath('/Users/a/.nvm/versions/node/v24.13.0/bin/node'), '/Users/a/.nvm/versions/node/v24.13.0/bin/node');

  const home = tempDir(t);
  const options = { home, script: '/pkg/bin/agent-guild.mjs', dataDir: home, execPath: cellar('25.8.1'), uid: 501, launchctl: fakeLaunchctl().launchctl, release: '6.8.0', env: {} };
  await createAutostart({ ...options, platform: 'darwin' }).set(true);
  const plist = fs.readFileSync(path.join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`), 'utf8');
  assert.ok(plist.includes(`<string>${opt}</string>`));
  assert.ok(!plist.includes('25.8.1'));
  await createAutostart({ ...options, platform: 'linux' }).set(true);
  assert.ok(fs.readFileSync(path.join(home, '.config', 'autostart', 'agent-guild.desktop'), 'utf8').includes(opt));
});

test('macOS and Linux entries are writable only by their owner, whatever the umask', { skip: process.platform === 'win32' }, async (t) => {
  const umask = process.umask(0o002);
  t.after(() => process.umask(umask));
  for (const platform of ['darwin', 'linux']) {
    const home = tempDir(t);
    const file = platform === 'darwin'
      ? path.join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`)
      : path.join(home, '.config', 'autostart', 'agent-guild.desktop');
    const autostart = createAutostart({ platform, home, release: '6.8.0', env: {}, script: '/pkg/bin/agent-guild.mjs', dataDir: home, uid: 501, launchctl: fakeLaunchctl().launchctl });
    await autostart.set(true);
    assert.equal(fs.statSync(file).mode & 0o777, 0o644, platform);
    // An unchanged entry left writable by others is repaired at the next start.
    fs.chmodSync(file, 0o666);
    await autostart.refresh();
    assert.equal(fs.statSync(file).mode & 0o777, 0o644, platform);
  }
});

test('a macOS or Linux entry appends what it runs to the manager log, and starts without one', { skip: process.platform === 'win32' && 'sh entries run on macOS and Linux' }, (t) => {
  const dir = tempDir(t);
  const script = path.join(dir, 'agent-guild.mjs');
  const entry = path.join(dir, 'entry.plist');
  const ran = path.join(dir, 'ran.json');
  const log = path.join(dir, 'data $1', 'manager.log');
  fs.writeFileSync(script, `${probe(ran)}console.log('manager output');\n`);
  fs.writeFileSync(entry, 'entry');
  const run = (execPath, logFile) => execFileSync('/bin/sh', ['-c', POSIX_LAUNCH, execPath, script, entry, '51234', logFile], { encoding: 'utf8' });
  fs.mkdirSync(path.dirname(log));
  fs.writeFileSync(log, 'earlier\n');
  assert.equal(run(process.execPath, log), '', 'nothing is left on the launching output');
  assert.match(fs.readFileSync(log, 'utf8'), /^earlier\n--- sign-in \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ ---\nmanager output\n$/);
  // A missing Node.js is recorded, and the entry is kept for the next manager to repair.
  assert.throws(() => run(path.join(dir, 'gone', 'node'), log));
  assert.match(fs.readFileSync(log, 'utf8'), /--- sign-in [^\n]+ ---\n(?:[^\n]*gone\/node[^\n]*\n)+$/);
  assert.equal(fs.existsSync(entry), true);
  // A log that cannot be opened still starts the manager.
  fs.rmSync(ran);
  fs.chmodSync(log, 0o444);
  assert.equal(run(process.execPath, log), 'manager output\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(ran, 'utf8')).args, ['open', '--no-browser']);
});
