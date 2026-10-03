import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describeCatalog } from '../src/manager/model-stats.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demo = path.join(repo, 'docs', 'demo');

test('the Pages builder makes a portable, complete site without changing web/', (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-pages-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const before = fs.readFileSync(path.join(repo, 'web', 'index.html'));
  execFileSync(process.execPath, [path.join(demo, 'build.mjs'), '--out', out, '--version', '1.2.3']);
  execFileSync(process.execPath, [path.join(demo, 'check.mjs'), out]);
  assert.deepEqual(fs.readFileSync(path.join(repo, 'web', 'index.html')), before);
  const index = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.doesNotMatch(index, /\b(?:src|href)=["']\//);
  assert.ok(index.indexOf('./demo-runtime.js') < index.indexOf('./app.js'));
  assert.match(fs.readFileSync(path.join(out, 'demo-config.js'), 'utf8'), /1\.2\.3/);
  const styles = fs.readFileSync(path.join(out, 'styles.css'), 'utf8');
  assert.doesNotMatch(styles, /url\(\s*["']?\/(?!\/)/, 'fonts and images resolve below the project path');
  assert.match(styles, /url\("\.\/fonts\/cinzel\.woff2"\)/);

  fs.appendFileSync(path.join(out, 'styles.css'), '\n.x { background: url(/brand/crest.png); }\n');
  assert.throws(() => execFileSync(process.execPath, [path.join(demo, 'check.mjs'), out], { stdio: 'pipe' }), /origin-root url\(\)/);
});

test('the demo runtime handles initial API calls and opens event and terminal sockets', async () => {
  const runtime = fs.readFileSync(path.join(demo, 'demo-runtime.js'), 'utf8');
  const elements = [];
  const storage = new Map();
  class Response {
    constructor(body, init = {}) { this.body = body; this.status = init.status || 200; this.ok = this.status < 400; }
    async json() { return JSON.parse(this.body); }
  }
  const context = {
    Response, URL, setTimeout, clearTimeout,
    location: { href: 'https://example.test/agent-guild/', pathname: '/agent-guild/' },
    fetch: () => { throw new Error('demo API escaped to the network'); },
    localStorage: { setItem: (key, value) => storage.set(key, value) },
    document: {
      body: { prepend: (node) => elements.push(node) }, head: { append: (node) => elements.push(node) },
      createElement: (tag) => ({ tag, setAttribute() {} }),
    },
    AGENT_GUILD_DEMO_VERSION: '2.3.4',
  };
  context.window = context;
  vm.runInNewContext(runtime, context, { filename: 'demo-runtime.js' });

  const providers = await (await context.fetch('/api/v1/providers')).json();
  const usage = await (await context.fetch('/api/v1/usage')).json();
  assert.equal(providers.providers.length, 5);
  assert.ok(usage.usage.length >= 2);
  assert.equal(storage.get('agentGuild.token'), 'public-demo');
  assert.equal(elements[0].className, 'demo-notice');

  const events = [];
  const socket = new context.WebSocket('wss://example.test/api/v1/events?token=demo');
  socket.onmessage = ({ data }) => events.push(JSON.parse(data));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(events[0].type, 'hello');
  assert.equal(events[0].version, '2.3.4');
  assert.ok(events[0].sessions.length >= 4);

  const terminal = [];
  const term = new context.WebSocket(`wss://example.test/api/v1/sessions/${events[0].sessions[0].id}/terminal?token=demo`);
  term.onmessage = ({ data }) => terminal.push(JSON.parse(data));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(terminal[0].type, 'snapshot');
  assert.match(terminal[0].data, /interactive demo/i);
});

function loadDemo() {
  const runtime = fs.readFileSync(path.join(demo, 'demo-runtime.js'), 'utf8');
  class Response {
    constructor(body, init = {}) { this.body = body; this.status = init.status || 200; this.ok = this.status < 400; }
    async json() { return JSON.parse(this.body); }
  }
  const context = {
    Response, URL, setTimeout, clearTimeout,
    location: { href: 'https://example.test/agent-guild/', pathname: '/agent-guild/' },
    fetch: () => { throw new Error('demo API escaped to the network'); },
    localStorage: { setItem() {} },
    document: { body: { prepend() {} }, head: { append() {} }, createElement: (tag) => ({ tag, setAttribute() {} }) },
  };
  context.window = context;
  vm.runInNewContext(runtime, context, { filename: 'demo-runtime.js' });
  const call = async (method, route, body) => {
    const res = await context.fetch(`/api/v1${route}`, { method, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { context, call };
}

test('the demo answers model stats in the manager\'s shape', async () => {
  const { call } = loadDemo();
  const { body } = await call('GET', '/model-stats');
  const real = describeCatalog({ index: null, retrievedAt: null, stale: false, error: null }, []);
  assert.deepEqual(Object.keys(body).sort(), Object.keys(real).sort());
  assert.deepEqual(body.sessions, {});
});

test('demo events arrive after the request that caused them returns', async () => {
  const { context, call } = loadDemo();
  const events = [];
  const socket = new context.WebSocket('wss://example.test/api/v1/events');
  socket.onmessage = ({ data }) => events.push(JSON.parse(data).type);
  await new Promise((resolve) => setTimeout(resolve, 40));
  events.length = 0;
  const made = await call('POST', '/sessions', { providerId: 'shell', cwd: '/work/demo' });
  assert.equal(made.status, 201);
  assert.deepEqual(events, [], 'a handler that throws cannot fail the request');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ['session.created']);
});

test('the demo lists removable copies and simulates uninstalling one', async () => {
  const { context, call } = loadDemo();
  const { providers } = (await call('GET', '/providers')).body;
  for (const p of providers.filter((item) => item.id !== 'shell')) {
    assert.ok(p.installs.length > 0 && p.installs.every((i) => i.uninstall && i.displayPath), `${p.id} shows an Uninstall button`);
  }
  const claude = providers.find((p) => p.id === 'anthropic');
  assert.equal(claude.installs.length, 2);
  assert.equal(claude.warnings.length, 1);

  const busy = await call('POST', '/providers/anthropic/uninstall', { path: claude.installs[1].path });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error.code, 'provider_in_use');
  assert.equal(busy.body.error.running, 1);
  assert.equal((await call('POST', '/providers/xai/uninstall', { path: '/nowhere' })).body.error.code, 'unknown_copy');

  const events = [];
  const socket = new context.WebSocket('wss://example.test/api/v1/events');
  socket.onmessage = ({ data }) => events.push(JSON.parse(data));
  const grok = providers.find((p) => p.id === 'xai');
  const started = await call('POST', '/providers/xai/uninstall', { path: grok.installs[0].path });
  assert.equal(started.status, 201);
  assert.equal(started.body.session.task, 'install');
  assert.equal(started.body.session.name, 'Uninstall Grok Build (native)');
  assert.equal((await call('POST', '/providers/xai/uninstall', { path: grok.installs[0].path })).body.error.code, 'install_in_progress');

  const terminal = [];
  const term = new context.WebSocket(`wss://example.test/api/v1/sessions/${started.body.session.id}/terminal`);
  term.onmessage = ({ data }) => terminal.push(JSON.parse(data));
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.match(terminal[0].data, /Removed \/Users\/demo\/\.grok\/bin/);
  const updated = events.find((e) => e.type === 'providers.updated').providers.find((p) => p.id === 'xai');
  assert.deepEqual(updated.installs, []);
  assert.equal(updated.available, false);
  assert.equal(updated.lastInstall.outcome, 'removed');
  assert.equal(events.find((e) => e.type === 'session.updated').session.status, 'exited');

  const forced = await call('POST', '/providers/anthropic/uninstall', { path: claude.installs[0].path, force: true });
  assert.equal(forced.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 1600));
  const left = (await call('GET', '/providers')).body.providers.find((p) => p.id === 'anthropic');
  assert.equal(left.installs.length, 1);
  assert.ok(left.installs[0].active, 'the remaining copy is the one in use');
  assert.deepEqual(left.warnings, []);
});

test('the release workflow gates Pages on the release and grants deployment-only permissions', () => {
  const workflow = fs.readFileSync(path.join(repo, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(workflow, /pages-build:[\s\S]*needs: \[plan, release\]/);
  assert.match(workflow, /pages-deploy:[\s\S]*pages: write[\s\S]*id-token: write/);
  assert.match(workflow, /environment:[\s\S]*name: github-pages/);
  assert.match(workflow, /--source "\$RUNNER_TEMP\/released\/package\/web"/);
});

test('every workflow action is pinned to a commit', () => {
  const folder = path.join(repo, '.github', 'workflows');
  for (const name of fs.readdirSync(folder)) {
    const uses = [...fs.readFileSync(path.join(folder, name), 'utf8').matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    for (const action of uses.filter((u) => !u.startsWith('./'))) {
      assert.match(action, /@[0-9a-f]{40}$/, `${name}: ${action}`);
    }
  }
});
