import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GitHub } from '../src/manager/github.mjs';
import { createViews } from '../src/manager/github-views.mjs';

function fixture(answer, { login = 'reader', save = () => {} } = {}) {
  const requests = [];
  const account = { id: 7, login };
  const saved = [];
  const updates = [];
  const hub = Object.assign(new EventEmitter(), {
    account(id) { if (id !== 7) throw Object.assign(new Error('Sign in'), { code: 'unknown_account' }); return account; },
    _refreshUser: GitHub.prototype._refreshUser,
    _changed: GitHub.prototype._changed,
    _save() { save(); saved.push({ ...account }); },
    async _apiJson(account, route) {
      requests.push(route);
      const result = await answer(route);
      return { body: result.body, res: new Response('', { headers: result.link ? { Link: result.link } : {} }) };
    },
  });
  hub.on('updated', () => updates.push(account.login));
  return { requests, account, saved, updates, views: createViews(hub) };
}

const from = '2026-10-10T00:00:00Z';
const after = '2026-10-11T00:00:00Z';
const before = '2026-10-01T00:00:00Z';
const next = '<https://api.github.com/next>; rel="next"';

function repo({ metadata = {}, pulls = {}, issues = [], details = {}, runs = [] } = {}) {
  return (route) => {
    const [path] = route.split('?');
    if (path === '/user') return { body: { id: 7, login: 'reader' } };
    if (path === '/repos/team/repo') return { body: metadata };
    if (path.endsWith('/pulls')) {
      const list = pulls[path.split('/').slice(2, 4).join('/')];
      if (!list) throw Object.assign(new Error('Not Found'), { github: 404 });
      return typeof list === 'function' ? list(route) : { body: list };
    }
    if (path === '/repos/team/repo/issues') return { body: issues };
    if (path.startsWith('/repos/team/repo/issues/')) return { body: details[path.split('/').at(-1)] };
    if (path === '/repos/team/repo/actions/runs') return { body: { workflow_runs: runs } };
    throw new Error(`unexpected ${route}`);
  };
}

test('activity is only the account\'s own merges, completed closes and passed runs since the given time', async () => {
  const { views, requests } = fixture(repo({
    pulls: { 'team/repo': [
      { number: 1, title: 'Mine', user: { id: 7 }, merged_at: after, updated_at: after },
      { number: 2, title: 'Theirs', user: { id: 8 }, merged_at: after, updated_at: after },
      { number: 3, title: 'Closed unmerged', user: { id: 7 }, merged_at: null, updated_at: after },
      { number: 4, title: 'Merged earlier', user: { id: 7 }, merged_at: '2026-10-09T00:00:00Z', updated_at: after },
      { number: 5, title: 'Old', user: { id: 7 }, merged_at: before, updated_at: before },
    ] },
    issues: [
      { number: 9, title: 'Listed with its closer', state: 'closed', state_reason: 'completed', closed_at: after, updated_at: after, closed_by: { id: 7 } },
      { number: 10, state_reason: 'completed', closed_at: after, updated_at: after },
      { number: 11, state_reason: 'completed', closed_at: after, updated_at: after },
      { number: 12, state_reason: 'not_planned', closed_at: after, updated_at: after },
      { number: 13, state_reason: 'completed', closed_at: after, updated_at: after, pull_request: {} },
      { number: 14, state_reason: 'completed', closed_at: after, updated_at: after },
    ],
    details: {
      10: { number: 10, title: 'Fixed', state: 'closed', state_reason: 'completed', closed_at: after, closed_by: { id: 7 } },
      11: { number: 11, title: 'Closed by someone else', state: 'closed', state_reason: 'completed', closed_at: after, closed_by: { id: 8 } },
      14: { number: 14, title: 'Reopened', state: 'open', state_reason: 'reopened', closed_at: null, closed_by: { id: 7 } },
    },
    runs: [
      { id: 21, name: 'CI', conclusion: 'success', actor: { id: 7 }, created_at: after },
      { id: 22, name: 'CI', conclusion: 'success', actor: { id: 8 }, created_at: after },
      { id: 23, name: 'CI', conclusion: 'failure', actor: { id: 7 }, created_at: after },
    ],
  }));
  const activity = await views.activity(7, 'team', 'repo', { from });
  assert.deepEqual(activity.merged, [{ repo: 'team/repo', number: 1, title: 'Mine', mergedAt: '2026-10-11T00:00:00.000Z', url: 'https://github.com/team/repo/pull/1' }]);
  assert.deepEqual(activity.closed, [{ number: 9, title: 'Listed with its closer', closedAt: '2026-10-11T00:00:00.000Z', url: 'https://github.com/team/repo/issues/9' }, { number: 10, title: 'Fixed', closedAt: '2026-10-11T00:00:00.000Z', url: 'https://github.com/team/repo/issues/10' }]);
  assert.deepEqual(activity.passed.map((r) => r.id), [21]);
  assert.equal(activity.since, '2026-10-10T00:00:00.000Z');
  assert.equal(activity.truncated, false);
  assert.deepEqual(requests.filter((r) => /\/issues\/\d+$/.test(r)), ['/repos/team/repo/issues/10', '/repos/team/repo/issues/11', '/repos/team/repo/issues/14']);
  assert.ok(requests.includes('/repos/team/repo/issues?state=closed&sort=updated&direction=desc&since=2026-10-10T00:00:00Z&per_page=100&page=1'));
  assert.ok(requests.includes('/repos/team/repo/actions/runs?actor=reader&status=success&created=%3E%3D2026-10-10T00%3A00%3A00Z&per_page=100&page=1'));
});

test('passed runs use creation time, including the boundary, even after a later start or rerun', async () => {
  const { views } = fixture(repo({
    pulls: { 'team/repo': [] },
    runs: [
      { id: 21, conclusion: 'success', actor: { id: 7 }, created_at: after, run_started_at: after, updated_at: after },
      { id: 22, conclusion: 'success', actor: { id: 7 }, created_at: from, run_started_at: after, updated_at: after },
      { id: 23, conclusion: 'success', actor: { id: 7 }, created_at: before, run_started_at: before, updated_at: after },
      { id: 24, conclusion: 'success', actor: { id: 7 }, created_at: before, run_started_at: after, updated_at: after },
      { id: 25, conclusion: 'success', actor: { id: 7 }, created_at: before, run_started_at: after, updated_at: after, run_attempt: 2 },
    ],
  }));
  const activity = await views.activity(7, 'team', 'repo', { from });
  assert.deepEqual(activity.passed.map((r) => [r.id, r.createdAt]), [
    [21, '2026-10-11T00:00:00.000Z'],
    [22, '2026-10-10T00:00:00.000Z'],
  ]);
  assert.equal(activity.truncated, false);
});

test('activity refreshes a renamed account before querying runs and still checks its numeric id', async () => {
  const runs = [
    { id: 21, conclusion: 'success', actor: { id: 7, login: 'renamed' }, created_at: after },
    { id: 22, conclusion: 'success', actor: { id: 8, login: 'renamed' }, created_at: after },
  ];
  const answer = (route) => {
    if (route === '/user') return { body: { id: 7, login: 'renamed' } };
    if (route.startsWith('/repos/team/repo/actions/runs?')) {
      const actor = new URL(route, 'https://api.github.com').searchParams.get('actor');
      return { body: { workflow_runs: runs.filter((r) => r.actor.login === actor) } };
    }
    return repo({ pulls: { 'team/repo': [] } })(route);
  };
  const { views, requests, account, saved, updates } = fixture(answer, { login: 'old-name' });
  const activity = await views.activity(7, 'team', 'repo', { from });
  assert.deepEqual(activity.passed.map((r) => r.id), [21]);
  assert.equal(requests[0], '/user');
  assert.ok(requests.includes('/repos/team/repo/actions/runs?actor=renamed&status=success&created=%3E%3D2026-10-10T00%3A00%3A00Z&per_page=100&page=1'));
  assert.equal(account.login, 'renamed');
  assert.deepEqual(saved, [{ id: 7, login: 'renamed' }]);
  assert.deepEqual(updates, ['renamed'], 'connected pages hear of the new name once it is saved');
  await views.activity(7, 'team', 'repo', { from });
  assert.deepEqual(updates, ['renamed'], 'an unchanged name is not announced');

  const unsaved = fixture(answer, { login: 'old-name', save() { throw new Error('disk full'); } });
  await assert.rejects(unsaved.views.activity(7, 'team', 'repo', { from }), /disk full/);
  assert.deepEqual(unsaved.updates, [], 'a name that was not saved is not announced');
});

test('activity reports refresh failures with the same errors as repository requests', async () => {
  for (const [failure, expected] of [
    [{ status: 502, code: 'github_error', github: 403, limited: true }, { status: 429, code: 'rate_limited' }],
    [{ status: 409, code: 'github_sign_in' }, { status: 409, code: 'github_sign_in' }],
    [{ status: 502, code: 'github_error', github: 403 }, { status: 403, code: 'forbidden' }],
    [{ status: 502, code: 'github_unreachable' }, { status: 502, code: 'github_unreachable' }],
  ]) {
    const { views, requests, updates } = fixture((route) => {
      if (route === '/user') throw Object.assign(new Error('Refresh failed'), failure);
      return repo({ pulls: { 'team/repo': [] } })(route);
    });
    await assert.rejects(views.activity(7, 'team', 'repo', { from }), expected);
    assert.deepEqual(requests, ['/user'], 'a failed refresh stops before repository requests');
    assert.deepEqual(updates, []);
  }
});

test('a fork counts what it merged into its parent, even asked by an old name, and paging stops at the time or the page cap', async () => {
  const fresh = Array.from({ length: 100 }, (_, i) => ({ number: 100 + i, user: { id: 8 }, merged_at: after, updated_at: after }));
  const { views, requests } = fixture(repo({
    metadata: { id: 99, full_name: 'team/renamed', fork: true, parent: { full_name: 'up/stream' } },
    pulls: {
      'team/repo': () => ({ body: fresh, link: next }),
      'up/stream': () => ({ link: next, body: [
        { number: 30, title: 'From the fork', user: { id: 7 }, merged_at: after, updated_at: after, head: { repo: { id: 99, full_name: 'team/renamed' } } },
        { number: 31, title: 'From elsewhere', user: { id: 7 }, merged_at: after, updated_at: after, head: { repo: { id: 98, full_name: 'team/repo' } } },
        { number: 32, title: 'Old', user: { id: 7 }, merged_at: before, updated_at: before },
      ] }),
    },
  }));
  const activity = await views.activity(7, 'team', 'repo', { from });
  assert.deepEqual(activity.merged.map((p) => [p.repo, p.number]), [['up/stream', 30]]);
  assert.equal(activity.truncated, true);
  assert.equal(requests.filter((r) => r.startsWith('/repos/team/repo/pulls')).length, 3);
  assert.equal(requests.filter((r) => r.startsWith('/repos/up/stream/pulls')).length, 1, 'an older pull request ends the listing');
});

test('a bad time asks GitHub nothing, turned-off issues and an unreadable parent leave the rest, and a rate limit fails the whole answer', async () => {
  const { views, requests } = fixture(repo());
  for (const bad of [undefined, '', 'yesterday', '1700000000', '2026-13-40T00:00:00Z']) {
    await assert.rejects(views.activity(7, 'team', 'repo', { from: bad }), { code: 'bad_since', status: 400 }, String(bad));
  }
  assert.equal(requests.length, 0);
  await assert.rejects(views.activity(8, 'team', 'repo', { from }), { code: 'unknown_account' });

  const partly = fixture((route) => {
    if (route.startsWith('/repos/team/repo/issues')) throw Object.assign(new Error('Issues are disabled'), { github: 410 });
    return repo({
      metadata: { fork: true, parent: { full_name: 'gone/away' } },
      pulls: { 'team/repo': [{ number: 1, title: 'Mine', user: { id: 7 }, merged_at: after, updated_at: after }] },
      runs: [{ id: 21, conclusion: 'success', actor: { id: 7 }, created_at: after }],
    })(route);
  });
  const activity = await partly.views.activity(7, 'team', 'repo', { from });
  assert.deepEqual([activity.merged.map((p) => p.number), activity.closed, activity.passed.map((r) => r.id)], [[1], [], [21]]);

  const limited = fixture((route) => {
    if (route.includes('/actions/runs')) throw Object.assign(new Error('rate limit'), { limited: true });
    return repo({ pulls: { 'team/repo': [] } })(route);
  });
  await assert.rejects(limited.views.activity(7, 'team', 'repo', { from }), { code: 'rate_limited' });
});
