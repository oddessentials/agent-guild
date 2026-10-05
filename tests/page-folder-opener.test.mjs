import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const source = ['renderFolderTools', 'openWorkingFolder'].map((name) => app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0]).join('\n');

function page(onApi = async () => ({})) {
  const tool = () => ({ attrs: {}, setAttribute(key, value) { this.attrs[key] = value; } });
  const button = tool(), pick = tool(), clonePick = tool();
  const input = { value: "  /work/space & 'notes'  " };
  const messages = [], requests = [], auth = [];
  const context = {
    state: { connected: true, folderOpener: { available: true, label: 'Finder' }, folderOpening: false },
    $: (id) => ({ 'cwd-open': button, 'cwd-pick': pick, 'github-parent-pick': clonePick })[id] || input,
    api: async (...args) => { requests.push(args); return onApi(); },
    toast: (message) => messages.push(message),
    showAuth: (message) => { auth.push(message); context.state.connected = false; },
    AuthError: class extends Error {},
  };
  runInNewContext(source, context);
  return { context, button, pick, clonePick, input, messages, requests, auth };
}

test('the folder button uses the manager capability and explains unavailable states', async () => {
  const p = page();
  p.context.renderFolderTools();
  assert.equal(p.button.disabled, false);
  assert.equal(p.button.attrs['aria-label'], 'Open working folder in Finder');
  p.context.state.folderOpener = { available: false, reason: 'No desktop session' };
  p.context.renderFolderTools();
  assert.equal(p.button.disabled, true);
  assert.equal(p.button.title, 'No desktop session');
  await p.context.openWorkingFolder();
  p.context.state.folderOpener = null;
  p.context.renderFolderTools();
  assert.equal(p.button.disabled, true);
  p.context.state.connected = false;
  p.context.renderFolderTools();
  assert.match(p.button.title, /Connect/);
  assert.equal(p.requests.length, 0);
});

test('opening sends the current field, preserves it, and blocks duplicate clicks until handoff', async () => {
  let finish;
  const p = page(() => new Promise((resolve) => { finish = resolve; }));
  const pending = p.context.openWorkingFolder();
  assert.equal(p.button.disabled, true);
  assert.equal(p.button.attrs['aria-busy'], 'true');
  await p.context.openWorkingFolder();
  assert.equal(p.requests.length, 1);
  assert.equal(p.requests[0][0], 'POST');
  assert.equal(p.requests[0][1], '/open-folder');
  assert.equal(p.requests[0][2].cwd, "/work/space & 'notes'");
  finish();
  await pending;
  assert.equal(p.button.disabled, false);
  assert.equal(p.button.attrs['aria-busy'], 'false');
  assert.equal(p.input.value, "  /work/space & 'notes'  ");
  assert.deepEqual(p.messages, []);
});

test('blank means home, failures allow retry, and a lost connection keeps the button disabled', async () => {
  const p = page(async () => { throw new Error('Folder does not exist'); });
  p.input.value = '   ';
  await p.context.openWorkingFolder();
  assert.equal(p.requests[0][2].cwd, '');
  assert.deepEqual(p.messages, ['Folder does not exist']);
  assert.equal(p.button.disabled, false);
  p.context.api = async () => { p.context.state.connected = false; };
  await p.context.openWorkingFolder();
  assert.equal(p.button.disabled, true);
  assert.equal(p.context.state.folderOpening, false);
});

test('authentication failures return to the existing sign-in flow', async () => {
  const p = page();
  p.context.api = async () => { throw new p.context.AuthError('Token rejected'); };
  await p.context.openWorkingFolder();
  assert.deepEqual(p.auth, ['Token rejected']);
  assert.deepEqual(p.messages, []);
  assert.equal(p.button.disabled, true);
});

test('the choose buttons follow the connection alone, whatever the opener reports', () => {
  const p = page();
  p.context.state.folderOpener = { available: false, reason: 'Only available on the computer running Agent Guild.' };
  p.context.renderFolderTools();
  assert.equal(p.button.disabled, true);
  assert.equal(p.button.title, 'Only available on the computer running Agent Guild.');
  for (const pick of [p.pick, p.clonePick]) {
    assert.equal(pick.disabled, false);
    assert.equal(pick.attrs['aria-label'], 'Choose a folder…');
  }
  p.context.state.connected = false;
  p.context.renderFolderTools();
  for (const pick of [p.pick, p.clonePick]) {
    assert.equal(pick.disabled, true);
    assert.match(pick.title, /Connect/);
  }
});
