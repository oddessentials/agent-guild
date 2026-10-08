import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pty from 'node-pty';
import { Session } from '../src/manager/session.mjs';
import { dockerSessionDb, openSessionStore } from '../src/manager/docker-sessions.mjs';
import { dockerHookReport } from '../src/report/hooks.mjs';

const LAUNCH = 'a'.repeat(32);

// Docker Agent's session store as the tracker reads it, set up by each test: top-level rows, sub-agent rows with their
// parent, and each session's saved delegation calls by position.
function fakeStore() {
  const store = { rows: new Map(), calls: new Map(), positions: new Map(), fail: null, opened: 0 };
  store.open = async () => {
    store.opened++;
    if (store.fail) throw new Error(store.fail);
    return {
      parentOf: (id) => store.rows.get(id),
      lastPosition: (id) => store.positions.get(id) ?? -1,
      delegations: (id, after) => (store.calls.get(id) || []).filter((call) => call.position > after),
      relative: () => null,
      close() {},
    };
  };
  store.top = (id) => store.rows.set(id, '');
  store.call = (session, callId, agent, label = agent) => {
    const position = (store.positions.get(session) ?? -1) + 1;
    store.positions.set(session, position);
    store.calls.set(session, [...(store.calls.get(session) || []), { position, callId, agent, label }]);
  };
  return store;
}

// The real session state machine, without a PTY or wall-clock races.
function dockerCard(t, store, { toolSessionId = null } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(pty, 'spawn', () => ({ pid: 0, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }));
  const session = new Session({
    id: 'docker-test', provider: { id: 'docker', tool: 'Docker Agent' },
    spawnSpec: { file: 'mocked-pty', args: [] },
    cwd: process.cwd(), env: {}, cols: 80, rows: 24, reportToken: 'test',
    reporting: { state: 'pending', reason: null },
    docker: { launch: LAUNCH, store: 'session.db', open: store.open },
  });
  if (toolSessionId) session.reportToolSession({ toolSessionId }, 'launch');
  t.after(() => session.dispose());
  // A hook event as the report command sends it; Agent Guild's own flags carry the launch nonce.
  const hook = (input, launch = LAUNCH) => session.reportDocker(dockerHookReport({ cwd: '/w', ...input }, launch));
  const shellsOf = (scope) => [...session.shells.values()].filter((s) => s.scope === scope);
  return { session, hook, shellsOf };
}

const start = (session_id, agent_name = 'root') => ({ hook_event_name: 'session_start', session_id, agent_name, source: 'startup' });
const end = (session_id, agent_name = 'root') => ({ hook_event_name: 'session_end', session_id, agent_name, reason: 'stream_ended' });
const stop = (session_id, agent_name = 'root') => ({ hook_event_name: 'stop', session_id, agent_name });
const shell = (event, session_id, id, agent_name = 'root') => ({ hook_event_name: event, session_id, agent_name, tool_name: 'shell', tool_use_id: id, tool_input: { cmd: `run ${id}` } });

test('a Docker Agent hook event reaches the manager as it is, with the launch nonce of the hooks that sent it', () => {
  // Captured from docker-agent v1.149.0 (--yolo).
  const report = dockerHookReport({ session_id: 's1', cwd: '/w', hook_event_name: 'pre_tool_use', agent_name: 'helper', tool_name: 'shell', tool_use_id: 'NzNH', tool_input: { cmd: 'echo hi', cwd: '.' }, safety_policy: 'autonomous' }, LAUNCH);
  assert.deepEqual(report, { launch: LAUNCH, event: 'PreToolUse', sessionId: 's1', agentName: 'helper', toolName: 'shell', toolUseId: 'NzNH', match: report.match, model: null });
  assert.match(report.match, /^[a-f0-9]{32}$/);
  assert.deepEqual(dockerHookReport({ session_id: 's1', hook_event_name: 'before_llm_call', model_id: 'openai/gpt-5', iteration: 1 }), {
    launch: null, event: 'BeforeLlmCall', sessionId: 's1', agentName: null, toolName: null, toolUseId: null, match: null, model: 'openai/gpt-5',
  }, 'the hooks.d model drop-in carries no nonce');
  assert.equal(dockerHookReport({ hook_event_name: 'stop' }), null, 'an event names its session');
});

test('Resume targets the most recently started confirmed top-level session, and nothing else moves it', async (t) => {
  const store = fakeStore();
  store.top('main');
  store.top('tab2');
  store.top('elsewhere');
  const { session, hook } = dockerCard(t, store, { toolSessionId: 'main' });
  await hook(start('main'));
  assert.equal(session.reporting.state, 'active');
  await hook(start('tab2'));
  assert.equal(session.toolSessionId, 'tab2', 'a prompt in another tab, or after /new, /fork or /sessions, starts that session');
  // Late events of the earlier session, still running in its tab, are its activity, not a new start.
  await hook(shell('pre_tool_use', 'main', 'c1'));
  await hook(stop('main'));
  await hook(end('main'));
  assert.equal(session.toolSessionId, 'tab2', 'a late event of a session no longer started last does not take Resume back');
  // A top-level session of another process (a nested `docker agent`, or a hooks.d file) carries no nonce.
  await hook(start('elsewhere'), null);
  await hook(start('elsewhere'), 'b'.repeat(32));
  await hook(shell('pre_tool_use', 'elsewhere', 'x1'), null);
  assert.equal(session.toolSessionId, 'tab2', 'only this launch\'s own hooks can name a session');
  assert.equal([...session.shells.values()].some((s) => s.scope === 'elsewhere'), false, 'and only they can add a session\'s activity');
  // A sub-agent never does, and an interrupted turn changes nothing.
  store.call('tab2', 'call-1', 'helper');
  await hook(start('sub-1', 'helper'));
  await hook(end('tab2'));
  assert.equal(session.toolSessionId, 'tab2');
  await hook(start('main'));
  assert.equal(session.toolSessionId, 'main', 'a new prompt in the first tab starts it again');
});

test('the store being unreadable keeps Resume, shows no sub-agent, and says why on the card', async (t) => {
  const store = fakeStore();
  store.top('main');
  const { session, hook } = dockerCard(t, store, { toolSessionId: 'main' });
  await hook(start('main'));
  store.fail = 'database is locked';
  await hook(start('new-tab'));
  await hook(shell('pre_tool_use', 'new-tab', 'c1'));
  assert.equal(session.toolSessionId, 'main', 'without evidence Resume stays on the last confirmed session');
  assert.equal(session.agents.size, 0, 'and nothing is shown as a sub-agent');
  assert.match(session.reporting.reason, /cannot read Docker Agent's sessions \(database is locked\)/);
  assert.equal(session.reporting.state, 'active', 'commands and turns still report');
  // Readable again: the provisional session is checked at its next event.
  store.fail = null;
  store.top('new-tab');
  await hook(stop('new-tab'));
  assert.equal(session.reporting.reason, null, 'the note goes once the store reads again');
  await hook(start('new-tab'));
  assert.equal(session.toolSessionId, 'new-tab');
});

test('a sub-agent is confirmed by its parent\'s delegation call, one call each, concurrent ones included', async (t) => {
  const store = fakeStore();
  store.top('main');
  const { session, hook, shellsOf } = dockerCard(t, store, { toolSessionId: 'main' });
  await hook(start('main'));
  await hook(shell('pre_tool_use', 'main', 'main-cmd'));
  // Two background agents of the same agent and a transfer to another, as Docker Agent saves them before each starts.
  store.call('main', 'call-a', 'researcher');
  store.call('main', 'call-b', 'researcher');
  store.call('main', 'call-c', 'coder');
  await hook(start('sub-c', 'coder'));
  await hook(start('sub-a', 'researcher'));
  await hook(start('sub-b', 'researcher'));
  assert.deepEqual([...session.agents.values()].map((a) => [a.id, a.name, a.status]), [
    ['hook-sub-c', 'coder', 'working'], ['hook-sub-a', 'researcher', 'working'], ['hook-sub-b', 'researcher', 'working'],
  ]);
  // A fourth session with no call of its own left is not called a sub-agent.
  await hook(start('sub-d', 'researcher'));
  assert.equal(session.agents.has('hook-sub-d'), false);
  // A sub-agent's turn and end are its own: the main command keeps running.
  await hook(shell('pre_tool_use', 'sub-a', 'sub-cmd', 'researcher'));
  assert.equal(shellsOf('sub-a')[0].agentId, 'hook-sub-a');
  await hook(stop('sub-a', 'researcher'));
  await hook(end('sub-a', 'researcher'));
  assert.equal(session.agents.get('hook-sub-a').status, 'done');
  assert.deepEqual([shellsOf('main').length, shellsOf('sub-a').length], [1, 0], 'its end ended its command only');
  assert.equal(session.toolSessionId, 'main');
});

test('before v1.81.2 a sub-agent\'s events name no agent, and it takes the oldest unclaimed call and that call\'s name', async (t) => {
  const store = fakeStore();
  store.top('main');
  const { session, hook } = dockerCard(t, store, { toolSessionId: 'main' });
  await hook(start('main'));
  store.call('main', 'call-1', null, 'helpskill');
  await hook({ hook_event_name: 'session_start', session_id: 'sub-1', source: 'startup' });
  assert.equal(session.agents.get('hook-sub-1').name, 'helpskill');
  await hook({ hook_event_name: 'session_end', session_id: 'sub-1' });
  assert.equal(session.agents.get('hook-sub-1').status, 'done');
  assert.deepEqual([...session.shells.values()], []);
  assert.equal(session.toolSessionId, 'main', 'an end that names no agent no longer ends the main session\'s commands or Resume');
});

test('a resumed session\'s earlier delegation calls are not its new sub-agents\'', async (t) => {
  const store = fakeStore();
  store.top('main');
  store.call('main', 'old-call', 'helper');
  const { session, hook } = dockerCard(t, store, { toolSessionId: 'main' });
  await hook(start('main'));
  await hook(start('stray', 'helper'));
  assert.equal(session.agents.size, 0, 'only calls saved during the current run count');
  store.call('main', 'new-call', 'helper');
  await hook(start('sub', 'helper'));
  assert.equal(session.agents.get('hook-sub').name, 'helper');
});

test('a provisional session shows its commands on the main agent, is promoted on evidence, and is forgotten when it ends unclassified', async (t) => {
  const store = fakeStore();
  store.top('main');
  const { session, hook, shellsOf } = dockerCard(t, store, { toolSessionId: 'main' });
  await hook(start('main'));
  // No row and no call yet: provisional.
  await hook(start('late'));
  await hook(shell('pre_tool_use', 'late', 'c1'));
  t.mock.timers.tick(600);
  assert.deepEqual([session.agents.size, session.toJSON().shells.length, shellsOf('late')[0].agentId], [0, 1, null]);
  // Its delegation call is found at its next event: a sub-agent now, and the command it ran is its own.
  store.call('main', 'call-late', 'root');
  await hook(shell('pre_tool_use', 'late', 'c2'));
  assert.equal(session.agents.get('hook-late').status, 'working');
  assert.deepEqual(shellsOf('late').map((s) => s.agentId), ['hook-late', 'hook-late']);

  // Another stays provisional to its end: its commands end and it leaves nothing behind.
  await hook(start('ghost'));
  await hook(shell('pre_tool_use', 'ghost', 'g1'));
  await hook(end('ghost'));
  assert.deepEqual([shellsOf('ghost').length, session.agents.has('hook-ghost'), session.docker.sessions.has('ghost')], [0, false, false]);
  // A late event of the forgotten session finds it a completed sub-agent's, and changes nothing.
  store.rows.set('ghost', 'main');
  await hook(shell('pre_tool_use', 'ghost', 'g2'));
  assert.deepEqual([shellsOf('ghost').length, session.agents.has('hook-ghost'), session.toolSessionId], [0, false, 'main']);

  // One whose row turns out top-level is main-level from then on, and its own start moves Resume.
  await hook(start('slow'));
  store.top('slow');
  await hook(shell('pre_tool_use', 'slow', 's1'));
  assert.equal(session.toolSessionId, 'main', 'evidence of a top-level session, but not of a new start');
  await hook(start('slow'));
  assert.equal(session.toolSessionId, 'slow');
});

test('a turn ends only its own session\'s commands, so other tabs\' keep running', async (t) => {
  const store = fakeStore();
  store.top('tab1');
  store.top('tab2');
  const { hook, shellsOf } = dockerCard(t, store, { toolSessionId: 'tab1' });
  await hook(start('tab1'));
  await hook(shell('pre_tool_use', 'tab1', 'build'));
  await hook(start('tab2'));
  await hook(shell('pre_tool_use', 'tab2', 'test'));
  await hook(stop('tab2'));
  await hook(end('tab2'));
  assert.deepEqual([shellsOf('tab1').length, shellsOf('tab2').length], [1, 0]);
  await hook(shell('post_tool_use', 'tab1', 'build'));
  assert.equal(shellsOf('tab1').length, 0);
});

test('the model comes from the session Resume targets, never a sub-agent\'s or another process\'s', async (t) => {
  const store = fakeStore();
  store.top('main');
  const { session, hook } = dockerCard(t, store, { toolSessionId: 'main' });
  await hook(start('main'));
  const llm = (session_id, model) => ({ hook_event_name: 'before_llm_call', session_id, model_id: model });
  await hook(llm('main', 'openai/gpt-5'), null);
  assert.equal(session.model?.name, 'openai/gpt-5', 'the hooks.d drop-in carries no nonce, and adds to a known session');
  store.call('main', 'call-1', 'helper');
  await hook(start('sub', 'helper'));
  await hook(llm('sub', 'dmr/ai/qwen3'), null);
  await hook(llm('nested', 'anthropic/claude'), null);
  assert.equal(session.model.name, 'openai/gpt-5');
  // Another tab's session is main-level, but its model is the card's only once it is the most recently started.
  store.top('tab2');
  await hook(start('tab2'));
  await hook(llm('main', 'openai/gpt-5-mini'), null);
  assert.equal(session.model.name, 'openai/gpt-5');
  await hook(llm('tab2', 'anthropic/claude-sonnet'), null);
  assert.equal(session.model.name, 'anthropic/claude-sonnet');
});

test('Docker Agent\'s session store is read where `docker agent run` keeps it, with its own queries', async (t) => {
  assert.equal(dockerSessionDb(['agent', 'run', '--session-db', '/x/s.db']), '/x/s.db');
  assert.equal(dockerSessionDb(['agent', 'run', '--session-db=/y.db']), '/y.db');
  assert.equal(dockerSessionDb(['agent', 'run', '-s', 'z.db']), 'z.db');
  assert.equal(dockerSessionDb(['agent', 'run'], { DOCKER_AGENT_DATA_DIR: '/data' }), path.join('/data', 'session.db'));
  // --data-dir wins over the variable, which Docker Agent reads from v1.147.0 only.
  assert.equal(dockerSessionDb(['agent', 'run', '--data-dir', '/flag'], { DOCKER_AGENT_DATA_DIR: '/data' }), path.join('/flag', 'session.db'));
  assert.equal(dockerSessionDb(['agent', 'run', '--data-dir=/flag']), path.join('/flag', 'session.db'));
  assert.equal(dockerSessionDb(['agent', 'run'], { DOCKER_AGENT_DATA_DIR: '/data' }, '1.146.0'), path.join(os.homedir(), '.cagent', 'session.db'));
  assert.equal(dockerSessionDb(['agent', 'run', '--data-dir', '/flag'], {}, '1.101.0'), path.join('/flag', 'session.db'));
  // Before v1.101.0 the store stays in ~/.cagent whatever --data-dir says; only --session-db moves it.
  assert.equal(dockerSessionDb(['agent', 'run', '--data-dir', '/flag'], { DOCKER_AGENT_DATA_DIR: '/data' }, '1.55.0'), path.join(os.homedir(), '.cagent', 'session.db'));
  assert.equal(dockerSessionDb(['agent', 'run', '-s', '/own.db'], {}, '1.55.0'), '/own.db');
  // The tables as docker-agent v1.149.0 writes them (the columns Agent Guild reads), with its message JSON.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.db');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec(`create table sessions (id text primary key, created_at text, parent_id text references sessions(id));
    create table session_items (id integer primary key autoincrement, session_id text not null, position integer not null, item_type text not null, agent_name text, message_json text)`);
  const row = db.prepare('insert into sessions (id, created_at, parent_id) values (?, ?, ?)');
  row.run('old', '2026-10-08T14:00:00-04:00', null);
  row.run('main', '2026-10-08T15:23:28-04:00', null);
  row.run('done-sub', '2026-10-08T15:23:29-04:00', 'main');
  const item = db.prepare('insert into session_items (session_id, position, item_type, agent_name, message_json) values (?, ?, ?, ?, ?)');
  const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  item.run('main', 0, 'message', '', JSON.stringify({ role: 'user', content: 'hi' }));
  item.run('main', 1, 'message', 'root', JSON.stringify({ message_id: 'm1', role: 'assistant', content: '', tool_calls: [call('c-skill', 'run_skill', { name: 'helpskill', task: 't' }), call('c-shell', 'shell', { cmd: 'ls' })] }));
  item.run('main', 2, 'subsession', null, null);
  item.run('main', 3, 'message', 'root', JSON.stringify({ role: 'assistant', content: '', tool_calls: [call('c-bg', 'run_background_agent', { agent: 'helper', task: 't' }), call('c-tt', 'transfer_task', { agent: 'coder', task: 't', expected_output: '' })] }));
  db.close();
  const store = await openSessionStore(file);
  assert.deepEqual([store.parentOf('main'), store.parentOf('done-sub'), store.parentOf('running-sub')], ['', 'main', undefined]);
  assert.deepEqual([store.lastPosition('main'), store.lastPosition('nothing')], [3, -1]);
  assert.deepEqual(store.delegations('main', -1), [
    { callId: 'c-skill', agent: 'root', label: 'helpskill' },
    { callId: 'c-bg', agent: 'helper', label: 'helper' },
    { callId: 'c-tt', agent: 'coder', label: 'coder' },
  ], 'a skill runs as its caller, and is named by its skill');
  assert.deepEqual(store.delegations('main', 1).map((c) => c.callId), ['c-bg', 'c-tt']);
  assert.deepEqual([store.relative(1), store.relative(2), store.relative(3)], ['main', 'old', null], '-1 is the newest top-level session');
  store.close();
});
