import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// app.js is a browser module. Run its real notes functions, strict as the
// module is, against fake elements and a fake localStorage.
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const found = (pattern, what) => app.match(pattern)?.[0] ?? assert.fail(`${what} is present in app.js`);
const fn = (name) => found(new RegExp(`^function ${name}\\([^)]*\\) \\{[^]*?\\n\\}`, 'm'), name);
const source = [
  "'use strict';",
  ...app.match(/^const \w+_KEY = '[^']*';$/gm),
  // One line each: the pattern for longer functions would run on into the next one.
  found(/^function load\(.*$/m, 'load'),
  found(/^function save\(.*$/m, 'save'),
  ...['NOTES_SAVED', 'NOTES_UNSAVED', 'notesView'].map((name) => found(new RegExp(`^const ${name} = .*$`, 'm'), name)),
  ...['refreshNotes', 'saveNotes', 'renderNotesStatus', 'notesStored', 'openNotes', 'closeNotes', 'notesClosed',
    'notesPressed', 'notesClicked', 'guardLeaving', 'confirmLeaving'].map(fn),
].join('\n');
const SAVED = runInNewContext(`${found(/^const NOTES_SAVED = .*$/m, 'NOTES_SAVED')}; NOTES_SAVED`);
const KEY = 'agentGuild.notes';

/** One open page. `storage` is shared between pages to stand for other tabs or a reload. */
function page({ storage = new Map(), blocked = false, full = false, coarse = false } = {}) {
  const calls = [];
  const quota = { full };
  const leaving = new Set();
  const element = (id, fields = {}) => ({ id, focus: () => calls.push(`focus ${id}`), ...fields });
  const sub = { text: SAVED, writes: 0, classes: new Set() };
  const elements = {
    notes: element('notes', {
      open: false,
      showModal() { this.open = true; calls.push('showModal'); },
      close() { this.open = false; calls.push('close'); },
    }),
    'notes-open': element('notes-open'),
    'notes-close': element('notes-close'),
    'notes-text': element('notes-text', {
      value: '', selectionStart: 0, selectionEnd: 0,
      setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    }),
    'notes-sub': {
      get textContent() { return sub.text; },
      set textContent(text) { sub.text = text; sub.writes++; },
      classList: { toggle: (name, on) => (on ? sub.classes.add(name) : sub.classes.delete(name)) },
    },
  };
  const sandbox = {
    $: (id) => elements[id],
    state: { connected: false, sessions: new Map() },
    coarsePointer: { matches: coarse },
    hideTip: () => calls.push('hideTip'),
    addEventListener: (type, listener) => leaving.add(`${type}:${listener.name}`),
    removeEventListener: (type, listener) => leaving.delete(`${type}:${listener.name}`),
  };
  // Blocked site data: the page cannot reach localStorage at all.
  if (!blocked) {
    sandbox.localStorage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        if (quota.full) throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
        storage.set(key, String(value));
      },
      removeItem: (key) => storage.delete(key),
    };
  }
  runInNewContext(source, sandbox);
  const area = elements['notes-text'];
  return {
    ...sandbox, calls, storage, quota, sub, area, dialog: elements.notes,
    /** The user edits the text: the input event saves it. */
    type(text) { area.value = text; sandbox.saveNotes(); },
    guarded: () => leaving.has('beforeunload:confirmLeaving'),
  };
}

test('notes save as they are typed, come back after a reload, and clearing them removes the saved copy', () => {
  const tab = page();
  tab.type('Release checklist');
  assert.equal(tab.storage.get(KEY), 'Release checklist');
  assert.equal(tab.sub.writes, 0, 'the status line already says they are saved');

  const reloaded = page({ storage: tab.storage });
  reloaded.refreshNotes();
  assert.equal(reloaded.area.value, 'Release checklist');
  reloaded.type('');
  assert.equal(reloaded.storage.has(KEY), false);
  assert.equal(reloaded.guarded(), false);
});

test('a save the browser refuses warns once, guards against leaving, and clears when a save succeeds', () => {
  const tab = page({ storage: new Map([[KEY, 'kept']]), full: true });
  tab.refreshNotes();
  tab.type('kept, and a paste too large for the quota');
  tab.type('kept, and a paste too large for the quota!');
  assert.match(tab.sub.text, /^Not saved: /);
  assert.ok(tab.sub.classes.has('warn'));
  assert.equal(tab.sub.writes, 1, 'the live region is not rewritten on every keystroke');
  assert.equal(tab.storage.get(KEY), 'kept', 'the saved notes are left as they were');
  assert.ok(tab.guarded(), 'closing the page asks first');

  tab.quota.full = false;
  tab.type('kept, and a shorter paste');
  assert.equal(tab.storage.get(KEY), 'kept, and a shorter paste');
  assert.equal(tab.sub.text, SAVED);
  assert.equal(tab.sub.classes.has('warn'), false);
  assert.equal(tab.guarded(), false);
});

test('with storage blocked the notes are never claimed saved, and an empty panel does not hold up leaving', () => {
  const tab = page({ blocked: true });
  tab.refreshNotes();
  assert.equal(tab.area.value, '');
  tab.type('scratch');
  assert.match(tab.sub.text, /^Not saved: /);
  assert.ok(tab.guarded());
  tab.type('');
  assert.match(tab.sub.text, /^Not saved: /);
  assert.equal(tab.guarded(), false, 'nothing is left to lose');
});

test('running sessions still guard against leaving whatever the notes do', () => {
  const tab = page();
  tab.state.connected = true;
  tab.state.sessions.set('s1', { status: 'running' });
  tab.type('saved');
  assert.ok(tab.guarded());
  tab.state.sessions.set('s1', { status: 'exited' });
  tab.guardLeaving();
  assert.equal(tab.guarded(), false);
});

test('another tab’s notes show here with the caret kept in range, and so does a cleared storage', () => {
  const storage = new Map([[KEY, 'hello world']]);
  const tab = page({ storage });
  tab.refreshNotes();
  tab.area.setSelectionRange(6, 11);

  storage.set(KEY, 'hello');
  tab.notesStored({ key: 'agentGuild.cwd' });
  assert.equal(tab.area.value, 'hello world', 'other keys are not the notes');
  tab.notesStored({ key: KEY });
  assert.equal(tab.area.value, 'hello');
  assert.deepEqual([tab.area.selectionStart, tab.area.selectionEnd], [5, 5]);

  storage.clear();
  tab.notesStored({ key: null });
  assert.equal(tab.area.value, '');
});

test('text the browser refused is never replaced by another tab’s notes, even on reopening', () => {
  const storage = new Map([[KEY, 'kept']]);
  const tab = page({ storage, full: true });
  tab.refreshNotes();
  tab.type('kept, and much more');
  storage.set(KEY, 'written in another tab');
  tab.notesStored({ key: KEY });
  tab.openNotes();
  assert.equal(tab.area.value, 'kept, and much more');
  assert.match(tab.sub.text, /^Not saved: /);
});

test('opening focuses the text, except on a touch screen; closing focuses the Notes button', () => {
  const desk = page();
  desk.openNotes();
  assert.deepEqual(desk.calls, ['hideTip', 'showModal', 'focus notes-text']);
  desk.openNotes();
  assert.equal(desk.calls.filter((call) => call === 'showModal').length, 1, 'an open panel is not opened again');
  desk.closeNotes();
  desk.notesClosed();
  assert.deepEqual(desk.calls.slice(-2), ['close', 'focus notes-open']);
  desk.closeNotes();
  assert.equal(desk.calls.filter((call) => call === 'close').length, 1, 'a closed panel is not closed again');

  const touch = page({ coarse: true });
  touch.openNotes();
  assert.deepEqual(touch.calls, ['hideTip', 'showModal'], 'focus stays on Close, where showModal put it');
});

test('a click on the backdrop closes the notes, but not one that ends a text selection dragged out of them', () => {
  const tab = page();
  tab.openNotes();
  const at = (target) => ({ target, currentTarget: tab.dialog });
  tab.notesPressed(at(tab.area));
  tab.notesClicked(at(tab.dialog));
  assert.equal(tab.dialog.open, true);
  tab.notesPressed(at(tab.dialog));
  tab.notesClicked(at(tab.area));
  assert.equal(tab.dialog.open, true, 'a click inside never closes them');
  tab.notesPressed(at(tab.dialog));
  tab.notesClicked(at(tab.dialog));
  assert.equal(tab.dialog.open, false);
});

test('the page wires the notes up and has their controls', () => {
  for (const line of [
    "$('notes-open').addEventListener('click', openNotes);",
    "$('notes-close').addEventListener('click', closeNotes);",
    "$('notes').addEventListener('pointerdown', notesPressed);",
    "$('notes').addEventListener('click', notesClicked);",
    "$('notes').addEventListener('close', notesClosed);",
    "$('notes-text').addEventListener('input', saveNotes);",
    "addEventListener('storage', notesStored);",
    'refreshNotes();',
  ]) assert.ok(app.includes(`\n${line}\n`), line);

  const topbar = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>'));
  assert.match(topbar, /<button id="notes-open" class="btn notes-open" type="button" aria-haspopup="dialog">Notes<\/button>/);
  assert.match(topbar, /id="appearance-menu"[^]*id="notes-open"/, 'the Appearance menu stays right after its button');
  assert.match(html, /<dialog id="notes" class="news-panel notes-panel" aria-labelledby="notes-title">/);
  assert.match(html, /<textarea id="notes-text" class="notes-text" aria-labelledby="notes-title" aria-describedby="notes-sub" autocomplete="off"/);
  assert.ok(html.includes(`<p id="notes-sub" class="sub" aria-live="polite">${SAVED}</p>`), 'the status line starts as the page writes it');
});
