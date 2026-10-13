import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

const source = ['accountLabelProblem', 'accountInUse', 'accountLabel'].map((name) => {
  const found = app.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(found, `${name} is present`);
  return found;
}).join('\n');

function page(providers = []) {
  const state = { providers };
  return { state, ...runInNewContext(`${source}\n({ accountLabelProblem, accountInUse, accountLabel })`, { state }) };
}

test('the page flags an account name before asking the manager', () => {
  const { accountLabelProblem } = page();
  const accounts = [{ id: 'default', label: 'Default' }, { id: 'work', label: 'Work' }];
  assert.equal(accountLabelProblem('  Side  ', accounts), null);
  assert.equal(accountLabelProblem('a'.repeat(40), accounts), null);
  assert.equal(accountLabelProblem('WORK', accounts, 'work'), null, 'an account may keep its own name in another case');
  assert.equal(accountLabelProblem('   ', accounts), 'Enter a name for the account.');
  assert.equal(accountLabelProblem('a'.repeat(41), accounts), 'Use at most 40 characters.');
  assert.equal(accountLabelProblem('a\u0007b', accounts), 'The account name cannot contain control characters.');
  assert.equal(accountLabelProblem(' work ', accounts), 'There is already an account named work.');
  assert.match(html, /id="accounts-new"[^>]*maxlength="40"/, 'the field stops at the same length');
});

test('an account is in use only while a running session of that tool uses it', () => {
  const { accountInUse } = page();
  const running = (provider, account) => ({ status: 'running', provider: { id: provider }, account: account && { id: account } });
  assert.equal(accountInUse([running('anthropic', 'work')], 'anthropic', 'work'), true);
  assert.equal(accountInUse([running('anthropic', null)], 'anthropic', 'default'), true, 'a session without an account uses the default');
  assert.equal(accountInUse([{ ...running('anthropic', 'work'), status: 'exited' }], 'anthropic', 'work'), false);
  assert.equal(accountInUse([running('openai', 'work')], 'anthropic', 'work'), false);
  assert.equal(accountInUse([running('anthropic', 'side')], 'anthropic', 'work'), false);
  assert.equal(accountInUse([], 'anthropic', 'work'), false);
});

test('a session card names its account as the account is called now', () => {
  const p = page([{ id: 'anthropic', accounts: [{ id: 'default', label: 'Personal' }, { id: 'work', label: 'Office' }] }]);
  const session = (account) => ({ provider: { id: 'anthropic' }, account });
  assert.equal(p.accountLabel(session({ id: 'work', label: 'Work' })), 'Office', 'a rename shows on running sessions');
  assert.equal(p.accountLabel(session({ id: 'default', label: 'Default' })), 'Personal');
  assert.equal(p.accountLabel(session({ id: 'gone', label: 'Gone' })), 'Gone', 'a removed account keeps the name it started with');
  assert.equal(p.accountLabel(session(null)), '');
  p.state.providers = [{ id: 'anthropic', accounts: [{ id: 'default', label: 'Default' }] }];
  assert.equal(p.accountLabel(session({ id: 'default', label: 'Default' })), '', 'one account needs no name');
});

const dialogSource = [
  app.match(/const accountsView = [^\n]*\n/)?.[0],
  ...['setProviders', 'accountsShowing', 'accountsProvider', 'showAccounts', 'changeAccounts', 'accountsPath', 'addAccount', 'renameAccount', 'removeAccount'].map((name) => {
    const found = app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
    assert.ok(found, `${name} is present`);
    return found;
  }),
  app.match(/\$\('accounts'\)\.addEventListener\('close', [^]*?\n\}\);/)?.[0],
].join('\n');

function dialogPage() {
  const elements = new Map();
  const focused = [];
  const listeners = {};
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id, value: '', open: false, isConnected: false,
        focus() { focused.push(id); },
        showModal() { this.open = true; },
        close() { this.open = false; },
        replaceChildren() {},
        addEventListener(type, fn) { listeners[type] = fn; },
        querySelector: () => null,
      });
    }
    return elements.get(id);
  };
  const replies = [];
  const calls = { api: [], selected: [], auth: [], reloads: [], usage: 0 };
  class AuthError extends Error {}
  const state = {
    providersRevision: 'r1',
    providersEvents: 0,
    eventsSocket: { id: 'events' },
    providers: [{ id: 'anthropic', tool: 'Claude Code', accountsEditable: true, accounts: [{ id: 'default', label: 'Default' }, { id: 'work', label: 'Work' }] }],
  };
  const context = {
    state, AuthError,
    $: element,
    document: { activeElement: null },
    api: (method, path, body) => {
      calls.api.push({ method, path, body });
      return new Promise((resolve, reject) => replies.push({ resolve, reject }));
    },
    renderProviders() {}, renderSessions() {}, renderAccountsDialog() {},
    showAuth: (message) => calls.auth.push(message),
    loadProviders: async (ws) => { calls.reloads.push(ws); },
    selectAccount: (provider, id) => calls.selected.push(`${provider.id}/${id}`),
    loadUsage: () => { calls.usage++; },
    accountLabelProblem: () => null,
    encodeURIComponent,
  };
  const api = runInNewContext(`${dialogSource}\n({ accountsView, setProviders, showAccounts, addAccount, renameAccount, removeAccount })`, context);
  const dialog = element('accounts');
  const open = () => api.showAccounts(state.providers[0]);
  // Escape closes the dialog without closeAccounts(); the close event follows.
  const escape = () => { dialog.open = false; listeners.close(); };
  const row = (id, value) => {
    const name = { value, focus() { focused.push(`name-${id}`); } };
    const remove = { focus() { focused.push(`remove-${id}`); } };
    return { dataset: { account: id }, querySelector: (sel) => (sel === '.account-name' ? name : sel === '.account-remove' ? remove : null) };
  };
  const reply = (accounts, account) => ({ providers: [{ ...state.providers[0], accounts }], revision: 'r2', account, dir: '/kept' });
  // What a providers.updated event does to the page.
  const update = (accounts, revision) => {
    state.providersEvents++;
    api.setProviders({ providers: [{ ...state.providers[0], accounts }], revision });
  };
  // What another request's reply does to the page, without an event.
  const replied = (accounts, revision) => api.setProviders({ providers: [{ ...state.providers[0], accounts }], revision });
  return { ...api, AuthError, state, calls, replies, focused, element, open, escape, row, reply, update, replied };
}

test('a reply that arrives after the dialog was reopened leaves the new dialog alone', async () => {
  const p = dialogPage();
  p.open();
  p.element('accounts-new').value = 'Side';
  const adding = p.addAccount();
  p.escape();
  p.open();
  p.element('accounts-new').value = 'draft';
  p.accountsView.errors.set('work', 'shown');
  p.accountsView.status = 'kept';
  const accounts = [{ id: 'default', label: 'Default' }, { id: 'work', label: 'Work' }, { id: 'side', label: 'Side' }];
  p.replies[0].resolve(p.reply(accounts, { id: 'side', label: 'Side' }));
  await adding;
  assert.equal(p.element('accounts-new').value, 'draft');
  assert.equal(p.accountsView.status, 'kept');
  assert.equal(p.accountsView.errors.get('work'), 'shown');
  assert.equal(p.accountsView.busy, false);
  assert.deepEqual(p.focused, []);
  assert.deepEqual(p.state.providers[0].accounts, accounts, 'the tools still update');
  assert.deepEqual(p.calls.selected, ['anthropic/side'], 'the card still picks the new account');
  assert.equal(p.calls.usage, 1);
});

test('a refusal that arrives after the dialog was reopened shows nowhere, and a lost sign-in still asks to sign in', async () => {
  const p = dialogPage();
  p.open();
  const renaming = p.renameAccount(p.row('work', 'Office'));
  p.escape();
  p.open();
  p.replies[0].reject(Object.assign(new Error('There is already an account named Office.'), { code: 'duplicate_label' }));
  await renaming;
  assert.equal(p.accountsView.errors.size, 0);
  assert.equal(p.accountsView.busy, false);
  assert.deepEqual(p.focused, []);

  const adding = p.addAccount();
  p.escape();
  p.open();
  p.replies[1].reject(new p.AuthError('Sign in again.'));
  await adding;
  assert.deepEqual(p.calls.auth, ['Sign in again.']);
  assert.deepEqual(p.focused, []);

  const stale = p.addAccount();
  p.escape();
  p.open();
  p.replies[2].reject(Object.assign(new Error('The accounts changed elsewhere.'), { code: 'stale_accounts' }));
  await stale;
  assert.deepEqual(p.calls.reloads, [p.state.eventsSocket], 'the tools still reload, unless a newer update arrives first');
  assert.equal(p.accountsView.errors.size, 0);
});

test('an older change finishing does not end the reopened dialog\'s own change', async () => {
  const p = dialogPage();
  p.open();
  const adding = p.addAccount();
  p.escape();
  p.open();
  const renaming = p.renameAccount(p.row('work', 'Office'));
  assert.equal(p.accountsView.busy, true);
  const added = [{ id: 'default', label: 'Default' }, { id: 'work', label: 'Work' }, { id: 'side', label: 'Side' }];
  p.replies[0].resolve(p.reply(added, { id: 'side', label: 'Side' }));
  await adding;
  assert.equal(p.accountsView.busy, true, 'the newer change is still pending');
  assert.equal(p.accountsView.status, '');
  const renamed = [{ id: 'default', label: 'Default' }, { id: 'work', label: 'Office' }, { id: 'side', label: 'Side' }];
  p.replies[1].resolve(p.reply(renamed, { id: 'work', label: 'Office' }));
  await renaming;
  assert.equal(p.accountsView.busy, false);
  assert.equal(p.accountsView.status, 'Renamed Work to Office.');
  assert.deepEqual(p.focused, ['name-work']);
});

test('a reply that arrives after the dialog was closed changes nothing in it', async () => {
  const p = dialogPage();
  p.open();
  p.accountsView.removing = 'work';
  const removing = p.removeAccount(p.row('work', 'Work'));
  p.escape();
  assert.equal(p.accountsView.providerId, null);
  p.replies[0].reject(Object.assign(new Error('A running session uses the Work account.'), { code: 'account_in_use' }));
  await removing;
  assert.equal(p.accountsView.providerId, null);
  assert.equal(p.accountsView.removing, null);
  assert.equal(p.accountsView.errors.size, 0);
  assert.equal(p.accountsView.busy, false);
  assert.deepEqual(p.focused, []);
});

test('a change in the dialog that stays open still reports there', async () => {
  const p = dialogPage();
  p.open();
  p.accountsView.removing = 'work';
  const removing = p.removeAccount(p.row('work', 'Work'));
  p.replies[0].reject(Object.assign(new Error('A running session uses the Work account.'), { code: 'account_in_use' }));
  await removing;
  assert.equal(p.accountsView.removing, null);
  assert.equal(p.accountsView.errors.get('work'), 'A running session uses the Work account.');
  assert.equal(p.accountsView.busy, false);
  assert.deepEqual(p.focused, ['remove-work']);
});

test('a reply never replaces a newer list of tools', async () => {
  const p = dialogPage();
  p.open();
  const adding = p.addAccount();
  const added = [{ id: 'default', label: 'Default' }, { id: 'work', label: 'Work' }, { id: 'side', label: 'Side' }];
  p.update(added, 'r2');
  const renamed = [{ id: 'default', label: 'Default' }, { id: 'work', label: 'Office' }, { id: 'side', label: 'Side' }];
  p.update(renamed, 'r3');
  p.replies[0].resolve(p.reply(added, { id: 'side', label: 'Side' }));
  await adding;
  assert.deepEqual(p.state.providers[0].accounts, renamed);
  assert.equal(p.state.providersRevision, 'r3');
  assert.deepEqual(p.calls.selected, ['anthropic/side'], 'the card still picks the added account');
  assert.equal(p.accountsView.status, 'Added Side and picked it on the card. Press New there to start a session and sign in.');

  const removing = p.removeAccount(p.row('side', 'Side'));
  const removed = [{ id: 'default', label: 'Default' }, { id: 'work', label: 'Office' }];
  p.replies[1].resolve({ ...p.reply(removed, { id: 'side', label: 'Side' }), revision: 'r4' });
  await removing;
  assert.deepEqual(p.state.providers[0].accounts, removed, 'with no newer update, the reply is the newest list');
  assert.equal(p.state.providersRevision, 'r4');
});

test('a reply is kept when only another request changed the tools meanwhile, as while reconnecting', async () => {
  const p = dialogPage();
  p.open();
  const adding = p.addAccount();
  p.replied([{ id: 'default', label: 'Default' }, { id: 'work', label: 'Work' }], 'r1');
  const added = [{ id: 'default', label: 'Default' }, { id: 'work', label: 'Work' }, { id: 'side', label: 'Side' }];
  p.replies[0].resolve(p.reply(added, { id: 'side', label: 'Side' }));
  await adding;
  assert.deepEqual(p.state.providers[0].accounts, added);
  assert.equal(p.state.providersRevision, 'r2');
});
