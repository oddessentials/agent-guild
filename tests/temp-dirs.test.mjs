// Temp folders from tests/fixtures/temp-dirs.mjs go after every test, and one that cannot go is a failure, not a leftover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/temp-dirs-run.mjs', import.meta.url));

function runFixture(extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-temp-dirs-'));
  const log = path.join(root, 'made.log');
  fs.writeFileSync(log, '');
  // Without its parent's context, or this run would report to that parent rather than run.
  const { NODE_TEST_CONTEXT, ...parentEnv } = process.env;
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=spec', fixture], {
    encoding: 'utf8', timeout: 60000,
    env: { ...parentEnv, TEMP: root, TMP: root, TMPDIR: root, TEMP_DIRS_LOG: log, ...extraEnv },
  });
  return { root, run, noted: fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
}

test('a folder goes after a test that passes and after one that fails', (t) => {
  const { root, run, noted } = runFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(run.status, 1, 'the failing test fails the run');
  assert.match(run.stdout, /this test fails on purpose/);
  assert.equal(noted.length, 3, 'all three tests ran');
  assert.deepEqual(noted.filter((dir) => fs.existsSync(dir)), []);
});

test('a folder a process still holds fails its test, and says so', { skip: process.platform !== 'win32' && 'only Windows refuses to remove a folder in use' }, (t) => {
  const { root, run, noted } = runFixture({ TEMP_DIRS_CASE: 'held' });
  const pid = Number(noted.find((line) => line.startsWith('pid ')).slice(4));
  t.after(async () => {
    try { process.kill(pid); } catch (err) { if (err.code !== 'ESRCH') throw err; }
    while (fs.existsSync(root)) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // Until the process has gone, as the first check below shows it can be.
        await new Promise((resolve) => { setTimeout(resolve, 50); });
      }
    }
  });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /could not remove 1 temp folder/);
});
