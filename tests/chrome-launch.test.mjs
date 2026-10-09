import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { launchChrome } from './browser/chrome.mjs';

// A Chrome that never reports its port, or one that reports it at once; each remembers whether it was ended.
function fakeChrome({ reports }) {
  return (_file, args) => {
    const profile = args.find((a) => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    const child = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null, stderr: new PassThrough(), killed: false, profile });
    child.kill = () => { child.killed = true; child.exitCode = null; child.signalCode = 'SIGTERM'; child.emit('exit'); };
    if (reports) fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), '9229\n/devtools/browser/x');
    return child;
  };
}

test('a Chrome that does not come up is ended and launched again, a bounded number of times, and only the launch is retried', async () => {
  const log = [];
  const outcomes = [false, true];
  const children = [];
  const spawnImpl = (file, args, opts) => { const child = fakeChrome({ reports: outcomes[children.length] })(file, args, opts); children.push(child); return child; };
  const launched = await launchChrome({ chromePath: 'fake-chrome', name: 'launch-test', timeoutMs: 120, spawnImpl, log: (line) => log.push(line) });
  assert.equal(launched.port, 9229);
  assert.equal(children.length, 2, 'the second launch is the one that came up');
  assert.deepEqual([children[0].killed, fs.existsSync(children[0].profile)], [true, false], 'the first was ended and its profile removed');
  assert.deepEqual([children[1].killed, fs.existsSync(children[1].profile)], [false, true], 'the second is handed back running');
  assert.deepEqual(log, ['# Chrome launch attempt 1 of 3 failed: Timed out: Chrome DevTools'], 'each failed attempt is in the log');
  fs.rmSync(launched.profile, { recursive: true, force: true });

  // Every attempt failing ends as the last failure, with nothing left running.
  const never = [];
  const neverSpawn = (file, args, opts) => { const child = fakeChrome({ reports: false })(file, args, opts); never.push(child); return child; };
  await assert.rejects(launchChrome({ chromePath: 'fake-chrome', name: 'launch-test', attempts: 2, timeoutMs: 60, spawnImpl: neverSpawn, log: () => {} }), /Timed out: Chrome DevTools/);
  assert.equal(never.length, 2);
  assert.ok(never.every((child) => child.killed && !fs.existsSync(child.profile)));
});
