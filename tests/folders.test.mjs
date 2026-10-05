import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECENT_FOLDERS_MAX, matchFolders, readRecentFolders, rememberFolder } from '../web/folders.js';

test('recent folders keep the five newest, without duplicates', () => {
  assert.equal(RECENT_FOLDERS_MAX, 5);
  let list = [];
  for (const dir of ['/a', '/b', '/c', '/d', '/e', '/f']) list = rememberFolder(list, dir);
  assert.deepEqual(list, ['/f', '/e', '/d', '/c', '/b']);
  assert.deepEqual(rememberFolder(list, '/c'), ['/c', '/f', '/e', '/d', '/b']);
});

test('duplicates ignore case only for a Windows manager', () => {
  const list = ['C:\\Work', '/srv/App'];
  assert.deepEqual(rememberFolder(list, 'c:\\work', { caseless: true }), ['c:\\work', '/srv/App']);
  assert.deepEqual(rememberFolder(list, '/srv/app'), ['/srv/app', 'C:\\Work', '/srv/App']);
});

test('stored folders survive corrupt or foreign values', () => {
  for (const text of [null, '', 'not json', '{"a":1}', '42']) assert.deepEqual(readRecentFolders(text), []);
  assert.deepEqual(readRecentFolders(JSON.stringify(['/a', 3, '', '  ', null, '/b', '/c', '/d', '/e', '/f'])), ['/a', '/b', '/c', '/d', '/e']);
});

test('typing narrows the suggestions without regard to case', () => {
  const list = ['/home/me/Projects/guild', '/srv/app', 'D:\\Work\\Guild'];
  assert.deepEqual(matchFolders(list, '  '), list);
  assert.deepEqual(matchFolders(list, 'GUILD'), ['/home/me/Projects/guild', 'D:\\Work\\Guild']);
  assert.deepEqual(matchFolders(list, 'nothing'), []);
});
