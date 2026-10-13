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
