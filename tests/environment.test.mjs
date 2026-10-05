import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync, fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCommand } from '../src/manager/command-resolver.mjs';
import { Environment, LAUNCH_DETAIL, probePathEnv } from '../src/manager/environment.mjs';
import { resolveProjectCwd, scanPins } from '../src/manager/environment-pins.mjs';
import { RUNTIMES, scanRuntime, detectTools, passiveExecutable, probeEnv, runProbe, releaseScanDirectory } from '../src/manager/environment-probe.mjs';

const definition = (id) => RUNTIMES.find((row) => row.id === id);
function scanner(files, outputs, options = {}) {
  const calls = [];
  return {
    calls,
    env: { PATH: '/manager/bin', NODE_OPTIONS: '--require unwanted.js' }, cwd: '/neutral',
    resolve: (name) => files[name] || null,
    inspect: (file) => ({ file }),
    run: async (file, args, opts) => {
      calls.push({ file, args, ...opts });
      return outputs[file + ' ' + args.join(' ')] ?? outputs[file] ?? { code: 1, output: 'failed' };
    },
    ...options,
  };
}

test('Python always prefers python; python3 is an alternate and never hides a failed primary', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const fixture = scanner({ python: '/python', python3: '/python3' }, {
      '/python': { code: 0, output: 'Python 3.12.4' }, '/python3': { code: 0, output: 'Python 3.14.1' },
    }, { platform });
    let row = await scanRuntime(definition('python'), fixture);
    assert.equal(row.version, '3.12.4');
    assert.equal(row.command, 'python');
    assert.equal(row.alternatives[0].version, '3.14.1');
    fixture.run = async (file) => file === '/python' ? { error: 'Version check timed out.' } : { code: 0, output: 'Python 3.14.1' };
    row = await scanRuntime(definition('python'), fixture);
    assert.equal(row.status, 'failed');
    assert.equal(row.version, null);
    assert.equal(row.alternatives[0].status, 'ok');
    fixture.resolve = (name) => name === 'python3' ? '/python3' : null;
    row = await scanRuntime(definition('python'), fixture);
    assert.equal(row.command, 'python3');
    assert.equal(row.version, '3.14.1');
  }
});

test('missing commands, missing runtimes, and failed probes are distinct', async () => {
  assert.equal((await scanRuntime(definition('node'), scanner({}, {}))).status, 'not_found');
  for (const [id, text] of [['python', 'No runtimes installed'], ['dotnet', 'No .NET SDKs were found.'], ['rust', 'no default is configured']]) {
    const def = definition(id);
    const row = await scanRuntime(def, scanner({ [def.command]: '/tool' }, { '/tool': { code: 1, output: text } }));
    assert.equal(row.status, 'unavailable', id);
  }
  for (const result of [{ error: 'Version check timed out.' }, { code: 1, output: 'file:///node-v24.3.2/error' }, { code: 0, output: 'unexpected 24.3.2 output' }]) {
    const row = await scanRuntime(definition('node'), scanner({ node: '/node' }, { '/node': result }));
    assert.equal(row.status, 'failed');
    assert.equal(row.version, null);
  }
});

test('runtime formats preserve channels and the SDK is separate from installed .NET runtimes', async () => {
  for (const [id, output, version] of [
    ['node', 'v24.1.0', '24.1.0'], ['python', 'Python 3.15.0rc1', '3.15.0rc1'],
    ['go', 'go version go1.26rc2 linux/amd64', '1.26rc2'], ['r', 'R version 4.6.1 (2026-06-24)', '4.6.1'],
    ['rust', 'rustc 1.94.0-nightly (abcdef 2026-01-01)', '1.94.0-nightly'],
  ]) {
    const def = definition(id);
    assert.equal((await scanRuntime(def, scanner({ [def.command]: '/tool' }, { '/tool': { code: 0, output } }))).version, version);
  }
  const dotnet = await scanRuntime(definition('dotnet'), scanner({ dotnet: '/dotnet' }, {
    '/dotnet --version': { code: 1, output: 'No .NET SDKs were found.' },
    '/dotnet --list-runtimes': { code: 0, output: 'Microsoft.NETCore.App 10.0.1 [/shared]\nMicrosoft.AspNetCore.App 10.0.1 [/shared]' },
  }));
  assert.equal(dotnet.status, 'unavailable');
  assert.equal(dotnet.runtimes.length, 2);
  assert.equal(dotnet.version, null);
});

test('probes use the provided neutral directory and disable downloads without changing the manager env', async () => {
  const fixture = scanner({ go: '/go' }, { '/go': { code: 0, output: 'go version go1.26.0 linux/amd64' } });
  await scanRuntime(definition('go'), fixture);
  assert.equal(fixture.calls[0].cwd, '/neutral');
  assert.equal(fixture.calls[0].env.GOTOOLCHAIN, 'local');
  assert.equal(fixture.calls[0].env.RUSTUP_AUTO_INSTALL, '0');
  assert.equal(fixture.calls[0].env.PYTHON_MANAGER_AUTOMATIC_INSTALL, 'false');
  assert.equal(fixture.calls[0].env.NODE_OPTIONS, '');
  assert.equal(fixture.env.NODE_OPTIONS, '--require unwanted.js');
  assert.equal(probeEnv({ node_options: 'bad' }).node_options, undefined);
});

test('a Windows execution alias is not opened, and a later real binary still wins', async () => {
  const checked = [];
  const env = { PATH: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Python314', PATHEXT: '.EXE' };
  const resolve = (name, _env, platform, options) => resolveCommand(name, env, platform, {
    ...options,
    isExecutable(file) {
      checked.push(file);
      return /Python314\\python\.EXE$/i.test(file);
    },
  });
  const row = await scanRuntime(definition('python'), {
    platform: 'win32', env, cwd: '/neutral', resolve,
    inspect: (file) => ({ file }),
    run: async () => ({ code: 0, output: 'Python 3.14.2' }),
  });
  assert.equal(row.status, 'ok');
  assert.equal(row.version, '3.14.2');
  assert.match(row.path, /Python314\\python\.EXE$/i);
  assert.ok(checked.every((file) => !/windowsapps/i.test(file)), checked.join(' '));
  assert.equal(row.alternatives[0].status, 'unavailable');
  assert.match(row.alternatives[0].path, /WindowsApps\\python3\.EXE$/i);
  assert.match(row.alternatives[0].detail, /Windows execution alias/);
});

test('passive inspection refuses script shims and Windows aliases, follows runtime links, and preserves rustup dispatch', () => {
  const binary = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
  const options = { platform: 'linux', realpath: (file) => file, read: () => binary };
  assert.ok(passiveExecutable('/home/me/.asdf/shims/node', 'node', options).error);
  assert.ok(passiveExecutable('C:/Users/me/AppData/Local/Microsoft/WindowsApps/python.exe', 'python', { ...options, platform: 'win32' }).error);
  assert.ok(passiveExecutable('/bin/python', 'python', { ...options, read: () => Buffer.from('#!/bin/sh\ninstall-python') }).error);
  assert.equal(passiveExecutable('/current/node', 'node', { ...options, realpath: () => '/versions/24/node' }).file, '/versions/24/node');
  assert.equal(passiveExecutable('/cargo/bin/rustc', 'rust', { ...options, realpath: () => '/cargo/bin/rustup' }).file, '/cargo/bin/rustc');
});

test('tool discovery reads presence only and never claims activation', () => {
  const paths = { uv: '/bin/uv', pnpm: '/bin/pnpm', vfox: '/bin/vfox', nvm: 'C:/nvm/nvm.exe' };
  const options = { env: { HOME: '/home/test', NVM_DIR: '/custom/nvm' }, resolve: (name) => paths[name], exists: (file) => file === '/custom/nvm/nvm.sh' };
  const tools = detectTools({ ...options, platform: 'linux' });
  assert.deepEqual(tools.map((t) => t.id), ['nvm', 'vfox', 'uv', 'pnpm']);
  assert.ok(tools.every((t) => t.status === 'detected' && !('active' in t)));
  assert.equal(detectTools({ ...options, platform: 'win32' })[0].label, 'NVM for Windows');
});

test('refresh is nonblocking, coalesces requests, retains previous values, and ignores late worker messages', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const children = [], options = [];
  const service = new Environment({ env: { PATH: '/manager', NODE_OPTIONS: 'preload' }, forkWorker: (file, args, opts) => {
    options.push(opts); const child = new EventEmitter(); children.push(child); return child;
  }, timeoutMs: 100 });
  t.after(() => service.close());
  assert.equal(service.refresh().refreshing, true);
  service.refresh();
  assert.equal(children.length, 1);
  assert.equal(options[0].env.NODE_OPTIONS, undefined);
  const row = { id: 'node', label: 'Node.js', status: 'ok', version: '24.0.0', path: '/node' };
  children[0].emit('message', { runtime: row });
  children[0].emit('message', { done: true });
  assert.equal(service.snapshot().runtimes[0].version, '24.0.0');
  service.refresh();
  assert.equal(service.snapshot().runtimes[0].version, '24.0.0');
  t.mock.timers.tick(100);
  assert.equal(service.snapshot().refreshing, false);
  assert.match(service.snapshot().error, /timed out/);
  assert.ok(service.snapshot().runtimes.every((r) => r.status === 'failed'));
  children[1].emit('message', { runtime: row });
  children[1].emit('message', { done: true });
  assert.equal(service.snapshot().runtimes[0].version, null);
});

test('real probe handles a known executable and bounds output', async () => {
  const result = await runProbe(process.execPath, ['--version'], { env: probeEnv(process.env), cwd: os.tmpdir() });
  assert.equal(result.code, 0);
  assert.match(result.output, /^v\d/);
  const noisy = await runProbe(process.execPath, ['-e', 'process.stdout.write("x".repeat(40000))'], { env: probeEnv(process.env), cwd: os.tmpdir() });
  assert.match(noisy.error, /too much output/);
});

test('a hung probe settles at its deadline without waiting for close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  const pending = runProbe('/hung', [], { timeoutMs: 100, spawnProcess: () => child });
  t.mock.timers.tick(100);
  assert.match((await pending).error, /timed out/);
  child.emit('close', 0); // a late close cannot replace the timeout result
});

const immediate = () => new Promise((resolve) => setImmediate(resolve));

function helper(t) {
  const children = [];
  const service = new Environment({ forkWorker: () => {
    const child = new EventEmitter();
    children.push(child);
    return child;
  } });
  t.after(() => service.close());
  return { service, children };
}

function emitRuntimes(child, row = {}) {
  for (const runtime of RUNTIMES) {
    child.emit('message', { runtime: {
      id: runtime.id, label: runtime.label, status: 'not_found', version: null, path: null, command: runtime.id, ...row,
    } });
  }
}

test('a helper that exits after every runtime is a finished scan', async (t) => {
  const { service, children } = helper(t);
  service.refresh();
  emitRuntimes(children[0]);
  children[0].emit('exit', 1);
  await immediate();
  const snapshot = service.snapshot();
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.refreshing, false);
  assert.ok(snapshot.runtimes.every((row) => row.status === 'not_found'));
});

test('a helper that exits before every runtime is a failed scan', async (t) => {
  const { service, children } = helper(t);
  service.refresh();
  children[0].emit('message', { runtime: { id: 'node', label: 'Node.js', status: 'ok', version: '24.0.0', path: '/node' } });
  children[0].emit('exit', 1);
  await immediate();
  const snapshot = service.snapshot();
  assert.match(snapshot.error, /stopped before finishing/);
  assert.equal(snapshot.runtimes[0].status, 'ok');
  assert.equal(snapshot.runtimes[0].version, '24.0.0');
  assert.ok(snapshot.runtimes.slice(1).every((row) => row.status === 'failed'));
});

test('a completed helper can exit without turning the scan into a failure', async (t) => {
  const { service, children } = helper(t);
  service.refresh();
  emitRuntimes(children[0]);
  children[0].emit('message', { runtime: { id: 'node', label: 'Node.js', status: 'ok', version: '24.2.0', path: '/node' } });
  children[0].emit('message', { done: true });
  children[0].emit('exit', 0);
  await immediate();
  assert.equal(service.snapshot().error, null);
  assert.equal(service.snapshot().runtimes[0].version, '24.2.0');
});

test('scan cleanup waits for kills and ignores a locked directory', async () => {
  const events = [];
  const cwd = path.join(os.tmpdir(), 'agent-guild-environment-locked');
  await releaseScanDirectory(cwd, [Promise.resolve().then(() => events.push('reaped'))], {
    chdir(dir) { events.push(['chdir', dir]); },
    tmpdir: () => os.tmpdir(),
    remove() {
      events.push('remove');
      throw Object.assign(new Error('busy'), { code: 'EPERM' });
    },
  });
  assert.deepEqual(events, ['reaped', ['chdir', os.tmpdir()], 'remove']);
});

test('probe cleanup keeps an isolated process alive until close or the kill deadline', {
  // POSIX uses child.kill; Windows uses a real taskkill process instead.
  skip: process.platform === 'win32',
}, (t) => {
  for (const closes of [true, false]) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-environment-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    // No test runner or real child process can keep this subprocess alive.
    // Even the simulated close event is unref'd, so cleanup owns its lifetime.
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { EventEmitter } from 'node:events';
      import { runProbe, releaseScanDirectory } from ${JSON.stringify(new URL('../src/manager/environment-probe.mjs', import.meta.url).href)};
      const stream = () => Object.assign(new EventEmitter(), { destroy() {} });
      const child = Object.assign(new EventEmitter(), {
        pid: 1, stdout: stream(), stderr: stream(), unref() {},
        kill() {
          if (${closes}) setTimeout(() => child.emit('close', null), 10).unref();
        },
      });
      const kills = [];
      const result = await runProbe('/hung', [], { timeoutMs: 1, spawnProcess: () => child, kills });
      assert.match(result.error, /timed out/);
      assert.equal(kills.length, 1);
      let ended = false;
      kills[0].then(() => { ended = true; });
      await Promise.resolve();
      assert.equal(ended, false, 'the probe result does not wait for termination');
      await releaseScanDirectory(process.argv[1], kills);
    `, cwd], { env: probeEnv(process.env), encoding: 'utf8', timeout: 10000 });
    assert.equal(fs.existsSync(cwd), false, closes ? 'cleanup after close' : 'cleanup after the kill deadline');
  }
});

test('a timed-out probe releases its directory', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-environment-'));
  const kills = [];
  const result = await runProbe(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
    env: process.env, cwd, timeoutMs: 100, kills,
  });
  assert.match(result.error, /timed out/);
  assert.equal(kills.length, 1);
  const previous = process.cwd();
  try {
    await releaseScanDirectory(cwd, kills);
  } finally {
    try { process.chdir(previous); } catch { /* the scan directory was removed */ }
  }
  assert.equal(fs.existsSync(cwd), false);
});

test('real isolated scan reports the manager PATH Node without changing a project', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-environment-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, PATH: path.dirname(process.execPath), HOME: home, USERPROFILE: home, NVM_DIR: home };
  delete env.Path;
  const service = new Environment({ env });
  t.after(() => service.close());
  const finished = new Promise((resolve) => service.on('updated', () => { if (!service.snapshot().refreshing) resolve(); }));
  service.refresh();
  await finished;
  const snapshot = service.snapshot();
  assert.equal(snapshot.scope, 'manager');
  assert.equal(snapshot.runtimes[0].version, process.versions.node);
  assert.equal(snapshot.runtimes[0].status, 'ok');
  assert.equal(snapshot.refreshing, false);
  assert.equal(snapshot.error, null);
  assert.deepEqual(fs.readdirSync(home), []);
  assert.equal(typeof snapshot.host, 'string');
});

test('pin files report configured text and do not resolve aliases or shell out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-pins-'));
  fs.writeFileSync(path.join(dir, '.nvmrc'), '# comment\n\nlts/*\n');
  fs.writeFileSync(path.join(dir, '.node-version'), '22.11.0\n');
  fs.writeFileSync(path.join(dir, '.python-version'), '3.12.1\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    engines: { node: '>=22', npm: '10' }, packageManager: 'pnpm@9.12.0',
  }));
  fs.writeFileSync(path.join(dir, 'pyproject.toml'), 'requires-python = ">=3.11"\n');
  fs.writeFileSync(path.join(dir, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.80.0"\n');
  fs.writeFileSync(path.join(dir, 'rust-toolchain'), 'stable\n');
  fs.writeFileSync(path.join(dir, 'go.mod'), 'module example\n\ngo 1.22.0\n\ntoolchain go1.22.5\n');
  fs.writeFileSync(path.join(dir, 'global.json'), JSON.stringify({ sdk: { version: '8.0.100', rollForward: 'latestFeature' } }));
  fs.writeFileSync(path.join(dir, '.tool-versions'), 'nodejs 20.11.0\nruby 3.3.0\npython 3.11.8\n');
  const { pins } = scanPins(dir);
  const byId = Object.fromEntries(pins.map((item) => [item.id, item]));
  assert.equal(byId.nvmrc.version, 'lts/*');
  assert.equal(byId.nvmrc.status, 'configured');
  assert.equal(byId['node-version'].version, '22.11.0');
  assert.equal(byId['python-version'].version, '3.12.1');
  assert.equal(byId['engines-node'].version, '>=22');
  assert.equal(byId['engines-npm'].version, '10');
  assert.equal(byId['package-manager'].label, 'pnpm');
  assert.equal(byId['package-manager'].version, 'pnpm@9.12.0');
  assert.equal(byId['requires-python'].version, '>=3.11');
  assert.equal(byId['rust-toolchain'].version, '1.80.0');
  assert.equal(byId['rust-toolchain-file'].version, 'stable');
  assert.equal(byId['go-language'].version, '1.22.0');
  assert.equal(byId['go-toolchain'].version, 'go1.22.5');
  assert.equal(byId['global-json'].version, '8.0.100');
  assert.equal(byId['tool-versions-node'].version, '20.11.0');
  assert.equal(byId['tool-versions-python'].version, '3.11.8');
  assert.equal(pins.some((item) => /ruby/.test(item.version || '')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unreadable and invalid pins stay distinct from a configured version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-pins-bad-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{');
  fs.writeFileSync(path.join(dir, 'pyproject.toml'), 'requires-python = [\n  ">=3.11",\n]\n');
  fs.writeFileSync(path.join(dir, '.nvmrc'), `${'1'.repeat(200)}\n`);
  fs.mkdirSync(path.join(dir, '.python-version'));
  fs.writeFileSync(path.join(dir, '.node-version'), Buffer.alloc(64 * 1024 + 1));
  const pins = Object.fromEntries(scanPins(dir).pins.map((item) => [item.source, item]));
  assert.equal(pins['package.json'].status, 'invalid');
  assert.equal(pins['pyproject.toml'].status, 'invalid');
  assert.match(pins['pyproject.toml'].detail, /single-line/);
  assert.equal(pins['.nvmrc'].status, 'invalid');
  assert.equal(pins['.nvmrc'].version, null);
  assert.equal(pins['.python-version'].status, 'unreadable');
  assert.match(pins['.python-version'].detail, /not a file/);
  assert.equal(pins['.node-version'].status, 'unreadable');
  assert.match(pins['.node-version'].detail, /64 KiB/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a pin symlink outside the project is not read', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-pins-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const outside = path.join(root, 'secret');
  fs.writeFileSync(outside, '99\n');
  try { fs.symlinkSync(outside, path.join(project, '.nvmrc')); } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EINVAL') return;
    throw err;
  }
  const pin = scanPins(project).pins.find((item) => item.source === '.nvmrc');
  assert.equal(pin.status, 'unreadable');
  assert.match(pin.detail, /outside/);
  assert.equal(pin.version, null);
});

test('a project check does not use the project as its working directory', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-pins-cwd-'));
  fs.writeFileSync(path.join(project, '.nvmrc'), 'lts/*\n');
  const child = fork(new URL('../src/manager/environment-probe.mjs', import.meta.url), ['--scan-pins', project], {
    execArgv: [], cwd: os.tmpdir(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
  });
  const message = await new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
  });
  child.kill();
  assert.equal(message.pins[0].version, 'lts/*');
  assert.equal(path.resolve(message.cwd), path.resolve(os.tmpdir()));
  assert.notEqual(path.resolve(message.cwd), path.resolve(project));
  fs.rmSync(project, { recursive: true, force: true });
});

test('the project helper reads pins without inheriting the manager environment', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-pins-live-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '.nvmrc'), '20\n');
  const service = new Environment({ env: { ...process.env, AGENT_GUILD_REPORT_TOKEN: 'secret' } });
  t.after(() => service.close());
  const finished = new Promise((resolve) => {
    service.on('updated', (snapshot) => {
      if (snapshot?.scope === 'project' && !snapshot.refreshing) resolve(snapshot);
    });
  });
  service.openProject(dir);
  const snapshot = await finished;
  assert.equal(snapshot.cwd, dir);
  assert.equal(snapshot.pins[0].version, '20');
  assert.equal(snapshot.pins[0].status, 'configured');
  assert.equal(snapshot.error, null);
});

test('a project folder is required and does not fall back to home', () => {
  assert.throws(() => resolveProjectCwd('  ', { homedir() { throw new Error('home'); } }), { code: 'cwd_required' });
  assert.throws(() => resolveProjectCwd(path.join(os.tmpdir(), 'guild-pins-missing')), { code: 'bad_cwd' });
});

test('launch scope labels the manager result and a manager refresh leaves that copy alone', async (t) => {
  const { service, children } = helper(t);
  service.refresh();
  emitRuntimes(children[0], { status: 'ok', version: '24.0.0', path: '/node' });
  children[0].emit('message', { tools: [{ id: 'uv', label: 'uv', path: '/uv', status: 'detected' }] });
  children[0].emit('message', { done: true });
  await immediate();
  const launch = service.openLaunch();
  assert.equal(children.length, 1);
  assert.equal(launch.scope, 'launch');
  assert.equal(launch.detail, LAUNCH_DETAIL);
  assert.equal(launch.managerNode, undefined);
  assert.equal(launch.runtimes[0].version, '24.0.0');
  service.refresh();
  emitRuntimes(children[1], { status: 'ok', version: '24.9.0', path: '/node' });
  children[1].emit('message', { done: true });
  await immediate();
  assert.equal(service.snapshot().runtimes[0].version, '24.9.0');
  assert.equal(service.openLaunch().runtimes[0].version, '24.0.0');
  service.openLaunch({ refresh: true });
  assert.equal(children.length, 3);
  emitRuntimes(children[2], { status: 'ok', version: '24.10.0', path: '/node' });
  children[2].emit('message', { done: true });
  await immediate();
  assert.equal(service.openLaunch().runtimes[0].version, '24.10.0');
  assert.equal(service.snapshot().runtimes[0].version, '24.10.0');
});

test('a session probe receives only the spawn PATH, and a multiplexer is not probed', async (t) => {
  const seen = [];
  const children = [];
  const service = new Environment({
    forkWorker: (_file, _args, opts) => {
      seen.push(opts.env);
      const child = new EventEmitter();
      children.push(child);
      return child;
    },
    sessionLookup: (id) => {
      if (id === 'aa') return { multiplexer: false, spawnCwd: '/work', pathEnv: { PATH: '/sessions', AGENT_GUILD_REPORT_TOKEN: 'secret', NODE_OPTIONS: 'preload' } };
      if (id === 'bb') return { multiplexer: true, spawnCwd: '/mux', pathEnv: { PATH: '/mux', AGENT_GUILD_REPORT_TOKEN: 'secret' } };
      return null;
    },
  });
  t.after(() => service.close());
  assert.equal(probePathEnv({ PATH: '/bin', AGENT_GUILD_REPORT_TOKEN: 'secret' }).AGENT_GUILD_REPORT_TOKEN, undefined);
  const started = service.openSession('aa');
  assert.equal(started.refreshing, true);
  assert.equal(seen[0].PATH, '/sessions');
  assert.equal(seen[0].AGENT_GUILD_REPORT_TOKEN, undefined);
  assert.equal(seen[0].NODE_OPTIONS, undefined);
  emitRuntimes(children[0], { status: 'ok', version: '24.0.0', path: '/sessions/node' });
  children[0].emit('message', { done: true });
  await immediate();
  const done = service.openSession('aa');
  assert.equal(done.availability, 'ok');
  assert.equal(done.spawnCwd, '/work');
  assert.equal(done.runtimes[0].version, '24.0.0');
  assert.equal(children.length, 1);
  const mux = service.openSession('bb');
  assert.equal(mux.availability, 'unavailable');
  assert.match(mux.detail, /tmux or herdr/);
  assert.deepEqual(mux.runtimes, []);
  assert.equal(children.length, 1);
  assert.equal(service.openSession('cc'), null);
});

test('an edited pin file marks the project stale without replacing the previous pin', async (t) => {
  const children = [];
  const args = [];
  const service = new Environment({ forkWorker: (_file, argv) => {
    args.push(argv[0]);
    const child = new EventEmitter();
    children.push(child);
    return child;
  } });
  t.after(() => service.close());
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-pins-stale-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const first = service.openProject(cwd);
  assert.equal(first.refreshing, true);
  const pin = { id: 'nvmrc', label: 'Node.js', source: '.nvmrc', version: '22', status: 'configured', detail: null };
  children[0].emit('message', { identity: 'same', pins: [pin] });
  children[0].emit('message', { done: true });
  await immediate();
  assert.equal(service.openProject(cwd).pins[0].version, '22');
  assert.equal(args[1], '--pin-identity');
  children[1].emit('message', { identity: 'edited' });
  children[1].emit('message', { done: true });
  await immediate();
  const stale = service.openProject(cwd);
  assert.equal(stale.stale, true);
  assert.equal(stale.pins[0].version, '22');
  const again = service.openProject(cwd, { refresh: true });
  assert.equal(again.refreshing, true);
  assert.equal(again.pins[0].version, '22');
  children.at(-1).emit('message', { identity: 'edited', pins: [{ ...pin, version: '24' }] });
  children.at(-1).emit('message', { done: true });
  await immediate();
  const fresh = service.openProject(cwd);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.pins[0].version, '24');
});
