import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('const AUTOSTART_NOTE ='), app.indexOf('function changeSound('));

/** Just enough of an element for the startup setting: text, flags, children and click listeners. */
function element(fields = {}) {
  const listeners = {};
  return {
    hidden: false, textContent: '', dataset: {}, children: [], ...fields,
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); },
    addEventListener(type, fn) { listeners[type] = fn; },
    click() { listeners.click?.(); },
  };
}

function page(api) {
  const nodes = new Map();
  const messages = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, element({ checked: false, disabled: false }));
    return nodes.get(id);
  };
  const copied = [];
  const document = { createElement: (tag) => element({ tag }) };
  const context = { api, $: node, document, copyText: (text) => copied.push(text), state: { connected: true }, AuthError: class extends Error {}, showAuth: (message) => messages.push(message), toast: (message) => messages.push(message) };
  runInNewContext(source, context);
  return { ...context, node, messages, copied };
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

test('while on, the setting says what the entry did at the last sign-in it ran at', () => {
  const view = page(async () => ({}));
  const run = view.node('autostart-run');
  const on = (lastRun) => ({ available: true, enabled: true, reason: null, lastRun, log: '/home/a/.config/agent-guild/manager.log' });
  const at = '2026-10-05T09:02:00.000Z';
  view.renderAutostart(on(null));
  assert.equal(run.hidden, false);
  assert.equal(run.textContent, 'Has not run at a sign-in yet.');
  assert.equal(run.dataset.outcome, 'none');
  view.renderAutostart(on({ at, outcome: 'started' }));
  assert.match(run.textContent, /^Last ran at sign-in on .+ and started the session manager\.$/);
  view.renderAutostart(on({ at, outcome: 'running' }));
  assert.match(run.textContent, /already running/);
  view.renderAutostart(on({ at, outcome: 'starting' }));
  assert.match(run.textContent, /^Starting the session manager/);
  view.renderAutostart(on({ at, outcome: 'failed' }));
  assert.match(run.textContent, /did not start\. See \/home\/a\/\.config\/agent-guild\/manager\.log\.$/);
  assert.equal(run.dataset.outcome, 'failed');
  for (const off of [{ available: true, enabled: false, reason: null, lastRun: null }, { available: false, enabled: false, reason: 'Not available in WSL.' }, null]) {
    view.renderAutostart(off);
    assert.equal(run.hidden, true);
    assert.equal(run.textContent, '');
  }
});

/** A Linux description: `mode`, with the service's side in `boot`. */
const linux = (mode, boot = {}, extra = {}) => ({
  available: true, enabled: mode === 'sign-in' || mode === 'both', reason: null, note: 'Sign-in note.', lastRun: null, log: '/home/a/.config/agent-guild/manager.log', mode,
  boot: { available: true, enabled: mode === 'boot' || mode === 'both', reason: null, note: 'Boot note.', user: 'ana', linger: true, state: null, commands: [], ...boot },
  ...extra,
});

test('linux: the setting is one choice of three, with the chosen one checked and the checkbox hidden', () => {
  const view = page(async () => ({}));
  for (const mode of ['off', 'sign-in', 'boot']) {
    view.renderAutostart(linux(mode, mode === 'boot' ? { state: { kind: 'pending' } } : {}));
    assert.equal(view.node('autostart-single').hidden, true);
    assert.equal(view.node('startup-modes').hidden, false);
    for (const value of ['off', 'sign-in', 'boot']) assert.equal(view.node(`startup-${value}`).checked, value === mode, `${mode}: ${value}`);
  }
  assert.equal(view.node('autostart-note').textContent, 'Boot note.');
  view.renderAutostart(linux('off'));
  assert.match(view.node('autostart-note').textContent, /^The session manager starts when you run agent-guild open/);
  view.renderAutostart(linux('sign-in'));
  assert.equal(view.node('autostart-note').textContent, 'Sign-in note.');
  assert.equal(view.node('autostart-run').textContent, 'Has not run at a sign-in yet.');
  // Another system's description goes back to the checkbox.
  view.renderAutostart({ available: true, enabled: true, reason: null });
  assert.equal(view.node('autostart-single').hidden, false);
  assert.equal(view.node('startup-modes').hidden, true);
});

test('linux: both starters on checks neither and asks for one', () => {
  const view = page(async () => ({}));
  view.renderAutostart(linux('both', { state: { kind: 'pending' }, commands: ['sudo loginctl enable-linger ana'] }));
  for (const value of ['off', 'sign-in', 'boot']) assert.equal(view.node(`startup-${value}`).checked, false);
  assert.equal(view.node('autostart-note').textContent, 'A sign-in entry and the systemd service are both on. Choose one.');
});

test('linux: a boot choice systemd cannot offer is disabled, and says why under any mode', () => {
  const view = page(async () => ({}));
  const reason = 'Not available because systemd\'s user manager did not answer: Failed to connect to bus';
  view.renderAutostart(linux('sign-in', { available: false, reason }));
  assert.equal(view.node('startup-boot').disabled, true);
  assert.equal(view.node('startup-sign-in').disabled, false);
  assert.equal(view.node('autostart-run').textContent, reason);
  view.renderAutostart(linux('off', { available: false, reason }, { available: false, reason: 'Not available while AGENT_GUILD_HOME sets the data folder.' }));
  for (const value of ['off', 'sign-in', 'boot']) assert.equal(view.node(`startup-${value}`).disabled, true);
});

test('linux: the boot state says what systemd reports, and failures and missing lingering name the command to run', () => {
  const view = page(async () => ({}));
  const run = view.node('autostart-run');
  const at = '2026-10-05T09:02:00.000Z';
  const shown = (state, boot = {}) => {
    view.renderAutostart(linux('boot', { state, ...boot }));
    return { text: run.textContent, outcome: run.dataset.outcome, hidden: run.hidden };
  };
  assert.match(shown({ kind: 'running', since: at, pid: 4 }).text, /^Running under systemd since .+\.$/);
  assert.equal(shown({ kind: 'running', since: null, pid: 4 }).outcome, 'started');
  assert.match(shown({ kind: 'other', since: null, pid: 77, port: 47821 }).text, /different session manager \(process 77\)/);
  assert.match(shown({ kind: 'pending' }).text, /systemd takes over at its next restart or when the computer starts\.$/);
  assert.match(shown({ kind: 'starting' }).text, /^systemd is starting/);
  const clash = shown({ kind: 'port-in-use', at, port: 47821 });
  assert.match(clash.text, /^Did not start on .+: another session manager was using port 47821\.$/);
  assert.equal(clash.outcome, 'failed');
  assert.equal(shown({ kind: 'failed', at, result: 'exit-code', status: 1 }, { commands: ['journalctl --user -u agent-guild.service -n 50 --no-pager'] }).outcome, 'failed');
  const commands = view.node('startup-commands');
  assert.equal(commands.hidden, false);
  assert.equal(commands.children.length, 1);
  assert.equal(commands.children[0].children[0].textContent, 'journalctl --user -u agent-guild.service -n 50 --no-pager');
  commands.children[0].children[1].click();
  assert.deepEqual(view.copied, ['journalctl --user -u agent-guild.service -n 50 --no-pager']);

  const unlingered = shown({ kind: 'running', since: null, pid: 4 }, { linger: false, commands: ['sudo loginctl enable-linger ana'] });
  assert.match(unlingered.text, /it starts when you first sign in, not when the computer starts\. Run this once as an administrator:$/);
  assert.equal(unlingered.outcome, 'warn');
  assert.equal(commands.children[0].children[0].textContent, 'sudo loginctl enable-linger ana');

  view.renderAutostart(linux('off'));
  assert.equal(commands.hidden, true, 'commands belong to the boot choice');
  assert.equal(run.hidden, true);
});

test('linux: choosing a mode sends it, keeps every choice disabled while saving, and reads back after a failure', async () => {
  const pending = deferred();
  const calls = [];
  const view = page(async (method, route, body) => {
    calls.push([method, route, body]);
    if (method === 'PUT') return pending.promise;
    return { autostart: linux('sign-in') };
  });
  const change = view.changeStartup({ value: 'boot' });
  for (const value of ['off', 'sign-in', 'boot']) assert.equal(view.node(`startup-${value}`).disabled, true);
  assert.equal(view.node('autostart').disabled, true);
  pending.resolve({ autostart: linux('boot', { state: { kind: 'pending' } }) });
  await change;
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['PUT', '/autostart', { mode: 'boot' }]], 'compared as JSON: the body was made in the page\'s realm');
  assert.equal(view.node('startup-boot').checked, true);
  assert.equal(view.node('startup-boot').disabled, false);

  const failing = page(async (method) => {
    if (method === 'PUT') throw Object.assign(new Error('Could not enable the systemd unit: Access denied'), { code: 'autostart_failed' });
    return { autostart: linux('sign-in') };
  });
  await failing.changeStartup({ value: 'boot' });
  assert.deepEqual(failing.messages, ['Could not enable the systemd unit: Access denied']);
  assert.equal(failing.node('startup-sign-in').checked, true, 'the actual state, read back');
});
