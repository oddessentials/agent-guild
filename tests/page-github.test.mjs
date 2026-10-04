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
    state: { github: { accounts: [{ id: 1, login: 'alice' }] } },
    githubPick: { repo, data: {}, issueState: 'open', listFor: null, loadingFor: null },
    AuthError: class extends Error {},
    api: (method, path) => new Promise((resolve, reject) => requests.push({ method, path, resolve, reject })),
    renderGitHubViews: () => calls.push('render'),
    restorePick: () => calls.push('restore'), followTerminal: () => calls.push('follow'),
    scheduleRuns: () => calls.push('schedule'), showAuth: () => calls.push('auth'),
  };
  const constants = ['BODY_LIMIT', 'GITHUB_REQUEST_LIMIT'].map((name) => app.match(new RegExp(`^const ${name} = .*$`, 'm'))[0]);
  runInNewContext([
    "'use strict';", ...constants, 'let reposRequest = null;',
    ...['issuePayloadError', 'repoPath', 'usableGitHubAccounts', 'githubAccountsStamp', 'ensureAllRepos', 'loadAllRepos', 'loadView'].map(fn),
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
