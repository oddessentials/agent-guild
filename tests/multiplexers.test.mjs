import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { MultiplexerRegistry, distroCandidate, nativeHerdrEnv } from '../src/manager/multiplexers.mjs';
import { loadProviders, ProviderRegistry } from '../src/manager/providers.mjs';
import { SessionManager } from '../src/manager/session-manager.mjs';
import { parseTmuxVersion, compareTmuxVersions, parseVersion } from '../src/manager/versions.mjs';
import { herdrLayout, reconcileHerdrPath, ownsPathEntry, WINDOWS_PATH_FILTER } from '../src/manager/multiplexer-paths.mjs';
import { weavePaths } from '../src/manager/shell-env.mjs';
import { runPlan } from '../src/manager/uninstall.mjs';
import { createManagerServer } from '../src/manager/server.mjs';

function fixture(platform = 'linux', options = {}) {
  const env = platform === 'win32'
    ? { USERPROFILE: 'C:\\Users\\test', LOCALAPPDATA: 'D:\\Local Data', Path: 'C:\\bin', SystemRoot: 'C:\\Windows' }
    : { HOME: '/home/test', PATH: '/usr/bin' };
  const provider = loadProviders({ platform }).providers.find((p) => p.id === 'shell');
  const files = new Set(), commands = new Map(), links = new Map(), outputs = new Map(), calls = [], fetches = [];
  const registry = Object.assign(new EventEmitter(), {
    env, platform, checkUpdates: true,
    get: (id) => id === 'shell' ? provider : null,
    fetchImpl: async (url) => { fetches.push(url); return { ok: true, json: async () => url.includes('tmux') ? { versions: { stable: '3.7c' } } : { version: '0.9.3', versions: { stable: '0.9.3' } } }; },
  });
  const fsx = { exists: (p) => files.has(p) || links.has(p), isFile: (p) => files.has(p), isLink: (p) => links.has(p), realpath: (p) => links.get(p) || p, readText: () => '' };
  const mux = new MultiplexerRegistry(registry, {
    fsx, resolve: (name) => commands.get(name) || null,
    resolveAll: (name) => [...files].filter((p) => p === commands.get(name)),
    uid: () => 1000,
    run: async (spec, { env: childEnv }) => {
      calls.push({ ...spec, env: childEnv });
      const value = outputs.get(JSON.stringify([spec.file, spec.args]));
      if (value instanceof Error) throw value;
      return { stdout: value ?? '', stderr: '' };
    },
    ...options,
  });
  registry.multiplexers = mux;
  registry.refreshVersions = (opts) => mux.refresh(provider, opts);
  const add = (name, file, answers = {}) => {
    commands.set(name, file); files.add(file);
    for (const [args, value] of Object.entries(answers)) outputs.set(JSON.stringify([file, args.split(' ')]), value);
  };
  const describe = (id) => mux.describe(provider).find((m) => m.id === id);
  return { mux, registry, provider, env, files, links, outputs, calls, fetches, commands, add, describe };
}

test('tmux and distro versions preserve patch ordering without changing provider semver', () => {
  for (const [raw, expected] of [['tmux 3.4\n', '3.4'], ['3.7c', '3.7c'], ['1:3.5_a-2', '3.5a'], ['3.2-1ubuntu1', '3.2'], ['(none)', null], ['master', null]]) assert.equal(parseTmuxVersion(raw), expected);
  assert.ok(compareTmuxVersions('3.7b', '3.7c') < 0);
  assert.ok(compareTmuxVersions('3.10', '3.9z') > 0);
  assert.equal(parseVersion('tmux 3.4'), null);
  assert.equal(distroCandidate('apt', 'Installed: (none)\n Candidate: 1:3.4-2ubuntu1'), '3.4');
  assert.equal(distroCandidate('pacman', 'Name : tmux\nVersion : 3.5_a-1'), '3.5a');
  assert.equal(distroCandidate('dnf', '3.7c\n'), '3.7c');
});

test('the Windows installer overrides inherited destinations, including relocated LOCALAPPDATA', async () => {
  const f = fixture('win32');
  f.env.HERDR_HOME = 'Z:\\custom';
  f.env.HERDR_INSTALL_DIR = 'Z:\\outside';
  f.add('powershell.exe', 'C:\\powershell.exe');
  f.add('curl.exe', 'C:\\curl.exe');
  await f.mux.refresh(f.provider);
  const plan = await f.mux.prepare(f.provider, 'herdr', 'install');
  assert.deepEqual(plan.extraEnv, {
    HERDR_HOME: 'C:\\Users\\test\\.herdr', HERDR_INSTALL_DIR: 'D:\\Local Data\\Programs\\Herdr\\bin',
    HERDR_CHANNEL: 'stable', HERDR_MANIFEST_URL: '', HERDR_EXPECTED_BUILD_ID: '',
  });
  assert.ok(plan.spec.args.includes('-NoProfile'));
  assert.match(plan.spec.args.at(-1), /-Channel stable/);
  assert.equal(f.describe('tmux').installable, false);
  assert.match(f.describe('tmux').guidance, /Windows/);
  if (process.platform === 'win32') {
    const manager = new SessionManager({ registry: f.registry, baseEnv: { ...f.env, Herdr_Home: 'Z:\\other', herdr_install_dir: 'Z:\\other' }, getApiUrl: () => '' });
    const child = manager._sessionEnv({ provider: f.provider, extraEnv: plan.extraEnv });
    for (const name of ['HERDR_HOME', 'HERDR_INSTALL_DIR']) {
      assert.deepEqual(Object.keys(child).filter((key) => key.toUpperCase() === name), [name]);
      assert.equal(child[name], plan.extraEnv[name]);
    }
  }
});

test('distro install candidates are preflighted; old or unreadable candidates fall back to brew or guidance', async () => {
  for (const [manager, query, binary, args, output] of [
    ['apt', 'apt-cache', 'apt-get', ['policy', 'tmux'], 'Candidate: 3.4-1'],
    ['dnf', 'dnf', 'dnf', ['repoquery', '--available', '--latest-limit=1', '--queryformat', '%{version}\\n', 'tmux'], '3.5a\n'],
    ['pacman', 'pacman', 'pacman', ['-Si', 'tmux'], 'Version : 3.7c-1'],
  ]) {
    const f = fixture();
    f.add(query, '/usr/bin/' + query);
    f.add(binary, '/usr/bin/' + binary);
    f.add('sudo', '/usr/bin/sudo');
    f.outputs.set(JSON.stringify(['/usr/bin/' + query, args]), output);
    let result = await f.mux.installRecipe(f.provider.multiplexers[0], f.env);
    assert.equal(result.recipe.file, '/usr/bin/sudo', manager);
    assert.equal(result.recipe.args[0], '/usr/bin/' + binary);
    assert.equal(f.calls.at(-1).env.LC_ALL, 'C');
    f.outputs.set(JSON.stringify(['/usr/bin/' + query, args]), manager === 'apt' ? 'Candidate: 3.1c-1' : 'unreadable');
    result = await f.mux.installRecipe(f.provider.multiplexers[0], f.env);
    assert.equal(result.recipe, undefined);
    f.add('brew', '/home/linuxbrew/.linuxbrew/bin/brew');
    result = await f.mux.installRecipe(f.provider.multiplexers[0], f.env);
    assert.deepEqual(result.recipe.args, ['install', 'tmux']);
  }
});

test('system ownership allows removal of old tmux but never guesses from a /usr/bin path', async () => {
  const f = fixture();
  f.add('tmux', '/usr/bin/tmux', { '-V': 'tmux 3.1c' });
  f.add('dpkg', '/usr/bin/dpkg', { '-S /usr/bin/tmux': 'tmux: /usr/bin/tmux' });
  f.add('apt-get', '/usr/bin/apt-get');
  f.add('sudo', '/usr/bin/sudo');
  await f.mux.refresh(f.provider);
  let copy = f.describe('tmux').installs[0];
  assert.equal(copy.supported, false);
  assert.equal(copy.channel, 'system');
  assert.match(copy.uninstall.command, /apt-get remove tmux/);
  assert.equal(copy.updateCommand, null);
  f.outputs.set(JSON.stringify(['/usr/bin/dpkg', ['-S', '/usr/bin/tmux']]), 'other-package: /usr/bin/tmux');
  await f.mux.refresh(f.provider, { force: true });
  copy = f.describe('tmux').installs[0];
  assert.equal(copy.channel, 'unknown');
  assert.equal(copy.uninstall, null);
});

test('Homebrew ownership wins over native-looking links and compares tmux patch releases', async () => {
  const f = fixture('darwin');
  const file = '/home/test/.local/bin/tmux';
  f.add('tmux', file, { '-V': 'tmux 3.7b' });
  f.files.add('/opt/homebrew/bin/brew');
  f.links.set(file, '/opt/homebrew/Cellar/tmux/3.7b/bin/tmux');
  await f.mux.refresh(f.provider);
  const copy = f.describe('tmux').installs[0];
  assert.equal(copy.channel, 'brew');
  assert.equal(copy.updateAvailable, true);
  assert.equal(copy.updateCommand, '/opt/homebrew/bin/brew upgrade tmux');
  assert.equal(copy.uninstall.command, '/opt/homebrew/bin/brew uninstall tmux');
});

test('native off-PATH copies stay manageable, and partial installations offer repair', async () => {
  const f = fixture();
  const layout = herdrLayout(f.env, 'linux');
  f.files.add(layout.launcher);
  f.outputs.set(JSON.stringify([layout.launcher, ['--version']]), 'herdr 0.9.2');
  f.outputs.set(JSON.stringify([layout.launcher, ['update', '--help']]), 'Usage: herdr update');
  f.outputs.set(JSON.stringify([layout.launcher, ['channel', 'show']]), 'stable');
  for (const name of ['sh', 'curl', 'awk']) f.add(name, '/usr/bin/' + name);
  await f.mux.refresh(f.provider);
  const row = f.describe('herdr');
  assert.equal(row.available, false);
  assert.equal(row.installable, false);
  assert.match(row.guidance, /off PATH/);
  assert.equal(row.installs[0].updateAvailable, true);
  assert.deepEqual(row.installs[0].uninstall.remove, ['~/.local/bin/herdr']);
  f.commands.set('herdr', layout.launcher);
  await f.mux.refresh(f.provider, { force: true });
  assert.equal(f.describe('herdr').available, true);

  const w = fixture('win32');
  const windows = herdrLayout(w.env, 'win32');
  w.files.add(windows.standalone);
  w.add('powershell.exe', 'C:\\powershell.exe');
  w.add('curl.exe', 'C:\\curl.exe');
  await w.mux.refresh(w.provider);
  assert.equal(w.describe('herdr').installs[0].partial, true);
  assert.equal(w.describe('herdr').installable, true);
});

test('unknown custom copies stay guidance-only, preview is not compared to stable, and lookups honor the opt-out', async () => {
  const f = fixture();
  f.add('herdr', '/opt/custom/herdr', { '--version': 'herdr 0.9.2' });
  await f.mux.refresh(f.provider);
  assert.equal(f.describe('herdr').installs[0].uninstall, null);
  const native = herdrLayout(f.env, 'linux').launcher;
  f.files.delete('/opt/custom/herdr');
  f.add('herdr', native, { '--version': 'herdr 0.9.3-preview', 'channel show': 'preview', 'update --help': 'Usage: herdr update' });
  await f.mux.refresh(f.provider, { force: true });
  assert.equal(f.describe('herdr').installs[0].latestVersion, null);
  assert.equal(f.fetches.length, 0);
  f.registry.checkUpdates = false;
  f.outputs.set(JSON.stringify([native, ['channel', 'show']]), 'stable');
  await f.mux.refresh(f.provider, { force: true });
  assert.equal(f.fetches.length, 0);
});

test('Windows PATH refresh drops old herdr releases while retaining unrelated inherited entries', () => {
  const env = { USERPROFILE: 'C:\\Users\\test', LOCALAPPDATA: 'D:\\Local Data' };
  const layout = herdrLayout(env, 'win32');
  const old = path.win32.join(layout.releases, 'old'), next = path.win32.join(layout.releases, 'new');
  const inherited = [old, 'C:\\personal', 'C:\\Windows'].join(';');
  const fresh = [next, 'C:\\Windows'].join(';');
  const merged = weavePaths(reconcileHerdrPath(inherited, env), fresh, { delimiter: ';', caseInsensitive: true });
  assert.ok(!merged.includes(old));
  assert.ok(merged.includes('C:\\personal'));
  assert.ok(merged.indexOf(next) < merged.indexOf('C:\\Windows'));
  assert.equal(ownsPathEntry('"%USERPROFILE%\\.herdr\\packages\\standalone\\current\\"', layout.pathEntries, env), true);
  assert.equal(ownsPathEntry(old + '\\unrelated', layout.pathEntries, env), false);
});

test('the production PowerShell filter preserves unrelated text and removes only owned entries', { skip: process.platform !== 'win32' }, () => {
  const script = WINDOWS_PATH_FILTER + String.raw`
$rules = @{ exact = @('C:\herdr\current', 'C:\bin'); parent = 'C:\herdr\releases' }
Remove-OwnedPathEntries 'C:\keep;;"c:\HERDR\current\";C:\herdr\releases\v1;C:\herdr\releases\v1\extra;%SystemRoot%\System32;' $rules
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { encoding: 'utf8', windowsHide: true }).trimEnd();
  assert.equal(output, 'C:\\keep;;C:\\herdr\\releases\\v1\\extra;%SystemRoot%\\System32;');
});

test('native removal preserves settings, is retryable, and never edits PATH after a file-removal failure', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-mux-removal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executable = path.join(dir, 'bin', 'herdr');
  fs.mkdirSync(path.dirname(executable));
  fs.writeFileSync(executable, 'binary');
  const settings = path.join(dir, 'settings');
  fs.writeFileSync(settings, 'keep');
  const plan = { remove: [executable], strict: true };
  let cleaned = false;
  assert.equal(runPlan({ ...plan, pathEntries: {} }, { platform: 'win32', log() {}, rm: () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); }, cleanPath: () => { cleaned = true; } }), 1);
  assert.equal(cleaned, false);
  assert.equal(runPlan(plan, { log() {} }), 0);
  assert.equal(runPlan(plan, { log() {} }), 0);
  assert.equal(fs.readFileSync(settings, 'utf8'), 'keep');
  fs.writeFileSync(executable, 'reinstalled');
  assert.equal(fs.readFileSync(executable, 'utf8'), 'reinstalled');
});

test('forced refresh invalidates shells even when PATH stays identical', async (t) => {
  const registry = new ProviderRegistry({ checkUpdates: false, env: { PATH: '' }, platform: 'linux' });
  registry.providers = [{ id: 'shell', command: '@shell', env: {}, channels: {}, multiplexers: [] }];
  registry.resolve = () => null;
  const old = { found: { shells: [{ id: 'stale' }] }, at: Date.now() };
  registry._shells.set('shell', old);
  t.mock.method(registry, 'shellsFor', () => registry._shells.get('shell')?.found ?? null);
  await registry.refreshVersions({ force: true });
  assert.equal(registry._shells.has('shell'), false);
});

function lifecycle(t, id = 'herdr') {
  const f = fixture();
  const copy = { key: 'native:one', resolvedPath: '/bin/' + id, realPath: '/bin/' + id, version: '0.9.2', channel: 'native' };
  const manager = new SessionManager({ registry: f.registry, baseEnv: {}, getApiUrl: () => '' });
  const stopped = [];
  t.mock.method(f.mux, 'prepare', async () => ({ spec: { file: '/fake', args: [] }, copy }));
  t.mock.method(f.mux, 'assertHerdrStopped', async () => { stopped.push(true); });
  t.mock.method(f.mux, 'finish', async () => {});
  t.mock.method(manager, '_checkMultiplexer', async () => {});
  let exit;
  t.mock.method(manager, '_spawn', (options) => {
    const session = Object.assign(new EventEmitter(), {
      ...options, id: 'operation', status: 'running', provider: f.provider,
      exited: new Promise((resolve) => { exit = resolve; }),
    });
    manager.sessions.set(session.id, session);
    return session;
  });
  return { ...f, manager, copy, stopped, exit: () => exit() };
}

test('native and Homebrew herdr updates allow existing servers; locks cover starts and reattachments until refresh finishes', async (t) => {
  const f = lifecycle(t);
  f.manager.sessions.set('work', { status: 'running', provider: { id: 'shell' }, task: null, multiplexer: { reattachable: true } });
  f.manager.multiplexers.set('work', { card: { provider: 'shell', shell: 'herdr', installationKey: f.copy.key }, shellPath: f.copy.resolvedPath });
  for (const channel of ['native', 'brew']) {
    f.copy.channel = channel;
    let release;
    const refreshing = new Promise((resolve) => { release = resolve; });
    f.mux.finish.mock.mockImplementation(() => refreshing);
    const operation = await f.manager.manageMultiplexer('shell', 'herdr', 'update', { path: f.copy.resolvedPath });
    assert.equal(f.stopped.length, 0, 'update never probes or stops servers');
    assert.equal(f.manager.installsRunningFor('shell'), 0, 'ordinary shells remain usable');
    await assert.rejects(f.manager._withMultiplexerStart('shell', 'herdr', () => assert.fail()), { code: 'install_in_progress' });
    await assert.rejects(f.manager._withMultiplexerStart('another-shell-provider', 'herdr', () => assert.fail()), { code: 'install_in_progress' });
    await assert.rejects(f.manager.reattach('work'), { code: 'install_in_progress' });
    await assert.rejects(f.manager.manageMultiplexer('shell', 'herdr', 'uninstall', { path: f.copy.resolvedPath }), { code: 'install_in_progress' });
    operation.status = 'exited'; operation.exitCode = 0; f.exit();
    await Promise.resolve();
    assert.equal(f.manager.multiplexerOperations.size, 1);
    release();
    await new Promise(setImmediate);
    assert.equal(f.manager.multiplexerOperations.size, 0);
  }
});

test('tmux guards count the selected copy and detached cards, ignore plain shells and other copies, and require force', async (t) => {
  const f = lifecycle(t, 'tmux');
  for (const [id, key, status, reattachable] of [['attached', f.copy.key, 'running', false], ['detached', f.copy.key, 'exited', true], ['other', 'brew:other', 'running', true], ['gone', f.copy.key, 'exited', false]]) {
    f.manager.sessions.set(id, { status, multiplexer: { reattachable } });
    f.manager.multiplexers.set(id, { card: { provider: 'shell', shell: 'tmux', installationKey: key }, shellPath: '/bin/tmux' });
  }
  f.manager.sessions.set('bash', { status: 'running', provider: { id: 'shell' }, task: null });
  f.manager.multiplexers.get('detached').card.provider = 'another-shell-provider';
  f.manager.pendingCards.set('pending', { provider: 'shell', shell: 'tmux' });
  // Avoid restoration of the deliberately minimal pending fixture.
  t.mock.method(f.manager, '_restorePending', async () => {});
  assert.deepEqual(f.manager.dependentsOf('shell', 'tmux', f.copy), { running: 2, pending: 1 });
  await assert.rejects(f.manager.manageMultiplexer('shell', 'tmux', 'update', { path: '/bin/tmux' }), { code: 'multiplexer_in_use', running: 2, pending: 1 });
  await f.manager.manageMultiplexer('shell', 'tmux', 'update', { path: '/bin/tmux', force: true });
  f.exit();
});

test('herdr uninstall refuses running or unknown server status, even with force', async (t) => {
  const f = fixture();
  const copy = { resolvedPath: '/bin/herdr' };
  const key = JSON.stringify(['/bin/herdr', ['session', 'list', '--json']]);
  for (const value of ['{"sessions":[{"running":true}]}', '{"sessions":[{}]}', 'invalid', new Error('timeout')]) {
    f.outputs.set(key, value);
    await assert.rejects(f.mux.assertHerdrStopped(f.provider, copy), { code: value.includes?.('true') ? 'herdr_running' : 'herdr_status_unknown' });
  }
  f.outputs.set(key, '{"sessions":[{"running":false}]}');
  await f.mux.assertHerdrStopped(f.provider, copy);
  const l = lifecycle(t);
  l.mux.assertHerdrStopped.mock.mockImplementation(async () => { throw Object.assign(new Error('running'), { code: 'herdr_running' }); });
  await assert.rejects(l.manager.manageMultiplexer('shell', 'herdr', 'uninstall', { path: '/bin/herdr', force: true }), { code: 'herdr_running' });
  assert.equal(l.manager.multiplexerOperations.size, 0);
});

test('missing multiplexer cards survive every save, recover once discovered, and discard only confirmed gone sessions', async (t) => {
  const f = fixture();
  let shells = [];
  f.registry.shellsFor = () => ({ shells });
  f.registry.account = () => ({ id: 'default' });
  f.registry.spawnSpec = () => ({ file: '/bin/tmux', args: [] });
  const card = { id: 'abcdef', reportToken: 'a'.repeat(32), muxName: 'guild-abcdef', provider: 'shell', shell: 'tmux', account: 'default', name: 'Saved' };
  let saved = [card];
  const manager = new SessionManager({ registry: f.registry, baseEnv: {}, getApiUrl: () => '', store: { load: () => structuredClone(saved), save: (cards) => { saved = structuredClone(cards); } } });
  t.mock.method(manager, '_multiplexer', () => ({ alive: async () => true, named: {}, clientEnv: {} }));
  t.mock.method(manager, '_spawn', (options) => {
    const session = Object.assign(new EventEmitter(), options, { status: 'exited' });
    manager.sessions.set(session.id, session);
    return session;
  });
  await manager.restore();
  manager._saveCards();
  assert.equal(saved.length, 1);
  assert.equal(manager.pendingCards.size, 1);
  assert.equal(f.registry.multiplexerState('shell', 'tmux').pendingCards, 1);
  shells = [{ id: 'tmux', path: '/bin/tmux', label: 'tmux', multiplexer: { attach: 'tmux attach -t {name}' } }];
  f.registry.emit('updated');
  await manager.pendingRestore;
  assert.equal(manager.pendingCards.size, 0);
  assert.equal(manager.sessions.get(card.id).reportToken, card.reportToken);
  assert.equal(saved.length, 1);
  const gone = { ...card, id: 'aaaaaa' };
  manager.pendingCards.set(gone.id, gone);
  manager._multiplexer.mock.mockImplementation(() => ({ alive: async () => false }));
  await manager._restorePending();
  assert.equal(manager.pendingCards.size, 0);
  assert.equal(saved.length, 1);
});

test('multiplexer API authenticates, validates, preserves conflict details and launches a real operation terminal', async (t) => {
  const f = fixture(process.platform);
  f.registry.describe = () => ({ id: 'shell', tool: 'Shell', vendor: 'Local', command: '@shell' });
  f.registry.list = () => [{ ...f.registry.describe(), multiplexers: f.mux.describe(f.provider) }];
  const manager = new SessionManager({ registry: f.registry, baseEnv: process.env, getApiUrl: () => api.url });
  t.mock.method(f.mux, 'prepare', async (provider, id, kind, file) => {
    if (file !== '/known-copy' && kind !== 'install') throw Object.assign(new Error('Unknown copy'), { status: 404, code: 'unknown_copy' });
    return {
      spec: { file: process.execPath, args: ['-e', "console.log('MULTIPLEXER OPERATION'); setTimeout(() => process.exit(0), 100);"] },
      copy: { key: 'copy', resolvedPath: '/known-copy', realPath: '/known-copy' },
    };
  });
  t.mock.method(f.mux, 'finish', async () => {});
  t.mock.method(f.mux, 'assertHerdrStopped', async () => {});
  const api = createManagerServer({ manager, registry: f.registry, token: 'test-token', webDir: path.resolve('web') });
  await api.listen();
  t.after(async () => {
    await manager.shutdown(); await api.close();
    // ConPTY can leave a handle open after the terminal has exited; use the
    // same post-results cleanup as manager.test.mjs.
    if (process.platform === 'win32') setTimeout(() => process.exit(), 3000).unref();
  });
  const call = async (route, body = {}, token = 'test-token') => {
    const response = await fetch(api.url + '/api/v1/providers/shell/multiplexers/' + route, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await call('herdr/install', {}, 'wrong')).status, 401);
  assert.equal((await call('unknown/install')).body.error.code, 'unknown_multiplexer');
  assert.equal((await call('herdr/uninstall', { path: '/arbitrary' })).body.error.code, 'unknown_copy');
  t.mock.method(manager, 'dependentsOf', () => ({ running: 2, pending: 1 }));
  const refused = await call('tmux/update', { path: '/known-copy' });
  assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.running, refused.body.error.pending], [409, 'multiplexer_in_use', 2, 1]);
  const made = await call('herdr/update', { path: '/known-copy' });
  assert.equal(made.status, 201);
  assert.equal(made.body.session.task, 'install');
  assert.equal(made.body.session.name, 'Update herdr');
  const session = manager.get(made.body.session.id);
  const messages = [];
  const detach = session.attach((message) => messages.push(message));
  await session.exited;
  detach();
  assert.equal(session.exitCode, 0);
  assert.ok(messages.some((m) => /MULTIPLEXER OPERATION/.test(m.data || '')), 'operation output reaches the terminal');
  await new Promise(setImmediate);
  assert.equal(manager.multiplexerOperations.size, 0);
});

test('redirected managed directories do not receive an Install button', async () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const f = fixture(platform);
    const layout = herdrLayout(f.env, platform);
    const target = platform === 'win32' ? layout.standalone : layout.bin;
    f.links.set(target, platform === 'win32' ? 'Z:\\unrelated' : '/unrelated');
    const recipe = await f.mux.installRecipe(f.provider.multiplexers[1], f.env);
    assert.equal(recipe.recipe, undefined);
    assert.match(recipe.guidance, /redirected/);
  }
});

test('detached cards probe and reattach with a replaced executable; an older status check cannot undo recovery', async (t) => {
  const f = fixture('win32');
  const oldPath = 'C:\\old-release\\herdr.exe';
  const newPath = 'C:\\new-release\\herdr.exe';
  const shell = { id: 'herdr', path: newPath, label: 'herdr', multiplexer: { attach: 'herdr' } };
  f.registry.shellsFor = () => ({ shells: [shell] });
  f.registry.account = () => ({ id: 'default' });
  f.registry.spawnSpec = () => ({ file: shell.path, args: [] });
  t.mock.method(f.mux, 'identityFor', () => 'native:stable-identity');
  const manager = new SessionManager({ registry: f.registry, baseEnv: {}, getApiUrl: () => '' });
  const card = { id: 'abcdef', provider: 'shell', shell: 'herdr', reportToken: 'a'.repeat(32), muxName: 'guild-abcdef' };
  const tracked = { card, shellPath: oldPath, alive: async () => false, herdr: { path: oldPath } };
  const session = { id: card.id, status: 'exited', cwd: os.homedir(), multiplexer: { reattachable: false }, _changed() {}, reattach: t.mock.fn() };
  manager.sessions.set(card.id, session); manager.multiplexers.set(card.id, tracked);
  t.mock.method(manager, '_watchHerdr', () => {});
  t.mock.method(manager, '_multiplexer', ({ shell: picked }) => {
    assert.equal(picked.path, newPath);
    return { alive: async () => true, named: {}, clientEnv: {} };
  });
  await manager._checkMultiplexer(session, tracked);
  assert.equal(session.multiplexer.reattachable, true);
  assert.equal(tracked.herdr.path, newPath);
  assert.equal(card.installationKey, 'native:stable-identity');
  await manager.reattach(card.id);
  assert.equal(session.reattach.mock.calls[0].arguments[0].file, newPath);
  let release;
  manager._multiplexer.mock.mockImplementationOnce(() => ({ alive: () => new Promise((resolve) => { release = resolve; }), named: {}, clientEnv: {} }));
  const stale = manager._checkMultiplexer(session, tracked);
  await manager._checkMultiplexer(session, tracked);
  release(false); await stale;
  assert.equal(session.multiplexer.reattachable, true);
  assert.equal(tracked.checking, false);
});

test('successful update commands still report failed post-operation verification', async () => {
  const f = fixture();
  f.add('herdr', '/home/test/.local/bin/herdr', { '--version': new Error('broken executable'), 'update --help': 'Usage: herdr update', 'channel show': 'stable' });
  await f.mux.refresh(f.provider);
  await f.mux.finish(f.provider, 'herdr', 'update', f.mux.copyFor(f.provider, 'herdr', '/home/test/.local/bin/herdr'), 0);
  assert.equal(f.describe('herdr').lastInstall.verification, 'failed');
});
