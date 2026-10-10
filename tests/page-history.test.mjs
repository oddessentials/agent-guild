import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryPreview } from '../web/history-preview.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const target = (id, accountId = 'default') => ({ providerId: 'google', accountId, id, title: id });
const detail = (text, nextCursor = null) => ({ messages: [{ role: 'assistant', text }], nextCursor, incomplete: false, omitted: false });
function page() {
  const requests = [];
  const preview = createHistoryPreview({
    read: (target, cursor) => new Promise((resolve, reject) => requests.push({ target, cursor, resolve, reject })),
    changed: () => {},
  });
  return { preview, requests };
}

test('a delayed selection or account reply cannot replace a newer conversation', async () => {
  const { preview, requests } = page();
  const old = preview.select(target('one'));
  const next = preview.select(target('two', 'work'));
  requests[1].resolve(detail('newest'));
  await next;
  requests[0].resolve(detail('stale'));
  await old;
  assert.equal(preview.state.messages[0].text, 'newest');
  assert.equal(preview.state.target.accountId, 'work');
});

test('closing then reopening invalidates outstanding preview requests and errors', async () => {
  const { preview, requests } = page();
  const pending = preview.select(target('one'));
  preview.clear();
  const reopened = preview.select(target('one'));
  requests[0].reject(new Error('old error'));
  await pending;
  assert.equal(preview.state.error, null);
  assert.equal(preview.state.loading, true);
  requests[1].resolve(detail('reopened'));
  await reopened;
  assert.equal(preview.state.messages[0].text, 'reopened');
});

test('paging appends once, ignores duplicate clicks and discards an old page after refresh', async () => {
  const { preview, requests } = page();
  const first = preview.select(target('one'));
  requests[0].resolve(detail('first', 'cursor1')); await first;
  const more = preview.more();
  await preview.more();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].cursor, 'cursor1');
  requests[1].resolve(detail('second', 'cursor2')); await more;
  assert.deepEqual(preview.state.messages.map((m) => m.text), ['first', 'second']);
  const stale = preview.more();
  const refresh = preview.refresh();
  requests[3].resolve(detail('refreshed')); await refresh;
  requests[2].resolve(detail('stale page')); await stale;
  assert.deepEqual(preview.state.messages.map((m) => m.text), ['refreshed']);
});

test('a changed transcript requires refresh; other page failures can retry the same cursor', async () => {
  const { preview, requests } = page();
  const first = preview.select(target('one'));
  requests[0].resolve(detail('first', 'cursor')); await first;
  const failed = preview.more(); requests[1].reject(new Error('unavailable')); await failed;
  assert.equal(preview.state.nextCursor, 'cursor');
  const retry = preview.more(); requests[2].reject(Object.assign(new Error('Refresh'), { code: 'history_changed' })); await retry;
  assert.equal(preview.state.nextCursor, null);
  assert.equal(preview.state.error, 'Refresh');
  const refresh = preview.refresh(); requests[3].resolve(detail('updated')); await refresh;
  assert.equal(preview.state.error, null);
});

// Exercise the real page functions with fixed data and explicit promise ordering.
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

function historyPage(provider) {
  const nodes = Object.fromEntries(['history-icon', 'history-title', 'history-filter', 'cwd', 'history-here', 'history-sub', 'history-note']
    .map((id) => [id, { value: '', checked: false, parentElement: {} }]));
  const sessions = Array.from({ length: 200 }, (_, i) => ({ id: `saved-${i}`, title: `Saved session ${i}`, cwd: '/work' }));
  const context = {
    $: (id) => nodes[id], historyProvider: () => provider,
    historyView: { accountId: 'default', snapshot: { sessions, total: 334 }, loading: false },
    paintProviderIcon: () => {}, renderHistorySubmit: () => {},
    renderHistoryRows: (provider, shown) => { context.shown = shown; },
  };
  for (const name of ['renderHistory', 'historyText', 'sameFolder']) {
    runInNewContext(app.match(new RegExp(`^function ${name}\\([^]*?\\n\\}`, 'm'))[0], context);
  }
  return { nodes, context };
}

test('history filtered on the page explains the loaded limit before, during and after filtering', () => {
  for (const historySource of ['claude', 'codex', 'grok', 'docker']) {
    const { nodes, context } = historyPage({ tool: historySource, historySource, historyDetails: false });
    const limit = 'Loaded the newest 200 of 334 sessions. Filtering searches these loaded sessions.';
    context.renderHistory();
    assert.equal(context.shown.length, 200);
    assert.equal(nodes['history-note'].textContent, limit, historySource);
    assert.equal(nodes['history-note'].hidden, false);
    nodes['history-filter'].value = 'Saved session 199';
    context.renderHistory();
    assert.equal(context.shown.length, 1);
    assert.equal(nodes['history-note'].textContent, limit);
    nodes['history-filter'].value = 'Saved session 333';
    context.renderHistory();
    assert.equal(context.shown.length, 0);
    assert.equal(nodes['history-note'].textContent, `No session matches the filter. ${limit}`);
    nodes['history-filter'].value = '';
    context.historyView.snapshot.total = 200;
    context.renderHistory();
    assert.equal(nodes['history-note'].textContent, '');
    assert.equal(nodes['history-note'].hidden, true);
  }
});

test('Google history offers narrowing only while the server-filtered results exceed the limit', () => {
  const { nodes, context } = historyPage({ tool: 'Antigravity CLI', historySource: 'antigravity', historyDetails: true });
  context.renderHistory();
  assert.equal(nodes['history-note'].textContent, 'Showing 200 of 334 sessions. Narrow the filter to find older conversations.');
  nodes['history-filter'].value = 'Saved session 333';
  context.historyView.snapshot = { sessions: [{ id: 'saved-333', title: 'Saved session 333', cwd: '/work' }], total: 1 };
  context.renderHistory();
  assert.equal(context.shown[0].id, 'saved-333');
  assert.equal(nodes['history-note'].textContent, '');
  assert.equal(nodes['history-note'].hidden, true);
});

test('Google empty history distinguishes active filters from an empty unfiltered history', () => {
  for (const { filter, cwd, checked, filtered } of [
    { filter: 'missing conversation', cwd: '', checked: false, filtered: true },
    { filter: '', cwd: '/other-project', checked: true, filtered: true },
    { filter: 'missing conversation', cwd: '', checked: true, filtered: true },
    { filter: '', cwd: '/other-project', checked: false, filtered: false },
    { filter: '', cwd: '', checked: true, filtered: false },
    { filter: '   ', cwd: '   ', checked: true, filtered: false },
  ]) {
    const { nodes, context } = historyPage({ tool: 'Antigravity CLI', historySource: 'antigravity', historyDetails: true });
    context.historyView.snapshot = { sessions: [], total: 0 };
    nodes['history-filter'].value = filter;
    nodes.cwd.value = cwd;
    nodes['history-here'].checked = checked;
    context.renderHistory();
    const scenario = JSON.stringify({ filter, cwd, checked });
    assert.equal(nodes['history-note'].textContent, filtered ? 'No session matches the filter.' : 'No Antigravity CLI sessions were found.', scenario);
    assert.equal(nodes['history-sub'].textContent, filtered ? 'no matching sessions' : 'no sessions found', scenario);
    assert.equal(nodes['history-note'].hidden, false);
  }
});

test('Google resume requires an explicit folder when unknown or ambiguous, and opens a running session directly', () => {
  let choice = null, running = null;
  const starts = [], opened = [], prompts = [];
  const context = {
    historyView: { accountId: 'work' },
    historyEntry: () => ({ workspaces: ['/one', '/two'] }),
    runningOn: () => running,
    prompt: (message, defaultValue) => { prompts.push({ message, defaultValue }); return choice; },
    $: () => ({ value: '/current' }),
    startSession: (provider, card, options) => starts.push(options),
    closeHistory: () => {}, openPanel: (id) => opened.push(id),
  };
  runInNewContext(app.match(/^function resumeFromHistory\([^]*?\n\}/m)[0], context);
  const provider = { id: 'google', historyDetails: true };
  context.resumeFromHistory(provider, 'saved', null);
  assert.equal(starts.length, 0, 'Cancel does not start anything');
  assert.match(prompts[0].message, /\/one\n\/two/);
  choice = '/chosen';
  context.resumeFromHistory(provider, 'saved', null);
  assert.equal(starts[0].cwd, '/chosen');
  assert.equal(starts[0].account, 'work');
  context.resumeFromHistory(provider, 'saved', '/saved');
  assert.equal(starts[1].cwd, '/saved');
  assert.equal(prompts.length, 2, 'a single saved folder needs no choice');
  running = { id: 'running' };
  context.resumeFromHistory(provider, 'saved', null);
  assert.deepEqual(opened, ['running']);
  assert.equal(starts.length, 2);
  assert.equal(prompts.length, 2);
});

test('a missing Google resume folder retries only with the chosen folder and releases pending state on Cancel', async () => {
  for (const choice of [null, '/chosen']) {
    const calls = [], prompts = [], opened = [];
    const context = {
      $: () => ({ value: '/current' }), CWD_KEY: 'cwd', save: () => {},
      sessionActionKey: () => 'action', pendingSessionActions: new Set(), refreshPendingActions: () => {},
      pickedShell: () => null, selectedAccount: () => ({ id: 'work' }),
      api: async (method, route, body) => {
        calls.push(body);
        if (calls.length === 1) throw Object.assign(new Error('Missing folder'), { code: 'bad_cwd' });
        return { session: { id: 'resumed', cwd: body.cwd } };
      },
      prompt: (message, defaultValue) => { prompts.push({ message, defaultValue }); return choice; },
      upsertSession: () => {}, rememberRecent: () => {}, closeHistory: () => {},
      openPanel: (id) => opened.push(id), AuthError: class extends Error {},
      showAuth: () => assert.fail('unexpected auth error'), toast: () => assert.fail('unexpected automatic fallback'),
    };
    runInNewContext(app.match(/^async function startSession\([^]*?\n\}/m)[0], context);
    await context.startSession({ id: 'google', historyDetails: true }, null, { resume: 'saved', cwd: '/gone' });
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].defaultValue, '/current');
    assert.equal(calls.length, choice ? 2 : 1);
    if (choice) {
      assert.equal(calls[1].cwd, '/chosen');
      assert.equal(calls[1].resume, 'saved');
      assert.equal(calls[1].account, 'work');
    }
    assert.deepEqual(opened, choice ? ['resumed'] : []);
    assert.equal(context.pendingSessionActions.size, 0);
  }
});

test('history list changes supersede both old success and old failure responses', async () => {
  const requests = [];
  const nodes = { 'history-here': { checked: true }, cwd: { value: '/work/first' }, 'history-filter': { value: '' } };
  const context = {
    URLSearchParams, HISTORY_LIMIT: 200,
    historyView: { providerId: 'google', accountId: 'default', request: 0 },
    historyProvider: () => ({ historyDetails: true }),
    $: (id) => nodes[id], renderHistory: () => {},
    AuthError: class extends Error {}, showAuth: () => assert.fail('stale request must not change authentication'),
    api: (method, url) => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
  };
  runInNewContext(app.match(/^async function loadHistory\([^]*?\n\}/m)[0], context);
  const first = context.loadHistory();
  nodes.cwd.value = '/work/second';
  const second = context.loadHistory();
  assert.equal(new URL('http://localhost' + requests[1].url).searchParams.get('cwd'), '/work/second');
  requests[1].resolve({ history: { sessions: ['second'] } }); await second;
  requests[0].resolve({ history: { sessions: ['first'] } }); await first;
  assert.deepEqual(context.historyView.snapshot.sessions, ['second']);
  const old = context.loadHistory();
  const current = context.loadHistory();
  requests[2].reject(new context.AuthError()); await old;
  assert.equal(context.historyView.loading, true);
  requests[3].resolve({ history: { sessions: ['current'] } }); await current;
  assert.deepEqual(context.historyView.snapshot.sessions, ['current']);
});
