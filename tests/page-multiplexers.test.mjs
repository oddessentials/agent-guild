import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const functions = ['renderCopies', 'renderMultiplexers', 'manageMultiplexer', 'reloadProviders', 'setProviders', 'installNote'].map((name) => {
  const found = app.match(new RegExp('(?:async )?function ' + name + '\\([^]*?\\n\\}'))?.[0];
  assert.ok(found);
  return found;
}).join('\n');

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.className = ''; this.classList = { toggle() {} }; this.attributes = {}; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, fn) { this[type] = fn; }
  querySelector(selector) { return this.findAll((node) => selector[0] === '.' ? node.className.split(' ').includes(selector.slice(1)) : node.tag === selector)[0]; }
  findAll(predicate) {
    return this.children.flatMap((node) => node instanceof Element ? [...(predicate(node) ? [node] : []), ...node.findAll(predicate)] : []);
  }
}

function page(tools, respond = null) {
  const card = new Element('article');
  const host = new Element('details'); host.className = 'multiplexers';
  const list = new Element('div'); list.className = 'multiplexer-list';
  const refresh = new Element('button'); refresh.className = 'btn multiplexer-refresh';
  host.append(new Element('summary'), refresh, list); card.append(host);
  const provider = { id: 'shell', multiplexers: tools };
  const requests = [], confirmations = [], errors = [], opened = [];
  const context = {
    document: { createElement: (tag) => new Element(tag) },
    CHANNEL_LABELS: { native: 'native', brew: 'Homebrew' }, state: { providers: [provider], providersRevision: 'r1', providersEvents: 0 },
    confirm: (message) => { confirmations.push(message); return true; },
    api: async (method, route, body) => {
      if (method === 'GET') return { providers: [provider] };
      requests.push({ method, route, body: JSON.parse(JSON.stringify(body)) });
      if (route === '/providers/reload') return { providers: [provider] };
      return respond ? respond(body) : { session: { id: 'operation' } };
    },
    upsertSession() {}, openPanel: (id) => opened.push(id), renderProviders() {}, renderAccountsDialog() {},
    toast: (message) => errors.push(message), AuthError: class extends Error {}, showAuth() {},
  };
  vm.runInNewContext('const openCopies = new Set(); const openMultiplexers = new Set();\n' + functions, context);
  return { context, card, host, provider, requests, confirmations, errors, opened, render: () => context.renderMultiplexers(card, provider) };
}

const copy = () => ({
  path: '/home/me/.local/bin/herdr', displayPath: '~/.local/bin/herdr', channel: 'native',
  version: '0.9.2', versionStatus: 'ok', active: true, onPath: true,
  updateAvailable: true, updateCommand: '/home/me/.local/bin/herdr update',
  uninstall: { command: null, remove: ['~/.local/bin/herdr'], pathEntries: true },
});

test('the multiplexer panel shows missing tools, guidance and pending cards, and preserves expansion', () => {
  const p = page([
    { id: 'tmux', tool: 'tmux', installable: false, installs: [], guidance: 'Not supported on Windows.' },
    { id: 'herdr', tool: 'herdr', installable: true, installCommand: 'install herdr', installs: [], pendingCards: 2 },
  ]);
  p.render();
  assert.equal(p.host.hidden, false);
  assert.equal(p.card.findAll((n) => n.tag === 'button' && !n.className.includes('multiplexer-refresh')).length, 1);
  assert.match(p.card.findAll((n) => n.className === 'multiplexer-note')[1].textContent, /2 detached herdr/);
  assert.match(p.card.findAll((n) => n.className === 'multiplexer-note')[1].textContent, /remove finished cards, then Refresh/);
  p.host.open = true; p.host.toggle();
  p.render();
  assert.equal(p.host.open, true);
  p.provider.multiplexers = [];
  p.render();
  assert.equal(p.host.hidden, true);
});

test('herdr Update sends the selected copy without asking to stop existing sessions', async () => {
  const tool = { id: 'herdr', tool: 'herdr', installs: [copy()] };
  const p = page([tool]);
  p.render();
  const update = p.card.findAll((n) => n.className === 'btn copy-update')[0];
  await update.click();
  assert.deepEqual(p.requests, [{ method: 'POST', route: '/providers/shell/multiplexers/herdr/update', body: { path: copy().path, force: false } }]);
  assert.equal(p.confirmations.length, 0);
  assert.deepEqual(p.opened, ['operation']);
  tool.busy = true;
  p.render();
  assert.ok(p.card.findAll((n) => n.tag === 'button' && !n.className.includes('multiplexer-refresh')).every((n) => n.disabled));
});

test('Uninstall describes owned paths; an unknown herdr status is surfaced without a force retry', async () => {
  const tool = { id: 'herdr', tool: 'herdr', installs: [copy()] };
  const p = page([tool], () => { throw Object.assign(new Error('Cannot determine server status.'), { code: 'herdr_status_unknown' }); });
  p.render();
  await p.card.findAll((n) => n.className === 'btn danger copy-uninstall')[0].click();
  assert.match(p.confirmations[0], /~\/.local\/bin\/herdr/);
  assert.match(p.confirmations[0], /user PATH/);
  assert.equal(p.requests.length, 1);
  assert.deepEqual(p.errors, ['Cannot determine server status.']);
});

test('tmux dependency conflicts retry with force only after confirmation, including pending-card context', async () => {
  const tool = { id: 'tmux', tool: 'tmux', installs: [copy()] };
  const p = page([tool], (body) => {
    if (!body.force) throw Object.assign(new Error('2 tmux cards depend on this installation.'), { code: 'multiplexer_in_use', pending: 1 });
    return { session: { id: 'forced' } };
  });
  await p.context.manageMultiplexer(p.provider, tool, 'update', copy());
  assert.equal(p.requests.length, 2);
  assert.equal(p.requests[1].body.force, true);
  assert.match(p.confirmations[0], /1 detached cards/);
});

test('Refresh requests forced rediscovery through the existing reload route', async () => {
  const p = page([{ id: 'herdr', tool: 'herdr', installs: [] }]);
  p.render();
  await p.host.querySelector('.multiplexer-refresh').click();
  assert.deepEqual(p.requests, [{ method: 'POST', route: '/providers/reload', body: {} }]);
});

function event(p, providers, revision) {
  p.context.state.providersEvents++;
  p.context.setProviders({ providers, revision });
}

function held(p) {
  const replies = [];
  p.context.api = (method, route, body) => new Promise((resolve, reject) => replies.push({ method, route, body, resolve, reject }));
  return replies;
}

test('a Refresh reply never replaces a newer list of tools', async () => {
  const p = page([{ id: 'herdr', tool: 'herdr', installs: [] }]);
  const replies = held(p);
  const older = { providers: [{ id: 'shell', multiplexers: [] }], revision: 'r2' };
  const refreshing = p.context.reloadProviders();
  const newer = [{ id: 'shell', multiplexers: [{ id: 'herdr', tool: 'herdr', installs: [] }] }];
  event(p, newer, 'r3');
  replies[0].resolve(older);
  await refreshing;
  assert.equal(p.context.state.providers, newer);
  assert.equal(p.context.state.providersRevision, 'r3');

  const again = p.context.reloadProviders();
  replies[1].resolve(older);
  await again;
  assert.equal(p.context.state.providers, older.providers, 'with no newer update, the reply is the newest list');
  assert.equal(p.context.state.providersRevision, 'r2');
});

test('a multiplexer operation never replaces a newer list of tools, and a failed reload clears busy', async () => {
  const tool = { id: 'herdr', tool: 'herdr', installs: [copy()] };
  const p = page([tool]);
  const replies = held(p);
  const operating = p.context.manageMultiplexer(p.provider, tool, 'update', copy());
  replies[0].resolve({ session: { id: 'operation' } });
  await new Promise(setImmediate);
  assert.deepEqual(replies.map((r) => `${r.method} ${r.route}`), ['POST /providers/shell/multiplexers/herdr/update', 'GET /providers']);
  const newer = [{ id: 'shell', multiplexers: [{ ...tool, busy: true }] }];
  event(p, newer, 'r3');
  replies[1].resolve({ providers: [{ id: 'shell', multiplexers: [] }], revision: 'r2' });
  await operating;
  assert.equal(p.context.state.providers, newer);
  assert.equal(p.context.state.providersRevision, 'r3');

  const failing = p.context.manageMultiplexer(p.provider, tool, 'update', copy());
  replies[2].resolve({ session: { id: 'operation' } });
  await new Promise(setImmediate);
  assert.equal(tool.busy, true);
  replies[3].reject(new Error('offline'));
  await failing;
  assert.equal(tool.busy, false);
});

test('a reply is kept when only another request changed the tools meanwhile, as while reconnecting', async () => {
  const tool = { id: 'herdr', tool: 'herdr', installs: [copy()] };
  const p = page([tool]);
  const replies = held(p);
  const before = { providers: [{ id: 'shell', multiplexers: [] }], revision: 'r1' };
  const after = { providers: [{ id: 'shell', multiplexers: [tool] }], revision: 'r2' };

  const refreshing = p.context.reloadProviders();
  p.context.setProviders(before);
  replies[0].resolve(after);
  await refreshing;
  assert.equal(p.context.state.providers, after.providers, 'Refresh');

  const operating = p.context.manageMultiplexer(p.provider, tool, 'update', copy());
  replies[1].resolve({ session: { id: 'operation' } });
  await new Promise(setImmediate);
  p.context.setProviders(before);
  replies[2].resolve(after);
  await operating;
  assert.equal(p.context.state.providers, after.providers, 'an operation');
});
