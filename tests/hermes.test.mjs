import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { HermesLive, HermesTokens, HERMES_EXPIRY_MS, hermesHomeKey, hermesRoot } from '../src/manager/hermes.mjs';
import { SessionHooks } from '../src/manager/session-hooks.mjs';
import { ProviderRegistry } from '../src/manager/providers.mjs';
import { createAccountEditor } from '../src/manager/accounts.mjs';
import { createManagerServer } from '../src/manager/server.mjs';
import { SessionManager } from '../src/manager/session-manager.mjs';
import { McpConnect, ownServer } from '../src/manager/mcp-connect.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const event = (seq, name, data) => ({ seq, event: name, data });
const heartbeat = (seq, open = {}) => ({ seq, open: { sessions: {}, working: [], subagents: {}, tools: {}, waits: {}, ...open } });
const statuses = (live, account = 'default') => Object.fromEntries(live.view(account).agents.map((a) => [a.agentId, a.status]));
const counts = (l) => l && { working: l.working, waiting: l.waiting };
const SECRET = 'sk-live-0123456789abcdef';
const MASKED = 'sk-liv...cdef';

async function until(what, read, done) {
  const deadline = Date.now() + 15000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    assert.ok(Date.now() < deadline, `${what} never came:\n${JSON.stringify(value, null, 2)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// The real plugin under Python, with Hermes 0.23.1's plugin context and modules stood in by their real names and
// signatures. Redaction masks only under force=True, as Hermes does with security.redact_secrets off; 'broken' raises.
async function startPlugin(t, { url, token, redact = 'mask', heartbeatSeconds = null, tokenFile = null, proxy = null }) {
  const stub = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-hermes-plugin-'));
  t.after(() => fs.rmSync(stub, { recursive: true, force: true }));
  fs.mkdirSync(path.join(stub, 'agent'));
  fs.writeFileSync(path.join(stub, 'agent', '__init__.py'), '');
  fs.writeFileSync(path.join(stub, 'agent', 'secret_scope.py'), 'import os\n\ndef get_secret(name):\n    return os.environ.get(name)\n');
  fs.writeFileSync(path.join(stub, 'agent', 'redact.py'), [
    'def redact_sensitive_text(text, *, force=False, code_file=False, file_read=False, secret_file=False, redact_url_credentials=False):',
    redact === 'broken' ? '    raise RuntimeError("redaction failed")' : `    return text.replace(${JSON.stringify(SECRET)}, ${JSON.stringify(MASKED)}) if force else text`,
  ].join('\n'));
  if (!tokenFile) {
    tokenFile = path.join(stub, 'report.token');
    fs.writeFileSync(tokenFile, `${token}\n/the/home\n${url}\n`);
  }
  fs.writeFileSync(path.join(stub, 'drive.py'), [
    'import gc, importlib.util, json, os, sys, threading',
    'hooks = {}',
    'unloads = []',
    'loads = [0]',
    'class Ctx:',
    '    profile_name = "default"',
    '    def register_hook(self, name, callback):',
    '        hooks[name] = callback',
    '    def on_unload(self, callback):',
    '        unloads.append(callback)',
    'def load():',
    '    loads[0] += 1',
    '    hooks.clear()',
    '    spec = importlib.util.spec_from_file_location(f"agent_guild_plugin_{loads[0]}", sys.argv[1])',
    '    plugin = importlib.util.module_from_spec(spec)',
    '    spec.loader.exec_module(plugin)',
    '    plugin.HEARTBEAT_SECONDS = float(os.environ.get("TEST_HEARTBEAT_SECONDS", plugin.HEARTBEAT_SECONDS))',
    '    plugin.register(Ctx())',
    'load()',
    'print("ready", flush=True)',
    'for line in sys.stdin:',
    '    message = json.loads(line)',
    '    if message.get("cmd") == "reload":',
    '        for callback in unloads:',
    '            callback()',
    '        unloads.clear()',
    '        load()',
    '        print("fired", flush=True)',
    '    elif message.get("cmd") == "state":',
    '        reporters = [o for o in gc.get_objects() if type(o).__name__ == "Reporter" and not getattr(o, "stopped", False)]',
    '        threads = sum(1 for t in threading.enumerate() if t.name == "agent-guild-reporter" and t.is_alive())',
    '        print(json.dumps({"open": [{k: sorted(v) for k, v in r.open.items()} for r in reporters], "threads": threads}), flush=True)',
    '    else:',
    '        callback = hooks.get(message["hook"])',
    '        if callback:',
    '            callback(**message["kw"])',
    '        print("fired", flush=True)',
  ].join('\n'));
  const python = spawn(process.platform === 'win32' ? 'python' : 'python3', [path.join(stub, 'drive.py'), path.join(here, '..', 'plugins', 'hermes', 'agent-guild', '__init__.py')], {
    env: {
      // With a proxy, the plugin runs with only HTTP_PROXY set: no other proxy setting and no NO_PROXY exception.
      ...(proxy ? Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(https?|all|no)_proxy$/i.test(name))) : process.env),
      ...(proxy && { HTTP_PROXY: proxy, http_proxy: proxy }),
      PYTHONPATH: stub, PYTHONDONTWRITEBYTECODE: '1', AGENT_GUILD_HERMES_TOKEN_FILE: tokenFile, ...(heartbeatSeconds && { TEST_HEARTBEAT_SECONDS: String(heartbeatSeconds) }),
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  t.after(() => python.kill());
  const lines = readline.createInterface({ input: python.stdout })[Symbol.asyncIterator]();
  assert.equal((await lines.next()).value, 'ready');
  const send = async (message) => {
    python.stdin.write(`${JSON.stringify(message)}\n`);
    return (await lines.next()).value;
  };
  return {
    fire: async (hook, kw) => assert.equal(await send({ hook, kw }), 'fired'),
    reload: async () => assert.equal(await send({ cmd: 'reload' }), 'fired'),
    state: async () => JSON.parse(await send({ cmd: 'state' })),
    tokenFile,
  };
}

test('a turn works from its start and waits on its own session, in Hermes 0.23.1\'s hook order', () => {
  const live = new HermesLive({ sweepMs: 0 });
  let seq = 0;
  const send = (name, data) => live.receive('default', 'gateway', [event(++seq, name, data)]);
  const turn = 'local-s1:local-s1:b2401558';
  send('on_session_start', { session_id: 'local-s1', platform: 'cli' });
  assert.deepEqual(statuses(live), {}, 'an idle session is no helper');
  send('pre_llm_call', { session_id: 'local-s1', turn_id: turn, platform: 'cli' });
  assert.deepEqual(statuses(live), { 'hermes:local-s1': 'working' }, 'a turn works from its start');
  send('on_session_start', { session_id: 'local-s2', platform: 'telegram' });
  send('pre_llm_call', { session_id: 'local-s2', turn_id: 'local-s2:local-s2:0c4f12aa', platform: 'telegram' });
  send('pre_tool_call', { session_id: 'local-s1', turn_id: turn, tool_call_id: 'call_rig_1', tool_name: 'terminal' });
  send('on_human_input_request', { session_id: 'local-s1', request_id: 'r1', kind: 'approval' });
  send('pre_approval_request', { session_id: 'local-s1', turn_id: turn, tool_call_id: 'call_rig_1' });
  assert.deepEqual(statuses(live), { 'hermes:local-s1': 'waiting', 'hermes:local-s2': 'working' });
  send('pre_approval_request', { session_id: 'local-s2', turn_id: 'local-s2:local-s2:0c4f12aa', tool_call_id: 'call_rig_2' });
  assert.deepEqual(statuses(live), { 'hermes:local-s1': 'waiting', 'hermes:local-s2': 'waiting' });
  send('post_approval_response', { session_id: 'local-s1', turn_id: turn, tool_call_id: 'call_rig_1', choice: 'once' });
  send('on_human_input_resolved', { session_id: 'local-s1', request_id: 'r1', kind: 'approval', outcome: 'once' });
  send('post_tool_call', { session_id: 'local-s1', turn_id: turn, tool_call_id: 'call_rig_1', tool_name: 'terminal' });
  send('post_llm_call', { session_id: 'local-s1', turn_id: turn, reply: 'done' });
  send('on_session_end', { session_id: 'local-s1', turn_id: turn, platform: 'cli' });
  assert.deepEqual(statuses(live), { 'hermes:local-s2': 'waiting' });
});

test('a heartbeat closes what a lost event left open, the last empty one included', () => {
  const live = new HermesLive({ sweepMs: 0 });
  live.receive('default', 'a', [
    event(1, 'on_session_start', { session_id: 's1', platform: 'telegram' }),
    event(2, 'pre_llm_call', { session_id: 's1', turn_id: 'u1' }),
    event(3, 'pre_tool_call', { session_id: 's1', turn_id: 'u1', tool_name: 'terminal', tool_call_id: 't1' }),
    event(4, 'pre_approval_request', { session_id: 's1', turn_id: 'u1', tool_call_id: 't1' }),
  ]);
  assert.deepEqual(statuses(live), { 'hermes:s1': 'waiting' });
  assert.equal(live.view('default').shells.length, 1);
  live.receive('default', 'a', [heartbeat(7, { sessions: { s1: { platform: 'telegram' } }, working: ['s1'] })]);
  assert.deepEqual(statuses(live), { 'hermes:s1': 'working' });
  assert.equal(live.view('default').shells.length, 0);
  live.receive('default', 'a', [heartbeat(9)]);
  assert.deepEqual(live.view('default').agents, []);
  assert.deepEqual(counts(live.live('default')), { working: 0, waiting: 0 });
});

test('an event older than the last applied heartbeat is ignored', () => {
  const live = new HermesLive({ sweepMs: 0 });
  live.receive('default', 'a', [event(1, 'on_session_start', { session_id: 's1' }), heartbeat(5, { sessions: { s1: {} } })]);
  live.receive('default', 'a', [event(4, 'pre_llm_call', { session_id: 's1', turn_id: 'u1' }), event(3, 'pre_tool_call', { session_id: 's1', turn_id: 'u1', tool_call_id: 't1' })]);
  assert.deepEqual(statuses(live), {});
});

test('two reporting processes of one profile keep their own helpers', () => {
  const live = new HermesLive({ sweepMs: 0 });
  live.receive('default', 'gateway', [event(1, 'pre_llm_call', { session_id: 's1', turn_id: 'u1' })]);
  live.receive('default', 'cli', [event(1, 'pre_llm_call', { session_id: 's2', turn_id: 'u2' }), heartbeat(2, { sessions: { s2: {} }, working: ['s2'] })]);
  assert.deepEqual(Object.keys(statuses(live)).sort(), ['hermes:s1', 'hermes:s2']);
  live.receive('default', 'cli', [heartbeat(3)]);
  assert.deepEqual(Object.keys(statuses(live)), ['hermes:s1']);
});

test('a heartbeat that lists a subagent as a session too counts it once', () => {
  const live = new HermesLive({ sweepMs: 0 });
  live.receive('default', 'a', [
    event(1, 'subagent_start', { parent_session_id: 'p1', child_session_id: 'c1', child_role: 'leaf', child_goal: 'Map the code' }),
    event(2, 'pre_approval_request', { session_id: 'c1', turn_id: 'c1:t', tool_call_id: 'k1' }),
    heartbeat(3, { sessions: { p1: {}, c1: {} }, subagents: { c1: {} }, working: ['c1'], waits: { 'approval:k1': { session_id: 'c1' } } }),
  ]);
  assert.deepEqual(live.view('default').agents.map((a) => `${a.agentId}:${a.name}:${a.status}`), ['hermes:c1:Map the code:waiting']);
});

test('a session two reporting processes both report, as after an unload whose last heartbeat was lost, counts once', () => {
  const live = new HermesLive({ sweepMs: 0 });
  for (const instance of ['unloaded', 'reloaded']) live.receive('default', instance, [event(1, 'pre_llm_call', { session_id: 's1', turn_id: 'u1', platform: 'telegram' })]);
  assert.deepEqual(counts(live.live('default')), { working: 1, waiting: 0 });
});

test('a heartbeat alone rebuilds what it lists, as after a manager restart or a lost batch', () => {
  const live = new HermesLive({ sweepMs: 0 });
  live.receive('default', 'a', [heartbeat(4, {
    sessions: { s1: { platform: 'telegram' } },
    working: ['s1', 'c1'],
    subagents: { c1: { parent_session_id: 's1', child_role: 'leaf', child_goal: 'Map the code' } },
    tools: { 's1:t1': { session_id: 's1', tool_name: 'terminal' } },
    waits: { 'approval:s1:t1': { session_id: 's1' } },
  })]);
  assert.deepEqual(live.view('default'), {
    agents: [
      { agentId: 'hermes:s1', name: 'telegram', kind: 'session', status: 'waiting' },
      { agentId: 'hermes:c1', name: 'Map the code', kind: 'leaf', status: 'working', detail: 'Map the code' },
    ],
    shells: [{ key: 'hermes:s1:t1', agentId: 'hermes:s1' }],
  });
});

test('a reporting process silent for the expiry time is dropped', () => {
  let now = 1000;
  const live = new HermesLive({ sweepMs: 0, now: () => now });
  live.receive('default', 'a', [event(1, 'subagent_start', { child_session_id: 'c1', child_goal: 'Map the code' })]);
  now += HERMES_EXPIRY_MS - 1;
  live.sweep();
  assert.deepEqual(statuses(live), { 'hermes:c1': 'working' });
  now += 1;
  live.sweep();
  assert.equal(live.live('default'), null);
});

test("the Hermes plugin reports to a real manager: the tool card's live helpers, shells and counts per profile, and nothing on a Hermes terminal's card", { timeout: 60000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-hermes-'));
  const apiToken = 'c7d1e0b2a4f6983e5d7c1b0a2f4e6d8c9b1a3e5f7d9c2b4a';
  fs.writeFileSync(path.join(home, 'auth-token'), `${apiToken}\n`);
  const hermesHome = path.join(home, 'hermes');
  fs.mkdirSync(hermesHome);
  const stored = new HermesTokens(path.join(home, 'hermes-tokens'));
  await stored.ensure(hermesHomeKey(hermesHome), 'http://127.0.0.1:1');
  Object.assign(process.env, { AGENT_GUILD_HOME: home, AGENT_GUILD_PORT: '0', AGENT_GUILD_NO_UPDATE_CHECK: '1', AGENT_GUILD_SKIP_SHELL_ENV: '1' });
  const fixture = path.join(here, 'fixtures', 'fake-tool.mjs');
  fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify({ providers: [
    ...['anthropic', 'openai', 'google', 'xai', 'docker', 'shell'].map((id) => ({ id, enabled: false })),
    { id: 'hermes', vendor: 'Nous Research', tool: 'Hermes Agent', command: process.execPath, args: [fixture], versionArgs: [fixture, '--version'], reporting: 'hermes', homeVar: 'HERMES_HOME', profiles: 'hermes', env: { HERMES_HOME: hermesHome } },
  ] }));
  const { startManager } = await import('../src/manager/main.mjs');
  const ctx = await startManager({ sessionDefaults: { killGraceMs: 100 } });
  t.after(() => ctx.shutdown());
  const api = async (method, route, body) => {
    const res = await fetch(`${ctx.api.url}/api/v1${route}`, { method, headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return res.json();
  };
  const tokenFile = stored.file(hermesHomeKey(hermesHome));
  assert.equal(fs.readFileSync(tokenFile, 'utf8').split('\n')[2], ctx.api.url, 'a start gives every token file the address the manager now has');
  const { fire, state, reload } = await startPlugin(t, { tokenFile });

  const { session } = await api('POST', '/sessions', { providerId: 'hermes', cwd: home });
  const card = () => api('GET', `/sessions/${session.id}`).then((r) => r.session);
  const live = () => api('GET', '/providers').then((r) => r.providers.find((p) => p.id === 'hermes').accounts[0].live);
  const helpers = (l) => Object.fromEntries((l?.agents ?? []).map((a) => [a.id, `${a.name}:${a.status}`]));
  const untouched = async () => {
    const own = await card();
    assert.deepEqual({ agents: own.agents, shells: own.shells, reporting: own.reporting, reply: own.reply, model: own.model, compactions: own.context.compactions },
      { agents: [], shells: [], reporting: null, reply: null, model: null, compactions: 0 });
  };

  const turn = 's1:s1:b2401558';
  await untouched();
  await fire('on_session_start', { session_id: 's1', platform: 'telegram' });
  await fire('pre_llm_call', { session_id: 's1', turn_id: turn, platform: 'telegram', user_message: 'clean the build' });
  await until('the turn and reporting heard', live, (s) => helpers(s)['hermes:s1'] === 'telegram:working');
  await fire('pre_tool_call', { session_id: 's1', turn_id: turn, tool_name: 'terminal', tool_call_id: 't1', args: { command: 'rm -rf build' } });
  await until('its shell command', live, (s) => s?.shells.length === 1);
  await fire('on_human_input_request', { session_id: 's1', request_id: 'r1', kind: 'approval' });
  await fire('pre_approval_request', { session_id: 's1', turn_id: turn, tool_call_id: 't1', command: 'rm -rf build' });
  await until('the approval wait', live, (s) => helpers(s)['hermes:s1'] === 'telegram:waiting');
  assert.deepEqual(counts(await live()), { working: 0, waiting: 1 });
  await untouched();
  await fire('post_approval_response', { session_id: 's1', turn_id: turn, tool_call_id: 't1', choice: 'once' });
  await fire('on_human_input_resolved', { session_id: 's1', request_id: 'r1', kind: 'approval', outcome: 'once' });
  await fire('post_tool_call', { session_id: 's1', turn_id: turn, tool_call_id: 't1', tool_name: 'terminal', status: 'ok' });
  await fire('subagent_start', { parent_session_id: 's1', child_session_id: 'c1', child_role: 'leaf', child_goal: 'Map the code' });
  await until('the subagent', live, (s) => helpers(s)['hermes:c1'] === 'Map the code:working' && helpers(s)['hermes:s1'] === 'telegram:working' && s.shells.length === 0);
  await fire('subagent_stop', { child_session_id: 'c1' });
  await fire('post_llm_call', { session_id: 's1', turn_id: turn, assistant_response: 'All done.', model: 'hermes-model' });
  await fire('post_compaction', { session_id: 's1' });
  await fire('on_session_end', { session_id: 's1', turn_id: turn });
  await until('the idle session leaving the card', live, (s) => Object.keys(helpers(s)).length === 0);
  await fire('on_session_start', { session_id: 's3', platform: 'discord', model: 'hermes-model' });
  await fire('pre_llm_call', { session_id: 's3', turn_id: 's3:s3:41d0', platform: 'discord' });
  await until('the Discord session working', live, (s) => helpers(s)['hermes:s3'] === 'discord:working');
  await untouched();
  assert.deepEqual((await api('GET', `/sessions/${session.id}/reply`)).reply, null, 'Read has nothing of theirs to read');
  await fire('on_session_end', { session_id: 's3', turn_id: 's3:s3:41d0' });
  await fire('on_session_finalize', { session_id: 's1' });
  await fire('on_session_finalize', { session_id: 's3' });
  await until('the session leaving', live, (s) => Object.keys(helpers(s)).length === 0);

  const resumed = 'r1:r1:c0f3a9';
  await fire('on_session_open', { session_id: 'r1', platform: 'cli', reason: 'resume' });
  await fire('pre_llm_call', { session_id: 'r1', turn_id: resumed, platform: 'cli', parent_session_id: '' });
  await until('a session resumed with no on_session_start, working', live, (s) => helpers(s)['hermes:r1'] === 'cli:working');
  await fire('post_llm_call', { session_id: 'r1', turn_id: resumed, platform: 'cli', assistant_response: 'again' });
  await fire('on_session_end', { session_id: 'r1', turn_id: resumed, platform: 'cli' });
  await fire('on_session_finalize', { session_id: 'r1', platform: 'oneshot', reason: 'cli_close' });
  await until('the resumed session leaving', live, (s) => !helpers(s)['hermes:r1']);

  const parentTurn = 'p1:p1:9be0a8';
  const childTurn = 'c2:c2:3ed17f';
  await fire('on_session_open', { session_id: 'p1', platform: 'cli', reason: 'create' });
  await fire('on_session_start', { session_id: 'p1', platform: 'cli' });
  await fire('pre_llm_call', { session_id: 'p1', turn_id: parentTurn, platform: 'cli', parent_session_id: '' });
  await fire('pre_tool_call', { session_id: 'p1', turn_id: parentTurn, tool_call_id: 'call_delegate_1', tool_name: 'delegate_task' });
  await fire('subagent_start', { parent_session_id: 'p1', child_session_id: 'c2', child_subagent_id: 'sa-0-fa75f0b8', child_role: 'leaf', child_goal: 'Map the code' });
  await fire('on_session_start', { session_id: 'c2', platform: 'subagent' });
  await fire('pre_llm_call', { session_id: 'c2', turn_id: childTurn, platform: 'subagent', parent_session_id: 'p1' });
  await until('the parent and its subagent, each once', live, (s) => helpers(s)['hermes:p1'] === 'cli:working' && helpers(s)['hermes:c2'] === 'Map the code:working');
  assert.deepEqual(counts(await live()), { working: 2, waiting: 0 });
  await fire('on_human_input_request', { session_id: 'c2', request_id: 'r2', kind: 'approval' });
  await fire('pre_approval_request', { session_id: 'c2', turn_id: childTurn, tool_call_id: 'call_c2' });
  await until('the subagent waiting, counted once', live, (counts) => counts?.working === 1 && counts.waiting === 1);
  await fire('post_approval_response', { session_id: 'c2', turn_id: childTurn, tool_call_id: 'call_c2', choice: 'once' });
  await fire('on_human_input_resolved', { session_id: 'c2', request_id: 'r2', kind: 'approval', outcome: 'once' });
  await fire('post_llm_call', { session_id: 'c2', turn_id: childTurn, platform: 'subagent', assistant_response: 'mapped' });
  await fire('on_session_end', { session_id: 'c2', turn_id: childTurn, platform: 'subagent' });
  await fire('subagent_stop', { parent_session_id: 'p1', child_session_id: 'c2', child_role: 'leaf', child_status: 'completed' });
  await fire('post_tool_call', { session_id: 'p1', turn_id: parentTurn, tool_call_id: 'call_delegate_1', tool_name: 'delegate_task' });
  await fire('post_llm_call', { session_id: 'p1', turn_id: parentTurn, platform: 'cli', assistant_response: 'delegated' });
  await fire('on_session_end', { session_id: 'p1', turn_id: parentTurn, platform: 'cli' });
  await fire('on_session_finalize', { session_id: 'p1', platform: 'oneshot', reason: 'cli_close' });
  assert.deepEqual((await state()).open, [{ sessions: [], working: [], subagents: [], tools: [], waits: [] }], 'a subagent, which Hermes never finalizes, is not kept open');

  const slowTurn = 'u1:u1:b7260b';
  await fire('on_session_open', { session_id: 'u1', platform: 'cli', reason: 'create' });
  await fire('on_session_start', { session_id: 'u1', platform: 'cli' });
  await fire('pre_llm_call', { session_id: 'u1', turn_id: slowTurn, platform: 'cli', parent_session_id: '' });
  await until('the slow turn working', live, (s) => helpers(s)['hermes:u1'] === 'cli:working');
  await reload();
  await until('the unloaded load cleared at once', live, (s) => !helpers(s)['hermes:u1']);
  await until('its reporter stopped', state, (s) => s.threads === 0);
  await fire('post_llm_call', { session_id: 'u1', turn_id: slowTurn, platform: 'cli', assistant_response: 'slow done' });
  await fire('on_session_end', { session_id: 'u1', turn_id: slowTurn, platform: 'cli' });
  await fire('on_session_finalize', { session_id: 'u1', platform: 'oneshot', reason: 'cli_close' });
  await until('nothing stale after the reload', live, (counts) => counts?.working === 0 && counts.waiting === 0);

  await api('POST', `/sessions/${session.id}/stop`);
  await until('the card to close', card, (s) => s.status === 'exited');
  await fire('on_session_start', { session_id: 's2', platform: 'cron' });
  await fire('pre_llm_call', { session_id: 's2', turn_id: 's2:s2:7a1e', platform: 'cron' });
  await until('live counts with no card open', live, (counts) => counts?.working === 1 && counts.waiting === 0);
});

async function captureServer(t) {
  const received = [];
  const held = [];
  let holding = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push(JSON.parse(body));
      const answer = () => res.end('{"ok":true}');
      if (holding) held.push(answer);
      else answer();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    received,
    held,
    hold: () => { holding = true; },
    release: () => { holding = false; for (const answer of held.splice(0)) answer(); },
  };
}

test('the plugin reports straight to the local manager, never through an HTTP proxy, even with no NO_PROXY exception', { timeout: 30000 }, async (t) => {
  const manager = await captureServer(t);
  const proxied = [];
  const proxy = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { proxied.push({ url: req.url, headers: req.headers, body }); res.statusCode = 502; res.end(); });
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => proxy.close());

  const { fire } = await startPlugin(t, { url: manager.url, token: 'report-token', proxy: `http://127.0.0.1:${proxy.address().port}` });
  await fire('on_session_start', { session_id: 'proxied-session', platform: 'telegram' });
  await fire('pre_llm_call', { session_id: 'proxied-session', turn_id: 'u1', platform: 'telegram' });
  await until('the manager has the turn', () => sentEvents(manager.received), (events) => events.some((e) => e.event === 'pre_llm_call'));
  assert.deepEqual(sentEvents(manager.received).map((e) => [e.event, e.data.session_id]), [['on_session_start', 'proxied-session'], ['pre_llm_call', 'proxied-session']]);
  const leaked = JSON.stringify(proxied);
  assert.equal(leaked.includes('report-token'), false, 'the proxy never sees the token');
  assert.equal(leaked.includes('proxied-session'), false, 'nor what is reported');
  assert.deepEqual(proxied, [], 'the proxy gets no request at all');
});

const sentEvents = (received) => received.flatMap((body) => body.messages.filter((m) => m.event));
const lastOpen = (received, instance) => received.filter((b) => !instance || b.instance === instance).flatMap((b) => b.messages.filter((m) => m.open)).at(-1)?.open;

test('the plugin redacts with Hermes\'s redactor, sends what rebuilds open items, and clears its instance when unloaded mid-send', { timeout: 30000 }, async (t) => {
  const manager = await captureServer(t);
  const { fire, reload } = await startPlugin(t, { url: manager.url, token: 'report-token' });
  await fire('on_session_start', { session_id: 's1', platform: 'telegram' });
  await fire('pre_llm_call', { session_id: 's1', turn_id: 'u1', platform: 'telegram' });
  await fire('pre_tool_call', { session_id: 's1', turn_id: 'u1', tool_call_id: 't1', tool_name: 'terminal', args: { command: `export KEY=${SECRET}` } });
  await fire('pre_approval_request', { session_id: 's1', turn_id: 'u1', tool_call_id: 't1' });
  await fire('subagent_start', { parent_session_id: 's1', child_session_id: 'c1', child_role: 'leaf', child_goal: `use ${SECRET}` });
  await until('the subagent sent', () => sentEvents(manager.received), (events) => events.some((e) => e.event === 'subagent_start'));
  const sent = JSON.stringify(manager.received);
  assert.equal(sent.includes(SECRET), false, 'no secret leaves');
  const byName = Object.fromEntries(sentEvents(manager.received).map((e) => [e.event, e.data]));
  assert.equal(byName.pre_tool_call.command, `export KEY=${MASKED}`);
  assert.equal(byName.subagent_start.child_goal, `use ${MASKED}`);

  const open = lastOpen(manager.received);
  assert.deepEqual(open, {
    sessions: { s1: { platform: 'telegram' } },
    working: ['s1'],
    subagents: { c1: { parent_session_id: 's1', child_role: 'leaf', child_goal: `use ${MASKED}` } },
    tools: { 's1:t1': { session_id: 's1', tool_name: 'terminal' } },
    waits: { 'approval:s1:t1': { session_id: 's1' } },
  });
  const restarted = new HermesLive({ sweepMs: 0 });
  restarted.receive('default', 'gateway', [{ seq: 1, open }]);
  assert.deepEqual(counts(restarted.live('default')), { working: 1, waiting: 1 }, 'a restarted manager rebuilds the wait from one heartbeat');
  assert.equal(restarted.view('default').shells.length, 1);

  const unloaded = manager.received[0].instance;
  manager.hold();
  await fire('post_tool_call', { session_id: 's1', turn_id: 'u1', tool_call_id: 't1', tool_name: 'terminal' });
  await until('a send in flight', () => manager.held.length, (n) => n === 1);
  await reload();
  manager.release();
  await until('the unloaded instance\'s last heartbeat, empty', () => lastOpen(manager.received, unloaded), (last) => last && Object.values(last).every((v) => Object.keys(v).length === 0));
});

test('when Hermes\'s redactor fails, the command and subagent goal are left out, never sent raw', { timeout: 30000 }, async (t) => {
  const manager = await captureServer(t);
  const { fire } = await startPlugin(t, { url: manager.url, token: 'report-token', redact: 'broken' });
  await fire('pre_tool_call', { session_id: 's1', turn_id: 'u1', tool_call_id: 't1', tool_name: 'terminal', args: { command: `export KEY=${SECRET}` } });
  await fire('subagent_start', { parent_session_id: 's1', child_session_id: 'c1', child_role: 'leaf', child_goal: `use ${SECRET}` });
  await until('the subagent event sent', () => sentEvents(manager.received), (events) => events.some((e) => e.event === 'subagent_start'));
  assert.equal(JSON.stringify(manager.received).includes(SECRET), false);
  const byName = Object.fromEntries(sentEvents(manager.received).map((e) => [e.event, e.data]));
  assert.equal('command' in byName.pre_tool_call, false);
  assert.equal('child_goal' in byName.subagent_start, false);
  assert.equal('child_goal' in lastOpen(manager.received).subagents.c1, false);
});

function makeHermesHome(base, names) {
  for (const [name, file] of names) {
    fs.mkdirSync(path.join(base, 'profiles', name), { recursive: true });
    fs.writeFileSync(path.join(base, 'profiles', name, file), '');
  }
}

function hermesRegistry(t, { env = {}, providerEnv = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-hermes-profiles-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = hermesRoot({ HOME: root, USERPROFILE: root }, process.platform);
  makeHermesHome(base, [['work', 'config.yaml'], ['coder', '.env'], ['Bad Name', 'config.yaml']]);
  fs.mkdirSync(path.join(base, 'profiles', 'logs-only'));
  const userFile = path.join(root, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [
    { id: 'hermes', vendor: 'Nous Research', tool: 'Hermes Agent', command: 'hermes', reporting: 'hermes', homeVar: 'HERMES_HOME', profiles: 'hermes', accounts: [{ id: 'mine', label: 'Mine' }], ...(providerEnv && { env: providerEnv }) },
  ] }));
  const registry = new ProviderRegistry({ userFile, env: { PATH: '', HOME: root, USERPROFILE: root, ...env }, platform: process.platform, checkUpdates: false, accountsDir: path.join(root, 'accounts') });
  return { registry, base, root, userFile };
}

test("a Hermes card's accounts are one home each: Hermes's base home, then each profile folder Hermes recognizes", (t) => {
  const { registry, base, userFile } = hermesRegistry(t);
  const hermes = registry.get('hermes');
  assert.deepEqual(registry.describe(hermes).accounts.map((a) => a.id), ['default', 'coder', 'work']);
  assert.equal(registry.describe(hermes).accountsEditable, false);
  const pick = (id) => { const a = registry.account(hermes, id); return { env: a.env, args: a.args, dir: a.dir }; };
  assert.deepEqual(pick('default'), { env: { HERMES_HOME: base }, args: ['-p', 'default'], dir: base }, 'the default selects the base home explicitly, whatever profile is active');
  assert.deepEqual(pick('work'), { env: { HERMES_HOME: base }, args: ['-p', 'work'], dir: path.join(base, 'profiles', 'work') });
  const selections = registry.accountsFor(hermes).map((a) => a.args.join(' '));
  assert.equal(new Set(selections).size, selections.length, 'no two accounts select the same profile');
  const before = fs.readFileSync(userFile, 'utf8');
  assert.throws(() => createAccountEditor({ registry, inUse: () => false }).add('hermes', { label: 'New' }), { code: 'accounts_unsupported' });
  assert.equal(fs.readFileSync(userFile, 'utf8'), before, 'no Hermes home is made');
  assert.equal(fs.existsSync(path.join(path.dirname(userFile), 'accounts')), false);
});

test("with HERMES_HOME set where the manager runs, the Hermes card's accounts come from that home", (t) => {
  const custom = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-hermes-custom-'));
  t.after(() => fs.rmSync(custom, { recursive: true, force: true }));
  makeHermesHome(custom, [['team', 'config.yaml']]);
  const { registry } = hermesRegistry(t, { env: { HERMES_HOME: custom } });
  const hermes = registry.get('hermes');
  assert.deepEqual(registry.accountsFor(hermes).map((a) => [a.id, a.dir, a.args, a.env]), [['default', custom, ['-p', 'default'], { HERMES_HOME: custom }], ['team', path.join(custom, 'profiles', 'team'), ['-p', 'team'], { HERMES_HOME: custom }]], "the manager's own HERMES_HOME stays in force");

  const fromCard = hermesRegistry(t, { providerEnv: { HERMES_HOME: custom } }).registry;
  assert.deepEqual(fromCard.accountsFor(fromCard.get('hermes')).map((a) => [a.id, a.dir]), [['default', custom], ['team', path.join(custom, 'profiles', 'team')]], 'the card env HERMES_HOME Hermes is started with');
});

test('with HERMES_HOME set to a custom home inside the native home, the accounts are the profiles hermes -p reaches there', (t) => {
  const { root, base, userFile } = hermesRegistry(t);
  const isolated = path.join(base, 'isolated');
  makeHermesHome(isolated, [['solo', 'config.yaml']]);
  const reg = new ProviderRegistry({ userFile, env: { PATH: '', HOME: root, USERPROFILE: root, HERMES_HOME: isolated }, platform: process.platform, checkUpdates: false, accountsDir: path.join(root, 'accounts') });
  assert.deepEqual(reg.accountsFor(reg.get('hermes')).map((a) => [a.id, a.dir]), [['default', isolated], ['solo', path.join(isolated, 'profiles', 'solo')]]);
});

test('with HERMES_HOME set to a profile inside the native home, the accounts come from the native home, as Hermes resolves it', (t) => {
  const inside = hermesRegistry(t);
  const reg = new ProviderRegistry({ userFile: inside.userFile, env: { PATH: '', HOME: inside.root, USERPROFILE: inside.root, HERMES_HOME: path.join(inside.base, 'profiles', 'work') }, platform: process.platform, checkUpdates: false, accountsDir: path.join(inside.root, 'accounts') });
  assert.deepEqual(reg.accountsFor(reg.get('hermes')).map((a) => [a.id, a.dir]), [['default', inside.base], ['coder', path.join(inside.base, 'profiles', 'coder')], ['work', path.join(inside.base, 'profiles', 'work')]]);
});

test('turning Hermes reporting off clears what the profile reports at once, refuses its reports meanwhile, and restores them when it fails', { timeout: 30000 }, async (t) => {
  const { registry } = hermesRegistry(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-hermes-off-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokens = new HermesTokens(path.join(dir, 'hermes-tokens'));
  const reportToken = await tokens.ensure(registry.account(registry.get('hermes'), 'work').home);
  const live = new HermesLive({ sweepMs: 0 });
  registry.liveFor = (provider, account) => live.live(account.home);
  let finish;
  const sessionHooks = { setEnabled: () => new Promise((resolve, reject) => { finish = { resolve, reject }; }) };
  const manager = Object.assign(new EventEmitter(), { list: () => [], refreshMultiplexers() {}, sessions: new Map(), sessionHooks });
  const token = 'f'.repeat(48);
  const api = createManagerServer({ manager, registry, token, port: 0, webDir: path.join(here, '..', 'web'), hermes: { tokens, live } });
  await api.listen();
  t.after(() => api.close());
  const report = (seq) => fetch(`${api.url}/api/v1/hermes/hook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-guild-report-token': reportToken },
    body: JSON.stringify({ instance: 'gateway', messages: [{ seq, event: 'pre_llm_call', data: { session_id: 's1', turn_id: `u${seq}`, platform: 'telegram' } }] }) });
  const turnOff = () => fetch(`${api.url}/api/v1/providers/hermes/reporting`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  const shown = async () => (await (await fetch(`${api.url}/api/v1/providers`, { headers: { authorization: `Bearer ${token}` } })).json()).providers.find((p) => p.id === 'hermes').accounts.find((a) => a.id === 'work').live;

  await report(1);
  assert.deepEqual(counts(await shown()), { working: 1, waiting: 0 });
  const failing = turnOff();
  await until('the off request under way', () => finish, Boolean);
  assert.equal(await shown(), null, 'cleared as soon as Off is asked');
  await report(2);
  assert.equal(await shown(), null, 'a report during the switch-off is refused');
  finish.reject(Object.assign(new Error('Hermes Agent could not turn off the Agent Guild plugin: locked'), { status: 502, code: 'reporting_setup_failed' }));
  let updates = 0;
  registry.on('updated', () => updates++);
  const failed = await failing;
  assert.equal(failed.status, 502);
  assert.equal(updates, 1, 'a failed switch still sends the cards what is now true');
  assert.match((await failed.json()).error.message, /could not turn off/);
  await report(3);
  assert.deepEqual(counts(await shown()), { working: 1, waiting: 0 }, 'reports count again after the switch-off failed');

  finish = null;
  const succeeding = turnOff();
  await until('the second off request under way', () => finish, Boolean);
  assert.equal(await shown(), null);
  finish.resolve(false);
  assert.equal((await succeeding).status, 200);
  assert.equal(await shown(), null);
});

test('a card with more sessions than it shows still counts them all', () => {
  const live = new HermesLive({ sweepMs: 0 });
  const ids = Array.from({ length: 65 }, (_, i) => `s${i}`);
  live.receive('default', 'a', [heartbeat(1, { sessions: Object.fromEntries(ids.map((id) => [id, {}])), working: ids })]);
  assert.equal(live.view('default').agents.length, 64);
  assert.deepEqual(counts(live.live('default')), { working: 65, waiting: 0 });
});

test('an approval Hermes reports with its turn and no session is rebuilt as that session waiting', { timeout: 30000 }, async (t) => {
  const manager = await captureServer(t);
  const { fire } = await startPlugin(t, { url: manager.url, token: 'report-token' });
  await fire('pre_llm_call', { session_id: 's1', turn_id: 'u1', platform: 'cli' });
  await fire('pre_approval_request', { turn_id: 'u1', tool_call_id: 't1' });
  const open = await until('the wait in a heartbeat', () => lastOpen(manager.received), (last) => last && Object.keys(last.waits).length === 1);
  assert.equal(sentEvents(manager.received).find((e) => e.event === 'pre_approval_request').data.session_id, 's1');
  const restarted = new HermesLive({ sweepMs: 0 });
  restarted.receive('default', 'gateway', [{ seq: 1, open }]);
  assert.deepEqual(counts(restarted.live('default')), { working: 0, waiting: 1 });
});

test("Hermes's default home on Windows follows LOCALAPPDATA and the data folder suffix", () => {
  const user = { USERPROFILE: 'C:\\Users\\ada' };
  assert.equal(hermesRoot({ ...user, LOCALAPPDATA: 'D:\\Local' }, 'win32'), 'D:\\Local\\hermes');
  assert.equal(hermesRoot(user, 'win32'), 'C:\\Users\\ada\\AppData\\Local\\hermes');
  assert.equal(hermesRoot({ ...user, LocalAppData: 'D:\\Local', HERMES_DATA_DIR_SUFFIX: '-dev' }, 'win32'), 'D:\\Local\\hermes-dev');
  assert.equal(hermesRoot({ ...user, LOCALAPPDATA: 'D:\\Local', HERMES_HOME: '%LOCALAPPDATA%\\other\\profiles\\work' }, 'win32'), 'D:\\Local\\other');
  assert.equal(hermesRoot({ HOME: '/home/ada', HERMES_DATA_DIR_SUFFIX: '-dev' }, 'linux'), '/home/ada/.hermes-dev');
  assert.equal(hermesRoot({ HOME: '/home/ada', DATA: '/srv', HERMES_HOME: '${DATA}/hermes' }, 'linux'), '/srv/hermes');
});

test('a Hermes profile is listed by Hermes\'s own rules: names up to 64 characters, never one it deleted', (t) => {
  const { registry, base, userFile, root } = hermesRegistry(t);
  const long = 'a'.repeat(64);
  makeHermesHome(base, [[long, 'config.yaml'], ['a'.repeat(65), 'config.yaml'], ['gone', 'config.yaml']]);
  fs.mkdirSync(path.join(base, 'profiles', '.deleted', 'gone'), { recursive: true });
  fs.mkdirSync(path.join(base, 'profiles', 'folder-marker', 'config.yaml'), { recursive: true });
  const reg = new ProviderRegistry({ userFile, env: registry.env, platform: process.platform, checkUpdates: false, accountsDir: path.join(root, 'accounts') });
  assert.deepEqual(reg.accountsFor(reg.get('hermes')).map((a) => a.id), ['default', long, 'coder', 'work']);
});

const win = process.platform === 'win32';

/** Starts Python holding `file` open until it reads a line, added to `readers` first so it is stopped even when this fails. */
async function holdOpen(file, readers) {
  const reader = spawn('python', ['-c', 'import sys\nf = open(sys.argv[1], encoding="utf-8")\nprint("open", flush=True)\nsys.stdin.readline()\nf.close()\nprint("closed", flush=True)', file], { stdio: ['pipe', 'pipe', 'inherit'] });
  readers.push(reader);
  const lines = readline.createInterface({ input: reader.stdout })[Symbol.asyncIterator]();
  assert.equal((await lines.next()).value, 'open');
  return { reader, lines };
}

/** Stops the readers and waits until each has exited, so the files they held can be deleted. */
function stopReaders(readers) {
  return Promise.all(readers.map((reader) => (reader.exitCode !== null || reader.signalCode !== null ? null : new Promise((resolve) => {
    reader.once('exit', resolve);
    reader.once('error', resolve);
    reader.kill();
  }))));
}

/** A deletion or replacement another process blocks fails with EPERM, or EBUSY from Node 22's rmSync. */
const blocked = (err) => ['EPERM', 'EBUSY'].includes(err.code);

/** The plugin commit the Hermes setup tests install, as a release stamps it. */
const PLUGIN_COMMIT = '0123456789abcdef0123456789abcdef01234567';

/** With `relative`, each card's HERMES_HOME is relative and the manager runs in `root`, where it resolves. */
function hermesSetup(t, cards, { relative = false, pluginCommit = PLUGIN_COMMIT } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-hermes-setup-'));
  const before = process.cwd();
  if (relative) process.chdir(root);
  t.after(() => {
    process.chdir(before);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const fake = path.join(here, 'fixtures', 'fake-hermes.mjs');
  if (win) fs.writeFileSync(path.join(bin, 'hermes.cmd'), `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
  else fs.writeFileSync(path.join(bin, 'hermes'), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  const log = path.join(root, 'hermes.log');
  const systemDirs = win ? ['System32', ''].map((dir) => path.join(process.env.SystemRoot || 'C:\\Windows', dir)) : ['/usr/bin', '/bin'];
  const env = {
    PATH: [bin, ...systemDirs].join(path.delimiter), HOME: root, USERPROFILE: root, FAKE_HERMES_LOG: log, FAKE_HERMES_HOMES: path.join(root, 'homes.log'),
    ...(win && { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: '.COM;.EXE;.BAT;.CMD' }),
  };
  const userFile = path.join(root, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: Object.entries(cards).map(([id, home]) => {
    fs.mkdirSync(path.join(root, home), { recursive: true });
    return { id, vendor: 'Nous Research', tool: 'Hermes Agent', command: 'hermes', reporting: 'hermes', homeVar: 'HERMES_HOME', profiles: 'hermes', env: { HERMES_HOME: relative ? home : path.join(root, home) }, ...(relative && { mcp: 'hermes' }) };
  }) }));
  const registry = new ProviderRegistry({ userFile, env, platform: process.platform, checkUpdates: false, accountsDir: path.join(root, 'accounts') });
  const tokens = new HermesTokens(path.join(root, 'hermes-tokens'));
  const hooks = new SessionHooks({ registry, dir: path.join(root, 'reporting'), version: '1', hermesTokens: tokens, hermesPluginCommit: pluginCommit, getApiUrl: () => env.TEST_API_URL ?? 'http://127.0.0.1:47821' });
  const home = (id) => registry.accountsFor(registry.get(id))[0];
  const token = (id) => tokens.get(home(id).home);
  const homes = () => (fs.existsSync(env.FAKE_HERMES_HOMES) ? fs.readFileSync(env.FAKE_HERMES_HOMES, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
  return { registry, tokens, hooks, env, log, home, token, homes, root };
}

test('a relative HERMES_HOME is pinned where discovery found it: reporting setup, MCP commands and terminals, run elsewhere, all target that home', { timeout: 30000 }, async (t) => {
  const { registry, hooks, env, home, homes, root } = hermesSetup(t, { hermes: 'relative-home' }, { relative: true });
  makeHermesHome(home('hermes').dir, [['work', 'config.yaml']]);
  registry.reload();
  const hermes = registry.get('hermes');
  const base = path.join(process.cwd(), 'relative-home');
  assert.deepEqual(registry.accountsFor(hermes).map((a) => [a.id, a.dir, a.env.HERMES_HOME, a.args]),
    [['default', base, base, ['-p', 'default']], ['work', path.join(base, 'profiles', 'work'), base, ['-p', 'work']]],
    "discovered against the manager's folder, each profile still chosen with -p");
  const discovered = Object.fromEntries(registry.accountsFor(hermes).map((a) => [a.id, a.home]));
  const targeted = (from) => homes().slice(from).map((call) => [call.profile, hermesHomeKey(call.home)]);
  const onlyDiscovered = (calls) => calls.every(([profile, key]) => discovered[profile] === key);

  // Reporting setup runs in Agent Guild's reporting folder.
  assert.equal(await hooks.setEnabled(hermes, true), true);
  const setup = targeted(0);
  assert.deepEqual([...new Set(setup.map(([profile]) => profile))], ['default', 'work']);
  assert.ok(onlyDiscovered(setup), JSON.stringify(setup));

  // MCP commands run in the MCP folder.
  const mcpCwd = path.join(root, 'mcp-folder');
  fs.mkdirSync(mcpCwd);
  const mcp = new McpConnect({ registry, own: ownServer(process.execPath, path.join(root, 'guild')), home: path.join(root, 'guild'), prepareAccount: () => {}, dir: mcpCwd });
  let from = homes().length;
  assert.deepEqual((await mcp.refresh(hermes, { force: true })).map((a) => [a.id, a.state]), [['default', 'off'], ['work', 'off']]);
  const mcpCalls = targeted(from);
  assert.deepEqual(mcpCalls.map(([profile]) => profile).sort(), ['default', 'work'], 'one probe per profile, in whatever order they finish');
  assert.ok(onlyDiscovered(mcpCalls), JSON.stringify(mcpCalls));

  // A terminal runs in its own folder.
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const manager = new SessionManager({ registry, baseEnv: env, getApiUrl: () => '' });
  try {
    from = homes().length;
    await manager.create({ providerId: 'hermes', cwd: project, account: 'work' });
    const terminal = await until('the terminal ran Hermes', () => targeted(from), (calls) => calls.length === 1);
    assert.deepEqual(terminal, [['work', discovered.work]]);
  } finally {
    await manager.shutdown(); // before the folder it runs in is deleted
  }
});

test('the Hermes report token stays in a file of Agent Guild\'s own: Hermes is given its path, and no command line or error carries the token', { timeout: 30000 }, async (t) => {
  const { registry, tokens, hooks, env, log, home } = hermesSetup(t, { hermes: 'home' });
  const hermes = registry.get('hermes');
  const dotEnv = path.join(home('hermes').dir, '.env');
  fs.writeFileSync(dotEnv, 'OPENAI_API_KEY=keep\n');
  const commands = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line).slice(2).join(' '));

  assert.equal(await hooks.setEnabled(hermes, true), true);
  const token = tokens.get(home('hermes').home);
  const file = tokens.file(home('hermes').home);
  assert.match(token, /^[0-9a-f]{48}$/);
  assert.deepEqual(fs.readFileSync(file, 'utf8').split('\n').slice(0, 3), [token, home('hermes').home, 'http://127.0.0.1:47821']);
  if (!win) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(commands().includes(`config set AGENT_GUILD_HERMES_TOKEN_FILE ${file}`), 'Hermes saves the path itself');
  assert.equal(fs.readFileSync(log, 'utf8').includes(token), false, 'no command carries the token');
  assert.equal(fs.readFileSync(dotEnv, 'utf8'), 'OPENAI_API_KEY=keep\n', 'Agent Guild writes no Hermes file');

  env.FAKE_HERMES_FAIL = 'plugins disable';
  await assert.rejects(hooks.setEnabled(hermes, false), (err) => {
    assert.equal(err.message, 'The Default profile failed: Hermes Agent could not turn off the Agent Guild plugin: it exited with code 1. Reporting is on for no profile.');
    return true;
  });
  assert.equal(tokens.account(token), null, 'the token is revoked though Hermes could not turn its plugin off');
  assert.ok(commands().includes('config unset AGENT_GUILD_HERMES_TOKEN_FILE'), 'and the rest of the teardown ran');

  delete env.FAKE_HERMES_FAIL;
  assert.equal(await hooks.setEnabled(hermes, false), false, 'turning off again finishes, though the setting is already gone');
  assert.equal(commands().filter((c) => c === 'plugins disable agent-guild').length, 2);
  assert.equal(tokens.get(home('hermes').home), null);
  assert.equal(fs.existsSync(file), false);
});

test('when one Hermes profile fails to turn on, the error names it and the profiles that report, and their activity still shows', { timeout: 30000 }, async (t) => {
  const { registry, hooks, env, home, tokens } = hermesSetup(t, { hermes: 'home' });
  makeHermesHome(home('hermes').dir, [['work', 'config.yaml']]);
  registry.reload();
  const hermes = registry.get('hermes');
  assert.deepEqual(registry.accountsFor(hermes).map((a) => a.id), ['default', 'work']);
  const live = new HermesLive({ sweepMs: 0 });
  registry.liveFor = (provider, account) => live.live(account.home);

  Object.assign(env, { FAKE_HERMES_FAIL: 'plugins install', FAKE_HERMES_FAIL_PROFILE: 'work' });
  await assert.rejects(hooks.setEnabled(hermes, true), (err) => {
    assert.equal(err.message, 'The work profile failed: Hermes Agent could not install the Agent Guild plugin: it exited with code 1. Reporting is on for Default.');
    return true;
  });
  const reporting = registry.accountsFor(hermes)[0].home;
  live.receive(tokens.account(tokens.get(reporting)), 'gateway', [event(1, 'pre_llm_call', { session_id: 's1', turn_id: 'u1', platform: 'telegram' })]);
  const described = registry.describe(hermes);
  assert.equal(hooks.enabled(hermes), true, 'one profile reports, so the card offers Turn off');
  assert.equal(hooks.note(hermes), 'Agent reporting is on for Default, not for work. Turn it off, then on, to try again.');
  assert.equal(tokens.get(registry.accountsFor(hermes)[1].home), null, 'the profile that failed keeps no accepted token');
  assert.notEqual(tokens.get(reporting), null, 'the profile that turned on keeps its token');
  assert.deepEqual(described.accounts.map((a) => [a.id, counts(a.live)]), [['default', { working: 1, waiting: 0 }], ['work', null]]);
});

test('each Hermes home has its own token and live state, two cards on one home share them, and a home no card has loses its token', { timeout: 30000 }, async (t) => {
  const { registry, tokens, hooks, home, token } = hermesSetup(t, { hermes: 'one', second: 'two', twin: 'one' });
  const live = new HermesLive({ sweepMs: 0 });
  registry.liveFor = (provider, account) => live.live(account.home);
  for (const id of ['hermes', 'second', 'twin']) assert.equal(await hooks.setEnabled(registry.get(id), true), true);
  const shown = (id) => registry.describe(registry.get(id)).accounts[0].live;

  assert.notEqual(token('hermes'), token('second'));
  assert.equal(token('twin'), token('hermes'));
  assert.equal(tokens.account(token('hermes')), home('hermes').home);
  assert.equal(tokens.account(token('second')), home('second').home);

  live.receive(tokens.account(token('hermes')), 'gateway', [event(1, 'pre_llm_call', { session_id: 's1', platform: 'cli' })]);
  assert.deepEqual([shown('hermes'), shown('twin'), shown('second')].map(counts), [{ working: 1, waiting: 0 }, { working: 1, waiting: 0 }, null]);

  assert.equal(await hooks.setEnabled(registry.get('hermes'), false), false);
  assert.equal(hooks.enabled(registry.get('second')), true, 'the other home keeps reporting');
  assert.equal(tokens.account(token('second')), home('second').home);

  const kept = token('second');
  await tokens.ensure('/a/home/no/card/has');
  assert.equal(await tokens.prune(new Set(['hermes', 'second', 'twin'].map((id) => home(id).home))), true);
  assert.equal(tokens.get('/a/home/no/card/has'), null);
  assert.equal(tokens.account(kept), home('second').home);
});

test("on Windows the Hermes card owns the launcher in Hermes's own home, wherever LOCALAPPDATA puts it", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-hermes-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const card = JSON.parse(fs.readFileSync(path.join(here, '..', 'config', 'providers.optional.json'), 'utf8')).providers.find((p) => p.id === 'hermes');
  const userFile = path.join(root, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({ providers: [card] }));
  const registry = new ProviderRegistry({ userFile, env: { PATH: '', USERPROFILE: 'C:\\Users\\ada', LOCALAPPDATA: 'D:\\Local' }, platform: 'win32', checkUpdates: false, accountsDir: path.join(root, 'accounts') });
  const hermes = registry.get('hermes');
  assert.equal(hermes.accounts[0].dir, 'D:\\Local\\hermes');
  assert.ok(hermes.channels.native.paths.includes('D:\\Local\\hermes\\bin'));
});

test('two sessions whose backend gives their tool calls the same id keep their own shells and approvals', { timeout: 30000 }, async (t) => {
  const manager = await captureServer(t);
  const { fire } = await startPlugin(t, { url: manager.url, token: 'report-token' });
  for (const sid of ['s1', 's2']) {
    await fire('pre_llm_call', { session_id: sid, turn_id: `turn-${sid}`, platform: 'cli' });
    await fire('pre_tool_call', { session_id: sid, turn_id: `turn-${sid}`, tool_call_id: 'call_0', tool_name: 'terminal' });
  }
  await fire('pre_approval_request', { session_id: 's2', turn_id: 'turn-s2', tool_call_id: 'call_0' });
  await fire('post_tool_call', { session_id: 's1', turn_id: 'turn-s1', tool_call_id: 'call_0', tool_name: 'terminal' });
  await until('the first session\'s call ended', () => sentEvents(manager.received), (events) => events.some((e) => e.event === 'post_tool_call'));
  const open = await until('a heartbeat after it', () => lastOpen(manager.received), (last) => last && Object.keys(last.tools).length === 1);
  const shown = (live) => ({ ...statuses(live), shells: live.view('default').shells.map((shell) => shell.agentId) });
  const expected = { 'hermes:s1': 'working', 'hermes:s2': 'waiting', shells: ['hermes:s2'] };

  const fromEvents = new HermesLive({ sweepMs: 0 });
  fromEvents.receive('default', 'gateway', sentEvents(manager.received));
  assert.deepEqual(shown(fromEvents), expected);
  const fromHeartbeat = new HermesLive({ sweepMs: 0 });
  fromHeartbeat.receive('default', 'gateway', [{ seq: 1, open }]);
  assert.deepEqual(shown(fromHeartbeat), expected);
});

test('a session waiting on an approval comes back after its token and the manager\'s address change, from heartbeats alone', { timeout: 30000 }, async (t) => {
  const first = await captureServer(t);
  const moved = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const ok = req.headers['x-agent-guild-report-token'] === 'token-b';
      if (ok) moved.push(JSON.parse(body));
      res.statusCode = ok ? 200 : 401;
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { fire, tokenFile } = await startPlugin(t, { url: first.url, token: 'token-a', heartbeatSeconds: 0.2 });
  await fire('pre_llm_call', { session_id: 's1', turn_id: 'u1', platform: 'cli' });
  await fire('pre_approval_request', { session_id: 's1', turn_id: 'u1', tool_call_id: 't1' });
  await until('the wait reported to the first address', () => lastOpen(first.received), (open) => open && Object.keys(open.waits).length === 1);

  fs.writeFileSync(`${tokenFile}.next`, `token-b\n/the/home\nhttp://127.0.0.1:${server.address().port}\n`);
  fs.renameSync(`${tokenFile}.next`, tokenFile);
  const open = await until('a heartbeat at the new address with the new token', () => lastOpen(moved), Boolean);
  const live = new HermesLive({ sweepMs: 0 });
  live.receive('default', 'gateway', [{ seq: 1, open }]);
  assert.deepEqual(statuses(live), { 'hermes:s1': 'waiting' });
});

test('stopping the manager ends a Hermes command still running, and waits for it', { timeout: 30000 }, async (t) => {
  const { registry, hooks, env } = hermesSetup(t, { hermes: 'home' });
  const pidFile = path.join(registry.accountsFor(registry.get('hermes'))[0].dir, 'hang.pid');
  Object.assign(env, { FAKE_HERMES_HANG: 'plugins list', FAKE_HERMES_PID: pidFile });
  hooks.warm();
  const pid = Number(await until('the Hermes command running', () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : ''), Boolean));
  await hooks.close();
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the command is gone once close resolves');
});

test("a token file Hermes is reading when the manager starts on another port: the manager starts, the card says reporting is off and why, and turning it on recovers", { skip: !win, timeout: 60000 }, async (t) => {
  const { registry, tokens, hooks, home, env } = hermesSetup(t, { hermes: 'home' });
  const hermes = registry.get('hermes');
  assert.equal(await hooks.setEnabled(hermes, true), true);
  const file = tokens.file(home('hermes').home);
  const before = fs.readFileSync(file, 'utf8');

  const readers = [];
  try {
    const { reader, lines } = await holdOpen(file, readers);
    fs.writeFileSync(`${file}.probe`, 'x');
    assert.throws(() => fs.renameSync(`${file}.probe`, file), blocked, 'the reader really blocks the replacement');
    fs.rmSync(`${file}.probe`);

    env.TEST_API_URL = 'http://127.0.0.1:47999';
    await tokens.refresh(env.TEST_API_URL);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'the file it could not replace is whole and unchanged');
    assert.equal(hooks.enabled(hermes), false);
    assert.match(hooks.note(hermes), /could not give Hermes Agent its new address\. Turn it on to try again\./);

    reader.stdin.write('\n');
    assert.equal((await lines.next()).value, 'closed');
  } finally {
    await stopReaders(readers);
  }
  assert.equal(await hooks.setEnabled(hermes, true), true);
  assert.equal(fs.readFileSync(file, 'utf8').split('\n')[2], 'http://127.0.0.1:47999');
  assert.equal(hooks.note(hermes), null);
});

test('overlapping requests for one Hermes home all get the token that is stored, and a removal never takes a token made after it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-hermes-tokens-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokens = new HermesTokens(dir);
  const stored = () => fs.readFileSync(tokens.file('/home/a'), 'utf8').split('\n').slice(0, 3);

  const given = await Promise.all([tokens.ensure('/home/a', 'http://one'), tokens.ensure('/home/a', 'http://one'), tokens.ensure('/home/a', 'http://two')]);
  assert.equal(new Set(given).size, 1, 'one token for the home');
  assert.deepEqual(stored(), [given[0], '/home/a', 'http://two']);

  const [, , remade] = await Promise.all([tokens.refresh('http://three'), tokens.remove('/home/a'), tokens.ensure('/home/a', 'http://four')]);
  assert.notEqual(remade, given[0]);
  assert.deepEqual(stored(), [remade, '/home/a', 'http://four'], 'the token made after the removal stays');
  assert.equal(tokens.get('/home/a'), remade);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => !name.endsWith('.token')), ['valid.json'], 'no temporary file is left');
});

test('a Hermes home whose last card is removed while its reporting is being set up gets no token', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-hermes-prune-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokens = new HermesTokens(dir);
  assert.equal(await tokens.prune(new Set(['/home/a'])), true);

  const setup = tokens.ensure('/home/a', 'http://one');
  const removed = tokens.prune(new Set());
  await assert.rejects(setup, /turned off meanwhile/);
  assert.equal(await removed, true);
  assert.equal(tokens.get('/home/a'), null);
  assert.deepEqual(fs.readdirSync(dir), ['valid.json'], 'no token is left for the home');

  const before = await (async () => { await tokens.prune(new Set(['/home/a'])); return tokens.ensure('/home/a', 'http://one'); })();
  assert.equal(tokens.account(before), '/home/a');
  const pruned = tokens.prune(new Set());
  assert.equal(tokens.account(before), null, 'refused at once, before the file is deleted');
  await assert.rejects(tokens.ensure('/home/a', 'http://one'));
  assert.equal(await pruned, true);
  assert.deepEqual(fs.readdirSync(dir), ['valid.json']);
});

test('a revoked Hermes token is refused at once even while its file cannot be deleted, and the file goes once it can', { skip: !win, timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-hermes-revoke-'));
  const readers = [];
  t.after(async () => {
    await stopReaders(readers);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  const tokens = new HermesTokens(dir);
  await tokens.prune(new Set(['/home/a', '/home/b']));
  const a = await tokens.ensure('/home/a', 'http://one');
  const b = await tokens.ensure('/home/b', 'http://one');
  const hold = async (file) => {
    const { reader, lines } = await holdOpen(file, readers);
    assert.throws(() => fs.rmSync(file), blocked, 'the reader really blocks the deletion');
    return async () => { reader.stdin.write('\n'); assert.equal((await lines.next()).value, 'closed'); };
  };

  const releaseA = await hold(tokens.file('/home/a'));
  const pruned = tokens.prune(new Set(['/home/b']));
  assert.equal(tokens.account(a), null, 'the last card gone: refused at once');
  assert.equal(await pruned, false, 'the cleanup is not done while the file is held');
  assert.equal(fs.existsSync(tokens.file('/home/a')), true);
  assert.equal(tokens.account(a), null);
  assert.equal(tokens.account(b), '/home/b');
  await releaseA();
  assert.equal(await tokens.prune(new Set(['/home/b'])), true, 'the next change deletes it');
  assert.equal(fs.existsSync(tokens.file('/home/a')), false);

  const releaseB = await hold(tokens.file('/home/b'));
  await tokens.remove('/home/b');
  assert.equal(tokens.account(b), null, 'reporting turned off: refused though the file is held');
  assert.equal(tokens.get('/home/b'), null);
  assert.equal(fs.existsSync(tokens.file('/home/b')), true, 'the file is still held');
  assert.equal(new HermesTokens(dir).account(b), null, 'and stays refused after a restart');
  await releaseB();
  const again = await tokens.ensure('/home/b', 'http://one');
  assert.notEqual(again, b, 'turning it on again makes a new token');
  assert.equal(tokens.account(again), '/home/b');
  assert.equal(tokens.account(b), null);
});

test('a revoked Hermes token stays refused after a restart, even when its file is left behind', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-hermes-restart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokens = new HermesTokens(dir);
  const kept = await tokens.ensure('/home/a', 'http://one');
  const revoked = await tokens.ensure('/home/b', 'http://one');
  const leftBehind = fs.readFileSync(tokens.file('/home/b'), 'utf8');
  assert.equal(await tokens.remove('/home/b'), true);
  fs.writeFileSync(tokens.file('/home/b'), leftBehind, { mode: 0o600 });

  const restarted = new HermesTokens(dir);
  assert.equal(restarted.unreadable, null);
  assert.equal(restarted.account(kept), '/home/a');
  assert.equal(restarted.account(revoked), null, 'a token file alone is never accepted');
  assert.equal(await restarted.prune(new Set(['/home/a', '/home/b'])), true);
  assert.equal(fs.existsSync(restarted.file('/home/b')), false, 'the file left behind is deleted');
});

test('an unreadable Hermes token record accepts no token and says so, unlike one with no token in it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-hermes-corrupt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokens = new HermesTokens(dir);
  const token = await tokens.ensure('/home/a', 'http://one');
  assert.equal(new HermesTokens(path.join(dir, 'none-yet')).unreadable, null, 'no record yet is an empty one');

  fs.writeFileSync(tokens.recordFile, '{}');
  assert.equal(new HermesTokens(dir).unreadable, null, 'an empty record is not reported');
  assert.equal(new HermesTokens(dir).account(token), null);

  for (const text of ['{"/home/a": "', '["/home/a"]', 'null']) {
    fs.writeFileSync(tokens.recordFile, text);
    const restarted = new HermesTokens(dir);
    assert.equal(restarted.unreadable, 'it is not a valid record', text);
    assert.equal(restarted.account(token), null, `${text}: the token file is not trusted instead`);
    assert.equal(restarted.get('/home/a'), null);
  }

  const restarted = new HermesTokens(dir);
  const made = await restarted.ensure('/home/a', 'http://one');
  assert.equal(restarted.unreadable, null, 'a saved change replaces the unreadable record');
  assert.notEqual(made, token);
  assert.equal(new HermesTokens(dir).account(made), '/home/a');
});

test('a Hermes removal asked after an enable wins, whichever finishes its file work last', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-hermes-order-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokens = new HermesTokens(dir);
  const enable = tokens.ensure('/home/a', 'http://one');
  const token = tokens.get('/home/a');
  assert.ok(token, 'the record has the token at once');
  const removal = tokens.remove('/home/a');
  assert.equal(tokens.account(token), null, 'refused as soon as the removal is asked');
  await assert.rejects(enable, /turned off meanwhile/);
  assert.equal(await removal, true);
  assert.equal(tokens.account(token), null);
  assert.equal(fs.existsSync(tokens.file('/home/a')), false);
  assert.equal(new HermesTokens(dir).account(token), null, 'and after a restart');

  // Refreshes and enables queued around a removal never bring its token back.
  const again = await tokens.ensure('/home/a', 'http://one');
  await Promise.all([tokens.ensure('/home/a', 'http://two'), tokens.remove('/home/a'), tokens.refresh('http://three')].map((p) => p.catch(() => {})));
  assert.equal(tokens.account(again), null);
  assert.equal(new HermesTokens(dir).account(again), null);
});

test('when the Hermes token record cannot be saved, no change counts and nothing reports success', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-hermes-unsaved-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokens = new HermesTokens(dir);
  await tokens.prune(new Set(['/home/a', '/home/b']));
  const a = await tokens.ensure('/home/a', 'http://one');
  fs.rmSync(tokens.recordFile);
  fs.mkdirSync(tokens.recordFile);

  await assert.rejects(tokens.ensure('/home/b', 'http://one'));
  assert.equal(tokens.get('/home/b'), null, 'no token is made');
  assert.equal(fs.existsSync(tokens.file('/home/b')), false);
  await assert.rejects(tokens.remove('/home/a'), 'a removal that is not saved fails');
  assert.equal(tokens.get('/home/a'), a, 'and changes nothing');
  await assert.rejects(tokens.prune(new Set(['/home/b'])));
  assert.equal(tokens.account(a), null, 'a home no card has is refused all the same');
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), [], 'no temporary file is left');
});

test('a Hermes home added back while its cleanup is still running can be turned on at once', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-hermes-readd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokens = new HermesTokens(dir);
  await tokens.prune(new Set(['/home/a']));
  const old = await tokens.ensure('/home/a', 'http://one');
  const cleanup = tokens.prune(new Set());
  const readded = tokens.prune(new Set(['/home/a']));
  const token = await tokens.ensure('/home/a', 'http://one');
  await Promise.all([cleanup, readded]);
  assert.notEqual(token, old);
  assert.equal(tokens.account(token), '/home/a');
  assert.equal(tokens.account(old), null);
  assert.equal(fs.readFileSync(tokens.file('/home/a'), 'utf8').split('\n')[0], token, 'the new token file is not deleted by the cleanup');
});

test('a failed Hermes setup never revokes the token that a request for the same home made after it set up', { timeout: 30000 }, async (t) => {
  const { registry, tokens, hooks, home } = hermesSetup(t, { hermes: 'one', twin: 'one' });
  const failing = registry.get('hermes');
  const twin = registry.get('twin');
  const shared = home('hermes').home;
  assert.equal(home('twin').home, shared, 'two cards on one home');
  failing.env.FAKE_HERMES_FAIL = 'plugins install';

  // A asks for the home first and starts B as it does; A's failing install then waits until B has asked for the home too.
  let later;
  let release;
  const bothAsked = new Promise((resolve) => { release = resolve; });
  const setup = tokens.setup.bind(tokens);
  let asks = 0;
  tokens.setup = (asked, work) => {
    if (asked === shared && ++asks === 1) later = hooks.setEnabled(twin, true);
    if (asked === shared && asks === 2) release();
    return setup(asked, work);
  };
  const run = hooks._hermesRun.bind(hooks);
  hooks._hermesRun = async (provider, account, args, what) => {
    if (provider === failing && args[0] === 'plugins' && args[1] === 'install') await bothAsked;
    return run(provider, account, args, what);
  };

  await assert.rejects(hooks.setEnabled(failing, true), /^Error: The Default profile failed: Hermes Agent could not install the Agent Guild plugin/);
  assert.equal(await later, true, 'the later request turns reporting on');
  const token = tokens.get(shared);
  assert.ok(token, 'and its token is kept');
  assert.equal(tokens.account(token), shared);
  assert.equal(fs.readFileSync(tokens.file(shared), 'utf8').split('\n')[0], token);
  assert.equal(hooks.enabled(twin), true);
  assert.equal(new HermesTokens(tokens.dir).account(token), shared, 'also after a restart');
});

const NEXT_COMMIT = 'fedcba9876543210fedcba9876543210fedcba98';
/** The plugin each profile's Hermes records, as `plugins list --json` gives it. */
const recorded = (registry, provider) => registry.accountsFor(provider).map((a) => {
  try { return [a.id, JSON.parse(fs.readFileSync(path.join(a.dir, 'fake-plugins.json'), 'utf8'))[0]]; } catch { return [a.id, null]; }
});
const installs = (log) => fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((argv) => argv[2] === 'plugins' && argv[3] === 'install');

test('turning on Hermes reporting installs the plugin at the commit this Agent Guild was released from, and nothing is left to update', { timeout: 30000 }, async (t) => {
  const { registry, hooks, log } = hermesSetup(t, { hermes: 'home' });
  const hermes = registry.get('hermes');
  assert.equal(await hooks.setEnabled(hermes, true), true);
  assert.deepEqual(installs(log), [['-p', 'default', 'plugins', 'install', 'oddessentials/agent-guild/plugins/hermes/agent-guild', '--ref', PLUGIN_COMMIT, '--enable']]);
  assert.deepEqual(recorded(registry, hermes), [['default', { name: 'agent-guild', status: 'enabled', source: `git pinned@${PLUGIN_COMMIT.slice(0, 8)}` }]]);
  assert.equal(hooks.updatable(hermes), false);
  assert.equal(hooks.note(hermes), null);
});

test('a Hermes plugin of another commit keeps reporting and offers Update plugin; a failed update keeps it, and an update changes only the profiles that report', { timeout: 60000 }, async (t) => {
  const { registry, tokens, env, log, root } = hermesSetup(t, { hermes: 'home' });
  makeHermesHome(registry.accountsFor(registry.get('hermes'))[0].dir, [['work', 'config.yaml']]);
  registry.reload();
  const hermes = registry.get('hermes');
  const before = new SessionHooks({ registry, dir: path.join(root, 'reporting'), version: '1', hermesTokens: tokens, hermesPluginCommit: PLUGIN_COMMIT, getApiUrl: () => 'http://127.0.0.1:47821' });
  assert.equal(await before.setEnabled(hermes, true), true);
  const [base, work] = registry.accountsFor(hermes);
  const kept = tokens.get(base.home);

  // The next Agent Guild, released from another commit.
  const hooks = new SessionHooks({ registry, dir: path.join(root, 'reporting'), version: '2', hermesTokens: tokens, hermesPluginCommit: NEXT_COMMIT, getApiUrl: () => 'http://127.0.0.1:47821' });
  t.after(() => hooks.close());
  await hooks._readHermes(hermes);
  assert.equal(hooks.enabled(hermes), true, 'the old plugin still reports');
  assert.equal(hooks.updatable(hermes), true);
  assert.equal(hooks.note(hermes), 'Agent reporting is on. The Agent Guild plugin of Default, work is not the one this Agent Guild installs; it keeps reporting until you update it.');
  assert.equal(installs(log).length, 2, 'starting changes no plugin');

  // Reporting turned off for work by hand in Hermes: its plugin, of the old commit too, stays off.
  fs.writeFileSync(path.join(work.dir, 'fake-plugins.json'), JSON.stringify([{ name: 'agent-guild', status: 'disabled', source: `git pinned@${PLUGIN_COMMIT.slice(0, 8)}` }]));
  await hooks._readHermes(hermes);
  assert.equal(hooks.updatable(hermes), true);

  env.FAKE_HERMES_FAIL = 'plugins install';
  await assert.rejects(hooks.update(hermes), (err) => {
    assert.equal(err.message, `The Default profile was not updated: Hermes Agent could not update the Agent Guild plugin: it exited with code 1. Hermes still has the plugin it had, git pinned@${PLUGIN_COMMIT.slice(0, 8)}, and it is on.`);
    return true;
  });
  delete env.FAKE_HERMES_FAIL;
  assert.equal(recorded(registry, hermes)[0][1].source, `git pinned@${PLUGIN_COMMIT.slice(0, 8)}`, 'Hermes kept the plugin it had');
  assert.equal(hooks.enabled(hermes), true);
  assert.equal(tokens.get(base.home), kept, 'and its token');
  assert.equal(hooks.updatable(hermes), true);

  env.FAKE_HERMES_UNPINNED = '1';
  await assert.rejects(hooks.update(hermes), /does not record the Agent Guild plugin at commit fedcba987654 as on\. Hermes now has another plugin, oddessentials\/agent-guild\/plugins\/hermes\/agent-guild, and it is on\.$/);
  delete env.FAKE_HERMES_UNPINNED;
  assert.equal(hooks.updatable(hermes), true, 'an update Hermes does not record is not taken as done');

  assert.equal(await hooks.update(hermes), true);
  assert.deepEqual(installs(log).slice(-1), [['-p', 'default', 'plugins', 'install', 'oddessentials/agent-guild/plugins/hermes/agent-guild', '--ref', NEXT_COMMIT, '--force', '--enable']]);
  assert.deepEqual(recorded(registry, hermes).map(([id, p]) => [id, p.status, p.source]),
    [['default', 'enabled', `git pinned@${NEXT_COMMIT.slice(0, 8)}`], ['work', 'disabled', `git pinned@${PLUGIN_COMMIT.slice(0, 8)}`]], 'the profile that does not report is left alone');
  assert.equal(tokens.get(base.home), kept, 'updating keeps the token');
  assert.equal(hooks.updatable(hermes), false);

  assert.equal(await hooks.setEnabled(hermes, true), true);
  assert.deepEqual(installs(log).slice(-1), [['-p', 'work', 'plugins', 'install', 'oddessentials/agent-guild/plugins/hermes/agent-guild', '--ref', NEXT_COMMIT, '--force', '--enable']], 'turning a profile on installs this commit over the old one');
  assert.equal(hooks.note(hermes), null);
});

test('a build that names no Hermes plugin commit installs none and says so, and still turns on a plugin Hermes already has', { timeout: 30000 }, async (t) => {
  const { registry, hooks, tokens, log, home } = hermesSetup(t, { hermes: 'home' }, { pluginCommit: null });
  const hermes = registry.get('hermes');
  await hooks._readHermes(hermes);
  assert.equal(hooks.note(hermes), 'Agent reporting is off: this build of Agent Guild names no commit of its Hermes plugin to install. Set AGENT_GUILD_HERMES_PLUGIN_COMMIT to one to install that plugin.');
  await assert.rejects(hooks.setEnabled(hermes, true), (err) => {
    assert.match(err.message, /^The Default profile failed: This build of Agent Guild names no commit of its Hermes plugin to install\./);
    assert.equal(err.code, 'reporting_unavailable');
    return true;
  });
  assert.equal(fs.existsSync(log) ? installs(log).length : 0, 0, 'nothing is installed from GitHub');
  assert.equal(tokens.get(home('hermes').home), null);
  await assert.rejects(hooks.update(hermes), { code: 'reporting_unavailable' });

  fs.writeFileSync(path.join(home('hermes').dir, 'fake-plugins.json'), JSON.stringify([{ name: 'agent-guild', status: 'disabled', source: 'git pinned@00000000' }]));
  assert.equal(await hooks.setEnabled(hermes, true), true, 'the plugin there is turned on');
  assert.equal(installs(log).length, 0);
  assert.equal(hooks.updatable(hermes), false);
  assert.equal(hooks.note(hermes), null);
});

/** The keys a profile's Hermes keeps with `config set`. */
const configKeys = (account) => { try { return JSON.parse(fs.readFileSync(path.join(account.dir, 'fake-config.json'), 'utf8')); } catch { return {}; } };

test('turning off Hermes reporting whose setting was removed by hand still finishes and revokes the token', { timeout: 30000 }, async (t) => {
  const { registry, hooks, tokens, home } = hermesSetup(t, { hermes: 'home' });
  const hermes = registry.get('hermes');
  assert.equal(await hooks.setEnabled(hermes, true), true);
  const token = tokens.get(home('hermes').home);
  assert.ok('AGENT_GUILD_HERMES_TOKEN_FILE' in configKeys(home('hermes')));
  fs.writeFileSync(path.join(home('hermes').dir, 'fake-config.json'), '{}');

  assert.equal(await hooks.setEnabled(hermes, false), false, 'Hermes saying the setting is not set counts as removed');
  assert.equal(tokens.account(token), null);
  assert.equal(hooks.note(hermes), null);
});

test('turning off Hermes reporting goes through every profile: each one is revoked though Hermes fails a step, and the error names each failure', { timeout: 30000 }, async (t) => {
  const { registry, hooks, tokens, env, home } = hermesSetup(t, { hermes: 'home' });
  makeHermesHome(home('hermes').dir, [['work', 'config.yaml']]);
  registry.reload();
  const hermes = registry.get('hermes');
  assert.equal(await hooks.setEnabled(hermes, true), true);
  const [base, work] = registry.accountsFor(hermes);
  const given = [tokens.get(base.home), tokens.get(work.home)];

  // Default cannot turn its plugin off; work cannot remove its setting, for another reason than its being absent.
  Object.assign(env, { FAKE_HERMES_FAIL: 'plugins disable', FAKE_HERMES_FAIL_PROFILE: 'default' });
  const disable = hooks.setEnabled(hermes, false);
  await assert.rejects(disable, (err) => {
    assert.equal(err.message, 'The Default profile failed: Hermes Agent could not turn off the Agent Guild plugin: it exited with code 1. Reporting is on for no profile.');
    return true;
  });
  assert.deepEqual(given.map((token) => tokens.account(token)), [null, null], 'both tokens are revoked');
  assert.equal(recorded(registry, hermes)[1][1].status, 'disabled', 'the profile after the one that failed is turned off too');

  assert.equal(await hooks.setEnabled(hermes, true), true);
  Object.assign(env, { FAKE_HERMES_FAIL: 'config unset', FAKE_HERMES_FAIL_PROFILE: 'work' });
  await assert.rejects(hooks.setEnabled(hermes, false), (err) => {
    assert.equal(err.message, "The work profile failed: Hermes Agent could not remove Agent Guild's reporting settings: it exited with code 1. Reporting is on for no profile.");
    return true;
  });
  assert.equal(tokens.get(work.home), null, 'a failed setting removal does not keep the token');
  assert.equal(tokens.get(base.home), null);
  delete env.FAKE_HERMES_FAIL;
  delete env.FAKE_HERMES_FAIL_PROFILE;
  assert.equal(await hooks.setEnabled(hermes, false), false, 'and turning off again finishes');
});

test('a Hermes token that cannot be revoked keeps the card from showing reporting off: Turn off stays, the note says why, and trying again revokes it', { timeout: 30000 }, async (t) => {
  const { registry, hooks, tokens, home } = hermesSetup(t, { hermes: 'home' });
  makeHermesHome(home('hermes').dir, [['work', 'config.yaml']]);
  registry.reload();
  const hermes = registry.get('hermes');
  assert.equal(await hooks.setEnabled(hermes, true), true);
  const [base, work] = registry.accountsFor(hermes);
  const given = [tokens.get(base.home), tokens.get(work.home)];
  const saved = fs.readFileSync(tokens.recordFile, 'utf8');
  fs.rmSync(tokens.recordFile);
  fs.mkdirSync(tokens.recordFile);

  await assert.rejects(hooks.setEnabled(hermes, false), (err) => {
    assert.match(err.message, /^The Default profile failed: Agent Guild could not revoke its report token \(\w+\)\. The work profile failed: Agent Guild could not revoke its report token \(\w+\)\. Reporting is on for no profile\. The report token of Default, work is still accepted; turn it off to try again\.$/);
    return true;
  });
  assert.deepEqual(given.map((token) => tokens.account(token)), [base.home, work.home], 'still accepted');
  assert.deepEqual(recorded(registry, hermes).map(([, p]) => p.status), ['disabled', 'disabled'], 'though Hermes turned the plugins off');
  assert.equal(hooks.enabled(hermes), true, 'so the card offers Turn off');
  assert.equal(hooks.note(hermes), 'Agent reporting is not fully off: the report token of Default, work is still accepted, because Agent Guild could not revoke it. Turn it off to try again.');

  fs.rmdirSync(tokens.recordFile);
  fs.writeFileSync(tokens.recordFile, saved);
  assert.equal(await hooks.setEnabled(hermes, false), false, 'trying again finishes, the settings already removed');
  assert.deepEqual(given.map((token) => tokens.account(token)), [null, null]);
  assert.equal(hooks.note(hermes), null);
});

test('two cards of one Hermes home show the same reporting and update state, whichever one changes it', { timeout: 30000 }, async (t) => {
  const { registry, hooks, home } = hermesSetup(t, { hermes: 'one', twin: 'one' });
  const [hermes, twin] = [registry.get('hermes'), registry.get('twin')];
  await hooks._readHermes(hermes);
  await hooks._readHermes(twin);
  let updated = 0;
  registry.on('updated', () => updated++);

  assert.equal(await hooks.setEnabled(hermes, true), true);
  assert.equal(hooks.enabled(twin), true, 'the other card shows reporting on');
  assert.ok(updated > 0, 'and is described again');

  fs.writeFileSync(path.join(home('hermes').dir, 'fake-plugins.json'), JSON.stringify([{ name: 'agent-guild', status: 'enabled', source: 'git pinned@00000000' }]));
  await hooks._readHermes(twin);
  assert.deepEqual([hooks.updatable(hermes), hooks.updatable(twin)], [true, true]);
  assert.equal(await hooks.update(twin), true);
  assert.deepEqual([hooks.updatable(hermes), hooks.updatable(twin)], [false, false]);

  assert.equal(await hooks.setEnabled(twin, false), false);
  assert.deepEqual([hooks.enabled(hermes), hooks.enabled(twin)], [false, false]);
});

test('turning off Hermes reporting revokes every token even when Hermes cannot list a profile\'s plugins, and names that failure', { timeout: 30000 }, async (t) => {
  const { registry, hooks, tokens, env, home } = hermesSetup(t, { hermes: 'home' });
  makeHermesHome(home('hermes').dir, [['work', 'config.yaml']]);
  registry.reload();
  const hermes = registry.get('hermes');
  assert.equal(await hooks.setEnabled(hermes, true), true);
  const [base, work] = registry.accountsFor(hermes);
  const given = [tokens.get(base.home), tokens.get(work.home)];

  Object.assign(env, { FAKE_HERMES_FAIL: 'plugins list', FAKE_HERMES_FAIL_PROFILE: 'work' });
  await assert.rejects(hooks.setEnabled(hermes, false), (err) => {
    assert.equal(err.message, 'The work profile failed: Hermes Agent could not list its plugins: it exited with code 1. Reporting is on for no profile.');
    return true;
  });
  assert.deepEqual(given.map((token) => tokens.account(token)), [null, null], 'both tokens are revoked');
  assert.deepEqual(recorded(registry, hermes).map(([, p]) => p.status), ['disabled', 'disabled'], 'and Hermes was still asked to turn the unlisted plugin off');
});

test('a Hermes report whose token is revoked while its body is still arriving is refused, and restores no activity', { timeout: 30000 }, async (t) => {
  const { registry } = hermesRegistry(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-hermes-inflight-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokens = new HermesTokens(path.join(dir, 'hermes-tokens'));
  const work = registry.account(registry.get('hermes'), 'work').home;
  const reportToken = await tokens.ensure(work);
  const live = new HermesLive({ sweepMs: 0 });
  registry.liveFor = (provider, account) => live.live(account.home);
  const manager = Object.assign(new EventEmitter(), { list: () => [], refreshMultiplexers() {}, sessions: new Map(), sessionHooks: {} });
  const api = createManagerServer({ manager, registry, token: 'f'.repeat(48), port: 0, webDir: path.join(here, '..', 'web'), hermes: { tokens, live } });
  await api.listen();
  t.after(() => api.close());

  // The token is checked as the request arrives: hold the body until then, revoke, then send the rest.
  let checked;
  const atCheck = new Promise((resolve) => { checked = resolve; });
  const account = tokens.account.bind(tokens);
  tokens.account = (token) => { const home = account(token); checked(); return home; };
  const body = JSON.stringify({ instance: 'gateway', messages: [{ seq: 1, event: 'pre_llm_call', data: { session_id: 's1', turn_id: 'u1', platform: 'telegram' } }] });
  const { port } = new URL(api.url);
  const answered = new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/v1/hermes/hook', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-agent-guild-report-token': reportToken } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.write(body.slice(0, 10));
    atCheck.then(() => tokens.remove(work)).then(() => req.end(body.slice(10)), reject);
  });
  assert.equal(await answered, 401, 'refused: its token was revoked before it was applied');
  assert.equal(live.live(work), null, 'and no activity came back');
});

test('a Hermes plugin read that finishes after a newer change is dropped, so it cannot show an enabled plugin as off', { timeout: 30000 }, async (t) => {
  const { registry, hooks } = hermesSetup(t, { hermes: 'home' });
  const hermes = registry.get('hermes');
  // A background read takes Hermes's answer before reporting is turned on, and is delivered only after.
  let release, taken;
  const gate = new Promise((resolve) => { release = resolve; });
  const tookIt = new Promise((resolve) => { taken = resolve; });
  const run = hooks._hermesRun.bind(hooks);
  let held = false;
  hooks._hermesRun = async (provider, account, args, what) => {
    const result = await run(provider, account, args, what);
    if (!held && args[0] === 'plugins' && args[1] === 'list') {
      held = true;
      taken();
      await gate;
    }
    return result;
  };
  const reading = hooks._readHermes(hermes);
  await tookIt;
  assert.equal(await hooks.setEnabled(hermes, true), true);
  release();
  await reading;
  assert.equal(hooks._hermesReporting(hermes)[0].on, true, 'the read from before is dropped');
  assert.equal(hooks.note(hermes), null, 'no false warning about a token still accepted');
});

test('turning off Hermes reporting revokes every token even when Hermes is no longer on PATH, since a gateway still running may hold one', { timeout: 30000 }, async (t) => {
  const { registry, hooks, tokens, home, root } = hermesSetup(t, { hermes: 'home' });
  makeHermesHome(home('hermes').dir, [['work', 'config.yaml']]);
  registry.reload();
  const hermes = registry.get('hermes');
  assert.equal(await hooks.setEnabled(hermes, true), true);
  const given = registry.accountsFor(hermes).map((account) => tokens.get(account.home));
  fs.rmSync(path.join(root, 'bin', win ? 'hermes.cmd' : 'hermes'));

  await assert.rejects(hooks.setEnabled(hermes, false), (err) => {
    assert.equal(err.message, 'The Default profile failed: Hermes Agent is not installed. The work profile failed: Hermes Agent is not installed. Reporting is on for no profile.');
    return true;
  });
  assert.deepEqual(given.map((token) => tokens.account(token)), [null, null], 'both tokens are revoked');
});

test('when a Hermes plugin update fails and Hermes then cannot be asked what it has, the error says that is unknown and claims no plugin survived', { timeout: 30000 }, async (t) => {
  const { registry, tokens, root } = hermesSetup(t, { hermes: 'home' });
  const hermes = registry.get('hermes');
  const before = new SessionHooks({ registry, dir: path.join(root, 'reporting'), version: '1', hermesTokens: tokens, hermesPluginCommit: PLUGIN_COMMIT, getApiUrl: () => 'http://127.0.0.1:47821' });
  assert.equal(await before.setEnabled(hermes, true), true);
  const hooks = new SessionHooks({ registry, dir: path.join(root, 'reporting'), version: '2', hermesTokens: tokens, hermesPluginCommit: NEXT_COMMIT, getApiUrl: () => 'http://127.0.0.1:47821' });
  t.after(() => hooks.close());
  await hooks._readHermes(hermes);
  assert.equal(hooks.updatable(hermes), true);

  // The install fails, and from then on Hermes cannot list its plugins either, as when its own cleanup leaves it stuck.
  const run = hooks._hermesRun.bind(hooks);
  let installed = false;
  hooks._hermesRun = async (provider, account, args, what) => {
    if (args[0] === 'plugins' && args[1] === 'install') {
      installed = true;
      throw Object.assign(new Error('Hermes Agent could not update the Agent Guild plugin: open() missing required argument \'flags\' (pos 2)'), { status: 502, code: 'reporting_setup_failed' });
    }
    if (installed && args[0] === 'plugins' && args[1] === 'list') {
      throw Object.assign(new Error('Hermes Agent could not list its plugins: cannot recover dependency publication'), { status: 502, code: 'reporting_setup_failed' });
    }
    return run(provider, account, args, what);
  };
  await assert.rejects(hooks.update(hermes), (err) => {
    assert.equal(err.message, "The Default profile was not updated: Hermes Agent could not update the Agent Guild plugin: open() missing required argument 'flags' (pos 2). Agent Guild could not check which plugin Hermes has now, so whether it still has the one it had is unknown: Hermes Agent could not list its plugins: cannot recover dependency publication.");
    assert.doesNotMatch(err.message, /still has the plugin it had|keeps reporting/);
    return true;
  });
});
