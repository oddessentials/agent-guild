import { test } from 'node:test';
import assert from 'node:assert/strict';
import pty from 'node-pty';
import { Session } from '../src/manager/session.mjs';

// Exercise the real session state machine without PTY startup or wall-clock races.
function createSession(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(pty, 'spawn', () => ({
    pid: 0, onData() {}, onExit() {}, write() {}, resize() {}, kill() {},
  }));
  const session = new Session({
    id: 'shell-test', provider: { id: 'fake', tool: 'Fake Tool' },
    spawnSpec: { file: 'mocked-pty', args: [] },
    cwd: process.cwd(), env: {}, cols: 80, rows: 24, reportToken: 'test',
  });
  t.after(() => session.dispose());
  return session;
}

test('shell display delay has an exact boundary and ended commands never flash later', (t) => {
  const session = createSession(t);
  const seen = [];
  session.on('changed', () => seen.push(session.toJSON().shells.length));
  session.reportShell({ shell: 'start', key: 'quick' });
  t.mock.timers.tick(150);
  session.reportShell({ shell: 'end', key: 'quick' });
  t.mock.timers.tick(1000);
  assert.equal(session.toJSON().shells.length, 0);
  assert.ok(seen.every((count) => count === 0), 'no event ever displays the brief command');

  session.reportShell({ shell: 'start', key: 'long' });
  t.mock.timers.tick(599);
  assert.equal(session.toJSON().shells.length, 0);
  t.mock.timers.tick(1);
  assert.equal(session.toJSON().shells.length, 1);
  session.reportShell({ shell: 'end', key: 'long' });
  assert.equal(session.toJSON().shells.length, 0, 'removed without a lingering timer');
  assert.deepEqual(seen, [1, 0], 'only the long command emits display changes');
  t.mock.timers.tick(10000);
  assert.equal(session.toJSON().shells.length, 0);
});

test('waiting cancels display until background approval, and reset cancels pending displays', (t) => {
  const session = createSession(t);
  const match = 'a'.repeat(32);
  session.reportShell({ shell: 'start', key: 'permission', match });
  t.mock.timers.tick(599);
  session.reportShell({ shell: 'waiting', match });
  t.mock.timers.tick(10000);
  assert.equal(session.toJSON().shells.length, 0);
  session.reportShell({ shell: 'background', key: 'permission', task: 'task' });
  t.mock.timers.tick(599);
  assert.equal(session.toJSON().shells.length, 0);
  t.mock.timers.tick(1);
  assert.equal(session.toJSON().shells.length, 1);

  session.reportShell({ shell: 'start', key: 'pending' });
  session.reportShell({ shell: 'reset' });
  t.mock.timers.tick(10000);
  assert.equal(session.shells.size, 0);
  assert.equal(session.toJSON().shells.length, 0);
});

test('a session shows each shell command from its start until its end, whatever reports that end', (t) => {
  const session = createSession(t);
  const report = (r) => session.reportShell(r);
  const drawn = () => { t.mock.timers.tick(600); return session.toJSON().shells.length; };
  const keys = () => [...session.shells.values()].map((sh) => sh.key).sort();
  const m = (n) => String(n).repeat(32);

  report({ shell: 'start', key: 'k1', match: m(1) });
  assert.equal(drawn(), 1);
  report({ shell: 'end', key: 'k1' });
  assert.equal(drawn(), 0);

  report({ shell: 'start', key: 'k2', match: m(2) });
  report({ shell: 'waiting', match: m(2) });
  assert.equal(drawn(), 0, 'hidden while it waits for permission');
  report({ shell: 'background', key: 'k2', task: 't2' });
  assert.equal(drawn(), 1, 'running in the background, so drawn again');
  report({ shell: 'running', tasks: [] });
  assert.equal(drawn(), 0, 'a task the tool no longer lists has ended');
  report({ shell: 'running', tasks: ['t2', 't3'] });
  assert.equal(session.toJSON().shells.length, 1, 'an ended task never comes back; one not seen before is drawn at once');
  report({ shell: 'end', task: 't3' });
  report({ shell: 'end', task: 't4' });
  report({ shell: 'running', tasks: ['t4'] });
  assert.equal(drawn(), 0, 'nor one whose end came before the list');

  report({ shell: 'start', key: 'c1', match: m(3), persist: true });
  report({ shell: 'start', key: 'c2', match: m(4), persist: true });
  report({ shell: 'start', key: 'f1', match: m(5) });
  report({ shell: 'asked', match: m(4) });
  assert.equal(drawn(), 3, 'a permission request that hides nothing');
  session.reportAgent({ finishForeground: true });
  assert.deepEqual(keys(), ['c1'], 'past its turn, only a command that persists and was not asked about');
  report({ shell: 'reset' });
  assert.equal(drawn(), 0);

  session.reportAgent({ agentId: 'hook-a', name: 'Explore', status: 'working' });
  report({ shell: 'start', key: 's1', agentId: 'hook-a' });
  report({ shell: 'start', key: 's2', agentId: 'hook-a' });
  report({ shell: 'background', key: 's2', task: 'ts2', endsWithAgent: true });
  report({ shell: 'start', key: 's3', agentId: 'hook-a' });
  report({ shell: 'background', key: 's3', task: 'ts3' });
  report({ shell: 'start', key: 'main' });
  session.reportAgent({ agentId: 'hook-a', status: 'done' });
  assert.deepEqual(keys(), ['main', 's3'], 'a sub-agent\'s end takes its commands, but not one that outlives it');
  report({ shell: 'end', task: 'ts3' });
  report({ shell: 'end', key: 'main' });
  report({ shell: 'start', key: 'h1', agentId: 'hook-helper' });
  session.reportAgent({ agentId: 'hook-helper', status: 'done' });
  assert.equal(session.shells.size, 0, 'so does the end of one never seen starting');

  report({ shell: 'start', key: 'x1', match: m(6) });
  report({ shell: 'start', key: 'x2', match: m(6) });
  report({ shell: 'waiting', match: m(6) });
  assert.equal(drawn(), 2, 'a request that could be either of two identical commands hides neither');
  report({ shell: 'end', key: 'x1' });
  report({ shell: 'waiting', match: m(7) });
  assert.equal(drawn(), 0, 'a rewritten request goes to the only command left');
  report({ shell: 'end', key: 'x2' });

  assert.throws(() => report({ shell: 'start' }), /needs a key/);
  assert.throws(() => report({ shell: 'background', key: 'k9' }), /needs a task/);
  assert.throws(() => report({ shell: 'running' }), /tasks array/);
  assert.throws(() => report({ shell: 'end' }), /key or a task/);
});
