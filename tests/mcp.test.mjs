// `agent-guild mcp` end to end: the real command on stdio, against a stand-in manager that answers the API and one
// terminal socket. Nothing it returns may carry the API token.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createGuildClient, serveMcp } from '../src/mcp/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'bin', 'agent-guild.mjs');
const token = '7319ac0e4bd2856f90a3d7c15e8b246dca5f093267e1b804';
const otherToken = 'a1'.repeat(24);
const sensitive = `Access ${token}; page https://example.invalid/#token=${otherToken}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-mcp-'));
fs.writeFileSync(path.join(home, 'auth-token'), `${token}\n`);

const providers = [
  { id: 'anthropic', vendor: 'Anthropic', tool: 'Claude Code', command: 'claude', available: true },
  { id: 'openai', vendor: 'OpenAI', tool: 'Codex CLI', command: 'codex', available: false, install: 'npm install -g @openai/codex' },
  { id: 'shell', vendor: 'Shell', tool: 'Shell', command: '@shell', available: true },
];
const session = {
  id: 'b45b6822d158', name: 'Claude Code', provider: { id: 'anthropic', vendor: 'Anthropic', tool: 'Claude Code' },
  cwd: '/work/app', status: 'running', activity: 'active', label: 'Working', account: { id: 'default' }, task: null,
  model: { name: 'claude-opus-5-5', displayName: 'Opus 5.5' }, agents: [{ name: 'explorer', status: 'working', detail: 'Map the auth flow' }],
  permission: { state: 'waiting', since: '2026-10-25T10:04:00.000Z' }, turn: { state: 'working', at: '2026-10-25T10:03:00.000Z' },
  reply: { id: 3, at: '2026-10-25T10:02:00.000Z' }, startedAt: '2026-10-25T10:00:00.000Z', exitCode: null,
};
const page = 'http://127.0.0.1:47821/#token=';
const clipped = [token, otherToken].flatMap((secret, i) => [
  { id: `c11900000${i}01`, cols: 31, data: `${page}${secret}\r\n$ `, shown: '[token hidden]\n[token hidden]\n$ ' },
  { id: `c11900000${i}02`, cols: 80, data: `link ${page}${secret.slice(0, 10)}\r\n  ${secret.slice(10)}\r\nnext\r\n$ `, shown: '[token hidden]\nnext\n$ ' },
]);
const exited = { ...session, id: 'e0e0e0e00001', status: 'exited', activity: null, label: 'Exited', exitCode: 0 };
const posted = [];
const opening = [];
/** What the next terminal socket to open receives, once it closes. */
const nextClose = () => new Promise((resolve) => opening.push(resolve));

let server;
let url;
before(async () => {
  server = http.createServer((req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/api/v1/health') return json(200, { ok: true, name: 'agent-guild', version: '9.9.9', pid: process.pid });
    if (req.headers.authorization !== `Bearer ${token}`) return json(401, { error: { code: 'unauthorized', message: 'Missing or invalid token' } });
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'POST') posted.push({ url: req.url, body: body ? JSON.parse(body) : null });
      if (req.url === '/api/v1/sessions' && req.method === 'GET') return json(200, { sessions: [session] });
      if (req.url === '/api/v1/providers') return json(200, { providers, revision: null });
      if (req.url === `/api/v1/sessions/${session.id}/reply`) return json(200, { reply: { id: 3, text: '## Done\n\nAll tests pass.', spoken: 'Done.' } });
      if (req.url === '/api/v1/sessions' && req.method === 'POST' && JSON.parse(body).name === 'hang') return undefined;
      if (req.url === '/api/v1/sessions' && req.method === 'POST') return json(201, { session: { ...session, id: 'c0ffee000001', name: 'New' } });
      // As a manager from before permission, turn and reply times answers.
      if (req.url === `/api/v1/sessions/${session.id}/stop`) return json(200, { session: { ...session, permission: undefined, turn: undefined, reply: { id: 3 }, status: 'exited', label: 'Exited' } });
      return json(404, { error: { code: 'not_found', message: 'Session not found' } });
    });
    return undefined;
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.headers.authorization !== `Bearer ${token}`) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    if (!/^\/api\/v1\/sessions\/[a-f0-9]+\/terminal$/.test(req.url)) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const received = [];
      ws.on('message', (raw) => received.push(JSON.parse(raw)));
      const done = opening.shift();
      ws.on('close', () => done?.(received));
      const clip = clipped.find((c) => req.url === `/api/v1/sessions/${c.id}/terminal`);
      if (clip) {
        ws.send(JSON.stringify({ type: 'snapshot', data: clip.data, cols: clip.cols, rows: 3, generation: 0, owner: false, session: { ...session, id: clip.id } }));
        return;
      }
      if (req.url === `/api/v1/sessions/${exited.id}/terminal`) {
        const screen = `$ agent-guild url\r\n${url}/#token=${token}\r\n$ cat auth-token\r\n${token.slice(0, 20)}\r\n│ ${token.slice(20)}`;
        ws.send(JSON.stringify({ type: 'snapshot', data: screen, cols: 40, rows: 8, generation: 0, owner: false, session: exited }));
        return;
      }
      if (req.url !== `/api/v1/sessions/${session.id}/terminal`) {
        ws.send(JSON.stringify({ type: 'error', code: 'not_found', message: 'Session not found' }));
        ws.close(4404);
        return;
      }
      ws.send(JSON.stringify({ type: 'snapshot', data: '\x1b[1mDo you want to proceed?\x1b[0m\r\n\x1b[32m> 1. Yes\x1b[0m\r\n  2. No', cols: 40, rows: 6, generation: 0, owner: false, session }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(home, 'manager.json'), JSON.stringify({ pid: process.pid, url }));
});
after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

/** The command on stdio, and a way to call it. Every line it prints is checked for the token. */
function startMcp(t, args = [], env = {}) {
  const child = spawn(process.execPath, [cli, 'mcp', ...args], { env: { ...process.env, AGENT_GUILD_HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const waiting = new Map();
  let next = 1;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    assert.equal(line.includes(token), false, 'the token never reaches the agent');
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
  const request = (method, params) => new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const callTool = async (name, args = {}) => {
    const { result, error } = await request('tools/call', { name, arguments: args });
    if (error) return { error };
    return { ...result, body: result.content[0].text };
  };
  return { child, request, callTool };
}

test('it introduces itself, lists read and write tools, and keeps typing off by default', async (t) => {
  const { request, child } = startMcp(t);
  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'agent-guild');
  assert.ok(init.result.capabilities.tools);
  assert.match(init.result.instructions, /Never ask for, print or store/);
  const unknownVersion = await request('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(unknownVersion.result.protocolVersion, '2025-11-25');
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  assert.deepEqual((await request('ping')).result, {});

  const { tools } = (await request('tools/list')).result;
  assert.deepEqual(tools.map((tool) => tool.name), ['guild_status', 'list_sessions', 'read_reply', 'read_screen', 'start_session', 'stop_session']);
  for (const tool of tools.slice(0, 4)) assert.equal(tool.annotations.readOnlyHint, true, tool.name);
  assert.equal(tools.find((tool) => tool.name === 'stop_session').annotations.destructiveHint, true);
  assert.equal(tools.find((tool) => tool.name === 'start_session').inputSchema.properties.args, undefined, 'launch flags stay the person\'s choice');
  assert.equal((await request('nope/nothing')).error.code, -32601);
});

test('the read tools report status, sessions, the last reply and the screen', async (t) => {
  const { callTool } = startMcp(t);
  const status = JSON.parse((await callTool('guild_status')).body);
  assert.equal(status.running, true);
  assert.equal(status.version, '9.9.9');
  assert.equal(status.working_sessions, 1);
  assert.deepEqual(status.tools.map((p) => p.installed), [true, false, true]);

  const [listed] = JSON.parse((await callTool('list_sessions')).body);
  assert.equal(listed.id, session.id);
  assert.equal(listed.tool, 'Claude Code');
  assert.equal(listed.model, 'Opus 5.5');
  assert.equal(listed.working, true);
  assert.equal(listed.hasReply, true);
  assert.deepEqual(listed.permission, { state: 'waiting', since: '2026-10-25T10:04:00.000Z' });
  assert.deepEqual(listed.turn, { state: 'working', at: '2026-10-25T10:03:00.000Z' });
  assert.equal(listed.replyAt, '2026-10-25T10:02:00.000Z', 'the reply\'s own time, not the turn\'s');
  assert.deepEqual(listed.agents, [{ name: 'explorer', status: 'working', detail: 'Map the auth flow' }]);

  assert.equal((await callTool('read_reply', { session_id: session.id })).body, '## Done\n\nAll tests pass.');
  assert.equal((await callTool('read_screen', { session_id: session.id })).body, 'Do you want to proceed?\n> 1. Yes\n  2. No');

  const missing = await callTool('read_screen', { session_id: 'deadbeef0000' });
  assert.equal(missing.isError, true);
  assert.match(missing.body, /No session has the id/);
  for (const tool of ['read_screen', 'read_reply', 'stop_session']) {
    assert.match((await callTool(tool, { session_id: 'Fix-login' })).body, /No session has the id "Fix-login"/, tool);
  }
  const bad = await callTool('read_reply', { session_id: '../../shutdown' });
  assert.equal(bad.isError, true);
  assert.equal(posted.some((p) => p.url.includes('shutdown')), false);
});

test('starting a session resolves the tool by name, sends no launch flags, and refuses a missing tool', async (t) => {
  const { callTool } = startMcp(t);
  posted.length = 0;
  const started = JSON.parse((await callTool('start_session', { tool: 'claude', cwd: '/work/app', name: 'Fix login' })).body);
  assert.equal(started.session.id, 'c0ffee000001');
  assert.deepEqual(posted.at(-1), { url: '/api/v1/sessions', body: { providerId: 'anthropic', cwd: '/work/app', name: 'Fix login' } });
  await callTool('start_session', { tool: 'shell' });
  assert.deepEqual(posted.at(-1).body, { providerId: 'shell' });

  posted.length = 0;
  const flag = await callTool('start_session', { tool: 'claude', resume: ' --dangerously-skip-permissions' });
  assert.equal(flag.isError, true);
  assert.match(flag.body, /does not start with "-"/);
  assert.equal(posted.length, 0, 'a manager that accepts any resume never receives it');
  await callTool('start_session', { tool: 'claude', resume: ' 550e8400-e29b ' });
  assert.equal(posted.at(-1).body.resume, '550e8400-e29b');

  const missing = await callTool('start_session', { tool: 'codex' });
  assert.equal(missing.isError, true);
  assert.match(missing.body, /Codex CLI is not installed.*npm install -g @openai\/codex/);
  const unknown = await callTool('start_session', { tool: 'emacs' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.body, /no tool called "emacs".*anthropic \(Claude Code\)/);

  const stopped = JSON.parse((await callTool('stop_session', { session_id: session.id })).body);
  assert.equal(stopped.session.status, 'exited');
  assert.deepEqual([stopped.session.permission, stopped.session.turn, stopped.session.replyAt], [null, null, null], 'an older manager\'s session');
});

test('--allow-input adds send_input, which types into the terminal and presses Enter', async (t) => {
  const { request, callTool } = startMcp(t, ['--allow-input']);
  const { tools } = (await request('tools/list')).result;
  assert.equal(tools.at(-1).name, 'send_input');
  let closed = nextClose();
  assert.equal((await callTool('send_input', { session_id: session.id, text: '1' })).isError, undefined);
  assert.deepEqual(await closed, [{ type: 'input', data: '1\r' }]);
  closed = nextClose();
  await callTool('send_input', { session_id: session.id, text: '/help', submit: false });
  assert.deepEqual(await closed, [{ type: 'input', data: '/help' }]);

  closed = nextClose();
  const refused = await callTool('send_input', { session_id: exited.id, text: 'npm test' });
  assert.equal(refused.isError, true);
  assert.match(refused.body, /has exited, so nothing was typed/);
  assert.deepEqual(await closed, []);
});

test('read_screen hides a token whose first row has scrolled off, and keeps the rows around it', async (t) => {
  const { callTool } = startMcp(t);
  for (const { id, shown } of clipped) assert.equal((await callTool('read_screen', { session_id: id })).body, shown, id);
});

test('read_screen hides the token, even wrapped across rows', async (t) => {
  const { callTool } = startMcp(t);
  const { body } = await callTool('read_screen', { session_id: exited.id });
  assert.equal(body.replace(/[\s│]/g, '').includes(token), false);
  assert.ok(body.includes(`${url}/#token=[token hidden]`), body);
  assert.equal(body.split('[token hidden]').length, 5, body);
});

async function exchange(client, requests) {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = '';
  output.on('data', (chunk) => { printed += chunk; });
  const done = serveMcp({ input, output, client });
  input.end(requests.map((request) => JSON.stringify({ jsonrpc: '2.0', ...request })).join('\n') + '\n');
  await done;
  return printed.trim().split('\n').map((line) => JSON.parse(line));
}

test('supported protocol revisions negotiate unchanged', async () => {
  for (const protocolVersion of ['2025-11-25', '2025-06-18', '2024-11-05']) {
    const [response] = await exchange(createGuildClient({ token }), [{
      id: 1, method: 'initialize',
      params: { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    }]);
    assert.equal(response.error, undefined);
    assert.equal(response.result.protocolVersion, protocolVersion);
  }
});

test('March 2025 negotiates a modern revision, rejects batches and still serves standalone requests', { timeout: 5000 }, async (t) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const replies = readline.createInterface({ input: output })[Symbol.asyncIterator]();
  const receive = async () => JSON.parse((await replies.next()).value);
  const send = (message) => input.write(`${JSON.stringify(message)}\n`);
  const done = serveMcp({ input, output, client: createGuildClient({ token }) });
  t.after(async () => { input.end(); await done; output.end(); });

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  } });
  const init = await receive();
  assert.equal(init.id, 1);
  assert.equal(init.error, undefined);
  assert.equal(init.result.protocolVersion, '2025-11-25');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send([
    { jsonrpc: '2.0', id: 2, method: 'ping' },
    { jsonrpc: '2.0', id: 3, method: 'tools/list' },
  ]);
  assert.deepEqual(await receive(), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });

  send({ jsonrpc: '2.0', id: 4, method: 'ping' });
  assert.deepEqual(await receive(), { jsonrpc: '2.0', id: 4, result: {} });
  send({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
  const listed = await receive();
  assert.equal(listed.id, 5);
  assert.ok(listed.result.tools.some((tool) => tool.name === 'guild_status'));
  input.end();
  await done;
  output.end();
  assert.equal((await replies.next()).done, true);
});

test('known token fragments need 16 hex digits, preserving short hashes, session ids and colors', () => {
  // 64 bits of the known token, above ordinary 6/8-digit colors and 7-12-digit ids.
  // Repeated windows must not leave a short tail behind when their matches overlap.
  for (const key of [token, '0'.repeat(16) + '1' + '0'.repeat(31)]) {
    const redact = createGuildClient({ token: key }).redactor();
    for (let length = 1; length <= key.length; length++) {
      for (let start = 0; start + length <= key.length; start++) {
        const fragment = key.slice(start, start + length);
        assert.equal(redact(`value: ${fragment}; done`), `value: ${length >= 16 ? '[token hidden]' : fragment}; done`, `${start}:${length}`);
      }
    }
    for (const gap of ['\n', '\n│ ', '\\n│ ', ' | ', '\t']) {
      const fragment = key.slice(1, 9) + gap + key.slice(9);
      assert.equal(redact(fragment), gap.includes('\n') ? '[token hidden]\n[token hidden]' : '[token hidden]');
    }
  }
  const ordinary = `color #${token.slice(0, 6)}; rgba ${token.slice(0, 8)}; commit ${token.slice(0, 7)}; session ${token.slice(0, 12)}; hash ${token.slice(0, 15)}; digest ${otherToken}`;
  assert.equal(createGuildClient({ token }).redactor()(ordinary), ordinary);
});

test('token fragments are hidden in replies, metadata, tool errors, protocol errors and stderr', async (t) => {
  const fragment = token.slice(1);
  const wrapped = fragment.slice(0, 31) + '\n│ ' + fragment.slice(31);
  const client = createGuildClient({ token });
  client.api = async (route) => route === '/sessions'
    ? { sessions: [{ ...session, name: fragment, task: wrapped }] }
    : route === '/providers' ? { providers: [] } : { reply: { text: wrapped } };
  const responses = await exchange(client, [
    { id: 1, method: 'tools/call', params: { name: 'list_sessions' } },
    { id: 2, method: 'tools/call', params: { name: 'read_reply', arguments: { session_id: session.id } } },
    { id: 3, method: 'tools/call', params: { name: fragment } },
    { id: 4, method: fragment },
    { id: 5, method: 'tools/call', params: { name: 'start_session', arguments: { tool: fragment } } },
  ]);
  const listed = JSON.parse(responses.find((r) => r.id === 1).result.content[0].text)[0];
  assert.equal(listed.name, '[token hidden]');
  assert.equal(listed.task, '[token hidden]');
  assert.equal(responses.find((r) => r.id === 2).result.content[0].text, '[token hidden]\n[token hidden]');
  for (const response of responses) {
    assert.equal(JSON.stringify(response).includes(fragment), false);
    assert.match(JSON.stringify(response), /\[token hidden\]/);
  }
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
  client.api = async () => { throw new Error(wrapped); };
  const [failed] = await exchange(client, [{ id: 6, method: 'tools/call', params: { name: 'list_sessions' } }]);
  assert.equal(failed.result.isError, true);
  assert.equal(logged.length, 1);
  assert.ok(logged[0].includes('Error: [token hidden]\n[token hidden]'));
});

test('replies, metadata and protocol errors are all redacted at the output boundary', async () => {
  const client = createGuildClient({ token });
  client.api = async (route) => route === '/sessions'
    ? { sessions: [{ ...session, name: sensitive, task: `${token.slice(0, 20)}\n│ ${token.slice(20)}`, agents: [{ name: sensitive, detail: sensitive }] }] }
    : route === '/providers' ? { providers: [] } : { reply: { text: sensitive } };
  const requests = [
    { id: 1, method: 'tools/call', params: { name: 'list_sessions' } },
    { id: 2, method: 'tools/call', params: { name: 'read_reply', arguments: { session_id: session.id } } },
    { id: 3, method: 'tools/call', params: { name: sensitive } },
    { id: 4, method: sensitive },
    { id: 7, method: 'tools/call', params: { name: 'start_session', arguments: { tool: sensitive } } },
  ];
  const responses = await exchange(client, requests);
  assert.equal(responses.length, requests.length);
  for (const response of responses) {
    const printed = JSON.stringify(response);
    assert.equal(printed.includes(token), false);
    assert.equal(printed.includes(otherToken), false);
    assert.match(printed, /\[token hidden\]/);
  }
  const metadata = JSON.parse(responses.find((response) => response.id === 1).result.content[0].text);
  assert.equal(metadata[0].task, '[token hidden]');
  assert.equal(responses.find((response) => response.id === 3).error.code, -32602);
  assert.equal(responses.find((response) => response.id === 4).error.code, -32601);
  assert.equal(responses.find((response) => response.id === 7).result.isError, true);
});

test('unexpected failures redact credentials from stderr as well as the tool response', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
  const client = createGuildClient({ token });
  client.api = async () => { throw new Error(sensitive); };
  const [response] = await exchange(client, [{ id: 1, method: 'tools/call', params: { name: 'list_sessions' } }]);
  assert.equal(response.result.isError, true);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].includes(token), false);
  assert.equal(logged[0].includes(otherToken), false);
  assert.match(logged[0], /\[token hidden\]/);
});

test('a session start that outlasts its wait is reported as unknown, not as a stopped manager', async () => {
  const client = createGuildClient({ url, token, startTimeoutMs: 100 });
  const [response] = await exchange(client, [{ id: 1, method: 'tools/call', params: { name: 'start_session', arguments: { tool: 'claude', name: 'hang' } } }]);
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /whether it started is unknown.*list_sessions/);
  assert.doesNotMatch(response.result.content[0].text, /not running/);
});

test('without the flag send_input is an unknown tool, and a stopped manager is reported, not thrown', async (t) => {
  const { callTool } = startMcp(t);
  assert.equal((await callTool('send_input', { session_id: session.id, text: 'rm -rf /' })).error.code, -32602);

  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-mcp-none-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  const idle = startMcp(t, [], { AGENT_GUILD_HOME: elsewhere, AGENT_GUILD_PORT: '1' });
  const status = JSON.parse((await idle.callTool('guild_status')).body);
  assert.equal(status.running, false);
  assert.match(status.message, /agent-guild --no-browser/);
  const list = await idle.callTool('list_sessions');
  assert.equal(list.isError, true);
  assert.match(list.body, /not running/);
});
