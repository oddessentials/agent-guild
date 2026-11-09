import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pty from 'node-pty';
import { fakePty } from './fixtures/fake-pty.mjs';
import { Session } from '../src/manager/session.mjs';

function sessions(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1700000000000 });
  t.mock.method(pty, 'spawn', () => fakePty());
  let instance = 0;
  t.mock.method(crypto, 'randomUUID', () => `00000000-0000-4000-8000-${String(++instance).padStart(12, '0')}`);
  return (opts = {}) => {
    const session = new Session({
      id: 'a1', provider: { id: 'fake', tool: 'Fake', reporting: 'codex' },
      spawnSpec: { file: 'mock', args: [] }, cwd: process.cwd(), env: {},
      cols: 80, rows: 24, reportToken: 'fixture', ...opts,
    });
    t.after(() => session.dispose());
    return session;
  };
}

test('reply readers paginate independently, retry without consuming, and keep answers after an empty turn', (t) => {
  const session = sessions(t)();
  const initial = session.toJSON().replyCursor;
  assert.deepEqual(session.readReplies(), { replies: [], nextCursor: initial, hasMore: false, gap: null, firstCursor: null });
  for (const reply of [' first ', 'second', 'second']) session.reportReply({ reply });
  const a = session.readReplies({ after: initial, limit: 1 });
  assert.deepEqual(a.replies.map(({ id, text }) => ({ id, text })), [{ id: 1, text: 'first' }]);
  assert.equal(a.hasMore, true);
  assert.equal(a.gap, null);
  const b = session.readReplies({ limit: 2 });
  assert.deepEqual(b.replies.map((r) => r.id), [1, 2]);
  assert.deepEqual(session.readReplies({ after: initial, limit: 1 }), a);
  session.reportReply({ reply: null });
  assert.equal(session.reply, null);
  assert.equal(session.toJSON().replyCursor, session.replyCursor(3));
  assert.deepEqual(session.readReplies({ after: a.nextCursor }).replies.map((r) => r.id), [2, 3]);
  assert.deepEqual(session.readReplies({ after: b.nextCursor }).replies.map((r) => r.id), [3]);
  assert.equal(session.readReplies({ after: session.replyCursor(3) }).hasMore, false);
  session._onExit(0);
  assert.deepEqual(session.readReplies().replies.map((r) => r.text), ['first', 'second', 'second']);
});

test('reply count eviction reports the gap without disturbing readers at the retained boundary', (t) => {
  const session = sessions(t)();
  const initial = session.toJSON().replyCursor;
  for (let n = 1; n <= 101; n++) session.reportReply({ reply: `reply ${n}` });
  const lost = session.readReplies({ after: initial, limit: 100 });
  assert.equal(lost.gap, 'evicted');
  assert.equal(lost.replies.length, 100);
  assert.equal(lost.replies[0].id, 2);
  assert.equal(lost.firstCursor, lost.replies[0].cursor);
  assert.equal(lost.replies.at(-1).id, 101);
  assert.equal(lost.hasMore, false);
  assert.equal(session.readReplies().gap, 'evicted');
  assert.equal(session.readReplies({ after: session.replyCursor(1) }).gap, null);
  session.reportReply({ reply: 'reply 102' });
  assert.deepEqual(session.readReplies({ after: lost.nextCursor }).replies.map((r) => r.id), [102]);
});

test('the reply byte budget counts UTF-8, evicts whole replies, and keeps an oversized newest answer', (t) => {
  const session = sessions(t)();
  const half = 'é'.repeat(4 * 1024 * 1024);
  session.reportReply({ reply: half });
  session.reportReply({ reply: half });
  assert.equal(session.readReplies().replies.length, 2);
  session.reportReply({ reply: 'x' });
  const trimmed = session.readReplies();
  assert.equal(trimmed.gap, 'evicted');
  assert.deepEqual(trimmed.replies.map((r) => r.id), [2, 3]);
  assert.equal(trimmed.replies[0].text, half);
  const oversized = half + half + 'x';
  session.reportReply({ reply: oversized });
  assert.deepEqual(session.readReplies().replies.map((r) => r.id), [4]);
  assert.equal(session.readReplies().replies[0].text, oversized);
  session.reportReply({ reply: 'next' });
  assert.deepEqual(session.readReplies().replies.map((r) => r.text), ['next']);
});

test('reply cursors distinguish replacement sessions and reject malformed or future positions', (t) => {
  const create = sessions(t);
  const original = create();
  original.reportReply({ reply: 'old' });
  const after = original.readReplies().nextCursor;
  const replacement = create();
  assert.equal(replacement.id, original.id);
  const empty = replacement.readReplies({ after });
  assert.equal(empty.gap, 'reset');
  assert.equal(empty.hasMore, false);
  assert.equal(replacement.readReplies({ after: empty.nextCursor }).gap, null);
  replacement.reportReply({ reply: 'new' });
  const reset = replacement.readReplies({ after });
  assert.equal(reset.gap, 'reset');
  assert.deepEqual(reset.replies.map((r) => r.text), ['new']);
  for (const after of ['', '1', 1, original.replyCursor(2), original.replyCursor(Number.MAX_SAFE_INTEGER + 1)]) {
    assert.throws(() => original.readReplies({ after }), { status: 400 });
  }
  for (const limit of [0, -1, 101, 1.5, '1', NaN]) assert.throws(() => original.readReplies({ limit }), { status: 400 });
});
