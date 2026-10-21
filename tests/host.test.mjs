import test from 'node:test';
import assert from 'node:assert/strict';

let loads = 0;

/** web/host.js loaded into a fake page; `framed` decides whether its parent is another window. */
async function host({ framed, writeText, execCommand = () => true }) {
  const posted = [], opened = [], listeners = {}, copied = [];
  const win = { open: (...args) => opened.push(args) };
  win.parent = framed ? { postMessage: (message, origin) => posted.push({ message, origin }) } : win;
  const document = {
    activeElement: null,
    body: { append: (area) => { area.parent = 'body'; } },
    addEventListener: (type, listener) => { listeners[type] = listener; },
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, setAttribute() {}, select() { document.selected = this; }, remove() {} }),
    execCommand: (command) => { copied.push([command, document.selected.value]); return execCommand(); },
  };
  const globals = {
    window: win, document, location: { href: 'http://127.0.0.1:47821/' },
    navigator: { clipboard: { writeText } },
  };
  // The module reads these when called too, so each page's stay until the next page or the end of the file.
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const module = await import(`../web/host.js?load=${++loads}`);
  return { module, posted, opened, listeners, copied };
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
