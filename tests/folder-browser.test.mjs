import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createFolderBrowser, folderNameProblem, folderSegments } from '../src/manager/folder-browser.mjs';
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

test('a new folder is made inside an existing folder and listed as the new location', async (t) => {
  const root = tree(t);
  const browser = createFolderBrowser({ home: root });
  const made = await browser.create(root, '  Fresh & co (1)  ');
  assert.equal(made.path, path.join(root, 'Fresh & co (1)'));
  assert.equal(made.parent, root);
  assert.deepEqual(made.entries, []);
  assert.ok(fs.statSync(made.path).isDirectory());
  assert.equal((await browser.create(path.join(root, 'linked'), 'through-link')).path, path.join(root, 'linked', 'through-link'));
  assert.ok(fs.statSync(path.join(root, 'Alpha', 'through-link')).isDirectory());
  await assert.rejects(browser.create(root, 'beta'), { status: 409, code: 'folder_exists', message: /beta/ });
  await assert.rejects(browser.create(root, 'file.txt'), { status: 409, code: 'folder_exists' });
  await assert.rejects(browser.create(path.join(root, 'gone'), 'x'), { status: 409, code: 'folder_missing' });
  await assert.rejects(browser.create(path.join(root, 'file.txt'), 'x'), { status: 409, code: 'folder_missing' });
  await assert.rejects(browser.create('', 'x'), { status: 400, code: 'bad_path' });
  await assert.rejects(browser.create(root, 7), { status: 400, code: 'bad_name' });
  assert.equal(fs.existsSync(path.join(root, 'gone')), false);
});

test('folder names must be one plain name, with Windows rules on Windows', () => {
  for (const name of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', 'a\nb']) {
    assert.ok(folderNameProblem(name, 'linux'), name);
    assert.ok(folderNameProblem(name, 'win32'), name);
  }
  for (const name of ['CON', 'con.txt', 'Nul', 'COM1', 'lpt9.log', 'a:b', 'a?', 'a*', 'a|b', 'a"b', '<a>', 'trailing.', 'trailing ']) {
    assert.ok(folderNameProblem(name, 'win32'), name);
    assert.equal(folderNameProblem(name, 'linux'), null, name);
  }
  for (const name of ['.hidden', 'CONSOLE', 'com10', 'my repo', 'résumé', 'a.b']) assert.equal(folderNameProblem(name, 'win32'), null, name);
});

test('creating fails clearly when the folder cannot be read or written', async () => {
  const readable = { stat: async () => ({ isDirectory: () => true }), readdir: async () => [], mkdir: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
  const browser = createFolderBrowser({ platform: 'linux', home: '/home/me', fsp: readable });
  await assert.rejects(browser.create('/srv', 'new'), { status: 409, code: 'folder_unwritable', message: /\/srv\/new/ });
  await assert.rejects(browser.create('/srv', 'CON'), { code: 'folder_unwritable' });
  const vanished = { ...readable, mkdir: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } };
  await assert.rejects(createFolderBrowser({ platform: 'linux', home: '/', fsp: vanished }).create('/srv', 'new'), { code: 'folder_missing' });
  const locked = { ...readable, stat: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
  await assert.rejects(createFolderBrowser({ platform: 'linux', home: '/', fsp: locked }).create('/srv', 'new'), { code: 'folder_unreadable' });
  const windows = createFolderBrowser({ platform: 'win32', home: 'C:\\', fsp: readable });
  await assert.rejects(windows.create('C:\\work', 'aux.md'), { status: 400, code: 'bad_name', message: /aux\.md/ });
});

test('the create-folder API requires the manager token and answers with the new listing', { timeout: 10000 }, async (t) => {
  const root = tree(t);
  const manager = Object.assign(new EventEmitter(), { list: () => [] });
  const registry = Object.assign(new EventEmitter(), { warnings: [] });
  const api = createManagerServer({ manager, registry, folderBrowser: createFolderBrowser({ home: root }), extraHosts: ['guild.example.ts.net'],
    token: 'test-manager-token', webDir: fileURLToPath(new URL('../web', import.meta.url)) });
  await api.listen();
  t.after(() => api.close());
  const post = (body, headers) => new Promise((resolve, reject) => {
    const req = http.request(`${api.url}/api/v1/folders`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (chunk) => { text += chunk; }).on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    }).on('error', reject);
    req.end(JSON.stringify(body));
  });
  const auth = { Authorization: 'Bearer test-manager-token', Host: 'guild.example.ts.net' };
  assert.equal((await post({ path: root, name: 'nope' }, {})).status, 401);
  assert.equal(fs.existsSync(path.join(root, 'nope')), false);
  const made = await post({ path: root, name: 'clones' }, auth);
  assert.equal(made.status, 201);
  assert.equal(made.body.path, path.join(root, 'clones'));
  const again = await post({ path: root, name: 'clones' }, auth);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'folder_exists');
  assert.equal((await post({ path: root, name: '../escape' }, auth)).body.error.code, 'bad_name');
});
