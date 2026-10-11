import { test } from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import pty from 'node-pty';
import { Session } from '../src/manager/session.mjs';

function createSession(t) {
  let onData;
  const resizes = [];
  const child = {
    pid: 0,
    onData(fn) { onData = fn; },
    onExit() {},
    write() {},
    resize(cols, rows) { resizes.push(`${cols}x${rows}`); },
    kill() {},
  };
  t.mock.method(pty, 'spawn', () => child);
  const session = new Session({
    id: 'size-session',
    provider: { id: 'fake', vendor: 'Test', tool: 'Fake Tool' },
    spawnSpec: { file: 'mocked-pty', args: [] },
    cwd: process.cwd(), env: {}, cols: 80, rows: 24, reportToken: 'test',
  });
  t.after(() => session.dispose());
  const viewer = (page) => {
    const messages = [];
    const detach = session.attach((message) => messages.push(message), { page });
    return { messages, detach, sizes: () => messages.filter((m) => m.type === 'resize').map((m) => `${m.cols}x${m.rows} ${m.generation} ${m.owner}`) };
  };
  return { session, resizes, viewer, output: (data) => onData(data) };
}

const parsed = (session) => new Promise((resolve) => session.term.write('', resolve));

test('only the page that last claimed a terminal sizes it, and only under its latest claim', async (t) => {
  const { session, resizes, viewer } = createSession(t);
  const desk = viewer('desk');
  const phone = viewer('phone');
  const watcher = viewer(null);
  await parsed(session);
  assert.deepEqual([desk, phone, watcher].map((v) => [v.messages[0].owner, v.messages[0].generation]), [[false, 0], [false, 0], [false, 0]]);

  assert.equal(session.resizeFrom('desk', 0, 100, 30), false, 'a page that never claimed cannot resize');
  assert.deepEqual(desk.sizes(), ['80x24 0 false'], 'and is answered with the current size, so it does not wait forever');
  assert.deepEqual([phone.sizes(), watcher.sizes()], [[], []]);
  assert.equal(session.claimSize(null, 100, 30), false, 'a viewer with no page cannot claim');
  assert.equal(session.claimSize('desk', 100, 30), true);
  assert.deepEqual(desk.sizes(), ['80x24 0 false', '100x30 1 true']);
  assert.deepEqual(phone.sizes(), ['100x30 1 false']);
  assert.deepEqual(watcher.sizes(), ['100x30 1 false']);

  assert.equal(session.resizeFrom('desk', 1, 110, 30), true);
  assert.equal(session.claimSize('phone', 40, 20), true);
  assert.equal(session.resizeFrom('desk', 1, 120, 40), false, 'the previous owner\'s resize is refused');
  assert.equal(session.claimSize('desk', 100, 30), true);
  assert.equal(session.resizeFrom('desk', 2, 130, 40), false, 'so is a resize sent before the owner\'s latest claim');
  assert.equal(session.resizeFrom('desk', 3, 100, 30), true, 'an unchanged size is still answered');
  assert.deepEqual(desk.sizes(), ['80x24 0 false', '100x30 1 true', '110x30 1 true', '40x20 2 false', '40x20 2 false', '100x30 3 true', '100x30 3 true', '100x30 3 true']);
  assert.deepEqual(resizes, ['100x30', '110x30', '40x20', '100x30'], 'the PTY is resized only when its size changes');

  desk.detach();
  phone.detach();
  assert.equal(`${session.cols}x${session.rows}`, '100x30', 'the size outlives its owner\'s connection');
  const back = viewer('desk');
  const reload = viewer('desk-reloaded');
  await parsed(session);
  assert.deepEqual([back.messages[0].owner, back.messages[0].generation], [true, 3], 'the owner\'s page keeps the size when it reconnects');
  assert.deepEqual([reload.messages[0].owner, reload.messages[0].cols], [false, 100], 'a reloaded page only watches');
  assert.equal(session.resizeFrom('desk-reloaded', 3, 90, 30), false);
  assert.equal(session.resizeFrom('desk', 3, 90, 30), true);
});

test('the mirror applies a resize after the output that came before it', async (t) => {
  const { session, viewer, output } = createSession(t);
  const reference = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const screen = (term) => {
    const lines = [];
    for (let y = 0; y < term.buffer.active.length; y++) lines.push(term.buffer.active.getLine(y).translateToString(true));
    return { lines, cursor: [term.buffer.active.cursorX, term.buffer.active.cursorY] };
  };
  const mark = 'line one\r\n\x1b[1;70HX';
  output(mark);
  session.claimSize('desk', 40, 24);
  await new Promise((resolve) => reference.write(mark, resolve));
  reference.resize(40, 24);
  await parsed(session);
  assert.deepEqual(screen(session.term), screen(reference));
  const fresh = viewer('phone');
  await parsed(session);
  assert.equal(fresh.messages[0].cols, 40);
  reference.dispose();
});
