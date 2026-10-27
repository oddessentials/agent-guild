import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { DeviceSignIn, MAX_SIGN_INS, SIGN_IN_LIFETIME_MS, SIGN_IN_THROTTLE_MS, normalizeSignInCode } from '../src/manager/device-sign-in.mjs';
import { createManagerServer } from '../src/manager/server.mjs';

const token = 'test-manager-token';

function clock(start = Date.parse('2026-10-26T12:00:00.000Z')) {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

function fakeTimers() {
  const pending = [];
  return {
    pending,
    set: (fn, ms) => { const timer = { fn, ms }; pending.push(timer); return timer; },
    clear: (timer) => { const index = pending.indexOf(timer); if (index >= 0) pending.splice(index, 1); },
  };
}

function setup({ random } = {}) {
  const time = clock();
  const timers = fakeTimers();
  let counter = 0;
  const signIn = new DeviceSignIn({ token, now: time.now, timers, random: random ?? ((size) => Buffer.alloc(size, ++counter)) });
  const updates = [];
  signIn.on('updated', () => updates.push(signIn.list().requests.map((entry) => entry.code)));
  return { signIn, time, timers, updates };
}

test('a device gets a code and a secret, the person approves the code, and the next poll hands the token out once', (t) => {
  const { signIn, time, updates } = setup();
  t.after(() => signIn.close());
  const started = signIn.request();
  assert.match(started.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.match(started.device, /^[0-9a-f]{48}$/);
  assert.equal(started.interval, 3);
  assert.equal(Date.parse(started.expiresAt), time.now() + SIGN_IN_LIFETIME_MS);
  assert.deepEqual(signIn.poll(started.device), { status: 'pending' });
  const listed = signIn.list().requests;
  assert.deepEqual(Object.keys(listed[0]), ['code', 'requestedAt', 'expiresAt']);
  assert.equal(listed[0].code, started.code);
  assert.ok(!JSON.stringify(listed).includes(started.device) && !JSON.stringify(listed).includes(token));

  const after = signIn.approve(started.code.toLowerCase());
  assert.deepEqual(after.requests, []);
  assert.deepEqual(signIn.poll(started.device), { status: 'approved', token });
  assert.throws(() => signIn.poll(started.device), { status: 404, code: 'sign_in_unknown' });
  assert.deepEqual(updates, [[started.code], [], []]);
});

test('a denied code answers denied once, an unknown secret or code is refused, and expiry removes the request', (t) => {
  const { signIn, time, timers, updates } = setup();
  t.after(() => signIn.close());
  const denied = signIn.request();
  signIn.deny(denied.code);
  assert.throws(() => signIn.approve(denied.code), { code: 'sign_in_unknown' });
  assert.deepEqual(signIn.poll(denied.device), { status: 'denied' });
  assert.throws(() => signIn.poll(denied.device), { code: 'sign_in_unknown' });
  assert.throws(() => signIn.poll('0'.repeat(48)), { code: 'sign_in_unknown' });
  assert.throws(() => signIn.poll(undefined), { code: 'sign_in_unknown' });
  assert.throws(() => signIn.approve('ZZZZ-ZZZZ'), { status: 404, code: 'sign_in_unknown' });

  time.advance(SIGN_IN_THROTTLE_MS);
  const expiring = signIn.request();
  assert.equal(timers.pending.length, 1);
  assert.equal(timers.pending[0].ms, SIGN_IN_LIFETIME_MS);
  time.advance(SIGN_IN_LIFETIME_MS);
  timers.pending[0].fn();
  assert.deepEqual(signIn.list().requests, []);
  assert.throws(() => signIn.poll(expiring.device), { code: 'sign_in_unknown' });
  assert.throws(() => signIn.approve(expiring.code), { code: 'sign_in_unknown' });
  assert.equal(timers.pending.length, 0);
  assert.deepEqual(updates.at(-1), []);
});

test('requests are throttled and capped, and codes are unique and normalized', (t) => {
  const { signIn, time } = setup();
  t.after(() => signIn.close());
  signIn.request();
  assert.throws(() => signIn.request(), { status: 429, code: 'sign_in_busy' });
  for (let i = 1; i < MAX_SIGN_INS; i++) { time.advance(SIGN_IN_THROTTLE_MS); signIn.request(); }
  time.advance(SIGN_IN_THROTTLE_MS);
  assert.throws(() => signIn.request(), { status: 429, code: 'sign_in_busy' });
  const codes = signIn.list().requests.map((entry) => entry.code);
  assert.equal(new Set(codes).size, MAX_SIGN_INS);
  assert.equal(normalizeSignInCode(' abcd-efgh '), 'ABCDEFGH');
  assert.equal(normalizeSignInCode(42), '');

  const same = new DeviceSignIn({ token, now: time.now, timers: fakeTimers(), random: (size) => Buffer.alloc(size, 7) });
  t.after(() => same.close());
  const first = same.request();
  time.advance(SIGN_IN_THROTTLE_MS);
  let attempts = 0;
  same.random = (size) => Buffer.alloc(size, attempts++ ? 9 : 7);
  const second = same.request();
  assert.notEqual(second.code, first.code);
  assert.equal(attempts, 3, 'one duplicate code, its replacement, then the device secret');
});

function call(api, method, route, { body, auth = token, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(`${api.url}/api/v1${route}`, {
      method,
      headers: {
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('over HTTP, asking and polling need no token, deciding does, the token comes back once, and an event follows each change', async (t) => {
  const manager = Object.assign(new EventEmitter(), { list: () => [], refreshMultiplexers: async () => {} });
  const registry = Object.assign(new EventEmitter(), { warnings: [] });
  const time = clock();
  const deviceSignIn = new DeviceSignIn({ token, now: time.now, timers: fakeTimers() });
  const api = createManagerServer({ manager, registry, token, deviceSignIn, webDir: fileURLToPath(new URL('../web', import.meta.url)) });
  await api.listen();
  t.after(() => api.close());
  const ws = new WebSocket(`${api.url.replace('http:', 'ws:')}/api/v1/events?token=${token}`);
  t.after(() => ws.terminate());
  assert.equal(JSON.parse((await once(ws, 'message'))[0]).type, 'hello');
  const nextEvent = async () => JSON.parse((await once(ws, 'message'))[0]).type;

  assert.equal((await call(api, 'GET', '/sign-in', { auth: '' })).status, 401);
  assert.equal((await call(api, 'POST', '/sign-in/approve', { auth: '', body: { code: 'x' } })).status, 401);
  assert.equal((await call(api, 'POST', '/sign-in/deny', { auth: '', body: { code: 'x' } })).status, 401);
  assert.equal((await call(api, 'POST', '/sign-in/poll', { auth: '', body: {} })).body.error.code, 'bad_request');
  assert.equal((await call(api, 'POST', '/sign-in/approve', { body: {} })).body.error.code, 'bad_request');

  const event = nextEvent();
  const started = await call(api, 'POST', '/sign-in', { auth: '' });
  assert.equal(started.status, 201);
  assert.equal(await event, 'sign-in.updated');
  const { code, device } = started.body.signIn;
  assert.equal((await call(api, 'POST', '/sign-in', { auth: '' })).status, 429);
  assert.deepEqual((await call(api, 'POST', '/sign-in/poll', { auth: '', body: { device } })).body, { signIn: { status: 'pending' } });
  const listed = await call(api, 'GET', '/sign-in');
  assert.deepEqual(listed.body.signIn.requests.map((entry) => entry.code), [code]);
  assert.ok(!JSON.stringify(listed.body).includes(device));

  const approved = nextEvent();
  assert.deepEqual((await call(api, 'POST', '/sign-in/approve', { body: { code } })).body, { signIn: { requests: [] } });
  assert.equal(await approved, 'sign-in.updated');
  const collected = nextEvent();
  const polled = await call(api, 'POST', '/sign-in/poll', { auth: '', body: { device } });
  assert.deepEqual(polled.body, { signIn: { status: 'approved', token } });
  assert.equal(await collected, 'sign-in.updated');
  const again = await call(api, 'POST', '/sign-in/poll', { auth: '', body: { device } });
  assert.equal(again.status, 404);
  assert.equal(again.body.error.code, 'sign_in_unknown');
  assert.equal((await call(api, 'POST', '/sign-in/approve', { body: { code } })).status, 404);
});
