import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { waitForTerminalReady } from './fixtures/terminal-ready.mjs';

const send = (socket, message) => socket.emit('message', Buffer.from(JSON.stringify(message)));
const snapshot = (data = '', status = 'running') => ({
  type: 'snapshot', data, session: { status, pid: null, exitCode: status === 'exited' ? -1 : null, signal: null },
});

test('readiness waits for output, however late it arrives, including split Windows control sequences', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const socket = new EventEmitter();
  let ready = false;
  const waiting = waitForTerminalReady(socket).then(() => { ready = true; });
  send(socket, snapshot());
  // Longer than the old PID-polling budget, without sleeping or starting a process.
  t.mock.timers.tick(6000);
  await Promise.resolve();
  assert.equal(ready, false, 'time passing cannot make a terminal ready');
  send(socket, { type: 'data', data: 'FAKE-TOOL \x1b[' });
  send(socket, { type: 'data', data: '0mREA' });
  await Promise.resolve();
  assert.equal(ready, false, 'a partial banner is not readiness');
  send(socket, { type: 'data', data: 'DY cwd=test\r\n' });
  await waiting;
  assert.equal(ready, true);
  assert.deepEqual(socket.eventNames(), [], 'observers are removed after success');
  t.mock.timers.runAll();
});

test('readiness accepts a running snapshot but rejects an exited snapshot even when its banner is present', async () => {
  const running = new EventEmitter();
  const ready = waitForTerminalReady(running);
  send(running, snapshot('FAKE-TOOL READY cwd=test'));
  await ready;
  assert.deepEqual(running.eventNames(), []);

  const exited = new EventEmitter();
  const failure = assert.rejects(waitForTerminalReady(exited), /exited before readiness: exitCode=-1.*\nTerminal output: .*FAKE-TOOL READY/);
  send(exited, snapshot('FAKE-TOOL READY cwd=test', 'exited'));
  await failure;
  assert.deepEqual(exited.eventNames(), []);
});

test('startup exits and broken connections fail immediately with the available output', async () => {
  for (const [event, value, reason] of [
    ['message', { type: 'exit', exitCode: 7, signal: null }, /exited before readiness: exitCode=7/],
    ['close', 1006, /socket closed before readiness: code=1006/],
    ['error', new Error('connection refused'), /socket error: connection refused/],
  ]) {
    const socket = new EventEmitter();
    const failure = assert.rejects(waitForTerminalReady(socket), (error) => {
      assert.match(error.message, reason);
      assert.match(error.message, /startup diagnostic/);
      return true;
    });
    send(socket, snapshot('startup diagnostic'));
    if (event === 'message') send(socket, value);
    else socket.emit(event, value);
    await failure;
    assert.deepEqual(socket.eventNames(), [], 'observers are removed after failure');
  }
});

test('a silent terminal has a bounded deadline with its last output', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const socket = new EventEmitter();
  const failure = assert.rejects(waitForTerminalReady(socket), /Timed out waiting.*\nTerminal output: "still starting"/);
  send(socket, snapshot('still starting'));
  t.mock.timers.tick(10000);
  await failure;
  assert.deepEqual(socket.eventNames(), []);
});
