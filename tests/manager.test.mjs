// End-to-end tests: a real manager, real PTYs, real WebSockets.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-test-'));
process.env.AGENT_GUILD_HOME = home;
process.env.AGENT_GUILD_PORT = '0';
process.env.AGENT_GUILD_SKIP_SHELL_ENV = '1';

fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify({
  providers: [
    { id: 'fake', vendor: 'Test', tool: 'Fake Tool', command: process.execPath, args: [path.join(here, 'fixtures', 'fake-tool.mjs')] },
    { id: 'missing', vendor: 'Nobody', tool: 'Missing Tool', command: 'definitely-not-installed-agent-guild', install: 'npm i -g nothing' },
  ],
}));

const { startManager } = await import('../src/manager/main.mjs');

let ctx;
let base;
let token;

before(async () => {
  ctx = await startManager({ sessionDefaults: { doneAgentLingerMs: 200, activityIdleMs: 200, killGraceMs: 500 } });
  base = ctx.api.url;
  token = ctx.token;
});

after(async () => {
  await ctx.shutdown('tests done');
  // Windows may hold the folder briefly after a process exits.
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  // node-pty on Windows can keep a handle open after every session has
  // ended. Exit once results are reported rather than hanging the run.
  setTimeout(() => process.exit(), 3000).unref();
});

async function call(method, route, body, headers = {}) {
  const res = await fetch(`${base}/api/v1${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

/** Raw request so we can forge Host/Origin headers (fetch forbids that). */
function rawGet(route, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}${route}`, { headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
  });
}

function waitFor(predicate, { timeout = 8000, interval = 25, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      try {
        const value = await predicate();
        if (value) return resolve(value);
      } catch { /* retry */ }
      if (Date.now() - start > timeout) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, interval);
    };
    tick();
  });
}

class Client {
  constructor(url) {
    this.messages = [];
    this.output = '';
    this.ws = new WebSocket(url);
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      this.messages.push(msg);
      if (msg.type === 'data') this.output += msg.data;
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.closed = new Promise((resolve) => this.ws.once('close', (code) => resolve(code)));
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  input(text) { this.send({ type: 'input', data: text + '\r' }); }
  close() { this.ws.close(); return this.closed; }
}

// ConPTY on Windows repaints with its own escape sequences, so compare text only.
const stripAnsi = (text) => text.replace(/\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>78]/g, '');

/** Visible text of a session's screen, read from the manager's mirror. */
function screenText(id) {
  const buffer = ctx.manager.get(id).term.buffer.active;
  const lines = [];
  for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
  return lines.join('\n');
}

async function waitForText(client, sessionId, text, label) {
  try {
    await waitFor(() => stripAnsi(client.output).includes(text) || screenText(sessionId).includes(text), { label });
  } catch (err) {
    err.message += `\n--- stream tail ---\n${JSON.stringify(client.output.slice(-600))}\n--- screen ---\n${screenText(sessionId).trimEnd().slice(-600)}`;
    throw err;
  }
}

const terminal = (id) => new Client(`${base.replace('http', 'ws')}/api/v1/sessions/${id}/terminal?token=${token}`);

async function createFake(extra = {}) {
  const { status, body } = await call('POST', '/sessions', { providerId: 'fake', cwd: home, cols: 90, rows: 20, ...extra });
  assert.equal(status, 201, JSON.stringify(body));
  return body.session;
}

test('health is public, everything else needs the token', async () => {
  const health = await fetch(`${base}/api/v1/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).name, 'agent-guild');
  const noToken = await fetch(`${base}/api/v1/sessions`);
  assert.equal(noToken.status, 401);
  const wrong = await call('GET', '/sessions', undefined, { Authorization: 'Bearer nope' });
  assert.equal(wrong.status, 401);
});

test('foreign Host and Origin headers are rejected', async () => {
  const port = new URL(base).port;
  assert.equal(await rawGet('/api/v1/health', { Host: `attacker.example:${port}` }), 403);
  assert.equal(await rawGet('/api/v1/health', { Origin: 'https://attacker.example' }), 403);
  assert.equal(await rawGet('/api/v1/health', { Origin: `http://localhost:${port}` }), 200);
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/v1/events?token=${token}`, { origin: 'https://attacker.example' });
  const err = await new Promise((resolve) => ws.once('unexpected-response', (_req, res) => resolve(res.statusCode)));
  assert.equal(err, 403);
  const noAuth = new WebSocket(`${base.replace('http', 'ws')}/api/v1/events`);
  assert.equal(await new Promise((resolve) => noAuth.once('unexpected-response', (_req, res) => resolve(res.statusCode))), 401);
});

test('the web page and xterm assets are served', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Agent Guild/);
  assert.equal((await fetch(`${base}/vendor/xterm/xterm.js`)).status, 200);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
});

test('providers report availability', async () => {
  const { body } = await call('GET', '/providers');
  const fake = body.providers.find((p) => p.id === 'fake');
  const missing = body.providers.find((p) => p.id === 'missing');
  assert.equal(fake.available, true);
  assert.equal(missing.available, false);
  assert.ok(body.providers.some((p) => p.id === 'anthropic'), 'built-in providers are still listed');
});

test('session creation validates its input', async () => {
  assert.equal((await call('POST', '/sessions', { providerId: 'nope' })).status, 404);
  const missing = await call('POST', '/sessions', { providerId: 'missing' });
  assert.equal(missing.status, 409);
  assert.match(missing.body.error.message, /npm i -g nothing/);
  assert.equal((await call('POST', '/sessions', { providerId: 'fake', cwd: path.join(home, 'no-such-dir') })).status, 400);
  assert.equal((await call('POST', '/sessions', { providerId: 'fake', args: 'x' })).status, 400);
});

test('a session runs, streams output, accepts input and resizes', async () => {
  const session = await createFake();
  assert.equal(session.status, 'running');
  assert.equal(session.cwd, home);

  const client = terminal(session.id);
  await client.opened;
  await waitFor(() => client.messages[0], { label: 'snapshot' });
  assert.equal(client.messages[0].type, 'snapshot', 'the first message is always a snapshot');

  await waitFor(() => client.messages.some((m) => m.type === 'snapshot' && m.data.includes('FAKE-TOOL READY')) || client.output.includes('FAKE-TOOL READY'), { label: 'banner' });
  client.input('echo hello world');
  await waitFor(() => client.output.includes('ECHO:hello world'), { label: 'echo' });

  client.input('env');
  await waitFor(() => client.output.includes('ENV:'), { label: 'env' });
  assert.ok(client.output.includes(`ENV:${session.id}|fake|${base}`), client.output);

  client.send({ type: 'resize', cols: 101, rows: 33 });
  await waitFor(async () => (await call('GET', `/sessions/${session.id}`)).body.session.cols === 101, { label: 'resize' });
  client.input('size');
  await waitForText(client, session.id, 'SIZE:101x33', 'pty size');

  await client.close();
  await call('DELETE', `/sessions/${session.id}`);
});

test('reconnecting clients get a snapshot of the current screen', async () => {
  const session = await createFake();
  const first = terminal(session.id);
  await first.opened;
  first.input('echo before-disconnect');
  await waitFor(() => first.output.includes('ECHO:before-disconnect'), { label: 'first output' });
  await first.close();

  // Output produced while nobody is watching must still be captured.
  const { body } = await call('GET', `/sessions/${session.id}`);
  assert.equal(body.session.status, 'running', 'closing the client does not stop the session');

  const second = terminal(session.id);
  await second.opened;
  const snapshot = await waitFor(() => second.messages.find((m) => m.type === 'snapshot'), { label: 'snapshot' });
  assert.ok(snapshot.data.includes('ECHO:before-disconnect'), snapshot.data);
  assert.equal(snapshot.cols, 90);
  second.input('echo after-reconnect');
  await waitFor(() => second.output.includes('ECHO:after-reconnect'), { label: 'live output after snapshot' });
  await second.close();
  await call('DELETE', `/sessions/${session.id}`);
});

test('agents can be reported over HTTP with the session report token', async () => {
  const session = await createFake();
  const managed = ctx.manager.get(session.id);
  const route = `/sessions/${session.id}/agents`;

  const denied = await call('POST', route, { agentId: 'a' }, { Authorization: '', 'X-Agent-Guild-Report-Token': 'wrong' });
  assert.equal(denied.status, 401);

  const ok = await call('POST', route, { agentId: 'explore-1', name: 'Explorer', detail: 'reading src/' },
    { Authorization: '', 'X-Agent-Guild-Report-Token': managed.reportToken });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.agent.status, 'working');

  assert.equal((await call('POST', route, { agentId: 'x', status: 'dancing' })).status, 400);
  assert.equal((await call('POST', route, {})).status, 400);

  let { body } = await call('GET', `/sessions/${session.id}`);
  assert.deepEqual(body.session.agents.map((a) => a.name), ['Explorer']);

  await call('POST', route, { agentId: 'explore-1', status: 'done' });
  ({ body } = await call('GET', `/sessions/${session.id}`));
  assert.equal(body.session.agents[0].status, 'done', 'done agents linger briefly');
  await waitFor(async () => (await call('GET', `/sessions/${session.id}`)).body.session.agents.length === 0, { label: 'agent removal' });
  await call('DELETE', `/sessions/${session.id}`);
});

test('agents can be reported in-band with an OSC escape sequence', async () => {
  const session = await createFake();
  const client = terminal(session.id);
  await client.opened;
  client.input('agent worker-7 Builder');
  const agents = await waitFor(async () => {
    const { body } = await call('GET', `/sessions/${session.id}`);
    return body.session.agents.length ? body.session.agents : null;
  }, { label: 'osc agent' });
  assert.equal(agents[0].id, 'worker-7');
  assert.equal(agents[0].name, 'Builder');
  assert.equal(agents[0].source, 'terminal');
  await client.close();
  await call('DELETE', `/sessions/${session.id}`);
});

test('the events socket announces session lifecycle changes', async () => {
  const events = new Client(`${base.replace('http', 'ws')}/api/v1/events?token=${token}`);
  await events.opened;
  await waitFor(() => events.messages.find((m) => m.type === 'hello'), { label: 'hello' });

  const session = await createFake({ name: 'Lifecycle' });
  await waitFor(() => events.messages.find((m) => m.type === 'session.created' && m.session.id === session.id), { label: 'created' });

  const renamed = await call('PATCH', `/sessions/${session.id}`, { name: 'Renamed' });
  assert.equal(renamed.body.session.name, 'Renamed');

  const term = terminal(session.id);
  await term.opened;
  term.input('exit 3');
  const exit = await waitFor(() => term.messages.find((m) => m.type === 'exit'), { label: 'exit message' });
  assert.equal(exit.exitCode, 3);
  await waitFor(() => events.messages.find((m) => m.type === 'session.updated' && m.session.id === session.id && m.session.status === 'exited'), { label: 'exited event' });

  // Exited sessions stay listed until removed, and still replay their last screen.
  const late = terminal(session.id);
  await late.opened;
  await waitFor(() => late.messages.find((m) => m.type === 'exit'), { label: 'exit replay' });
  assert.equal(late.messages[0].type, 'snapshot');

  assert.equal((await call('DELETE', `/sessions/${session.id}`)).status, 200);
  await waitFor(() => events.messages.find((m) => m.type === 'session.removed' && m.sessionId === session.id), { label: 'removed' });
  assert.equal(await late.closed, 4410);
  assert.equal((await call('GET', `/sessions/${session.id}`)).status, 404);
  await term.close();
  await events.close();
});

test('stop ends a running session', async () => {
  const session = await createFake();
  const { status } = await call('POST', `/sessions/${session.id}/stop`);
  assert.equal(status, 200);
  await waitFor(async () => (await call('GET', `/sessions/${session.id}`)).body.session.status === 'exited', { label: 'stopped' });
  await call('DELETE', `/sessions/${session.id}`);
});

test('a tool that ignores the hang-up is force-killed', { skip: process.platform === 'win32' }, async () => {
  const session = await createFake();
  const client = terminal(session.id);
  await client.opened;
  client.input('stubborn');
  await waitFor(() => client.output.includes('STUBBORN'), { label: 'stubborn mode' });
  const pid = ctx.manager.get(session.id).pid;
  await client.close();
  await call('DELETE', `/sessions/${session.id}`);
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  await waitFor(() => !alive(), { timeout: 5000, label: 'force kill' });
});

test('several sessions run concurrently', async () => {
  const sessions = await Promise.all([createFake(), createFake(), createFake()]);
  const clients = sessions.map((s) => terminal(s.id));
  await Promise.all(clients.map((c) => c.opened));
  clients.forEach((c, i) => c.input(`echo session-${i}`));
  await Promise.all(clients.map((c, i) => waitFor(() => c.output.includes(`ECHO:session-${i}`), { label: `session ${i}` })));
  clients.forEach((c, i) => assert.ok(!c.output.includes(`ECHO:session-${(i + 1) % 3}`), 'output does not leak between sessions'));
  await Promise.all(clients.map((c) => c.close()));
  for (const s of sessions) await call('DELETE', `/sessions/${s.id}`);
});

test('the runtime file lets other clients discover the manager', () => {
  const runtime = JSON.parse(fs.readFileSync(path.join(home, 'manager.json'), 'utf8'));
  assert.equal(runtime.url, base);
  assert.equal(runtime.pid, process.pid);
  assert.equal(fs.readFileSync(path.join(home, 'auth-token'), 'utf8').trim(), token);
});
