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
    reader: null, replies: new Map(), renderRead: () => {},
    isSessionWorking,
    state: { sessions: new Map() },
    renderSessions() {}, noticeClone() {}, dropSession() {}, renderAccountsDialog() {},
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
        followSize() {}, layoutChanged() {},
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

function sizingView() {
  const methods = ['connect', 'onMessage', 'showLink', 'claim', 'followSize', 'layoutChanged', 'fitHere', 'scaleToSize', 'measure', 'sizedElsewhere'].map((name) => {
    const found = app.match(new RegExp(`  ${name}\\([^]*?\\n  \\}`))?.[0];
    assert.ok(found, `${name} is present`);
    return found;
  }).join(',\n');
  const { context } = page();
  const ui = { keyboard: false, dragging: false };
  Object.assign(context, {
    WebSocket: Object.assign(class { readyState = 1; }, { OPEN: 1, CLOSING: 2 }),
    wsUrl: (path) => `ws://manager${path}?token=t`, PAGE_ID: 'page', clearTimeout() {},
    terminalControls: { refresh() {} }, dictation: null, paintSizeNote() {},
    terminalFontSize: 14, TERMINAL_FONT_MIN: 9, TERMINAL_SCALE_MIN: 0.8, TERMINAL_COLS_MAX: 1000, TERMINAL_ROWS_MAX: 500,
    terminalKeyboardShown: () => ui.keyboard,
    document: { documentElement: { classList: { contains: (name) => name === 'resizing' && ui.dragging } } },
  });
  const sent = [], callbacks = [];
  // The pane holds 1400x700 px; a cell is 0.6em wide and 1.2em tall.
  const pane = { width: 1400, height: 700 };
  const term = {
    cols: 120, rows: 32, options: { fontSize: 14 },
    reset() {}, focus() {},
    resize(cols, rows) { Object.assign(this, { cols, rows }); },
    write(_data, callback) { if (callback) callbacks.push(callback); },
  };
  const fit = { proposeDimensions: () => ({ cols: Math.floor(pane.width / (term.options.fontSize * 0.6)), rows: Math.floor(pane.height / (term.options.fontSize * 1.2)) }) };
  const view = Object.assign(runInNewContext(`({${methods}})`, context), {
    id: plain.id, ws: { readyState: 1 }, status: { hidden: false }, statusLabel: { textContent: '' },
    term, fit, el: { isConnected: true, parentElement: { style: {} } }, size: null, owner: false, generation: 0, claiming: false, sizing: false,
    send: (message) => sent.push(message.type === 'claim' ? `claim ${message.cols}x${message.rows}` : `resize ${message.generation} ${message.cols}x${message.rows}`),
  });
  const parsed = () => { while (callbacks.length) callbacks.shift()(); };
  const snapshot = (cols, rows, owner, generation) => { view.onMessage({ type: 'snapshot', session: { ...plain }, data: '', cols, rows, owner, generation }); parsed(); };
  const resized = (cols, rows, owner, generation) => { view.onMessage({ type: 'resize', cols, rows, owner, generation }); parsed(); };
  return { context, ui, view, term, pane, sent, parsed, snapshot, resized };
}

test('a terminal is sized only by the page that claimed it, and other pages scale it to fit', () => {
  const { ui, view, term, pane, sent, parsed, snapshot, resized } = sizingView();
  const fitted = [Math.floor(1400 / (14 * 0.6)), Math.floor(700 / (14 * 1.2))].join('x');

  snapshot(120, 32, false, 0);
  assert.deepEqual(sent, [], 'a restored or reloaded page only watches');
  assert.equal(view.sizedElsewhere(), true, 'and says the terminal is sized for another screen');

  view.claim();
  assert.deepEqual(sent, [`claim ${fitted}`], 'opening it takes this pane\'s size');
  view.claim();
  view.layoutChanged();
  assert.equal(sent.length, 1, 'nothing more is sent until the manager answers');
  resized(166, 41, true, 1);
  assert.equal(`${term.cols}x${term.rows}`, '166x41');
  assert.deepEqual(sent, [`claim ${fitted}`, 'claim 166x41'], 'a second open while the first was answered claims again');
  resized(166, 41, true, 2);
  assert.equal(view.sizedElsewhere(), false);

  pane.width = 1000;
  view.layoutChanged();
  assert.deepEqual(sent.at(-1), 'resize 2 119x41', 'the owner\'s layout refits it, under its latest claim');
  pane.width = 900;
  view.layoutChanged();
  assert.equal(sent.length, 3, 'one resize at a time');
  resized(119, 41, true, 2);
  assert.deepEqual(sent.at(-1), 'resize 2 107x41', 'the next goes once the first is answered');
  resized(107, 41, true, 2);
  view.layoutChanged();
  assert.equal(sent.length, 4, 'an unchanged grid sends nothing');

  ui.keyboard = true;
  pane.height = 300;
  view.layoutChanged();
  ui.dragging = true;
  ui.keyboard = false;
  view.layoutChanged();
  assert.equal(sent.length, 4, 'neither an on-screen keyboard nor a drag in progress resizes it');
  ui.dragging = false;
  pane.height = 700;
  view.layoutChanged();
  assert.equal(sent.length, 4);

  snapshot(107, 41, true, 2);
  assert.equal(sent.length, 4, 'a reconnection of the owner sends nothing when its pane is unchanged');
  pane.width = 1400;
  snapshot(107, 41, true, 2);
  assert.deepEqual(sent.at(-1), 'resize 2 166x41', 'and fits a pane that changed while it was away');
  resized(80, 24, false, 3);
  assert.equal(term.options.fontSize, 14, 'another page\'s smaller terminal keeps this page\'s text size');
  pane.width = 600;
  view.layoutChanged();
  assert.equal(sent.length, 5, 'a page that lost the size never resizes it');
  assert.equal(term.options.fontSize, 12, 'a terminal wider than the pane shrinks the text until it fits');
  resized(200, 60, false, 3);
  assert.equal(term.options.fontSize, 11, 'but not below the readable limit');
  assert.equal(view.sizedElsewhere(), true);

  view.ws = { readyState: 1 };
  view.onMessage({ type: 'resize', cols: 50, rows: 10, owner: true, generation: 9 });
  view.ws = { readyState: 1 };
  parsed();
  assert.equal(`${term.cols}x${term.rows}`, '200x60', 'a size from a link that ended cannot reach the next link\'s screen');
});

test('terminal sizing never waits forever: an older manager, a reconnection, an oversized pane; text size applies offline', () => {
  const legacy = sizingView();
  legacy.snapshot(120, 32);
  legacy.view.claim();
  legacy.view.claim();
  assert.deepEqual(legacy.sent, ['resize undefined 166x41', 'resize undefined 166x41'], 'a manager without size ownership gets a plain resize, and nothing waits for its answer');

  const { context, view, term, pane, sent, snapshot, resized } = sizingView();
  snapshot(120, 32, false, 0);
  view.claim();
  resized(166, 41, true, 1);
  view.connect();
  pane.width = 1000;
  view.layoutChanged();
  snapshot(80, 24, false, 2);
  assert.deepEqual(sent, ['claim 166x41'], 'nothing is sent between reconnecting and the new screen, and a page that lost the size meanwhile only watches');
  view.claim();
  assert.deepEqual(sent.at(-1), 'claim 119x41', 'opening it there again takes the size back');
  resized(119, 41, true, 3);

  pane.width = 9000;
  view.layoutChanged();
  resized(1000, 41, true, 3);
  view.layoutChanged();
  assert.deepEqual(sent.slice(2), ['resize 3 1000x41'], 'a pane wider than the manager allows asks once for the widest terminal');

  view.ws = { readyState: 3 };
  context.terminalFontSize = 18;
  view.layoutChanged();
  assert.equal(term.options.fontSize, 18, 'a text size chosen while disconnected applies at once');
  assert.equal(sent.length, 3);
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

  let top = 316.8888854980469;
  Object.defineProperties(host, {
    scrollHeight: { value: 744 }, clientHeight: { value: 427 },
    scrollTop: { get: () => top, set: (value) => { top = Math.min(316.8888854980469, Math.max(0, value)); } },
  });
  touch('touchstart', 60, 500);
  touch('touchmove', 60, 330);
  assert.deepEqual(scrolled, [10, 10], 'a sliver of room the pane cannot scroll into does not stop the history scrolling');
});
