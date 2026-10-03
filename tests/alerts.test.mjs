import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { SOUNDS, MIN_WORK_MS, SETTLE_MS, SHARED_MS, playOnce, sessionIdle, idleWatcher, stopWatcher, updateWatcher } from '../web/alerts.js';

// A watcher on a fake clock: `at(ms)` moves time forward and fires due timers.
function watch() {
  let time = 0;
  let seq = 0;
  const timers = new Map();
  const chimes = [];
  const watcher = idleWatcher({
    chime: (id) => chimes.push(id),
    now: () => time,
    setTimer: (fn, ms) => { timers.set(++seq, { fn, due: time + ms }); return seq; },
    clearTimer: (id) => timers.delete(id),
  });
  const at = (ms) => {
    time = ms;
    for (const [id, t] of [...timers]) if (t.due <= time) { timers.delete(id); t.fn(); }
  };
  const session = (fields = {}) => ({ id: 's1', status: 'running', activity: 'quiet', agents: [], shells: [], ...fields });
  return { watcher, chimes, at, session };
}

test('every alert sound ships with the page', () => {
  for (const file of Object.values(SOUNDS)) assert.ok(existsSync(new URL(`../web/${file}`, import.meta.url)), file);
});

test('a session is idle only when quiet with no working agent and no shell command', () => {
  const base = { status: 'running', activity: 'quiet', agents: [], shells: [] };
  assert.equal(sessionIdle(base), true);
  assert.equal(sessionIdle({ ...base, activity: 'active' }), false);
  assert.equal(sessionIdle({ ...base, status: 'exited' }), false);
  assert.equal(sessionIdle({ ...base, agents: [{ status: 'working' }] }), false);
  assert.equal(sessionIdle({ ...base, agents: [{ status: 'done' }, { status: 'waiting' }] }), true);
  assert.equal(sessionIdle({ ...base, shells: [{ id: 'shell-1' }] }), false);
});

test('a session that worked and went quiet chimes once, after it settles', () => {
  const { watcher, chimes, at, session } = watch();
  watcher.update(session({ activity: 'active' }));
  at(MIN_WORK_MS);
  watcher.update(session());
  at(MIN_WORK_MS + SETTLE_MS - 1);
  assert.deepEqual(chimes, []);
  at(MIN_WORK_MS + SETTLE_MS);
  assert.deepEqual(chimes, ['s1']);
  watcher.update(session());
  at(MIN_WORK_MS + 10 * SETTLE_MS);
  assert.deepEqual(chimes, ['s1']);
});

test('a short burst of output does not chime', () => {
  const { watcher, chimes, at, session } = watch();
  watcher.update(session({ activity: 'active' }));
  at(MIN_WORK_MS - 1);
  watcher.update(session());
  at(MIN_WORK_MS + 10 * SETTLE_MS);
  assert.deepEqual(chimes, []);
});

test('the echo of typing does not count as work', () => {
  const { watcher, chimes, at, session } = watch();
  watcher.update(session({ activity: 'active' }));
  at(MIN_WORK_MS * 2);
  watcher.input('s1');
  at(MIN_WORK_MS * 2 + 2000);
  watcher.update(session());
  at(MIN_WORK_MS * 4);
  assert.deepEqual(chimes, []);
});

test('typing into a session cancels its pending chime', () => {
  const { watcher, chimes, at, session } = watch();
  watcher.update(session({ activity: 'active' }));
  at(MIN_WORK_MS);
  watcher.update(session());
  watcher.input('s1');
  at(MIN_WORK_MS + 10 * SETTLE_MS);
  assert.deepEqual(chimes, []);
});

test('output again during the settle delay waits for the next quiet', () => {
  const { watcher, chimes, at, session } = watch();
  watcher.update(session({ activity: 'active' }));
  at(MIN_WORK_MS);
  watcher.update(session());
  at(MIN_WORK_MS + 500);
  watcher.update(session({ activity: 'active' }));
  at(MIN_WORK_MS + 10 * SETTLE_MS);
  assert.deepEqual(chimes, []);
  watcher.update(session());
  at(MIN_WORK_MS + 11 * SETTLE_MS);
  assert.deepEqual(chimes, ['s1']);
});

test('a quiet session waits for its agents and shell commands to end', () => {
  const { watcher, chimes, at, session } = watch();
  watcher.update(session({ activity: 'active' }));
  at(MIN_WORK_MS);
  watcher.update(session({ agents: [{ status: 'working' }], shells: [{ id: 'shell-1' }] }));
  at(MIN_WORK_MS * 3);
  watcher.update(session({ agents: [{ status: 'working' }] }));
  at(MIN_WORK_MS * 4);
  assert.deepEqual(chimes, []);
  watcher.update(session({ agents: [{ status: 'done' }] }));
  at(MIN_WORK_MS * 4 + SETTLE_MS);
  assert.deepEqual(chimes, ['s1']);
});

test('an exited, forgotten or cleared session does not chime', () => {
  for (const end of ['exit', 'forget', 'clear']) {
    const { watcher, chimes, at, session } = watch();
    watcher.update(session({ activity: 'active' }));
    at(MIN_WORK_MS);
    watcher.update(session());
    if (end === 'exit') watcher.update(session({ status: 'exited' }));
    else if (end === 'forget') watcher.forget('s1');
    else watcher.clear();
    at(MIN_WORK_MS + 10 * SETTLE_MS);
    assert.deepEqual(chimes, [], end);
  }
});

test('the manager stopping sounds once per connection', () => {
  const stop = stopWatcher();
  assert.equal(stop.stopped(), false, 'a socket that never connected');
  stop.connected();
  assert.equal(stop.stopped(), true);
  assert.equal(stop.stopped(), false, 'the socket closing after manager.stopped');
  stop.connected();
  assert.equal(stop.stopped(), true, 'the next connection, after a restart');
});

test('an update sounds for each new version, but not for the one known when the page opened', () => {
  const update = updateWatcher();
  assert.equal(update({ available: true, latestVersion: '1.1.0' }), false);
  assert.equal(update({ available: true, latestVersion: '1.1.0' }), false);
  assert.equal(update({ available: true, latestVersion: '1.2.0' }), true);
  assert.equal(update(null), false);
  assert.equal(update({ available: true, latestVersion: '1.2.0' }), false);

  const later = updateWatcher();
  assert.equal(later({ available: false, latestVersion: '1.0.0' }), false);
  assert.equal(later({ available: true, latestVersion: '1.1.0' }), true);
});

// Web Locks as one origin shares them between its pages: a held name is not available to anyone else.
function fakeLocks() {
  const held = new Set();
  return {
    held,
    request(name, options, callback) {
      assert.equal(options.ifAvailable, true);
      if (held.has(name)) return Promise.resolve(callback(null));
      held.add(name);
      return Promise.resolve(callback({ name })).finally(() => held.delete(name));
    },
  };
}

test('only one open page plays an alert, and the next one plays once the hold ends', async () => {
  const locks = fakeLocks();
  const waits = [];
  const wait = (resolve, ms) => waits.push({ resolve, ms });
  const played = [];
  playOnce('idle.s1', () => played.push('first page'), { locks, wait });
  playOnce('idle.s1', () => played.push('second page'), { locks, wait });
  playOnce('idle.s2', () => played.push('another session'), { locks, wait });
  assert.deepEqual(played, ['first page', 'another session']);
  assert.deepEqual(waits.map((w) => w.ms), [SHARED_MS, SHARED_MS]);
  for (const w of waits) w.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(locks.held.size, 0);
  playOnce('idle.s1', () => played.push('a later alert'), { locks, wait });
  assert.deepEqual(played, ['first page', 'another session', 'a later alert']);
});

test('without Web Locks every page plays', () => {
  const played = [];
  playOnce('stopped', () => played.push('played'), { locks: null });
  assert.deepEqual(played, ['played']);
});
