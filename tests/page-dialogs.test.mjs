import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { YardPhoto } from '../web/yard/photo.js';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const dialogs = [...html.matchAll(/<dialog id="([a-z-]+)"/g)].map((m) => m[1]);

const source = ['closeDialogs', 'closeModels', 'closeNews', 'closeChangelog', 'closeVideos', 'closeAccounts', 'closeFlags', 'closeMemory', 'showAuth', 'enterStopping'].map((name) => {
  const found = app.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(found, `${name} is present`);
  return found;
}).join('\n');

function page() {
  const elements = new Map(), closeEvents = [];
  let focused = null;
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, Object.assign(new EventTarget(), {
      open: false, hidden: false, textContent: '',
      showModal() { this.open = true; },
      close() {
        if (!this.open) return;
        this.open = false;
        closeEvents.push(() => this.dispatchEvent(new Event('close')));
      },
      focus() { focused = this; },
    }));
    return elements.get(id);
  };
  const noop = () => {};
  const context = {
    $,
    yardUi: { closePhoto: () => $('yard-photo-dialog').close() },
    state: {
      eventsSocket: null, views: new Map(), sessions: new Map(),
      environmentUI: { close: () => $('environment').close() },
      remoteAccessUI: { close: () => $('remote-access').close(), setAvailable: (capability) => { if (!capability) $('remote-access').close(); } },
      glassesLinkUI: { close: () => $('glasses').close(), setAvailable: (capability) => { if (!capability) $('glasses').close(); } },
    },
    closePanel: () => $('terminal-copy').close(),
    closeHistory: () => $('history').close(),
    closeGitHub: noop,
    managerLoss: { cancel: noop },
    renderSessions: noop, showStopped: noop, setConnection: noop, restartGaveUp: noop,
    setTimeout: noop, clearTimeout: noop, RESTART_WAIT_MS: 0, restartTimer: undefined,
  };
  const api = runInNewContext(`${source}\n({ showAuth, enterStopping })`, context);
  return { ...api, $, yardUi: context.yardUi, get focused() { return focused; }, releaseClose() { closeEvents.splice(0).forEach((close) => close()); } };
}

// Seed a captured picture; these tests exercise closing, not rendering the Yard.
function photo(p) {
  const dialog = p.$('yard-photo-dialog');
  dialog.querySelector = (selector) => p.$(`photo:${selector}`);
  const photo = new YardPhoto(dialog);
  p.yardUi.closePhoto = () => photo.close();
  photo.opener = p.$('yard-photo');
  photo.shot = { canvas: { width: 640, height: 480 }, skin: 'guild' };
  photo.preview.width = 640; photo.preview.height = 480;
  return photo;
}

test('signing out, stopping or restarting closes every dialog and releases the Photo capture', (t) => {
  const revoke = t.mock.method(URL, 'revokeObjectURL');
  assert.ok(dialogs.includes('accounts') && dialogs.includes('memory'), 'the page lists its dialogs');
  for (const leave of ['sign out', 'stop', 'restart']) {
    const p = page();
    const picture = photo(p), canvas = picture.shot.canvas;
    picture.blob = new Blob(['picture'], { type: 'image/png' });
    picture.png = Promise.resolve(picture.blob);
    const url = picture.url = URL.createObjectURL(picture.blob);
    for (const id of dialogs) p.$(id).open = true;
    if (leave === 'sign out') p.showAuth('Sign in again.');
    else p.enterStopping(0, leave === 'restart');
    assert.deepEqual(dialogs.filter((id) => p.$(id).open), [], leave);
    p.releaseClose();
    assert.equal(picture.shot, null, leave);
    assert.equal(canvas.width, 0, leave);
    assert.deepEqual([picture.preview.width, picture.preview.height], [0, 0], leave);
    assert.equal(picture.png, null, leave);
    assert.equal(picture.blob, null, leave);
    assert.equal(picture.url, '', leave);
    assert.ok(revoke.mock.calls.some((call) => call.arguments[0] === url), leave);
  }
});

test('a queued Photo close does not clear a reopened capture or move focus', () => {
  const p = page(), picture = photo(p), dialog = picture.dialog;
  dialog.showModal();
  dialog.close();
  const shot = picture.shot = { canvas: { width: 800, height: 600 }, skin: 'guild' };
  picture.preview.width = 800; picture.preview.height = 600;
  dialog.showModal();
  picture.saveButton.focus();
  p.releaseClose();
  assert.equal(dialog.open, true);
  assert.equal(picture.shot, shot);
  assert.deepEqual([shot.canvas.width, shot.canvas.height], [800, 600]);
  assert.deepEqual([picture.preview.width, picture.preview.height], [800, 600]);
  assert.equal(p.focused, picture.saveButton);
  dialog.close();
  p.releaseClose();
  assert.equal(picture.shot, null, 'the current close still releases the capture');
  assert.equal(p.focused, picture.opener);
});

test('Save discards encoding completed after Photo closes and still downloads while open', async (t) => {
  const createURL = t.mock.method(URL, 'createObjectURL', () => 'blob:yard-photo-test');
  const download = t.mock.fn();
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true, value: { createElement: () => ({ click: download }) },
  });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
  });
  for (const closed of [true, false]) {
    const p = page(), picture = photo(p);
    picture.taken = new Date('2026-10-28T12:00:00Z');
    let finishEncoding;
    picture.preview.toBlob = (callback) => { finishEncoding = callback; };
    picture.dialog.showModal();
    const saving = picture.save();
    assert.equal(typeof finishEncoding, 'function');
    if (closed) {
      picture.dialog.close();
      p.releaseClose();
    }
    const blob = new Blob(['picture'], { type: 'image/png' });
    finishEncoding(blob);
    await saving;
    assert.equal(createURL.mock.callCount(), closed ? 0 : 1);
    assert.equal(download.mock.callCount(), closed ? 0 : 1);
    assert.equal(picture.url, closed ? '' : 'blob:yard-photo-test');
    assert.equal(picture.blob, closed ? null : blob);
    if (closed) assert.equal(picture.png, null);
    else assert.equal(picture.status.textContent, 'Saved ' + picture.name());
    picture.dialog.close();
    p.releaseClose();
  }
});

// The page globals YardPhoto.open() reads, restored after the test.
function photoGlobals(t) {
  const document = { documentElement: {}, fonts: {} };
  for (const [key, value] of Object.entries({
    document, window: { isSecureContext: false },
    getComputedStyle: () => ({ getPropertyValue: () => 'serif' }),
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete globalThis[key];
    });
  }
  return document;
}

test('Photo opens without checkVisibility while the stage is connected and sized, and not once it is detached', async (t) => {
  const document = photoGlobals(t);
  document.fonts.load = async () => {};
  for (const connected of [true, false]) {
    const p = page(), picture = photo(p), stage = p.$('yard-stage');
    picture.clear();
    picture.labels.parentElement = {};
    picture.crest = Promise.resolve(null);
    Object.assign(stage, { isConnected: connected, clientWidth: 640, clientHeight: 480 });
    document.getElementById = p.$;
    const renderer = { capture: t.mock.fn(() => ({ canvas: { width: 1280, height: 960 }, skin: 'guild' })) };
    t.mock.method(picture, 'draw', () => {});
    await picture.open(renderer, picture.opener);
    assert.equal(renderer.capture.mock.callCount(), connected ? 1 : 0);
    assert.equal(picture.dialog.open, connected);
  }
});

test('a preview that cannot be drawn opens Photo with the capture error and only Done', async (t) => {
  const document = photoGlobals(t);
  document.fonts.load = async () => {};
  const p = page(), picture = photo(p), stage = p.$('yard-stage');
  picture.clear();
  picture.labels.parentElement = {};
  picture.crest = Promise.resolve(null);
  picture.preview.getContext = () => null;
  Object.assign(stage, { isConnected: true, clientWidth: 640, clientHeight: 480 });
  document.getElementById = p.$;
  const canvas = { width: 1280, height: 960 };
  await picture.open({ capture: () => ({ canvas, scale: 2, skin: 'guild', tags: [] }) }, picture.opener);
  assert.equal(picture.dialog.open, true);
  assert.equal(picture.status.textContent, 'Couldn’t take the picture.');
  assert.deepEqual([picture.saveButton, picture.copyButton, picture.shareButton, picture.labels.parentElement].map((e) => e.hidden), [true, true, true, true]);
  assert.equal(p.focused, p.$('photo:[data-done]'));
  assert.equal(picture.shot, null);
  assert.equal(canvas.width, 0, 'the failed capture is released');
});

test('pending Photo opens are invalidated by Yard shutdown, sign-out and manager stop or restart', async (t) => {
  const yard = readFileSync(new URL('../web/yard/view.js', import.meta.url), 'utf8');
  const dispose = yard.match(/dispose\(\) \{[^]*?\n  \}/)?.[0];
  assert.ok(dispose);
  const document = photoGlobals(t);
  for (const leave of ['Yard shutdown', 'sign out', 'stop', 'restart']) {
    const p = page(), picture = photo(p), stage = p.$('yard-stage');
    picture.clear();
    picture.labels.parentElement = {};
    Object.assign(stage, { clientWidth: 640, clientHeight: 480, checkVisibility() { return !this.hidden; } });
    document.getElementById = p.$;
    let finishFonts, finishImage;
    const fonts = new Promise((resolve) => { finishFonts = resolve; });
    document.fonts.load = () => fonts;
    picture.crest = new Promise((resolve) => { finishImage = resolve; });
    const renderer = { capture: t.mock.fn(() => ({ canvas: { width: stage.clientWidth, height: stage.clientHeight }, skin: 'guild' })) };
    const draw = t.mock.method(picture, 'draw', () => { throw new DOMException('The stage is empty', 'InvalidStateError'); });
    const version = picture.version;
    const opening = picture.open(renderer, picture.opener);
    assert.equal(picture.opening, true, leave);
    if (leave === 'Yard shutdown') {
      const noop = () => {};
      runInNewContext(`({ ${dispose} }).dispose()`, {
        closePhoto: p.yardUi.closePhoto, disposed: false, sceneAttempt: 0, worldAttempt: 0,
        clearTimeout: noop, swapReveal: 0, observer: { disconnect: noop }, pendingRenderer: null, renderer: null,
        document: { removeEventListener: noop }, motion: { removeEventListener: noop }, window: { removeEventListener: noop },
        visibility: noop, motionChange: noop, pageHide: noop,
      });
    } else if (leave === 'sign out') p.showAuth('Sign in again.');
    else p.enterStopping(0, leave === 'restart');
    const invalidated = picture.version !== version;
    stage.hidden = true;
    stage.clientWidth = stage.clientHeight = 0;
    finishFonts(); finishImage(null);
    await assert.doesNotReject(opening, leave);
    assert.equal(invalidated, true, leave);
    assert.equal(renderer.capture.mock.callCount(), 0, leave);
    assert.equal(draw.mock.callCount(), 0, leave);
    assert.equal(picture.dialog.open, false, leave);
    assert.equal(picture.opening, false, leave);
    assert.equal(picture.shot, null, leave);
    assert.equal(picture.png, null, leave);
    assert.equal(picture.blob, null, leave);
    assert.equal(picture.url, '', leave);
    assert.deepEqual([picture.preview.width, picture.preview.height], [0, 0], leave);
  }
});
