import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const source = ['upsertSession', 'statusText', 'stopNote', 'stopSession', 'removeSession', 'osc52Text'].map((name) => {
  const found = app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(found, `${name} is present in app.js`);
  return found;
}).join('\n');

const plain = { id: 'p1', name: 'Shell · bash', provider: { tool: 'Shell' }, status: 'running', exitCode: null, signal: null, multiplexer: null };
const tmux = { ...plain, id: 'm1', name: 'Shell · tmux', multiplexer: { label: 'tmux', attach: 'tmux attach -t guild-abc123' } };

// The browser's own session logic, with only the DOM and the network stubbed.
function page({ onApi = () => ({}) } = {}) {
  const confirms = [];
  const context = {
    state: { sessions: new Map() },
    renderSessions() {}, noticeClone() {}, dropSession() {},
    toast(message) { assert.fail(message); },
    confirm: (message) => { confirms.push(message); return true; },
    api: async (method, route) => onApi(method, route, context),
    TextDecoder, atob,
  };
  runInNewContext(source, context);
  return { context, confirms, sessions: context.state.sessions };
}

test('a reply sent before a session exited cannot show it running again', async () => {
  // Stop's reply was taken before the process ended; the exit event overtakes it.
  const { context, sessions } = page({
    onApi: (method, route, ctx) => {
      ctx.upsertSession({ ...plain, status: 'exited', exitCode: 1 });
      return { session: { ...plain } };
    },
  });
  context.upsertSession({ ...plain });
  await context.stopSession(plain.id);
  assert.equal(sessions.get(plain.id).status, 'exited');

  context.upsertSession({ ...plain, status: 'exited', exitCode: 1, name: 'Renamed' });
  assert.equal(sessions.get(plain.id).name, 'Renamed', 'updates to an exited session still apply');
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
    'Detach "Shell · tmux"? tmux keeps running it. Reattach in a terminal with: tmux attach -t guild-abc123',
    'Stop "Shell · bash"? The Shell process will be ended.',
    '"Shell · tmux" is still running. Detach it and remove it? tmux keeps running it. Reattach in a terminal with: tmux attach -t guild-abc123',
    '"Shell · bash" is still running. End it and remove it?',
  ]);
  assert.equal(context.statusText({ ...tmux, status: 'exited', exitCode: 1 }), 'Closed', 'a detached client\'s exit code means nothing to the user');
  assert.equal(context.statusText({ ...plain, status: 'exited', exitCode: 1 }), 'Exited (1)');
  assert.equal(context.statusText({ ...plain, status: 'exited', exitCode: 0 }), 'Exited');
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
