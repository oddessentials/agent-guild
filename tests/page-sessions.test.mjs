import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const source = ['upsertSession', 'statusText', 'stopNote', 'stopSession', 'removeSession', 'reattachable', 'reattachSession', 'resumeCard', 'osc52Text', 'exitLine'].map((name) => {
  const found = app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(found, `${name} is present in app.js`);
  return found;
}).join('\n');

const started = '2026-10-03T10:00:00.000Z';
const plain = { id: 'p1', name: 'Shell · bash', provider: { tool: 'Shell' }, status: 'running', exitCode: null, signal: null, startedAt: started, exitedAt: null, multiplexer: null };
const tmux = { ...plain, id: 'm1', name: 'Shell · tmux', multiplexer: { label: 'tmux', attach: 'tmux attach -t guild-abc123', reattachable: false } };
const exited = (s, extra = {}) => ({ ...s, status: 'exited', exitCode: 1, exitedAt: '2026-10-03T10:05:00.000Z', ...extra });

// The browser's own session logic, with only the DOM and the network stubbed.
function page({ onApi = () => ({}) } = {}) {
  const confirms = [];
  const requests = [];
  const opened = [];
  const context = {
    state: { sessions: new Map() },
    renderSessions() {}, noticeClone() {}, dropSession() {},
    openPanel: (id) => opened.push(id),
    toast(message) { assert.fail(message); },
    confirm: (message) => { confirms.push(message); return true; },
    api: async (method, route) => { requests.push(`${method} ${route}`); return onApi(method, route, context); },
    AuthError: class extends Error {},
    TextDecoder, atob,
  };
  runInNewContext(source, context);
  return { context, confirms, requests, opened, sessions: context.state.sessions };
}

test('a reply sent before a session exited cannot show it running again; a reattached run can', async () => {
  // Stop's reply was taken before the process ended; the exit event overtakes it.
  const { context, sessions } = page({
    onApi: (method, route, ctx) => {
      ctx.upsertSession(exited(plain));
      return { session: { ...plain } };
    },
  });
  context.upsertSession({ ...plain });
  await context.stopSession(plain.id);
  assert.equal(sessions.get(plain.id).status, 'exited');

  context.upsertSession(exited(plain, { name: 'Renamed' }));
  assert.equal(sessions.get(plain.id).name, 'Renamed', 'updates to an exited session still apply');
  context.upsertSession({ ...plain, startedAt: '2026-10-03T10:06:00.000Z' });
  assert.equal(sessions.get(plain.id).status, 'running', 'a process started after the exit is a new run');
  context.upsertSession({ ...tmux, activity: 'active' });
  context.upsertSession({ ...tmux, activity: 'quiet' });
  assert.equal(sessions.get(tmux.id).activity, 'quiet', 'a running session updates as before');
});

test('a multiplexer session detaches instead of ending, says how to reattach, and reads Closed', async () => {
  const { context, confirms } = page({ onApi: (method, route) => (method === 'DELETE' ? {} : { session: { ...(route.includes(tmux.id) ? tmux : plain) } }) });
  context.upsertSession({ ...plain });
  context.upsertSession({ ...tmux });
  await context.stopSession(tmux.id);
  await context.stopSession(plain.id);
  await context.removeSession(tmux.id);
  await context.removeSession(plain.id);
  assert.deepEqual(confirms, [
    'Detach "Shell · tmux"? tmux keeps running it. Reattach it from its card, or in a terminal with: tmux attach -t guild-abc123',
    'Stop "Shell · bash"? The Shell process will be ended.',
    '"Shell · tmux" is still running. Detach it and remove it? tmux keeps running it. Reattach it in a terminal with: tmux attach -t guild-abc123',
    '"Shell · bash" is still running. End it and remove it?',
  ]);
  assert.equal(context.statusText(exited(tmux)), 'Closed', 'a detached client\'s exit code means nothing to the user');
  assert.equal(context.statusText(exited(plain)), 'Exited (1)');
  assert.equal(context.statusText(exited(plain, { exitCode: 0 })), 'Exited');
});

test('Reattach brings a closed tmux card back as itself, only while tmux still has its session', async () => {
  const revived = { ...tmux, startedAt: '2026-10-03T10:06:00.000Z' };
  const { context, requests, opened, sessions } = page({ onApi: () => ({ session: revived }) });
  context.upsertSession(exited(tmux));
  assert.equal(context.reattachable(sessions.get(tmux.id)), false, 'not until the manager has found tmux still has it');
  context.upsertSession(exited(tmux, { multiplexer: { ...tmux.multiplexer, reattachable: true } }));
  assert.equal(context.reattachable(sessions.get(tmux.id)), true);
  await context.resumeCard(tmux.id);
  assert.deepEqual(requests, ['POST /sessions/m1/reattach']);
  assert.deepEqual([sessions.get(tmux.id).status, opened], ['running', ['m1']], 'the same card runs again and opens');
  assert.equal(context.reattachable(revived), false, 'a running card has nothing to reattach');
});

test('OSC 52 copies text and never answers a clipboard query', () => {
  const { context } = page();
  const b64 = (text) => Buffer.from(text).toString('base64');
  assert.equal(context.osc52Text(`c;${b64('copied → λ')}`), 'copied → λ');
  assert.equal(context.osc52Text(`;${b64('from tmux')}`), 'from tmux', 'tmux names no selection');
  for (const data of ['c;?', '?', 'c;', 'c;not base64!', 'no-separator', `c;${'A'.repeat(4 * 1024 * 1024 + 4)}`]) {
    assert.equal(context.osc52Text(data), null, data.slice(0, 20));
  }
});

test('a closed tmux or herdr panel says closed, not an exit code that means nothing to the user', () => {
  const { context } = page();
  assert.equal(context.exitLine(exited(tmux), { exitCode: 1, signal: null }), '[closed]', 'tmux\'s client exits 1 when detached');
  assert.equal(context.exitLine(exited(tmux, { exitCode: null }), { exitCode: null, signal: null }), '[closed]', 'a card brought back after a restart ran nothing yet');
  assert.equal(context.exitLine(exited(plain), { exitCode: 1, signal: null }), '[process exited with code 1]', 'other sessions as before');
  assert.equal(context.exitLine(exited(plain), { exitCode: null, signal: 'SIGKILL' }), '[process exited with signal SIGKILL]');
});
