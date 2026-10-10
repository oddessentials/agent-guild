import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// app.js is a browser script. Run its real events handler against a fake
// socket and stubbed page functions, without booting the DOM or a manager.
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const connectSource = app.match(/function connectEvents\([^]*?\n\}/)?.[0];
assert.ok(connectSource, 'connectEvents is present in app.js');
const lifecycleSource = [
  /async function loadProviders\([^]*?\n\}/,
  /function showAuth\([^]*?\n\}/,
  /addEventListener\('pagehide', \(\) => \{[^]*?\n\}\);/,
  /addEventListener\('pageshow', (?:async )?\(event\) => \{[^]*?\n\}\);/,
].map((pattern) => {
  const source = app.match(pattern)?.[0];
  assert.ok(source, `${pattern} is present`);
  return source;
}).join('\n');

function connect({ changelogOpen = false, githubOpen = false, docked = null } = {}) {
  const calls = [];
  const alerts = [];
  const recovery = [];
  const labels = [];
  const sockets = [];
  const timers = [], requests = [], refreshes = [], renders = [], auth = [];
  const listeners = new Map();
  const noop = () => {};
  const context = {
    state: { stopping: false, stopRemaining: null, views: new Map(), eventsRetry: 0, providers: [] },
    sessionsShown: false,
    WebSocket: class {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
      constructor() { this.readyState = 0; sockets.push(this); }
      close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
    },
    requestLink: new AbortController(), AbortController,
    AuthError: class extends Error {},
    api: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
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
    setConnection: (kind, label) => { context.state.connected = kind === 'ok'; labels.push(label); },
    renderSessions: () => renders.push('sessions'),
    renderProviders: () => renders.push('providers'),
    renderHistory: () => renders.push('history'),
    scheduleStats: () => renders.push('stats'),
    dropSession: noop,
    leaveStopping: noop,
    enterStopping: noop,
    showManagerStopped: () => labels.push('Confirmed stop'),
    showManagerUnavailable: () => labels.push('Manager unavailable'),
    setTimeout: (callback) => timers.push(callback),
    clearTimeout: noop, restartTimer: null,
    addEventListener: (type, callback) => listeners.set(type, callback),
    activityFavicon: { setPaused: noop }, terminalCopy: { close: noop },
    flushNotes: noop, stopDictation: noop,
    closePanel: noop, closeModels: noop, closeNews: noop, closeChangelog: noop, closeHistory: noop, closeGitHub: noop,
    managerConnected: () => alerts.push('connected'),
    managerGone: () => alerts.push('gone'),
    managerLoss: { disconnected: () => recovery.push('check'), cancel: () => recovery.push('cancel') },
    catchUpNotes: noop, applyServerNotes: noop,
  };
  runInNewContext(`${connectSource}\n${lifecycleSource}`, context);
  const loadProviders = context.loadProviders;
  context.loadProviders = (...args) => {
    const pending = loadProviders(...args);
    refreshes.push(pending);
    return pending;
  };
  const showAuth = context.showAuth;
  context.showAuth = (message) => { auth.push(message); showAuth(message); };
  context.connectEvents();
  const hello = { type: 'hello', version: '1.2.3', pid: 1, sessions: [], upgrade: null };
  return {
    context, sockets, calls, alerts, recovery, labels, renders, auth, requests, refreshes, timers, hello, state: context.state,
    send: (msg, ws = sockets.at(-1)) => ws.onmessage({ data: JSON.stringify(msg) }),
    open: () => { const ws = sockets.at(-1); ws.readyState = 1; ws.onopen(); },
    close: () => sockets.at(-1).close(),
    fire: (type, event = {}) => listeners.get(type)(event),
    retry: () => { assert.ok(timers.length, 'a reconnect is scheduled'); timers.shift()(); },
  };
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

test('restoration and subsequent retries connect without waiting for provider responses', async () => {
  const page = connect();
  page.open();
  page.send(page.hello);
  page.fire('pagehide');
  page.fire('pageshow', { persisted: true });
  assert.equal(page.sockets.length, 2, 'restoration starts a socket immediately');
  assert.equal(page.state.connected, false, 'the old Connected status is cleared');
  assert.match(page.labels.at(-1), /Reconnecting/);
  assert.equal(page.requests.length, 1);
  page.open();
  page.send(page.hello);
  assert.equal(page.state.connected, true, 'hello is processed with providers still pending');
  page.close();
  page.retry();
  assert.equal(page.sockets.length, 3, 'an ordinary retry also starts immediately');
  assert.equal(page.requests.length, 2);
  page.open();
  page.send(page.hello);
  page.renders.length = 0;
  const current = [{ id: 'current' }];
  page.requests[1].resolve({ providers: current });
  await page.refreshes[1];
  assert.equal(page.state.providers, current);
  assert.deepEqual(page.renders, ['providers', 'sessions', 'stats'], 'dependent controls catch up after hello');
  page.renders.length = 0;
  page.requests[0].resolve({ providers: [{ id: 'obsolete' }] });
  await page.refreshes[0];
  assert.equal(page.state.providers, current);
  assert.deepEqual(page.renders, [], 'the previous connection cannot repaint');
});

test('a newer provider event wins over the pending refresh on the same socket', async () => {
  const page = connect();
  page.close();
  page.retry();
  page.send({ type: 'providers.updated', providers: [{ id: 'newer' }] });
  const current = page.state.providers;
  page.renders.length = 0;
  page.requests[0].resolve({ providers: [{ id: 'older' }] });
  await page.refreshes[0];
  assert.equal(page.state.providers, current);
  assert.deepEqual(page.renders, []);
});

test('departure, revocation and obsolete sockets ignore late refresh results and auth failures', async () => {
  for (const leave of ['pagehide', 'revoked', 'replaced']) {
    for (const failed of [false, true]) {
      const page = connect();
      page.close();
      page.retry();
      const current = page.state.providers;
      if (leave === 'pagehide') page.fire('pagehide');
      else if (leave === 'revoked') page.state.remoteRevoked = true;
      else page.context.connectEvents();
      const socket = page.state.eventsSocket;
      page.renders.length = 0;
      if (failed) page.requests[0].reject(new page.context.AuthError('old token'));
      else page.requests[0].resolve({ providers: [{ id: 'old' }] });
      await page.refreshes[0].catch(() => {});
      assert.equal(page.state.providers, current, leave);
      assert.equal(page.state.eventsSocket, socket, leave);
      assert.deepEqual(page.renders, [], leave);
      assert.deepEqual(page.auth, [], leave);
    }
  }
});

test('a current auth failure closes the socket and cancels its queued retry', async () => {
  for (const closed of [false, true]) {
    const page = connect();
    page.close();
    page.retry();
    const socket = page.state.eventsSocket;
    if (closed) page.close(); // A rejected WebSocket handshake can arrive before HTTP's 401.
    page.requests[0].reject(new page.context.AuthError('rejected token'));
    await assert.rejects(page.refreshes[0], /rejected token/);
    assert.deepEqual(page.auth, ['rejected token']);
    assert.equal(page.state.eventsSocket, null);
    assert.equal(socket.readyState, 3);
    assert.equal(page.state.connected, false);
    for (const retry of page.timers.splice(0)) retry();
    assert.equal(page.sockets.length, 2, 'authentication waits for user input');
  }
});

test('provider network failures leave the socket usable, and departure cancels a queued retry', async () => {
  const page = connect();
  page.close();
  page.retry();
  page.open();
  page.send(page.hello);
  page.requests[0].reject(new Error('network unavailable'));
  await assert.rejects(page.refreshes[0], /network unavailable/);
  assert.equal(page.state.connected, true);
  assert.deepEqual(page.auth, []);
  page.close();
  page.fire('pagehide');
  page.retry();
  assert.equal(page.sockets.length, 2);
  assert.equal(page.requests.length, 1);
});

function linkPage(hello) {
  const linkSource = app.match(/function checkLinks\([^]*?\n\}/)?.[0];
  assert.ok(linkSource, 'checkLinks is present in app.js');
  const page = connect({ changelogOpen: false });
  page.send({ ...page.hello, ...hello });
  const ws = page.sockets[0];
  ws.readyState = 1;
  page.sent = [];
  ws.send = (raw) => page.sent.push(JSON.parse(raw).type);
  let now = ws.heardAt;
  Object.assign(page.context, {
    PING_AFTER_MS: 20000, PONG_WITHIN_MS: 8000, OPEN_WITHIN_MS: 15000,
    Date: { now: () => now }, document: { visibilityState: 'visible' },
  });
  page.context.WebSocket.CONNECTING = 0;
  page.context.WebSocket.OPEN = 1;
  runInNewContext(linkSource, page.context);
  page.after = (ms) => { now += ms; page.context.checkLinks(); };
  return page;
}

test('a manager that predates the heartbeat is never pinged or dropped for staying quiet', () => {
  const page = linkPage({});
  const request = page.context.requestLink.signal;
  for (let i = 0; i < 10; i++) page.after(10000);
  assert.deepEqual(page.sent, []);
  assert.equal(request.aborted, false);
  assert.deepEqual(page.recovery, []);
});

test('a silent link is asked for a pong, then dropped with every request waiting on it', () => {
  const page = linkPage({ heartbeat: true });
  const { sent } = page;
  const request = page.context.requestLink.signal;
  page.after(10000);
  assert.deepEqual(sent, [], 'a link heard from lately is left alone');
  page.after(15000);
  assert.deepEqual(sent, ['ping']);
  page.after(9000);
  assert.equal(request.aborted, true, 'a request waiting on the dead link ends');
  assert.notEqual(page.context.requestLink.signal, request, 'later requests are not aborted');
  assert.match(page.labels.at(-1), /Trying to reconnect/);
  assert.deepEqual(page.recovery, ['check']);
});

test('a request cancelled while its answer is still arriving is reported, never taken as an empty success', async () => {
  const apiSource = app.match(/const ANSWER_LOST = [^\n]*\n/)?.[0] + app.match(/async function api\([^]*?\n\}/)?.[0];
  assert.ok(apiSource, 'api is present in app.js');
  const cut = () => Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  const context = {
    state: { token: 't' }, requestLink: new AbortController(), AuthError: class extends Error {},
    fetch: async () => ({ status: 200, ok: true, json: cut, text: cut }),
  };
  runInNewContext(apiSource, context);
  await assert.rejects(context.api('POST', '/sessions', {}), /lost before it answered/);
});
