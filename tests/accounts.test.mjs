import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProviderRegistry, ID_RE } from '../src/manager/providers.mjs';
import { accountIdFor, checkLabel, createAccountEditor, editAccountsText } from '../src/manager/accounts.mjs';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-accounts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(t, contents, { inUse = () => false } = {}) {
  const dir = tempDir(t);
  const userFile = path.join(dir, 'providers.json');
  if (contents !== undefined) fs.writeFileSync(userFile, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
  const accountsDir = path.join(dir, 'accounts');
  const registry = new ProviderRegistry({ userFile, env: { PATH: '', HOME: dir }, platform: 'linux', checkUpdates: false, accountsDir });
  const editor = createAccountEditor({ registry, inUse });
  const read = () => JSON.parse(fs.readFileSync(userFile, 'utf8'));
  const accounts = (id) => registry.get(id).accounts.map(({ id: accountId, label }) => ({ id: accountId, label }));
  return { dir, userFile, accountsDir, registry, editor, read, accounts };
}

function refused(fn, status, code) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, code, err.message);
    assert.equal(err.status, status);
    return true;
  });
}

test('an account id comes from its label, is unique, never "default", and is a valid id', () => {
  const none = new Set();
  assert.equal(accountIdFor('Work', none), 'work');
  assert.equal(accountIdFor('  Side project!  ', none), 'side-project');
  assert.equal(accountIdFor('Café Équipe', none), 'cafe-equipe');
  assert.equal(accountIdFor('仕事', none), 'account');
  assert.equal(accountIdFor('Default', none), 'default-2');
  assert.equal(accountIdFor('Work', new Set(['work', 'work-2'])), 'work-3');
  const long = accountIdFor('A very long account name that goes on', new Set(['a-very-long-account-name']));
  assert.equal(long, 'a-very-long-account-name-2');
  for (const label of ['Work', '--x--', 'Ünïcödé', '仕事', 'a'.repeat(40), 'trailing dash -----------------x']) {
    assert.match(accountIdFor(label, new Set(['work', 'account'])), ID_RE, label);
  }
});

test('a label is trimmed, bounded, free of control characters and unique ignoring case', () => {
  const accounts = [{ id: 'default', label: 'Default' }, { id: 'work', label: 'Work' }];
  assert.equal(checkLabel('  Side  ', accounts), 'Side');
  assert.equal(checkLabel('a'.repeat(40), accounts), 'a'.repeat(40));
  assert.equal(checkLabel('work', accounts, 'work'), 'work', 'an account may keep its own name in another case');
  refused(() => checkLabel('   ', accounts), 400, 'bad_label');
  refused(() => checkLabel('a'.repeat(41), accounts), 400, 'bad_label');
  refused(() => checkLabel('Tab\there', accounts), 400, 'bad_label');
  refused(() => checkLabel(7, accounts), 400, 'bad_label');
  refused(() => checkLabel(' WORK ', accounts), 409, 'duplicate_label');
  refused(() => checkLabel('default', accounts, 'work'), 409, 'duplicate_label');
});

test('editing the accounts text keeps every other part of the file', () => {
  const add = (accounts) => [...accounts, { id: 'x', label: 'X' }];
  assert.deepEqual(JSON.parse(editAccountsText(null, 'anthropic', 'linux', add)), { providers: [{ id: 'anthropic', accounts: [{ id: 'x', label: 'X' }] }] });

  const original = {
    note: 'kept',
    providers: [
      { id: 'openai', usage: null, accounts: ['shared'] },
      { id: 'anthropic', usage: null, extra: { nested: [1, 2] } },
      { id: 'anthropic', accounts: [{ id: 'work', label: 'Work', dir: '~/.claude-work', future: true }] },
      { id: 'anthropic', color: '#123456' },
    ],
  };
  const edited = JSON.parse(editAccountsText(JSON.stringify(original), 'anthropic', 'linux', add));
  const expected = structuredClone(original);
  expected.providers[2].accounts.push({ id: 'x', label: 'X' });
  assert.deepEqual(edited, expected, 'the last entry with accounts is the one in effect, and only it changes');

  const bare = JSON.parse(editAccountsText(JSON.stringify([{ id: 'xai', usage: null }]), 'xai', 'linux', add));
  assert.deepEqual(bare, [{ id: 'xai', usage: null, accounts: [{ id: 'x', label: 'X' }] }], 'a file that is a bare list stays one');

  const appended = JSON.parse(editAccountsText(JSON.stringify({ providers: [{ id: 'openai' }] }), 'xai', 'linux', add));
  assert.deepEqual(appended.providers, [{ id: 'openai' }, { id: 'xai', accounts: [{ id: 'x', label: 'X' }] }]);
  assert.match(editAccountsText(null, 'xai', 'linux', add), /\n$/);
});

test('a file this cannot edit safely is refused, never rewritten', () => {
  const same = (accounts) => accounts;
  refused(() => editAccountsText('{ "providers": [', 'anthropic', 'linux', same), 409, 'providers_file_invalid');
  refused(() => editAccountsText('{ "tools": [] }', 'anthropic', 'linux', same), 409, 'providers_file_invalid');
  refused(() => editAccountsText('null', 'anthropic', 'linux', same), 409, 'providers_file_invalid');
  refused(() => editAccountsText(JSON.stringify({ providers: [{ id: 'anthropic', accounts: 'work' }] }), 'anthropic', 'linux', same), 409, 'providers_file_invalid');
  const perPlatform = JSON.stringify({ providers: [{ id: 'anthropic', linux: { accounts: [{ id: 'work' }] } }] });
  refused(() => editAccountsText(perPlatform, 'anthropic', 'linux', same), 409, 'accounts_per_platform');
  assert.doesNotThrow(() => editAccountsText(perPlatform, 'anthropic', 'win32', same), 'another platform\'s accounts do not apply here');
});

test('adding an account writes providers.json, reloads the tools and changes the revision', (t) => {
  const { registry, editor, read, accounts, userFile } = setup(t);
  assert.equal(registry.revision, null, 'no file, no revision');
  const updates = [];
  registry.on('updated', () => updates.push(registry.revision));

  const added = editor.add('anthropic', { label: ' Work ', revision: null });
  assert.deepEqual(added, { account: { id: 'work', label: 'Work' }, dir: null, changed: true });
  assert.deepEqual(read(), { providers: [{ id: 'anthropic', accounts: [{ id: 'work', label: 'Work' }] }] });
  assert.deepEqual(accounts('anthropic'), [{ id: 'default', label: 'Default' }, { id: 'work', label: 'Work' }]);
  assert.match(registry.revision, /^[0-9a-f]{32}$/);
  assert.deepEqual(updates, [registry.revision], 'every open page hears of the change once');
  assert.deepEqual(fs.readdirSync(path.dirname(userFile)), ['providers.json'], 'no temporary file is left behind');

  const second = editor.add('anthropic', { label: 'work two', revision: registry.revision });
  assert.equal(second.account.id, 'work-two');
  refused(() => editor.add('anthropic', { label: 'WORK', revision: registry.revision }), 409, 'duplicate_label');
  refused(() => editor.add('google', { label: 'Work', revision: registry.revision }), 409, 'accounts_unsupported');
  refused(() => editor.add('shell', { label: 'Work', revision: registry.revision }), 409, 'accounts_unsupported');
  refused(() => editor.add('nobody', { label: 'Work', revision: registry.revision }), 404, 'unknown_provider');
  refused(() => editor.add('anthropic', { label: 'Work', revision: 7 }), 400, 'bad_revision');
});

test('a change made from an older view of the file is refused, and the tools reload from the file', (t) => {
  const { registry, editor, userFile, accounts } = setup(t, { providers: [{ id: 'openai', accounts: [{ id: 'work', label: 'Work' }] }] });
  const loaded = registry.revision;
  refused(() => editor.add('openai', { label: 'Side', revision: null }), 409, 'stale_accounts');
  refused(() => editor.add('openai', { label: 'Side', revision: 'f'.repeat(32) }), 409, 'stale_accounts');
  assert.equal(registry.revision, loaded, 'nothing changed on disk, so nothing reloads');

  const handEdited = JSON.stringify({ providers: [{ id: 'openai', accounts: [{ id: 'work', label: 'Job' }] }] });
  fs.writeFileSync(userFile, handEdited);
  refused(() => editor.rename('openai', 'work', { label: 'Office', revision: loaded }), 409, 'stale_accounts');
  assert.equal(fs.readFileSync(userFile, 'utf8'), handEdited, 'the hand edit is kept as written');
  assert.notEqual(registry.revision, loaded, 'the tools now reflect the hand edit');
  assert.deepEqual(accounts('openai'), [{ id: 'default', label: 'Default' }, { id: 'work', label: 'Job' }]);
  editor.rename('openai', 'work', { label: 'Office', revision: registry.revision });
  assert.deepEqual(accounts('openai'), [{ id: 'default', label: 'Default' }, { id: 'work', label: 'Office' }]);
});

test('a manager without a providers.json path refuses account changes', () => {
  const registry = new ProviderRegistry({ env: { PATH: '' }, platform: 'linux', checkUpdates: false });
  const editor = createAccountEditor({ registry, inUse: () => false });
  refused(() => editor.add('anthropic', { label: 'Work', revision: null }), 409, 'accounts_unsupported');
});

test('a broken providers.json is reported and left exactly as it was', (t) => {
  const broken = '{ "providers": [ { "id": "anthropic", ';
  const { registry, editor, userFile } = setup(t, broken);
  refused(() => editor.add('anthropic', { label: 'Work', revision: registry.revision }), 409, 'providers_file_invalid');
  assert.equal(fs.readFileSync(userFile, 'utf8'), broken);
});

test('renaming keeps the id, so the account keeps its folder; the default can be renamed', (t) => {
  const { registry, editor, read, accounts } = setup(t, { providers: [{ id: 'xai', usage: null, accounts: ['shared', { id: 'work', label: 'Work', dir: '/elsewhere' }] }] });
  const before = registry.account(registry.get('xai'), 'work').dir;
  editor.rename('xai', 'work', { label: 'Office', revision: registry.revision });
  editor.rename('xai', 'shared', { label: 'Team', revision: registry.revision });
  editor.rename('xai', 'default', { label: 'Personal', revision: registry.revision });
  assert.deepEqual(read(), { providers: [{ id: 'xai', usage: null, accounts: [
    { id: 'shared', label: 'Team' }, { id: 'work', label: 'Office', dir: '/elsewhere' }, { id: 'default', label: 'Personal' },
  ] }] });
  assert.deepEqual(accounts('xai'), [{ id: 'default', label: 'Personal' }, { id: 'shared', label: 'Team' }, { id: 'work', label: 'Office' }]);
  assert.equal(registry.account(registry.get('xai'), 'work').dir, before);

  const bytes = fs.readFileSync(registry.userFile, 'utf8');
  const revision = registry.revision;
  assert.deepEqual(editor.rename('xai', 'work', { label: ' Office ', revision }), { account: { id: 'work', label: 'Office' }, dir: null, changed: false });
  assert.equal(fs.readFileSync(registry.userFile, 'utf8'), bytes, 'an unchanged name writes nothing');
  assert.equal(registry.revision, revision);
  refused(() => editor.rename('xai', 'nope', { label: 'X', revision }), 404, 'unknown_account');
  refused(() => editor.rename('xai', 'work', { label: 'team', revision }), 409, 'duplicate_label');
});

test('removing an account keeps its folder, and is refused for the default or while a session uses it', (t) => {
  let running = true;
  const { registry, editor, read, accountsDir } = setup(t, { providers: [{ id: 'anthropic', accounts: [{ id: 'work', label: 'Work' }, 'side'] }] }, {
    inUse: (providerId, accountId) => running && providerId === 'anthropic' && accountId === 'work',
  });
  const folder = path.join(accountsDir, 'anthropic', 'work');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, '.credentials.json'), '{}');

  refused(() => editor.remove('anthropic', 'default', { revision: registry.revision }), 409, 'default_account');
  refused(() => editor.remove('anthropic', 'nope', { revision: registry.revision }), 404, 'unknown_account');
  refused(() => editor.remove('anthropic', 'work', { revision: registry.revision }), 409, 'account_in_use');
  running = false;
  const removed = editor.remove('anthropic', 'work', { revision: registry.revision });
  assert.deepEqual(removed, { account: { id: 'work', label: 'Work' }, dir: path.posix.join(accountsDir, 'anthropic', 'work'), changed: true });
  assert.deepEqual(read(), { providers: [{ id: 'anthropic', accounts: ['side'] }] });
  assert.ok(fs.existsSync(path.join(folder, '.credentials.json')), 'the sign-in stays on disk');

  const again = editor.add('anthropic', { label: 'Work', revision: registry.revision });
  assert.equal(again.account.id, 'work', 'adding the name again finds the same folder');
});
