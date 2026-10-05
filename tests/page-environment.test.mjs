import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentUI, runtimeValue } from '../web/environment.js';

class Element extends EventTarget {
  constructor(document, closeEvents) {
    super();
    this.document = document; this.closeEvents = closeEvents;
    this.children = []; this.dataset = {}; this.hidden = false; this.open = false; this.textContent = '';
    this.isConnected = true;
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  click() { this.dispatchEvent(new Event('click')); }
  showModal() { this.open = true; this.focus(); }
  close() {
    if (!this.open) return;
    this.open = false;
    // Native close events are queued separately from the synchronous close().
    this.closeEvents.push(() => this.dispatchEvent(new Event('close')));
  }
  focus() { this.document.activeElement = this; }
}
const snapshot = (revision, version = '24.0.0', extra = {}) => ({
  scope: 'manager', revision, refreshing: false, checkedAt: '2026-10-04T12:00:00Z',
  managerNode: { version: '24.0.0', path: '/manager/node' },
  runtimes: [{ id: 'node', label: 'Node.js', status: 'ok', version, path: '/bin/node' }],
  tools: [], ...extra,
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

function page() {
  const nodes = new Map(), closeEvents = [];
  const document = { activeElement: null };
  const element = () => new Element(document, closeEvents);
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const summary = element();
  summary.querySelector = get;
  let opener = get('.environment-open');
  Object.assign(document, {
    getElementById: get, createElement: element,
    querySelectorAll: () => summary.hidden ? [] : [summary],
    querySelector: (selector) => selector === '.provider[data-id="shell"] .environment-open' ? opener : null,
  });
  const requests = [];
  const ui = createEnvironmentUI({ document, api: (method, route, body) => new Promise((resolve, reject) => requests.push({ method, route, body, resolve, reject })) });
  const renderCard = () => ui.renderCard({ querySelector: () => summary }, { id: 'shell', shells: [] });
  renderCard();
  return {
    ui, requests, get, summary, document, closeEvents,
    releaseClose() { assert.ok(closeEvents.length, 'a close event must be queued'); closeEvents.shift()(); },
    replaceOpener() {
      opener.isConnected = false;
      opener = element();
      nodes.set('.environment-open', opener);
      renderCard();
      return opener;
    },
    removeOpener() { opener.isConnected = false; opener = null; },
  };
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

for (const action of ['button', 'backdrop']) {
  test(`environment ${action} close restores focus after the queued close event`, () => {
    const p = page(), dialog = p.get('environment'), opener = p.get('.environment-open');
    let closed = 0;
    dialog.addEventListener('close', () => { closed++; });
    opener.click();
    assert.equal(dialog.open, true);
    if (action === 'button') p.get('environment-close').click();
    else dialog.click();
    assert.equal(dialog.open, false);
    assert.equal(closed, 0, 'close events must not run synchronously');
    assert.equal(p.closeEvents.length, 1);
    dialog.close();
    assert.equal(p.closeEvents.length, 1, 'closing an already closed dialog queues no event');
    p.releaseClose();
    assert.equal(closed, 1, 'application and test listeners both receive close');
    assert.equal(p.document.activeElement, opener);
    assert.equal(p.closeEvents.length, 0);
  });
}

test('environment close focuses the replacement provider opener', () => {
  const p = page(), original = p.get('.environment-open');
  original.click();
  const replacement = p.replaceOpener();
  assert.equal(original.isConnected, false);
  p.get('environment-close').click();
  p.releaseClose();
  assert.equal(p.document.activeElement, replacement);
});

test('a delayed close event after reopening preserves the replacement focus destination', () => {
  const p = page(), dialog = p.get('environment'), original = p.get('.environment-open');
  original.click();
  p.get('environment-close').click();
  assert.equal(dialog.open, false);
  assert.equal(p.closeEvents.length, 1);
  original.click();
  assert.equal(dialog.open, true);
  // Release the earlier close only after reopening, with no event-loop timing.
  p.releaseClose();
  assert.equal(dialog.open, true);
  const replacement = p.replaceOpener();
  p.get('environment-close').click();
  assert.equal(dialog.open, false);
  p.releaseClose();
  assert.equal(p.document.activeElement, replacement);
  assert.equal(p.closeEvents.length, 0);
});

test('environment close tolerates a removed provider opener', () => {
  const p = page(), dialog = p.get('environment');
  p.get('.environment-open').click();
  p.removeOpener();
  p.get('environment-close').click();
  p.releaseClose();
  assert.equal(dialog.open, false);
  assert.equal(p.document.activeElement, dialog, 'no application focus target remains');
});

test('environment teardown clears focus restoration before its queued close event', () => {
  const p = page(), dialog = p.get('environment');
  p.get('.environment-open').click();
  p.ui.close();
  assert.equal(dialog.open, false);
  p.releaseClose();
  assert.equal(p.document.activeElement, dialog, 'teardown must not focus a provider');
  assert.equal(p.get('environment-refresh').disabled, true);
});
