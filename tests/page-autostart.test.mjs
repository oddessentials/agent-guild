import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('const AUTOSTART_NOTE ='), app.indexOf('function changeSound('));

function page(api) {
  const nodes = new Map();
  const messages = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { checked: false, disabled: false, hidden: false, textContent: '' });
    return nodes.get(id);
  };
  const context = { api, $: node, state: { connected: true }, AuthError: class extends Error {}, showAuth: (message) => messages.push(message), toast: (message) => messages.push(message) };
  runInNewContext(source, context);
  return { ...context, node, messages };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const status = (enabled) => ({ autostart: { available: true, enabled, reason: null } });

test('the startup checkbox follows the verified response and stays disabled while saving', async () => {
  const saved = deferred();
  let calls = 0;
  const view = page(async (method, route, body) => {
    calls++;
    assert.equal(method, 'PUT');
    assert.equal(route, '/autostart');
    assert.equal(body.enabled, true);
    return saved.promise;
  });
  const input = view.node('autostart');
  input.checked = true;
  const changing = view.changeAutostart(input);
  assert.equal(input.disabled, true);
  await view.loadAutostart();
  await view.changeAutostart(input);
  assert.equal(calls, 1, 'menu refreshes and repeated clicks cannot overlap a save');
  saved.resolve(status(true));
  await changing;
  assert.equal(input.checked, true);
  assert.equal(input.disabled, false);
});

test('after a failed change the checkbox reads actual state, including partial success', async () => {
  const calls = [];
  const verified = deferred();
  const view = page(async (method) => {
    calls.push(method);
    if (method === 'PUT') throw new Error('Could not verify the startup setting');
    return verified.promise;
  });
  const input = view.node('autostart');
  input.checked = true;
  const changing = view.changeAutostart(input);
  await Promise.resolve();
  await view.loadAutostart();
  await view.changeAutostart(input);
  assert.deepEqual(calls, ['PUT', 'GET']);
  assert.equal(input.disabled, true, 'recovery keeps further operations blocked');
  verified.resolve(status(true));
  await changing;
  assert.equal(input.checked, true);
  assert.equal(input.disabled, false);
  assert.match(view.messages[0], /Could not verify/);
});

test('a failed status read remains visible and can recover when settings are reopened', async () => {
  let failing = true;
  const view = page(async () => {
    if (failing) throw new Error('Connection lost');
    return status(false);
  });
  await view.loadAutostart();
  assert.equal(view.node('autostart-choice').hidden, false);
  assert.equal(view.node('autostart').disabled, true);
  assert.match(view.node('autostart-note').textContent, /Connection lost/);
  failing = false;
  await view.loadAutostart();
  assert.equal(view.node('autostart').disabled, false);
  assert.doesNotMatch(view.node('autostart-note').textContent, /Connection lost/);
});

test('a manager without the startup API hides the setting', async () => {
  const view = page(async () => { throw Object.assign(new Error('not found'), { code: 'not_found' }); });
  await view.loadAutostart();
  assert.equal(view.node('autostart-choice').hidden, true);
});

test('older status responses cannot overwrite a newer change or read', async () => {
  const old = deferred();
  let reads = 0;
  const view = page(async (method) => {
    if (method === 'GET' && reads++ === 0) return old.promise;
    return status(true);
  });
  const loading = view.loadAutostart();
  const input = view.node('autostart');
  input.checked = true;
  await view.changeAutostart(input);
  old.resolve(status(false));
  await loading;
  assert.equal(input.checked, true);
  assert.equal(input.disabled, false);

  const earlier = deferred();
  const later = deferred();
  let requests = 0;
  const reopened = page(() => requests++ === 0 ? earlier.promise : later.promise);
  const first = reopened.loadAutostart();
  const second = reopened.loadAutostart();
  later.resolve(status(true));
  await second;
  earlier.reject(new Error('Old connection failure'));
  await first;
  assert.equal(reopened.node('autostart').checked, true);
  assert.equal(reopened.node('autostart').disabled, false);
  assert.equal(reopened.messages.length, 0);
});

test('the note is the reason when there is one, else the manager\'s note for its system, else the default', () => {
  const view = page(async () => ({}));
  const note = view.node('autostart-note');
  view.renderAutostart({ available: true, enabled: true, reason: null, note: 'macOS also lists it.' });
  assert.equal(note.textContent, 'macOS also lists it.');
  view.renderAutostart({ available: true, enabled: true, reason: 'Could not update the sign-in entry', note: 'macOS also lists it.' });
  assert.equal(note.textContent, 'Could not update the sign-in entry');
  view.renderAutostart({ available: true, enabled: false, reason: null });
  assert.equal(note.textContent, source.match(/const AUTOSTART_NOTE = '([^']+)'/)[1]);
});
