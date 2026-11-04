// Run by tests/temp-dirs.test.mjs under node --test: it notes each folder it makes in TEMP_DIRS_LOG.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tempDirs } from './temp-dirs.mjs';

const tempDir = tempDirs('guild-temp-dirs-check-');
const made = () => {
  const dir = tempDir();
  fs.appendFileSync(process.env.TEMP_DIRS_LOG, `${dir}\n`);
  fs.writeFileSync(path.join(dir, 'file'), 'x');
  return dir;
};

if (process.env.TEMP_DIRS_CASE === 'held') {
  test('a test that leaves a process in its folder', async () => {
    const child = spawn(process.execPath, ['-e', 'console.log(1);setInterval(()=>{},1000)'], { cwd: made(), stdio: ['ignore', 'pipe', 'ignore'] });
    fs.appendFileSync(process.env.TEMP_DIRS_LOG, `pid ${child.pid}\n`);
    await new Promise((resolve) => { child.stdout.once('data', resolve); });
    child.unref();
    child.stdout.destroy();
  });
} else {
  test('a test that passes', () => { made(); });
  test('a test that fails', () => {
    made();
    assert.fail('this test fails on purpose');
  });
  test('a test that passes after one failed', () => { made(); });
}
