import { test } from 'node:test';
import assert from 'node:assert/strict';
import pty from 'node-pty';
import { Session } from '../src/manager/session.mjs';
import { DockerSessions } from '../src/manager/docker-sessions.mjs';
import { dockerHookEvent, commandHash } from '../src/report/hooks.mjs';

// The real session state machine, with no terminal and with time under control.
function createSession(t) {
  try { t.mock.timers.enable({ apis: ['setTimeout'] }); } catch { /* a second session in the same test */ }
  t.mock.method(pty, 'spawn', () => ({ pid: 0, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }));
  const session = new Session({
    id: 'docker-test', provider: { id: 'docker', tool: 'Docker Agent' },
    spawnSpec: { file: 'mocked-pty', args: [] },
    cwd: process.cwd(), env: {}, cols: 80, rows: 24, reportToken: 'test', reporting: { state: 'pending', reason: 'waiting' },
  });
  t.after(() => session.dispose());
  return session;
}

const MAIN = '11111111-2222-4333-8444-555555555555';
const event = (sessionId, agentName, name, extra = {}) => ({ event: name, sessionId, agentName, ...extra });
const shell = (sessionId, agentName, name, id, cmd) => event(sessionId, agentName, name, { toolName: 'shell', toolUseId: id, command: cmd });
const agents = (session) => session.toJSON().agents.map((a) => [a.id, a.name, a.status]);
const shells = (session, t) => { t.mock.timers.tick(600); return session.toJSON().shells.length; };

test('the hook keeps only what the manager needs of a Docker Agent event', () => {
  const full = {
    session_id: MAIN, cwd: '/w', hook_event_name: 'post_tool_use', agent_name: 'root', tool_name: 'shell', tool_use_id: 'call_1',
    tool_input: { cmd: 'go test ./...', cwd: '.' }, tool_response: 'ok\n'.repeat(1000), safety_policy: 'autonomous', model_id: 'openai/gpt-5',
  };
  assert.deepEqual(dockerHookEvent(full), { event: 'PostToolUse', sessionId: MAIN, agentName: 'root', toolName: 'shell', toolUseId: 'call_1', command: 'go test ./...', model: 'openai/gpt-5' });
  assert.deepEqual(dockerHookEvent({ session_id: 'a', hook_event_name: 'session_start', source: 'startup' }), { event: 'SessionStart', sessionId: 'a' }, 'before 1.81.2 there is no agent name');
  assert.equal(dockerHookEvent({ hook_event_name: 'stop' }), null, 'an event with no session is dropped');
  assert.equal(dockerHookEvent({ session_id: 'a' }), null);
  assert.equal(dockerHookEvent('nope'), null);
});

test('the named main session reports its commands, turns and model; its hooks are heard', (t) => {
  const session = createSession(t);
  const docker = new DockerSessions(session, { mainId: MAIN });
  session.reportToolSession({ toolSessionId: MAIN }, 'launch');
  docker.report(event(MAIN, 'root', 'SessionStart'));
  assert.equal(session.reporting.state, 'active');
  docker.report(shell(MAIN, 'root', 'PreToolUse', 'call_1', 'go test ./...'));
  assert.equal(shells(session, t), 1);
  docker.report(shell(MAIN, 'root', 'PostToolUse', 'call_1', 'go test ./...'));
  assert.equal(shells(session, t), 0);
  docker.report(shell(MAIN, 'root', 'PreToolUse', 'call_2', 'sleep 9'));
  docker.report(event(MAIN, 'root', 'Stop'));
  assert.equal(shells(session, t), 0, 'the turn\'s end ends its foreground command');
  docker.report(event(MAIN, 'root', 'BeforeLlmCall', { model: 'openai/gpt-5' }));
  assert.deepEqual(session.model, { name: 'openai/gpt-5', displayName: null, source: 'report' });
  docker.report(event(MAIN, 'root', 'PreToolUse', { toolName: 'edit_file', toolUseId: 'call_3' }));
  assert.equal(shells(session, t), 0, 'only the shell tool is a command');
  assert.deepEqual(agents(session), []);
  assert.equal(session.toolSessionId, MAIN);
});

test('a sub-agent is a session run by another agent: a card from its first event to its end, with its own commands', (t) => {
  const session = createSession(t);
  const docker = new DockerSessions(session, { mainId: MAIN });
  session.reportToolSession({ toolSessionId: MAIN }, 'launch');
  docker.report(event(MAIN, 'root', 'SessionStart'));
  docker.report(shell(MAIN, 'root', 'PreToolUse', 'call_1', 'go build'));
  const helper = '89ac0beb-aaaa-4d27-b562-36f308181f6e';
  docker.report(event(helper, 'helper', 'SessionStart'));
  assert.deepEqual(agents(session), [[`hook-${helper}`, 'helper', 'working']]);
  docker.report(shell(helper, 'helper', 'PreToolUse', 'call_1', 'echo helper-ran'));
  assert.equal(shells(session, t), 2, 'the helper\'s call id repeats the main session\'s, and both commands show');
  docker.report(event(helper, 'helper', 'BeforeLlmCall', { model: 'dmr/ai/qwen2.5:3B-Q4_K_M' }));
  assert.equal(session.model, null, 'a sub-agent\'s model is its own');
  docker.report(event(helper, 'helper', 'Stop'));
  assert.equal(shells(session, t), 2, 'a sub-agent\'s turn end is not the main session\'s');
  docker.report(event(helper, 'helper', 'SessionEnd'));
  assert.deepEqual(agents(session), [[`hook-${helper}`, 'helper', 'done']]);
  assert.equal(shells(session, t), 1, 'its session\'s end ends its command and leaves the main one running');
  docker.report(event(helper, 'helper', 'SubagentStop', { parentSessionId: MAIN }));
  assert.deepEqual(agents(session), [[`hook-${helper}`, 'helper', 'done']], 'the parent\'s subagent_stop repeats the end');
  assert.equal(session.toolSessionId, MAIN, 'Resume stays on the main session');
  // A session first heard of at its end has nothing to show.
  docker.report(event('late-1', 'other', 'SessionEnd'));
  docker.report(event('late-2', 'other', 'SubagentStop'));
  assert.deepEqual(agents(session), [[`hook-${helper}`, 'helper', 'done']]);
});

test('a tab runs the main agent: no card, Resume stays, and its commands end with its own turn', (t) => {
  const session = createSession(t);
  const docker = new DockerSessions(session, { mainId: MAIN });
  session.reportToolSession({ toolSessionId: MAIN }, 'launch');
  docker.report(event(MAIN, 'root', 'SessionStart'));
  docker.report(shell(MAIN, 'root', 'PreToolUse', 'c1', 'npm test'));
  const tab = 'tab-1';
  docker.report(event(tab, 'root', 'SessionStart'));
  docker.report(shell(tab, 'root', 'PreToolUse', 'c1', 'npm run lint'));
  assert.deepEqual(agents(session), [], 'a session run by the main agent is not a sub-agent');
  assert.equal(shells(session, t), 2, 'its command shows as the terminal\'s activity');
  docker.report(event(tab, 'root', 'Stop'));
  assert.equal(shells(session, t), 1, 'the tab\'s turn ends only the tab\'s command');
  docker.report(event(tab, 'root', 'SessionEnd'));
  assert.equal(session.toolSessionId, MAIN);
  docker.report(event(MAIN, 'root', 'Stop'));
  assert.equal(shells(session, t), 0);
  // A tab opened before the first prompt is heard from first: it runs the main agent, so it is not a sub-agent, and
  // it is the session the user works in, so Resume follows it rather than the named session, which stays empty.
  const early = createSession(t);
  const earlyDocker = new DockerSessions(early, { mainId: MAIN });
  early.reportToolSession({ toolSessionId: MAIN }, 'launch');
  earlyDocker.report(event('tab-0', 'root', 'SessionStart'));
  assert.equal(early.toolSessionId, 'tab-0');
  earlyDocker.report(event(MAIN, 'root', 'SessionStart'));
  earlyDocker.report(event('helper', 'helper', 'SessionStart'));
  assert.deepEqual(agents(early), [['hook-helper', 'helper', 'working']]);
  assert.equal(early.toolSessionId, 'tab-0', 'and never moves again');
});

test('a tab starts with the launch agent whatever another tab switched to, and keeps its role across its turns', (t) => {
  const session = createSession(t);
  const docker = new DockerSessions(session, { mainId: MAIN });
  docker.report(event(MAIN, 'root', 'SessionStart'));
  // The user switches the main tab to coder, then opens a tab: Docker Agent starts the tab's runtime with root.
  docker.report(event(MAIN, 'coder', 'SessionStart'));
  docker.report(event('tab-1', 'root', 'SessionStart'));
  docker.report(event('tab-1', 'root', 'SessionEnd'));
  assert.deepEqual(agents(session), [], 'the tab is not a sub-agent');
  // The user switches the tab to coder: its role was decided at its first event and stays.
  docker.report(event('tab-1', 'coder', 'SessionStart'));
  docker.report(shell('tab-1', 'coder', 'PreToolUse', 'x', 'ls'));
  assert.deepEqual(agents(session), []);
  assert.equal(shells(session, t), 1, 'its commands show as the terminal\'s activity');
  docker.report(event('tab-1', 'coder', 'Stop'));
  assert.equal(shells(session, t), 0);
  // A session first heard of under another name is a sub-agent, whichever agent the main tab runs now.
  docker.report(event('sub-1', 'reviewer', 'SessionStart'));
  assert.deepEqual(agents(session), [['hook-sub-1', 'reviewer', 'working']]);
  docker.report(event('sub-1', 'reviewer', 'SessionEnd'));
  assert.ok(!docker.sessions.has('sub-1') && docker.sessions.has('tab-1'), 'a finished sub-agent is forgotten; a tab is kept with its role');
});

test('a session first heard from under another name while nothing runs is a tab, not a sub-agent', (t) => {
  const session = createSession(t);
  const docker = new DockerSessions(session, { mainId: MAIN });
  // The user switched the first tab to coder before its first prompt, so coder is the launch agent as far as the
  // card knows. Its turn ends; then a tab Docker Agent started with root is prompted: no sub-agent runs outside a turn.
  docker.report(event(MAIN, 'coder', 'SessionStart'));
  docker.report(event(MAIN, 'coder', 'Stop'));
  docker.report(event('tab-1', 'root', 'SessionStart'));
  docker.report(shell('tab-1', 'root', 'PreToolUse', 'c1', 'ls'));
  assert.deepEqual(agents(session), [], 'a tab prompted while no turn runs is not a sub-agent, whatever its agent');
  assert.equal(shells(session, t), 1, 'its command shows as the terminal\'s activity');
  docker.report(event('tab-1', 'root', 'Stop'));
  assert.equal(shells(session, t), 0);
  // A sub-agent begins inside its parent's turn, under another name: still a card.
  docker.report(event(MAIN, 'coder', 'SessionStart'));
  docker.report(event('sub-1', 'reviewer', 'SessionStart'));
  assert.deepEqual(agents(session), [['hook-sub-1', 'reviewer', 'working']]);
  docker.report(event('sub-1', 'reviewer', 'SessionEnd'));
  docker.report(event(MAIN, 'coder', 'SessionEnd'));
  assert.equal(docker.open.size, 0, 'every run heard to end is closed');
});

test('without a named session the first session heard from is the main one, and Resume never moves', (t) => {
  const session = createSession(t);
  const docker = new DockerSessions(session);
  assert.equal(session.toolSessionId, null);
  docker.report(event('resumed-1', 'root', 'SessionStart'));
  assert.equal(session.toolSessionId, 'resumed-1');
  docker.report(event('helper-1', 'helper', 'SessionStart'));
  docker.report(event('helper-1', 'helper', 'SessionEnd'));
  docker.report(event('tab-1', 'root', 'SessionStart'));
  docker.report(event('resumed-1', 'root', 'SessionStart'));
  assert.equal(session.toolSessionId, 'resumed-1');
  assert.deepEqual(agents(session), [['hook-helper-1', 'helper', 'done']]);
  // Before 1.81.2 no event names its agent: other sessions are main-level, never sub-agents.
  const old = createSession(t);
  const oldDocker = new DockerSessions(old);
  oldDocker.report({ event: 'SessionStart', sessionId: 'first' });
  oldDocker.report({ event: 'SessionStart', sessionId: 'second' });
  oldDocker.report({ event: 'PreToolUse', sessionId: 'second', toolName: 'shell', toolUseId: 'c', command: 'make' });
  assert.deepEqual(agents(old), []);
  assert.equal(shells(old, t), 1);
  assert.equal(old.toolSessionId, 'first');
});

test('a permission request hides the matching command until it runs', (t) => {
  const session = createSession(t);
  const docker = new DockerSessions(session, { mainId: MAIN });
  docker.report(event(MAIN, 'root', 'SessionStart'));
  docker.report(shell(MAIN, 'root', 'PreToolUse', 'c1', 'rm -rf build'));
  docker.report({ event: 'PermissionRequest', sessionId: MAIN, agentName: 'root', toolName: 'shell', command: 'rm -rf build' });
  assert.equal(shells(session, t), 0, 'waiting for approval');
  assert.equal(commandHash('rm -rf build'), commandHash('rm  -rf   build'), 'spacing does not matter to the match');
  docker.report(shell(MAIN, 'root', 'PostToolUse', 'c1', 'rm -rf build'));
  assert.equal(shells(session, t), 0);
});

test('events are checked, refused after the exit, and forgotten sessions are bounded', (t) => {
  const session = createSession(t);
  const docker = new DockerSessions(session, { mainId: MAIN });
  for (const bad of [null, 'x', {}, { event: 'Stop' }, { event: 'Stop', sessionId: 'a\u0000b' }, { sessionId: 'a' }, { event: '', sessionId: 'a' }]) {
    assert.throws(() => docker.report(bad), { status: 400 }, JSON.stringify(bad));
  }
  docker.report({ event: 'session_start', sessionId: MAIN, agentName: 'root' });
  assert.equal(session.reporting.state, 'active', 'snake_case event names are accepted too');
  for (let i = 0; i < 600; i++) docker.report(event(`s-${i}`, 'root', 'SessionStart'));
  assert.ok(docker.sessions.size <= 512, `${docker.sessions.size} sessions remembered`);
  assert.ok(!docker.sessions.has('s-0') && docker.sessions.has('s-599'), 'the oldest are forgotten first');
  // The card holds 64 agents: a 65th sub-agent gets no card, and its events are still taken.
  for (let i = 0; i < 70; i++) docker.report(event(`sub-${i}`, `agent-${i}`, 'SessionStart'));
  assert.equal(session.toJSON().agents.length, 64);
  docker.report(shell('sub-69', 'agent-69', 'PreToolUse', 'c', 'make'));
  assert.equal(shells(session, t), 1);
  docker.report(event('sub-69', 'agent-69', 'SessionEnd'));
  assert.equal(shells(session, t), 0, 'its end ends its command');
  // A long session id still gives each call its own key.
  const long = 'x'.repeat(150);
  docker.report(shell(long, 'other', 'PreToolUse', 'a', 'one'));
  docker.report(shell(long, 'other', 'PreToolUse', 'b', 'two'));
  assert.equal(shells(session, t), 2);
  session.status = 'exited';
  assert.throws(() => docker.report(event(MAIN, 'root', 'Stop')), { status: 409 });
});
