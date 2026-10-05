import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// app.js is a browser script. Run its real upgrade and restart functions
// against stub elements, without booting the DOM or a manager.
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const source = ['function ptyRebuild', 'function ptyBuildToast', 'function renderUpgrade', 'function setUpgrade', 'async function stopManager']
  .map((name) => {
    const found = app.match(new RegExp(`${name}\\([^]*?\\n\\}`))?.[0];
    assert.ok(found, `${name} is present in app.js`);
    return found;
  }).join('\n');

const COMMAND = 'cd /usr/local/lib/node_modules/@oddessentials/agent-guild/node_modules/node-pty && npx --yes node-gyp rebuild';

function element() {
  return { hidden: false, disabled: false, textContent: '', title: '', classList: { toggle() {} } };
}

function page({ api = async () => ({}) } = {}) {
  const nodes = new Map();
  const toasts = [];
  const copied = [];
  const context = {
    state: { connected: true, restartable: true, upgrade: null },
    $: (id) => {
      if (!nodes.has(id)) nodes.set(id, element());
      return nodes.get(id);
    },
    toast: (message, ms, action) => toasts.push({ message, action }),
    copyText: (text) => copied.push(text),
    updateAlert: () => false,
    alertSound() {},
    renderVersion() {},
    enterStopping() {},
    api,
    AuthError: class extends Error {},
    showAuth() {},
    confirm: () => false,
  };
  runInNewContext(source, context);
  return { ...context, node: context.$, toasts, copied };
}

const upgrade = (fields) => ({
  version: '1.0.0', latestVersion: '1.1.0', available: false, command: null, guidance: null,
  pendingVersion: null, installing: false, lastInstall: null, ptyBuild: null, ...fields,
});

test('where node-pty runs from its own builds, the upgrade and restart read as before', () => {
  const view = page();
  view.setUpgrade(upgrade({ available: true, command: 'npm install -g @oddessentials/agent-guild@1.1.0' }), true);
  assert.equal(view.node('upgrade').hidden, false);
  assert.doesNotMatch(view.node('upgrade').title, /node-pty/);
  assert.equal(view.node('upgrade-note').hidden, true);

  view.setUpgrade(upgrade({ pendingVersion: '1.1.0' }));
  assert.equal(view.node('restart-manager').textContent, 'Restart to use v1.1.0');
  assert.match(view.node('restart-manager').title, /^Agent Guild 1\.1\.0 is installed, but this manager is still 1\.0\.0/);
  assert.equal(view.node('upgrade-note').hidden, true);
  assert.equal(view.toasts.length, 1);
  assert.match(view.toasts[0].message, /^Agent Guild 1\.1\.0 is installed\. Use "Restart to use v1\.1\.0" in the top bar/);
  assert.equal(view.toasts[0].action, undefined);
});

test('where node-pty is compiled here, the upgrade says it has to be built again, and the restart waits for it', () => {
  const view = page();
  view.setUpgrade(upgrade({ available: true, command: 'npm install -g @oddessentials/agent-guild@1.1.0', ptyBuild: { command: COMMAND, built: true } }), true);
  assert.match(view.node('upgrade').title, new RegExp(`after the upgrade, run "${COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" in a terminal before restarting\\.$`));
  assert.equal(view.node('upgrade-note').hidden, false);
  assert.equal(view.node('upgrade-note').textContent, 'Build node-pty again after upgrading');
  assert.ok(view.node('upgrade-note').title.includes(COMMAND));

  // npm replaced the build with the new version's files.
  view.setUpgrade(upgrade({ latestVersion: '1.1.0', pendingVersion: '1.1.0', ptyBuild: { command: COMMAND, built: false } }));
  assert.equal(view.node('upgrade-note').textContent, 'v1.1.0 installed · build node-pty before restarting');
  assert.ok(view.node('upgrade-note').title.includes(COMMAND));
  assert.ok(view.node('restart-manager').title.includes(COMMAND));
  const [installed] = view.toasts;
  assert.equal(installed.message, `Agent Guild 1.1.0 is installed. Before restarting, build node-pty for this computer again: run "${COMMAND}" in a terminal.`);
  assert.equal(installed.action.label, 'Copy command');
  installed.action.run();
  assert.deepEqual(view.copied, [COMMAND]);

  // Built again: the restart is offered as on any computer.
  view.setUpgrade(upgrade({ latestVersion: '1.1.0', pendingVersion: '1.1.0', ptyBuild: { command: COMMAND, built: true } }));
  assert.equal(view.node('upgrade-note').hidden, true);
  assert.match(view.node('restart-manager').title, /^Agent Guild 1\.1\.0 is installed, but this manager is still 1\.0\.0/);
  assert.equal(view.toasts.length, 1, 'the same installed version is announced once');
});

test('a restart the manager refuses for node-pty says so, with the command to copy', async () => {
  const refusal = Object.assign(new Error('Build node-pty first.\nThe manager was not restarted, and its sessions keep running.'), { code: 'pty_unavailable' });
  const view = page({ api: async () => { throw refusal; } });
  view.state.upgrade = upgrade({ pendingVersion: '1.1.0', ptyBuild: { command: COMMAND, built: false } });
  await view.stopManager({ restart: true });
  assert.equal(view.toasts.length, 1);
  assert.equal(view.toasts[0].message, `The manager was not restarted, and its sessions keep running. First build node-pty, the terminal library, for this computer: run "${COMMAND}" in a terminal.`);
  view.toasts[0].action.run();
  assert.deepEqual(view.copied, [COMMAND]);
  assert.equal(view.node('restart-manager').disabled, false, 'the buttons work again');

  // Without the build in hand, the manager's own message is shown.
  view.state.upgrade = null;
  await view.stopManager({ restart: true });
  assert.equal(view.toasts[1].message, refusal.message);
});
