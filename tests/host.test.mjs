import test from 'node:test';
import assert from 'node:assert/strict';

let loads = 0;

/** web/host.js loaded into a fake page; `framed` decides whether its parent is another window, `app` whether the Apple app's handler exists. */
async function host({ framed, app = false, writeText, execCommand = () => true }) {
  const posted = [], opened = [], listeners = {}, copied = [], appPosted = [];
  const win = { open: (...args) => opened.push(args), addEventListener: (type, listener) => { listeners[`window.${type}`] = listener; } };
  win.parent = framed ? { postMessage: (message, origin) => posted.push({ message, origin }) } : win;
  if (app) win.webkit = { messageHandlers: { agentGuild: { postMessage: (message) => appPosted.push(message) } } };
  const document = {
    activeElement: null,
    body: { append: (area) => { area.parent = 'body'; } },
    addEventListener: (type, listener) => { listeners[type] = listener; },
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, setAttribute() {}, select() { document.selected = this; }, remove() {} }),
    execCommand: (command) => { copied.push([command, document.selected.value]); return execCommand(); },
  };
  const globals = {
    window: win, document, location: { href: 'http://127.0.0.1:47821/', origin: 'http://127.0.0.1:47821' },
    navigator: { clipboard: { writeText } },
  };
  // The module reads these when called too, so each page's stay until the next page or the end of the file.
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const module = await import(`../web/host.js?load=${++loads}`);
  return { module, posted, opened, listeners, copied, appPosted };
}

const saved = Object.fromEntries(['window', 'document', 'location', 'navigator'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
test.after(() => {
  for (const [key, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

const click = (href) => {
  const event = { button: 0, prevented: false, preventDefault() { this.prevented = true; }, target: { closest: () => (href ? { href } : null) } };
  return event;
};

test('a framed page sends http(s) links to the extension and an unframed one opens a tab', async () => {
  const framed = await host({ framed: true });
  const link = click('https://github.com/login/device');
  framed.listeners.click(link);
  assert.equal(link.prevented, true);
  framed.module.openLink('file:///etc/passwd');
  framed.module.openLink('javascript:alert(1)');
  framed.module.announceReady('1.2.0');
  assert.deepEqual(framed.posted, [
    { message: { source: 'agent-guild', type: 'open', url: 'https://github.com/login/device' }, origin: '*' },
    { message: { source: 'agent-guild', type: 'ready', version: '1.2.0' }, origin: '*' },
  ]);
  assert.deepEqual(framed.opened, []);

  const page = await host({ framed: false });
  assert.equal(page.module.framed, false);
  assert.equal(page.listeners.click, undefined, 'an unframed page leaves links alone');
  page.module.openLink('https://example.com/');
  page.module.announceReady('1.2.0');
  assert.deepEqual(page.opened, [['https://example.com/', '_blank', 'noopener,noreferrer']]);
  assert.deepEqual(page.posted, []);
});

test('a framed page shows the view its extension names, and only its extension', async () => {
  const framed = await host({ framed: true });
  const shown = [];
  framed.module.onViewRequest((view) => shown.push(view));
  const send = (source, data) => framed.listeners['window.message']({ source, data });
  send(window.parent, { source: 'agent-guild-vscode', type: 'view', view: 'yard' });
  send({}, { source: 'agent-guild-vscode', type: 'view', view: 'cards' });
  send(window.parent, { source: 'agent-guild-vscode', type: 'view', view: 'map' });
  send(window.parent, null);
  assert.deepEqual(shown, ['yard']);

  const page = await host({ framed: false });
  assert.equal(page.listeners['window.message'], undefined, 'an unframed page takes no requests');
});

test('the Apple app gets links and readiness, and only its own page can ask for a view', async () => {
  const page = await host({ framed: false, app: true });
  assert.equal(page.module.framed, false);
  const link = click('https://github.com/login/device');
  page.listeners.click(link);
  assert.equal(link.prevented, true);
  page.module.openLink('file:///etc/passwd');
  page.module.announceReady('1.4.0');
  assert.deepEqual(page.appPosted, [
    { source: 'agent-guild', type: 'open', url: 'https://github.com/login/device' },
    { source: 'agent-guild', type: 'ready', version: '1.4.0' },
  ]);
  assert.deepEqual([page.opened, page.posted], [[], []]);

  const shown = [];
  page.module.onViewRequest((view) => shown.push(view));
  const send = (source, origin, data) => page.listeners['window.message']({ source, origin, data });
  const own = 'http://127.0.0.1:47821';
  send(window, own, { source: 'agent-guild-app', type: 'view', view: 'yard' });
  send({}, own, { source: 'agent-guild-app', type: 'view', view: 'cards' });
  send(window, 'https://www.youtube-nocookie.com', { source: 'agent-guild-app', type: 'view', view: 'cards' });
  send(window, own, { source: 'agent-guild-vscode', type: 'view', view: 'cards' });
  send(window, own, { source: 'agent-guild-app', type: 'view', view: 'cards' });
  assert.deepEqual(shown, ['yard', 'cards'], 'one transition per request from the page itself');

  const framed = await host({ framed: true, app: true });
  framed.module.announceReady('1.4.0');
  assert.deepEqual(framed.appPosted, [], 'a framed page answers only its frame host');
});

test('copying falls back to execCommand when the clipboard API is refused', async () => {
  const refused = Object.assign(new Error('Write permission denied.'), { name: 'NotAllowedError' });
  const framed = await host({ framed: true, writeText: () => Promise.reject(refused) });
  await framed.module.copyToClipboard('session-id');
  assert.deepEqual(framed.copied, [['copy', 'session-id']]);

  const failing = await host({ framed: true, writeText: () => Promise.reject(refused), execCommand: () => false });
  await assert.rejects(failing.module.copyToClipboard('x'), refused);

  const page = await host({ framed: false, writeText: () => Promise.resolve() });
  await page.module.copyToClipboard('x');
  assert.deepEqual(page.copied, [], 'the clipboard API is used when it works');
});
