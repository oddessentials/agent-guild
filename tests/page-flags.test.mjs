import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const source = [
  'var flagLists = new Map();',
  'var flagsView = { providerId: null };',
  ...['el', 'button', 'flagPicks', 'refreshFlagCards', 'setFlagPicks', 'setFlagPick', 'loadFlags', 'flagText', 'riskyFlag', 'offersFlag', 'currentFlags',
    'unavailableReason', 'unavailableReasons', 'flagProblem', 'flagArgs', 'launchArgs', 'renderLaunchFlags', 'flagRow', 'shellWord', 'renderFlagsCommand',
    'renderFlagsDialog', 'sessionActionKey', 'startSession', 'resumeCard', 'resumeFromHistory'].map((name) => {
    const found = app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
    assert.ok(found, `${name} is present in app.js`);
    return found;
  }),
].join('\n');

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.hidden = false;
    this.className = '';
    this.id = '';
    this.text = '';
    const classes = new Set();
    this.classList = { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: (name) => classes.has(name) };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.text = ''; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  click() { for (const listener of this.listeners.click ?? []) listener({}); }
  focus() {}
  get textContent() { return this.text || this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
}

const all = (node) => [node, ...(node.children ?? []).filter((c) => typeof c !== 'string').flatMap(all)];

const provider = {
  id: 'anthropic', tool: 'Claude Code', command: 'claude', args: [], available: true, accounts: [{ id: 'default' }], launchFlagsEquals: true,
  launchFlags: [{ flag: '--model', risky: false }, { flag: '--dangerously-skip-permissions', risky: true }, { flag: '--worktree', risky: false }, { flag: '--effort', risky: false }],
};
const OFFERED = [
  { flag: '--model', value: 'required', placeholder: '<model>', about: 'Model' },
  { flag: '--dangerously-skip-permissions', value: 'none', placeholder: '', about: 'Bypass', risky: true },
  { flag: '--worktree', value: 'optional', placeholder: '[name]', about: 'Worktree' },
  { flag: '--effort', value: 'required', placeholder: '<level>', about: 'Effort' },
];

function page({ saved = {}, flags = { flags: OFFERED, error: null }, current = provider } = {}) {
  const storage = new Map([['agentGuild.flags', JSON.stringify(saved)]]);
  const requests = [];
  const toasts = [];
  const label = new FakeElement('span');
  const summary = new FakeElement('span');
  const line = Object.assign(new FakeElement('button'), { querySelector: (selector) => (selector === '.launch-flags-label' ? label : summary) });
  const card = { dataset: { id: current.id }, querySelector: () => line };
  const elements = new Map();
  const $ = (id) => {
    if (id === 'cwd') return { value: '/work/project' };
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  const session = { provider: { id: current.id }, account: { id: 'default' }, cwd: '/work/old', toolSessionId: 'tool-1' };
  const context = {
    state: { flagPicks: JSON.parse(storage.get('agentGuild.flags')), providers: [current], sessions: new Map([['card-1', session]]) },
    FLAGS_KEY: 'agentGuild.flags', CWD_KEY: 'agentGuild.cwd',
    save: (key, value) => storage.set(key, value),
    pendingSessionActions: new Set(),
    refreshPendingActions() {},
    document: { querySelectorAll: () => [card], createElement: (tag) => new FakeElement(tag) },
    paintProviderIcon() {}, closeFlags() {},
    selectedAccount: () => ({ id: 'default' }),
    pickedShell: () => null,
    $,
    api: async (method, route, body) => {
      if (route === `/providers/${current.id}/flags`) {
        requests.push({ method, route });
        return JSON.parse(JSON.stringify(flags));
      }
      requests.push({ method, route, body: JSON.parse(JSON.stringify(body)) });
      return { session: { id: 'new-session', cwd: body.cwd } };
    },
    upsertSession() {}, rememberRecent() {}, closeHistory() {}, openPanel() {},
    reattachable: () => false, resumable: () => true, toolSessionId: (s) => s.toolSessionId, cards: new Map(),
    runningOn: () => null, historyView: { accountId: 'default' }, historyEntry: () => null,
    AuthError: class extends Error {},
    toast(message) { toasts.push(message); },
  };
  runInNewContext(source, context);
  const starts = () => requests.filter((r) => r.route === '/sessions');
  const helpReads = () => requests.filter((r) => r.route.endsWith('/flags')).length;
  return { context, storage, requests, starts, helpReads, toasts, line, label, summary, card, $ };
}

test('picked flags reach every start: New, a card\'s Resume and Existing…', async () => {
  const p = page({ saved: { anthropic: { '--effort': 'max', '--dangerously-skip-permissions': '', '--worktree': 'feat', '--model': 'opus' } } });
  await p.context.startSession(provider, null);
  p.context.resumeCard('card-1');
  await new Promise((resolve) => setImmediate(resolve));
  await p.context.resumeFromHistory(provider, 'tool-2', '/work/other');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(p.toasts, []);
  const args = ['--model', 'opus', '--dangerously-skip-permissions', '--worktree=feat', '--effort', 'max'];
  assert.deepEqual(p.starts().map((r) => r.body), [
    { providerId: 'anthropic', account: 'default', cwd: '/work/project', cols: 120, rows: 32, args },
    { providerId: 'anthropic', account: 'default', cwd: '/work/old', cols: 120, rows: 32, resume: 'tool-1', args },
    { providerId: 'anthropic', account: 'default', cwd: '/work/other', cols: 120, rows: 32, resume: 'tool-2', args },
  ]);
});

test('no picks send no args and read no help', async () => {
  const p = page();
  await p.context.startSession(provider, null);
  assert.deepEqual(p.requests.map((r) => r.route), ['/sessions']);
  assert.equal(Object.hasOwn(p.starts()[0].body, 'args'), false);
});

test('an optional value left empty sends the bare flag', async () => {
  const p = page({ saved: { anthropic: { '--worktree': '' } } });
  await p.context.startSession(provider, null);
  assert.deepEqual(p.starts()[0].body.args, ['--worktree']);
});

test('a flag the help no longer lists keeps its pick and stops the start, saying why', async () => {
  const current = { ...provider, launchFlags: [...provider.launchFlags, { flag: '--bg', risky: false }] };
  const saved = { anthropic: { '--effort': 'max', '--bg': '' } };
  const p = page({ saved, current });
  await p.context.startSession(current, null);
  p.context.resumeCard('card-1');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(p.starts(), []);
  assert.equal(p.toasts.length, 2);
  assert.equal(p.toasts[0], 'Claude Code\'s help no longer lists --bg. The session was not started; remove that flag under Flags to start without it.');
  assert.deepEqual(JSON.parse(p.storage.get('agentGuild.flags')), saved);
  p.context.renderLaunchFlags(p.card, current);
  assert.equal(p.summary.textContent, '--effort max · --bg');
  assert.ok(p.line.classList.contains('missing'));
  assert.equal(p.line.title, 'Claude Code\'s help no longer lists --bg. Sessions do not start until it is removed.');
});

test('a help that cannot be read keeps every pick and stops the start with the reason', async () => {
  const saved = { anthropic: { '--effort': 'max' } };
  const p = page({ saved, flags: { flags: [], error: 'Could not read Claude Code\'s help: it took longer than 10 seconds' } });
  await p.context.startSession(provider, null);
  assert.deepEqual(p.starts(), []);
  assert.match(p.toasts[0], /^Could not read Claude Code's help: it took longer than 10 seconds The session was not started/);
  assert.deepEqual(JSON.parse(p.storage.get('agentGuild.flags')), saved);
});

test('a flag that needs a value does not start without one', async () => {
  const p = page({ saved: { anthropic: { '--effort': '' } } });
  await p.context.startSession(provider, null);
  assert.deepEqual(p.starts(), []);
  assert.match(p.toasts[0], /^--effort needs a value\. Change it under Flags, or remove the flag\.$/);
});

test('the card line summarises the picks, warns about a risky one, and hides without flags', () => {
  const p = page({ saved: { anthropic: { '--effort': 'max', '--model': 'opus' } } });
  p.context.renderLaunchFlags(p.card, provider);
  assert.equal(p.line.hidden, false);
  assert.deepEqual([p.label.textContent, p.summary.textContent], ['Flags · 2', '--model opus · --effort max']);
  assert.ok(p.line.classList.contains('picked'));
  assert.ok(!p.line.classList.contains('risky'));
  p.context.setFlagPick(provider, '--dangerously-skip-permissions', '');
  assert.ok(p.line.classList.contains('risky'));
  assert.equal(p.line.attributes['aria-label'], 'Claude Code launch flags: --model opus · --dangerously-skip-permissions · --effort max, one skips approvals', 'in the provider\'s order');
  p.context.setFlagPicks(provider, {});
  assert.deepEqual(JSON.parse(p.storage.get('agentGuild.flags')), {});
  assert.deepEqual([p.label.textContent, p.summary.textContent, p.line.classList.contains('picked')], ['Add launch flags', '', false]);
  p.context.renderLaunchFlags(p.card, { ...provider, launchFlags: [] });
  assert.equal(p.line.hidden, true);
});

test('a value starting with "-" is joined to its flag only for a tool known to read --flag=value', async () => {
  const p = page({ saved: { anthropic: { '--effort': '-x', '--model': 'opus' } } });
  await p.context.startSession(provider, null);
  assert.deepEqual(p.starts()[0].body.args, ['--model', 'opus', '--effort=-x']);

  const unconfirmed = { ...provider, launchFlagsEquals: false };
  const q = page({ saved: { anthropic: { '--effort': '-x' } } });
  await q.context.startSession(unconfirmed, null);
  assert.deepEqual(q.starts(), []);
  assert.equal(q.toasts[0], 'Agent Guild cannot pass a value starting with "-" to --effort: Claude Code could read it as another flag. Change it under Flags, or remove the flag.');

  const r = page({ saved: { anthropic: { '--worktree': 'feat' } } });
  await r.context.startSession(unconfirmed, null);
  assert.deepEqual(r.starts(), []);
  assert.match(r.toasts[0], /^Agent Guild cannot pass a value to --worktree: it has not confirmed that Claude Code reads --worktree=value\./);

  const bare = page({ saved: { anthropic: { '--worktree': '', '--effort': 'max' } } });
  await bare.context.startSession(unconfirmed, null);
  assert.deepEqual(bare.starts()[0].body.args, ['--worktree', '--effort', 'max']);
});

test('a flag dropped from launchFlags is reported as no longer offered, before and without any help read', async () => {
  const current = { ...provider, launchFlags: provider.launchFlags.filter((f) => f.flag !== '--model') };
  const saved = { anthropic: { '--model': 'opus' } };
  const p = page({ saved, current });
  await p.context.startSession(current, null);
  assert.deepEqual(p.starts(), []);
  assert.equal(p.helpReads(), 0, 'the configured list decides first');
  const reason = 'Agent Guild no longer offers --model for Claude Code.';
  assert.equal(p.toasts[0], `${reason} The session was not started; remove that flag under Flags to start without it.`);
  p.context.renderLaunchFlags(p.card, current);
  assert.equal(p.line.title, `${reason} Sessions do not start until it is removed.`);
});

test('saved picks stay reachable when the tool offers no flags or is not installed; with nothing picked the line hides', async () => {
  const empty = { ...provider, launchFlags: [] };
  const p = page({ saved: { anthropic: { '--effort': 'max' } }, current: empty });
  p.context.renderLaunchFlags(p.card, empty);
  assert.equal(p.line.hidden, false);
  assert.ok(p.line.classList.contains('missing'));
  assert.equal(p.line.title, 'Agent Guild no longer offers --effort for Claude Code. Sessions do not start until it is removed.');
  await p.context.startSession(empty, null);
  assert.deepEqual([p.starts(), p.helpReads()], [[], 0]);

  const missing = { ...provider, available: false };
  const q = page({ saved: { anthropic: { '--effort': 'max' } }, current: missing, flags: { flags: [], error: 'Claude Code is not installed.' } });
  q.context.renderLaunchFlags(q.card, missing);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(q.line.hidden, false);
  assert.equal(q.line.title, 'Claude Code is not installed. Sessions do not start until it is removed.');

  p.context.flagsView.providerId = empty.id;
  p.context.renderFlagsDialog();
  assert.equal(p.$('flags-status').textContent, 'Agent Guild offers no flags for Claude Code.');
  assert.equal(p.$('flags-sub').textContent, 'Remove the flags saved for Claude Code; it offers none now.');
  assert.equal(p.$('flags-command').hidden, true);
  all(p.$('flags-list').children[0]).find((node) => node.textContent === 'Remove').click();
  assert.deepEqual(JSON.parse(p.storage.get('agentGuild.flags')), {});
  assert.equal(p.line.hidden, true, 'the line goes once nothing is picked');

  for (const current of [empty, missing]) {
    const r = page({ current });
    r.context.renderLaunchFlags(r.card, current);
    assert.equal(r.line.hidden, true);
  }
});

test('the dialog lets a stale pick be removed, keeps the removal, and the next start succeeds', async () => {
  const current = { ...provider, launchFlags: provider.launchFlags.filter((f) => f.flag !== '--worktree') };
  const p = page({ saved: { anthropic: { '--effort': 'max', '--worktree': 'feat', '--model': 'opus' } }, current });
  p.context.flagsView.providerId = current.id;
  await p.context.loadFlags(current);
  const rows = () => p.$('flags-list').children;
  assert.deepEqual(rows().map((row) => row.dataset.flag), ['--model', '--dangerously-skip-permissions', '--effort', '--worktree'], 'help that still lists --worktree cannot bring it back');
  const stale = rows().find((row) => row.dataset.flag === '--worktree');
  assert.ok(stale.className.includes('missing'));
  assert.match(stale.textContent, /Agent Guild no longer offers --worktree for Claude Code\. Sessions do not start while it is picked\./);
  assert.equal(p.$('flags-command').textContent, 'claude --model opus --effort max');

  await p.context.startSession(current, null);
  assert.deepEqual(p.starts(), []);

  all(stale).find((node) => node.tagName === 'BUTTON' && node.textContent === 'Remove').click();
  assert.deepEqual(JSON.parse(p.storage.get('agentGuild.flags')), { anthropic: { '--effort': 'max', '--model': 'opus' } });
  assert.ok(!rows().some((row) => row.dataset.flag === '--worktree'));
  assert.equal(p.line.classList.contains('missing'), false);

  await p.context.startSession(current, null);
  assert.deepEqual(p.starts().map((r) => r.body.args), [['--model', 'opus', '--effort', 'max']]);
});
