import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

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

test('the release workflow gates Pages on the release and grants deployment-only permissions', () => {
  const workflow = fs.readFileSync(path.join(repo, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(workflow, /pages-build:[\s\S]*needs: \[plan, release\]/);
  assert.match(workflow, /pages-deploy:[\s\S]*pages: write[\s\S]*id-token: write/);
  assert.match(workflow, /environment:[\s\S]*name: github-pages/);
  assert.match(workflow, /--source "\$RUNNER_TEMP\/released\/package\/web"/);
});
