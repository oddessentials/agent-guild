import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentUI, runtimeValue } from '../web/environment.js';

class Element {
  constructor() { this.children = []; this.dataset = {}; this.hidden = false; this.open = false; this.textContent = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(type, listener) { this[type] = listener; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.focused = true; }
}
const snapshot = (revision, version = '24.0.0', extra = {}) => ({
  scope: 'manager', revision, refreshing: false, checkedAt: '2026-10-04T12:00:00Z',
  managerNode: { version: '24.0.0', path: '/manager/node' },
  runtimes: [{ id: 'node', label: 'Node.js', status: 'ok', version, path: '/bin/node' }],
  tools: [], ...extra,
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

function page() {
  const nodes = new Map();
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const summary = new Element();
  summary.querySelector = get;
  const document = {
    getElementById: get, createElement: () => new Element(),
    querySelectorAll: () => summary.hidden ? [] : [summary], querySelector: () => get('replacement-opener'),
  };
  const requests = [];
  const ui = createEnvironmentUI({ document, api: (method, route, body) => new Promise((resolve, reject) => requests.push({ method, route, body, resolve, reject })) });
  ui.renderCard({ querySelector: () => summary }, { id: 'shell', shells: [] });
  return { ui, requests, get, summary };
}

test('the page keeps all detection states distinct', () => {
  assert.deepEqual(['not_found', 'unavailable', 'failed'].map((status) => runtimeValue({ status })), ['Not found', 'Runtime unavailable', 'Probe failed']);
});

test('an environment event wins over a stale initial response; manual refresh retains prior values', async () => {
  const p = page();
  p.ui.connected(10);
  p.ui.updated(snapshot(2, '24.2.0'));
  p.requests[0].resolve(snapshot(1));
  await flush();
  assert.equal(p.get('.environment-values').children[1].textContent, '24.2.0');
  p.get('environment-refresh').click();
  assert.deepEqual([p.requests[1].method, p.requests[1].route, p.requests[1].body], ['POST', '/environment/refresh', {}]);
  p.ui.updated(snapshot(3, '24.2.0', { refreshing: true }));
  assert.equal(p.get('environment-refresh').disabled, true);
  assert.match(p.get('.environment-note').textContent, /previous check/);
  assert.equal(p.get('.environment-values').children[1].textContent, '24.2.0');
  p.ui.updated(snapshot(4, '24.3.0'));
  p.requests[1].resolve(snapshot(3, '24.2.0', { refreshing: true }));
  await flush();
  assert.equal(p.get('.environment-values').children[1].textContent, '24.3.0');
  assert.equal(p.get('environment-refresh').disabled, false);
});

test('disconnect discards pending responses and a restarted manager can have a lower revision', async () => {
  const p = page();
  p.ui.connected(10);
  p.ui.updated(snapshot(8));
  p.ui.disconnected();
  p.requests[0].resolve(snapshot(9, 'wrong'));
  await flush();
  assert.equal(p.get('environment-refresh').disabled, true);
  assert.match(p.get('environment-status').textContent, /Disconnected/);
  p.ui.connected(11);
  p.requests[1].resolve(snapshot(1, '26.0.0'));
  await flush();
  assert.equal(p.get('.environment-values').children[1].textContent, '26.0.0');
});

test('environment data is confined to shell cards; tools only claim presence', async () => {
  const p = page();
  p.ui.connected(10);
  p.requests[0].resolve(snapshot(1, '24.0.0', { tools: [{ id: 'vfox', label: 'vfox', path: '/bin/vfox', status: 'detected' }] }));
  await flush();
  assert.equal(p.get('environment-tools').children[0].children[0].textContent, 'vfox · Detected');
  p.ui.renderCard({ querySelector: () => p.summary }, { id: 'openai', shells: null });
  assert.equal(p.summary.hidden, true);
});
