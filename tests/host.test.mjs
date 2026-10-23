import test from 'node:test';
import assert from 'node:assert/strict';

let loads = 0;

/**
 * web/host.js loaded into a fake page; `framed` decides whether its parent is another window, `app` whether the Apple app's
 * handler exists, and `android` what the Android app's listener puts at window.agentGuild.
 */
async function host({ framed, app = false, android, layout, writeText, execCommand = () => true }) {
  const posted = [], opened = [], listeners = {}, copied = [], appPosted = [], observers = [];
  const win = { open: (...args) => opened.push(args), addEventListener: (type, listener) => { listeners[`window.${type}`] = listener; } };
  win.parent = framed ? { postMessage: (message, origin) => posted.push({ message, origin }) } : win;
  if (app) win.webkit = { messageHandlers: { agentGuild: { postMessage: (message) => appPosted.push(message) } } };
  if (android === true) {
    // Like Android's WebMessageListener object, which refuses anything but a string.
    win.agentGuild = { postMessage: (message) => {
      if (typeof message !== 'string') throw new TypeError('not a string');
      appPosted.push(message);
    } };
  } else if (android !== undefined) win.agentGuild = android;
  const document = {
    documentElement: { dataset: { skin: 'guild', theme: 'dark', ...(layout ? { layout } : {}) } },
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
    MutationObserver: class { constructor(callback) { observers.push(callback); } observe() {} },
  };
  // The module reads these when called too, so each page's stay until the next page or the end of the file.
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const module = await import(`../web/host.js?load=${++loads}`);
  return { module, posted, opened, listeners, copied, appPosted, observers };
}

const saved = Object.fromEntries(['window', 'document', 'location', 'navigator', 'MutationObserver'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
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
    { message: { source: 'agent-guild', type: 'look', skin: 'guild', theme: 'dark' }, origin: '*' },
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

test('a framed page tells its extension its look as it changes, and opens the session its extension names', async () => {
  const framed = await host({ framed: true });
  document.documentElement.dataset.skin = 'grove';
  for (const observer of framed.observers) observer();
  assert.deepEqual(framed.posted.map(({ message }) => [message.type, message.skin]), [['look', 'guild'], ['look', 'grove']]);

  const opened = [];
  framed.module.onSessionRequest((id) => opened.push(id));
  const send = (source, data) => framed.listeners['window.message']({ source, data });
  send(window.parent, { source: 'agent-guild-vscode', type: 'session', id: 's1' });
  send({}, { source: 'agent-guild-vscode', type: 'session', id: 's2' });
  send(window.parent, { source: 'agent-guild-vscode', type: 'session', id: 3 });
  send(window.parent, { source: 'agent-guild', type: 'session', id: 's4' });
  assert.deepEqual(opened, ['s1']);
});

test('a compact page asks its host for the full page, and keeps its look to itself', async () => {
  const compact = await host({ framed: true, layout: 'compact' });
  assert.equal(compact.module.compact, true);
  compact.module.expand('s1');
  compact.module.expand();
  assert.deepEqual(compact.posted.map(({ message }) => message), [
    { source: 'agent-guild', type: 'expand', session: 's1' },
    { source: 'agent-guild', type: 'expand' },
  ]);

  const page = await host({ framed: false, layout: 'compact' });
  assert.equal(page.module.compact, false, 'only a host can make the page compact');
  page.module.expand('s1');
  assert.deepEqual([page.posted, page.opened], [[], []]);
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

test('the Android app gets links and readiness as JSON text, and only its own page can ask for a view', async () => {
  const page = await host({ framed: false, android: true });
  assert.equal(page.module.framed, false);
  const link = click('https://github.com/login/device');
  page.listeners.click(link);
  assert.equal(link.prevented, true);
  page.module.openLink('file:///etc/passwd');
  page.module.announceReady('1.8.0');
  assert.deepEqual(page.appPosted.map((text) => JSON.parse(text)), [
    { source: 'agent-guild', type: 'open', url: 'https://github.com/login/device' },
    { source: 'agent-guild', type: 'ready', version: '1.8.0' },
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
  assert.deepEqual(shown, ['yard']);

  const compact = await host({ framed: false, android: true, layout: 'compact' });
  assert.equal(compact.module.compact, true);
  compact.module.expand('s1');
  assert.deepEqual(compact.appPosted.map((text) => JSON.parse(text)), [{ source: 'agent-guild', type: 'expand', session: 's1' }]);

  const framed = await host({ framed: true, android: true });
  framed.module.announceReady('1.8.0');
  assert.deepEqual(framed.appPosted, [], 'a framed page answers only its frame host');
});

test('a window.agentGuild without postMessage is not a host', async () => {
  for (const android of [{}, { postMessage: 'text' }, null]) {
    const page = await host({ framed: false, android });
    page.module.openLink('https://example.com/');
    assert.deepEqual(page.opened, [['https://example.com/', '_blank', 'noopener,noreferrer']]);
    assert.equal(page.listeners.click, undefined);
  }
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
