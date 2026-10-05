import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createViews } from '../src/manager/github-views.mjs';

function fixture(answer) {
  const requests = [];
  return { requests, views: createViews({
    account(id) { if (id !== 7) throw Object.assign(new Error('Sign in'), { code: 'unknown_account' }); return { id, login: 'reader' }; },
    async _apiJson(account, route) {
      requests.push({ account, route });
      const result = await answer(route);
      return { body: result.body, res: new Response('', { headers: result.link ? { Link: result.link } : {} }) };
    },
  }) };
}
const sha = 'a'.repeat(40);

test('branches read the default once, preserve names and use GitHub protection flags', async () => {
  const names = ['trunk', 'feat/a#b%&é', 'feature/' + 'long'.repeat(100)];
  const { views, requests } = fixture((route) => route.endsWith('/repo') ? { body: { default_branch: 'trunk' } }
    : { body: names.map((name, i) => ({ name, commit: { sha }, protected: i === 1 })) });
  const result = await views.branches(7, 'team', 'repo');
  assert.equal(result.defaultBranch, 'trunk');
  assert.equal(result.metadataError, null);
  assert.deepEqual(result.branches.map((b) => b.name), names);
  assert.deepEqual(result.branches.map((b) => b.protected), [false, true, false]);
  assert.equal(result.branches[1].url, 'https://github.com/team/repo/tree/feat%2Fa%23b%25%26%C3%A9');
  assert.equal(result.nextPage, null);
  assert.equal(requests.length, 2, 'one listing and one metadata request, no per-branch calls');
  assert.ok(requests.every((r) => r.account.id === 7));
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
});

test('pagination follows the next link even for short pages and ends only when it is absent', async () => {
  const { views, requests } = fixture((route) => {
    if (route.endsWith('/repo')) return { body: { default_branch: 'trunk' } };
    const page = Number(new URL(route, 'https://api.github.com').searchParams.get('page'));
    return { body: Array.from({ length: page === 1 ? 100 : page === 2 ? 1 : 100 }, (_, i) => ({ name: `${page}/${i}`, protected: false, commit: { sha } })),
      link: page < 3 ? `<https://api.github.com/repos/team/repo/branches?page=${page + 1}&per_page=100>; rel="next"` : null };
  });
  let page = 1, count = 0;
  do { const result = await views.branches(7, 'team', 'repo', { page }); count += result.branches.length; page = result.nextPage; } while (page !== null);
  assert.equal(count, 201);
  assert.equal(requests.filter((r) => r.route.endsWith('/repo')).length, 1);
  assert.equal(requests.filter((r) => r.route.includes('/branches?')).length, 3);
});

test('bad pagination cannot silently finish a list or turn a Link into an authenticated arbitrary request', async () => {
  for (const link of ['<https://evil.test/?page=1>; rel="next"', '<https://api.github.com/x>; rel="next"']) {
    const { views } = fixture((route) => ({ body: route.endsWith('/repo') ? {} : [], link }));
    await assert.rejects(views.branches(7, 'team', 'repo'), { code: 'github_error' });
  }
  const { views, requests } = fixture(() => ({ body: [] }));
  for (const page of ['', '0', '-1', '1.5', '01', '1e2', '9007199254740992', 'https://evil.test']) {
    await assert.rejects(views.branches(7, 'team', 'repo', { page }), { code: 'bad_page' });
  }
  assert.equal(requests.length, 0);
  await assert.rejects(views.branches(8, 'team', 'repo'), { code: 'unknown_account' });
  await assert.rejects(views.branches(7, '..', 'repo'), { code: 'bad_repo' });
});

test('empty repositories, failed metadata and upstream refusals remain distinct', async () => {
  const { views } = fixture((route) => {
    if (route.endsWith('/repo')) throw new Error('Metadata unavailable');
    return { body: [] };
  });
  const result = await views.branches(7, 'team', 'repo');
  assert.deepEqual(result.branches, []);
  assert.equal(result.nextPage, null);
  assert.equal(result.defaultBranch, null);
  assert.equal(result.metadataError, 'Metadata unavailable');
  for (const [failure, code] of [[{ github: 404 }, 'not_found'], [{ github: 403 }, 'forbidden'], [{ limited: true }, 'rate_limited']]) {
    const denied = fixture(() => { throw Object.assign(new Error('Refused'), failure); });
    await assert.rejects(denied.views.branches(7, 'team', 'repo'), { code });
  }
  const malformed = fixture(() => ({ body: {} }));
  await assert.rejects(malformed.views.branches(7, 'team', 'repo'), { code: 'github_error' });
});
