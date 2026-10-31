// A handle that whoever runs the launcher can inherit must not stay open in the manager it starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

/** Runs a .cmd file through cmd.exe, as a launcher runs, with an extra inheritable pipe as handle 3. */
function throughCmd(file, args, env) {
  const line = `"${[file, ...args].map((arg) => `"${arg}"`).join(' ')}"`;
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], { env, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], windowsVerbatimArguments: true, windowsHide: true });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { out += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve({ code, at: Date.now() })));
  const closed = new Promise((resolve) => { child.stdio[3].once('close', () => resolve(Date.now())); child.stdio[3].resume(); });
  return { child, exited, closed, output: () => out };
}

function writeCmd(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `@${body}\r\n`);
  return file;
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-handles-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, AGENT_GUILD_HOME: home, AGENT_GUILD_PORT: String(port), AGENT_GUILD_SKIP_SHELL_ENV: '1', AGENT_GUILD_NO_UPDATE_CHECK: '1' };
  const health = () => fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(2000) }).then((res) => res.json(), () => null);
  let managerPid = null;
  const stop = () => new Promise((resolve) => execFile(process.execPath, [cli, 'stop'], { env, timeout: 30000 }, (error, stdout) => resolve({ error, stdout })));
  // Register before any assertion: a failed test must still stop its own manager.
  t.after(async () => {
    const stopped = await stop();
    if (managerPid && /still shutting down/.test(stopped.stdout)) {
      await new Promise((resolve) => execFile('taskkill', ['/PID', String(managerPid), '/T', '/F'], { timeout: 10000 }, resolve));
    }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const run = throughCmd(writeCmd(home, 'agent-guild.cmd', `"${process.execPath}" "${cli}" %*`), ['open', '--no-browser'], env);
  t.after(() => run.child.kill());
  const exited = await within(run.exited, 30000);
  assert.ok(exited, 'agent-guild open did not return');
  assert.equal(exited.code, 0, run.output());
  const up = await health();
  assert.ok(up?.pid, 'the manager agent-guild open started does not answer');
  managerPid = up.pid;

  const closed = await within(run.closed, 5000);
  assert.equal((await health())?.pid, managerPid, 'the manager stopped answering during the check, so the result says nothing');
  if (closed) {
    t.diagnostic(`closed ${closed - exited.at} ms after cmd.exe exited, while manager ${managerPid} ran`);
    return;
  }
  const stoppedAt = Date.now();
  await stop();
  const closedAfterStop = await within(run.closed, 10000);
  assert.fail(`the extra handle was still open 5 s after cmd.exe exited, while manager ${managerPid} was running; ` +
    (closedAfterStop ? `it closed ${closedAfterStop - stoppedAt} ms after the manager was stopped` : 'it was still open 10 s after the manager was stopped'));
});
