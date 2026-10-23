import { test } from 'node:test';
import assert from 'node:assert/strict';
import pty from 'node-pty';
import { Session } from '../src/manager/session.mjs';

// A session whose process is a stub: every write it receives, by process, and a way to end that process.
function createSession(t) {
  const processes = [];
  t.mock.method(pty, 'spawn', () => {
    const child = { pid: 0, writes: [], onData() {}, onExit(fn) { child.exit = fn; }, write(data) { child.writes.push(data); }, resize() {}, kill() {} };
    processes.push(child);
    return child;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const session = new Session({
    id: 'send-session',
    provider: { id: 'fake', vendor: 'Test', tool: 'Fake Tool' },
    spawnSpec: { file: 'mocked-pty', args: [] },
    cwd: process.cwd(), env: {}, cols: 80, rows: 24, reportToken: 'test',
  });
  t.after(() => session.dispose());
  // Mocked timers fire at once on a tick; what a send does after its timer runs a turn later.
  const settle = () => new Promise(setImmediate);
  const tick = async (ms) => { t.mock.timers.tick(ms); await settle(); };
  /** A send, followed from its start: state is 'pending', 'sent', or [status, code] once refused. */
  const track = (sending) => {
    const send = { state: 'pending' };
    sending.then(() => { send.state = 'sent'; }, (err) => { send.state = [err.status, err.code]; });
    return send;
  };
  return { session, processes, settle, tick, track };
}

test('send presses Enter 250 ms after the text, as a person would', async (t) => {
  const { session, processes: [child], tick, track } = createSession(t);
  const send = track(session.send('run the tests'));
  assert.deepEqual(child.writes, ['run the tests']);
  await tick(249);
  assert.deepEqual([child.writes, send.state], [['run the tests'], 'pending']);
  await tick(1);
  assert.deepEqual([child.writes, send.state], [['run the tests', '\r'], 'sent']);
});

test('other input during the wait leaves the text unsubmitted, and says so', async (t) => {
  const { session, processes: [child], tick, track } = createSession(t);
  const send = track(session.send('run the tests'));
  session.input('x');
  await tick(250);
  assert.deepEqual([child.writes, send.state], [['run the tests', 'x'], [409, 'input_interrupted']]);
});

test('a second send while one waits is refused, and the first still submits alone', async (t) => {
  const { session, processes: [child], settle, tick, track } = createSession(t);
  const first = track(session.send('first'));
  const second = track(session.send('second'));
  await settle();
  assert.deepEqual(second.state, [409, 'send_in_progress']);
  await tick(250);
  assert.deepEqual([child.writes, first.state], [['first', '\r'], 'sent']);
  const third = track(session.send('third'));
  await tick(250);
  assert.deepEqual([child.writes, third.state], [['first', '\r', 'third', '\r'], 'sent'], 'a finished send frees the session');
});

test('Enter never reaches a process that exited, or the one that replaced it, during the wait', async (t) => {
  const { session, processes, settle, tick, track } = createSession(t);
  const exited = track(session.send('one'));
  processes[0].exit({ exitCode: 0 });
  await tick(250);
  assert.deepEqual(exited.state, [409, 'session_exited']);
  const late = track(session.send('two'));
  await settle();
  assert.deepEqual(late.state, [409, 'session_exited'], 'an exited session takes no text, at once');

  // A reattached tmux or herdr card runs a new process under the same session.
  session.reattach({ file: 'mocked-pty', args: [] });
  const replaced = track(session.send('three'));
  processes[1].exit({ exitCode: 0 });
  session.reattach({ file: 'mocked-pty', args: [] });
  await tick(250);
  assert.deepEqual(replaced.state, [409, 'session_exited']);
  assert.deepEqual(processes.map((p) => p.writes), [['one'], ['three'], []], 'no Enter in any run');
});
