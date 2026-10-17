import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const dialogs = [...html.matchAll(/<dialog id="([a-z-]+)"/g)].map((m) => m[1]);

const source = ['closeDialogs', 'closeModels', 'closeNews', 'closeChangelog', 'closeVideos', 'closeAccounts', 'closeFlags', 'closeMemory', 'showAuth', 'enterStopping'].map((name) => {
  const found = app.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(found, `${name} is present`);
  return found;
}).join('\n');

function page() {
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, { open: false, hidden: false, textContent: '', close() { this.open = false; } });
    return elements.get(id);
  };
  const noop = () => {};
  const context = {
    $,
    state: {
      eventsSocket: null, views: new Map(), sessions: new Map(),
      environmentUI: { close: () => $('environment').close() },
      remoteAccessUI: { close: () => $('remote-access').close(), setAvailable: (capability) => { if (!capability) $('remote-access').close(); } },
    },
    closePanel: () => $('terminal-copy').close(),
    closeHistory: () => $('history').close(),
    closeGitHub: noop,
    managerLoss: { cancel: noop },
    renderSessions: noop, showStopped: noop, setConnection: noop, restartGaveUp: noop,
    setTimeout: noop, clearTimeout: noop, RESTART_WAIT_MS: 0, restartTimer: undefined,
  };
  const api = runInNewContext(`${source}\n({ showAuth, enterStopping })`, context);
  return { ...api, $ };
}

test('signing out, stopping or restarting closes every dialog on the page', () => {
  assert.ok(dialogs.includes('accounts') && dialogs.includes('memory'), 'the page lists its dialogs');
  for (const leave of ['sign out', 'stop', 'restart']) {
    const p = page();
    for (const id of dialogs) p.$(id).open = true;
    if (leave === 'sign out') p.showAuth('Sign in again.');
    else p.enterStopping(0, leave === 'restart');
    assert.deepEqual(dialogs.filter((id) => p.$(id).open), [], leave);
  }
});
