import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');

const source = ['usageLeft', 'accountUsageSpent', 'cardUsageSpent'].map((name) => {
  const found = app.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(found, `${name} is present`);
  return found;
}).join('\n');
const { usageLeft, accountUsageSpent, cardUsageSpent } = runInNewContext(`${source}\n({ usageLeft, accountUsageSpent, cardUsageSpent })`);

const windowAt = (usedPercent, label = '5-hour') => ({ label, usedPercent, resetsAt: null });
const reading = (overrides) => ({ signedIn: true, error: null, windows: [windowAt(100)], credits: null, ...overrides });

test('usage left uses the meter rounding', () => {
  assert.equal(usageLeft(0), 100);
  assert.equal(usageLeft(99.4), 1);
  assert.equal(usageLeft(99.6), 0);
  assert.equal(usageLeft(100), 0);
});

test('an account is spent only when every window explicitly reads 0% left', () => {
  assert.equal(accountUsageSpent(reading()), true);
  assert.equal(accountUsageSpent(reading({ windows: [windowAt(99.6), windowAt(100, '7-day')] })), true);
  assert.equal(accountUsageSpent(reading({ windows: [windowAt(100), windowAt(40, '7-day')] })), false);
  assert.equal(accountUsageSpent(reading({ windows: [windowAt(99.4)] })), false);
  assert.equal(accountUsageSpent(reading({ credits: 12 })), false);
  assert.equal(accountUsageSpent(reading({ credits: 0 })), true);
  assert.equal(accountUsageSpent(reading({ signedIn: false, windows: [windowAt(100)] })), null);
  assert.equal(accountUsageSpent(reading({ signedIn: null, windows: [windowAt(100)] })), true);
  assert.equal(accountUsageSpent(reading({ error: 'usage check failed', windows: [] })), false);
  assert.equal(accountUsageSpent(reading({ signedIn: null, error: 'usage check failed', windows: [] })), null);
  assert.equal(accountUsageSpent(reading({ windows: [] })), false);
  assert.equal(accountUsageSpent(null), null);
});

test('the card is spent only when every logged-in account explicitly reads 0% left', () => {
  const provider = {
    id: 'anthropic', available: true, usageSource: 'claude',
    accounts: [{ id: 'default' }, { id: 'work' }],
  };
  const usage = (rows) => new Map(rows.map((row) => [`anthropic/${row.accountId}`, row]));
  assert.equal(cardUsageSpent(provider, usage([
    { accountId: 'default', ...reading() },
    { accountId: 'work', ...reading({ signedIn: false, error: 'not signed in', windows: [] }) },
  ])), true);
  assert.equal(cardUsageSpent(provider, usage([
    { accountId: 'default', ...reading() },
    { accountId: 'work', ...reading({ windows: [windowAt(12)] }) },
  ])), false);
  assert.equal(cardUsageSpent(provider, usage([
    { accountId: 'default', ...reading() },
    { accountId: 'work', ...reading({ error: 'timed out', windows: [] }) },
  ])), false);
  assert.equal(cardUsageSpent(provider, usage([
    { accountId: 'default', ...reading({ signedIn: false, error: 'not signed in', windows: [] }) },
  ])), false);
  assert.equal(cardUsageSpent({ ...provider, available: false }, usage([{ accountId: 'default', ...reading() }])), false);
  assert.equal(cardUsageSpent({ ...provider, usageSource: null }, usage([{ accountId: 'default', ...reading() }])), false);
  assert.equal(cardUsageSpent(
    { id: 'custom', available: true, usageSource: 'command', accounts: [{ id: 'default' }] },
    new Map([['custom/default', reading({ signedIn: null })]]),
  ), true);
});

test('the spent portrait is paint on the provider card and leaves the session card alone', () => {
  assert.match(app, /card\.classList\.toggle\('spent', cardUsageSpent\(provider, state\.usage\)\)/);
  assert.match(app, /const left = usageLeft\(w\.usedPercent\)/);
  const provider = html.slice(html.indexOf('id="provider-template"'), html.indexOf('id="meter-template"'));
  const session = html.slice(html.indexOf('id="session-template"'));
  assert.match(provider, /<span class="card-art" aria-hidden="true"><span class="spent-veil"><\/span><\/span>/);
  assert.doesNotMatch(session, /spent-veil/);
  assert.match(css, /\.provider\.spent \.spent-veil \{ opacity: 1; \}/);
  assert.match(css, /\.provider\.spent \.card-art::before \{ filter: grayscale\(1\) brightness\(0\.82\); \}/);
  assert.match(css, /prefers-reduced-motion: reduce\)[\s\S]*\.provider \.spent-veil \{ transition: none; \}/);
});
