import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlightParts, rankRepos, recentFirst, remember, repoForOrigin, repoKey } from '../web/repo-search.js';

const repos = [
  { accountId: 1, login: 'octo', name: 'guild', fullName: 'octo/guild', description: 'hall', language: 'JavaScript', pushedAt: '2026-01-01T00:00:00.000Z' },
  { accountId: 1, login: 'octo', name: 'web', fullName: 'octo/web', description: 'guild site', language: 'CSS', pushedAt: '2026-06-01T00:00:00.000Z' },
  { accountId: 2, login: 'ada', name: 'other', fullName: 'ada/other', description: 'notes', language: null, pushedAt: '2026-05-01T00:00:00.000Z' },
  { accountId: 2, login: 'ada', name: 'guild', fullName: 'ada/guild', description: 'fork', language: 'Go', pushedAt: '2026-04-01T00:00:00.000Z' },
];
const names = (list) => list.map((repo) => repo.fullName);

test('a name starting with the query ranks first, then owner/name containing it, then other matches', () => {
  assert.deepEqual(names(rankRepos(repos, 'guild')), ['ada/guild', 'octo/guild', 'octo/web']);
  assert.deepEqual(names(rankRepos(repos, 'octo/g')), ['octo/guild']);
  assert.deepEqual(names(rankRepos(repos, 'ada notes')), ['ada/other'], 'every word must match somewhere');
  assert.deepEqual(names(rankRepos(repos, 'GO')), ['ada/guild'], 'case does not matter; language counts');
  assert.deepEqual(names(rankRepos(repos, 'octo')), ['octo/web', 'octo/guild'], 'the account login matches');
  assert.deepEqual(rankRepos(repos, 'missing'), []);
  assert.deepEqual(names(rankRepos(repos, '   ')), ['octo/web', 'ada/other', 'ada/guild', 'octo/guild'], 'no query: latest push first');
  assert.deepEqual(rankRepos([], 'x'), []);
  assert.deepEqual(names(rankRepos([{ accountId: 3, fullName: 'z/a', name: 'a' }, { accountId: 3, fullName: 'y/a', name: 'a' }], 'a')), ['y/a', 'z/a'], 'no push time: by name');
});

test('the same repository through two accounts stays two picks', () => {
  const twice = [{ ...repos[0] }, { ...repos[0], accountId: 2, login: 'ada' }];
  assert.equal(rankRepos(twice, 'guild').length, 2);
  assert.notEqual(repoKey(twice[0]), repoKey(twice[1]));
  assert.equal(repoKey(twice[0]), '1:octo/guild');
});

test('recent picks come first, once each and at most eight, and remembering moves a pick to the front', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ accountId: 3, fullName: `org/r${i}`, name: `r${i}`, pushedAt: `2026-03-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` }));
  const keys = many.map(repoKey).reverse();
  const ordered = recentFirst(many, [...keys, keys[0], 'missing']);
  assert.equal(ordered.length, 10);
  assert.deepEqual(names(ordered.slice(0, 8)), keys.slice(0, 8).map((key) => key.split(':')[1]));
  assert.deepEqual(names(recentFirst(repos, 'not a list')), names(repos));
  let recent = [];
  for (const repo of many) recent = remember(recent, repo);
  assert.equal(recent.length, 8);
  assert.equal(recent[0], '3:org/r9');
  recent = remember(recent, many[5]);
  assert.equal(recent[0], '3:org/r5');
  assert.equal(new Set(recent).size, recent.length);
  assert.deepEqual(remember(null, repos[0]), ['1:octo/guild']);
});

test('a folder\'s origin picks the account used most recently for it', () => {
  const twice = [{ ...repos[0] }, { ...repos[0], accountId: 2, login: 'ada' }];
  assert.equal(repoForOrigin(twice, 'octo/guild').accountId, 1);
  assert.equal(repoForOrigin(twice, 'octo/guild', ['2:octo/guild']).accountId, 2);
  assert.equal(repoForOrigin([{ ...repos[0], fullName: 'Octo/Guild' }], 'octo/guild').fullName, 'Octo/Guild', 'GitHub names ignore case');
  assert.equal(repoForOrigin(twice, 'octo/missing'), null);
  assert.equal(repoForOrigin(twice, null), null);
});

test('highlighting splits text on the query\'s words without reading them as patterns', () => {
  const parts = highlightParts('agent-guild', 'guild');
  assert.equal(parts.map((part) => part.text).join(''), 'agent-guild');
  assert.deepEqual(parts, [{ match: false, text: 'agent-' }, { match: true, text: 'guild' }]);
  assert.deepEqual(highlightParts('a.b', '.'), [{ match: false, text: 'a' }, { match: true, text: '.' }, { match: false, text: 'b' }]);
  assert.deepEqual(highlightParts('Octo/Guild', 'oct gui'), [{ match: true, text: 'Oct' }, { match: false, text: 'o/' }, { match: true, text: 'Gui' }, { match: false, text: 'ld' }]);
  assert.deepEqual(highlightParts('aaaa', 'aa'), [{ match: true, text: 'aaaa' }]);
  assert.deepEqual(highlightParts('plain', ''), [{ match: false, text: 'plain' }]);
  assert.deepEqual(highlightParts('', 'x'), [{ match: false, text: '' }]);
  assert.deepEqual(highlightParts('(x)', '(x'), [{ match: true, text: '(x' }, { match: false, text: ')' }]);
});
