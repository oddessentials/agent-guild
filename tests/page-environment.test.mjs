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
const sessionSnapshot = (sessionId, revision, extra = {}) => ({
  scope: 'session', sessionId, revision, availability: 'ok', refreshing: false,
  checkedAt: '2026-10-04T12:00:00Z', spawnCwd: `/work/${sessionId}`,
  runtimes: [{ id: 'node', label: 'Node.js', status: 'ok', version: `${revision}.0.0` }],
  tools: [], ...extra,
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

function page(options = {}) {
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
  const ui = createEnvironmentUI({
    document, workingFolder: options.workingFolder, sessions: options.sessions,
    api: (method, route, body) => new Promise((resolve, reject) => requests.push({ method, route, body, resolve, reject })),
  });
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

async function sessionPage(revision = 2, sessions = [{ id: 'aa', name: 'A' }, { id: 'bb', name: 'B' }]) {
  const p = page({ sessions: () => sessions });
  p.ui.connected(10);
  p.requests[0].resolve(snapshot(2));
  await flush();
  p.get('environment-scope-session').click();
  p.requests.at(-1).resolve(sessionSnapshot('aa', revision));
  await flush();
  return p;
}

function selectSession(p, id) {
  const select = p.get('environment-session');
  select.value = id;
  select.dispatchEvent(new Event('change'));
  assert.equal(p.requests.at(-1).route, `/environment?scope=session&id=${id}`);
  return p.requests.at(-1);
}

test('missing languages do not make the shell card say the check failed', () => {
  const p = page();
  p.ui.connected(10);
  p.ui.updated(snapshot(1, '24.0.0', {
    runtimes: [
      { id: 'node', label: 'Node.js', status: 'ok', version: '24.0.0', path: '/bin/node' },
      { id: 'r', label: 'R', status: 'not_found', version: null, path: null },
    ],
  }));
  assert.equal(p.get('.environment-note').textContent, 'Manager environment');
  assert.equal(p.get('.environment-values').children[1].textContent, '24.0.0');
});

test('the shell card repeats a helper failure in the helper\'s own words', () => {
  const p = page();
  p.ui.connected(10);
  p.ui.updated(snapshot(2, '24.0.0', { error: 'The environment check timed out.' }));
  assert.equal(p.get('.environment-note').textContent, 'The environment check timed out.');
  assert.equal(p.get('environment-status').textContent, 'The environment check timed out.');
});

test('the page keeps all detection states distinct', () => {
  assert.deepEqual(['not_found', 'unavailable', 'failed'].map((status) => runtimeValue({ status })), ['Not found', 'Runtime unavailable', 'Probe failed']);
  assert.notEqual(runtimeValue({ status: 'configured', version: '22' }), 'Configured');
});

test('scope buttons request that scope, and an empty folder is not sent', async () => {
  const p = page({
    workingFolder: () => '',
    sessions: () => [{ id: 'abc', name: 'Shell', tool: 'Shell', cwd: '/work' }],
  });
  p.ui.connected(10);
  p.requests[0].resolve(snapshot(1, '24.0.0', { host: 'guild-host' }));
  await flush();
  const before = p.requests.length;
  p.get('environment-scope-project').click();
  assert.equal(p.requests.length, before);
  assert.match(p.get('environment-status').textContent, /Choose a working folder/);
  assert.equal(p.get('environment-title').textContent, 'Project pins');
  p.get('environment-scope-session').click();
  assert.equal(p.requests.at(-1).route, '/environment?scope=session&id=abc');
  assert.equal(p.get('environment-title').textContent, 'Session spawn environment');
  p.requests.at(-1).resolve({
    scope: 'session', revision: 1, refreshing: false, checkedAt: '2026-10-04T12:00:00Z', host: 'guild-host',
    availability: 'unavailable', detail: 'This session is tmux or herdr. Its environment is not the spawn record.',
    sessionId: 'abc', spawnCwd: '/work', runtimes: [], tools: [],
  });
  await flush();
  assert.match(p.get('environment-status').textContent, /tmux or herdr/);
  assert.equal(p.get('.environment-note').textContent, 'Manager environment');
  p.get('environment-scope-launch').click();
  const launch = p.requests.at(-1);
  assert.equal(launch.route, '/environment?scope=launch');
  launch.resolve({
    scope: 'launch', revision: 1, refreshing: false, checkedAt: '2026-10-04T12:00:00Z', host: 'guild-host',
    detail: 'Launch PATH, profiles not applied. The selected shell is not consulted.', runtimes: [], tools: [],
  });
  await flush();
  p.get('environment-refresh').click();
  assert.deepEqual([p.requests.at(-1).method, p.requests.at(-1).body], ['POST', { scope: 'launch' }]);
  assert.equal(p.get('environment-host').textContent, 'On guild-host');
});

test('session revisions are compared only within the selected session', async () => {
  const p = await sessionPage(4);
  selectSession(p, 'bb').resolve(sessionSnapshot('bb', 2));
  await flush();
  assert.equal(p.get('environment-manager-node').textContent, 'Spawn folder: /work/bb');
  assert.equal(p.get('environment-runtimes').children[0].children[0].children[1].textContent, '2.0.0');
  assert.equal(p.get('environment-refresh').disabled, false);
});

test('a multiplexer result with revision one displays after an ordinary session', async () => {
  const p = await sessionPage();
  const detail = 'This session is tmux or herdr. Its environment is not the spawn record.';
  selectSession(p, 'bb').resolve(sessionSnapshot('bb', 1, { availability: 'unavailable', detail, runtimes: [] }));
  await flush();
  assert.equal(p.get('environment-status').textContent, detail);
  assert.equal(p.get('environment-runtimes').children.length, 0);
  assert.equal(p.get('environment-tools-heading').hidden, true);
});

test('an update for another session cannot replace the selected results or the manager summary', async () => {
  const p = await sessionPage();
  selectSession(p, 'bb').resolve(sessionSnapshot('bb', 2));
  await flush();
  p.ui.updated(sessionSnapshot('aa', 6));
  assert.equal(p.get('environment-session').value, 'bb');
  assert.equal(p.get('environment-manager-node').textContent, 'Spawn folder: /work/bb');
  assert.equal(p.get('environment-runtimes').children[0].children[0].children[1].textContent, '2.0.0');
  assert.equal(p.get('.environment-values').children[1].textContent, '24.0.0');
  assert.equal(p.get('.environment-note').textContent, 'Manager environment');
});

test('an update for another session cannot clear the selected request error', async () => {
  const p = await sessionPage();
  selectSession(p, 'bb').reject(new Error('Could not check B.'));
  await flush();
  p.ui.updated(sessionSnapshot('aa', 6));
  assert.equal(p.get('environment-status').textContent, 'Could not check B.');
});

test('a session event wins over its older HTTP response', async () => {
  const p = await sessionPage();
  const request = selectSession(p, 'bb');
  p.ui.updated(sessionSnapshot('bb', 4));
  request.resolve(sessionSnapshot('bb', 1, { refreshing: true }));
  await flush();
  assert.equal(p.get('environment-manager-node').textContent, 'Spawn folder: /work/bb');
  assert.equal(p.get('environment-runtimes').children[0].children[0].children[1].textContent, '4.0.0');
  assert.equal(p.get('environment-refresh').disabled, false);
});

test('a late HTTP response for the previous session cannot replace the selection', async () => {
  const p = await sessionPage();
  p.get('environment-refresh').click();
  const previous = p.requests.at(-1);
  assert.deepEqual(previous.body, { scope: 'session', id: 'aa' });
  selectSession(p, 'bb').resolve(sessionSnapshot('bb', 2));
  await flush();
  previous.resolve(sessionSnapshot('aa', 8));
  await flush();
  assert.equal(p.get('environment-session').value, 'bb');
  assert.equal(p.get('environment-manager-node').textContent, 'Spawn folder: /work/bb');
});

test('returning through the dropdown or scope button uses that session\'s cached result', async () => {
  const p = await sessionPage();
  selectSession(p, 'bb').resolve(sessionSnapshot('bb', 2));
  await flush();
  p.ui.updated(sessionSnapshot('aa', 6));
  const request = selectSession(p, 'aa');
  assert.equal(p.get('environment-manager-node').textContent, 'Spawn folder: /work/aa');
  assert.equal(p.get('environment-runtimes').children[0].children[0].children[1].textContent, '6.0.0');
  request.resolve(sessionSnapshot('aa', 4));
  await flush();
  assert.equal(p.get('environment-runtimes').children[0].children[0].children[1].textContent, '6.0.0');
  p.get('environment-scope-manager').click();
  p.requests.at(-1).resolve(snapshot(2));
  await flush();
  p.get('environment-scope-session').click();
  assert.equal(p.get('environment-manager-node').textContent, 'Spawn folder: /work/aa');
  assert.equal(p.get('environment-runtimes').children[0].children[0].children[1].textContent, '6.0.0');
});

test('removing the selected session hides its results before rendering the fallback', async () => {
  const sessions = [{ id: 'aa', name: 'A' }, { id: 'bb', name: 'B' }];
  const p = await sessionPage(2, sessions);
  sessions.shift();
  p.ui.sync();
  assert.equal(p.get('environment-session').value, 'bb');
  assert.equal(p.get('environment-runtimes').children.length, 0);
  assert.equal(p.get('environment-manager-node').hidden, true);
  assert.equal(p.get('environment-status').textContent, 'Not checked yet.');
});

test('a recheck keeps the visible results and says so', async () => {
  const p = await sessionPage(4);
  p.get('environment-refresh').click();
  assert.equal(p.get('environment-refresh').textContent, 'Checking…');
  assert.equal(p.get('environment-status').textContent, 'Refreshing. Previous results remain visible.');
  assert.equal(p.get('environment-runtimes').children[0].children[0].children[1].textContent, '4.0.0');
});

test('removing the selected session starts one check of the next session', async () => {
  const sessions = [{ id: 'aa', name: 'A' }, { id: 'bb', name: 'B' }];
  const p = await sessionPage(4, sessions);
  selectSession(p, 'bb').resolve(sessionSnapshot('bb', 2));
  await flush();
  p.get('environment').open = true;
  const sent = p.requests.length;
  sessions.pop();
  p.ui.sessionRemoved('bb');
  assert.equal(p.get('environment-session').value, 'aa');
  assert.equal(p.requests.length, sent + 1);
  assert.equal(p.requests.at(-1).route, '/environment?scope=session&id=aa');
  assert.equal(p.get('environment-status').textContent, 'Refreshing. Previous results remain visible.');
  assert.equal(p.get('environment-runtimes').children[0].children[0].children[1].textContent, '4.0.0');
  sessions.shift();
  p.ui.sessionRemoved('aa');
  assert.equal(p.requests.length, sent + 1);
  assert.equal(p.get('environment-status').textContent, 'No sessions.');
});

test('a removed session does not start a check while the dialog is closed or another session is selected', async () => {
  const sessions = [{ id: 'aa', name: 'A' }, { id: 'bb', name: 'B' }];
  const p = await sessionPage(2, sessions);
  const sent = p.requests.length;
  sessions.pop();
  p.ui.sessionRemoved('bb');
  assert.equal(p.requests.length, sent);
  assert.equal(p.get('environment-session').value, 'aa');
  sessions.push({ id: 'bb', name: 'B' });
  p.get('environment').open = true;
  p.ui.sync();
  sessions.pop();
  p.ui.sessionRemoved('bb');
  assert.equal(p.requests.length, sent);
  assert.equal(p.get('environment-session').value, 'aa');
  assert.equal([...p.get('environment-session').children].some((option) => option.value === 'bb'), false);
});

test('reconnecting to a new manager clears the old session revisions', async () => {
  const p = await sessionPage(8);
  p.ui.disconnected();
  p.ui.connected(11);
  p.requests.at(-1).resolve(snapshot(1));
  await flush();
  p.get('environment-scope-session').click();
  p.requests.at(-1).resolve(sessionSnapshot('aa', 2));
  await flush();
  assert.equal(p.get('environment-manager-node').textContent, 'Spawn folder: /work/aa');
  assert.equal(p.get('environment-runtimes').children[0].children[0].children[1].textContent, '2.0.0');
});

test('a project folder is sent with its refresh and configured pins stay off the shell card', async () => {
  const p = page({ workingFolder: () => '/work/app' });
  p.ui.connected(10);
  p.requests[0].resolve(snapshot(1));
  await flush();
  p.get('environment-scope-project').click();
  assert.equal(p.requests.at(-1).route, `/environment?scope=project&cwd=${encodeURIComponent('/work/app')}`);
  p.requests.at(-1).resolve({
    scope: 'project', cwd: '/resolved/app', revision: 1, refreshing: false, checkedAt: '2026-10-04T12:00:00Z',
    error: null, stale: false, host: 'guild-host',
    pins: [{ id: 'nvmrc', label: 'Node.js', source: '.nvmrc', version: 'lts/*', status: 'configured', detail: null }],
  });
  await flush();
  const pin = p.get('environment-pins').children[0];
  assert.equal(pin.children[0].children[1].textContent, 'Configured');
  assert.equal(pin.children[2].textContent, 'lts/*');
  assert.equal(p.get('.environment-note').textContent, 'Manager environment');
  p.get('environment-refresh').click();
  assert.deepEqual(p.requests.at(-1).body, { scope: 'project', cwd: '/work/app' });
});

test('editing the working folder hides pins until that folder is read', async () => {
  let folder = '/work/app';
  const p = page({ workingFolder: () => folder });
  p.ui.connected(10);
  p.requests[0].resolve(snapshot(1));
  await flush();
  p.get('environment-scope-project').click();
  p.requests.at(-1).resolve({
    scope: 'project', cwd: '/work/app', revision: 1, refreshing: false, checkedAt: '2026-10-04T12:00:00Z',
    error: null, stale: false, host: 'guild-host',
    pins: [{ id: 'nvmrc', label: 'Node.js', source: '.nvmrc', version: '22', status: 'configured', detail: null }],
  });
  await flush();
  assert.equal(p.get('environment-pins').hidden, false);
  const sent = p.requests.length;
  folder = '/work/other';
  p.ui.sync();
  assert.equal(p.get('environment-pins').hidden, true);
  assert.match(p.get('environment-status').textContent, /Refresh to read this folder/);
  assert.equal(p.requests.length, sent);
  folder = '/work/app';
  p.ui.sync();
  assert.equal(p.get('environment-pins').hidden, false);
  assert.equal(p.get('environment-pins').children[0].children[2].textContent, '22');
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
  p.ui.updated({ scope: 'project', cwd: '/work', revision: 9, host: 'elsewhere', pins: [{ id: 'nvmrc', label: 'Node.js', source: '.nvmrc', version: '18', status: 'configured', detail: null }] });
  assert.equal(p.get('.environment-note').textContent, 'Manager environment');
  assert.equal(p.get('.environment-values').children[1].textContent, '24.0.0');
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
