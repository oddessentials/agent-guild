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
// As if the manager were started from a tmux shell; the tools must not inherit it.
process.env.TMUX = '/tmp/tmux-0/default,1,0';
process.env.TERM_PROGRAM = 'tmux';

// A stand-in npm so install sessions never touch the real global prefix. Not
// the manager's launcher folder (<home>/bin), so that folder reaches the
// session PATH only through the manager.
const bin = path.join(home, 'fake-npm');
fs.mkdirSync(bin);
if (process.platform === 'win32') {
  fs.writeFileSync(path.join(bin, 'npm.cmd'), '@echo off\r\necho FAKE-NPM %*\r\n');
} else {
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho "FAKE-NPM $*"\n', { mode: 0o755 });
}
const win = process.platform === 'win32';
const fixture = path.join(here, 'fixtures', 'fake-tool.mjs');
const runFixture = { win: `"${process.execPath}" "${fixture}" %*`, sh: `exec "${process.execPath}" "${fixture}" "$@"` };
function writeScript(file, body) {
  if (win) fs.writeFileSync(`${file}.cmd`, `@echo off\r\n${body.win}\r\n`);
  else fs.writeFileSync(file, `#!/bin/sh\n${body.sh}\n`, { mode: 0o755 });
}

const nativeDir = path.join(home, 'native-bin');
fs.mkdirSync(nativeDir);
writeScript(path.join(nativeDir, 'fake-native'), runFixture);

const npmPrefix = path.join(home, 'npm-prefix');
const npmBinDir = win ? npmPrefix : path.join(npmPrefix, 'bin');
const npmPkgDir = path.join(npmPrefix, ...(win ? [] : ['lib']), 'node_modules', 'fake-tool-pkg');
fs.mkdirSync(path.join(npmPkgDir, 'bin'), { recursive: true });
fs.mkdirSync(npmBinDir, { recursive: true });
fs.writeFileSync(path.join(npmPkgDir, 'package.json'), JSON.stringify({ name: 'fake-tool-pkg' }));
if (win) {
  writeScript(path.join(npmBinDir, 'fake-npmtool'), { win: `REM "%~dp0\\node_modules\\fake-tool-pkg\\bin\\tool.js"\r\n${runFixture.win}` });
} else {
  writeScript(path.join(npmPkgDir, 'bin', 'fake-npmtool'), runFixture);
  fs.symlinkSync(path.join(npmPkgDir, 'bin', 'fake-npmtool'), path.join(npmBinDir, 'fake-npmtool'));
}
writeScript(path.join(npmBinDir, 'npm'), {
  win: 'echo FAKE-NPM-OWNER %*\r\nif not defined FAKE_NPM_BREAKS exit /b 0\r\nif exist "%FAKE_TOOL_BREAK_FILE%" (del "%FAKE_TOOL_BREAK_FILE%") else (type nul > "%FAKE_TOOL_BREAK_FILE%")',
  sh: 'echo "FAKE-NPM-OWNER $*"\n[ -z "$FAKE_NPM_BREAKS" ] && exit 0\nif [ -e "$FAKE_TOOL_BREAK_FILE" ]; then rm -f "$FAKE_TOOL_BREAK_FILE"; else : > "$FAKE_TOOL_BREAK_FILE"; fi',
});
const breakFlag = path.join(home, 'broken.flag');
fs.writeFileSync(path.join(home, 'break-version.txt'), '9.9.9');

const secondDir = path.join(home, 'second-bin');
fs.mkdirSync(secondDir);
const secondVersion = path.join(secondDir, 'version.txt');
fs.writeFileSync(secondVersion, '0.9.0');
writeScript(path.join(secondDir, 'fake-native'), {
  win: `set "FAKE_TOOL_VERSION_FILE=${secondVersion}"\r\n${runFixture.win}`,
  sh: `FAKE_TOOL_VERSION_FILE="${secondVersion}" ${runFixture.sh}`,
});
const linkDir = path.join(home, 'links');
fs.mkdirSync(linkDir);
if (win) fs.writeFileSync(path.join(npmBinDir, 'fake-npmtool.ps1'), '& "$PSScriptRoot\\fake-npmtool.cmd" @args\r\n');
else fs.symlinkSync(path.join(npmBinDir, 'fake-npmtool'), path.join(linkDir, 'fake-npmtool'));

process.env.PATH = [bin, npmBinDir, nativeDir, secondDir, linkDir, process.env.PATH].join(path.delimiter);

const racyBuild = `racy-pkg-${process.platform}-${process.arch}`;
const registryRequests = [];
const npmRegistry = http.createServer((req, res) => {
  registryRequests.push(req.url);
  const manifests = {
    '/fake-tool-pkg/latest': { name: 'fake-tool-pkg', version: '9.9.9' },
    '/@oddessentials%2fagent-guild/latest': { name: '@oddessentials/agent-guild', version: '9.9.9' },
    '/racy-pkg/latest': { name: 'racy-pkg', version: '2.0.0', optionalDependencies: { [racyBuild]: `npm:racy-pkg@2.0.0-${process.platform}-${process.arch}` } },
  };
  const known = manifests[req.url];
  res.writeHead(known ? 200 : 404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(known || { error: 'Not found' }));
});
await new Promise((resolve) => npmRegistry.listen(0, '127.0.0.1', resolve));
process.env.AGENT_GUILD_NPM_REGISTRY = `http://127.0.0.1:${npmRegistry.address().port}`;

fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify({
  providers: [
    { id: 'fake', vendor: 'Test', tool: 'Fake Tool', command: process.execPath, args: [path.join(here, 'fixtures', 'fake-tool.mjs')], resumeArgs: ['--resume', '{id}'], package: 'fake-tool-pkg', versionArgs: [path.join(here, 'fixtures', 'fake-tool.mjs'), '--version'], modelPattern: 'fake-model-[a-z0-9.]+' },
    { id: 'plain', vendor: 'Test', tool: 'Plain Tool', command: process.execPath, args: [path.join(here, 'fixtures', 'fake-tool.mjs')], usage: { command: process.execPath, args: [path.join(here, 'fixtures', 'fake-usage.mjs')] }, history: { command: process.execPath, args: [path.join(here, 'fixtures', 'fake-history.mjs')] } },
    { id: 'missing', vendor: 'Nobody', tool: 'Missing Tool', command: 'definitely-not-installed-agent-guild', install: 'npm i -g nothing', package: 'nothing' },
    { id: 'nativetool', vendor: 'Test', tool: 'Native Tool', command: 'fake-native', package: 'fake-tool-pkg', versionArgs: ['--version'], env: { FAKE_TOOL_VERSION_FILE: path.join(home, 'native-version-1.txt') }, channels: { native: { paths: [path.join(nativeDir, 'fake-native')], update: ['update'] } } },
    { id: 'nativetool2', vendor: 'Test', tool: 'Native Tool Two', command: 'fake-native', package: 'fake-tool-pkg', versionArgs: ['--version'], env: { FAKE_TOOL_VERSION_FILE: path.join(home, 'native-version-2.txt'), FAKE_TOOL_UPDATE_TO: '2.0.0' }, channels: { native: { paths: [path.join(nativeDir, 'fake-native')], update: ['update'] } } },
    { id: 'npmtool', vendor: 'Test', tool: 'Npm Tool', command: 'fake-npmtool', package: 'fake-tool-pkg', versionArgs: ['--version'] },
    { id: 'breaktool', vendor: 'Test', tool: 'Break Tool', command: 'fake-npmtool', package: 'fake-tool-pkg', versionArgs: ['--version'], env: { FAKE_TOOL_VERSION_FILE: path.join(home, 'break-version.txt'), FAKE_TOOL_BREAK_FILE: breakFlag, FAKE_NPM_BREAKS: '1' } },
    { id: 'oddtool', vendor: 'Test', tool: 'Odd Tool', command: 'fake-native', versionArgs: ['--version'], env: { FAKE_TOOL_VERSION_TEXT: 'fake-tool nightly build' } },
    { id: 'absent', vendor: 'Nobody', tool: 'Absent Tool', command: 'definitely-not-installed-agent-guild', package: 'fake-tool-pkg' },
    { id: 'racytool', vendor: 'Nobody', tool: 'Racy Tool', command: 'definitely-not-installed-agent-guild', package: 'racy-pkg' },
    { id: 'multi', vendor: 'Test', tool: 'Multi Tool', command: process.execPath, args: [path.join(here, 'fixtures', 'fake-tool.mjs')], homeVar: 'FAKE_TOOL_HOME', hooks: { path: 'hooks/settings.json', example: 'claude-code-settings.json' }, accounts: [{ id: 'work', label: 'Work' }, { id: 'kept', dir: path.join(home, 'kept-home') }] },
    // Never read the developer's real Claude Code, Codex, Gemini or Grok sign-in or sessions during tests.
    { id: 'anthropic', usage: null, history: null },
    { id: 'openai', usage: null, history: null },
    { id: 'google', usage: null, history: null },
    { id: 'xai', history: null },
  ],
}));

const { startManager } = await import('../src/manager/main.mjs');

// The manager runs as a released version, from package files an upgrade can replace.
const packageFile = path.join(home, 'package.json');
fs.writeFileSync(packageFile, JSON.stringify({ name: '@oddessentials/agent-guild', version: '1.0.0' }));

let ctx;
let base;
let token;

before(async () => {
  ctx = await startManager({ version: '1.0.0', packageFile, sessionDefaults: { doneAgentLingerMs: 200, activityIdleMs: 200, killGraceMs: 500 } });
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

const findProvider = async (id) => (await call('GET', '/providers')).body.providers.find((p) => p.id === id);

async function runInstall(id) {
  const startedAt = Date.now();
  const started = await call('POST', `/providers/${id}/install`);
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const { session } = started.body;
  const client = terminal(session.id);
  await client.opened;
  await waitFor(() => client.messages.find((m) => m.type === 'exit'), { label: `${id} update exit` });
  const output = `${stripAnsi(client.output)}\n${screenText(session.id)}`;
  await client.close();
  await call('DELETE', `/sessions/${session.id}`);
  const provider = await waitFor(async () => {
    const p = await findProvider(id);
    return p.lastInstall?.at >= startedAt ? p : null;
  }, { label: `${id} update outcome` });
  return { session, output, provider };
}

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
  assert.equal((await fetch(`${base}/theme.js`)).status, 200);
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
});

test('the manager offers its own upgrade in a visible npm session', async () => {
  const events = new Client(`${base.replace('http', 'ws')}/api/v1/events?token=${token}`);
  await events.opened;
  const hello = await waitFor(() => events.messages.find((m) => m.type === 'hello'), { label: 'hello' });
  assert.equal(hello.upgrade.version, '1.0.0');

  const info = await waitFor(async () => {
    const { body } = await call('GET', '/info');
    return body.upgrade.latestVersion ? body.upgrade : null;
  }, { label: 'self version check' });
  assert.equal(info.latestVersion, '9.9.9');
  assert.equal(info.available, true);
  assert.ok(info.command.endsWith(`install -g @oddessentials/agent-guild@9.9.9 --registry ${process.env.AGENT_GUILD_NPM_REGISTRY}`), info.command);
  assert.equal(info.pendingVersion, null);
  assert.equal(info.lastInstall, null);

  const { status, body } = await call('POST', '/upgrade');
  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body.session.task, 'upgrade');
  assert.equal(body.session.name, 'Upgrade Agent Guild to 9.9.9');
  assert.equal(body.session.provider.id, 'agent-guild');
  const client = terminal(body.session.id);
  await client.opened;
  await waitForText(client, body.session.id, `FAKE-NPM install -g @oddessentials/agent-guild@9.9.9 --registry ${process.env.AGENT_GUILD_NPM_REGISTRY}`, 'npm output');
  await waitFor(() => client.messages.find((m) => m.type === 'exit'), { label: 'npm exit' });
  const result = await waitFor(() => events.messages.find((m) => m.type === 'manager.upgrade' && m.upgrade.lastInstall), { label: 'manager.upgrade' });
  assert.equal(result.upgrade.lastInstall.outcome, 'unchanged', 'the fake npm did not replace the package files');
  assert.equal(result.upgrade.lastInstall.exitCode, 0);
  assert.equal(result.upgrade.available, true, 'the upgrade stays on offer');
  await client.close();
  await call('DELETE', `/sessions/${body.session.id}`);

  // Once npm has replaced the files, the new version waits for a restart.
  fs.writeFileSync(packageFile, JSON.stringify({ name: '@oddessentials/agent-guild', version: '9.9.9' }));
  try {
    const pending = (await call('GET', '/info')).body.upgrade;
    assert.equal(pending.pendingVersion, '9.9.9');
    assert.equal(pending.available, false);
    const refused = await call('POST', '/upgrade');
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error.code, 'not_updatable');
    assert.match(refused.body.error.message, /restart the manager/);
  } finally {
    fs.writeFileSync(packageFile, JSON.stringify({ name: '@oddessentials/agent-guild', version: '1.0.0' }));
  }
  await events.close();
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
  const anthropic = body.providers.find((p) => p.id === 'anthropic');
  assert.match(anthropic.usageUrl, /^https:\/\//);
  assert.match(anthropic.billingUrl, /^https:\/\//);
  assert.equal(fake.usageUrl, null);
  assert.equal(fake.billingUrl, null);
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

  const { status, body } = await call('POST', '/providers/absent/install');
  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body.session.task, 'install');
  assert.equal(body.session.name, 'Install Absent Tool');
  assert.equal(body.session.provider.id, 'absent');
  const client = terminal(body.session.id);
  await client.opened;
  await waitForText(client, body.session.id, `FAKE-NPM install -g fake-tool-pkg@9.9.9 --registry ${process.env.AGENT_GUILD_NPM_REGISTRY}`, 'npm output');
  await waitFor(() => client.messages.find((m) => m.type === 'exit'), { label: 'npm exit' });
  const updated = await waitFor(() => events.messages.find((m) => m.type === 'providers.updated'), { label: 'providers.updated' });
  assert.ok(updated.providers.some((p) => p.id === 'absent'));
  await client.close();
  await call('DELETE', `/sessions/${body.session.id}`);

  assert.equal((await call('POST', '/providers/plain/install')).body.error.code, 'not_updatable');
  const unresolved = await call('POST', '/providers/missing/install');
  assert.equal(unresolved.status, 503);
  assert.equal(unresolved.body.error.code, 'release_unresolved');
  assert.equal((await call('POST', '/providers/nope/install')).status, 404);

  // Updating a tool that has running sessions needs an explicit go-ahead.
  await waitFor(async () => (await findProvider('nativetool')).updateCommand, { label: 'self-update probe' });
  const running = (await call('POST', '/sessions', { providerId: 'nativetool', cwd: home, cols: 90, rows: 20 })).body.session;
  const refused = await call('POST', '/providers/nativetool/install');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'provider_in_use');
  assert.equal(refused.body.error.running, 1);
  const forced = await call('POST', '/providers/nativetool/install', { force: true });
  assert.equal(forced.status, 201);
  assert.equal(forced.body.session.name, 'Update Native Tool (native)');
  await waitFor(async () => (await call('GET', `/sessions/${forced.body.session.id}`)).body.session.status === 'exited', { label: 'update exit' });
  await call('DELETE', `/sessions/${forced.body.session.id}`);
  await call('DELETE', `/sessions/${running.id}`);
  await events.close();
});

test('an installed tool reports the installation that owns it', async () => {
  const native = await waitFor(async () => {
    const p = await findProvider('nativetool');
    return p.updateCommand ? p : null;
  }, { label: 'self-update probe' });
  assert.equal(native.installChannel, 'native');
  assert.ok(native.resolvedPath.startsWith(nativeDir));
  assert.ok(native.updateCommand.includes(native.resolvedPath), 'the detected launcher is named by its absolute path');
  assert.ok(native.updateCommand.endsWith(' update'));

  const npmtool = await waitFor(async () => {
    const p = await findProvider('npmtool');
    return p.latestVersion ? p : null;
  }, { label: 'release lookup' });
  assert.equal(npmtool.installChannel, 'npm');
  assert.ok(npmtool.updateCommand.includes(path.join(npmBinDir, win ? 'npm.cmd' : 'npm')), 'the npm of the owning prefix');
  assert.ok(npmtool.updateCommand.includes('install -g --prefix'));
  assert.ok(npmtool.updateCommand.includes(npmPrefix));
  assert.ok(npmtool.updateCommand.includes('fake-tool-pkg@9.9.9'), 'the known release, as an exact version');

  const fake = await findProvider('fake');
  assert.equal(fake.installChannel, 'unknown');
  assert.equal(fake.updateCommand, null);
  assert.match(fake.updateGuidance, /does not recognise/);
  assert.equal((await findProvider('missing')).installChannel, null);
});

test('an update runs the updater of the owning installation and stays retryable', async () => {
  const native = await runInstall('nativetool');
  assert.equal(native.session.name, 'Update Native Tool (native)');
  assert.ok(native.output.includes('FAKE-TOOL UPDATE update'), native.output);
  assert.ok(!native.output.includes('FAKE-NPM'), 'npm is not run for a tool npm does not own');

  const unchanged = native.provider;
  assert.equal(unchanged.lastInstall.outcome, 'unchanged');
  assert.equal(unchanged.lastInstall.exitCode, 0);
  assert.equal(unchanged.installedVersion, '1.2.3');
  assert.equal(unchanged.latestVersion, '9.9.9', 'the release is still reported');
  assert.equal(unchanged.updateAvailable, true);
  assert.ok(unchanged.updateCommand, 'the update can be tried again');
  const retry = await runInstall('nativetool');
  assert.ok(retry.output.includes('FAKE-TOOL UPDATE update'), retry.output);

  const viaNpm = await runInstall('npmtool');
  assert.equal(viaNpm.session.name, 'Update Npm Tool (npm)');
  assert.ok(viaNpm.output.includes('FAKE-NPM-OWNER install -g --prefix'), viaNpm.output);
  assert.ok(!viaNpm.output.includes('FAKE-NPM install'), 'the first npm on PATH is not used');

  const unknown = await call('POST', '/providers/fake/install');
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, 'not_updatable');
});

test('the version is read again right after an update', async () => {
  const before = await waitFor(async () => {
    const p = await findProvider('nativetool2');
    return p.installedVersion && p.updateCommand ? p : null;
  }, { label: 'version check' });
  assert.equal(before.installedVersion, '1.2.3');
  const { provider: after } = await runInstall('nativetool2');
  assert.equal(after.lastInstall.outcome, 'updated');
  assert.equal(after.lastInstall.before, '1.2.3');
  assert.equal(after.installedVersion, '2.0.0');
  assert.equal(after.updateAvailable, true);
});

test('a clean npm exit that leaves the tool broken is reported and stays repairable', async () => {
  const healthy = await waitFor(async () => {
    const p = await findProvider('breaktool');
    return p.installedVersion ? p : null;
  }, { label: 'version check' });
  assert.equal(healthy.installedVersion, '9.9.9');
  assert.equal(healthy.updateAvailable, false, 'no newer release is known');
  assert.equal(healthy.versionStatus, 'ok');

  const broke = await runInstall('breaktool');
  assert.ok(broke.output.includes('FAKE-NPM-OWNER install -g --prefix'), broke.output);
  assert.equal(broke.provider.lastInstall.exitCode, 0, 'npm itself reported success');
  assert.equal(broke.provider.lastInstall.verification, 'failed');
  assert.equal(broke.provider.versionStatus, 'failed');
  assert.equal(broke.provider.installedVersion, null, 'the Node.js version in the error is not taken as the tool version');
  assert.match(broke.provider.versionError, /^Error: Missing optional dependency/);
  assert.equal(broke.provider.installChannel, 'npm');
  assert.equal(broke.provider.updateAvailable, false);
  assert.ok(broke.provider.updateCommand, 'the reinstall stays on offer with no newer release');

  const repaired = await runInstall('breaktool');
  assert.equal(repaired.provider.lastInstall.exitCode, 0);
  assert.equal(repaired.provider.lastInstall.verification, 'ok');
  assert.equal(repaired.provider.versionStatus, 'ok');
  assert.equal(repaired.provider.installedVersion, '9.9.9');

  const odd = await waitFor(async () => {
    const p = await findProvider('oddtool');
    return p.versionStatus ? p : null;
  }, { label: 'odd version check' });
  assert.equal(odd.versionStatus, 'unavailable');
  assert.equal(odd.installedVersion, null);
});

test('an unpublished platform build stops the install before anything runs', async () => {
  const before = (await call('GET', '/sessions')).body.sessions.length;
  registryRequests.length = 0;
  const refused = await call('POST', '/providers/racytool/install');
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, 'release_incomplete');
  assert.ok(refused.body.error.message.includes(`racy-pkg@2.0.0-${process.platform}-${process.arch}`));
  assert.match(refused.body.error.message, /Nothing was changed/);
  assert.deepEqual(registryRequests, ['/racy-pkg/latest', `/racy-pkg/2.0.0-${process.platform}-${process.arch}`]);
  assert.equal((await call('GET', '/sessions')).body.sessions.length, before, 'no session was started');
});

test('other copies of a tool are listed, wrappers of one copy are not', async () => {
  const native = await waitFor(async () => {
    const p = await findProvider('nativetool');
    return p.installs.length === 2 && p.installs.every((i) => i.version) ? p : null;
  }, { label: 'copy versions' });
  assert.deepEqual(native.installs.map((i) => [i.channel, i.version, i.active, i.onPath, i.newer]), [
    ['native', '1.2.3', true, true, false],
    ['unknown', '0.9.0', false, true, false],
  ]);
  assert.ok(native.installs[1].path.startsWith(secondDir));
  assert.equal(native.installs[1].removeCommand, null, 'no removal command without confirmed ownership');
  assert.equal(native.warnings.length, 1);
  assert.match(native.warnings[0], /^2 copies of Native Tool are installed\. The one in use is native v1\.2\.3 at /);

  const npmtool = await findProvider('npmtool');
  assert.equal(npmtool.installs.length, 1, 'several entry points of one installation are one installation');
  assert.equal(npmtool.installs[0].channel, 'npm');
  assert.ok(npmtool.installs[0].removeCommand.includes('uninstall -g --prefix'));
  assert.ok(npmtool.installs[0].removeCommand.includes(npmPrefix));
  assert.ok(npmtool.installs[0].removeCommand.endsWith('fake-tool-pkg'));
  assert.deepEqual(npmtool.warnings, []);
  assert.deepEqual((await findProvider('missing')).installs, []);
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

test('past sessions of a provider are listed from its history source', async () => {
  const { body: listed } = await call('GET', '/providers');
  assert.equal(listed.providers.find((p) => p.id === 'plain').historySource, 'command');
  assert.equal(listed.providers.find((p) => p.id === 'fake').historySource, null);
  assert.equal(listed.providers.find((p) => p.id === 'anthropic').historySource, null, 'built-in sources are disabled for tests');

  const { status, body } = await call('GET', '/providers/plain/history');
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.history.sessions.map((s) => s.id), ['older-1', 'newer-2']);
  assert.deepEqual([body.history.providerId, body.history.accountId, body.history.total, body.history.error], ['plain', 'default', 2, null]);
  assert.ok(Date.parse(body.history.fetchedAt));
  assert.equal((await call('GET', '/providers/plain/history?limit=1')).body.history.sessions.length, 1);
  const unsupported = await call('GET', '/providers/fake/history');
  assert.deepEqual([unsupported.status, unsupported.body.error.code], [400, 'history_unsupported']);
  assert.equal((await call('GET', '/providers/nope/history')).status, 404);
  assert.equal((await call('GET', '/providers/plain/history?account=nobody')).body.error.code, 'unknown_account');
});

test('the tool\'s own session id is reported over HTTP, in-band, and through hooks', async () => {
  const session = await createFake();
  assert.equal(session.toolSessionId, null);
  const managed = ctx.manager.get(session.id);
  const route = `/sessions/${session.id}/tool-session`;
  assert.equal((await call('POST', route, { toolSessionId: 'x' }, { Authorization: '', 'X-Agent-Guild-Report-Token': 'wrong' })).status, 401);
  const ok = await call('POST', route, { toolSessionId: ' 550e8400-e29b-41d4-a716-446655440000 ' }, { Authorization: '', 'X-Agent-Guild-Report-Token': managed.reportToken });
  assert.deepEqual([ok.status, ok.body.toolSessionId], [200, '550e8400-e29b-41d4-a716-446655440000']);
  assert.equal((await call('GET', `/sessions/${session.id}`)).body.session.toolSessionId, '550e8400-e29b-41d4-a716-446655440000');
  assert.equal((await call('POST', route, { toolSessionId: '' })).status, 400);
  assert.equal((await call('POST', route, { toolSessionId: 'a\nb' })).status, 400);

  const client = terminal(session.id);
  await client.opened;
  client.input('session in-band-1');
  await waitFor(() => ctx.manager.get(session.id).toolSessionId === 'in-band-1', { label: 'in-band tool session id' });
  client.input(`hook sh ${JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'hooked-2', source: 'startup' })}`);
  await waitForText(client, session.id, 'HOOK-EXIT:0', 'hook exit');
  await waitFor(() => ctx.manager.get(session.id).toolSessionId === 'hooked-2', { label: 'hook tool session id' });
  await client.close();
  await call('POST', `/sessions/${session.id}/stop`);
  await waitFor(async () => (await call('GET', `/sessions/${session.id}`)).body.session.status === 'exited', { label: 'exit' });
  assert.equal((await call('POST', route, { toolSessionId: 'late' })).status, 409, 'an exited session takes no reports');
  assert.equal((await call('GET', `/sessions/${session.id}`)).body.session.toolSessionId, 'hooked-2', 'the id outlives the process');
  await call('DELETE', `/sessions/${session.id}`);
});

test('session creation validates its input', async () => {
  assert.equal((await call('POST', '/sessions', { providerId: 'nope' })).status, 404);
  const missing = await call('POST', '/sessions', { providerId: 'missing' });
  assert.equal(missing.status, 409);
  assert.match(missing.body.error.message, /npm i -g nothing/);
  assert.equal((await call('POST', '/sessions', { providerId: 'fake', cwd: path.join(home, 'no-such-dir') })).status, 400);
  assert.equal((await call('POST', '/sessions', { providerId: 'fake', args: 'x' })).status, 400);
});

test('a session runs under the account picked, in that account\'s own home folder', async () => {
  const { body: listed } = await call('GET', '/providers');
  assert.deepEqual(listed.providers.find((p) => p.id === 'multi').accounts, [{ id: 'default', label: 'Default' }, { id: 'work', label: 'Work' }, { id: 'kept', label: 'Kept' }]);
  assert.deepEqual(listed.providers.find((p) => p.id === 'fake').accounts, [{ id: 'default', label: 'Default' }]);

  const workHome = path.join(home, 'accounts', 'multi', 'work');
  assert.ok(!fs.existsSync(workHome), 'nothing is created before the first session');
  const { status, body } = await call('POST', '/sessions', { providerId: 'multi', account: 'work', cwd: home, cols: 90, rows: 20 });
  assert.equal(status, 201, JSON.stringify(body));
  const work = body.session;
  assert.deepEqual(work.account, { id: 'work', label: 'Work' });
  assert.equal(work.name, 'Multi Tool · Work');
  assert.equal(fs.readFileSync(path.join(workHome, 'hooks', 'settings.json'), 'utf8'), fs.readFileSync(path.join(here, '..', 'examples', 'claude-code-settings.json'), 'utf8'), 'the reporting hooks are seeded');
  const client = terminal(work.id);
  await client.opened;
  client.input('env');
  await waitFor(() => client.output.includes('ENV:'), { label: 'env' });
  assert.ok(client.output.includes(`|home=${workHome}\r`), client.output);
  await client.close();
  await call('DELETE', `/sessions/${work.id}`);

  fs.writeFileSync(path.join(workHome, 'hooks', 'settings.json'), '{"mine":true}');
  const again = (await call('POST', '/sessions', { providerId: 'multi', account: 'work', cwd: home, name: 'Named' })).body.session;
  assert.equal(again.name, 'Named');
  assert.equal(fs.readFileSync(path.join(workHome, 'hooks', 'settings.json'), 'utf8'), '{"mine":true}', 'an existing hooks file is kept');
  await call('DELETE', `/sessions/${again.id}`);

  const kept = (await call('POST', '/sessions', { providerId: 'multi', account: 'kept', cwd: home })).body.session;
  assert.ok(fs.existsSync(path.join(home, 'kept-home', 'hooks', 'settings.json')), 'a configured dir is used as is');
  await call('DELETE', `/sessions/${kept.id}`);

  const plain = (await call('POST', '/sessions', { providerId: 'multi', cwd: home })).body.session;
  assert.deepEqual(plain.account, { id: 'default', label: 'Default' });
  assert.equal(plain.name, 'Multi Tool · Default');
  const single = await createFake();
  assert.deepEqual(single.account, { id: 'default', label: 'Default' });
  assert.equal(single.name, 'Fake Tool', 'one account leaves the name alone');
  await call('DELETE', `/sessions/${plain.id}`);
  await call('DELETE', `/sessions/${single.id}`);

  const unknown = await call('POST', '/sessions', { providerId: 'multi', account: 'nope', cwd: home });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'unknown_account');
  assert.equal((await call('POST', '/sessions', { providerId: 'multi', account: 3, cwd: home })).status, 400);
  assert.equal((await call('POST', '/sessions', { providerId: 'fake', account: 'work', cwd: home })).status, 404, 'other providers have only the default account');
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
  const { pid } = (await call('GET', `/sessions/${session.id}`)).body.session;
  assert.ok(Number.isInteger(pid) && pid > 0, `a started session reports its pid, got ${pid}`);

  client.input('env');
  await waitFor(() => client.output.includes('ENV:'), { label: 'env' });
  await waitForText(client, session.id, '|term_program=', 'env line');
  assert.ok(client.output.includes(`ENV:${session.id}|fake|${base}|${path.join(home, 'bin')}|tmux=|term_program=|home=\r`), client.output);

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
  const lingerFrom = body.session.agents[0].updatedAt;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal((await call('POST', route, { agentId: 'explore-1', status: 'done' })).body.agent.updatedAt, lingerFrom, 'a repeated done keeps the first linger');
  await waitFor(async () => (await call('GET', `/sessions/${session.id}`)).body.session.agents.length === 0, { label: 'agent removal' });

  // A stop for an agent that never started (Claude Code's internal helpers) shows nothing.
  assert.equal((await call('POST', route, { agentId: 'ghost', status: 'done' })).body.agent, null);
  assert.deepEqual((await call('GET', `/sessions/${session.id}`)).body.session.agents, []);

  // The cap counts working agents; a lingering done agent makes room.
  for (let i = 0; i < 64; i++) assert.equal((await call('POST', route, { agentId: `w${i}` })).status, 200);
  assert.equal((await call('POST', route, { agentId: 'w64' })).status, 400);
  await call('POST', route, { agentId: 'w0', status: 'done' });
  assert.equal((await call('POST', route, { agentId: 'w64' })).status, 200);
  const ids = (await call('GET', `/sessions/${session.id}`)).body.session.agents.map((a) => a.id);
  assert.ok(ids.includes('w64') && !ids.includes('w0'), ids.join(','));
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
    const child = execFile(process.execPath, [reporter, '--hook'], { env, timeout: 10000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}\n${stderr}`)); else resolve(stderr);
    });
    child.stdin.end(JSON.stringify(payload));
  });
  const common = { session_id: 'claude-session', cwd: home, transcript_path: '/tmp/t.jsonl' };

  assert.equal(await runHook({ ...common, hook_event_name: 'SubagentStart', agent_id: 'agent-7', agent_type: 'Explore' }), '');
  let { body } = await call('GET', `/sessions/${session.id}`);
  assert.deepEqual(body.session.agents.map((a) => [a.id, a.name, a.status]), [['hook-agent-7', 'Explore', 'working']]);

  await runHook({ ...common, hook_event_name: 'SubagentStop', agent_id: 'agent-7', agent_type: 'Explore', stop_hook_active: false });
  ({ body } = await call('GET', `/sessions/${session.id}`));
  assert.equal(body.session.agents[0].status, 'done');

  // Codex CLI's events carry the model too, and Grok Build spells the fields in camelCase.
  await runHook({ session_id: 'codex', cwd: home, hook_event_name: 'SessionStart', source: 'startup', model: 'gpt-5-codex' });
  ({ body } = await call('GET', `/sessions/${session.id}`));
  assert.deepEqual(body.session.model, { name: 'gpt-5-codex', displayName: null, source: 'report' });
  await runHook({ hookEventName: 'subagent_start', hook_event_name: 'SubagentStart', sessionId: 'grok', subagentId: 'sub-1', agentType: 'reviewer', modelId: 'grok-build' });
  ({ body } = await call('GET', `/sessions/${session.id}`));
  assert.ok(body.session.agents.some((a) => a.id === 'hook-sub-1' && a.name === 'reviewer' && a.status === 'working'));
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

test('a hook run through the shell finds agent-guild-report on the session PATH', async () => {
  // The tools run `agent-guild-report --hook` by name in a shell that inherits
  // the session environment; nobody ran npm link here.
  const session = await createFake();
  const client = terminal(session.id);
  await client.opened;
  client.input('env');
  await waitForText(client, session.id, `|${path.join(home, 'bin')}`, 'launcher folder first on PATH');

  const shells = process.platform === 'win32' ? ['cmd', 'powershell'] : ['sh'];
  for (const [i, shell] of shells.entries()) {
    const payload = { session_id: 'claude-session', hook_event_name: 'SubagentStart', agent_id: `via-${shell}`, agent_type: 'Explore' };
    client.input(`hook ${shell} ${JSON.stringify(payload)}`);
    await waitFor(() => (stripAnsi(client.output).match(/HOOK-EXIT:[^\r\n]*/g) || []).length > i, { timeout: 20000, label: `${shell} hook exit` });
    const line = stripAnsi(client.output).match(/HOOK-EXIT:[^\r\n]*/g)[i];
    assert.match(line, /^HOOK-EXIT:0 STDERR:""/, `${shell}: ${line}`);
    const agents = (await call('GET', `/sessions/${session.id}`)).body.session.agents;
    assert.ok(agents.some((a) => a.id === `hook-via-${shell}` && a.name === 'Explore' && a.status === 'working'), `${shell}: ${JSON.stringify(agents)}`);
  }
  await client.close();
  await call('DELETE', `/sessions/${session.id}`);
});

test('a model reported while a foreground agent works is the agent\'s, not the session\'s', async () => {
  const session = await createFake();
  const route = `/sessions/${session.id}`;
  assert.equal((await call('POST', `${route}/model`, { model: 'fake-model-main' })).body.model.name, 'fake-model-main');
  // Gemini CLI: BeforeModel fires for the sub-agent's own requests while invoke_agent runs.
  const [start] = [{ agentId: 'hook-task-1', name: 'codebase_investigator', kind: 'subagent', foreground: true }];
  assert.equal((await call('POST', `${route}/agents`, start)).body.agent.foreground, true);
  assert.equal((await call('POST', `${route}/model`, { model: 'fake-model-sub' })).body.model.name, 'fake-model-main', 'ignored while the agent works');
  await call('POST', `${route}/agents`, { agentId: 'hook-task-1', status: 'done' });
  assert.equal((await call('POST', `${route}/model`, { model: 'fake-model-next' })).body.model.name, 'fake-model-next', 'accepted once the agent is done');
  // A cancelled call never reports done; the next turn boundary closes it.
  await call('POST', `${route}/agents`, { agentId: 'hook-task-2', name: 'generalist', kind: 'subagent', foreground: true });
  assert.equal((await call('POST', `${route}/model`, { model: 'fake-model-sub' })).body.model.name, 'fake-model-next');
  assert.equal((await call('POST', `${route}/agents`, { finishForeground: true })).body.agent, null);
  assert.equal((await call('GET', route)).body.session.agents.find((a) => a.id === 'hook-task-2').status, 'done');
  assert.equal((await call('POST', `${route}/model`, { model: 'fake-model-after' })).body.model.name, 'fake-model-after', 'model reports resume after the boundary');
  // A background agent (Claude Code, Codex CLI) does not block its parent.
  await call('POST', `${route}/agents`, { agentId: 'hook-bg', name: 'Explore', kind: 'subagent' });
  assert.equal((await call('POST', `${route}/model`, { model: 'fake-model-switched' })).body.model.name, 'fake-model-switched');
  const { agents } = (await call('GET', route)).body.session;
  assert.equal(agents.find((a) => a.id === 'hook-bg').foreground, false);
  await call('DELETE', route);
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
  assert.equal(session.exitedAt, null);
  await waitFor(() => events.messages.find((m) => m.type === 'session.created' && m.session.id === session.id), { label: 'created' });

  const renamed = await call('PATCH', `/sessions/${session.id}`, { name: 'Renamed' });
  assert.equal(renamed.body.session.name, 'Renamed');

  const term = terminal(session.id);
  await term.opened;
  const beforeExit = Date.now();
  term.input('exit 3');
  const exit = await waitFor(() => term.messages.find((m) => m.type === 'exit'), { label: 'exit message' });
  assert.equal(exit.exitCode, 3);
  const updated = await waitFor(() => events.messages.find((m) => m.type === 'session.updated' && m.session.id === session.id && m.session.status === 'exited'), { label: 'exited event' });
  const exitedAt = updated.session.exitedAt;
  assert.ok(Date.parse(exitedAt) >= beforeExit && Date.parse(exitedAt) <= Date.now(), 'exit time is recorded when the process exits');
  assert.equal((await call('GET', `/sessions/${session.id}`)).body.session.exitedAt, exitedAt);
  assert.equal((await call('GET', '/sessions')).body.sessions.find((s) => s.id === session.id).exitedAt, exitedAt);

  const reconnected = new Client(`${base.replace('http', 'ws')}/api/v1/events?token=${token}`);
  await reconnected.opened;
  const hello = await waitFor(() => reconnected.messages.find((m) => m.type === 'hello'), { label: 'reconnected hello' });
  assert.equal(hello.sessions.find((s) => s.id === session.id).exitedAt, exitedAt);
  await reconnected.close();

  // Exited sessions stay listed until removed, and still replay their last screen.
  const late = terminal(session.id);
  await late.opened;
  await waitFor(() => late.messages.find((m) => m.type === 'exit'), { label: 'exit replay' });
  assert.equal(late.messages[0].type, 'snapshot');
  assert.equal(late.messages[0].session.exitedAt, exitedAt);

  assert.equal((await call('DELETE', `/sessions/${session.id}`)).status, 200);
  await waitFor(() => events.messages.find((m) => m.type === 'session.removed' && m.sessionId === session.id), { label: 'removed' });
  assert.equal(await late.closed, 4410);
  assert.equal((await call('GET', `/sessions/${session.id}`)).status, 404);
  await term.close();
  await events.close();
});

test('stop ends a running session', async () => {
  const session = await createFake();
  assert.equal(session.exitedAt, null);
  const beforeStop = Date.now();
  const { status } = await call('POST', `/sessions/${session.id}/stop`);
  assert.equal(status, 200);
  await waitFor(async () => (await call('GET', `/sessions/${session.id}`)).body.session.status === 'exited', { label: 'stopped' });
  const stopped = (await call('GET', `/sessions/${session.id}`)).body.session;
  assert.equal(stopped.pid, null, 'an exited session has no pid');
  assert.ok(Date.parse(stopped.exitedAt) >= beforeStop && Date.parse(stopped.exitedAt) <= Date.now(), 'stopping records an exit time');
  await call('DELETE', `/sessions/${session.id}`);
});

test('shutdown is refused while sessions are running unless forced', async () => {
  const session = await createFake();
  const refused = await call('POST', '/shutdown');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'sessions_running');
  assert.equal(refused.body.error.running, ctx.manager.runningCount());
  assert.ok(refused.body.error.running >= 1);
  assert.equal((await fetch(`${base}/api/v1/health`)).status, 200, 'the manager keeps running');
  assert.equal((await call('GET', `/sessions/${session.id}`)).body.session.status, 'running');
  await call('DELETE', `/sessions/${session.id}`);
});

test('model stats come from the catalog and match each session\'s model', async () => {
  const { createManagerServer } = await import('../src/manager/server.mjs');
  const { ModelStats } = await import('../src/manager/model-stats.mjs');
  const entry = (id, coding) => ({
    id,
    name: `Test: ${id}`,
    created: 1780000000,
    architecture: { output_modalities: ['text'] },
    supported_parameters: ['tools'],
    benchmarks: { artificial_analysis: { coding_index: coding } },
  });
  let fetches = 0;
  const modelStats = new ModelStats({
    registry: ctx.registry,
    fetchImpl: async () => {
      fetches++;
      return { ok: true, json: async () => ({ data: [entry('test/fake-model-1', 50), entry('test/fake-model-2', 70)] }) };
    },
  });
  const spare = createManagerServer({
    manager: ctx.manager,
    registry: ctx.registry,
    usage: { all: async () => [] },
    modelStats,
    token,
    webDir: path.join(here, '..', 'web'),
    onShutdownRequest: () => {},
  });
  await spare.listen();
  const session = await createFake({ args: ['--model', 'fake-model-1'] });
  try {
    const res = await fetch(`${spare.url}/api/v1/model-stats`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.providers.fake.models, ['test/fake-model-1', 'test/fake-model-2']);
    assert.equal(body.sessions[session.id], 'test/fake-model-1');
    assert.deepEqual([body.models['test/fake-model-1'].stats.coding.level, body.models['test/fake-model-2'].stats.coding.tier], [0, 'S']);
    assert.equal((await fetch(`${spare.url}/api/v1/model-stats`)).status, 401);
    assert.equal(fetches, 1);
  } finally {
    await call('DELETE', `/sessions/${session.id}`);
    await spare.close();
  }
});

test('the news endpoint needs the token, answers at once while it refreshes, and announces the refresh', async () => {
  const { createManagerServer } = await import('../src/manager/server.mjs');
  const { NewsFeed } = await import('../src/manager/news.mjs');
  const published = new Date(Date.now() - 3600000).toUTCString();
  const news = new NewsFeed({
    feeds: [{ id: 'test', name: 'Test News', category: 'news', url: 'https://news.test/feed' }],
    fetchImpl: async () => new Response(`<rss version="2.0"><channel><item><title>Agents ship</title><link>https://news.test/agents</link><pubDate>${published}</pubDate><description>Plain words</description></item></channel></rss>`),
  });
  const spare = createManagerServer({
    manager: ctx.manager,
    registry: ctx.registry,
    usage: { all: async () => [] },
    modelStats: { snapshot: async () => ({}) },
    news,
    token,
    webDir: path.join(here, '..', 'web'),
    onShutdownRequest: () => {},
  });
  await spare.listen();
  const events = new Client(`${spare.url.replace('http', 'ws')}/api/v1/events?token=${token}`);
  const read = async () => (await fetch(`${spare.url}/api/v1/news`, { headers: { Authorization: `Bearer ${token}` } })).json();
  try {
    await events.opened;
    assert.equal((await fetch(`${spare.url}/api/v1/news`)).status, 401);
    assert.deepEqual(await read(), {
      refreshedAt: null, refreshing: true, sources: [{ id: 'test', name: 'Test News', category: 'news', error: null, okAt: null }], items: [],
    });
    await waitFor(() => events.messages.find((m) => m.type === 'news.updated'), { label: 'news.updated' });
    const body = await read();
    assert.equal(body.refreshing, false);
    assert.deepEqual(body.items.map((i) => [i.title, i.url, i.source, i.summary]), [['Agents ship', 'https://news.test/agents', 'Test News', 'Plain words']]);
    assert.deepEqual(body.sources.map((s) => [s.name, s.error]), [['Test News', null]]);
  } finally {
    await events.close();
    await spare.close();
  }
});

test('no session can start once a shutdown has been accepted', async () => {
  // A second API server over the same manager, whose shutdown callback does
  // nothing, so the accepted request can be observed without exiting.
  const { createManagerServer } = await import('../src/manager/server.mjs');
  const spare = createManagerServer({
    manager: ctx.manager,
    registry: ctx.registry,
    usage: { all: async () => [] },
    token,
    webDir: path.join(here, '..', 'web'),
    onShutdownRequest: () => {},
  });
  await spare.listen();
  const spareCall = (method, route, body) => fetch(`${spare.url}/api/v1${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
  try {
    const accepted = await spareCall('POST', '/shutdown', { force: true });
    assert.equal(accepted.status, 202);
    assert.equal(ctx.manager.closing, true, 'the guard is set as soon as the shutdown is accepted');
    // Through either server: the guard lives in the manager.
    const { status, body } = await call('POST', '/sessions', { providerId: 'fake', cwd: home });
    assert.equal(status, 503);
    assert.equal(body.error.code, 'manager_stopping');
    assert.equal((await call('POST', '/providers/missing/install')).status, 503);
    assert.equal((await spareCall('POST', '/sessions', { providerId: 'fake', cwd: home })).status, 503);
  } finally {
    ctx.manager.closing = false;
    await spare.close();
  }
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
