// A handle that whoever runs the launcher can inherit must not stay open in the manager it starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { waitForTerminalReady } from './fixtures/terminal-ready.mjs';
import { startHidden, startProcessScript } from '../src/manager/launch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '../bin/agent-guild.mjs');
const skip = process.platform !== 'win32';

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms, null))]);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Runs a .cmd file through cmd.exe, as a launcher runs, with an extra inheritable pipe as handle 3. */
function throughCmd(file, args, env, { detached = false } = {}) {
  const line = `"${[file, ...args].map((arg) => `"${arg}"`).join(' ')}"`;
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], { env, detached, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], windowsVerbatimArguments: true, windowsHide: true });
  let out = '';
  child.stderr.on('data', (chunk) => { out += chunk; });
  const stdoutEnded = new Promise((resolve) => { child.stdout.on('data', (chunk) => { out += chunk; }); child.stdout.once('close', () => resolve(Date.now())); });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve({ code, at: Date.now() })));
  const closed = new Promise((resolve) => { child.stdio[3].once('close', () => resolve(Date.now())); child.stdio[3].resume(); });
  return { child, exited, closed, stdoutEnded, output: () => out };
}

function writeCmd(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `@${body}\r\n`);
  return file;
}

/** A manager of the test's own, in its own home and on its own port, stopped by the test however it ends. */
async function isolated(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-handles-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, AGENT_GUILD_HOME: home, AGENT_GUILD_PORT: String(port), AGENT_GUILD_SKIP_SHELL_ENV: '1', AGENT_GUILD_NO_UPDATE_CHECK: '1' };
  fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify({
    providers: [{ id: 'fake', vendor: 'Test', tool: 'Fake Tool', command: process.execPath, args: [path.join(here, 'fixtures', 'fake-tool.mjs')] }],
  }));
  const pids = new Set();
  const stop = () => new Promise((resolve) => execFile(process.execPath, [cli, 'stop'], { env, timeout: 30000 }, (error, stdout) => resolve({ code: error ? error.code : 0, stdout })));
  // Register before any assertion: a failed test must still stop its own manager and nothing else.
  t.after(async () => {
    await stop();
    for (const pid of pids) if (alive(pid)) await new Promise((resolve) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10000 }, resolve));
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const health = () => fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(2000) }).then((res) => res.json(), () => null);
  const token = () => fs.readFileSync(path.join(home, 'auth-token'), 'utf8').trim();
  const call = async (method, route, body) => {
    const res = await fetch(`${base}/api/v1${route}`, {
      method, signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const launcher = writeCmd(home, 'agent-guild.cmd', `"${process.execPath}" "${cli}" %*`);
  return { home, port, base, env, health, call, stop, launcher, track: (pid) => pids.add(pid) };
}

test('the harness sees the extra handle close once nothing under cmd.exe holds it', { skip }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-handles-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = throughCmd(writeCmd(dir, 'quick.cmd', `"${process.execPath}" -e 0`), [], process.env);
  t.after(() => run.child.kill());
  const exited = await within(run.exited, 15000);
  assert.ok(exited, 'cmd.exe did not exit');
  const closed = await within(run.closed, 5000);
  assert.ok(closed, 'the extra handle stayed open after cmd.exe and Node.js exited');
  t.diagnostic(`closed ${closed - exited.at} ms after cmd.exe exited`);
});

test('the extra handle reaches the Node.js that cmd.exe starts, which holds it after cmd.exe is gone', { skip }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-handles-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const ready = path.join(dir, 'ready');
  const hold = `"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 4000)" "${ready}"`;
  const run = throughCmd(writeCmd(dir, 'hold.cmd', hold), [], process.env);
  t.after(() => {
    run.child.kill();
    try { process.kill(Number(fs.readFileSync(ready, 'utf8'))); } catch { /* already exited */ }
  });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(fs.existsSync(ready), 'the Node.js that cmd.exe starts did not start');
  // cmd.exe waits for Node.js and holds the handle too, so it goes first: only Node.js can hold it after that.
  run.child.kill();
  const killed = await within(run.exited, 5000);
  assert.ok(killed, 'cmd.exe did not exit when stopped');
  const early = await within(run.closed, 1000);
  assert.equal(early, null, 'the extra handle closed with cmd.exe while its Node.js still ran, so it never reached Node.js and the experiment is invalid');
  const closed = await within(run.closed, 10000);
  assert.ok(closed, 'the extra handle stayed open after Node.js exited');
  t.diagnostic(`held by Node.js for ${closed - killed.at} ms after cmd.exe was stopped`);
});

test('agent-guild open through a .cmd launcher does not leave the caller\'s inheritable handle open in the manager', { skip }, async (t) => {
  const m = await isolated(t);
  const run = throughCmd(m.launcher, ['open', '--no-browser'], m.env);
  t.after(() => run.child.kill());
  const exited = await within(run.exited, 30000);
  assert.ok(exited, 'agent-guild open did not return');
  assert.equal(exited.code, 0, run.output());
  const up = await m.health();
  assert.ok(up?.pid, 'the manager agent-guild open started does not answer');
  m.track(up.pid);
  assert.equal(JSON.parse(fs.readFileSync(path.join(m.home, 'manager.json'), 'utf8')).pid, up.pid, 'manager.json names another process');
  assert.ok(await within(run.stdoutEnded, 5000), 'a script reading agent-guild open\'s output would still be waiting');

  const closed = await within(run.closed, 5000);
  assert.equal((await m.health())?.pid, up.pid, 'the manager stopped answering during the check, so the result says nothing');
  if (!closed) {
    const stoppedAt = Date.now();
    await m.stop();
    const closedAfterStop = await within(run.closed, 10000);
    assert.fail(`the extra handle was still open 5 s after cmd.exe exited, while manager ${up.pid} was running; ` +
      (closedAfterStop ? `it closed ${closedAfterStop - stoppedAt} ms after the manager was stopped` : 'it was still open 10 s after the manager was stopped'));
  }
  t.diagnostic(`closed ${closed - exited.at} ms after cmd.exe exited, while manager ${up.pid} ran`);

  assert.match(fs.readFileSync(path.join(m.home, 'manager.log'), 'utf8'), new RegExp(`listening on ${m.base.replace(/[.]/g, '\\.')} \\(pid ${up.pid}\\)`));
  const window = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${up.pid}).MainWindowHandle`], { encoding: 'utf8', timeout: 30000 }).trim();
  assert.equal(window, '0', 'the manager shows a window');
  const stopped = await m.stop();
  assert.equal(stopped.code, 0, stopped.stdout);
  assert.match(stopped.stdout, /Session manager stopped\./);
  assert.equal(alive(up.pid), false, 'the manager process still runs after stop');
});

test('a manager started through the launcher runs terminal sessions and its environment checks, and stop ends every session process', { skip }, async (t) => {
  const m = await isolated(t);
  const run = throughCmd(m.launcher, ['open', '--no-browser'], m.env);
  t.after(() => run.child.kill());
  assert.equal((await within(run.exited, 30000))?.code, 0, run.output());
  const up = await m.health();
  assert.ok(up?.pid, 'the manager does not answer');
  m.track(up.pid);

  const created = await m.call('POST', '/sessions', { providerId: 'fake', cwd: m.home });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.session.id;
  const socket = new WebSocket(`ws://127.0.0.1:${m.port}/api/v1/sessions/${id}/terminal?token=${fs.readFileSync(path.join(m.home, 'auth-token'), 'utf8').trim()}`);
  socket.on('error', () => {});
  t.after(() => socket.terminate());
  await waitForTerminalReady(socket);
  let screen = '';
  socket.on('message', (raw) => { const message = JSON.parse(raw.toString()); if (message.type === 'data') screen += message.data; });
  socket.send(JSON.stringify({ type: 'input', data: 'echo hidden-console\r' }));
  const deadline = Date.now() + 15000;
  while (!screen.includes('ECHO:hidden-console') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match(screen, /ECHO:hidden-console/, 'the session did not answer through its terminal');
  const session = (await m.call('GET', `/sessions/${id}`)).body.session;
  assert.ok(session.pid > 0, 'the running session has no pid');
  m.track(session.pid);

  let scan = null;
  const scanDeadline = Date.now() + 60000;
  while (Date.now() < scanDeadline) {
    scan = (await m.call('GET', '/environment')).body;
    if (scan?.checkedAt && !scan.refreshing) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(scan?.checkedAt && !scan.refreshing, `the environment check did not finish: ${JSON.stringify(scan).slice(0, 300)}`);

  const stopped = await m.stop();
  assert.equal(stopped.code, 0, stopped.stdout);
  assert.equal(alive(up.pid), false, 'the manager process still runs after stop');
  const goneBy = Date.now() + 10000;
  while (alive(session.pid) && Date.now() < goneBy) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(alive(session.pid), false, 'the session process still runs after stop');
});

test('a manager keeps running when the console that started it is closed', { skip }, async (t) => {
  const m = await isolated(t);
  const wait = writeCmd(m.home, 'open-and-wait.cmd', `"${process.execPath}" "${cli}" open --no-browser && ping -n 60 127.0.0.1 > nul`);
  const run = throughCmd(wait, [], m.env, { detached: true });
  t.after(() => run.child.kill());
  let up = null;
  const deadline = Date.now() + 30000;
  while (!up && Date.now() < deadline) {
    up = await m.health();
    if (!up) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(up?.pid, 'the manager does not answer');
  m.track(up.pid);
  execFileSync('taskkill', ['/PID', String(run.child.pid), '/T', '/F'], { timeout: 10000 });
  assert.ok(await within(run.exited, 10000), 'the console did not close');
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal((await m.health())?.pid, up.pid, 'the manager stopped with the console that started it');
});

test('without Windows PowerShell the manager is not started, and the error says why', () => {
  assert.throws(
    () => startHidden(process.execPath, ['-e', '0'], { powershell: path.join(os.tmpdir(), 'no-such-powershell.exe') }),
    /could not start the session manager: Windows PowerShell did not start it/,
  );
});

test('the Start-Process script quotes the program and its arguments', () => {
  assert.equal(
    startProcessScript("C:\\Program Files\\O'Brien\\node.exe", ['C:\\a b\\main.mjs', '--own-log']),
    "$p = Start-Process -FilePath 'C:\\Program Files\\O''Brien\\node.exe' -ArgumentList '\"C:\\a b\\main.mjs\" \"--own-log\"' -WindowStyle Hidden -PassThru; $p.Id",
  );
});
