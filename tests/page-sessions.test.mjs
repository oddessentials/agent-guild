import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { isSessionWorking } from '../web/activity-favicon.js';
import { revealRow } from '../web/layout.js';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const source = ['upsertSession', 'statusText', 'stopNote', 'stopSession', 'removeSession', 'reattachable', 'reattachSession', 'resumeCard', 'osc52Text', 'exitLine'].map((name) => {
  const found = app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(found, `${name} is present in app.js`);
  return found;
}).join('\n');

const started = '2026-10-03T10:00:00.000Z';
const plain = { id: 'p1', name: 'Shell · bash', provider: { tool: 'Shell' }, status: 'running', exitCode: null, signal: null, startedAt: started, exitedAt: null, multiplexer: null };
const tmux = { ...plain, id: 'm1', name: 'Shell · tmux', multiplexer: { label: 'tmux', attach: 'tmux attach -t guild-abc123', reattachable: false } };
const exited = (s, extra = {}) => ({ ...s, status: 'exited', exitCode: 1, exitedAt: '2026-10-03T10:05:00.000Z', ...extra });

// The browser's own session logic, with only the DOM and the network stubbed.
function page({ onApi = () => ({}) } = {}) {
  const confirms = [];
  const requests = [];
  const opened = [];
  const context = {
    isSessionWorking,
    state: { sessions: new Map() },
    renderSessions() {}, noticeClone() {}, dropSession() {},
    openPanel: (id) => opened.push(id),
    toast(message) { assert.fail(message); },
    confirm: (message) => { confirms.push(message); return true; },
    api: async (method, route) => { requests.push(`${method} ${route}`); return onApi(method, route, context); },
    AuthError: class extends Error {},
    TextDecoder, atob,
  };
  runInNewContext(source, context);
  return { context, confirms, requests, opened, sessions: context.state.sessions };
}

test('a reply sent before a session exited cannot show it running again; a reattached run can', async () => {
  // Stop's reply was taken before the process ended; the exit event overtakes it.
  const { context, sessions } = page({
    onApi: (method, route, ctx) => {
      ctx.upsertSession(exited(plain));
      return { session: { ...plain } };
    },
  });
  context.upsertSession({ ...plain });
  await context.stopSession(plain.id);
  assert.equal(sessions.get(plain.id).status, 'exited');

  context.upsertSession(exited(plain, { name: 'Renamed' }));
  assert.equal(sessions.get(plain.id).name, 'Renamed', 'updates to an exited session still apply');
  context.upsertSession({ ...plain, startedAt: '2026-10-03T10:06:00.000Z' });
  assert.equal(sessions.get(plain.id).status, 'running', 'a process started after the exit is a new run');
  context.upsertSession({ ...tmux, activity: 'active' });
  context.upsertSession({ ...tmux, activity: 'quiet' });
  assert.equal(sessions.get(tmux.id).activity, 'quiet', 'a running session updates as before');
});

test('a multiplexer session detaches instead of ending, says how to reattach, and reads Closed', async () => {
  const { context, confirms } = page({ onApi: (method, route) => (method === 'DELETE' ? {} : { session: { ...(route.includes(tmux.id) ? tmux : plain) } }) });
  context.upsertSession({ ...plain });
  context.upsertSession({ ...tmux });
  await context.stopSession(tmux.id);
  await context.stopSession(plain.id);
  await context.removeSession(tmux.id);
  await context.removeSession(plain.id);
  assert.deepEqual(confirms, [
    'Detach "Shell · tmux"? tmux keeps running it. Reattach it from its card, or in a terminal with: tmux attach -t guild-abc123',
    'Stop "Shell · bash"? The Shell process will be ended.',
    '"Shell · tmux" is still running. Detach it and remove it? tmux keeps running it. Reattach it in a terminal with: tmux attach -t guild-abc123',
    '"Shell · bash" is still running. End it and remove it?',
  ]);
  assert.equal(context.statusText(exited(tmux)), 'Closed', 'a detached client\'s exit code means nothing to the user');
  assert.equal(context.statusText(exited(plain)), 'Exited (1)');
  assert.equal(context.statusText(exited(plain, { exitCode: 0 })), 'Exited');
});

test('Reattach brings a closed tmux card back as itself, only while tmux still has its session', async () => {
  const revived = { ...tmux, startedAt: '2026-10-03T10:06:00.000Z' };
  const { context, requests, opened, sessions } = page({ onApi: () => ({ session: revived }) });
  context.upsertSession(exited(tmux));
  assert.equal(context.reattachable(sessions.get(tmux.id)), false, 'not until the manager has found tmux still has it');
  context.upsertSession(exited(tmux, { multiplexer: { ...tmux.multiplexer, reattachable: true } }));
  assert.equal(context.reattachable(sessions.get(tmux.id)), true);
  await context.resumeCard(tmux.id);
  assert.deepEqual(requests, ['POST /sessions/m1/reattach']);
  assert.deepEqual([sessions.get(tmux.id).status, opened], ['running', ['m1']], 'the same card runs again and opens');
  assert.equal(context.reattachable(revived), false, 'a running card has nothing to reattach');
});

test('OSC 52 copies text and never answers a clipboard query', () => {
  const { context } = page();
  const b64 = (text) => Buffer.from(text).toString('base64');
  assert.equal(context.osc52Text(`c;${b64('copied → λ')}`), 'copied → λ');
  assert.equal(context.osc52Text(`;${b64('from tmux')}`), 'from tmux', 'tmux names no selection');
  for (const data of ['c;?', '?', 'c;', 'c;not base64!', 'no-separator', `c;${'A'.repeat(4 * 1024 * 1024 + 4)}`]) {
    assert.equal(context.osc52Text(data), null, data.slice(0, 20));
  }
});

test('a closed tmux or herdr panel says closed, not an exit code that means nothing to the user', () => {
  const { context } = page();
  assert.equal(context.exitLine(exited(tmux), { exitCode: 1, signal: null }), '[closed]', 'tmux\'s client exits 1 when detached');
  assert.equal(context.exitLine(exited(tmux, { exitCode: null }), { exitCode: null, signal: null }), '[closed]', 'a card brought back after a restart ran nothing yet');
  assert.equal(context.exitLine(exited(plain), { exitCode: 1, signal: null }), '[process exited with code 1]', 'other sessions as before');
  assert.equal(context.exitLine(exited(plain), { exitCode: null, signal: 'SIGKILL' }), '[process exited with signal SIGKILL]');
});

test('exit clears an initial or reconnecting badge before the held snapshot completes, without enabling input', () => {
  const methods = ['onMessage', 'showLink'].map((name) => {
    const found = app.match(new RegExp(`  ${name}\\([^]*?\\n  \\}`))?.[0];
    assert.ok(found, `${name} is present`);
    return found;
  }).join(',\n');
  for (const label of ['Connecting…', 'Reconnecting…']) {
    for (const status of ['running', 'exited']) {
      const { context } = page();
      Object.assign(context, { WebSocket: { OPEN: 1 }, terminalControls: { refresh() {} }, dictation: null, paintSizeNote() {} });
      const callbacks = [];
      const view = Object.assign(runInNewContext(`({${methods}})`, context), {
        id: plain.id, ws: { readyState: 1 }, status: { hidden: false }, statusLabel: { textContent: label },
        term: { reset() {}, resize() {}, write(_data, callback) { if (callback) callbacks.push(callback); } },
        takeDeviceSize() {},
      });
      view.onMessage({ type: 'snapshot', session: { ...plain, status }, data: 'saved output', cols: 80, rows: 24 });
      assert.equal(view.status.hidden, false, 'the snapshot has not finished');
      view.onMessage({ type: 'exit', exitCode: 0 });
      assert.equal(view.status.hidden, true, `${label}, ${status}`);
      assert.equal(view.statusLabel.textContent, '');
      assert.equal(view.shown, true);
      assert.equal(view.inputReady, false);
      assert.equal(callbacks.length, 1);
      callbacks[0]();
      assert.equal(view.inputReady, false, 'a snapshot of a running process cannot undo its exit');
      // A callback left over from this connection also cannot clear a later connection's badge.
      view.ws = { readyState: 1 };
      view.showLink('Reconnecting…');
      callbacks[0]();
      assert.equal(view.status.hidden, false);
      assert.equal(view.inputReady, false);
    }
  }
});

test('a terminal takes a device\'s size only when placed on screen there; otherwise it follows the session\'s size', () => {
  const methods = ['onMessage', 'showLink', 'mount', 'unmount', 'place', 'takeDeviceSize', 'sizedElsewhere'].map((name) => {
    const found = app.match(new RegExp(`  ${name}\\([^]*?\\n  \\}`))?.[0];
    assert.ok(found, `${name} is present`);
    return found;
  }).join(',\n');
  const { context } = page();
  Object.assign(context, { WebSocket: { OPEN: 1 }, terminalControls: { refresh() {} }, dictation: null, paintSizeNote() {} });
  const sent = [], resized = [], callbacks = [];
  const term = {
    cols: 120, rows: 32,
    reset() {}, focus() {},
    resize(cols, rows) { Object.assign(this, { cols, rows }); resized.push(`${cols}x${rows}`); },
    write(_data, callback) { if (callback) callbacks.push(callback); },
  };
  const view = Object.assign(runInNewContext(`({${methods}})`, context), {
    id: plain.id, ws: { readyState: 1 }, status: { hidden: false }, statusLabel: { textContent: '' },
    term, fit: { fit() { term.resize(50, 20); }, proposeDimensions: () => ({ cols: 50, rows: 20 }) }, el: { isConnected: false, remove() {} },
    opened: true, takeSize: false, enableTouchScroll() {},
    send: (message) => sent.push(`${message.type} ${message.cols}x${message.rows}`),
  });
  const host = { replaceChildren() { view.el.isConnected = true; } };
  // xterm parses writes in order and calls back after each; the fake does so on demand.
  const parsed = () => { while (callbacks.length) callbacks.shift()(); };
  const snapshot = (cols, rows) => { view.onMessage({ type: 'snapshot', session: { ...plain }, data: '', cols, rows }); parsed(); };

  snapshot(120, 32);
  assert.deepEqual(sent, [], 'a screen that is not on this device sends no size');
  assert.deepEqual(resized, ['120x32'], 'and shows the session\'s size');

  view.mount(host, { focus: false });
  assert.deepEqual(sent, [], 'the size is taken once the output already received is on screen');
  parsed();
  assert.deepEqual(sent, ['resize 50x20'], 'placing it on screen takes this device\'s size once');

  assert.equal(view.sizedElsewhere(), false);
  view.onMessage({ type: 'resize', cols: 100, rows: 30 });
  assert.equal(`${term.cols}x${term.rows}`, '50x20', 'another device\'s size waits for the output before it');
  parsed();
  assert.equal(`${term.cols}x${term.rows}`, '100x30', 'then is followed');
  assert.equal(view.sizedElsewhere(), true, 'and the page can say so');
  snapshot(100, 30);
  assert.deepEqual(sent, ['resize 50x20'], 'a reconnection does not take it back');

  view.onMessage({ type: 'resize', cols: 90, rows: 25 });
  view.ws = { readyState: 1 };
  snapshot(100, 30);
  assert.equal(`${term.cols}x${term.rows}`, '100x30', 'a size from a link that ended cannot reach the next link\'s screen');

  view.unmount();
  view.el.isConnected = false;
  assert.equal(view.sizedElsewhere(), false, 'a terminal off screen has no screen to fit');
  view.mount(host, { focus: false });
  parsed();
  assert.deepEqual(sent, ['resize 50x20', 'resize 50x20'], 'opening it again does');
  assert.equal(view.sizedElsewhere(), false);

  view.unmount();
  view.el.isConnected = false;
  view.ws = { readyState: 0 };
  view.mount(host, { focus: false });
  parsed();
  assert.deepEqual(sent, ['resize 50x20', 'resize 50x20'], 'a terminal opened while its link is down waits');
  view.ws = { readyState: 1 };
  snapshot(100, 30);
  assert.deepEqual(sent, ['resize 50x20', 'resize 50x20', 'resize 50x20'], 'and takes the size with its first screen');

  view.unmount();
  view.el.isConnected = false;
  view.mount(host, { focus: false });
  view.ws = { readyState: 1 };
  parsed();
  assert.deepEqual(sent.length, 3, 'a link that ended before the output was on screen sends nothing');
  snapshot(100, 30);
  assert.deepEqual(sent.length, 4, 'the next link\'s first screen takes the size instead');

  for (const ended of [{ readyState: 2 }, { readyState: 3 }, { ended: true }]) {
    view.place();
    Object.assign(view.ws, ended);
    const before = [sent.length, resized.length];
    parsed();
    assert.deepEqual([sent.length, resized.length], before, 'a link that ended before its replacement neither fits nor sends');
    view.ws = { readyState: 1 };
    snapshot(100, 30);
    assert.equal(sent.length, before[0] + 1, 'the pending size is sent once after the new snapshot');
    snapshot(100, 30);
    assert.equal(sent.length, before[0] + 1, 'later snapshots do not take the size again');
  }

  view.place();
  view.el.isConnected = false;
  const before = [sent.length, resized.length];
  parsed();
  assert.deepEqual([sent.length, resized.length], before, 'a pane closed before parsing finishes cannot resize the shared terminal');
  view.mount(host, { focus: false });
  parsed();
  assert.equal(sent.length, before[0] + 1);

  view.place();
  view.disposed = true;
  const disposed = [sent.length, resized.length];
  parsed();
  assert.deepEqual([sent.length, resized.length], disposed);
});

test('cursor following respects manual panning, history, selection and typing focus', () => {
  const source = app.match(/  revealCursor\([^]*?\n  \}/)?.[0];
  assert.ok(source);
  const { context } = page();
  const buffer = { cursorY: 4, viewportY: 0, baseY: 0 };
  const host = { scrollTop: 0, clientHeight: 100, getBoundingClientRect: () => ({ top: 0 }) };
  const textarea = {};
  let selected = false;
  Object.assign(context, { revealRow, document: { activeElement: textarea } });
  context.state.activeId = plain.id;
  const view = Object.assign(runInNewContext(`({${source}})`, context), {
    id: plain.id,
    term: { buffer: { active: buffer }, textarea, hasSelection: () => selected },
    el: {
      isConnected: true, parentElement: host,
      querySelector: () => ({ firstElementChild: { offsetHeight: 17 } }),
      getBoundingClientRect: () => ({ top: -host.scrollTop }),
    },
  });
  view.revealCursor();
  assert.equal(host.scrollTop, 0);
  buffer.cursorY = 5;
  view.revealCursor();
  assert.equal(host.scrollTop, 2, 'only the clipped part of the new cursor row is revealed');
  buffer.cursorY = 6;
  view.revealCursor();
  assert.equal(host.scrollTop, 19);

  host.scrollTop = 0;
  buffer.cursorY = 7;
  view.revealCursor();
  assert.equal(host.scrollTop, 0, 'output does not undo a manual pan away from the cursor');
  view.revealCursor(true);
  assert.equal(host.scrollTop, 36, 'typing resumes following');

  for (const blocked of ['history', 'selection', 'blur', 'other pane', 'unmounted', 'disposed']) {
    host.scrollTop = 0;
    buffer.baseY = blocked === 'history' ? 10 : 0;
    selected = blocked === 'selection';
    context.document.activeElement = blocked === 'blur' ? null : textarea;
    context.state.activeId = blocked === 'other pane' ? 'other' : plain.id;
    view.el.isConnected = blocked !== 'unmounted';
    view.disposed = blocked === 'disposed';
    view.revealCursor(true);
    assert.equal(host.scrollTop, 0, blocked);
  }
});

test('a touch drag pans a terminal larger than its pane before scrolling the terminal\'s own history', () => {
  const source = app.match(/  enableTouchScroll\(\) \{[^]*?\n  \}/)?.[0];
  assert.ok(source, 'enableTouchScroll is present');
  const { context } = page();
  const handlers = {};
  const scrolled = [];
  const host = { scrollLeft: 0, scrollTop: 0, scrollHeight: 900, clientHeight: 300 };
  const view = Object.assign(runInNewContext(`({${source}})`, context), {
    el: { parentElement: host, addEventListener: (type, fn) => { handlers[type] = fn; }, querySelector: () => null },
    term: { buffer: { active: { type: 'normal' } }, modes: { mouseTrackingMode: 'none' }, scrollLines: (n) => scrolled.push(n) },
  });
  view.enableTouchScroll();
  const touch = (type, x, y) => handlers[type]({ touches: [{ clientX: x, clientY: y }], preventDefault() {} });

  touch('touchstart', 100, 500);
  touch('touchmove', 60, 400);
  assert.deepEqual([host.scrollLeft, host.scrollTop, scrolled], [40, 100, []], 'the pane pans to the rows and columns it clips');
  touch('touchmove', 60, 0);
  assert.deepEqual([host.scrollTop, scrolled], [500, [], ], 'and stops where it ends');
  touch('touchmove', 60, -170);
  assert.deepEqual([host.scrollTop, scrolled], [600, []], 'the last of the pane is reached first');
  touch('touchmove', 60, -340);
  assert.deepEqual([host.scrollTop, scrolled], [600, [10]], 'then the terminal\'s history scrolls');
  touch('touchmove', 60, -300);
  assert.deepEqual([host.scrollTop, scrolled], [560, [10]], 'dragging back pans the pane again');
});
