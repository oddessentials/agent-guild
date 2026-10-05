import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// app.js is a browser script. Run its real events handler against a fake
// socket and stubbed page functions, without booting the DOM or a manager.
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const connectSource = app.match(/function connectEvents\(\) \{[^]*?\n\}/)?.[0];
assert.ok(connectSource, 'connectEvents is present in app.js');

function connect({ changelogOpen, githubOpen = false, docked = null }) {
  const calls = [];
  const alerts = [];
  const recovery = [];
  const labels = [];
  const sockets = [];
  const noop = () => {};
  const context = {
    state: { stopping: false, stopRemaining: null, views: new Map(), eventsRetry: 0 },
    sessionsShown: false,
    WebSocket: class { constructor() { sockets.push(this); } },
    $: (id) => ({ open: id === 'changelog' && changelogOpen }),
    dockShows: (panel) => panel === 'github' && githubOpen,
    dockView: { panel: githubOpen ? 'github' : null },
    load: (key) => (key === 'agentGuild.dock' ? docked : null),
    DOCK_KEY: 'agentGuild.dock',
    openGitHub: () => calls.push('restore github'),
    restorePanes: () => calls.push('panes'),
    wsUrl: (path) => path,
    loadChangelog: () => calls.push('changelog'),
    loadNews: () => calls.push('news'),
    loadGitHub: () => calls.push('github'),
    setUpgrade: noop,
    renderVersion: noop,
    setConnection: (_kind, label) => labels.push(label),
    renderSessions: noop,
    dropSession: noop,
    leaveStopping: noop,
    enterStopping: noop,
    showManagerStopped: () => labels.push('Confirmed stop'),
    showManagerUnavailable: () => labels.push('Manager unavailable'),
    setTimeout: noop,
    managerConnected: () => alerts.push('connected'),
    managerGone: () => alerts.push('gone'),
    managerLoss: { disconnected: () => recovery.push('check'), cancel: () => recovery.push('cancel') },
    catchUpNotes: noop, applyServerNotes: noop,
  };
  runInNewContext(`(${connectSource})()`, context);
  const hello = { type: 'hello', version: '1.2.3', pid: 1, sessions: [], upgrade: null };
  return { calls, alerts, recovery, labels, state: context.state, send: (msg) => sockets[0].onmessage({ data: JSON.stringify(msg) }), open: () => sockets[0].onopen(), close: () => sockets[0].onclose(), hello };
}

test('a reconnect catches the open What\'s new panel up on a changelog.updated it missed', () => {
  const page = connect({ changelogOpen: true });
  page.send(page.hello);
  assert.deepEqual(page.calls, ['panes', 'news', 'changelog']);
});

test('a reconnect leaves the changelog alone while its panel is closed', () => {
  const page = connect({ changelogOpen: false });
  page.send(page.hello);
  assert.deepEqual(page.calls, ['panes', 'news']);
});

test('a reconnect and a github.updated reload the open GitHub panel', () => {
  const page = connect({ changelogOpen: false, githubOpen: true });
  page.send(page.hello);
  page.send({ type: 'github.updated' });
  assert.deepEqual(page.calls, ['panes', 'news', 'github', 'github']);
});

test('the first hello brings back the GitHub panel left open last time before the terminals under it, and a reconnect does not', () => {
  const page = connect({ changelogOpen: false, docked: 'github' });
  page.send(page.hello);
  page.send(page.hello);
  assert.deepEqual(page.calls, ['restore github', 'panes', 'news', 'panes', 'news']);
});

test('only an explicit stop reports a manager stop', () => {
  const page = connect({ changelogOpen: false });
  page.send(page.hello);
  assert.deepEqual(page.alerts, ['connected']);
  page.send({ type: 'manager.stopped', restart: true, remaining: 0 });
  page.close();
  assert.deepEqual(page.alerts, ['connected', 'gone']);
});

test('connection loss starts recovery checking without announcing a confirmed stop', () => {
  const page = connect({ changelogOpen: false });
  page.send(page.hello);
  page.close();
  assert.deepEqual(page.alerts, ['connected']);
  assert.deepEqual(page.recovery, ['check']);
  assert.match(page.labels.at(-1), /Trying to reconnect/);
});

test('a departing page or obsolete socket cannot start a recovery check or process events', () => {
  for (const reason of ['pageAway', 'obsolete']) {
    const page = connect({ changelogOpen: false });
    page.send(page.hello);
    if (reason === 'pageAway') page.state.pageAway = true;
    else page.state.eventsSocket = {};
    page.close();
    page.send({ type: 'manager.stopped', remaining: 0 });
    assert.deepEqual(page.recovery, []);
    assert.deepEqual(page.alerts, ['connected']);
  }
});

test('a lost connection during shutdown does not claim shutdown completed', () => {
  const page = connect({ changelogOpen: false });
  page.send(page.hello);
  page.state.stopping = true;
  page.close();
  assert.match(page.labels.at(-1), /Trying to reconnect/);
  assert.deepEqual(page.alerts, ['connected']);
});

test('failed reconnects preserve the unavailable explanation', () => {
  const page = connect({ changelogOpen: false });
  page.send(page.hello);
  page.state.managerUnavailable = true;
  page.close();
  assert.equal(page.labels.at(-1), 'Manager unavailable');
});

test('a successful socket handshake cancels a pending loss before the hello arrives', () => {
  const page = connect({ changelogOpen: false });
  page.open();
  assert.deepEqual(page.recovery, ['cancel']);
  assert.match(page.labels.at(-1), /Connected to session manager/);
});
