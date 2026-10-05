import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { NOTES_BODY_LIMIT, NOTES_LIMIT, createNotesStore } from '../src/manager/notes.mjs';
import { createManagerServer } from '../src/manager/server.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-notes-'));
}

test('a missing notepad is empty, a cleared one stays empty, and a stale revision cannot overwrite it', () => {
  const dir = tempDir();
  const file = path.join(dir, 'notes.json');
  const store = createNotesStore(file);
  assert.deepEqual(store.snapshot(), { revision: null, text: '' });
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(store.helloRevision(), { known: true, revision: null });

  const first = store.save({ revision: null, text: 'checklist' });
  assert.equal(first.text, 'checklist');
  assert.equal(fs.existsSync(file), true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = createNotesStore(file);
  assert.equal(again.snapshot().text, 'checklist');

  const cleared = again.save({ revision: first.revision, text: '' });
  assert.equal(cleared.text, '');
  assert.notEqual(cleared.revision, first.revision);
  assert.equal(createNotesStore(file).snapshot().revision, cleared.revision, 'cleared notes are stored, not forgotten');

  assert.throws(() => again.save({ revision: first.revision, text: 'resurrected' }), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'stale_notes');
    assert.equal(error.notes.text, '');
    assert.equal(error.message.includes('resurrected'), false);
    return true;
  });
  assert.equal(createNotesStore(file).snapshot().text, '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('notes over the character cap are refused and a file that cannot be read is not replaced', () => {
  const dir = tempDir();
  const file = path.join(dir, 'notes.json');
  const store = createNotesStore(file);
  assert.throws(() => store.save({ revision: null, text: 'x'.repeat(NOTES_LIMIT + 1) }), { code: 'notes_too_long', status: 400 });
  assert.equal(fs.existsSync(file), false);
  store.save({ revision: null, text: 'x'.repeat(NOTES_LIMIT) });

  fs.writeFileSync(file, '{"version":1,"text":', { mode: 0o600 });
  const broken = createNotesStore(file);
  assert.throws(() => broken.snapshot(), { code: 'notes_unreadable', status: 500 });
  assert.deepEqual(broken.helloRevision(), { known: false });
  assert.throws(() => broken.save({ revision: null, text: 'replacement' }), { code: 'notes_unreadable' });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"version":1,"text":');
  fs.rmSync(dir, { recursive: true, force: true });
});

async function listen(notes) {
  const manager = Object.assign(new EventEmitter(), { list: () => [] });
  const registry = Object.assign(new EventEmitter(), { warnings: [] });
  const api = createManagerServer({
    manager, registry, notes, token: 'test-manager-token',
    webDir: fileURLToPath(new URL('../web', import.meta.url)),
  });
  await api.listen();
  return api;
}

function call(api, method, route, { body, token = 'test-manager-token', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(body);
    const req = http.request(`${api.url}/api/v1${route}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('the notes routes require the manager token, accept a notepad larger than the usual body cap, and publish one event', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const api = await listen(createNotesStore(path.join(dir, 'notes.json')));
  t.after(() => api.close());

  assert.equal((await call(api, 'GET', '/notes', { token: '' })).status, 401);
  assert.equal((await call(api, 'GET', '/notes', { token: '', headers: { 'X-Agent-Guild-Report-Token': 'test-manager-token' } })).status, 401);

  const ws = new WebSocket(`${api.url.replace('http:', 'ws:')}/api/v1/events?token=test-manager-token`);
  t.after(() => ws.terminate());
  const hello = JSON.parse((await once(ws, 'message'))[0]);
  assert.equal(hello.notesRevision, null);

  const text = 'n'.repeat(70_000);
  assert.ok(Buffer.byteLength(JSON.stringify({ revision: null, text })) > 64 * 1024);
  const published = once(ws, 'message');
  const saved = await call(api, 'PUT', '/notes', { body: JSON.stringify({ revision: null, text }) });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.notes.text, text);
  const event = JSON.parse((await published)[0]);
  assert.equal(event.type, 'notes.updated');
  assert.equal(event.notes.revision, saved.body.notes.revision);
  assert.equal(event.notes.text, text);

  const read = await call(api, 'GET', '/notes');
  assert.equal(read.body.notes.revision, saved.body.notes.revision);

  const stale = await call(api, 'PUT', '/notes', { body: JSON.stringify({ revision: null, text: 'nope' }) });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'stale_notes');
  assert.equal(stale.body.error.notes.text, text);
  assert.equal(stale.body.error.message.includes(text), false);

  const tooLong = await call(api, 'PUT', '/notes', { body: JSON.stringify({ revision: saved.body.notes.revision, text: 'x'.repeat(NOTES_LIMIT + 1) }) });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.error.code, 'notes_too_long');

  const huge = await call(api, 'PUT', '/notes', { body: `{"revision":null,"text":"${'x'.repeat(NOTES_BODY_LIMIT)}"}` });
  assert.equal(huge.status, 413);
});
