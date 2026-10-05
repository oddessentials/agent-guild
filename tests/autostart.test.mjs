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
  LINUX_LAUNCHER,
  LINUX_NOTE,
  LINUX_NO_DESKTOP,
  MAC_LAUNCHER,
  MAC_NOTE,
  POSIX_LAUNCHER,
  SIGN_IN_ATTEMPT,
  SIGN_IN_RESULT,
  SIGN_IN_WAIT_MS,
  approvedDisabled,
  createAutostart as createAutostartWith,
  desktopArg,
  desktopEntry,
  desktopEntryEnabled,
  lastSignIn,
  launchAgentPlist,
  launchAgentDisabled,
  recordSignIn,
  stableExecPath,
  windowsRunCommand,
  windowsWrapper,
} from '../src/manager/autostart.mjs';
import { createManagerServer } from '../src/manager/server.mjs';
import { BOOT_NOTE, EXIT_PORT_IN_USE, SERVICE, journalCommand, lingerCommand, unitPort } from '../src/manager/systemd-service.mjs';
import { fakeSystemd } from './fixtures/fake-systemd.mjs';

/** A computer without systemd, unless a test passes its own: no test reaches the real user manager. */
const noSystemd = async () => ({ status: 127, stdout: '', stderr: 'spawn systemctl ENOENT', missing: true });
const createAutostart = (options) => createAutostartWith({ systemd: noSystemd, user: 'ana', ...options });
/** The service's part of a Linux description on a computer without systemd. */
const noBoot = { note: BOOT_NOTE, user: 'ana', linger: false, available: false, enabled: false, reason: 'Not available because this computer does not use systemd.', state: null, commands: [] };

// Linux entries deliberately refuse backslashes. Native Windows temporary
// paths cannot stand in for their filesystem; the POSIX runners cover them.
const linuxPaths = { skip: process.platform === 'win32' && 'Linux desktop entries require POSIX filesystem paths' };

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
const ENTRY_ARGS = ['open', '--no-browser', '--sign-in'];
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
  const attempt = 'C:\\Users\\Zoë 中\\AppData\\Roaming\\AgentGuild\\sign-in-attempt';
  const text = windowsWrapper({ execPath, script, attempt, port: 51234 });
  assert.match(text, /shell\.Environment\("Process"\)\("AGENT_GUILD_PORT"\) = "51234";/);
  assert.match(text, /^[\x00-\x7f]*$/);
  const literal = text.match(/\.Run\((".*"), 0, false\);/)[1];
  assert.equal(JSON.parse(literal), `"${execPath}" "${script}" open --no-browser --sign-in`);
  assert.equal(JSON.parse(text.match(/files\.CreateTextFile\((".*"), true\)/)[1]), attempt, 'the sign-in is recorded before the launcher starts');
  assert.equal(
    windowsRunCommand({ env: { SystemRoot: 'C:\\Windows' }, wrapper: 'C:\\Users\\Zoë\\AppData\\Roaming\\AgentGuild\\autostart.js' }),
    '"C:\\Windows\\System32\\wscript.exe" //B //NoLogo "C:\\Users\\Zoë\\AppData\\Roaming\\AgentGuild\\autostart.js"',
  );
});

test('the LaunchAgent runs at load, escapes its paths and outlives the launching command', () => {
  const text = launchAgentPlist({ launcher: '/Users/a/.agent-guild/Agent Guild', execPath: '/opt/node & co/bin/node', script: '/Users/a/<guild>/bin/agent-guild.mjs', file: '/Users/a/Library/LaunchAgents/x.plist', port: 51234, log: '/Users/a/.agent-guild/manager.log', attempt: '/Users/a/.agent-guild/sign-in-attempt' });
  const args = [...text.matchAll(/<string>([^<]*)<\/string>/g)].slice(1).map((m) => m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  assert.deepEqual(args, ['/Users/a/.agent-guild/Agent Guild', '/opt/node & co/bin/node', '/Users/a/<guild>/bin/agent-guild.mjs', '/Users/a/Library/LaunchAgents/x.plist', '51234', '/Users/a/.agent-guild/manager.log', '/Users/a/.agent-guild/sign-in-attempt']);
  assert.match(text, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(text, /<key>AbandonProcessGroup<\/key><true\/>/);
  assert.doesNotMatch(text, /KeepAlive/);
});

test('desktop entry arguments follow the quoting and string escape rules', () => {
  assert.equal(desktopArg('/home/a b/50%$x'), '"/home/a b/50%%\\\\$x"');
  assert.equal(desktopArg('/a"b`c\\d'), '"/a\\\\"b\\\\`c\\\\\\\\d"');
  const paths = { launcher: '/home/a/.config/agent-guild/autostart.sh', execPath: '/opt/my node/bin/node', script: '/home/a/50% "guild"/bin/agent-guild.mjs', file: '/home/a/.config/autostart/agent-guild.desktop', log: '/home/a/$HOME/manager.log', attempt: '/home/a/.config/agent-guild/sign-in-attempt' };
  const text = desktopEntry(paths);
  const exec = text.match(/^Exec=(.*)$/m)[1];
  assert.deepEqual(desktopExecArgs(exec), ['/bin/sh', paths.launcher, paths.execPath, paths.script, paths.file, '47821', paths.log, paths.attempt]);
  assert.doesNotMatch(text, /NoDisplay/, 'desktop startup settings list it, as Task Manager and Login Items do');
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
  test(`${platform}: the entry is added, kept current at start, and removed`, platform === 'linux' ? linuxPaths : {}, async (t) => {
    const home = tempDir(t);
    const file = platform === 'darwin'
      ? path.join(home, 'Library', 'LaunchAgents', 'com.oddessentials.agent-guild.plist')
      : path.join(home, 'xdg', 'autostart', 'agent-guild.desktop');
    const options = { platform, home, release: '6.8.0', env: { XDG_CONFIG_HOME: path.join(home, 'xdg') }, script: '/pkg/bin/agent-guild.mjs', dataDir: home, uid: 501, launchctl: fakeLaunchctl().launchctl };
    const autostart = createAutostart({ ...options, execPath: '/old/node' });
    const on = (enabled) => ({
      available: true, enabled, reason: null, note: platform === 'darwin' ? MAC_NOTE : `${LINUX_NOTE} ${LINUX_NO_DESKTOP}`, lastRun: null, log: path.join(home, 'manager.log'),
      ...(platform === 'linux' && { mode: enabled ? 'sign-in' : 'off', boot: noBoot }),
    });
    assert.deepEqual(await autostart.describe(), on(false));
    await autostart.refresh();
    assert.equal(fs.existsSync(file), false, 'refresh never turns it on');

    assert.deepEqual(await autostart.set(true), on(true));
    assert.match(fs.readFileSync(file, 'utf8'), /\/old\/node/);

    await createAutostart({ ...options, execPath: '/new/node', getPort: () => 51234 }).refresh();
    assert.match(fs.readFileSync(file, 'utf8'), /\/new\/node/);
    assert.match(fs.readFileSync(file, 'utf8'), /51234/);

    assert.deepEqual(await autostart.set(false), on(false));
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(await autostart.set(false), on(false), 'turning off twice is fine');
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
  assert.deepEqual(await autostart.set(true), { available: true, enabled: true, reason: null, note: MAC_NOTE, lastRun: null, log: path.join(home, 'manager.log') });
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
  assert.equal(fs.existsSync(path.join(home, MAC_LAUNCHER)), false, 'nor its launcher');
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

test('linux: an entry a desktop turned off reads as off and is left alone', linuxPaths, async (t) => {
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
  const on = (enabled) => ({ available: true, enabled, reason: null, lastRun: null, log: path.join(dataDir, 'manager.log') });
  assert.deepEqual(await autostart.describe(), on(false));

  values.set(`${WINDOWS_APPROVED_KEY}\0${WINDOWS_VALUE}`, { type: 'REG_BINARY', data: '03000000D2C2B1E0A73FDB01' });
  assert.deepEqual(await autostart.set(true), on(true));
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

  assert.deepEqual(await autostart.set(false), on(false));
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
  const paths = { launcher: '/Agent Guild', execPath: '/node', script: '/pkg/bin/agent-guild.mjs', file: '/entry', log: '/manager.log', attempt: '/sign-in-attempt' };
  for (const build of [windowsWrapper, launchAgentPlist, desktopEntry]) {
    for (const port of [0, -1, 65536, NaN, '51234']) assert.throws(() => build({ ...paths, port }), /listening/);
    for (const port of [1, 65535]) assert.ok(build({ ...paths, port }).includes(String(port)));
  }
});

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform}: a failed refresh is visible and a subsequent change clears the warning`, platform === 'linux' ? linuxPaths : {}, async (t) => {
    const home = tempDir(t);
    let port = 47821;
    const autostart = createAutostart({ platform, home, env: {}, release: '6.8.0', script: '/pkg/bin/agent-guild.mjs', dataDir: home, getPort: () => port, uid: 501, launchctl: fakeLaunchctl().launchctl, reg: fakeReg().reg });
    await autostart.set(true);
    port = 0;
    await assert.rejects(autostart.refresh(), /listening/);
    const state = await autostart.describe();
    assert.equal(state.available, true, 'the user can still turn it off');
    assert.equal(state.enabled, true);
    assert.match(state.reason, /Could not update the sign-in entry/);
    await autostart.set(false);
    port = 51234;
    const state2 = await autostart.set(true);
    assert.equal(state2.enabled, true);
    assert.equal(state2.reason, null);
  });
}

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform}: the API saves the actual bound port after listening on port zero`, platform === 'linux' ? linuxPaths : {}, async (t) => {
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
    else assert.equal(desktopExecArgs(saved.match(/^Exec=(.*)$/m)[1])[5], String(api.port));
  });
}

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
  const attempt = path.join(dir, 'sign-in-attempt');
  fs.writeFileSync(wrapper, windowsWrapper({ execPath: process.execPath, script, attempt, runKey, approvedKey, port: 51234 }));
  const has = (key) => { try { execFileSync(reg, ['query', key, '/v', WINDOWS_VALUE], { stdio: 'ignore' }); return true; } catch { return false; } };
  execFileSync(reg, ['add', runKey, '/v', WINDOWS_VALUE, '/t', 'REG_SZ', '/d', 'x', '/f'], { stdio: 'ignore' });
  execFileSync(reg, ['add', approvedKey, '/v', WINDOWS_VALUE, '/t', 'REG_BINARY', '/d', '03000000', '/f'], { stdio: 'ignore' });
  const wscript = () => execFileSync(path.join(process.env.SystemRoot, 'System32', 'wscript.exe'), ['//B', '//NoLogo', wrapper], { env: { ...process.env, AGENT_GUILD_PORT: '47821' } });

  wscript();
  for (let i = 0; i < 80 && !fs.existsSync(ran); i++) execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 100)']);
  assert.deepEqual(JSON.parse(fs.readFileSync(ran, 'utf8')), { args: ENTRY_ARGS, port: '51234' });
  assert.equal(has(runKey) && has(approvedKey) && fs.existsSync(wrapper), true);
  assert.equal(fs.existsSync(attempt), true, 'the sign-in is recorded');

  fs.rmSync(path.dirname(script), { recursive: true });
  wscript();
  assert.equal(has(runKey), false);
  assert.equal(has(approvedKey), false);
  assert.equal(fs.existsSync(wrapper), false);
});

test('Homebrew\'s Node.js is named by its opt link, which an upgrade keeps', { skip: process.platform === 'win32' && 'Homebrew uses POSIX paths and symlinks' }, async (t) => {
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

test('a snap\'s Node.js is named by its current link, which a refresh keeps', { skip: process.platform === 'win32' && 'snaps use POSIX paths and symlinks' }, async (t) => {
  const root = tempDir(t);
  for (const snaps of [path.join(root, 'snap'), path.join(root, 'var', 'lib', 'snapd', 'snap')]) {
    const node = (snap, revision) => path.join(snaps, snap, revision, 'bin', 'node');
    for (const [snap, revision] of [['node', '10234'], ['node', '10301'], ['node_22', 'x1']]) {
      fs.mkdirSync(path.dirname(node(snap, revision)), { recursive: true });
      fs.writeFileSync(node(snap, revision), '');
    }
    fs.symlinkSync('10234', path.join(snaps, 'node', 'current'));
    fs.symlinkSync('x1', path.join(snaps, 'node_22', 'current'));
    assert.equal(stableExecPath(node('node', '10234')), node('node', 'current'));
    assert.equal(stableExecPath(node('node', '10301')), node('node', '10301'), 'a current link to another revision is not used');
    assert.equal(stableExecPath(node('node_22', 'x1')), node('node_22', 'current'), 'parallel installs and local revisions');
  }
  const loose = path.join(root, 'snap', 'other', '7', 'bin', 'node');
  fs.mkdirSync(path.dirname(loose), { recursive: true });
  fs.writeFileSync(loose, '');
  assert.equal(stableExecPath(loose), loose, 'a snap with no current link keeps its path');
  assert.equal(stableExecPath('/home/a/.nvm/versions/node/v22.22.0/bin/node'), '/home/a/.nvm/versions/node/v22.22.0/bin/node');

  const home = tempDir(t);
  const execPath = path.join(root, 'snap', 'node', '10234', 'bin', 'node');
  await createAutostart({ platform: 'linux', home, script: '/pkg/bin/agent-guild.mjs', dataDir: home, execPath, release: '6.8.0', env: {} }).set(true);
  const entry = fs.readFileSync(path.join(home, '.config', 'autostart', 'agent-guild.desktop'), 'utf8');
  assert.ok(entry.includes(path.join(root, 'snap', 'node', 'current', 'bin', 'node')));
  assert.ok(!entry.includes('10234'));
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
    if (platform === 'darwin') assert.equal(fs.statSync(path.join(home, MAC_LAUNCHER)).mode & 0o777, 0o755);
    // An unchanged entry left writable by others is repaired at the next start.
    fs.chmodSync(file, 0o666);
    if (platform === 'darwin') fs.chmodSync(path.join(home, MAC_LAUNCHER), 0o644);
    await autostart.refresh();
    assert.equal(fs.statSync(file).mode & 0o777, 0o644, platform);
    if (platform === 'darwin') assert.equal(fs.statSync(path.join(home, MAC_LAUNCHER)).mode & 0o777, 0o755);
  }
});

test('macOS: the LaunchAgent runs a launcher named Agent Guild from the data folder, and both go when it is turned off', async (t) => {
  const home = tempDir(t);
  const data = path.join(home, 'data');
  const file = path.join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
  const launcher = path.join(data, MAC_LAUNCHER);
  const autostart = createAutostart({ platform: 'darwin', home, execPath: '/node', script: '/pkg/bin/agent-guild.mjs', dataDir: data, uid: 501, launchctl: fakeLaunchctl().launchctl });
  await autostart.set(true);
  assert.equal(fs.readFileSync(launcher, 'utf8'), POSIX_LAUNCHER);
  assert.ok(fs.readFileSync(file, 'utf8').includes(`<array>\n    <string>${launcher}</string>\n    <string>/node</string>`));
  // A launcher deleted with the data folder is put back when the manager starts.
  fs.rmSync(launcher);
  await autostart.refresh();
  assert.equal(fs.readFileSync(launcher, 'utf8'), POSIX_LAUNCHER);
  await autostart.set(false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(launcher), false);
});

test('the macOS and Linux launcher records the sign-in, starts the manager while the package is there, and removes itself and its entry once it is gone', { skip: process.platform === 'win32' && 'sh entries run on macOS and Linux' }, (t) => {
  const dir = tempDir(t);
  const data = path.join(dir, 'data $1');
  const launcher = path.join(data, LINUX_LAUNCHER);
  const script = path.join(dir, 'pkg', 'agent guild "$x".mjs');
  const entry = path.join(dir, 'entry $2.desktop');
  const ran = path.join(dir, 'ran.json');
  const log = path.join(data, 'manager.log');
  const attempt = path.join(data, SIGN_IN_ATTEMPT);
  fs.mkdirSync(data);
  fs.mkdirSync(path.dirname(script));
  fs.writeFileSync(launcher, POSIX_LAUNCHER, { mode: 0o755 });
  fs.writeFileSync(script, probe(ran));
  fs.writeFileSync(entry, 'entry');
  // As a desktop entry runs it: sh with the launcher's path, whatever the inherited port.
  const run = (env = process.env) => execFileSync('/bin/sh', [launcher, process.execPath, script, entry, '51234', log, attempt], { encoding: 'utf8', env });
  for (const inherited of [undefined, '47821']) {
    const env = { ...process.env };
    if (inherited === undefined) delete env.AGENT_GUILD_PORT;
    else env.AGENT_GUILD_PORT = inherited;
    assert.equal(run(env), '', 'nothing is left on the launching output');
    assert.deepEqual(JSON.parse(fs.readFileSync(ran, 'utf8')), { args: ENTRY_ARGS, port: '51234' });
  }
  assert.equal(fs.existsSync(attempt), true);
  assert.match(fs.readFileSync(log, 'utf8'), /^--- sign-in \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ ---\n--- sign-in [^\n]+ ---\n$/);
  // A launcher run directly, as launchd runs the macOS one, behaves the same.
  fs.rmSync(ran);
  execFileSync(launcher, [process.execPath, script, entry, '51234', log, attempt]);
  assert.deepEqual(JSON.parse(fs.readFileSync(ran, 'utf8')), { args: ENTRY_ARGS, port: '51234' });

  // Once the package is gone: no sign-in recorded, and the entry and launcher go.
  fs.rmSync(path.dirname(script), { recursive: true });
  fs.rmSync(ran);
  fs.rmSync(attempt);
  run();
  assert.equal(fs.existsSync(ran), false);
  assert.equal(fs.existsSync(attempt), false);
  assert.equal(fs.existsSync(entry), false);
  assert.equal(fs.existsSync(launcher), false);
});

test('the launcher logs a missing Node.js and keeps its entry, and starts without a writable log', { skip: process.platform === 'win32' && 'sh entries run on macOS and Linux' }, (t) => {
  const dir = tempDir(t);
  const launcher = path.join(dir, LINUX_LAUNCHER);
  const script = path.join(dir, 'agent-guild.mjs');
  const entry = path.join(dir, 'entry.desktop');
  const ran = path.join(dir, 'ran.json');
  const log = path.join(dir, 'data $1', 'manager.log');
  const attempt = path.join(dir, SIGN_IN_ATTEMPT);
  fs.writeFileSync(launcher, POSIX_LAUNCHER);
  fs.writeFileSync(script, `${probe(ran)}console.log('manager output');\n`);
  fs.writeFileSync(entry, 'entry');
  const run = (execPath, logFile) => execFileSync('/bin/sh', [launcher, execPath, script, entry, '51234', logFile, attempt], { encoding: 'utf8' });
  fs.mkdirSync(path.dirname(log));
  fs.writeFileSync(log, 'earlier\n');
  assert.equal(run(process.execPath, log), '');
  assert.match(fs.readFileSync(log, 'utf8'), /^earlier\n--- sign-in [^\n]+ ---\nmanager output\n$/);
  // A missing Node.js is recorded, and the entry is kept for the next manager to repair.
  assert.throws(() => run(path.join(dir, 'gone', 'node'), log));
  assert.match(fs.readFileSync(log, 'utf8'), /--- sign-in [^\n]+ ---\n(?:[^\n]*gone\/node[^\n]*\n)+$/);
  assert.equal(fs.existsSync(entry), true);
  assert.equal(fs.existsSync(launcher), true);
  // A log that cannot be opened still starts the manager.
  fs.rmSync(ran);
  assert.equal(run(process.execPath, path.join(dir, 'missing folder', 'manager.log')), 'manager output\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(ran, 'utf8')).args, ENTRY_ARGS);
});

test('linux: the entry runs a launcher in the data folder, and both go when it is turned off', linuxPaths, async (t) => {
  const home = tempDir(t);
  const data = path.join(home, 'data');
  const file = path.join(home, '.config', 'autostart', 'agent-guild.desktop');
  const launcher = path.join(data, LINUX_LAUNCHER);
  const autostart = createAutostart({ platform: 'linux', home, release: '6.8.0', env: { XDG_CURRENT_DESKTOP: 'GNOME' }, execPath: '/node', script: '/pkg/bin/agent-guild.mjs', dataDir: data });
  assert.equal((await autostart.describe()).note, LINUX_NOTE, 'no warning from a desktop session');
  await autostart.set(true);
  assert.equal(fs.readFileSync(launcher, 'utf8'), POSIX_LAUNCHER);
  assert.equal(fs.statSync(launcher).mode & 0o777, 0o755);
  assert.deepEqual(desktopExecArgs(fs.readFileSync(file, 'utf8').match(/^Exec=(.*)$/m)[1]).slice(0, 3), ['/bin/sh', launcher, '/node']);
  fs.rmSync(launcher);
  await autostart.refresh();
  assert.equal(fs.readFileSync(launcher, 'utf8'), POSIX_LAUNCHER, 'a launcher deleted with the data folder is put back');
  await autostart.set(false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(launcher), false);
});

test('linux: a path desktops would read differently makes it unavailable instead of silently broken', linuxPaths, async () => {
  for (const [field, value] of [['execPath', '/opt/$node/bin/node'], ['script', '/home/a/`x`/bin/agent-guild.mjs'], ['dataDir', '/home/a/data "x"'], ['home', '/home/a\\b']]) {
    const options = { platform: 'linux', release: '6.8.0', env: {}, home: '/home/a', execPath: '/node', script: '/pkg/bin/agent-guild.mjs', dataDir: '/home/a/data', [field]: value };
    const autostart = createAutostart(options);
    const described = await autostart.describe();
    assert.equal(described.available, false, field);
    assert.ok(described.reason.includes(value), field);
    await assert.rejects(autostart.set(true), (err) => err.code === 'autostart_unavailable');
  }
});

test('the last sign-in reads as not run, starting, started, already running or failed', async (t) => {
  const data = tempDir(t);
  const attempt = path.join(data, SIGN_IN_ATTEMPT);
  const touch = (ms) => { fs.writeFileSync(attempt, ''); fs.utimesSync(attempt, ms / 1000, ms / 1000); };
  const now = Date.parse('2026-10-05T09:00:00Z');
  assert.equal(await lastSignIn(data, now), null);
  touch(now - 1000);
  assert.deepEqual(await lastSignIn(data, now), { at: new Date(now - 1000).toISOString(), outcome: 'starting' });
  assert.deepEqual(await lastSignIn(data, now + SIGN_IN_WAIT_MS), { at: new Date(now - 1000).toISOString(), outcome: 'failed' });
  recordSignIn(data, 'started', now);
  assert.deepEqual(await lastSignIn(data, now + SIGN_IN_WAIT_MS), { at: new Date(now).toISOString(), outcome: 'started' });
  recordSignIn(data, 'running', now);
  assert.equal((await lastSignIn(data, now)).outcome, 'running');
  // The next sign-in's attempt is newer than that result: until a new result, it is starting, then failed.
  touch(now + 3600000);
  assert.equal((await lastSignIn(data, now + 3600000 + 1000)).outcome, 'starting');
  assert.equal((await lastSignIn(data, now + 3600000 + SIGN_IN_WAIT_MS)).outcome, 'failed');
  for (const junk of ['not json', '{"at":"x","outcome":"started"}', `{"at":${now + 3600000},"outcome":"bogus"}`]) {
    fs.writeFileSync(path.join(data, SIGN_IN_RESULT), junk);
    assert.equal((await lastSignIn(data, now + 3600000 + SIGN_IN_WAIT_MS)).outcome, 'failed', junk);
  }
});

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform}: the description carries the last sign-in while on, and turning it on afresh or off forgets earlier ones`, platform === 'linux' ? linuxPaths : {}, async (t) => {
    const home = tempDir(t);
    const attempt = path.join(home, SIGN_IN_ATTEMPT);
    const autostart = createAutostart({ platform, home, release: '6.8.0', env: { DISPLAY: ':0' }, execPath: '/node', script: '/pkg/bin/agent-guild.mjs', dataDir: home, uid: 501, launchctl: fakeLaunchctl().launchctl, reg: fakeReg().reg });
    fs.writeFileSync(attempt, '');
    recordSignIn(home, 'started');
    assert.equal((await autostart.describe()).lastRun, null, 'off: no last run');
    assert.equal((await autostart.set(true)).lastRun, null, 'a run from an earlier time it was on is forgotten');
    assert.equal(fs.existsSync(attempt), false);
    fs.writeFileSync(attempt, '');
    recordSignIn(home, 'started');
    const on = await autostart.describe();
    assert.equal(on.lastRun.outcome, 'started');
    assert.equal(on.log, path.join(home, 'manager.log'));
    assert.equal((await autostart.set(true)).lastRun.outcome, 'started', 'turning it on again while on keeps it');
    await autostart.refresh();
    assert.equal((await autostart.describe()).lastRun.outcome, 'started');
    await autostart.set(false);
    assert.equal(fs.existsSync(attempt), false);
    assert.equal(fs.existsSync(path.join(home, SIGN_IN_RESULT)), false);
  });
}

const GENERATOR = ['/usr/lib/systemd/user-generators/systemd-xdg-autostart-generator', '/lib/systemd/user-generators/systemd-xdg-autostart-generator'].find((file) => fs.existsSync(file));

test('linux: systemd\'s autostart generator turns the entry into a command with no escapes', { skip: !GENERATOR && 'systemd-xdg-autostart-generator is not installed' }, async (t) => {
  const home = tempDir(t);
  const config = path.join(home, 'config 100%');
  const data = path.join(config, 'agent-guild');
  const autostart = createAutostart({ platform: 'linux', home, release: '6.8.0', env: { XDG_CONFIG_HOME: config }, execPath: '/opt/my node/bin/node', script: '/pkg/bin/agent-guild.mjs', dataDir: data });
  await autostart.set(true);
  const out = path.join(home, 'units');
  for (const dir of ['normal', 'early', 'late']) fs.mkdirSync(path.join(out, dir), { recursive: true });
  execFileSync(GENERATOR, ['normal', 'early', 'late'].map((dir) => path.join(out, dir)), { env: { ...process.env, XDG_CONFIG_HOME: config, XDG_CONFIG_DIRS: path.join(home, 'none') } });
  const unit = fs.readFileSync(path.join(out, 'late', 'app-agent\\x2dguild@autostart.service'), 'utf8');
  const exec = unit.match(/^ExecStart=:(.*)$/m)[1];
  assert.doesNotMatch(exec, /\\/, 'systemd keeps a backslash it does not know, so the command has none');
  const args = [...exec.matchAll(/"([^"]*)"|(\S+)/g)].map(([, quoted, bare]) => (quoted ?? bare).replace(/%%/g, '%'));
  assert.deepEqual(args, ['/bin/sh', path.join(data, LINUX_LAUNCHER), '/opt/my node/bin/node', '/pkg/bin/agent-guild.mjs', path.join(config, 'autostart', 'agent-guild.desktop'), '47821', path.join(data, 'manager.log'), path.join(data, SIGN_IN_ATTEMPT)]);
});

const GIO = ['/usr/bin/gio', '/bin/gio'].find((file) => fs.existsSync(file));

test('linux: GLib launches the entry with the launcher and its arguments', { skip: (process.platform !== 'linux' || !GIO) && 'gio runs desktop entries on Linux' }, async (t) => {
  const home = tempDir(t);
  const data = path.join(home, 'data 100%');
  const script = path.join(home, 'pkg', 'agent-guild.mjs');
  const ran = path.join(home, 'ran.json');
  fs.mkdirSync(path.dirname(script));
  fs.writeFileSync(script, probe(ran));
  const autostart = createAutostart({ platform: 'linux', home, release: '6.8.0', env: {}, execPath: process.execPath, script, dataDir: data, getPort: () => 51234 });
  await autostart.set(true);
  execFileSync(GIO, ['launch', path.join(home, '.config', 'autostart', 'agent-guild.desktop')], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !fs.existsSync(ran); i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(JSON.parse(fs.readFileSync(ran, 'utf8')), { args: ENTRY_ARGS, port: '51234' });
  assert.equal(fs.existsSync(path.join(data, SIGN_IN_ATTEMPT)), true);
  assert.equal((await autostart.describe()).lastRun.outcome, 'starting', 'the probe records no result, as a manager that has not answered yet');
});

test('a uid with no user name, as in a container, still gets a startup setting, and names the uid for lingering', linuxPaths, async (t) => {
  t.mock.method(os, 'userInfo', () => { throw Object.assign(new Error('uv_os_get_passwd returned ENOENT'), { code: 'ERR_SYSTEM_ERROR' }); });
  const home = tempDir(t);
  for (const platform of ['linux', 'darwin', 'win32']) {
    const autostart = createAutostartWith({ platform, home, release: '6.8.0', env: {}, execPath: '/node', script: '/pkg/bin/agent-guild.mjs', dataDir: home, uid: 501, systemd: fakeSystemd().run, lingerDir: home, reg: fakeReg().reg, launchctl: fakeLaunchctl().launchctl });
    const state = await autostart.describe();
    assert.equal(state.available, true, platform);
    if (platform === 'linux') assert.equal(state.boot.user, '501');
  }
});

/** A Linux manager with a fake user manager: `entry` is the sign-in entry, `unit` the service, `linger` its lingering record. */
function linuxStartup(t, { systemd = fakeSystemd(), pid = 4242, port = 47821, lingering = false } = {}) {
  const home = tempDir(t);
  const lingerDir = path.join(home, 'linger');
  fs.mkdirSync(lingerDir);
  if (lingering) fs.writeFileSync(path.join(lingerDir, 'ana'), '');
  const data = path.join(home, 'data');
  const options = { platform: 'linux', home, release: '6.8.0', env: { XDG_CURRENT_DESKTOP: 'GNOME' }, execPath: '/node', script: '/pkg/bin/agent-guild.mjs', dataDir: data, getPort: () => port, uid: 1000, user: 'ana', systemd: systemd.run, lingerDir, pid };
  return {
    systemd,
    options,
    autostart: createAutostartWith(options),
    entry: path.join(home, '.config', 'autostart', 'agent-guild.desktop'),
    unit: path.join(home, '.config', 'systemd', 'user', SERVICE),
    launcher: path.join(data, 'boot.sh'),
    linger: path.join(lingerDir, 'ana'),
  };
}

test('linux: choosing boot enables the unit first, then removes the sign-in entry, and starts or stops nothing', linuxPaths, async (t) => {
  const { systemd, options, entry, unit, launcher } = linuxStartup(t);
  let entryAtEnable = null;
  const runner = async (command, args) => {
    if (args[1] === 'enable') entryAtEnable = fs.existsSync(entry);
    return systemd.run(command, args);
  };
  const autostart = createAutostartWith({ ...options, systemd: runner });
  await autostart.setMode('sign-in');
  systemd.calls.length = 0;
  const state = await autostart.setMode('boot');
  assert.equal(entryAtEnable, true, 'the sign-in entry is kept until the unit is enabled');
  assert.equal(fs.existsSync(entry), false);
  assert.equal(fs.existsSync(unit), true);
  assert.equal(fs.existsSync(launcher), true);
  assert.equal(unitPort(fs.readFileSync(unit, 'utf8')), 47821);
  assert.equal(state.mode, 'boot');
  assert.equal(state.enabled, false);
  assert.equal(state.boot.enabled, true);
  assert.deepEqual(systemd.verbs().filter((verb) => verb !== 'show'), ['daemon-reload', 'enable'], 'changing the mode never starts or stops a manager');
});

test('linux: choosing sign-in or off adds the new starter before removing the unit', linuxPaths, async (t) => {
  for (const mode of ['sign-in', 'off']) {
    const { systemd, options, entry, unit, launcher } = linuxStartup(t);
    let entryAtDisable = null;
    const runner = async (command, args) => {
      if (args[1] === 'disable') entryAtDisable = fs.existsSync(entry);
      return systemd.run(command, args);
    };
    const autostart = createAutostartWith({ ...options, systemd: runner });
    await autostart.setMode('boot');
    const state = await autostart.setMode(mode);
    assert.equal(state.mode, mode);
    assert.equal(entryAtDisable, mode === 'sign-in', mode);
    assert.equal(fs.existsSync(entry), mode === 'sign-in');
    for (const file of [unit, launcher]) assert.equal(fs.existsSync(file), false, `${mode}: ${file}`);
    assert.equal(systemd.verbs().includes('stop'), false, 'a running service manager is never stopped by a mode change');
  }
});

test('linux: the checkbox API keeps one starter: on is sign-in, and off leaves a service on', linuxPaths, async (t) => {
  const { autostart, entry, unit } = linuxStartup(t);
  await autostart.setMode('boot');
  assert.equal((await autostart.set(false)).mode, 'boot');
  assert.equal(fs.existsSync(unit), true);
  const on = await autostart.set(true);
  assert.equal(on.mode, 'sign-in');
  assert.equal(fs.existsSync(unit), false);
  assert.equal(fs.existsSync(entry), true);
  assert.equal((await autostart.set(false)).mode, 'off');
});

test('linux: a refused enable leaves the sign-in entry as it was and no unit behind', linuxPaths, async (t) => {
  const { systemd, autostart, entry, unit, launcher } = linuxStartup(t);
  await autostart.setMode('sign-in');
  systemd.state.fail.add('enable');
  await assert.rejects(autostart.setMode('boot'), (err) => err.code === 'autostart_failed' && /enable refused/.test(err.message));
  const state = await autostart.describe();
  assert.equal(state.mode, 'sign-in');
  assert.equal(fs.existsSync(entry), true);
  assert.equal(fs.existsSync(unit), false);
  assert.equal(fs.existsSync(launcher), false);
});

test('linux: without a reachable user manager boot is unavailable with its reason, and the other modes still work', linuxPaths, async (t) => {
  for (const systemd of [fakeSystemd({ reachable: false }), fakeSystemd({ missing: true })]) {
    const { autostart, entry, unit } = linuxStartup(t, { systemd });
    const before = await autostart.describe();
    assert.equal(before.available, true);
    assert.equal(before.boot.available, false);
    assert.match(before.boot.reason, systemd.state.missing ? /does not use systemd/ : /did not answer: Failed to connect to bus/);
    await assert.rejects(autostart.setMode('boot'), (err) => err.code === 'autostart_unavailable' && err.status === 409);
    assert.equal(fs.existsSync(unit), false);
    assert.equal((await autostart.setMode('sign-in')).mode, 'sign-in');
    assert.equal(fs.existsSync(entry), true);
    assert.equal((await autostart.setMode('off')).mode, 'off');
  }
});

test('linux: the service state names this manager, lingering and the next step', linuxPaths, async (t) => {
  const { systemd, autostart, linger } = linuxStartup(t, { pid: 4242 });
  await autostart.setMode('boot');
  let boot = (await autostart.describe()).boot;
  assert.deepEqual(boot.state, { kind: 'pending' }, 'this manager was started without systemd');
  assert.deepEqual(boot.commands, [lingerCommand('ana')]);
  assert.equal(boot.linger, false);

  fs.writeFileSync(linger, '');
  Object.assign(systemd.state.show, { ActiveState: 'active', MainPID: '4242', ExecMainStartTimestamp: 'Mon 2026-10-05 18:40:29 UTC' });
  boot = (await autostart.describe()).boot;
  assert.deepEqual(boot.state, { kind: 'running', since: '2026-10-05T18:40:29.000Z', pid: 4242 });
  assert.deepEqual(boot.commands, []);

  Object.assign(systemd.state.show, { ActiveState: 'failed', MainPID: '0', Result: 'exit-code', ExecMainStatus: String(EXIT_PORT_IN_USE), InactiveEnterTimestamp: 'Mon 2026-10-05 18:41:00 UTC' });
  boot = (await autostart.describe()).boot;
  assert.deepEqual(boot.state, { kind: 'port-in-use', at: '2026-10-05T18:41:00.000Z', port: 47821 });
  assert.deepEqual(boot.commands, [journalCommand()]);
});

test('linux: a unit and a sign-in entry both on read as both, and choosing one resolves it', linuxPaths, async (t) => {
  const { autostart, entry, unit } = linuxStartup(t);
  await autostart.setMode('boot');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, desktopEntry({ launcher: '/l', execPath: '/node', script: '/s', file: entry, port: 47821, log: '/log', attempt: '/a' }));
  assert.equal((await autostart.describe()).mode, 'both');
  assert.equal((await autostart.setMode('boot')).mode, 'boot');
  assert.equal(fs.existsSync(entry), false);
  assert.equal(fs.existsSync(unit), true);
});

test('linux: refresh rewrites an enabled unit for this manager and reloads only when it changed', linuxPaths, async (t) => {
  const { systemd, options, unit } = linuxStartup(t);
  const autostart = createAutostartWith(options);
  await autostart.refresh();
  assert.equal(fs.existsSync(unit), false, 'refresh never turns it on');
  await autostart.setMode('boot');
  systemd.calls.length = 0;
  await autostart.refresh();
  assert.deepEqual(systemd.verbs(), ['show'], 'unchanged: no reload');
  await createAutostartWith({ ...options, execPath: '/new/node', getPort: () => 51234 }).refresh();
  assert.match(fs.readFileSync(unit, 'utf8'), /"\/new\/node"/);
  assert.equal(unitPort(fs.readFileSync(unit, 'utf8')), 51234);
  assert.deepEqual(systemd.verbs(), ['show', 'show', 'daemon-reload']);

  systemd.state.fail.add('daemon-reload');
  await assert.rejects(createAutostartWith({ ...options, execPath: '/newer/node' }).refresh(), /reload/);
  const failing = createAutostartWith({ ...options, execPath: '/newest/node' });
  await failing.refresh().catch(() => {});
  assert.match((await failing.describe()).boot.reason, /^Could not update the systemd unit/);
});

test('linux: a path systemd would read differently makes startup unavailable', linuxPaths, async (t) => {
  const { options } = linuxStartup(t);
  for (const dataDir of ['/home/a/data "x"', '/home/a/da\nta']) {
    const described = await createAutostartWith({ ...options, dataDir }).describe();
    assert.equal(described.available, false);
    assert.ok(described.reason.includes(dataDir));
  }
});

test('other systems offer no boot mode: sign-in and off work as the checkbox does', async (t) => {
  const home = tempDir(t);
  const autostart = createAutostart({ platform: 'darwin', home, release: '25.0.0', env: {}, execPath: '/node', script: '/pkg/bin/agent-guild.mjs', dataDir: home, uid: 501, launchctl: fakeLaunchctl().launchctl });
  await assert.rejects(autostart.setMode('boot'), (err) => err.code === 'autostart_unavailable' && err.status === 409);
  const on = await autostart.setMode('sign-in');
  assert.equal(on.enabled, true);
  assert.equal('mode' in on, false);
  assert.equal((await autostart.setMode('off')).enabled, false);
});

test('the autostart API takes a mode and refuses anything else', { timeout: 10000 }, async (t) => {
  const modes = [];
  const autostart = {
    describe: async () => ({ available: true, enabled: false, reason: null }),
    set: async () => { throw new Error('the mode goes to setMode'); },
    setMode: async (mode) => { modes.push(mode); return { available: true, enabled: false, reason: null, mode }; },
  };
  const manager = Object.assign(new EventEmitter(), { list: () => [] });
  const registry = Object.assign(new EventEmitter(), { warnings: [] });
  const api = createManagerServer({ manager, registry, autostart, token: 'tok', webDir: fileURLToPath(new URL('../web', import.meta.url)) });
  await api.listen();
  t.after(() => api.close());
  const put = (body) => fetch(`${api.url}/api/v1/autostart`, { method: 'PUT', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const mode of ['both', 'Boot', 1, null]) {
    const bad = await put({ mode });
    assert.equal(bad.status, 400, String(mode));
    assert.match((await bad.json()).error.message, /mode must be one of off, sign-in, boot/);
  }
  assert.deepEqual(await (await put({ mode: 'boot' })).json(), { autostart: { available: true, enabled: false, reason: null, mode: 'boot' } });
  assert.deepEqual(modes, ['boot']);
});
