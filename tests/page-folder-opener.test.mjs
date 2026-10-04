import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const source = ['renderFolderTools', 'pickWorkingFolder', 'openWorkingFolder'].map((name) => app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0]).join('\n');

function page(onApi = async () => ({})) {
  const tool = () => ({ attrs: {}, setAttribute(key, value) { this.attrs[key] = value; } });
  const button = tool(), pick = tool();
  const input = { value: "  /work/space & 'notes'  " };
  const messages = [], requests = [], auth = [], used = [];
  const context = {
    state: { connected: true, folderOpener: { available: true, label: 'Finder' }, folderOpening: false, folderPicker: { available: true }, folderPicking: false },
    $: (id) => ({ 'cwd-open': button, 'cwd-pick': pick })[id] || input,
    useFolder: (dir) => used.push(dir),
    api: async (...args) => { requests.push(args); return onApi(); },
    toast: (message) => messages.push(message),
    showAuth: (message) => { auth.push(message); context.state.connected = false; },
    AuthError: class extends Error {},
  };
  runInNewContext(source, context);
  return { context, button, pick, input, messages, requests, auth, used };
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

test('choosing asks for a folder from the current field, uses the answer, and leaves the field alone on cancel', async () => {
  let finish;
  const p = page(() => new Promise((resolve) => { finish = resolve; }));
  const pending = p.context.pickWorkingFolder();
  assert.equal(p.pick.disabled, true);
  assert.equal(p.pick.attrs['aria-busy'], 'true');
  assert.equal(p.button.disabled, false, 'the folder can still be opened while the dialog is up');
  await p.context.pickWorkingFolder();
  assert.equal(p.requests.length, 1);
  assert.equal(p.requests[0][1], '/pick-folder');
  assert.equal(p.requests[0][2].cwd, "/work/space & 'notes'");
  finish({ path: '/picked' });
  await pending;
  assert.deepEqual(p.used, ['/picked']);
  assert.equal(p.pick.disabled, false);
  p.context.api = async () => ({ path: null });
  await p.context.pickWorkingFolder();
  assert.deepEqual(p.used, ['/picked']);
  assert.deepEqual(p.messages, []);
});

test('the choose button explains an unavailable dialog and reports failures', async () => {
  const p = page(async () => { throw new Error('Could not show the folder dialog.'); });
  await p.context.pickWorkingFolder();
  assert.deepEqual(p.messages, ['Could not show the folder dialog.']);
  assert.equal(p.pick.disabled, false);
  p.context.state.folderPicker = { available: false, reason: 'Install zenity or kdialog to choose folders.' };
  p.context.renderFolderTools();
  assert.equal(p.pick.disabled, true);
  assert.equal(p.pick.title, 'Install zenity or kdialog to choose folders.');
  await p.context.pickWorkingFolder();
  assert.equal(p.requests.length, 1);
});