import { test } from 'node:test';
import assert from 'node:assert/strict';
import pty from 'node-pty';
import { Session } from '../src/manager/session.mjs';

// The Windows path of Session.kill, on any host: a mocked pty, and a tree kill that answers as taskkill would.
function windowsSession(t, answer, { pid = 4242 } = {}) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const child = { pid, ptyKills: 0, onData() {}, onExit() {}, write() {}, resize() {}, kill() { this.ptyKills++; } };
  t.mock.method(pty, 'spawn', () => child);
  const treeKills = [];
  const session = new Session({
    id: 'kill-test', provider: { id: 'fake', vendor: 'Test', tool: 'Fake Tool' }, spawnSpec: { file: 'mocked-pty', args: [] },
    cwd: process.cwd(), env: {}, cols: 80, rows: 24, reportToken: 'test',
    killTree: (pid, done) => { treeKills.push(pid); done(answer()); },
  });
  return { session, child, treeKills };
}

test('a Windows session asked to stop again while its process is ending ends its tree once', (t) => {
  const { session, child, treeKills } = windowsSession(t, () => null);
  session.kill();
  session.kill();
  session.dispose();
  assert.deepEqual([treeKills, child.ptyKills], [[4242], 0]);
});

test('a Windows process taskkill no longer finds is never ended again through its console', (t) => {
  const notFound = Object.assign(new Error('Command failed: taskkill /PID 4242 /T /F'), { code: 128 });
  const { session, child, treeKills } = windowsSession(t, () => notFound);
  session.kill();
  assert.deepEqual([treeKills, child.ptyKills], [[4242], 0], 'node-pty would list and end every process on the console the pid now belongs to');
  const denied = Object.assign(new Error('Command failed: taskkill /PID 4242 /T /F'), { code: 1 });
  const other = windowsSession(t, () => denied);
  other.session.kill();
  assert.equal(other.child.ptyKills, 1, 'any other failure still falls back to the pty');
});

test('a Windows session stopped and closed before its pty is ready asks node-pty to kill it once', (t) => {
  const { session, child, treeKills } = windowsSession(t, () => null, { pid: 0 });
  session.kill();
  session.dispose();
  assert.deepEqual([treeKills, child.ptyKills], [[], 1], 'a second node-pty kill closes the same pseudoconsole twice');
});
