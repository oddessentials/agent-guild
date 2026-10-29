import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import pty from 'node-pty';
import { Session } from '../src/manager/session.mjs';
import { SessionManager } from '../src/manager/session-manager.mjs';
import { releasePty } from '../src/manager/pty.mjs';

const provider = { id: 'fake', vendor: 'Test', tool: 'Fake Tool' };

function onWindows(t) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
}

// node-pty's Windows terminal as Session sees it: kill() and close calls wait until the terminal is ready, and every
// read of its pid, every public kill() and every native close is counted.
function fakeTerminals(t) {
  const terminals = [];
  t.mock.method(pty, 'spawn', () => {
    const term = {
      ready: false, queued: [], pidReads: 0, publicKills: 0, closes: 0, exit: null,
      get pid() { this.pidReads++; return this.ready ? 4242 : 0; },
      onData() {}, onExit(fn) { this.exit = fn; }, write() {}, resize() {},
      kill() { this.publicKills++; },
      _deferNoArgs(fn) { if (this.ready) fn(); else this.queued.push(fn); },
      _close() {},
      becomeReady() { this.ready = true; for (const fn of this.queued.splice(0)) fn(); },
    };
    const socket = () => ({ readable: true, destroyed: false, destroy() { this.destroyed = true; } });
    term._agent = {
      _pty: 7, _inSocket: socket(), _outSocket: socket(), _pendingPtyInfo: {}, _clearConnectionTimeout() {},
      _ptyNative: { kill: (id, useConptyDll) => { assert.deepEqual([id, useConptyDll], [7, false]); term.closes++; } },
      _conoutSocketWorker: { disposed: 0, dispose() { this.disposed++; } },
    };
    terminals.push(term);
    return term;
  });
  return terminals;
}

function windowsSession(t) {
  onWindows(t);
  const terminals = fakeTerminals(t);
  const session = new Session({ id: 'kill-test', provider, spawnSpec: { file: 'mocked-pty', args: [] }, cwd: process.cwd(), env: {}, cols: 80, rows: 24, reportToken: 'test' });
  return { session, terminals };
}

test('a Windows session is ended once, by closing its console through node-pty, never by pid or node-pty\'s kill()', (t) => {
  const { session, terminals: [term] } = windowsSession(t);
  term.becomeReady();
  const reads = term.pidReads;
  session.kill();
  session.kill();
  session.dispose();
  assert.deepEqual([term.closes, term.publicKills, term.pidReads - reads], [1, 0, 0]);
  assert.deepEqual([term._agent._inSocket.destroyed, term._agent._conoutSocketWorker.disposed], [true, 1], 'the input pipe and the output worker are released');
});

test('a Windows session stopped while starting is closed once, when node-pty is ready to close it', (t) => {
  const { session, terminals: [term] } = windowsSession(t);
  session.kill();
  session.dispose();
  assert.equal(term.closes, 0, 'nothing is closed before the console is connected');
  term.becomeReady();
  assert.deepEqual([term.closes, term.publicKills], [1, 0]);
});

test('a Windows session that exited by itself is not closed again', (t) => {
  const { session, terminals: [term] } = windowsSession(t);
  term.becomeReady();
  term.exit({ exitCode: 0 });
  session.kill();
  session.dispose();
  assert.equal(term.closes, 0);
});

test('a reattached Windows session is closed once on its new pty, and the old one is not touched again', (t) => {
  const { session, terminals } = windowsSession(t);
  terminals[0].becomeReady();
  session.kill();
  terminals[0].exit({ exitCode: 1 });
  session.reattach({ file: 'mocked-pty', args: [] });
  terminals[1].becomeReady();
  session.kill();
  session.kill();
  assert.deepEqual([terminals.length, terminals[0].closes, terminals[1].closes], [2, 1, 1]);
});

test('Stop, Remove and shutdown together close a Windows session\'s console once, whoever asks', async (t) => {
  onWindows(t);
  const terminals = fakeTerminals(t);
  const tool = { id: 'tool', tool: 'Tool', args: [], accounts: [{ id: 'default' }] };
  const registry = {
    get: () => tool, account: () => ({ id: 'default', label: 'Default' }), describe: () => tool,
    shellFor: () => null, shellsFor: () => ({ shells: [] }), spawnSpec: () => ({ file: 'tool', args: [] }),
  };
  const manager = new SessionManager({ registry, baseEnv: {}, getApiUrl: () => '' });
  const session = await manager.create({ providerId: 'tool', cwd: os.tmpdir() });
  terminals[0].becomeReady();
  manager.stop(session.id);
  manager.stop(session.id);
  manager.remove(session.id);
  const shutdown = manager.shutdown({ graceMs: 0, timeoutMs: 0 });
  terminals[0].exit({ exitCode: 1 });
  await shutdown;
  assert.deepEqual([terminals[0].closes, terminals[0].publicKills], [1, 0]);
});

// ---- the real inbox ConPTY ----------------------------------------------------------------------

const windows = { skip: process.platform !== 'win32' && 'Windows only' };

// Counts every process started through child_process, by node-pty's console-list helper or by taskkill.
function countSpawns(t) {
  const counts = { fork: 0, execFile: 0, spawn: 0 };
  for (const name of Object.keys(counts)) {
    const original = childProcess[name];
    childProcess[name] = (...args) => { counts[name]++; return original(...args); };
    t.after(() => { childProcess[name] = original; syncBuiltinESMExports(); });
  }
  syncBuiltinESMExports();
  return counts;
}

function realSession(t, file, args) {
  const session = new Session({ id: `real-${Math.random()}`, provider, spawnSpec: { file, args }, cwd: process.cwd(), env: process.env, cols: 80, rows: 24, reportToken: 'test' });
  t.after(() => session.dispose());
  let output = '';
  const waiting = [];
  session.attach((message) => {
    if (message.type !== 'data') return;
    output += message.data;
    for (const w of waiting.filter((w) => w.pattern.test(output))) { waiting.splice(waiting.indexOf(w), 1); w.resolve(output.match(w.pattern)); }
  });
  const until = (pattern) => new Promise((resolve) => (pattern.test(output) ? resolve(output.match(pattern)) : waiting.push({ pattern, resolve })));
  const agent = session.pty._agent;
  const workerExited = new Promise((resolve) => agent._conoutSocketWorker._worker.once('exit', resolve));
  return { session, until, agent, workerExited };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('node-pty still has the parts closeConsole uses', windows, async () => {
  const term = pty.spawn('cmd.exe', ['/c', 'exit'], { useConpty: true });
  const exited = new Promise((resolve) => term.onExit(resolve));
  const agent = term._agent;
  for (const [what, value] of Object.entries({ _deferNoArgs: term._deferNoArgs, _close: term._close, _clearConnectionTimeout: agent._clearConnectionTimeout,
    native: agent._ptyNative?.kill, dispose: agent._conoutSocketWorker?.dispose, destroy: agent._inSocket?.destroy })) assert.equal(typeof value, 'function', what);
  assert.equal(typeof agent._pty, 'number');
  assert.equal(typeof agent._outSocket?.destroy, 'function');
  await exited;
  releasePty(term);
});

test('a Windows session that exits by itself leaves no node-pty worker or pipe open', windows, async (t) => {
  const { session, agent, workerExited } = realSession(t, 'cmd.exe', ['/c', 'exit 3']);
  await session.exited;
  await workerExited;
  assert.deepEqual([session.exitCode, agent._inSocket.destroyed, agent._outSocket.destroyed], [3, true, true]);
});

test('Stop ends a Windows session and the console child it started, reports the exit and releases the pty', windows, async (t) => {
  const counts = countSpawns(t);
  const { session, until, agent, workerExited } = realSession(t, process.execPath, ['-e', `
    const child = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    console.log('child ' + child.pid);
    setInterval(() => {}, 1000);`]);
  const [, pid] = await until(/child (\d+)/);
  const before = { ...counts };
  session.kill();
  session.kill();
  session.dispose();
  await session.exited;
  await workerExited;
  assert.deepEqual(counts, before, 'no helper and no taskkill was started');
  assert.equal(alive(Number(pid)), false, 'the console child ended with its console');
  assert.deepEqual([agent._inSocket.destroyed, agent._outSocket.destroyed], [true, true]);
});

test('a Windows session stopped while starting ends cleanly', windows, async (t) => {
  const counts = countSpawns(t);
  const { session, workerExited } = realSession(t, process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const before = { ...counts };
  session.kill();
  session.dispose();
  await session.exited;
  await workerExited;
  assert.deepEqual(counts, before);
});

test('a Stop after the process has ended, while node-pty still holds back its exit, names no process', windows, async (t) => {
  const counts = countSpawns(t);
  const { session, agent } = realSession(t, 'cmd.exe', ['/c', 'exit 7']);
  // node-pty learns of the exit here and reports it only after flushing the output: the window in which the pid is free.
  const ended = new Promise((resolve) => {
    const onProcessExit = agent._$onProcessExit.bind(agent);
    agent._$onProcessExit = (code) => { onProcessExit(code); resolve(); };
  });
  await ended;
  assert.equal(session.status, 'running', 'the exit is still on its way');
  const before = { ...counts };
  session.kill();
  session.kill();
  await session.exited;
  assert.deepEqual(counts, before, 'nothing was started to end a pid');
  assert.equal(session.exitCode, 7, 'the process ended by itself; the close did nothing');
});
