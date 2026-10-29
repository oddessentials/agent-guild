import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { repoKey } from '../web/repo-search.js';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const fn = (name) => app.match(new RegExp(`^(?:async )?function ${name}\\([^]*?\\n\\}`, 'm'))?.[0] ?? assert.fail(`${name} is present`);
const line = (prefix) => app.match(new RegExp(`^${prefix} .*$`, 'm'))?.[0] ?? assert.fail(`${prefix} is present`);
const KEY = 'agentGuild.githubWatch';
const repo = { accountId: 1, login: 'alice', owner: 'team', name: 'project', fullName: 'team/project', private: true };
const other = { ...repo, name: 'other', fullName: 'team/other' };
const bob = { ...repo, accountId: 2, login: 'bob', owner: 'bob', name: 'thing', fullName: 'bob/thing' };
const run = (id, status = 'in_progress', conclusion = null, name = 'CI') => ({ id, name, title: `Run ${id}`, branch: 'main', status, conclusion, url: `https://github.com/team/project/actions/runs/${id}` });
const accounts = [{ id: 1, login: 'alice' }, { id: 2, login: 'bob', needsSignIn: true }];

function page({ store = new Map(), visible = true, shown = true } = {}) {
  const requests = [], calls = [], toasts = [], celebrations = [], timers = [], rendered = [];
  const toastEl = { hidden: true, node: null, contains: (node) => node === toastEl.node };
  const context = {
    repoKey,
    document: { visibilityState: visible ? 'visible' : 'hidden', createTextNode: (text) => ({ text }) },
    window: { open: (url) => calls.push(`open:${url}`) },
    state: { connected: true, github: { accounts }, sessions: new Map() },
    runWatch: { runs: new Map(), outcomes: [], failures: [], timer: 0, polling: null, told: null },
    yardUi: { celebrate: () => celebrations.push(1) },
    toast: (message, ms, action) => { toastEl.hidden = false; toastEl.node = message; toasts.push({ message: message.text, action }); },
    renderRunFailures: () => rendered.push([...context.runWatch.failures]),
    renderGitHubViews: () => calls.push('render'),
    setGitHub: (github) => { context.state.github = github; calls.push('accounts'); },
    showAuth: () => calls.push('auth'),
    AuthError: class extends Error {},
    api: (method, path) => new Promise((resolve, reject) => requests.push({ method, path, resolve, reject })),
    sessionStorage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) },
    setTimeout: (handler, ms) => timers.push({ handler, ms, cleared: false }),
    clearTimeout: (id) => { if (id) timers[id - 1].cleared = true; },
    githubPick: { repo: null, data: {}, issueState: 'open' }, loadBranches: () => {}, scheduleRuns: () => {},
  };
  context.$ = (id) => ({ app: { hidden: !shown }, toast: toastEl })[id];
  runInNewContext([
    "'use strict';", line('const RUNS_POLL_MS ='), line('const RUNS_IDLE_POLL_MS ='), line('const RUN_WATCH_KEY ='), line('const RUN_FAILURES ='),
    ...['usableGitHubAccounts', 'repoPath', 'runLabel', 'runWatchKey', 'saveRunWatch', 'loadRunWatch', 'watchedRun', 'toggleRunWatch', 'endWatch',
      'runWatchSeen', 'dropWatchAccounts', 'deliverRunWatch', 'dismissRunFailures', 'scheduleRunWatch', 'pollRunWatch', 'loadView'].map(fn),
  ].join('\n'), context);
  const live = () => timers.filter((t) => !t.cleared);
  const saved = () => JSON.parse(store.get(KEY) ?? 'null');
  return { ...context, requests, calls, toasts, celebrations, timers, rendered, store, live, saved, toastEl };
}

test('a watch is set, saved and restored, and polls on the page\'s visibility cadence', () => {
  const p = page();
  p.toggleRunWatch(repo, run(7));
  assert.equal(p.watchedRun(repo, 7), true);
  assert.equal(p.watchedRun(other, 7), false);
  assert.deepEqual(p.live().map((t) => t.ms), [6000]);
  p.document.visibilityState = 'hidden';
  p.scheduleRunWatch();
  assert.deepEqual(p.live().map((t) => t.ms), [30000]);

  const q = page({ store: p.store });
  q.loadRunWatch();
  assert.equal(q.watchedRun(repo, 7), true);
  assert.deepEqual(q.live().map((t) => t.ms), [6000]);

  const r = page();
  r.store.set(KEY, '{bad');
  r.loadRunWatch();
  assert.equal(r.runWatch.runs.size, 0);
  r.store.set(KEY, JSON.stringify({ watches: [{ id: 'x' }, { id: 3 }, null, { id: 4, repo: { accountId: 1, fullName: 'a/b' } }], outcomes: 'no', failures: [null] }));
  r.loadRunWatch();
  assert.equal(r.runWatch.runs.size, 1);
  assert.deepEqual([...r.runWatch.outcomes], []);
  assert.deepEqual([...r.runWatch.failures], []);

  p.toggleRunWatch(repo, run(7));
  assert.equal(p.watchedRun(repo, 7), false);
  assert.equal(p.store.has(KEY), false);
  assert.deepEqual(p.live(), []);
});

test('a run that passes is delivered as a toast and fireworks over the yard, once, and only to a visible page', () => {
  const p = page({ visible: false });
  p.toggleRunWatch(repo, run(7));
  p.runWatchSeen(repo, [run(7)]);
  p.runWatchSeen(other, [run(7, 'completed', 'success')]);
  assert.equal(p.watchedRun(repo, 7), true);
  p.runWatchSeen(repo, [run(8), run(7, 'completed', 'success')]);
  assert.equal(p.watchedRun(repo, 7), false);
  p.deliverRunWatch();
  assert.deepEqual(p.toasts, [], 'nothing is delivered while hidden');
  assert.equal(p.saved().outcomes.length, 1, 'the outcome waits in storage');
  p.document.visibilityState = 'visible';
  p.deliverRunWatch();
  assert.equal(p.toasts.length, 1);
  assert.equal(p.toasts[0].message, 'CI passed: Run 7');
  p.toasts[0].action.run();
  assert.ok(p.calls.includes('open:https://github.com/team/project/actions/runs/7'));
  assert.deepEqual([...p.celebrations], [1]);
  assert.equal(p.store.has(KEY), false);
  p.deliverRunWatch();
  assert.equal(p.toasts.length, 1);

  const q = page({ shown: false });
  q.toggleRunWatch(repo, run(1));
  q.runWatchSeen(repo, [run(1, 'completed', 'success')]);
  q.deliverRunWatch();
  assert.deepEqual(q.toasts, [], 'nothing is delivered on the sign-in screen');
  assert.equal(q.saved().outcomes.length, 1);
});

test('several outcomes arrive as one toast; failures join a banner list kept until dismissed', () => {
  const p = page();
  for (const id of [1, 2, 3, 4, 5]) p.toggleRunWatch(repo, run(id));
  p.runWatchSeen(repo, [run(1, 'completed', 'failure', 'Release'), run(2, 'completed', 'cancelled'), run(4, 'completed', 'timed_out'), run(5, 'completed', 'success')]);
  p.deliverRunWatch();
  assert.equal(p.toasts.length, 1);
  assert.equal(p.toasts[0].message, 'CI was cancelled: Run 2\nRun 3 is no longer among the latest runs of team/project.\nCI passed: Run 5');
  assert.equal(p.toasts[0].action, null, 'no single link for several outcomes');
  assert.deepEqual([...p.celebrations], [1]);
  assert.deepEqual(p.runWatch.failures.map((f) => [f.name, f.title, f.label, f.branch, f.repo]), [['CI', 'Run 1', 'failure', 'main', 'team/project'], ['CI', 'Run 4', 'timed out', 'main', 'team/project']]);
  assert.equal(p.saved().failures.length, 2, 'failures survive a reload');
  assert.equal(p.runWatch.runs.size, 0);
  assert.deepEqual(p.live(), []);

  const q = page({ store: p.store });
  q.loadRunWatch();
  assert.equal(q.rendered.at(-1).length, 2, 'a reloaded page shows the banner again');
  q.toggleRunWatch(repo, run(6));
  q.runWatchSeen(repo, [run(6, 'completed', 'failure')]);
  q.deliverRunWatch();
  assert.equal(q.runWatch.failures.length, 3, 'a later failure joins the list');
  q.dismissRunFailures();
  assert.equal(q.runWatch.failures.length, 0);
  assert.equal(q.store.has(KEY), false);
  assert.deepEqual(q.rendered.at(-1), []);
});

test('runs finishing in several repositories during one poll arrive as one toast and one show', async () => {
  const p = page();
  p.toggleRunWatch(repo, run(1));
  p.toggleRunWatch(other, run(2));
  const poll = p.pollRunWatch();
  assert.deepEqual(p.requests.map((r) => r.path), ['/github/accounts/1/repos/team/project/actions', '/github/accounts/1/repos/team/other/actions']);
  p.requests[0].resolve({ runs: [run(1, 'completed', 'success')] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(p.toasts, [], 'the first answer waits for the rest of the poll');
  p.requests[1].resolve({ runs: [run(2, 'completed', 'success')] });
  await poll;
  assert.deepEqual(p.toasts.map((t) => t.message), ['CI passed: Run 1\nCI passed: Run 2']);
  assert.deepEqual([...p.celebrations], [1]);
  assert.equal(p.store.has(KEY), false);
});

test('outcomes recorded while a poll is in flight, by the Actions panel or an account change, are delivered when it settles', async () => {
  const p = page();
  p.toggleRunWatch(repo, run(1));
  p.toggleRunWatch(other, run(2));
  const poll = p.pollRunWatch();
  p.runWatchSeen(repo, [run(1, 'completed', 'success')]);
  p.deliverRunWatch();
  assert.deepEqual(p.toasts, [], 'the panel refresh waits for the poll');
  p.requests[0].resolve({ runs: [run(1, 'completed', 'success')] });
  p.requests[1].resolve({ runs: [run(2, 'completed', 'success')] });
  await poll;
  assert.deepEqual(p.toasts.map((t) => t.message), ['CI passed: Run 1\nCI passed: Run 2']);
  assert.deepEqual([...p.celebrations], [1]);

  const q = page();
  q.state.github = { accounts: [{ id: 1, login: 'alice' }, { id: 2, login: 'bob' }] };
  q.toggleRunWatch(repo, run(1));
  q.toggleRunWatch(bob, run(2));
  const again = q.pollRunWatch();
  q.dropWatchAccounts([{ id: 2, login: 'bob' }]);
  assert.deepEqual(q.toasts, [], 'the sign-out waits for the poll');
  q.requests[0].resolve({ runs: [run(1, 'completed', 'success')] });
  q.requests[1].resolve({ runs: [run(2, 'completed', 'success')] });
  await again;
  assert.deepEqual(q.toasts.map((t) => t.message), ['Stopped watching Run 1: @alice was signed out.\nCI passed: Run 2']);
  assert.equal(q.store.has(KEY), false);
});

test('an outcome delivered while a watcher toast is still showing joins it instead of replacing it', () => {
  const p = page();
  p.toggleRunWatch(repo, run(1));
  p.toggleRunWatch(bob, run(2));
  p.toggleRunWatch(other, run(3));
  p.runWatchSeen(repo, [run(1, 'completed', 'success')]);
  p.deliverRunWatch();
  assert.equal(p.toasts.at(-1).message, 'CI passed: Run 1');
  assert.equal(p.toasts.at(-1).action.label, 'GitHub');
  p.dropWatchAccounts([{ id: 1, login: 'alice' }]);
  assert.equal(p.toasts.at(-1).message, 'CI passed: Run 1\nStopped watching Run 2: @bob was signed out.');
  assert.equal(p.toasts.at(-1).action, null);
  p.toastEl.hidden = true;
  p.runWatchSeen(other, [run(3, 'completed', 'cancelled')]);
  p.deliverRunWatch();
  assert.equal(p.toasts.at(-1).message, 'CI was cancelled: Run 3');
  p.toastEl.node = { text: 'another feature' };
  p.toggleRunWatch(other, run(4));
  p.runWatchSeen(other, [run(4, 'completed', 'success')]);
  p.deliverRunWatch();
  assert.equal(p.toasts.at(-1).message, 'CI passed: Run 4', 'a toast that another feature replaced is not extended');
  assert.equal(p.toasts.length, 4);
});

test('a signed-out account ends its watches with a word; an account needing sign-in keeps them waiting', () => {
  const p = page();
  p.toggleRunWatch(repo, run(1));
  p.toggleRunWatch(bob, run(2));
  p.dropWatchAccounts(accounts);
  assert.equal(p.runWatch.runs.size, 2);
  assert.deepEqual(p.toasts, []);
  p.dropWatchAccounts([{ id: 2, login: 'bob' }]);
  assert.equal(p.watchedRun(repo, 1), false);
  assert.equal(p.watchedRun(bob, 2), true);
  assert.equal(p.toasts[0].message, 'Stopped watching Run 1: @alice was signed out.');
});

test('the poll loads accounts when it has none, asks once per repository, skips accounts it cannot use, keeps a watch through an error, and stops when none is left', async () => {
  const p = page();
  p.state.github = null;
  p.toggleRunWatch(repo, run(1));
  p.toggleRunWatch(repo, run(2));
  p.toggleRunWatch(other, run(3));
  p.toggleRunWatch(bob, run(4));
  const poll = p.pollRunWatch();
  assert.equal(p.pollRunWatch(), poll);
  assert.deepEqual(p.live(), [], 'no timer while a poll is in flight');
  assert.deepEqual(p.requests.map((r) => r.path), ['/github']);
  p.requests[0].resolve({ github: { accounts } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(p.calls.includes('accounts'));
  assert.deepEqual(p.requests.slice(1).map((r) => r.path), ['/github/accounts/1/repos/team/project/actions', '/github/accounts/1/repos/team/other/actions']);
  p.requests[1].resolve({ runs: [run(1, 'completed', 'success'), run(2)] });
  p.requests[2].reject(new Error('Offline'));
  await poll;
  assert.deepEqual([1, 2, 3, 4].map((id) => p.watchedRun([repo, repo, other, bob][id - 1], id)), [false, true, true, true]);
  assert.deepEqual(p.live().map((t) => t.ms), [6000]);

  const again = p.pollRunWatch();
  assert.equal(p.requests.length, 5, 'accounts are not asked for again');
  p.requests[3].resolve({ runs: [run(2, 'completed', 'success')] });
  p.requests[4].reject(new p.AuthError('Sign in'));
  await again;
  assert.ok(p.calls.includes('auth'));
  assert.equal(p.watchedRun(other, 3), true);

  p.state.connected = false;
  const offline = p.pollRunWatch();
  assert.equal(p.requests.length, 5);
  await offline;
  assert.deepEqual(p.live().map((t) => t.ms), [6000]);

  p.toggleRunWatch(other, run(3));
  p.toggleRunWatch(bob, run(4));
  assert.equal(p.runWatch.runs.size, 0);
  assert.deepEqual(p.live(), []);
});

test('a response settles only the watches there were when its request began, from a poll or the Actions panel', async () => {
  const p = page();
  p.toggleRunWatch(repo, run(1));
  p.toggleRunWatch(repo, run(3));
  const poll = p.pollRunWatch();
  p.toggleRunWatch(repo, run(2));
  p.toggleRunWatch(repo, run(3));
  p.toggleRunWatch(repo, run(3));
  p.requests[0].resolve({ runs: [run(1, 'completed', 'success')] });
  await poll;
  assert.deepEqual(p.toasts.map((t) => t.message), ['CI passed: Run 1']);
  assert.deepEqual([p.watchedRun(repo, 2), p.watchedRun(repo, 3)], [true, true], 'a watch added, or added again, during the poll is not ended by it');

  const q = page();
  q.githubPick.repo = repo;
  q.toggleRunWatch(repo, run(1));
  const panel = q.loadView('actions');
  q.toggleRunWatch(repo, run(2));
  q.requests[0].resolve({ runs: [] });
  await panel;
  assert.deepEqual([q.watchedRun(repo, 1), q.watchedRun(repo, 2)], [false, true]);
  assert.deepEqual(q.toasts.map((t) => t.message), ['Run 1 is no longer among the latest runs of team/project.']);
});
