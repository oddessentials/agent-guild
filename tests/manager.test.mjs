// End-to-end tests: a real manager, real PTYs, real WebSockets.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { execFile } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-test-'));
process.env.AGENT_GUILD_HOME = home;
process.env.AGENT_GUILD_PORT = '0';
process.env.AGENT_GUILD_SKIP_SHELL_ENV = '1';

// A stand-in npm so install sessions never touch the real global prefix.
const bin = path.join(home, 'bin');
fs.mkdirSync(bin);
if (process.platform === 'win32') {
  fs.writeFileSync(path.join(bin, 'npm.cmd'), '@echo off\r\necho FAKE-NPM %*\r\n');
} else {
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho "FAKE-NPM $*"\n', { mode: 0o755 });
}
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

// A stand-in npm registry that knows one package.
const npmRegistry = http.createServer((req, res) => {
  const known = req.url === '/fake-tool-pkg/latest';
  res.writeHead(known ? 200 : 404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(known ? { name: 'fake-tool-pkg', version: '9.9.9' } : { error: 'Not found' }));
});
await new Promise((resolve) => npmRegistry.listen(0, '127.0.0.1', resolve));
process.env.AGENT_GUILD_NPM_REGISTRY = `http://127.0.0.1:${npmRegistry.address().port}`;

fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify({
  providers: [
    { id: 'fake', vendor: 'Test', tool: 'Fake Tool', command: process.execPath, args: [path.join(here, 'fixtures', 'fake-tool.mjs')], resumeArgs: ['--resume', '{id}'], package: 'fake-tool-pkg', versionArgs: [path.join(here, 'fixtures', 'fake-tool.mjs'), '--version'], modelPattern: 'fake-model-[a-z0-9.]+' },
    { id: 'plain', vendor: 'Test', tool: 'Plain Tool', command: process.execPath, args: [path.join(here, 'fixtures', 'fake-tool.mjs')], usage: { command: process.execPath, args: [path.join(here, 'fixtures', 'fake-usage.mjs')] } },
    { id: 'missing', vendor: 'Nobody', tool: 'Missing Tool', command: 'definitely-not-installed-agent-guild', install: 'npm i -g nothing', package: 'nothing' },
    // Never read the developer's real Claude Code or Codex sign-in during tests.
    { id: 'anthropic', usage: null },
    { id: 'openai', usage: null },
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
  npmRegistry.close();
  assert.equal(ctx.manager.exiting.size, 0, 'shutdown waits for removed sessions to exit');
  try {
    // Windows may hold the folder briefly after a process exits.
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    console.warn(`could not remove ${home}: ${err.message}`);
  }
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
  assert.equal(fake.resumable, true);
  assert.equal(fake.installable, true);
  const plain = body.providers.find((p) => p.id === 'plain');
  assert.equal(plain.resumable, false);
  assert.equal(plain.installable, false, 'no npm package configured');
  assert.equal(missing.available, false);
  assert.equal(missing.installable, true);
  assert.ok(body.providers.some((p) => p.id === 'anthropic'), 'built-in providers are still listed');
});

test('usage meters come from the provider usage source', async () => {
  const { body } = await call('GET', '/providers');
  assert.equal(body.providers.find((p) => p.id === 'plain').usageSource, 'command');
  assert.equal(body.providers.find((p) => p.id === 'fake').usageSource, null);
  assert.equal(body.providers.find((p) => p.id === 'anthropic').usageSource, null, 'built-in sources are disabled for tests');

  const { status, body: usage } = await call('GET', '/usage');
  assert.equal(status, 200);
  assert.deepEqual(usage.usage.map((u) => u.providerId), ['plain'], 'only providers with a source are listed');
  const [plain] = usage.usage;
  assert.equal(plain.error, null);
  assert.equal(plain.plan, 'test');
  assert.deepEqual(plain.windows, [
    { label: '5-hour', usedPercent: 42.3, resetsAt: '2030-01-01T00:00:00.000Z' },
    { label: '7-day', usedPercent: 90, resetsAt: null },
  ]);
});

test('installed and latest versions are reported and updates flagged', async () => {
  const fake = await waitFor(async () => {
    const p = (await call('GET', '/providers')).body.providers.find((x) => x.id === 'fake');
    return p.installedVersion && p.latestVersion ? p : null;
  }, { label: 'version check' });
  assert.equal(fake.installedVersion, '1.2.3');
  assert.equal(fake.latestVersion, '9.9.9');
  assert.equal(fake.updateAvailable, true);
  const missing = (await call('GET', '/providers')).body.providers.find((x) => x.id === 'missing');
  assert.equal(missing.installedVersion, null);
  assert.equal(missing.latestVersion, null, 'unknown packages have no latest version');
  assert.equal(missing.updateAvailable, false);
});

test('a provider can be installed or updated from a visible npm session', async () => {
  const events = new Client(`${base.replace('http', 'ws')}/api/v1/events?token=${token}`);
  await events.opened;

  const { status, body } = await call('POST', '/providers/missing/install');
  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body.session.task, 'install');
  assert.equal(body.session.name, 'Install Missing Tool');
  assert.equal(body.session.provider.id, 'missing');
  const client = terminal(body.session.id);
  await client.opened;
  await waitForText(client, body.session.id, `FAKE-NPM install -g nothing@latest --registry=${process.env.AGENT_GUILD_NPM_REGISTRY}`, 'npm output');
  await waitFor(() => client.messages.find((m) => m.type === 'exit'), { label: 'npm exit' });
  const updated = await waitFor(() => events.messages.find((m) => m.type === 'providers.updated'), { label: 'providers.updated' });
  assert.ok(updated.providers.some((p) => p.id === 'missing'));
  await client.close();
  await call('DELETE', `/sessions/${body.session.id}`);

  assert.equal((await call('POST', '/providers/plain/install')).body.error.code, 'not_installable');
  assert.equal((await call('POST', '/providers/nope/install')).status, 404);

  // Updating a tool that has running sessions needs an explicit go-ahead.
  const running = await createFake();
  const refused = await call('POST', '/providers/fake/install');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'provider_in_use');
  assert.equal(refused.body.error.running, 1);
  const forced = await call('POST', '/providers/fake/install', { force: true });
  assert.equal(forced.status, 201);
  assert.equal(forced.body.session.name, 'Update Fake Tool');
  await waitFor(async () => (await call('GET', `/sessions/${forced.body.session.id}`)).body.session.status === 'exited', { label: 'update exit' });
  await call('DELETE', `/sessions/${forced.body.session.id}`);
  await call('DELETE', `/sessions/${running.id}`);
  await events.close();
});

test('an existing tool session can be resumed by id', async () => {
  const session = await createFake({ resume: ' abc-123 ' });
  assert.equal(session.resume, 'abc-123');
  const client = terminal(session.id);
  await client.opened;
  client.input('args');
  await waitForText(client, session.id, 'ARGS:["--resume","abc-123"]', 'resume args');
  await client.close();
  await call('DELETE', `/sessions/${session.id}`);

  const fresh = await createFake();
  assert.equal(fresh.resume, null);
  await call('DELETE', `/sessions/${fresh.id}`);

  assert.equal((await call('POST', '/sessions', { providerId: 'fake', resume: '' })).status, 400);
  assert.equal((await call('POST', '/sessions', { providerId: 'fake', resume: 'a\nb' })).status, 400);
  const unsupported = await call('POST', '/sessions', { providerId: 'plain', resume: 'abc' });
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.body.error.code, 'resume_unsupported');
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
  if (process.platform === 'win32') {
    // ConPTY confirms a resize by emitting CSI 8 ; rows ; cols t. (A Node
    // child inside ConPTY can keep reporting its old size, so the tool's own
    // report is not a reliable signal there.)
    await waitFor(() => client.output.includes('\x1b[8;33;101t'), { label: 'ConPTY resize' });
  } else {
    client.input('size');
    await waitForText(client, session.id, 'SIZE:101x33', 'pty size');
  }

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

test('Claude Code sub-agent hooks reach the session through agent-guild-report', async () => {
  const session = await createFake();
  const managed = ctx.manager.get(session.id);
  const reporter = path.resolve(here, '../bin/agent-guild-report.mjs');
  const env = {
    ...process.env,
    AGENT_GUILD_URL: base,
    AGENT_GUILD_SESSION_ID: session.id,
    AGENT_GUILD_REPORT_TOKEN: managed.reportToken,
  };
  const runHook = (payload) => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [reporter, '--claude-hook'], { env, timeout: 10000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}\n${stderr}`)); else resolve(stderr);
    });
    child.stdin.end(JSON.stringify(payload));
  });
  const common = { session_id: 'claude-session', cwd: home, transcript_path: '/tmp/t.jsonl' };

  assert.equal(await runHook({ ...common, hook_event_name: 'SubagentStart', agent_id: 'agent-7', agent_type: 'Explore' }), '');
  let { body } = await call('GET', `/sessions/${session.id}`);
  assert.deepEqual(body.session.agents.map((a) => [a.id, a.name, a.status]), [['claude-agent-7', 'Explore', 'working']]);

  await runHook({ ...common, hook_event_name: 'SubagentStop', agent_id: 'agent-7', agent_type: 'Explore', stop_hook_active: false });
  ({ body } = await call('GET', `/sessions/${session.id}`));
  assert.equal(body.session.agents[0].status, 'done');
  await call('DELETE', `/sessions/${session.id}`);
});

test('the model comes from arguments, the screen, or an explicit report', async () => {
  const session = await createFake({ args: ['--model', 'fake-model-1'] });
  assert.deepEqual(session.model, { name: 'fake-model-1', displayName: null, source: 'args' });
  const client = terminal(session.id);
  await client.opened;
  const modelIs = (name, source) => async () => {
    const { body } = await call('GET', `/sessions/${session.id}`);
    return body.session.model?.name === name && body.session.model.source === source ? body.session.model : null;
  };

  // Text on screen that matches the provider's modelPattern wins over the argument.
  client.input('echo now on fake-model-2.5, really');
  assert.equal((await waitFor(modelIs('fake-model-2.5', 'screen'), { label: 'screen model' })).source, 'screen');

  // A tool that keeps printing is still scanned while it prints.
  client.input('stream 3500 switching to fake-model-7');
  await waitFor(modelIs('fake-model-7', 'screen'), { timeout: 3000, label: 'model during continuous output' });
  await waitForText(client, session.id, 'STREAM-DONE', 'stream end');

  // An explicit report wins over the screen and is not replaced by later screen text.
  client.input('model fake-model-3 Three');
  const reported = await waitFor(modelIs('fake-model-3', 'report'), { label: 'reported model' });
  assert.equal(reported.displayName, 'Three');
  client.input('echo mention fake-model-4');
  await waitForText(client, session.id, 'ECHO:mention fake-model-4', 'later screen text');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal((await call('GET', `/sessions/${session.id}`)).body.session.model.name, 'fake-model-3');

  // Reports also arrive over HTTP with the session report token.
  const managed = ctx.manager.get(session.id);
  const ok = await call('POST', `/sessions/${session.id}/model`, { model: 'fake-model-5' }, { Authorization: '', 'X-Agent-Guild-Report-Token': managed.reportToken });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.model, { name: 'fake-model-5', displayName: null, source: 'report' });
  assert.equal((await call('POST', `/sessions/${session.id}/model`, { model: '' })).status, 400);
  assert.equal((await call('POST', `/sessions/${session.id}/model`, { model: 'x' }, { Authorization: '', 'X-Agent-Guild-Report-Token': 'wrong' })).status, 401);

  // Claude Code's status line feeds the model id and display name.
  const reporter = path.resolve(here, '../bin/agent-guild-report.mjs');
  const env = { ...process.env, AGENT_GUILD_URL: base, AGENT_GUILD_SESSION_ID: session.id, AGENT_GUILD_REPORT_TOKEN: managed.reportToken };
  const statusline = { model: { id: 'claude-opus-4-5', display_name: 'Opus 4.5' }, workspace: { current_dir: home }, context_window: { used_percentage: 12.4 } };
  const stdout = await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [reporter, '--claude-statusline'], { env, timeout: 10000 }, (err, out, stderr) => (err ? reject(new Error(stderr)) : resolve(out)));
    child.stdin.end(JSON.stringify(statusline));
  });
  assert.equal(stdout, `[Opus 4.5] | ${path.basename(home)} | 12% context\n`);
  assert.deepEqual((await call('GET', `/sessions/${session.id}`)).body.session.model, { name: 'claude-opus-4-5', displayName: 'Opus 4.5', source: 'report' });

  await client.close();
  await call('DELETE', `/sessions/${session.id}`);
});

test('agent-guild-report does nothing outside an Agent Guild terminal', async () => {
  const reporter = path.resolve(here, '../bin/agent-guild-report.mjs');
  const env = { ...process.env };
  delete env.AGENT_GUILD_URL; delete env.AGENT_GUILD_SESSION_ID; delete env.AGENT_GUILD_REPORT_TOKEN;
  const code = await new Promise((resolve) => {
    const child = execFile(process.execPath, [reporter, '--claude-hook'], { env }, (err) => resolve(err ? err.code : 0));
    child.stdin.end(JSON.stringify({ hook_event_name: 'SubagentStart', agent_id: 'x', agent_type: 'Plan' }));
  });
  assert.equal(code, 0);
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

test('the manager answers terminal queries exactly once, with or without clients', async () => {
  const session = await createFake();
  // Two attached clients: neither replies, and the program still gets one answer.
  const a = terminal(session.id);
  const b = terminal(session.id);
  await Promise.all([a.opened, b.opened]);
  a.input('query cpr');
  await waitForText(a, session.id, 'REPLIES:', 'cpr replies with clients');
  assert.match(stripAnsi(a.output), /REPLIES:1:/);
  await Promise.all([a.close(), b.close()]);

  // No client at all: the manager still answers.
  const managed = ctx.manager.get(session.id);
  managed.write('query cpr\r');
  await waitFor(() => (screenText(session.id).match(/REPLIES:/g) || []).length >= 2, { label: 'cpr replies without clients' });
  assert.match(screenText(session.id), /REPLIES:1:[^\n]*\n[^]*REPLIES:1:/);
  await call('DELETE', `/sessions/${session.id}`);
});

test('background colour queries get the page theme colour', async () => {
  const session = await createFake();
  const client = terminal(session.id);
  await client.opened;
  client.input('query bg');
  await waitForText(client, session.id, 'REPLIES:', 'bg replies');
  const text = stripAnsi(client.output);
  if (process.platform === 'win32') {
    // ConPTY's console host sits between the program and the manager and may
    // handle this query itself. Whatever it does, there must be no duplicate.
    assert.match(text, /REPLIES:[01]:/);
  } else {
    assert.match(text, /REPLIES:1:/);
    assert.ok(text.includes('rgb:0f0f/1111/1515'), text.slice(-200));
  }
  await client.close();
  await call('DELETE', `/sessions/${session.id}`);
});

test('snapshots restore a hidden cursor and SGR mouse reporting', async () => {
  const session = await createFake();
  const first = terminal(session.id);
  await first.opened;
  first.input('modes');
  await waitForText(first, session.id, 'MODES-SET', 'modes set');
  await first.close();
  const second = terminal(session.id);
  await second.opened;
  const snapshot = await waitFor(() => second.messages.find((m) => m.type === 'snapshot'), { label: 'snapshot' });
  assert.ok(snapshot.data.includes('\x1b[?25l'), 'cursor stays hidden');
  if (process.platform !== 'win32') assert.ok(snapshot.data.includes('\x1b[?1006h'), 'SGR mouse encoding is restored');
  await second.close();
  await call('DELETE', `/sessions/${session.id}`);
});

test('input that arrives after removal is ignored safely', async () => {
  const session = await createFake();
  const managed = ctx.manager.get(session.id);
  await call('DELETE', `/sessions/${session.id}`);
  managed.write('echo too late\r');
  managed.resize(50, 10);
  const health = await fetch(`${base}/api/v1/health`);
  assert.equal(health.status, 200);
});

test('request validation: names, body size and report authentication', async () => {
  const session = await createFake({ name: { not: 'a string' } });
  assert.equal(session.name, 'Fake Tool', 'a non-string name falls back to the tool name');
  const long = await createFake({ name: 'x'.repeat(200) });
  assert.equal(long.name.length, 80);

  assert.equal((await call('PATCH', `/sessions/${session.id}`, { name: 42 })).status, 400);
  assert.equal((await call('PATCH', `/sessions/${session.id}`, { name: '   ' })).status, 400);

  const big = await fetch(`${base}/api/v1/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: 'fake', pad: 'x'.repeat(100 * 1024) }),
  });
  assert.equal(big.status, 413);

  // Without the API token, a real and a made-up session id are indistinguishable.
  const noAuth = { Authorization: '', 'X-Agent-Guild-Report-Token': 'wrong' };
  assert.equal((await call('POST', `/sessions/${session.id}/agents`, { agentId: 'a' }, noAuth)).status, 401);
  assert.equal((await call('POST', '/sessions/000000000000/agents', { agentId: 'a' }, noAuth)).status, 401);
  assert.equal((await call('POST', '/sessions/000000000000/agents', { agentId: 'a' })).status, 404);

  assert.equal((await fetch(`${base}/%00`)).status, 404);
  await call('DELETE', `/sessions/${session.id}`);
  await call('DELETE', `/sessions/${long.id}`);
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
