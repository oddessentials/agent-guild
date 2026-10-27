import { test } from 'node:test';
import assert from 'node:assert/strict';
import pty from 'node-pty';
import { Session } from '../src/manager/session.mjs';

const NOW = Date.UTC(2026, 9, 26, 12);
const iso = (ms) => new Date(ms).toISOString();
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

// The real session state, with a mocked terminal and clock: report times are the hook processes' start times.
function createSession(t, { reporting = 'claude', state = 'pending' } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  let exit = null;
  t.mock.method(pty, 'spawn', () => ({
    pid: 0, onData() {}, onExit(cb) { exit = cb; }, write() {}, resize() {}, kill() {},
  }));
  const session = new Session({
    id: 'permission-test', provider: { id: 'tool', tool: 'Tool', reporting },
    spawnSpec: { file: 'mocked-pty', args: [] },
    cwd: process.cwd(), env: {}, cols: 80, rows: 24, reportToken: 'test',
    reporting: state ? { state, reason: null } : null,
  });
  t.after(() => session.dispose());
  return { session, exit: () => exit({ exitCode: 0 }) };
}

const permission = (session) => session.toJSON().permission;
const request = (session, at, match = A, agentId) => session.reportPermission({ permission: 'request', match, at, ...(agentId ? { agentId } : {}) });
const done = (session, at, match = A, agentId) => session.reportPermission({ permission: 'done', match, at, ...(agentId ? { agentId } : {}) });

test('a tool that cannot say, or whose hooks have not spoken, shows null rather than nothing waiting', (t) => {
  for (const reporting of ['grok', 'antigravity', 'docker', null]) {
    const { session } = createSession(t, { reporting });
    session.reportHello();
    assert.deepEqual([permission(session), session.toJSON().turn], [null, null], String(reporting));
    t.mock.timers.reset();
  }
  const { session: claude } = createSession(t);
  assert.equal(permission(claude), null, 'hooks not heard yet');
  t.mock.timers.reset();
  const { session: unhooked } = createSession(t, { state: null });
  assert.equal(permission(unhooked), null, 'Agent Guild supplied no hooks');
  t.mock.timers.reset();
  const { session: own } = createSession(t, { state: 'unsupported' });
  own.reportHello();
  assert.deepEqual([own.reporting.state, permission(own)], ['active', null], 'hooks the user added may cover only some tools');
  t.mock.timers.reset();
  const { session: codex } = createSession(t, { reporting: 'codex' });
  codex.reportHello();
  codex.reportTurn({ turn: 'working', at: NOW - 10 });
  assert.equal(permission(codex), null, 'Codex CLI asks its Guardian reviewer through the same event');
  assert.deepEqual(codex.toJSON().turn, { state: 'working', at: iso(NOW - 10) }, 'but reports its turns');
});

test('a request waits from when it was made until the call it asked about ends', (t) => {
  const { session } = createSession(t);
  session.reportHello();
  assert.deepEqual(permission(session), { state: 'none', since: iso(NOW) }, 'none since the hooks first spoke');
  request(session, NOW - 50);
  assert.deepEqual(permission(session), { state: 'waiting', since: iso(NOW - 50) });
  done(session, NOW - 40, B);
  assert.equal(permission(session).state, 'waiting', 'another call ending answers nothing');
  done(session, NOW - 30);
  assert.deepEqual(permission(session), { state: 'none', since: iso(NOW - 30) });
  request(session, NOW + 60_000);
  assert.equal(permission(session).since, iso(NOW), 'a time from the future is taken as now');
});

test('a delayed request does not reopen a wait its call already ended, in either order of arrival', (t) => {
  const { session } = createSession(t);
  session.reportHello();
  request(session, NOW - 50);
  done(session, NOW - 30);
  assert.equal(permission(session).state, 'none', 'request, then done');

  done(session, NOW - 10, B);
  request(session, NOW - 20, B);
  assert.equal(permission(session).state, 'none', 'done, then the request it answered');
  request(session, NOW - 5, B);
  assert.equal(permission(session).state, 'waiting', 'a later request for the same call is a new one');
});

test('the next identical call\'s request outlives the previous call\'s late end', (t) => {
  const { session } = createSession(t);
  session.reportHello();
  request(session, NOW - 300);
  // Claude Code asks for the second call 6 ms after the first one ends; their hooks may arrive in either order.
  request(session, NOW - 100);
  done(session, NOW - 106);
  assert.deepEqual(permission(session), { state: 'waiting', since: iso(NOW - 100) });
  done(session, NOW - 20);
  assert.equal(permission(session).state, 'none');
});

test('the main agent\'s turn boundaries end its own requests, not a sub-agent\'s', (t) => {
  const { session } = createSession(t);
  session.reportHello();
  request(session, NOW - 90);
  request(session, NOW - 80, B, 'hook-a1');
  session.reportTurn({ turn: 'ended', at: NOW - 70 });
  assert.deepEqual(permission(session), { state: 'waiting', since: iso(NOW - 80) }, 'a background sub-agent still asks after the main turn ends');
  request(session, NOW - 95);
  assert.equal(permission(session).since, iso(NOW - 80), 'a main request from before the boundary stays answered');
  session.reportAgent({ agentId: 'hook-a1', status: 'done' });
  assert.deepEqual(permission(session), { state: 'none', since: iso(NOW) });
  request(session, NOW - 60, B, 'hook-a1');
  assert.equal(permission(session).state, 'none', 'a sub-agent request delayed past the sub-agent\'s end');

  // A denial or Esc reports nothing: the user's next prompt ends the wait.
  request(session, NOW - 40);
  session.reportTurn({ turn: 'working', at: NOW - 20 });
  assert.equal(permission(session).state, 'none');
  request(session, NOW - 10, B, 'hook-a2');
  done(session, NOW - 5, B);
  assert.equal(permission(session).state, 'waiting', 'the main agent\'s call is not the sub-agent\'s');
  done(session, NOW - 4, B, 'hook-a2');
  assert.equal(permission(session).state, 'none');
});

test('a sub-agent\'s end answers its requests from before it, not those of its resumed run, in either order of arrival', (t) => {
  const { session } = createSession(t);
  session.reportHello();
  session.reportAgent({ agentId: 'hook-a1', status: 'working' });
  request(session, NOW - 90, A, 'hook-a1');
  // The resumed run asks before the end's own hook reaches the manager.
  request(session, NOW - 50, B, 'hook-a1');
  session.reportAgent({ agentId: 'hook-a1', status: 'done', at: NOW - 70 });
  assert.deepEqual(permission(session), { state: 'waiting', since: iso(NOW - 50) }, 'end, after the newer request');
  request(session, NOW - 80, A, 'hook-a1');
  assert.equal(permission(session).since, iso(NOW - 50), 'a request from before the end stays answered');
  done(session, NOW - 40, B, 'hook-a1');

  session.reportAgent({ agentId: 'hook-a2', status: 'working' });
  session.reportAgent({ agentId: 'hook-a2', status: 'done', at: NOW - 30 });
  request(session, NOW - 35, A, 'hook-a2');
  assert.equal(permission(session).state, 'none', 'a request from before the end, delayed past it');
  request(session, NOW - 20, A, 'hook-a2');
  assert.deepEqual(permission(session), { state: 'waiting', since: iso(NOW - 20) }, 'end, before the newer request');
});

test('an agent end that was never shown changes nothing else', (t) => {
  const { session } = createSession(t);
  session.reportHello();
  // A widened PostToolUse of a foreground Agent call ends a hook-task agent that never started.
  assert.equal(session.reportAgent({ agentId: 'hook-task-toolu_1', status: 'done' }), null);
  assert.deepEqual([session.toJSON().agents, permission(session).state], [[], 'none']);
});

test('the turn and the reply carry their times; a turn can end without a reply, and an old report changes nothing', (t) => {
  const { session } = createSession(t);
  session.reportHello();
  assert.equal(session.toJSON().turn, null, 'no turn seen yet');
  session.reportTurn({ turn: 'working', at: NOW - 100 });
  assert.deepEqual(session.reportReply({ reply: 'Done.', at: NOW - 60 }), { id: 1, at: iso(NOW - 60) });
  session.reportTurn({ turn: 'ended', at: NOW - 60 });
  assert.deepEqual([session.toJSON().turn, session.toJSON().reply], [{ state: 'ended', at: iso(NOW - 60) }, { id: 1, at: iso(NOW - 60) }]);
  session.reportTurn({ turn: 'working', at: NOW - 80 });
  assert.deepEqual(session.toJSON().turn, { state: 'ended', at: iso(NOW - 60) }, 'a prompt from before the end');

  session.reportTurn({ turn: 'working', at: NOW - 30 });
  session.reportReply({ reply: null, at: NOW - 10 });
  session.reportTurn({ turn: 'ended', at: NOW - 10 });
  assert.deepEqual([session.toJSON().turn, session.toJSON().reply], [{ state: 'ended', at: iso(NOW - 10) }, null]);
  assert.equal(session.reportReply({ reply: 'No time.' }).at, iso(NOW), 'a reply without a time is dated when heard');
});

test('an exited session neither waits nor works', (t) => {
  const { session, exit } = createSession(t);
  session.reportHello();
  request(session, NOW - 10);
  session.reportTurn({ turn: 'working', at: NOW - 20 });
  exit();
  assert.deepEqual([permission(session), session.toJSON().turn], [null, null]);
  assert.throws(() => request(session, NOW - 5), { status: 409 });
});

test('permission reports leave shell commands and the label as they were', (t) => {
  const { session } = createSession(t);
  session.reportHello();
  session.reportShell({ shell: 'start', key: 'toolu_1', match: A });
  t.mock.timers.tick(1000);
  assert.equal(session.toJSON().shells.length, 1);
  session.reportShell({ shell: 'waiting', match: A });
  request(session, NOW);
  assert.deepEqual([session.toJSON().shells, session.toJSON().label], [[], 'Running'], 'a command waiting for permission is not drawn running');
  done(session, NOW + 1000);
  assert.equal(session.toJSON().shells.length, 0, 'the shell report ends the command, not the permission report');
  assert.throws(() => session.reportPermission({ permission: 'waiting', match: A }), { status: 400 });
  assert.throws(() => session.reportTurn({ turn: 'idle' }), { status: 400 });
});
