import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describeCatalog, indexCatalog, parseCatalog } from '../src/manager/model-stats.mjs';
import { GitHub } from '../src/manager/github.mjs';
import { createViews } from '../src/manager/github-views.mjs';
import { arrives, doorFor, familiarPose, hallActivity, lookTarget, stage } from '../web/yard/model.mjs';
import { sessionLabel } from '../src/manager/session.mjs';

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
  assert.match(index, /<script src="\.\/theme\.js"><\/script>\n  <script src="\.\/demo-bookmark\.js"><\/script>/);
  assert.match(index, /<meta property="og:image" content="https:\/\/oddessentials\.github\.io\/agent-guild\/social\.png">/);
  assert.match(index, /<meta name="twitter:card" content="summary_large_image">/);
  const config = fs.readFileSync(path.join(out, 'demo-config.js'), 'utf8');
  assert.match(config, /1\.2\.3/);
  assert.match(config, /window\.AGENT_GUILD_DEMO_MODEL_STATS=\{"retrievedAt":"2026-10-13T00:00:00\.000Z"/);
  assert.match(config, /^window\.AGENT_GUILD_DEMO_ACTIVITY=true;$/m);
  const styles = fs.readFileSync(path.join(out, 'styles.css'), 'utf8');
  assert.doesNotMatch(styles, /url\(\s*["']?\/(?!\/)/, 'fonts and images resolve below the project path');
  assert.match(styles, /url\("\.\/fonts\/cinzel\.woff2"\)/);

  fs.appendFileSync(path.join(out, 'styles.css'), '\n.x { background: url(/brand/crest.png); }\n');
  assert.throws(() => execFileSync(process.execPath, [path.join(demo, 'check.mjs'), out], { stdio: 'pipe' }), /origin-root url\(\)/);
});

function openBookmark(search, saved = {}) {
  const storage = new Map(Object.entries(saved));
  const root = { dataset: {} };
  const context = {
    URLSearchParams,
    location: { search },
    document: { documentElement: root },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key),
      get length() { return storage.size; }, key: (i) => [...storage.keys()][i] ?? null,
    },
    matchMedia: () => ({ matches: false }),
  };
  context.window = context;
  for (const file of [path.join(repo, 'web', 'theme.js'), path.join(demo, 'demo-bookmark.js')]) {
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: path.basename(file) });
  }
  return { shown: { ...root.dataset }, saved: Object.fromEntries(storage) };
}

test('a demo bookmark opens its skin, view, theme and card art whatever the visitor saved, keeps them, and closes restored terminals and panels', () => {
  const saved = { 'agentGuild.skin': 'guild', 'agentGuild.view': 'cards', 'agentGuild.theme': 'light', 'agentGuild.art': 'on' };
  const skins = fs.readFileSync(path.join(repo, 'web', 'theme.js'), 'utf8').match(/\{ id: '[a-z]+'/g).map((m) => m.slice(7, -1));
  assert.equal(skins.length, 6);
  for (const skin of skins) for (const view of ['cards', 'yard']) for (const theme of ['light', 'dark']) {
    const opened = openBookmark(`?skin=${skin}&view=${view}&theme=${theme}`, saved);
    assert.deepEqual(opened.shown, { skin, view, theme, art: 'on' });
    assert.deepEqual(opened.saved, { 'agentGuild.skin': skin, 'agentGuild.view': view, 'agentGuild.theme': theme, 'agentGuild.art': 'on' });
  }
  assert.deepEqual(openBookmark('?view=yard', saved).shown, { skin: 'guild', view: 'yard', theme: 'light', art: 'on' });
  assert.deepEqual(openBookmark('?art=off', saved).saved, { ...saved, 'agentGuild.art': 'off' });
  assert.deepEqual(openBookmark('?skin=guild&art=on', {}).shown, { skin: 'guild', view: 'cards', theme: 'light', art: 'on' });
  const refused = openBookmark('?skin=nope&view=map&theme=sepia&art=maybe', saved);
  assert.deepEqual(refused.shown, { skin: 'guild', view: 'cards', theme: 'light', art: 'on' });
  assert.deepEqual(refused.saved, saved);
  assert.deepEqual(openBookmark('', {}).shown, { skin: 'professional', view: 'cards', theme: 'light', art: 'off' });

  const open = { ...saved, 'agentGuild.panes': '{"panes":["a11ce001"],"focused":"a11ce001"}', 'agentGuild.dock': 'notes' };
  assert.deepEqual(openBookmark('?view=yard', open).saved, { ...saved, 'agentGuild.view': 'yard' });
  assert.deepEqual(openBookmark('?view=map', open).saved, open);
  assert.deepEqual(openBookmark('', open).saved, open);
});

test('the demo runtime handles initial API calls and opens event and terminal sockets', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const runtime = fs.readFileSync(path.join(demo, 'demo-runtime.js'), 'utf8');
  const elements = [];
  const storage = new Map();
  class Response {
    constructor(body, init = {}) { this.body = body; this.status = init.status || 200; this.ok = this.status < 400; }
    async json() { return JSON.parse(this.body); }
  }
  const context = {
    Response, URL, TextEncoder, setTimeout, clearTimeout,
    location: { href: 'https://example.test/agent-guild/', pathname: '/agent-guild/' },
    fetch: () => { throw new Error('demo API escaped to the network'); },
    localStorage: { setItem: (key, value) => storage.set(key, value) },
    document: {
      body: { prepend: (node) => elements.push(node) }, head: { append: (node) => elements.push(node) },
      createElement: (tag) => ({ tag, setAttribute() {} }), querySelector: () => null,
    },
    AGENT_GUILD_DEMO_VERSION: '2.3.4',
    AGENT_GUILD_DEMO_SESSION_LABEL: sessionLabel,
  };
  context.window = context;
  vm.runInNewContext(runtime, context, { filename: 'demo-runtime.js' });

  const providers = await (await context.fetch('/api/v1/providers')).json();
  const usage = await (await context.fetch('/api/v1/usage')).json();
  assert.equal(providers.providers.length, 6);
  assert.ok(usage.usage.length >= 2);
  assert.equal(storage.get('agentGuild.token'), 'public-demo');
  assert.equal(elements[0].className, 'demo-notice');

  const events = [];
  const socket = new context.WebSocket('wss://example.test/api/v1/events?token=demo');
  socket.onmessage = ({ data }) => events.push(JSON.parse(data));
  t.mock.timers.tick(40);
  assert.equal(events[0].type, 'hello');
  assert.equal(events[0].version, '2.3.4');
  assert.ok(events[0].sessions.length >= 4);

  const terminal = [];
  const term = new context.WebSocket(`wss://example.test/api/v1/sessions/${events[0].sessions[0].id}/terminal?token=demo`);
  term.onmessage = ({ data }) => terminal.push(JSON.parse(data));
  t.mock.timers.tick(40);
  assert.equal(terminal[0].type, 'snapshot');
  assert.match(terminal[0].data, /interactive demo/i);
});

function loadDemo(globals = {}) {
  const runtime = fs.readFileSync(path.join(demo, 'demo-runtime.js'), 'utf8');
  class Response {
    constructor(body, init = {}) { this.body = body; this.status = init.status || 200; this.ok = this.status < 400; }
    async json() { return JSON.parse(this.body); }
  }
  const context = {
    Response, URL, TextEncoder, setTimeout, clearTimeout,
    location: { href: 'https://example.test/agent-guild/', pathname: '/agent-guild/' },
    fetch: () => { throw new Error('demo API escaped to the network'); },
    localStorage: { setItem() {} },
    document: { body: { prepend() {} }, head: { append() {} }, createElement: (tag) => ({ tag, setAttribute() {} }), querySelector: () => null },
    AGENT_GUILD_DEMO_VERSION: '2.3.4',
    // As the Pages config sets it: the manager's own label.
    AGENT_GUILD_DEMO_SESSION_LABEL: sessionLabel,
    ...globals,
  };
  context.window = context;
  vm.runInNewContext(runtime, context, { filename: 'demo-runtime.js' });
  const call = async (method, route, body) => {
    const res = await context.fetch(`/api/v1${route}`, { method, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { context, call };
}

test('the demo simulates multiplexer install, update, uninstall and reinstall without network access', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { call } = loadDemo();
  const get = async () => (await call('GET', '/providers')).body.providers.find((p) => p.id === 'shell').multiplexers.find((m) => m.id === 'herdr');
  for (const kind of ['install', 'update', 'uninstall', 'install']) {
    const before = await get();
    const response = await call('POST', '/providers/shell/multiplexers/herdr/' + kind, { path: before.installs[0]?.path });
    assert.equal(response.status, 201);
    assert.equal(response.body.session.task, 'install');
    assert.equal((await get()).busy, true);
    t.mock.timers.tick(1000);
    const after = await get();
    assert.equal(after.busy, false);
    assert.equal(after.available, kind !== 'uninstall');
    assert.equal(after.installable, kind === 'uninstall');
  }
});

test('the demo answers model stats as the manager would for its sample catalog and sessions', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const catalog = JSON.parse(fs.readFileSync(path.join(demo, 'models.json'), 'utf8'));
  const { providers } = JSON.parse(fs.readFileSync(path.join(repo, 'config', 'providers.default.json'), 'utf8'));
  const source = { index: indexCatalog(parseCatalog(catalog)), retrievedAt: catalog.retrievedAt, stale: false, error: null };
  const { context, call } = loadDemo({ AGENT_GUILD_DEMO_MODEL_STATS: describeCatalog(source, providers) });
  const events = [];
  const socket = new context.WebSocket('wss://example.test/api/v1/events?token=demo');
  socket.onmessage = ({ data }) => events.push(JSON.parse(data));
  t.mock.timers.tick(40);
  const { body } = await call('GET', '/model-stats');
  assert.deepEqual(body, describeCatalog(source, providers, events[0].sessions));
  for (const id of ['anthropic', 'openai', 'google', 'xai']) assert.ok(body.providers[id], `${id} has benchmarks`);
  assert.equal(Object.values(body.sessions).filter(Boolean).length, 5);

  const empty = await loadDemo().call('GET', '/model-stats');
  assert.deepEqual(Object.keys(empty.body).sort(), Object.keys(describeCatalog({ index: null, retrievedAt: null, stale: false, error: null }, [])).sort());
});

test('the demo serves each running agent session\'s last answer for Read', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { context, call } = loadDemo();
  const events = [];
  const socket = new context.WebSocket('wss://example.test/api/v1/events?token=demo');
  socket.onmessage = ({ data }) => events.push(JSON.parse(data));
  t.mock.timers.tick(40);
  const answered = events[0].sessions.filter((s) => s.reply);
  assert.ok(answered.length >= 3);
  for (const s of answered) {
    const { body } = await call('GET', `/sessions/${s.id}/reply`);
    assert.equal(body.reply.id, s.reply.id);
    assert.match(body.reply.text, /\w/);
  }
  const quiet = events[0].sessions.find((s) => !s.reply);
  assert.deepEqual((await call('GET', `/sessions/${quiet.id}/reply`)).body, { reply: null });
});

test('the demo simulates remote access through Tailscale and a custom proxy', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { context, call } = loadDemo();
  const events = [];
  const socket = new context.WebSocket('wss://example.test/api/v1/events?token=demo');
  socket.onmessage = ({ data }) => events.push(JSON.parse(data));
  t.mock.timers.tick(40);
  assert.deepEqual(events[0].remoteAccess, { available: true });

  const off = (await call('GET', '/remote-access')).body.remoteAccess;
  assert.equal(off.mode, 'off');
  assert.equal(off.url, null);
  assert.equal(off.tailscale.connected, true);
  assert.equal((await call('PUT', '/remote-access', { revision: 'old', action: 'enable' })).body.error.code, 'stale_settings');

  const enabled = await call('PUT', '/remote-access', { revision: off.revision, action: 'enable' });
  assert.equal(enabled.status, 202);
  assert.equal(enabled.body.remoteAccess.mode, 'tailscale');
  assert.match(enabled.body.remoteAccess.url, /^https:\/\/[^/]+\.ts\.net$/);
  assert.equal(enabled.body.remoteAccess.connection.ok, true);
  t.mock.timers.tick(40);
  assert.equal(events.at(-1).type, 'remote-access.updated');

  const refused = await call('PUT', '/remote-access', { revision: enabled.body.remoteAccess.revision, action: 'custom', hosts: ['a.example'], origins: [] });
  assert.equal(refused.body.error.code, 'disable_first');
  const disabled = (await call('PUT', '/remote-access', { revision: enabled.body.remoteAccess.revision, action: 'disable' })).body.remoteAccess;
  assert.equal(disabled.mode, 'off');
  const custom = (await call('PUT', '/remote-access', { revision: disabled.revision, action: 'custom', hosts: ['guild.example'], origins: ['https://guild.example'] })).body.remoteAccess;
  assert.equal(custom.mode, 'custom');
  assert.deepEqual(custom.hosts, ['guild.example']);
  assert.equal((await call('POST', '/remote-access/check')).body.remoteAccess.mode, 'custom');
});

/** The real GitHub and its views, signed in with one account, against canned GitHub answers. */
function realGitHub(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-github-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ accounts: [{ id: 7, login: 'octo', name: 'Octo', avatar: null, scopes: ['repo'], addedAt: '2026-01-01T00:00:00.000Z', ssh: { verifiedAt: null }, token: { access: 'x', expiresAt: null, refresh: null } }] }));
  const answers = {
    '/user/repos': [{ full_name: 'octo/demo', owner: { type: 'User' }, private: true, pushed_at: '2026-01-01T00:00:00Z' }],
    '/repos/octo/demo/issues': [{ number: 1, title: 'Bug', state: 'open', user: { login: 'octo' }, html_url: 'https://github.com/octo/demo/issues/1' }],
    '/repos/octo/demo/actions/runs': { workflow_runs: [{ id: 2, name: 'CI', status: 'queued' }] },
    '/repos/octo/demo': { default_branch: 'trunk' },
    '/repos/octo/demo/branches': [{ name: 'trunk', protected: true, commit: { sha: 'a'.repeat(40) } }],
    '/repos/octo/demo/pulls': [{ number: 3, title: 'Change', user: { login: 'octo' }, head: { ref: 'x' }, base: { ref: 'main' } }],
  };
  const fetchImpl = async (url, init = {}) => {
    const route = new URL(url).pathname;
    const body = init.method === 'POST' || init.method === 'PATCH' ? { number: 1, title: 'Bug', state: 'open' } : answers[route];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const github = new GitHub({ dir, registry: { env: { PATH: '' }, platform: process.platform }, fetchImpl });
  return { github, views: createViews(github) };
}

const keys = (value) => Object.keys(value).sort();

test('the demo answers GitHub in the manager\'s shapes, signed in with repositories, issues, runs and pull requests', async (t) => {
  const { github, views } = realGitHub(t);
  const { call } = loadDemo();
  const real = github.snapshot();
  const demo = (await call('GET', '/github')).body.github;
  assert.deepEqual(keys(demo), keys(real));
  assert.deepEqual(keys(demo.tools), keys(real.tools));
  assert.deepEqual(demo.scopes, real.scopes);
  assert.equal(demo.appUrl.replace(/[^/]+$/, ''), real.appUrl.replace(/[^/]+$/, ''));
  assert.equal(demo.accounts.length, 1);
  assert.deepEqual(keys(demo.accounts[0]), keys(real.accounts[0]));
  assert.deepEqual(keys(demo.accounts[0].ssh), keys(real.accounts[0].ssh));

  const all = await github.allRepos();
  const demoAll = (await call('GET', '/github/repos')).body;
  assert.deepEqual(keys(demoAll), keys(all));
  assert.ok(demoAll.repos.length >= 3);
  for (const repo of demoAll.repos) assert.deepEqual(keys(repo), keys(all.repos[0]), repo.fullName);
  const account = demoAll.repos[0].accountId;

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-parent-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const listed = await github.repos(7, { parent });
  const demoListed = (await call('GET', `/github/accounts/${account}/repos?parent=%2Fwork`)).body.repos;
  assert.deepEqual(keys(demoListed), keys(listed));
  for (const repo of demoListed.repos) assert.deepEqual(keys(repo), keys(listed.repos[0]), repo.fullName);

  const origin = (await call('GET', '/github/origin?cwd=%2Fwork%2Fstorefront')).body;
  assert.deepEqual(origin, { folder: '/work/storefront', repo: 'acme/storefront' });
  const sessions = await new Promise((resolve) => {
    const { context } = loadDemo();
    const socket = new context.WebSocket('wss://example.test/api/v1/events');
    socket.onmessage = ({ data }) => resolve(JSON.parse(data).sessions);
  });
  for (const s of sessions.filter((item) => item.provider.id !== 'shell')) {
    assert.ok((await call('GET', `/github/origin?cwd=${encodeURIComponent(s.cwd)}`)).body.repo, `${s.name} sits in a demo repository`);
  }

  const base = `/github/accounts/${account}/repos/acme/storefront`;
  const pairs = [
    [await views.branches(7, 'octo', 'demo'), (await call('GET', `${base}/branches`)).body, 'branches'],
    [await views.issues(7, 'octo', 'demo'), (await call('GET', `${base}/issues`)).body, 'issues'],
    [await views.actions(7, 'octo', 'demo'), (await call('GET', `${base}/actions`)).body, 'runs'],
    [await views.pulls(7, 'octo', 'demo'), (await call('GET', `${base}/pulls`)).body, 'pulls'],
  ];
  for (const [expected, answered, list] of pairs) {
    assert.deepEqual(keys(answered), keys(expected), list);
    assert.ok(answered[list].length > 0, list);
    for (const item of answered[list]) assert.deepEqual(keys(item), keys(expected[list][0]), `${list} ${item.number ?? item.id}`);
  }
  assert.equal((await call('GET', `${base}/actions`)).body.running, true, 'a run is going, so the panel shows it');

  const madeReal = await views.createIssue(7, 'octo', 'demo', { title: 'x' });
  const made = await call('POST', `${base}/issues`, { title: '  From the demo  ', body: 'Hi' });
  assert.equal(made.status, 201);
  assert.deepEqual(keys(made.body.issue), keys(madeReal));
  assert.equal(made.body.issue.title, 'From the demo');
  const closed = await call('PATCH', `${base}/issues/${made.body.issue.number}`, { state: 'closed' });
  assert.equal(closed.body.issue.state, 'closed');
  assert.ok((await call('GET', `${base}/issues?state=closed`)).body.issues.some((i) => i.number === made.body.issue.number));
  assert.equal((await call('POST', `${base}/issues`, { title: ' ' })).body.error.code, 'bad_title');
  assert.equal((await call('GET', `/github/accounts/${account}/repos/acme/missing/pulls`)).status, 404);
  assert.equal((await call('POST', '/github/clone', { account, repo: 'acme/storefront', parent: '/work' })).body.error.code, 'demo_only');
});

test('demo issue validation preserves omitted fields and refuses oversized writes atomically', async () => {
  const { call } = loadDemo();
  const base = '/github/accounts/1001/repos/acme/storefront/issues';
  const content = '漢字 👋\r\n"quoted"\\path';
  const made = (await call('POST', base, { title: 'x'.repeat(256), body: content })).body.issue;
  const target = `${base}/${made.number}`;
  assert.equal((await call('PATCH', target, { title: 'Renamed' })).body.issue.body, content);
  for (const state of ['closed', 'open']) assert.equal((await call('PATCH', target, { state })).body.issue.body, content);
  for (const method of ['POST', 'PATCH']) {
    const route = method === 'POST' ? base : target;
    for (const [body, code] of [
      [{ title: 'x'.repeat(257), state: 'closed' }, 'bad_title'],
      [{ title: 'x', body: 'x'.repeat(48001), state: 'closed' }, 'bad_body'],
      [{ title: 'x', body: 42 }, 'bad_body'],
      [{ title: 'x', body: '漢'.repeat(24000) }, 'too_large'],
      [{ title: 'x', body: '\\'.repeat(40000) }, 'too_large'],
    ]) assert.equal((await call(method, route, body)).body.error.code, code);
  }
  const kept = (await call('GET', base)).body.issues.find((i) => i.number === made.number);
  assert.deepEqual([kept.title, kept.body, kept.state], ['Renamed', content, 'open']);
  assert.equal((await call('PATCH', target, {})).body.error.code, 'bad_request');
  assert.equal((await call('PATCH', target, { body: 'x'.repeat(48000) })).body.issue.body.length, 48000);
  assert.equal((await call('PATCH', target, { body: '' })).body.issue.body, '');
  assert.equal((await call('PATCH', target, { body: null })).body.issue.body, '');
});

test('demo events arrive after the request that caused them returns', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { context, call } = loadDemo();
  const events = [];
  const socket = new context.WebSocket('wss://example.test/api/v1/events');
  socket.onmessage = ({ data }) => events.push(JSON.parse(data).type);
  t.mock.timers.tick(40);
  events.length = 0;
  const made = await call('POST', '/sessions', { providerId: 'shell', cwd: '/work/demo' });
  assert.equal(made.status, 201);
  assert.deepEqual(events, [], 'a handler that throws cannot fail the request');
  t.mock.timers.tick(0);
  assert.deepEqual(events, ['session.created']);
});

test('the demo lists removable copies and simulates uninstalling one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
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
  assert.equal(busy.body.error.running, 2);
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
  t.mock.timers.tick(1600);
  assert.match(terminal[0].data, /Removed \/Users\/demo\/\.grok\/bin/);
  const updated = events.find((e) => e.type === 'providers.updated').providers.find((p) => p.id === 'xai');
  assert.deepEqual(updated.installs, []);
  assert.equal(updated.available, false);
  assert.equal(updated.lastInstall.outcome, 'removed');
  assert.equal(events.find((e) => e.type === 'session.updated').session.status, 'exited');

  const forced = await call('POST', '/providers/anthropic/uninstall', { path: claude.installs[0].path, force: true });
  assert.equal(forced.status, 201);
  t.mock.timers.tick(1600);
  const left = (await call('GET', '/providers')).body.providers.find((p) => p.id === 'anthropic');
  assert.equal(left.installs.length, 1);
  assert.ok(left.installs[0].active, 'the remaining copy is the one in use');
  assert.deepEqual(left.warnings, []);
});

test('the demo serves health, sign-in launch and shared notes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { context, call } = loadDemo();
  const health = await call('GET', '/health');
  assert.equal(health.status, 200);
  assert.deepEqual({ ok: health.body.ok, name: health.body.name }, { ok: true, name: 'agent-guild' });

  const off = (await call('GET', '/autostart')).body.autostart;
  assert.equal(off.available, true);
  assert.equal(off.enabled, false);
  assert.equal(off.lastRun, null);
  const on = (await call('PUT', '/autostart', { enabled: true })).body.autostart;
  assert.equal(on.enabled, true);
  assert.equal(on.lastRun.outcome, 'started');
  assert.equal((await call('GET', '/autostart')).body.autostart.enabled, true);
  assert.equal((await call('PUT', '/autostart', { enabled: false })).body.autostart.enabled, false);

  const events = [];
  const socket = new context.WebSocket('wss://example.test/api/v1/events');
  socket.onmessage = ({ data }) => events.push(JSON.parse(data));
  t.mock.timers.tick(40);
  const notes = (await call('GET', '/notes')).body.notes;
  assert.equal(typeof notes.text, 'string');
  assert.equal(notes.text.length > 0, true);
  assert.equal(events[0].notesRevision, notes.revision);
  events.length = 0;
  const saved = await call('PUT', '/notes', { revision: notes.revision, text: 'Hello from the demo' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.notes.text, 'Hello from the demo');
  const stale = await call('PUT', '/notes', { revision: notes.revision, text: 'too late' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'stale_notes');
  assert.equal(stale.body.error.notes.text, 'Hello from the demo');
  assert.equal((await call('GET', '/notes')).body.notes.text, 'Hello from the demo');
  t.mock.timers.tick(0);
  assert.equal(events.some((event) => event.type === 'notes.updated' && event.notes.text === 'Hello from the demo'), true);
});

test('the demo changelog, news and history match the shapes the page reads', async () => {
  const { call } = loadDemo();
  const changelog = (await call('GET', '/changelog')).body;
  assert.deepEqual(changelog.releases.map((release) => release.version),
    ['0.38.1', '0.38.0', '0.37.0', '0.36.0', '0.35.0', '0.34.0', '0.33.2', '0.33.1', '0.33.0', '0.32.0']);
  assert.deepEqual(changelog.releases[0].sections, [{ title: 'Bug Fixes', changes: [[
    { text: 'show the Explorer window and keep front crews visible (' },
    { text: '#150', url: 'https://github.com/oddessentials/agent-guild/issues/150' },
    { text: ', ' },
    { text: '#151', url: 'https://github.com/oddessentials/agent-guild/issues/151' },
    { text: ') (' },
    { text: '#152', url: 'https://github.com/oddessentials/agent-guild/issues/152' },
    { text: ')' },
  ]] }]);

  const news = (await call('GET', '/news')).body;
  assert.equal(typeof news.refreshedAt, 'string');
  for (const category of ['news', 'releases', 'research']) {
    assert.equal(news.items.some((item) => item.category === category), true, category);
  }

  const history = (await call('GET', '/providers/anthropic/history?account=work')).body.history;
  assert.equal(history.accountId, 'work');
  assert.equal(history.total, history.sessions.length);
  assert.ok(history.sessions.length >= 2);
  for (const row of history.sessions) {
    assert.deepEqual(Object.keys(row).sort(), ['cwd', 'id', 'startedAt', 'title', 'updatedAt']);
  }
  assert.equal((await call('GET', '/providers/shell/history')).body.error.code, 'history_unsupported');
});

test('the demo can reattach tmux, update Grok and stop while sessions are running', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { context, call } = loadDemo();
  const reattached = await call('POST', '/sessions/7e110005/reattach');
  assert.equal(reattached.status, 200);
  assert.equal(reattached.body.session.status, 'running');
  assert.equal(reattached.body.session.multiplexer.reattachable, true);

  const grok = (await call('GET', '/providers')).body.providers.find((p) => p.id === 'xai');
  assert.equal(grok.installedVersion, '0.1.40');
  assert.equal(grok.latestVersion, '0.1.42');
  assert.equal(grok.updateAvailable, true);
  assert.equal(grok.cloudUrl, 'https://grok.com/');
  const updated = await call('POST', '/providers/xai/install', {});
  assert.equal(updated.status, 201);
  assert.match(updated.body.session.name, /^Update Grok Build/);
  t.mock.timers.tick(1200);
  const after = (await call('GET', '/providers')).body.providers.find((p) => p.id === 'xai');
  assert.equal(after.installedVersion, '0.1.42');
  assert.equal(after.updateAvailable, false);

  const reporting = await call('POST', '/providers/google/reporting', { enabled: false });
  assert.equal(reporting.body.provider.reportingEnabled, false);
  assert.equal((await call('POST', '/providers/anthropic/reporting', { enabled: true })).body.error.code, 'not_applicable');

  const denied = await call('POST', '/shutdown', {});
  assert.equal(denied.status, 409);
  assert.equal(denied.body.error.code, 'sessions_running');
  assert.equal(typeof denied.body.error.running, 'number');
  assert.ok(denied.body.error.running > 0);

  const events = [];
  const socket = new context.WebSocket('wss://example.test/api/v1/events');
  socket.onmessage = ({ data }) => events.push(JSON.parse(data));
  t.mock.timers.tick(40);
  events.length = 0;
  const stopped = await call('POST', '/shutdown', { force: true });
  assert.equal(stopped.status, 202);
  assert.equal(stopped.body.restart, false);
  t.mock.timers.tick(0);
  assert.equal(events.some((event) => event.type === 'manager.stopped' && event.remaining === 0), true);
});

test('the demo Yard plays every staging mode, glance, hall level and helper pose, and new sessions arrive from their door', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-14T12:00:00Z') });
  const { context, call } = loadDemo({ Date, AGENT_GUILD_DEMO_ACTIVITY: true });
  const providers = (await call('GET', '/providers')).body.providers;
  const sessions = new Map();
  const socket = new context.WebSocket('wss://example.test/api/v1/events');
  socket.onmessage = ({ data }) => {
    const event = JSON.parse(data);
    if (event.type === 'hello') for (const s of event.sessions) sessions.set(s.id, s);
    if (event.type === 'session.created' || event.type === 'session.updated') sessions.set(event.session.id, event.session);
  };
  t.mock.timers.tick(40);
  const all = [...sessions.values()];
  assert.deepEqual(new Set(all.flatMap((s) => s.agents.map(familiarPose))), new Set(['working', 'waiting', 'idle', 'done']));
  assert.deepEqual(new Set(all.flatMap((s) => s.shells.map((shell) => shell.kind || 'shell'))), new Set(['shell', 'monitor']));

  const seen = new Set(), worked = new Set(), rested = new Set();
  let staged = null;
  for (let step = 0; step < 240; step++) {
    staged = stage([...sessions.values()], providers, Date.now(), staged);
    for (const [id, place] of staged.places) {
      seen.add(place.mode);
      if (place.mode === 'work') worked.add(id);
      if (place.mode === 'rest') rested.add(id);
      if (lookTarget(id, staged.places)) seen.add('glance:' + place.mode);
    }
    for (const p of providers) seen.add('hall:' + hallActivity([...sessions.values()], p.id));
    t.mock.timers.tick(500);
  }
  for (const want of ['work', 'pause', 'rest', 'done', 'glance:pause', 'glance:rest', 'hall:off', 'hall:low', 'hall:high']) assert.ok(seen.has(want), want);
  const running = all.filter((s) => s.status === 'running').map((s) => s.id);
  assert.deepEqual([...worked].filter((id) => running.includes(id)).sort(), running.sort());
  assert.deepEqual([...rested].filter((id) => running.includes(id)).sort(), running.sort());

  const made = (await call('POST', '/sessions', { providerId: 'xai', cwd: '/work/storefront' })).body.session;
  assert.equal(arrives(made, Date.now()), true);
  assert.notDeepEqual(doorFor(made, providers), { x: 0, z: 0 });

  socket.close();
  const before = JSON.stringify([...sessions.values()]);
  t.mock.timers.tick(60000);
  assert.equal(JSON.stringify([...sessions.values()]), before, 'the demo stops simulating output once no page listens');
});

test('the built demo labels its sessions with the manager\'s own code, as they change', async (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-pages-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  execFileSync(process.execPath, [path.join(demo, 'build.mjs'), '--out', out, '--version', '1.2.3']);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { context, call } = loadDemo({ AGENT_GUILD_DEMO_SESSION_LABEL: undefined });
  vm.runInNewContext(fs.readFileSync(path.join(out, 'demo-config.js'), 'utf8'), context, { filename: 'demo-config.js' });
  const events = [];
  const socket = new context.WebSocket('wss://example.test/api/v1/events');
  socket.onmessage = ({ data }) => events.push(JSON.parse(data));
  t.mock.timers.tick(40);
  const { sessions } = events[0];
  assert.ok(sessions.length >= 4);
  for (const s of sessions) assert.equal(s.label, sessionLabel(s), s.name);
  const running = sessions.find((s) => s.status === 'running' && s.task === null);
  const stopped = await call('POST', `/sessions/${running.id}/stop`);
  t.mock.timers.tick(1);
  assert.equal(stopped.body.session.label, 'Exited');
  assert.equal(events.at(-1).session.label, 'Exited');
});

test('without the Pages config, demo sessions keep their state', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-14T12:00:00Z') });
  const { context } = loadDemo({ Date });
  const events = [];
  const socket = new context.WebSocket('wss://example.test/api/v1/events');
  socket.onmessage = ({ data }) => events.push(JSON.parse(data));
  t.mock.timers.tick(40);
  t.mock.timers.tick(600000);
  assert.deepEqual(events.map((event) => event.type), ['hello']);
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
