// The launcher starts a detached manager that outlives it, and can stop it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '../bin/agent-guild.mjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-launcher-'));

// A provider that runs the fake tool, so a real session can be running when
// the manager is asked to stop.
fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify({
  providers: [
    { id: 'fake', vendor: 'Test', tool: 'Fake Tool', command: process.execPath, args: [path.join(here, 'fixtures', 'fake-tool.mjs')] },
    { id: 'anthropic', usage: null },
    { id: 'openai', usage: null },
    { id: 'google', usage: null },
  ],
}));

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, AGENT_GUILD_HOME: home, AGENT_GUILD_PORT: String(port), AGENT_GUILD_SKIP_SHELL_ENV: '1', AGENT_GUILD_NO_UPDATE_CHECK: '1' };

function run(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { env, timeout: 30000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

const token = () => fs.readFileSync(path.join(home, 'auth-token'), 'utf8').trim();

async function call(method, route, body) {
  const res = await fetch(`${base}/api/v1${route}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

after(async () => {
  await run('stop');
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('open starts a background manager, status reports it, stop ends it', async () => {
  const opened = await run('open', '--no-browser');
  assert.equal(opened.code, 0, opened.stderr);
  assert.match(opened.stdout, /Session manager started/);
  assert.match(opened.stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}/#token=[a-f0-9]+`));

  // The launcher has exited; the manager must still be serving.
  const health = await fetch(`${base}/api/v1/health`);
  assert.equal(health.status, 200);

  const again = await run('open', '--no-browser');
  assert.match(again.stdout, /already running/);

  const status = await run('status');
  assert.equal(status.code, 0);
  assert.match(status.stdout, /running at/);

  const url = await run('url');
  assert.match(url.stdout, /#token=/);

  // With a session running, a bare shutdown request is refused: the web
  // page uses that refusal to ask before ending sessions.
  const created = await call('POST', '/sessions', { providerId: 'fake', cwd: home });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  // Windows reports the pid a moment after the console connects.
  let pid = created.body.session.pid;
  for (let i = 0; pid === null && i < 200; i++) {
    await new Promise((r) => setTimeout(r, 25));
    pid = (await call('GET', `/sessions/${created.body.session.id}`)).body.session.pid;
  }
  assert.ok(pid, 'the session has a pid');
  const refused = await call('POST', '/shutdown');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'sessions_running');
  assert.equal(refused.body.error.running, 1);
  assert.equal((await fetch(`${base}/api/v1/health`)).status, 200, 'a refused shutdown leaves the manager running');

  // Every events client hears that the manager is stopping before it goes.
  const events = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events?token=${token()}`);
  const messages = [];
  events.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { events.once('open', resolve); events.once('error', reject); });
  const closed = new Promise((resolve) => events.once('close', resolve));

  // The CLI's stop is documented as ending every session, so it forces.
  const stopped = await run('stop');
  assert.match(stopped.stdout, /Ending 1 running session/);
  assert.match(stopped.stdout, /stopped/);
  await closed;
  // The socket closes only after the sessions have ended, so a page can
  // report "every session has ended" when its socket drops.
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(alive(), false, 'the session process has exited by the time the events socket closes');
  const stopping = messages.find((m) => m.type === 'manager.stopping');
  assert.ok(stopping, `no manager.stopping event in ${JSON.stringify(messages.map((m) => m.type))}`);
  assert.equal(stopping.running, 1);

  const after = await run('status');
  assert.equal(after.code, 3);
  assert.ok(!fs.existsSync(path.join(home, 'manager.json')), 'runtime file is removed on shutdown');
});
