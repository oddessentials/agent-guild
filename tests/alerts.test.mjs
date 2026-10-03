import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { SOUNDS, playOnce, rearmSound, managerLossWatcher, stopWatcher, updateWatcher, MAX_ALERT_AGE_MS, RECOVERY_WAIT_MS, HEALTH_TIMEOUT_MS } from '../web/alerts.js';

test('every alert sound ships with the page', () => {
  for (const file of Object.values(SOUNDS)) assert.ok(existsSync(new URL(`../web/${file}`, import.meta.url)), file);
});

test('a manager stop is once per lifetime; reconnects never announce old stops', () => {
  const stop = stopWatcher();
  assert.equal(stop.stopped(), null);
  assert.equal(stop.connected('one'), undefined);
  assert.equal(stop.connected('one'), undefined);
  assert.equal(stop.stopped(), 'one');
  assert.equal(stop.stopped(), null);
  stop.connected('one');
  assert.equal(stop.stopped(), null, 'same lifetime stays consumed');
  assert.equal(stop.connected('two'), undefined, 'already heard confirmed stop');
  assert.equal(stop.connected('three'), undefined, 'a replacement silently establishes a baseline');
  assert.equal(stop.connected('three'), undefined);
  assert.equal(stop.stopped(), 'three');
});

test('version checks baseline on the first real result and do not replay on reconnect or rollback', () => {
  const update = updateWatcher();
  const v = (latestVersion, available = true) => ({ latestVersion, available });
  assert.equal(update(null), false);
  assert.equal(update(v(null, false)), false);
  assert.equal(update(v('1.1.0')), false, 'startup fetch completed');
  assert.equal(update(v('1.2.0')), true);
  assert.equal(update(v('1.1.0')), false);
  assert.equal(update(v('1.2.0')), false);
  assert.equal(update(v('1.3.0'), true), false, 'reconnected snapshot');
  assert.equal(update(v('1.3.0')), false);
  assert.equal(update(v('1.4.0', false)), false);
  assert.equal(update(v('1.4.0')), false, 'available flag alone is no new release');
  assert.equal(update(v('2.0.0-beta.2')), true);
  assert.equal(update(v('2.0.0-beta.10')), true);
  assert.equal(update(v('2.0.0-beta.3')), false);
  assert.equal(update(v('2.0.0')), true);
  assert.equal(update(v('2.0.0+build')), false);
});

function shared() {
  const values = new Map();
  let queue = Promise.resolve();
  return {
    storage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    locks: { request(_key, callback) {
      const result = queue.then(callback);
      queue = result.catch(() => {});
      return result;
    } },
  };
}

test('two tabs play once, including a late tab after the lock has been released', async () => {
  const options = shared();
  const played = [];
  const play = (page) => () => { played.push(page); return true; };
  await Promise.all([playOnce('update.1', play('first'), options), playOnce('update.1', play('second'), options)]);
  await playOnce('update.1', play('late'), options);
  await playOnce('update.2', play('next'), options);
  assert.deepEqual(played, ['first', 'next']);
});

test('a blocked tab releases the event for an eligible tab; failed playback never consumes it', async () => {
  const options = shared();
  let played = 0;
  const results = await Promise.all([
    playOnce('event', () => Promise.reject(new Error('NotAllowedError')), options),
    playOnce('event', () => { played++; return true; }, options),
  ]);
  assert.deepEqual(results, [false, true]);
  assert.equal(played, 1);
  await playOnce('muted', () => false, options);
  assert.equal(await playOnce('muted', () => true, options), true);
});

test('old events and missing coordination stay silent without unhandled failures', async () => {
  const noPlay = () => assert.fail('must stay silent');
  assert.equal(await playOnce('old', noPlay, { ...shared(), fresh: () => false }), false);
  assert.equal(await playOnce('no-locks', noPlay, { ...shared(), locks: null }), false);
  assert.equal(await playOnce('storage-blocked', noPlay, {
    ...shared(), storage: { getItem() { throw new Error('blocked'); } },
  }), false);
});

test('confirmed and unavailable reports of the same loss share one sound; recovery rearms only unavailability', async () => {
  for (const first of ['stopped', 'unavailable']) {
    const options = shared();
    const second = first === 'stopped' ? 'unavailable' : 'stopped';
    let plays = 0;
    const play = () => { plays++; return true; };
    assert.equal(await playOnce(`${first}.one`, play, { ...options, related: [`${second}.one`] }), true);
    assert.equal(await playOnce(`${second}.one`, play, { ...options, related: [`${first}.one`] }), false);
    assert.equal(plays, 1);
    await rearmSound('unavailable.one', options);
    assert.equal(await playOnce('unavailable.one', play, { ...options, related: ['stopped.one'] }), first === 'unavailable');
  }
});

function lossChecks(answers) {
  let time = 0, sequence = 0;
  const timers = new Map(), requests = [], alerts = [];
  const watcher = managerLossWatcher({
    now: () => time,
    setTimer: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, due: time + ms }); return id; },
    clearTimer: (id) => timers.delete(id),
    reachable(signal) {
      requests.push(signal);
      const answer = answers.shift();
      if (answer === 'hang') return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return Promise.resolve(answer);
    },
    unavailable: (at, fresh) => alerts.push({ at, fresh }),
  });
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const advance = async (ms) => {
    const end = time + ms;
    await flush();
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
      if (!next || next[1].due > end) break;
      const [id, timer] = next;
      time = Math.max(time, timer.due);
      timers.delete(id);
      timer.fn();
      await flush();
    }
    time = end;
    await flush();
  };
  return { watcher, requests, alerts, timers, flush, advance, jump: (ms) => { time += ms; } };
}

test('unavailability needs a live connection and two failures; retrying a dead manager adds no more checks', async () => {
  const w = lossChecks([false, false, false, false]);
  await w.watcher.disconnected();
  assert.equal(w.requests.length, 0, 'initially unreachable is silent');
  w.watcher.connected();
  w.watcher.disconnected();
  await w.advance(RECOVERY_WAIT_MS - 1);
  assert.equal(w.alerts.length, 0);
  await w.advance(1);
  assert.equal(w.requests.length, 2);
  assert.equal(w.alerts.length, 1);
  assert.equal(w.alerts[0].fresh(), true);
  await w.watcher.disconnected();
  await w.advance(60000);
  assert.equal(w.requests.length, 2);
  w.watcher.connected();
  w.watcher.disconnected();
  await w.advance(RECOVERY_WAIT_MS);
  assert.equal(w.alerts.length, 2, 'a later outage gets its own check');
});

test('either successful health check cancels the alert', async () => {
  for (const answers of [[true], [false, true]]) {
    const expected = answers.length;
    const w = lossChecks(answers);
    w.watcher.connected();
    w.watcher.disconnected();
    await w.advance(10000);
    assert.equal(w.requests.length, expected);
    assert.equal(w.alerts.length, 0);
    assert.equal(w.timers.size, 0);
  }
});

test('unresponsive health requests time out; the check is bounded', async () => {
  const w = lossChecks(['hang', 'hang']);
  w.watcher.connected();
  w.watcher.disconnected();
  await w.advance(HEALTH_TIMEOUT_MS * 2 + RECOVERY_WAIT_MS);
  assert.equal(w.alerts.length, 1);
  assert.equal(w.requests.length, 2);
  assert.ok(w.requests.every((signal) => signal.aborted));
  assert.equal(w.timers.size, 0);
});

test('reconnect, confirmed shutdown or page departure cancel requests, timers and queued alerts', async () => {
  for (const action of ['connected', 'cancel']) {
    for (const elapsed of [0, HEALTH_TIMEOUT_MS + 1, HEALTH_TIMEOUT_MS + RECOVERY_WAIT_MS + 1]) {
      const w = lossChecks(['hang', 'hang']);
      w.watcher.connected();
      w.watcher.disconnected();
      await w.advance(elapsed);
      w.watcher[action]();
      await w.advance(10000);
      assert.equal(w.alerts.length, 0);
      assert.equal(w.timers.size, 0);
      assert.ok(w.requests.every((signal) => signal.aborted));
    }
    const w = lossChecks([false, false]);
    w.watcher.connected();
    w.watcher.disconnected();
    await w.advance(RECOVERY_WAIT_MS);
    w.watcher[action]();
    assert.equal(w.alerts[0].fresh(), false, 'playback waiting for a lock stays silent');
  }
});

test('a check delayed by suspension does not replay an old loss', async () => {
  const w = lossChecks([false, false]);
  w.watcher.connected();
  w.watcher.disconnected();
  await w.flush();
  w.jump(MAX_ALERT_AGE_MS + 1);
  await w.advance(0);
  assert.equal(w.alerts.length, 0);
  assert.equal(w.requests.length, 1);
  assert.equal(w.timers.size, 0);
});
