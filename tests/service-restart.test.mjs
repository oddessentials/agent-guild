import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nextManager } from '../src/manager/launch.mjs';
import { EXIT_PORT_IN_USE, EXIT_RESTART, serviceUnit } from '../src/manager/systemd-service.mjs';

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
