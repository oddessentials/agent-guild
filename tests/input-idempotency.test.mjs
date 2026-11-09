import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import WebSocket from 'ws';
import { fakePty } from './fixtures/fake-pty.mjs';
import { Session } from '../src/manager/session.mjs';
import { SessionManager } from '../src/manager/session-manager.mjs';
import { createManagerServer } from '../src/manager/server.mjs';
import { createGuildClient, createToolHandlers } from '../src/mcp/server.mjs';

function sessions(t, { clock = true, write = () => {} } = {}) {
  if (clock) t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1700000000000 });
  t.mock.method(pty, 'spawn', () => fakePty({ write }));
  let instance = 0;
  t.mock.method(crypto, 'randomUUID', () => `00000000-0000-4000-8000-${String(++instance).padStart(12, '0')}`);
  return () => {
    const session = new Session({
      id: 'a1', provider: { id: 'fake', tool: 'Fake' }, spawnSpec: { file: 'mock', args: [] },
      cwd: process.cwd(), env: {}, cols: 80, rows: 24, reportToken: 'fixture', reporting: { state: 'pending' },
    });
    t.after(() => session.dispose());
    return session;
  };
}

const keyFor = (session, id) => `${session.toJSON().inputInstance}:${id}`;
const outcome = (result) => JSON.parse(result.content[0].text);

test('a keyed input is recorded before writing, keeps paste handling, and rejects conflicting bytes', (t) => {
  const writes = [];
  let reentered;
  const session = sessions(t, { write: (data) => {
    writes.push(data);
    reentered = session.inputOnce(input, key);
  } })();
  const key = keyFor(session, 'request');
  const input = '\x1b[200~echo hello\x1b[201~\r\x1b[201~';
  assert.deepEqual(session.inputOnce(input, key), { outcome: 'accepted' });
  assert.deepEqual(reentered, { outcome: 'uncertain', code: 'write_uncertain' });
  assert.deepEqual(writes, ['\x1b[200~echo hello␛[201~\r\x1b[201~']);
  assert.deepEqual(session.inputOnce(input, key), { outcome: 'accepted' });
  assert.deepEqual(session.inputOnce('different', key), { outcome: 'rejected', code: 'key_conflict' });
  assert.equal(writes.length, 1);
  assert.ok(session._reportingTimer);
});

test('an uncertain write is never attempted again, while unkeyed input keeps its behavior', (t) => {
  const writes = [];
  const session = sessions(t, { write: (data) => { writes.push(data); throw new Error('write may have started'); } })();
  const key = keyFor(session, 'uncertain');
  const result = session.inputOnce('do work\r', key);
  assert.deepEqual(result, { outcome: 'uncertain', code: 'write_uncertain' });
  assert.deepEqual(session.inputOnce('do work\r', key), result);
  assert.equal(writes.length, 1);
  assert.doesNotThrow(() => session.input('do work\r'));
  assert.equal(writes.length, 2);
});

test('a full receipt generation retires its input instance, keeps one generation back, and fails older keys closed', (t) => {
  let writes = 0;
  const session = sessions(t, { write: () => writes++ })();
  const input = 'private input that must not remain in the receipt';
  const fill = (count) => {
    const keys = Array.from({ length: count }, (_, n) => keyFor(session, `n${n}`));
    for (const key of keys) assert.deepEqual(session.inputOnce(input, key), { outcome: 'accepted' });
    return keys;
  };
  const first = session.inputInstance;
  const [oldest] = fill(4095);
  assert.equal(session.inputInstance, first);
  const boundary = `${first}:boundary`;
  assert.deepEqual(session.inputOnce(input, boundary), { outcome: 'accepted' });
  assert.notEqual(session.inputInstance, first);
  assert.deepEqual(session.inputOnce(input, `${first}:late`), { outcome: 'rejected', code: 'stale_instance' });
  assert.deepEqual(session.inputOnce(input, oldest), { outcome: 'accepted' });
  assert.deepEqual(session.inputOnce(input, boundary), { outcome: 'accepted' });
  assert.deepEqual(session.inputOnce('changed', oldest), { outcome: 'rejected', code: 'key_conflict' });

  const rotated = session.inputInstance;
  session._onExit(0);
  t.mock.timers.tick(0);
  session.reattach({ file: 'mock', args: [] });
  assert.notEqual(session.inputInstance, rotated);
  assert.deepEqual(session.inputOnce(input, oldest), { outcome: 'accepted' });
  assert.deepEqual(session.inputOnce(input, `${rotated}:unsent`), { outcome: 'rejected', code: 'stale_instance' });

  const reattached = fill(4096);
  assert.equal(writes, 2 * 4096);
  for (const discarded of [oldest, boundary, `${first}:n4094`]) {
    assert.deepEqual(session.inputOnce(input, discarded), { outcome: 'rejected', code: 'stale_instance' });
  }
  assert.deepEqual(session.inputOnce(input, reattached[0]), { outcome: 'accepted' });
  assert.equal(writes, 2 * 4096);
  assert.ok(session._inputReceipts.size + session._previousReceipts.size <= 2 * 4096);
  assert.equal(JSON.stringify([...session._inputReceipts, ...session._previousReceipts]).includes(input), false);
});

test('exit retains receipts, reattachment changes the input instance, and replacement refuses old keys', (t) => {
  const writes = [];
  const create = sessions(t, { write: (data) => writes.push(data) });
  const session = create();
  const accepted = keyFor(session, 'accepted');
  const rejected = keyFor(session, 'rejected');
  const unseen = keyFor(session, 'unseen');
  session.inputOnce('first', accepted);
  session._onExit(0);
  t.mock.timers.tick(0);
  assert.deepEqual(session.inputOnce('first', accepted), { outcome: 'accepted' });
  assert.deepEqual(session.inputOnce('second', rejected), { outcome: 'rejected', code: 'not_writable' });
  session.reattach({ file: 'mock', args: [] });
  assert.deepEqual(session.inputOnce('first', accepted), { outcome: 'accepted' });
  assert.deepEqual(session.inputOnce('second', rejected), { outcome: 'rejected', code: 'not_writable' });
  assert.deepEqual(session.inputOnce('late', unseen), { outcome: 'rejected', code: 'stale_instance' });
  assert.equal(session.inputOnce('new', keyFor(session, 'accepted')).outcome, 'accepted');
  const replacement = create();
  assert.equal(replacement.id, session.id);
  assert.deepEqual(replacement.inputOnce('first', accepted), { outcome: 'rejected', code: 'stale_instance' });
  assert.deepEqual(writes, ['first', 'new']);
});

test('malformed keys and empty input cannot fall back to an unkeyed write', (t) => {
  const writes = [];
  const session = sessions(t, { write: (data) => writes.push(data) })();
  for (const key of [null, {}, '', 'unscoped', keyFor(session, 'has spaces'), keyFor(session, 'x'.repeat(129))]) {
    assert.deepEqual(session.inputOnce('text', key), { outcome: 'rejected', code: 'invalid_key' });
  }
  assert.deepEqual(session.inputOnce(null, keyFor(session, 'bad-input')), { outcome: 'rejected', code: 'invalid_input' });
  assert.deepEqual(session.inputOnce('', keyFor(session, 'empty')), { outcome: 'rejected', code: 'not_writable' });
  assert.deepEqual(writes, []);
});

test('MCP retries a lost acknowledgement with the original key and waits for a manager receipt', async (t) => {
  const writes = [];
  const session = sessions(t, { write: (data) => writes.push(data) })();
  const key = keyFor(session, 'lost-ack');
  const sockets = [];
  let drop = true;
  const client = {
    withTerminal: async (_id, use) => {
      const ws = new EventEmitter();
      sockets.push(ws);
      ws.send = (raw, done) => {
        const message = JSON.parse(raw);
        const receipt = session.inputOnce(message.data, message.idempotencyKey);
        done();
        if (drop) ws.emit('close');
        else ws.emit('message', JSON.stringify({ type: 'input-result', idempotencyKey: message.idempotencyKey, ...receipt }));
      };
      return use(ws, { session: session.toJSON() });
    },
  };
  const { send_input } = createToolHandlers(client, { allowInput: true });
  const args = { session_id: 'a1', text: 'work', idempotency_key: key };
  assert.deepEqual(outcome(await send_input(args)), { idempotency_key: key, outcome: 'uncertain', code: 'acknowledgement_lost' });
  assert.deepEqual(writes, ['work\r']);
  drop = false;
  assert.deepEqual(outcome(await send_input(args)), { idempotency_key: key, outcome: 'accepted' });
  assert.equal(outcome(await send_input({ ...args, submit: false })).code, 'key_conflict');
  assert.deepEqual(writes, ['work\r']);
  for (const ws of sockets) assert.deepEqual(ws.eventNames(), []);
});

test('MCP acknowledgement timeout stays uncertain and never starts a second write', async (t) => {
  const writes = [];
  const session = sessions(t, { write: (data) => writes.push(data) })();
  const ws = new EventEmitter();
  ws.send = (raw, done) => {
    const message = JSON.parse(raw);
    session.inputOnce(message.data, message.idempotencyKey);
    done();
  };
  const client = { withTerminal: async (_id, use) => use(ws, { session: session.toJSON() }) };
  const { send_input } = createToolHandlers(client, { allowInput: true });
  const result = send_input({ session_id: 'a1', text: 'work', idempotency_key: keyFor(session, 'timeout') });
  t.mock.timers.tick(10000);
  assert.equal(outcome(await result).code, 'acknowledgement_lost');
  t.mock.timers.tick(600000);
  assert.deepEqual(writes, ['work\r']);
  assert.deepEqual(ws.eventNames(), []);
});

test('MCP refuses keyed input on an old manager and preserves unkeyed sending', async () => {
  const sent = [];
  const client = { withTerminal: async (_id, use) => use({ send: (data, done) => { sent.push(JSON.parse(data)); done(); } }, { session: { status: 'running' } }) };
  const { send_input } = createToolHandlers(client, { allowInput: true });
  const args = { session_id: 'a1', text: 'work' };
  assert.equal(outcome(await send_input({ ...args, idempotency_key: 'old-instance:request' })).code, 'unsupported');
  assert.deepEqual(sent, []);
  assert.deepEqual(outcome(await send_input(args)), { sent: true });
  assert.deepEqual(sent, [{ type: 'input', data: 'work\r' }]);
});

test('concurrent WebSocket and MCP retries share receipts through exit and session replacement', async (t) => {
  const writes = [];
  const create = sessions(t, { clock: false, write: (data) => writes.push(data) });
  const session = create();
  const registry = new EventEmitter();
  const manager = new SessionManager({ registry, baseEnv: {}, getApiUrl: () => api.url });
  manager.sessions.set('a1', session);
  const token = 'fixture-input-token';
  const api = createManagerServer({
    manager, registry, token, webDir: fileURLToPath(new URL('../web', import.meta.url)),
    yardArt: new EventEmitter(), yardWorlds: new EventEmitter(), yardPieces: new EventEmitter(),
  });
  await api.listen();
  t.after(() => api.close());
  const { send_input, list_sessions } = createToolHandlers(createGuildClient({ url: api.url, token }), { allowInput: true });
  assert.equal(outcome(await list_sessions())[0].inputInstance, session.inputInstance);
  const key = keyFor(session, 'concurrent');
  const args = { session_id: 'a1', text: 'work', idempotency_key: key };
  const results = await Promise.all(Array.from({ length: 5 }, () => send_input(args)));
  assert.deepEqual(results.map(outcome), Array(5).fill({ idempotency_key: key, outcome: 'accepted' }));
  assert.deepEqual(writes, ['work\r']);
  assert.equal(outcome(await send_input({ ...args, text: 'conflict' })).code, 'key_conflict');
  session._onExit(0);
  assert.equal(outcome(await send_input(args)).outcome, 'accepted');
  const replacement = create();
  manager.sessions.set('a1', replacement);
  assert.equal(outcome(await send_input(args)).code, 'stale_instance');
  assert.deepEqual(writes, ['work\r']);
  t.mock.method(replacement.pty, 'write', (data) => { writes.push(data); throw new Error('uncertain write'); });
  const uncertain = { ...args, idempotency_key: keyFor(replacement, 'uncertain') };
  const original = outcome(await send_input(uncertain));
  assert.deepEqual(original, { idempotency_key: uncertain.idempotency_key, outcome: 'uncertain', code: 'write_uncertain' });
  assert.deepEqual(outcome(await send_input(uncertain)), original);
  assert.deepEqual(writes, ['work\r', 'work\r']);
  const ws = new WebSocket(`${api.url.replace('http', 'ws')}/api/v1/sessions/a1/terminal`, { headers: { Authorization: `Bearer ${token}` } });
  t.after(() => ws.terminate());
  await once(ws, 'message');
  const receipt = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'input', data: 'must not be typed', idempotencyKey: null }));
  assert.deepEqual(JSON.parse((await receipt)[0]), { type: 'input-result', idempotencyKey: null, outcome: 'rejected', code: 'invalid_key' });
  assert.deepEqual(writes, ['work\r', 'work\r']);
});

test('concurrent MCP callers at the rotation boundary write once, and a stale caller refreshes the instance', async (t) => {
  const writes = [];
  const session = sessions(t, { clock: false, write: (data) => writes.push(data) })();
  const registry = new EventEmitter();
  const manager = new SessionManager({ registry, baseEnv: {}, getApiUrl: () => api.url });
  manager.sessions.set('a1', session);
  const token = 'fixture-input-token';
  const api = createManagerServer({
    manager, registry, token, webDir: fileURLToPath(new URL('../web', import.meta.url)),
    yardArt: new EventEmitter(), yardWorlds: new EventEmitter(), yardPieces: new EventEmitter(),
  });
  await api.listen();
  t.after(() => api.close());
  const { send_input, list_sessions } = createToolHandlers(createGuildClient({ url: api.url, token }), { allowInput: true });
  const first = session.inputInstance;
  for (let n = 0; n < 4095; n++) session.inputOnce('fill', `${first}:fill-${n}`);
  writes.length = 0;
  const keys = ['boundary', 'boundary', 'boundary', 'boundary', 'other-0', 'other-1', 'other-2'].map((id) => `${first}:${id}`);
  const results = (await Promise.all(keys.map((key) => send_input({ session_id: 'a1', text: 'work', idempotency_key: key })))).map(outcome);
  const byKey = Map.groupBy(results, (result) => result.idempotency_key);
  for (const group of byKey.values()) assert.equal(new Set(group.map((r) => JSON.stringify(r))).size, 1, 'duplicates share one receipt');
  const outcomes = [...byKey.values()].map(([result]) => result.code ?? result.outcome).sort();
  assert.deepEqual(outcomes, ['accepted', 'stale_instance', 'stale_instance', 'stale_instance']);
  assert.deepEqual(writes, ['work\r']);
  const [listed] = outcome(await list_sessions());
  assert.notEqual(listed.inputInstance, first);
  const fresh = `${listed.inputInstance}:after-refresh`;
  assert.deepEqual(outcome(await send_input({ session_id: 'a1', text: 'next', idempotency_key: fresh })), { idempotency_key: fresh, outcome: 'accepted' });
  assert.deepEqual(writes, ['work\r', 'next\r']);
});
