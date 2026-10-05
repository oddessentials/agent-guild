import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nextManager, serviceFor, startService } from '../src/manager/launch.mjs';
import { EXIT_PORT_IN_USE, EXIT_RESTART, createBootService, journalCommand, lingerCommand, serviceUnit, startupSummary, unitPort } from '../src/manager/systemd-service.mjs';
import { fakeSystemd } from './fixtures/fake-systemd.mjs';

const BIN = fileURLToPath(new URL('../bin/agent-guild.mjs', import.meta.url));

/** A boot service whose unit is `enabled` for `port`, recording what is asked of it. */
function fakeBoot({ enabled = true, port = 47821, failStart = false, failReset = false } = {}) {
  const calls = [];
  return {
    calls,
    read: async () => { calls.push('read'); return { reachable: true, enabled }; },
    text: async () => serviceUnit({ launcher: '/d/boot.sh', execPath: '/n', script: '/s', file: '/c', port }),
    resetFailed: async () => { calls.push('reset-failed'); if (failReset) throw new Error('reset refused'); return { status: 0 }; },
    start: async ({ block }) => { calls.push(block ? 'start' : 'start --no-block'); if (failStart) throw new Error('start refused'); },
  };
}

function fakeSpawn() {
  const spawned = [];
  return { spawned, spawn: (opts) => { spawned.push(opts); return { pid: 99 }; } };
}

test('a supervised manager exits for systemd to start the next one, after resetting the start count', async () => {
  for (const failReset of [false, true]) {
    const boot = fakeBoot({ failReset });
    const { spawned, spawn: start } = fakeSpawn();
    const lines = [];
    assert.equal(await nextManager({ supervised: true, boot, port: 47821, spawn: start, log: (l) => lines.push(l) }), EXIT_RESTART);
    assert.deepEqual(boot.calls, ['reset-failed']);
    assert.deepEqual(spawned, [], 'systemd starts it, so nothing else does');
    assert.match(lines.join('\n'), /exiting for systemd/);
  }
  assert.equal(await nextManager({ supervised: true, boot: null, port: 1, spawn: () => assert.fail('no spawn'), log: () => {} }), EXIT_RESTART);
});

test('a manager started without systemd hands its restart to the service on its port', async () => {
  const boot = fakeBoot({ port: 47821 });
  const { spawned, spawn: start } = fakeSpawn();
  assert.equal(await nextManager({ boot, port: 47821, spawn: start, log: () => {} }), 0);
  assert.deepEqual(boot.calls, ['read', 'reset-failed', 'start --no-block']);
  assert.deepEqual(spawned, []);
});

test('without the service on its port, or when systemd refuses, the next manager is started directly', async () => {
  for (const boot of [null, fakeBoot({ enabled: false }), fakeBoot({ port: 51234 }), fakeBoot({ failStart: true })]) {
    const { spawned, spawn: start } = fakeSpawn();
    const lines = [];
    assert.equal(await nextManager({ boot, port: 47821, spawn: start, log: (l) => lines.push(l) }), 0);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].env.AGENT_GUILD_PORT, '47821');
    assert.match(lines.at(-1), /started the next manager \(pid 99\)/);
  }
});

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-service-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Runs `agent-guild start` with its own data folder; resolves the child, its output so far, and its exit. */
function start(home, port, args) {
  const child = spawn(process.execPath, [BIN, 'start', ...args], {
    env: { ...process.env, AGENT_GUILD_HOME: home, AGENT_GUILD_PORT: String(port), AGENT_GUILD_NO_UPDATE_CHECK: '1', AGENT_GUILD_SKIP_SHELL_ENV: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, exited, output: () => output };
}

test('a supervised manager whose port is taken exits with the code systemd does not retry', { timeout: 60000 }, async (t) => {
  const home = tempHome(t);
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  t.after(() => holder.close());
  const { port } = holder.address();
  const supervised = start(home, port, ['--service']);
  assert.equal(await supervised.exited, EXIT_PORT_IN_USE);
  assert.match(supervised.output(), /already in use/);
  const plain = start(home, port, []);
  assert.equal(await plain.exited, 1, 'without systemd it stays an ordinary failure');
});

test('a supervised manager asked to restart exits for systemd and starts no successor itself', { timeout: 60000 }, async (t) => {
  const home = tempHome(t);
  const port = await freePort();
  const manager = start(home, port, ['--service']);
  t.after(() => manager.child.kill('SIGKILL'));
  const deadline = Date.now() + 30000;
  while (!/listening on/.test(manager.output())) {
    if (Date.now() > deadline) assert.fail(`the manager did not start:\n${manager.output()}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const token = fs.readFileSync(path.join(home, 'auth-token'), 'utf8').trim();
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/shutdown`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: true, restart: true }),
  });
  assert.equal(res.status, 202);
  assert.equal(await manager.exited, EXIT_RESTART);
  assert.match(manager.output(), /exiting for systemd to start the next manager/);
  assert.doesNotMatch(manager.output(), /started the next manager/);
});

const posix = { skip: process.platform === 'win32' && 'systemd units run on Linux' };

/** A real boot service over a fake user manager, with its unit enabled for `port` when `port` is given. */
async function bootWith(t, { port = null, systemd = fakeSystemd() } = {}) {
  const home = tempHome(t);
  const boot = createBootService({ env: {}, home, user: 'ana', uid: 1000, dataDir: path.join(home, 'data'), lingerDir: path.join(home, 'linger'), run: systemd.run });
  if (port !== null) {
    await boot.write({ execPath: '/old/node', script: '/old/agent-guild.mjs', port });
    systemd.state.enabled = true;
  }
  systemd.calls.length = 0;
  return { boot, systemd };
}

test('the CLI uses the service only while it is on for the port it wants, and says why when it cannot', posix, async (t) => {
  assert.deepEqual(await serviceFor(47821, null), { boot: null, note: null });
  const on = await bootWith(t, { port: 47821 });
  assert.equal((await serviceFor(47821, on.boot)).boot, on.boot);
  assert.equal((await serviceFor(51234, on.boot)).boot, null, 'another port is not the service\'s');
  const off = await bootWith(t);
  assert.deepEqual(await serviceFor(47821, off.boot), { boot: null, note: null });

  const unreachable = await bootWith(t, { port: 47821 });
  unreachable.systemd.state.reachable = false;
  const passed = await serviceFor(47821, unreachable.boot);
  assert.equal(passed.boot, null);
  assert.match(passed.note, /^The boot service could not be used \(.*Failed to connect to bus.*\), so the session manager runs without systemd\.$/);
  const none = await bootWith(t);
  none.systemd.state.reachable = false;
  assert.deepEqual(await serviceFor(47821, none.boot), { boot: null, note: null }, 'no unit, nothing to explain');
});

test('starting through systemd points the unit at this Node.js, clears a failure, and waits for the manager to answer', posix, async (t) => {
  const { boot, systemd } = await bootWith(t, { port: 47821 });
  let answers = 0;
  const health = async () => (++answers >= 3 ? { version: '9.9.9' } : null);
  const result = await startService({ boot, port: 47821, url: 'http://127.0.0.1:47821', health, execPath: '/new/node', script: '/new/agent-guild.mjs', pollMs: 1 });
  assert.deepEqual(result, { url: 'http://127.0.0.1:47821', started: true, version: '9.9.9' });
  assert.match(await boot.text(), /"\/new\/node" "\/new\/agent-guild.mjs"/);
  assert.equal(unitPort(await boot.text()), 47821);
  assert.deepEqual(systemd.verbs().filter((v) => v !== 'show'), ['daemon-reload', 'reset-failed', 'start']);

  systemd.calls.length = 0;
  await startService({ boot, port: 47821, url: 'u', health: async () => ({ version: '1' }), execPath: '/new/node', script: '/new/agent-guild.mjs' });
  assert.deepEqual(systemd.verbs(), ['reset-failed', 'start'], 'an unchanged unit needs no reload');

  systemd.calls.length = 0;
  await startService({ boot, port: 47821, url: 'u', health: async () => ({ version: '1' }), execPath: '/odd/$node', script: '/new/agent-guild.mjs' });
  assert.match(await boot.text(), /"\/new\/node"/, 'a path systemd would misread is not written');
  assert.deepEqual(systemd.verbs(), ['reset-failed', 'start']);
});

test('a service that fails or never answers is reported with its journal', posix, async (t) => {
  const { boot, systemd } = await bootWith(t, { port: 47821 });
  systemd.state.journal = 'node: not found\n';
  systemd.state.started = { ActiveState: 'failed', Result: 'exit-code', ExecMainStatus: '127', MainPID: '0' };
  const started = Date.now();
  await assert.rejects(
    startService({ boot, port: 47821, url: 'u', health: async () => null, execPath: '/n', script: '/s', timeoutMs: 60000, pollMs: 1 }),
    (err) => err.message === `the session manager did not start under systemd.\n\nRecent log (${journalCommand(20)}):\nnode: not found`,
  );
  assert.ok(Date.now() - started < 5000, 'a failed unit is reported at once, not after the timeout');

  systemd.state.started = { ActiveState: 'active', MainPID: '5' };
  await assert.rejects(startService({ boot, port: 47821, url: 'u', health: async () => null, execPath: '/n', script: '/s', timeoutMs: 20, pollMs: 1 }), /did not start under systemd/);

  systemd.state.fail.add('start');
  await assert.rejects(startService({ boot, port: 47821, url: 'u', health: async () => null, execPath: '/n', script: '/s' }), /Could not start the systemd unit: start refused/);
});

test('status sums up the startup setting in one line', () => {
  assert.equal(startupSummary(undefined), null);
  assert.equal(startupSummary({ available: false, enabled: false, reason: 'Not available in WSL.' }), 'Startup: Not available in WSL.');
  assert.equal(startupSummary({ available: true, enabled: true, reason: null }), 'Starts when you sign in.');
  assert.equal(startupSummary({ available: true, enabled: false, reason: null }), 'Starts only when you start it.');
  const boot = { enabled: true, linger: true, user: 'ana', state: { kind: 'running', since: null, pid: 4 } };
  assert.equal(startupSummary({ available: true, enabled: false, mode: 'boot', boot }), 'Starts when the computer starts; running under systemd.');
  assert.match(startupSummary({ available: true, enabled: true, mode: 'both', boot }), /A sign-in entry is on as well; choose one under Settings › Startup\.$/);
  assert.ok(startupSummary({ available: true, enabled: false, mode: 'boot', boot: { ...boot, linger: false } }).endsWith(lingerCommand('ana')));
});
