import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// app.js is a browser module. Run its real notes functions, strict as the
// module is, against fakes that behave like the browser's elements and storage.
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const found = (pattern, what) => app.match(pattern)?.[0] ?? assert.fail(`${what} is present in app.js`);
const fn = (name) => found(new RegExp(`^function ${name}\\([^)]*\\) \\{[^]*?\\n\\}`, 'm'), name);
const line = (name) => found(new RegExp(`^const ${name} = .*$`, 'm'), name);
const limitLine = line('NOTES_LIMIT');
const statusBlock = found(/^const NOTES_STATUS = \{[^]*?\n\};$/m, 'NOTES_STATUS');
const source = [
  "'use strict';",
  ...app.match(/^const \w+_KEY = '[^']*';$/gm),
  // One line each: the pattern for longer functions would run on into the next one.
  found(/^function load\(.*$/m, 'load'),
  found(/^function save\(.*$/m, 'save'),
  limitLine, statusBlock, line('notesView'), line('firstClick'), line('keepFocus'),
  ...['refreshNotes', 'saveNotes', 'renderNotesStatus', 'notesStored', 'openNotes', 'closeNotes', 'notesClosed',
    'isOutsideNotes', 'notesPressed', 'notesClicked', 'guardLeaving', 'confirmLeaving'].map(fn),
  'globalThis.firstClick = firstClick;',
  'globalThis.keepFocus = keepFocus;',
].join('\n');
const LIMIT = runInNewContext(`${limitLine}; NOTES_LIMIT`);
const STATUS = runInNewContext(`${limitLine}\n${statusBlock}; NOTES_STATUS`);
const KEY = 'agentGuild.notes';
/** The side sheet, at the right of a 1360 x 860 window. */
const SHEET = { left: 900, right: 1360, top: 0, bottom: 860 };

/** One open page. `storage` is shared between pages to stand for other tabs or a reload. */
function page({ storage = new Map(), blocked = false, full = false } = {}) {
  const calls = [];
  // `full`: writes throw as at the quota. `readsFail`: reads throw, as when site data is blocked mid-visit.
  const quota = { full, readsFail: false, setItems: 0 };
  const listeners = new Map();
  const element = (id, fields = {}) => ({ id, focus: () => calls.push(`focus ${id}`), ...fields });
  // `translated`: a translator rewrites the line, so its text no longer reads back as written.
  const sub = { text: STATUS.saved, writes: 0, classes: new Set(), translated: false };
  // Like a browser's: setting the text puts the caret at its end, and selections are clamped to it.
  // Written out rather than spread into element(), which would copy the getter's value and drop the setter.
  let text = '';
  const area = {
    id: 'notes-text', selectionStart: 0, selectionEnd: 0,
    focus: () => calls.push('focus notes-text'),
    get value() { return text; },
    set value(next) { text = String(next); this.selectionStart = this.selectionEnd = text.length; },
    setSelectionRange(start, end) { this.selectionStart = Math.min(start, text.length); this.selectionEnd = Math.min(end, text.length); },
  };
  const elements = {
    notes: element('notes', {
      open: false,
      showModal() { this.open = true; calls.push('showModal'); },
      close() { this.open = false; calls.push('close'); },
      getBoundingClientRect: () => SHEET,
    }),
    'notes-open': element('notes-open'),
    'notes-close': element('notes-close'),
    'notes-text': area,
    'notes-sub': {
      get textContent() { return sub.translated ? `Übersetzt: ${sub.text}` : sub.text; },
      set textContent(next) { sub.text = next; sub.writes++; },
      classList: { toggle: (name, on) => (on ? sub.classes.add(name) : sub.classes.delete(name)) },
    },
  };
  const sandbox = {
    $: (id) => elements[id],
    state: { connected: false, sessions: new Map() },
    hideTip: () => calls.push('hideTip'),
    addEventListener: (type, listener) => listeners.set(type, (listeners.get(type) ?? new Set()).add(listener)),
    removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
  };
  // Blocked site data: the page cannot reach localStorage at all.
  if (!blocked) {
    sandbox.localStorage = {
      getItem: (key) => {
        if (quota.readsFail) throw Object.assign(new Error('Access is denied for this document.'), { name: 'SecurityError' });
        return storage.get(key) ?? null;
      },
      setItem: (key, value) => {
        quota.setItems++;
        if (quota.full) throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
        storage.set(key, String(value));
      },
      removeItem: (key) => storage.delete(key),
    };
  }
  runInNewContext(source, sandbox);
  return {
    ...sandbox, calls, storage, quota, sub, area, elements, dialog: elements.notes,
    /** The user edits the text: the input event saves it. */
    type(next) { area.value = next; sandbox.saveNotes(); },
    guarded: () => Boolean(listeners.get('beforeunload')?.has(sandbox.confirmLeaving)),
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
  assert.equal(reloaded.area.selectionStart, 'Release checklist'.length, 'the caret waits at the end, ready for a new line');
  reloaded.type('');
  assert.equal(reloaded.storage.has(KEY), false);
  assert.equal(reloaded.guarded(), false);
});

test('a save the browser refuses warns once, guards against leaving, and clears when a save succeeds', () => {
  const tab = page({ storage: new Map([[KEY, 'kept']]), full: true });
  tab.refreshNotes();
  tab.type('kept, and a paste the browser has no room for');
  tab.type('kept, and a paste the browser has no room for!');
  assert.equal(tab.sub.text, STATUS.refused);
  assert.ok(tab.sub.classes.has('warn'));
  assert.equal(tab.sub.writes, 1, 'the live region is not rewritten on every keystroke');
  assert.equal(tab.storage.get(KEY), 'kept', 'the saved notes are left as they were');
  assert.ok(tab.guarded(), 'closing the page asks first');

  tab.quota.full = false;
  tab.type('kept, and a shorter paste');
  assert.equal(tab.storage.get(KEY), 'kept, and a shorter paste');
  assert.equal(tab.sub.text, STATUS.saved);
  assert.equal(tab.sub.classes.has('warn'), false);
  assert.equal(tab.guarded(), false);
});

test('on a translated page the status line is still rewritten only when the status changes', () => {
  const tab = page({ full: true });
  tab.sub.translated = true;
  for (const text of ['a', 'ab', 'abc']) tab.type(text);
  assert.equal(tab.sub.writes, 1);
  tab.quota.full = false;
  for (const text of ['abcd', 'abcde']) tab.type(text);
  assert.equal(tab.sub.writes, 2);
});

test('reopening keeps the caret where it was', () => {
  const tab = page();
  tab.openNotes();
  tab.type('first line\nsecond line');
  tab.area.setSelectionRange(5, 5);
  tab.closeNotes();
  tab.openNotes();
  assert.deepEqual([tab.area.selectionStart, tab.area.selectionEnd], [5, 5]);
});

test('notes over the limit are not saved, so every other setting keeps room in storage', () => {
  assert.match(STATUS.long, /100,000 characters/);
  const tab = page({ storage: new Map([[KEY, 'short']]) });
  tab.refreshNotes();
  tab.type('x'.repeat(LIMIT));
  assert.equal(tab.storage.get(KEY).length, LIMIT, 'the limit itself is saved');
  tab.type('x'.repeat(LIMIT + 1));
  assert.equal(tab.storage.get(KEY).length, LIMIT, 'one character more is not');
  assert.equal(tab.sub.text, STATUS.long);
  assert.ok(tab.guarded());
  tab.openNotes();
  assert.equal(tab.area.value.length, LIMIT + 1, 'the text over the limit stays in the panel');
  assert.equal(tab.sub.text, STATUS.long);
  tab.type('x'.repeat(LIMIT - 1));
  assert.equal(tab.storage.get(KEY).length, LIMIT - 1);
  assert.equal(tab.sub.text, STATUS.saved);
  assert.equal(tab.guarded(), false);
});

test('with storage blocked the notes are never claimed saved, never wiped, and an empty panel does not hold up leaving', () => {
  const tab = page({ blocked: true });
  tab.openNotes();
  assert.equal(tab.sub.text, STATUS.refused, 'the warning shows before anything is typed');
  assert.equal(tab.guarded(), false);
  tab.type('scratch');
  assert.equal(tab.sub.text, STATUS.refused);
  assert.ok(tab.guarded());
  tab.refreshNotes();
  tab.openNotes();
  assert.equal(tab.area.value, 'scratch', 'storage that cannot be read is not taken for empty notes');
  tab.type('');
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

test('another tab’s notes show here with the caret at their end, and so does a cleared storage', () => {
  const storage = new Map([[KEY, 'hello world']]);
  const tab = page({ storage });
  tab.refreshNotes();
  tab.area.setSelectionRange(2, 2);

  storage.set(KEY, 'NEW hello');
  tab.notesStored({ key: 'agentGuild.cwd' });
  assert.equal(tab.area.value, 'hello world', 'other keys are not the notes');
  tab.notesStored({ key: KEY });
  assert.equal(tab.area.value, 'NEW hello');
  assert.deepEqual([tab.area.selectionStart, tab.area.selectionEnd], [9, 9], 'not left at an offset that now means other text');

  storage.clear();
  tab.notesStored({ key: null });
  assert.equal(tab.area.value, '');
});

test('opening shows notes another tab saved, even with no storage event to say so', () => {
  const storage = new Map([[KEY, 'hello world']]);
  const tab = page({ storage });
  tab.refreshNotes();
  storage.set(KEY, 'hello');
  tab.openNotes();
  assert.equal(tab.area.value, 'hello');
  assert.equal(tab.sub.writes, 0);
});

test('opening with empty notes changes nothing in working storage', () => {
  const storage = new Map();
  const tab = page({ storage });
  tab.openNotes();
  assert.equal(storage.size, 0);
  assert.equal(tab.quota.setItems, 0, 'only a removal of the missing key, which changes nothing');
  assert.equal(tab.sub.text, STATUS.saved);
  assert.equal(tab.sub.writes, 0);
});

test('a read that fails after good ones is not taken for emptied notes', () => {
  const tab = page({ storage: new Map([[KEY, 'kept']]) });
  tab.refreshNotes();
  tab.quota.readsFail = true;
  tab.refreshNotes();
  tab.openNotes();
  assert.equal(tab.area.value, 'kept');
  assert.equal(tab.guarded(), false);
});

test('text that could not be saved stays, until another tab saves newer notes, which win', () => {
  const storage = new Map([[KEY, 'kept']]);
  const tab = page({ storage, full: true });
  tab.refreshNotes();
  tab.type('kept, and much more');
  tab.openNotes();
  tab.notesStored({ key: null });
  assert.equal(tab.area.value, 'kept, and much more', 'nothing new was saved, so the text stays');
  assert.equal(tab.sub.text, STATUS.refused);

  storage.set(KEY, 'kept, and an edit saved in another tab');
  tab.notesStored({ key: KEY });
  assert.equal(tab.area.value, 'kept, and an edit saved in another tab');
  assert.equal(tab.sub.text, STATUS.saved);
  assert.equal(tab.guarded(), false);
  tab.quota.full = false;
  tab.type(`${tab.area.value}!`);
  assert.equal(storage.get(KEY), 'kept, and an edit saved in another tab!', 'the next save builds on them');
});

test('opening focuses the text and hides a tip; closing focuses the Notes button', () => {
  const tab = page();
  tab.openNotes();
  assert.deepEqual(tab.calls, ['hideTip', 'showModal', 'focus notes-text']);
  tab.openNotes();
  assert.equal(tab.calls.filter((call) => call === 'showModal').length, 1, 'an open panel is not opened again');
  tab.closeNotes();
  tab.notesClosed();
  assert.deepEqual(tab.calls.slice(-2), ['close', 'focus notes-open']);
  tab.closeNotes();
  assert.equal(tab.calls.filter((call) => call === 'close').length, 1, 'a closed panel is not closed again');
});

test('only the first click of a double-click counts, so Notes cannot open and at once close', () => {
  const tab = page();
  const runs = [];
  const click = tab.firstClick(() => runs.push('run'));
  for (const detail of [1, 2, 3, 0]) click({ detail });
  assert.equal(runs.length, 2, 'a click, and a keyboard press (detail 0), but not the second or third click');
  // Nor may the second press, landing on Close or the heading, move the focus from the text,
  // though in the text itself it still selects a word.
  const prevented = (detail, target) => {
    let stopped = false;
    tab.keepFocus({ detail, target, preventDefault: () => { stopped = true; } });
    return stopped;
  };
  assert.deepEqual([1, 2, 3].map((detail) => prevented(detail, tab.elements['notes-close'])), [false, true, true]);
  assert.equal(prevented(2, tab.area), false);
});

test('only a press and a release both outside the sheet close the notes', () => {
  const tab = page();
  tab.openNotes();
  const at = (clientX, target = tab.dialog) => ({ target, currentTarget: tab.dialog, clientX, clientY: 400 });
  tab.notesPressed(at(1000, tab.area));
  tab.notesClicked(at(300));
  assert.equal(tab.dialog.open, true, 'a text selection dragged out of the sheet');
  tab.notesPressed(at(300));
  tab.notesClicked(at(1000));
  assert.equal(tab.dialog.open, true, 'a drag from the backdrop into the sheet');
  tab.notesPressed(at(1000));
  tab.notesClicked(at(300));
  assert.equal(tab.dialog.open, true, 'a press on the sheet itself, such as its edge, released outside');
  tab.notesPressed(at(300));
  tab.notesClicked({ target: tab.elements['notes-close'], currentTarget: tab.dialog, clientX: 0, clientY: 0 });
  assert.equal(tab.dialog.open, true, 'a click on a control in the sheet, such as one from the keyboard');
  tab.notesPressed(at(300));
  tab.notesClicked(at(300));
  assert.equal(tab.dialog.open, false);
});

test('the page wires the notes up and has their controls', () => {
  for (const wiring of [
    "$('notes-open').addEventListener('click', firstClick(openNotes));",
    "$('notes-close').addEventListener('click', firstClick(closeNotes));",
    "$('notes').addEventListener('mousedown', keepFocus);",
    // Close lies over Stop manager: the second click of a double-click on it must not stop the manager.
    "$('stop-manager').addEventListener('click', firstClick(() => stopManager()));",
    "$('restart-manager').addEventListener('click', firstClick(() => stopManager({ restart: true })));",
    "$('notes').addEventListener('pointerdown', notesPressed);",
    "$('notes').addEventListener('click', notesClicked);",
    "$('notes').addEventListener('close', notesClosed);",
    "$('notes-text').addEventListener('input', saveNotes);",
    "addEventListener('storage', notesStored);",
    "addEventListener('pageshow', refreshNotes);",
  ]) assert.ok(app.includes(`\n${wiring}\n`), wiring);

  const topbar = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>'));
  assert.match(topbar, /<button id="notes-open" class="btn notes-open" type="button" aria-haspopup="dialog">Notes<\/button>/);
  // `.appearance:has(+ :popover-open)` turns the chevron, so nothing may come between the button and its menu.
  assert.match(topbar, />Appearance<\/button>\s*<div id="appearance-menu"[^>]*>[^]*?<\/div>\s*<button id="notes-open"/,
    'Notes comes right after the Appearance menu, which comes right after its button');
  assert.match(html, /<dialog id="notes" class="news-panel notes-panel" aria-labelledby="notes-title">/);
  assert.match(html, /<textarea id="notes-text" class="notes-text" aria-labelledby="notes-title" aria-describedby="notes-sub" autocomplete="off"/);
  assert.ok(html.includes(`<p id="notes-sub" class="sub" aria-live="polite">${STATUS.saved}</p>`), 'the status line starts as the page writes it');
});
