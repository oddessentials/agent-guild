import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const source = ['pickedShell', 'selectedShell', 'selectShell', 'renderShells', 'startSession'].map((name) => {
  const found = app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(found, `${name} is present in app.js`);
  return found;
}).join('\n');

const provider = {
  id: 'shell', available: true, defaultShell: 'zsh',
  shells: [
    { id: 'bash', label: 'bash', path: '/bin/bash' },
    { id: 'zsh', label: 'zsh', path: '/bin/zsh' },
  ],
};

// Exercise the browser's real selection and request logic with only DOM and
// network boundaries stubbed, so these tests run on every CI platform.
function picker(saved = '{}') {
  const storage = new Map([['agentGuild.shells', saved]]);
  const requests = [];
  const host = { children: [], replaceChildren(...children) { this.children = children; } };
  const card = { querySelector: () => host, classList: { add() {}, remove() {} } };
  const context = {
    state: { shellPicks: JSON.parse(saved) },
    SHELLS_KEY: 'agentGuild.shells', CWD_KEY: 'agentGuild.cwd',
    save: (key, value) => storage.set(key, value),
    document: {
      createElement: () => ({
        dataset: {}, attributes: {},
        setAttribute(key, value) { this.attributes[key] = value; },
        addEventListener(type, listener) { this[type] = listener; },
      }),
    },
    renderUsage() {},
    selectedAccount: () => ({ id: 'default' }),
    $: () => ({ value: '/work/project' }),
    api: async (method, route, body) => {
      requests.push({ method, route, body: JSON.parse(JSON.stringify(body)) });
      return { session: { id: 'new-session' } };
    },
    upsertSession() {}, closeHistory() {}, openPanel() {},
    AuthError: class extends Error {},
    toast(message) { assert.fail(message); },
  };
  runInNewContext(source, context);
  return { context, storage, requests, host, card };
}

test('shell chips persist an alternate selection and send it when starting a session', async () => {
  const page = picker();
  page.context.renderShells(page.card, provider);
  assert.equal(page.host.hidden, false);
  assert.deepEqual(page.host.children.map((chip) => chip.attributes['aria-selected']), ['false', 'true']);
  page.host.children[0].click();
  assert.deepEqual(page.host.children.map((chip) => chip.attributes['aria-selected']), ['true', 'false']);
  assert.equal(page.host.children[0].title, 'Start new sessions in bash\n/bin/bash');

  const reloaded = picker(page.storage.get('agentGuild.shells'));
  assert.equal(reloaded.context.selectedShell(provider).id, 'bash');
  await reloaded.context.startSession(provider, reloaded.card);
  assert.deepEqual(reloaded.requests, [{
    method: 'POST', route: '/sessions',
    body: { providerId: 'shell', account: 'default', shell: 'bash', cwd: '/work/project', cols: 120, rows: 32 },
  }]);
});

test('choosing the default clears the saved override and follows later default changes', async () => {
  const page = picker('{"shell":"bash"}');
  page.context.renderShells(page.card, provider);
  page.host.children[1].click();
  assert.equal(page.storage.get('agentGuild.shells'), '{}');
  assert.equal(page.context.selectedShell({ ...provider, defaultShell: 'bash' }).id, 'bash');
  await page.context.startSession(provider, page.card);
  assert.equal(Object.hasOwn(page.requests[0].body, 'shell'), false);
});

test('an unavailable saved shell falls back to the default and cannot leak into another tool request', async () => {
  const page = picker('{"shell":"fish","anthropic":"bash"}');
  assert.equal(page.context.selectedShell(provider).id, 'zsh');
  await page.context.startSession(provider, page.card);
  await page.context.startSession({ id: 'anthropic', shells: null, defaultShell: null }, page.card);
  assert.ok(page.requests.every(({ body }) => !Object.hasOwn(body, 'shell')));
  for (const current of [
    { ...provider, available: false },
    { ...provider, shells: [provider.shells[1]] },
    { id: 'anthropic', available: true, shells: null },
  ]) {
    page.context.renderShells(page.card, current);
    assert.equal(page.host.hidden, true);
    assert.equal(page.host.children.length, 0);
  }
});
