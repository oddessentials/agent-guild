// The launcher starts a detached manager that outlives it, and can stop it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '../bin/agent-guild.mjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-launcher-'));

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const env = { ...process.env, AGENT_GUILD_HOME: home, AGENT_GUILD_PORT: String(port), AGENT_GUILD_SKIP_SHELL_ENV: '1' };

function run(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { env, timeout: 30000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

after(async () => {
  await run('stop');
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('open starts a background manager, status reports it, stop ends it', async () => {
  const opened = await run('open', '--no-browser');
  assert.equal(opened.code, 0, opened.stderr);
  assert.match(opened.stdout, /Session manager started/);
  assert.match(opened.stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}/#token=[a-f0-9]+`));

  // The launcher has exited; the manager must still be serving.
  const health = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  assert.equal(health.status, 200);

  const again = await run('open', '--no-browser');
  assert.match(again.stdout, /already running/);

  const status = await run('status');
  assert.equal(status.code, 0);
  assert.match(status.stdout, /running at/);

  const url = await run('url');
  assert.match(url.stdout, /#token=/);

  const stopped = await run('stop');
  assert.match(stopped.stdout, /stopped/);
  const after = await run('status');
  assert.equal(after.code, 3);
  assert.ok(!fs.existsSync(path.join(home, 'manager.json')), 'runtime file is removed on shutdown');
});
