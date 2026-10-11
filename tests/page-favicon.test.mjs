import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { isSessionWorking } from '../web/activity-favicon.js';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const source = ['statusText', 'renderSessions', 'upsertSession', 'dropSession', 'connectEvents', 'enterStopping'].map((name) => {
  const found = app.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(found, `${name} is present`);
  return found;
}).join('\n');

// Exercise the real snapshot/event/render path, without a manager or coding processes.
function page() {
  const noop = () => {}, nodes = new Map(), grid = { children: [], insertBefore: noop };
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { querySelector: () => ({}), classList: { add: noop }, remove: noop });
    return nodes.get(id);
  };
  const favicon = { working: false, setWorking(value) { this.working = value; } };
  const context = {
    isSessionWorking, activityFavicon: favicon,
    state: { sessions: new Map(), views: new Map(), panes: [], pageAway: false },
    cards: new Map(), drag: null, sessionsShown: false, sessionOrder: [],
    $: (id) => id === 'sessions' ? grid : node(id),
    orderSessions: (sessions) => [...sessions], buildCard: (s) => node(s.id),
    updateCard: (el, s) => { el.label = context.statusText(s); },
    guardLeaving: noop, noticeClone: noop, renderVersion: noop, setConnection: noop, notifyViews: noop, renderEmpty: noop,
    managerConnected: noop, setUpgrade: noop, loadNews: noop,
    load: noop, DOCK_KEY: 'dock', dockView: {}, restorePanes: noop, dockShows: () => false,
    managerLoss: { cancel: noop, disconnected: noop },
    closePanel: noop, closeModels: noop, closeNews: noop, closeChangelog: noop, closeHistory: noop, closeGitHub: noop,
    showStopped: noop, showManagerStopped: noop, managerGone: noop,
    wsUrl: (path) => path, WebSocket: class {}, setTimeout: noop, catchUpNotes: noop, applyServerNotes: noop,
  };
  runInNewContext(source, context);
  context.connectEvents();
  return {
    context, favicon,
    send: (message) => context.state.eventsSocket.onmessage({ data: JSON.stringify(message) }),
    hello: (sessions) => context.state.eventsSocket.onmessage({ data: JSON.stringify({ type: 'hello', sessions }) }),
    label: (id) => node(id).label,
  };
}

const session = (id, activity = 'active') => ({ id, activity, status: 'running', startedAt: '2026-10-04T10:00:00Z' });

test('favicon follows all cards through snapshots, updates, exits and removals', () => {
  const p = page();
  p.hello([session('a'), session('b')]);
  assert.equal(p.label('a'), 'Working');
  assert.equal(p.favicon.working, true);
  p.send({ type: 'session.updated', session: session('a', 'quiet') });
  assert.equal(p.label('a'), 'Running');
  assert.equal(p.favicon.working, true, 'another card is still working');
  p.send({ type: 'session.removed', sessionId: 'b' });
  assert.equal(p.favicon.working, false);
  p.send({ type: 'session.created', session: session('c') });
  assert.equal(p.favicon.working, true);
  p.send({ type: 'session.updated', session: { ...session('c'), status: 'exited', exitCode: 0, exitedAt: '2026-10-04T10:01:00Z' } });
  assert.equal(p.label('c'), 'Exited');
  assert.equal(p.favicon.working, false, 'exited cards never count, even with stale active activity');
  p.send({ type: 'session.updated', session: session('c') });
  assert.equal(p.favicon.working, false, 'a late pre-exit reply cannot restart the indicator');
  p.context.upsertSession({ ...session('c'), startedAt: '2026-10-04T10:02:00Z' });
  assert.equal(p.favicon.working, true, 'a newly reattached process can work again');
  p.hello([]);
  assert.equal(p.favicon.working, false, 'an empty reconnect snapshot replaces the previous aggregate');
});

test('connection loss preserves the cards, reconnect replaces them, and shutdown clears activity', () => {
  const p = page();
  p.hello([session('a')]);
  p.context.state.eventsSocket.onclose();
  assert.equal(p.favicon.working, true, 'a disconnect does not infer that work finished');
  assert.equal(p.label('a'), 'Working');
  p.context.connectEvents();
  p.hello([session('a', 'quiet')]);
  assert.equal(p.favicon.working, false);
  p.send({ type: 'session.updated', session: session('a') });
  p.send({ type: 'manager.stopping', running: 1 });
  assert.equal(p.context.state.sessions.size, 0);
  assert.equal(p.favicon.working, false);
});
