import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { repoKey } from '../web/repo-search.js';

// Run the page's actual request handlers; delayed answers exercise lifecycle
// behavior that cannot be established by checking repository names alone.
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`^(?:async )?function ${name}\\([^]*?\\n\\}`, 'm'))?.[0]
  ?? assert.fail(`${name} is present`);
const repo = { accountId: 1, login: 'alice', fullName: 'team/project', owner: 'team', name: 'project' };

function page() {
  const requests = [], calls = [];
  const context = {
    TextEncoder, repoKey,
    visibility: { shown: true }, document: { visibilityState: 'visible' },
    githubView: {}, githubAccount: () => null, selectGitHubAccount: () => {},
    renderGitHub: () => {}, ensureRepos: () => {},
    githubShownView: () => 'branches',
    state: { github: { accounts: [{ id: 1, login: 'alice' }] } },
    githubPick: { repo, data: {}, issueState: 'open', listFor: null, loadingFor: null },
    AuthError: class extends Error {},
    api: (method, path) => new Promise((resolve, reject) => requests.push({ method, path, resolve, reject })),
    renderGitHubViews: () => calls.push('render'),
    restorePick: () => calls.push('restore'), followTerminal: () => calls.push('follow'),
    scheduleRuns: () => calls.push('schedule'), showAuth: () => calls.push('auth'),
  };
  context.dockShows = () => context.visibility.shown;
  const constants = ['BODY_LIMIT', 'GITHUB_REQUEST_LIMIT'].map((name) => app.match(new RegExp(`^const ${name} = .*$`, 'm'))[0]);
  runInNewContext([
    "'use strict';", ...constants, 'let reposRequest = null;',
    ...['issuePayloadError', 'repoPath', 'usableGitHubAccounts', 'githubAccountsStamp', 'ensureAllRepos', 'loadAllRepos', 'loadView', 'viewData', 'branchesCurrent', 'branchesVisible', 'loadBranches', 'setGitHub'].map(fn),
  ].join('\n'), context);
  return { ...context, requests, calls };
}

test('issue validation accounts for the encoded request size, including Unicode and escaping', () => {
  const p = page();
  assert.equal(p.issuePayloadError({ title: 'x'.repeat(256), body: 'x'.repeat(48000) }), null);
  assert.match(p.issuePayloadError({ title: 'x'.repeat(257) }), /256/);
  assert.match(p.issuePayloadError({ title: ' ' }), /Enter a title/);
  assert.match(p.issuePayloadError({ body: 'x'.repeat(48001) }), /48,000/);
  for (const body of ['漢'.repeat(24000), '\\'.repeat(40000), '\n'.repeat(40000)]) {
    assert.match(p.issuePayloadError({ body }), /too large to send/);
  }
  assert.equal(p.issuePayloadError({ title: 'Rename without sending the existing oversized body' }), null);
  assert.equal(p.issuePayloadError({ state: 'closed' }), null);
  assert.equal(p.issuePayloadError({ body: '' }), null);
});

test('the latest view request wins even after returning to the same repository and filter', async () => {
  const p = page();
  const first = p.loadView('issues');
  p.githubPick.data = {}; // Pick another repository and come back.
  const second = p.loadView('issues');
  const latest = { issues: [{ number: 2, title: 'Current' }] };
  p.requests[1].resolve(latest);
  await second;
  p.requests[0].resolve({ issues: [{ number: 1, title: 'Old' }] });
  await first;
  assert.equal(p.githubPick.data.issues.value, latest);
  const third = p.loadView('issues');
  const fourth = p.loadView('issues');
  p.requests[3].resolve(latest);
  await fourth;
  p.requests[2].reject(new Error('An old request failed'));
  await third;
  assert.equal(p.githubPick.data.issues.error, null);
});

test('repository answers from an earlier sign-in cannot restore removed accounts or replace a newer list', async () => {
  const p = page();
  const draft = p.githubPick.editing = { target: 'new' };
  const old = p.loadAllRepos();
  p.state.github.accounts = [];
  p.ensureAllRepos();
  p.requests[0].resolve({ repos: [repo] });
  await old;
  assert.equal(p.githubPick.list, null);
  assert.equal(p.githubPick.editing, draft);
  assert.equal(p.calls.includes('restore'), false);
  p.state.github.accounts = [{ id: 1 }];
  const first = p.loadAllRepos();
  const second = p.loadAllRepos({ refresh: true });
  const latest = { repos: [] };
  p.requests[2].resolve(latest);
  await second;
  p.requests[1].resolve({ repos: [repo] });
  await first;
  assert.equal(p.githubPick.list, latest);
  assert.equal(p.githubPick.loadingFor, null);
});

const branchPage = (names, nextPage = null) => ({ branches: names.map((name) => ({ name, sha: 'a'.repeat(40), protected: false })), nextPage,
  defaultBranch: 'trunk', metadataError: null, url: 'https://github.com/team/project/branches', fetchedAt: '2026-10-01T00:00:00Z' });
const turn = () => new Promise((resolve) => setImmediate(resolve));

test('branches load all pages, including empty intermediate pages, deduplicate and retain the default', async () => {
  const p = page();
  const done = p.loadView('branches');
  p.requests[0].resolve(branchPage(Array.from({ length: 100 }, (_, i) => `branch-${i}`), 2));
  await turn();
  assert.equal(p.githubPick.data.branches.value.branches.length, 100);
  p.requests[1].resolve({ ...branchPage([], 3), defaultBranch: null });
  await turn();
  p.requests[2].resolve({ ...branchPage(['branch-0', ...Array.from({ length: 101 }, (_, i) => `other-${i}`)]), defaultBranch: null });
  await done;
  assert.equal(p.githubPick.data.branches.value.branches.length, 201);
  assert.equal(p.githubPick.data.branches.value.defaultBranch, 'trunk');
  assert.equal(p.githubPick.data.branches.nextPage, null);
  assert.equal(p.githubPick.data.branches.loading, false);
  assert.match(p.requests[2].path, /page=3$/);
});

test('a later page can retry in place; failed refresh retains results and a successful refresh removes deleted branches', async () => {
  const p = page();
  const first = p.loadView('branches');
  p.requests[0].resolve(branchPage(['old'], 2));
  await turn();
  p.requests[1].reject(new Error('Rate limited'));
  await first;
  assert.equal(p.githubPick.data.branches.error, 'Rate limited');
  assert.equal(p.githubPick.data.branches.nextPage, 2);
  const retry = p.loadBranches({ resume: true });
  assert.match(p.requests[2].path, /page=2$/);
  p.requests[2].resolve(branchPage(['keep']));
  await retry;
  const refresh = p.loadView('branches');
  p.requests[3].reject(new Error('Offline'));
  await refresh;
  assert.deepEqual(Array.from(p.githubPick.data.branches.value.branches, (b) => b.name), ['old', 'keep']);
  const again = p.loadBranches({ resume: true });
  assert.match(p.requests[4].path, /page=1$/);
  p.requests[4].resolve(branchPage(['keep']));
  await again;
  assert.deepEqual(Array.from(p.githubPick.data.branches.value.branches, (b) => b.name), ['keep']);
});

test('late branch pages and failures cannot populate another repository, account, or a newer refresh', async () => {
  for (const change of ['repository', 'account', 'refresh']) {
    const p = page();
    p.state.github.accounts.push({ id: 2, login: 'bob' });
    const old = p.loadView('branches');
    p.requests[0].resolve(branchPage(['old'], 2));
    await turn();
    if (change === 'repository') p.githubPick.repo = { ...repo, name: 'other', fullName: 'team/other' };
    if (change === 'account') p.githubPick.repo = { ...repo, accountId: 2, login: 'bob' };
    const newer = p.loadView('branches');
    p.requests[2].resolve(branchPage(['current']));
    await newer;
    p.requests[1].resolve(branchPage(['stale']));
    await old;
    assert.deepEqual(Array.from(p.githubPick.data.branches.value.branches, (b) => b.name), ['current'], change);
    assert.equal(p.githubPick.data.branches.error, null);
  }
  const p = page();
  const old = p.loadView('branches');
  p.githubPick.data = {}; // Leave and return to exactly the same account/repository.
  const fresh = p.loadView('branches');
  p.requests[1].resolve(branchPage(['new']));
  await fresh;
  p.requests[0].reject(new Error('Old failure'));
  await old;
  assert.equal(p.githubPick.data.branches.error, null);
});

test('a removed or expired account invalidates pending branches even if the same account signs in again', async () => {
  for (const accounts of [[], [{ id: 1, login: 'alice', needsSignIn: true }]]) {
    const p = page();
    const old = p.loadView('branches');
    p.visibility.shown = false;
    p.setGitHub({ accounts });
    p.setGitHub({ accounts: [{ id: 1, login: 'alice' }] });
    p.requests[0].resolve(branchPage(['stale']));
    await old;
    assert.equal(p.githubPick.data.branches.value, null);
    assert.equal(p.githubPick.data.branches.loading, false);
  }
});

test('background branches stop requesting pages, then resume at the next page when visible', async () => {
  const p = page();
  const first = p.loadView('branches');
  p.visibility.shown = false;
  p.requests[0].resolve(branchPage(['first'], 2));
  await first;
  assert.equal(p.requests.length, 1);
  assert.equal(p.githubPick.data.branches.nextPage, 2);
  p.visibility.shown = true;
  const resumed = p.loadBranches({ resume: true });
  const duplicate = p.loadBranches({ resume: true });
  assert.equal(p.requests.length, 2, 'only one page request in flight per listing');
  p.requests[1].resolve(branchPage(['second']));
  await Promise.all([resumed, duplicate]);
  assert.equal(p.githubPick.data.branches.value.branches.length, 2);
});
