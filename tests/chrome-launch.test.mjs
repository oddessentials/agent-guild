import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { launchChrome, pageLoads } from './browser/chrome.mjs';

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

// A CDP session whose replies and events the test hands out one at a time, in any order.
function fakePage() {
  const listeners = new Set(), calls = [];
  const send = (method, params) => new Promise((resolve, reject) => calls.push({ method, params, resolve, reject }));
  const listen = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
  const emit = (name, loaderId, frameId = 'main') => { for (const l of [...listeners]) l({ method: 'Page.lifecycleEvent', params: { frameId, loaderId, name } }); };
  return { calls, listeners, emit, ...pageLoads(send, listen, 'main', 200) };
}
const state = (promise) => Promise.race([promise.then(() => 'resolved', (e) => `rejected: ${e.message}`), new Promise((r) => setImmediate(() => r('pending')))]);

test('navigate and reload return only once their own new document has parsed', async () => {
  const page = fakePage();
  let done = page.navigate('http://x/');
  page.emit('init', 'one');
  page.emit('DOMContentLoaded', 'one');
  page.emit('DOMContentLoaded', 'stale');
  page.calls[0].resolve({ loaderId: 'one' });
  assert.equal(await state(done), 'resolved', 'its DOMContentLoaded may come before the reply');
  assert.equal(page.listeners.size, 0);

  done = page.navigate('http://x/?q');
  page.calls[1].resolve({ loaderId: 'two' });
  page.emit('DOMContentLoaded', 'one');
  page.emit('DOMContentLoaded', 'two', 'child-frame');
  assert.equal(await state(done), 'pending', 'another loader\'s or frame\'s event is not its own');
  page.emit('DOMContentLoaded', 'two');
  assert.equal(await state(done), 'resolved');

  done = page.reload();
  page.calls[2].resolve({});
  page.emit('init', 'two');
  page.emit('DOMContentLoaded', 'two');
  assert.equal(await state(done), 'pending', 'a reload waits for a new loader, not the page it replaces');
  page.emit('init', 'three');
  page.emit('DOMContentLoaded', 'three');
  assert.equal(await state(done), 'resolved');

  done = page.navigate('http://x/?q#h');
  page.calls[3].resolve({ frameId: 'main' });
  assert.equal(await state(done), 'resolved', 'a hash-only navigation keeps the document');

  done = page.navigate('http://nowhere/');
  page.calls[4].resolve({ loaderId: 'four', errorText: 'net::ERR_NAME_NOT_RESOLVED' });
  assert.equal(await state(done), 'rejected: Page.navigate: net::ERR_NAME_NOT_RESOLVED');

  done = page.navigate('http://x/broken');
  page.calls[5].reject(new Error('Page.navigate: Cannot navigate to invalid URL'));
  assert.equal(await state(done), 'rejected: Page.navigate: Cannot navigate to invalid URL');

  done = page.navigate('http://x/slow');
  page.calls[6].resolve({ loaderId: 'five' });
  await assert.rejects(done, /Timed out: Page\.navigate http:\/\/x\/slow/);
  assert.equal(page.listeners.size, 0, 'nothing is left listening after success, a hash-only change, failure or a timeout');
});
