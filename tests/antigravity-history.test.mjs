import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SessionHistory, FileMemo, listAntigravitySessions, antigravityWorkspaces, sameHistoryFolder } from '../src/manager/session-history.mjs';
import { readAntigravityTranscript, TRANSCRIPT_PAGE_BYTES } from '../src/manager/antigravity-transcript.mjs';

const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user = (text = 'First prompt') => ({ source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-10-01T12:00:00Z', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>injected</ADDITIONAL_METADATA>` });
const reply = (content = 'Visible reply') => ({ source: 'MODEL', type: 'PLANNER_RESPONSE', content, thinking: 'private reasoning', tool_calls: [{ secret: 'payload' }] });
const lines = (...records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-history-'));
  const cleanup = [];
  t.after(() => { for (const close of cleanup) close(); fs.rmSync(home, { recursive: true, force: true }); });
  const dir = path.join(home, '.gemini', 'antigravity-cli');
  fs.mkdirSync(dir, { recursive: true });
  const write = (rel, text) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    fs.utimesSync(file, new Date('2026-10-01T12:00:00Z'), new Date('2026-10-01T12:00:00Z'));
    return file;
  };
  const transcript = (n, text = lines(user(), reply())) => write(`brain/${id(n)}/.system_generated/logs/transcript.jsonl`, text);
  return { home, dir, write, transcript, cleanup };
}

async function database(t, f) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { t.skip('SQLite is unavailable on this Node version'); return null; }
  const db = new DatabaseSync(path.join(f.dir, 'conversation_summaries.db'));
  f.cleanup.push(() => db.close());
  // Only the text/scalar schema inspected in CLI 1.3.1; no copied user data or protobuf.
  db.exec(`CREATE TABLE conversation_summaries (
    conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, workspace_uris TEXT,
    app_data_dir TEXT, parent_conversation_id TEXT, nesting_depth INTEGER, step_count INTEGER)`);
  const insert = db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  return {
    db,
    row(n, extra = {}) {
      const r = { title: '', preview: '', workspace: [pathToFileURL(path.join(f.home, 'project')).href], app: 'antigravity-cli', parent: '', depth: 0, steps: 2, ...extra };
      insert.run(id(n), r.title, r.preview, JSON.stringify(r.workspace), r.app, r.parent, r.depth, r.steps);
    },
  };
}

test('Antigravity joins workspace metadata by id, prefers saved workspaces and excludes desktop, child and empty rows', async (t) => {
  const f = fixture(t), store = await database(t, f);
  if (!store) return;
  for (let n = 1; n <= 7; n++) f.transcript(n);
  store.row(1, { title: 'Renamed conversation' });
  store.row(2, { preview: 'Preview title' });
  store.row(3, { app: 'antigravity' });
  store.row(4, { parent: id(1), depth: 1 });
  store.row(5, { steps: 0 });
  store.row(6, { workspace: ['file:///one', 'file:///two'] });
  store.row(8); // A stale index entry without a local transcript.
  f.write('cache/last_conversations.json', JSON.stringify({ [path.join(f.home, 'wrong')]: id(1), [path.join(f.home, 'legacy')]: id(7) }));
  const before = fs.readFileSync(path.join(f.dir, 'conversation_summaries.db'));
  const result = await listAntigravitySessions(f.dir, new FileMemo(), { platform: 'linux', withStatus: true });
  assert.equal(result.note, null);
  assert.deepEqual(result.sessions.map((s) => s.id), [id(1), id(2), id(6), id(7)]);
  assert.equal(result.sessions[0].title, 'Renamed conversation');
  assert.equal(result.sessions[1].title, 'Preview title');
  const expected = antigravityWorkspaces(JSON.stringify([pathToFileURL(path.join(f.home, 'project')).href]), 'linux')[0];
  assert.equal(result.sessions[0].cwd, expected, 'the latest launch cache never overwrites the saved workspace');
  assert.deepEqual([result.sessions[2].cwd, result.sessions[2].workspaces], [null, ['/one', '/two']]);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'conversation_summaries.db')), before, 'the index is never modified');
});

test('missing, corrupt and changed-schema indexes keep readable transcripts with an explicit fallback note', async (t) => {
  const f = fixture(t);
  f.transcript(1);
  f.write('cache/last_conversations.json', JSON.stringify({ '/one': id(1), '/two': id(1) }));
  const read = () => listAntigravitySessions(f.dir, new FileMemo(), { platform: 'linux', withStatus: true });
  for (const data of [null, 'not a database']) {
    if (data) f.write('conversation_summaries.db', data);
    const result = await read();
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].cwd, null, 'ambiguous legacy mappings never choose the last object key');
    assert.match(result.note, /unavailable/);
  }
  fs.unlinkSync(path.join(f.dir, 'conversation_summaries.db'));
  const store = await database(t, f);
  if (!store) return;
  store.db.exec('DROP TABLE conversation_summaries; CREATE TABLE conversation_summaries (unexpected TEXT)');
  assert.equal((await read()).sessions.length, 1);
  assert.match((await read()).note, /unavailable/);
});

test('workspace URI decoding and equality follow the host platform without remote URLs or case folding on Linux', () => {
  assert.deepEqual(antigravityWorkspaces(JSON.stringify(['file:///C:/My%20Repo', 'file:///c:/my%20repo/', 'https://example.com', 'file://server/share', 'file:///C:/bad%2Fpath', 'file:///C:/x?y=1', 'file:///C:/x%00']), 'win32'), ['C:\\My Repo']);
  assert.deepEqual(antigravityWorkspaces(JSON.stringify(['file:///work/A', 'file:///work/a', 'file:///work/A/']), 'linux'), ['/work/A', '/work/a']);
  assert.deepEqual(antigravityWorkspaces('not json'), []);
  assert.deepEqual(antigravityWorkspaces('{}'), []);
  assert.equal(sameHistoryFolder('/work/A', '/work/a', 'linux'), false);
  assert.equal(sameHistoryFolder('/work/A\\', '/work/A', 'linux'), false);
  assert.equal(sameHistoryFolder('C:\\work\\A', 'c:/work/a/', 'win32'), true);
  assert.equal(sameHistoryFolder(null, '', 'linux'), false);
});

test('folder and search filters run before limits, including secondary workspaces and isolated account homes', async (t) => {
  const f = fixture(t);
  const provider = { id: 'google', history: 'antigravity', env: {} };
  const account = { id: 'default', env: {} };
  const roots = [];
  // This tests filtering and account isolation, so runner pauses must not expire the fixture cache.
  const history = new SessionHistory({ registry: {}, platform: 'linux', env: { HOME: f.home }, ttlMs: Infinity, readers: {
    antigravity: async (dir) => {
      roots.push(dir);
      return [{ id: id(1), title: 'Elsewhere', cwd: '/other' }, { id: id(2), title: 'Older', cwd: null, workspaces: ['/work/A', '/work/B'] }, { id: id(3), title: 'Third', cwd: '/work/B' }];
    },
  } });
  assert.deepEqual((await history.list(provider, account, { limit: 1, cwd: '/work/B' })).sessions.map((s) => s.id), [id(2)]);
  assert.equal((await history.list(provider, account, { limit: 1, cwd: '/work/B' })).total, 2);
  assert.equal((await history.list(provider, account, { query: 'third', limit: 1 })).sessions[0].id, id(3));
  assert.equal((await history.list(provider, account, { cwd: '/work/b' })).total, 0);
  await history.list(provider, { id: 'work', env: { HOME: path.join(f.home, 'second') } });
  assert.deepEqual(roots, [f.dir, path.join(f.home, 'second', '.gemini', 'antigravity-cli')]);
});

test('preview returns only visible user and assistant messages, treating markup as plain text', async (t) => {
  const f = fixture(t);
  f.transcript(1, lines(user('<script>plain text</script>'), reply(), { source: 'MODEL', type: 'GENERIC', content: 'tool output' },
    { source: 'MODEL', type: 'PLANNER_RESPONSE', thinking: 'no visible reply' }, { source: 'SYSTEM', type: 'USER_INPUT', content: 'injected' }));
  const result = await readAntigravityTranscript(f.dir, id(1));
  assert.deepEqual(result, { id: id(1), messages: [{ role: 'user', text: '<script>plain text</script>' }, { role: 'assistant', text: 'Visible reply' }], nextCursor: null, incomplete: false, omitted: false });
});

test('transcript pages preserve UTF-8 records across byte boundaries and do not duplicate messages', async (t) => {
  const f = fixture(t);
  const records = [user(), ...Array.from({ length: 10 }, (_, n) => reply(`${n}: ${'漢🙂'.repeat(6000)}`))];
  f.transcript(1, lines(...records));
  const messages = [];
  let cursor = null, pages = 0;
  do {
    const page = await readAntigravityTranscript(f.dir, id(1), cursor);
    messages.push(...page.messages);
    assert.equal(page.omitted, false);
    assert.equal(page.incomplete, false);
    cursor = page.nextCursor;
    assert.ok(++pages < 10, 'bounded fixture finishes without a cursor loop');
  } while (cursor);
  assert.ok(pages > 1);
  assert.deepEqual(messages.map((m) => m.text), ['First prompt', ...records.slice(1).map((r) => r.content)]);
});

test('oversized, malformed and partial records have bounded, explicit outcomes', async (t) => {
  const f = fixture(t);
  f.transcript(1, lines(user(), reply('x'.repeat(TRANSCRIPT_PAGE_BYTES * 2)), reply('After long record')) + 'not json\n{"unfinished":');
  let cursor = null, pages = 0, omitted = false, last;
  const messages = [];
  do {
    last = await readAntigravityTranscript(f.dir, id(1), cursor);
    messages.push(...last.messages); omitted ||= last.omitted; cursor = last.nextCursor;
    assert.ok(++pages < 10);
  } while (cursor);
  assert.equal(omitted, true);
  assert.equal(last.incomplete, true);
  assert.deepEqual(messages.map((m) => m.text), ['First prompt', 'After long record']);
});

test('changed or deleted transcripts invalidate saved cursors without timing assumptions', async (t) => {
  const f = fixture(t);
  const file = f.transcript(1, lines(user(), ...Array.from({ length: 8 }, () => reply('a'.repeat(50000)))));
  const first = await readAntigravityTranscript(f.dir, id(1));
  assert.ok(first.nextCursor);
  fs.appendFileSync(file, lines(reply('New turn'))); // Size changes even on coarse timestamp filesystems.
  await assert.rejects(readAntigravityTranscript(f.dir, id(1), first.nextCursor), { code: 'history_changed', status: 409 });
  assert.ok((await readAntigravityTranscript(f.dir, id(1))).messages.length);
  fs.unlinkSync(file);
  await assert.rejects(readAntigravityTranscript(f.dir, id(1)), { code: 'history_unavailable', status: 404 });
});

test('preview rejects traversal, bad cursors, linked folders and subagents', async (t) => {
  const f = fixture(t);
  f.transcript(1);
  f.transcript(2, lines({ source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: 'parent message' }, reply()));
  f.transcript(4, 'not json\n' + lines(user(), reply()));
  for (const bad of ['../outside', 'x', null, id(1) + '/logs']) await assert.rejects(readAntigravityTranscript(f.dir, bad), { code: 'bad_history_id' });
  await assert.rejects(readAntigravityTranscript(f.dir, id(1), 'not-a-cursor'), { code: 'bad_history_cursor' });
  await assert.rejects(readAntigravityTranscript(f.dir, id(1), 'x'.repeat(257)), { code: 'bad_history_cursor' });
  await assert.rejects(readAntigravityTranscript(f.dir, id(2)), { code: 'history_unavailable' });
  await assert.rejects(readAntigravityTranscript(f.dir, id(4)), { code: 'history_unavailable' });
  const linked = path.join(f.dir, 'brain', id(3));
  fs.symlinkSync(path.join(f.dir, 'brain', id(1)), linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readAntigravityTranscript(f.dir, id(3)), { code: 'history_unavailable' });
  assert.deepEqual((await listAntigravitySessions(f.dir)).map((s) => s.id), [id(1)]);
});

test('detail requests recheck provider membership and account environment', async (t) => {
  const f = fixture(t);
  f.transcript(1);
  const provider = { id: 'google', history: 'antigravity', env: {} };
  const account = { id: 'default', env: { HOME: f.home, USERPROFILE: f.home } };
  const history = new SessionHistory({ registry: {}, env: {} });
  assert.equal((await history.detail(provider, account, id(1))).messages.length, 2);
  await assert.rejects(history.detail({ ...provider, history: 'codex' }, account, id(1)), { code: 'history_detail_unsupported' });
  await assert.rejects(history.detail(provider, account, '../x'), { code: 'bad_history_id' });
  await assert.rejects(history.detail(provider, { id: 'other', env: { HOME: path.join(f.home, 'other'), USERPROFILE: path.join(f.home, 'other') } }, id(1)), { code: 'history_unavailable' });
});
