import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import { fakePty } from './fixtures/fake-pty.mjs';
import { Session } from '../src/manager/session.mjs';
import { SessionManager } from '../src/manager/session-manager.mjs';
import { createManagerServer } from '../src/manager/server.mjs';
import { createGuildClient, serveMcp } from '../src/mcp/server.mjs';
import { handleHookEvent } from '../src/report/hook-event.mjs';

test('reply history crosses the API and MCP without changing existing reads or typing anything', async (t) => {
  const writes = [];
  t.mock.method(pty, 'spawn', () => fakePty({ write: (data) => writes.push(data) }));
  let instance = 0;
  t.mock.method(crypto, 'randomUUID', () => `00000000-0000-4000-8000-${String(++instance).padStart(12, '0')}`);
  const registry = new EventEmitter();
  const manager = new SessionManager({ registry, baseEnv: {}, getApiUrl: () => api.url });
  const token = '1234567890abcdef'.repeat(3);
  const api = createManagerServer({
    manager, registry, token, webDir: fileURLToPath(new URL('../web', import.meta.url)),
    yardArt: new EventEmitter(), yardWorlds: new EventEmitter(), yardPieces: new EventEmitter(),
  });
  await api.listen();
  t.after(() => api.close());
  const create = (opts = {}) => {
    const session = new Session({
      id: 'a1', provider: { id: 'fake', tool: 'Fake', reporting: 'codex' },
      spawnSpec: { file: 'mock', args: [] }, cwd: process.cwd(), env: {}, cols: 80, rows: 24, reportToken: 'fixture-report',
      reporting: { state: 'pending', reason: null }, ...opts,
    });
    manager.sessions.set(session.id, session);
    t.after(() => session.dispose());
    return session;
  };
  const session = create();
  const request = async (route, { body, reportToken, auth = token } = {}) => {
    const res = await fetch(`${api.url}/api/v1/sessions/a1${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: reportToken ? { 'X-Agent-Guild-Report-Token': reportToken } : { Authorization: `Bearer ${auth}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() };
  };
  const input = new PassThrough();
  const output = new PassThrough();
  const served = serveMcp({ input, output, allowInput: true, client: createGuildClient({ url: api.url, token }) });
  const waiting = new Map();
  readline.createInterface({ input: output }).on('line', (line) => {
    assert.equal(line.includes(token), false);
    const message = JSON.parse(line);
    waiting.get(message.id)(message);
    waiting.delete(message.id);
  });
  t.after(async () => { input.end(); await served; output.end(); });
  let next = 0;
  const rpc = (method, params) => new Promise((resolve) => {
    const id = ++next;
    waiting.set(id, resolve);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
  const parsed = async (name, args) => {
    const result = await call(name, args);
    assert.notEqual(result.isError, true, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  const id = { session_id: 'a1' };
  await rpc('initialize', {});
  const tools = (await rpc('tools/list', {})).result.tools;
  assert.equal(tools.find((tool) => tool.name === 'read_replies').annotations.readOnlyHint, true);
  const [initial] = await parsed('list_sessions');
  assert.equal(initial.replyId, null);
  const after = initial.replyCursor;
  for (const reply of ['first', 'second']) {
    assert.equal((await request('/reply', { body: { reply }, reportToken: 'fixture-report' })).status, 200);
  }
  const latest = (await request('/reply')).body.reply;
  assert.deepEqual(latest, { id: 2, text: 'second', spoken: 'second' });
  assert.equal((await call('read_reply', id)).content[0].text, 'second');
  const page = await parsed('read_replies', { ...id, after, limit: 1 });
  assert.deepEqual(page.replies.map((r) => r.text), ['first']);
  assert.equal(page.hasMore, true);
  assert.deepEqual(await parsed('read_replies', { ...id, after, limit: 1 }), page);
  assert.deepEqual((await request('/replies')).body.replies.map((r) => r.id), [1, 2]);
  await request('/reply', { body: { reply: null } });
  const [emptyTurn] = await parsed('list_sessions');
  assert.equal(emptyTurn.hasReply, false);
  assert.equal(emptyTurn.replyId, null);
  assert.notEqual(emptyTurn.replyCursor, after);
  assert.deepEqual((await request('/reply')).body, { reply: null });
  assert.deepEqual((await parsed('read_replies', { ...id, after: page.nextCursor })).replies.map((r) => r.text), ['second']);
  session.reportReply({ reply: `secret ${token}` });
  assert.match((await parsed('read_replies', id)).replies.at(-1).text, /hidden/);
  for (const query of ['?limit=0', '?limit=101', '?limit=1.5', '?limit=', '?after=invalid']) {
    assert.equal((await request(`/replies${query}`)).status, 400, query);
  }
  assert.equal((await call('read_replies', { ...id, limit: 0 })).isError, true);
  assert.equal((await request('/replies', { reportToken: 'fixture-report' })).status, 401);
  const stop = { hook_event_name: 'Stop', session_id: 'root', turn_id: 'one', last_assistant_message: 'finished' };
  const { later } = await handleHookEvent(stop, {
    reporting: 'codex', send: async (body, kind) => {
      assert.equal((await request(`/${kind}`, { body, reportToken: 'fixture-report' })).status, 200);
    },
  });
  await later;
  assert.equal((await call('read_reply', id)).content[0].text, 'finished');
  session._onExit(0);
  const [exited] = await parsed('list_sessions');
  assert.equal(exited.working, false);
  const retained = await parsed('read_replies', id);
  manager.sessions.delete('a1');
  assert.equal((await request('/replies')).status, 404);
  assert.equal((await call('read_replies', id)).isError, true);
  create().reportReply({ reply: 'replacement' });
  const reset = await parsed('read_replies', { ...id, after: retained.nextCursor });
  assert.equal(reset.gap, 'reset');
  assert.deepEqual(reset.replies.map((r) => r.text), ['replacement']);
  assert.deepEqual(writes, []);
});
