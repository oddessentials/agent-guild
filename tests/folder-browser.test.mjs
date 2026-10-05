import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createFolderBrowser, folderSegments } from '../src/manager/folder-browser.mjs';
import { createManagerServer } from '../src/manager/server.mjs';

function tree(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'guild-browse-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['beta', 'Alpha', 'item10', 'item9', '.hidden', 'Alpha/inner']) fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(path.join(root, 'file.txt'), 'x');
  fs.symlinkSync(path.join(root, 'Alpha'), path.join(root, 'linked'), 'junction');
  fs.mkdirSync(path.join(root, 'gone'));
  fs.symlinkSync(path.join(root, 'gone'), path.join(root, 'dangling'), 'junction');
  fs.rmdirSync(path.join(root, 'gone'));
  return root;
}

test('a listing holds only folders, including linked ones, sorted by name with hidden ones flagged', async (t) => {
  const root = tree(t);
  const listing = await createFolderBrowser({ home: root }).list(root);
  assert.deepEqual(listing.entries.map((e) => e.name), ['.hidden', 'Alpha', 'beta', 'item9', 'item10', 'linked']);
  assert.deepEqual(listing.entries.find((e) => e.name === '.hidden'), { name: '.hidden', path: path.join(root, '.hidden'), hidden: true });
  assert.equal(listing.entries.find((e) => e.name === 'linked').hidden, false);
  assert.equal(listing.path, root);
  assert.equal(listing.parent, path.dirname(root));
  assert.equal(listing.truncated, false);
  assert.equal(listing.note, null);
  assert.deepEqual(listing.segments.at(-1), { name: path.basename(root), path: root });
});

test('missing paths fall back to the nearest folder and blank or ~ paths mean home', async (t) => {
  const root = tree(t);
  const browser = createFolderBrowser({ home: path.join(root, 'beta') });
  const missing = path.join(root, 'Alpha', 'gone', 'deeper');
  const fallback = await browser.list(missing);
  assert.equal(fallback.path, path.join(root, 'Alpha'));
  assert.equal(fallback.note, missing);
  assert.equal((await browser.list(path.join(root, 'file.txt'))).path, root);
  for (const blank of [undefined, '', '   ', '~']) assert.equal((await browser.list(blank)).path, path.join(root, 'beta'));
  assert.equal((await browser.list(`~${path.sep}..${path.sep}Alpha`)).path, path.join(root, 'Alpha'));
  await assert.rejects(browser.list('a\0b'), { status: 400, code: 'bad_path' });
});

test('an unreadable folder fails clearly', async () => {
  const fsp = {
    stat: async () => ({ isDirectory: () => true }),
    readdir: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
  };
  await assert.rejects(createFolderBrowser({ platform: 'linux', home: '/home/me', fsp }).list('/root'), { status: 409, code: 'folder_unreadable', message: /\/root/ });
});

test('listings stop at the limit and say so', async (t) => {
  const root = tree(t);
  const listing = await createFolderBrowser({ home: root, limit: 2 }).list(root);
  assert.deepEqual(listing.entries.map((e) => e.name), ['.hidden', 'Alpha']);
  assert.equal(listing.truncated, true);
});

test('Windows lists the drives that answer in time and splits paths into segments', async () => {
  const stat = (dir) => {
    if (dir === 'C:\\' || dir === 'E:\\' || dir === 'E:\\projects') return Promise.resolve({ isDirectory: () => true });
    if (dir === 'Z:\\') return new Promise(() => {});
    return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  };
  const fsp = { stat, readdir: async () => [] };
  const started = Date.now();
  const listing = await createFolderBrowser({ platform: 'win32', home: 'C:\\', driveTimeoutMs: 50, fsp }).list('E:\\projects');
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(listing.roots, [{ name: 'C:', path: 'C:\\' }, { name: 'E:', path: 'E:\\' }]);
  assert.deepEqual(listing.segments, [{ name: 'E:\\', path: 'E:\\' }, { name: 'projects', path: 'E:\\projects' }]);
  assert.equal(listing.parent, 'E:\\');
  assert.equal((await createFolderBrowser({ platform: 'win32', home: 'C:\\', driveTimeoutMs: 50, fsp }).list('Q:\\gone')).path, 'C:\\');
  assert.deepEqual(folderSegments('/', path.posix), [{ name: '/', path: '/' }]);
  assert.deepEqual(folderSegments('/a/b', path.posix).map((s) => s.path), ['/', '/a', '/a/b']);
});

test('the folders API requires the manager token and serves local and remote clients alike', { timeout: 10000 }, async (t) => {
  const root = tree(t);
  const manager = Object.assign(new EventEmitter(), { list: () => [] });
  const registry = Object.assign(new EventEmitter(), { warnings: [] });
  const api = createManagerServer({ manager, registry, folderBrowser: createFolderBrowser({ home: root }), extraHosts: ['guild.example.ts.net'],
    token: 'test-manager-token', webDir: fileURLToPath(new URL('../web', import.meta.url)) });
  await api.listen();
  t.after(() => api.close());
  const get = (query, headers) => new Promise((resolve, reject) => {
    http.get(`${api.url}/api/v1/folders${query}`, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (chunk) => { body += chunk; }).on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
  const auth = { Authorization: 'Bearer test-manager-token' };
  assert.equal((await get('', {})).status, 401);
  assert.equal((await get('', { ...auth, Host: 'evil.example' })).status, 403);
  const home = await get('', auth);
  assert.equal(home.status, 200);
  assert.equal(home.body.path, root);
  const remote = await get(`?path=${encodeURIComponent(path.join(root, 'Alpha'))}`, { ...auth, Host: 'guild.example.ts.net' });
  assert.equal(remote.status, 200);
  assert.deepEqual(remote.body.entries.map((e) => e.name), ['inner']);
});
