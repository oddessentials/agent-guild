import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const source = [
  'const flagLists = new Map();',
  'const flagsView = { providerId: null };',
  ...['flagPicks', 'refreshFlagCards', 'setFlagPicks', 'setFlagPick', 'loadFlags', 'flagText', 'riskyFlag', 'flagArgs', 'launchArgs', 'renderLaunchFlags', 'sessionActionKey', 'startSession', 'resumeCard', 'resumeFromHistory'].map((name) => {
    const found = app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
    assert.ok(found, `${name} is present in app.js`);
    return found;
  }),
].join('\n');

const provider = {
  id: 'anthropic', tool: 'Claude Code', available: true, accounts: [{ id: 'default' }],
  launchFlags: [{ flag: '--model', risky: false }, { flag: '--dangerously-skip-permissions', risky: true }, { flag: '--worktree', risky: false }, { flag: '--effort', risky: false }],
};
const OFFERED = [
  { flag: '--model', value: 'required', about: 'Model' },
  { flag: '--dangerously-skip-permissions', value: 'none', about: 'Bypass' },
  { flag: '--worktree', value: 'optional', about: 'Worktree' },
  { flag: '--effort', value: 'required', about: 'Effort' },
];

function page({ saved = {}, flags = { flags: OFFERED, error: null } } = {}) {
  const storage = new Map([['agentGuild.flags', JSON.stringify(saved)]]);
  const requests = [];
  const toasts = [];
  const nodes = () => ({
    hidden: false, children: [], dataset: {}, attributes: {}, classList: { toggle() {} },
    replaceChildren(...children) { this.children = children; },
    setAttribute(key, value) { this.attributes[key] = value; },
  });
  const label = nodes();
  const summary = nodes();
  const classes = new Set();
  const line = { ...nodes(), classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: (name) => classes.has(name) },
    querySelector: (selector) => (selector === '.launch-flags-label' ? label : summary) };
  const card = { dataset: { id: provider.id }, querySelector: () => line };
  const session = { provider: { id: provider.id }, account: { id: 'default' }, cwd: '/work/old', toolSessionId: 'tool-1' };
  const context = {
    state: { flagPicks: JSON.parse(storage.get('agentGuild.flags')), providers: [provider], sessions: new Map([['card-1', session]]) },
    FLAGS_KEY: 'agentGuild.flags', CWD_KEY: 'agentGuild.cwd',
    save: (key, value) => storage.set(key, value),
    pendingSessionActions: new Set(),
    refreshPendingActions() {},
    document: { querySelectorAll: () => [card] },
    button: (label, onClick, className) => ({ ...nodes(), label, onClick, className, click: onClick }),
    renderFlagsDialog() {},
    renderFlagsCommand() {},
    selectedAccount: () => ({ id: 'default' }),
    pickedShell: () => null,
    $: () => ({ value: '/work/project' }),
    api: async (method, route, body) => {
      if (route === `/providers/${provider.id}/flags`) {
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
  return { context, storage, requests, starts, toasts, line, label, summary, card };
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
  const saved = { anthropic: { '--effort': 'max', '--bg': '' } };
  const p = page({ saved });
  await p.context.startSession(provider, null);
  p.context.resumeCard('card-1');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(p.starts(), []);
  assert.equal(p.toasts.length, 2);
  assert.match(p.toasts[0], /^Claude Code's help no longer lists --bg\. The session was not started; remove that flag under Flags/);
  assert.deepEqual(JSON.parse(p.storage.get('agentGuild.flags')), saved);
  p.context.renderLaunchFlags(p.card, provider);
  assert.equal(p.summary.textContent, '--effort max · --bg');
  assert.ok(p.line.classList.contains('missing'));
  assert.match(p.line.title, /no longer lists a picked flag/);
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
  assert.match(p.toasts[0], /--effort needs a value/);
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
  assert.equal(p.line.attributes['aria-label'], 'Claude Code launch flags: --model opus · --dangerously-skip-permissions · --effort max', 'in the provider\'s order');
  p.context.setFlagPicks(provider, {});
  assert.deepEqual(JSON.parse(p.storage.get('agentGuild.flags')), {});
  assert.deepEqual([p.label.textContent, p.summary.textContent, p.line.classList.contains('picked')], ['Add launch flags', '', false]);
  p.context.renderLaunchFlags(p.card, { ...provider, launchFlags: [] });
  assert.equal(p.line.hidden, true);
});
