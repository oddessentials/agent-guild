import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// app.js is a browser module. Run its real notes functions, strict as the
// module is, against fakes that behave like the browser's elements and storage.
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const found = (pattern, what) => app.match(pattern)?.[0] ?? assert.fail(`${what} is present in app.js`);
const fn = (name) => found(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[^]*?\\n\\}`, 'm'), name);
const line = (name) => found(new RegExp(`^const ${name} = .*$`, 'm'), name);
const limitLine = line('NOTES_LIMIT');
const statusBlock = found(/^const NOTES_STATUS = \{[^]*?\n\};$/m, 'NOTES_STATUS');
const source = [
  "'use strict';",
  ...app.match(/^const \w+_KEY = '[^']*';$/gm),
  // One line each: the pattern for longer functions would run on into the next one.
  found(/^function load\(.*$/m, 'load'),
  found(/^function save\(.*$/m, 'save'),
  limitLine, statusBlock, line('notesView'), line('firstClick'), line('NOTES_PUSH_MS'), line('NOTES_KEEPALIVE_BYTES'),
  ...['refreshNotes', 'saveNotes', 'renderNotesStatus', 'notesStored', 'openNotes', 'toggleNotes',
    'setNotesSync', 'notesFailed', 'sharedPrefix', 'adoptNotes', 'notesPushable', 'scheduleNotesPush', 'flushNotes', 'pushNotes', 'sendNotes',
    'applyServerNotes', 'catchUpNotes', 'pullNotes', 'guardLeaving', 'confirmLeaving'].map(fn),
  'globalThis.firstClick = firstClick;',
  'globalThis.notesView = notesView;',
].join('\n');
const LIMIT = runInNewContext(`${limitLine}; NOTES_LIMIT`);
const STATUS = runInNewContext(`${limitLine}\n${statusBlock}; NOTES_STATUS`);
const KEY = 'agentGuild.notes';
const REV = 'agentGuild.notesRevision';

function stale(notes) {
  return Object.assign(new Error('Notes changed in another browser.'), { code: 'stale_notes', notes });
}

/** One open page. `storage` is shared between pages to stand for other tabs or a reload. */
function page({ storage = new Map(), blocked = false, full = false } = {}) {
  const calls = [];
  const pushes = [];
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
  const dock = { panel: null };
  const elements = {
    'notes-open': element('notes-open'),
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
    dockShows: (panel) => dock.panel === panel,
    showDock: (panel) => { dock.panel = panel; calls.push(`showDock ${panel}`); },
    closeDock: () => { dock.panel = null; calls.push('closeDock'); },
    addEventListener: (type, listener) => listeners.set(type, (listeners.get(type) ?? new Set()).add(listener)),
    removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
    document: { activeElement: null },
    TextEncoder,
    clearTimeout() {},
    setTimeout() { return 0; },
    AuthError: class AuthError extends Error {},
    showAuth: (message) => calls.push(`auth ${message}`),
    api: async (method, path, body, options) => {
      pushes.push({ method, path, body, options });
      return { notes: { revision: 'rev-1', text: body?.text ?? '' } };
    },
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
  // Return the context itself so a test can replace `api` and the page calls that replacement.
  return Object.assign(sandbox, {
    calls, pushes, storage, quota, sub, area, elements, dock,
    /** The user edits the text: the input event saves it. */
    type(next) { area.value = next; sandbox.saveNotes(); },
    guarded: () => Boolean(listeners.get('beforeunload')?.has(sandbox.confirmLeaving)),
  });
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
  tab.toggleNotes();
  tab.toggleNotes();
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
  assert.equal(tab.pushes.length, 0, 'an empty panel does not create notes on the manager');
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

test('the Notes button opens the notes in the side panel with the text focused, and closes them again', () => {
  const tab = page();
  tab.toggleNotes();
  assert.deepEqual(tab.calls, ['hideTip', 'showDock notes', 'focus notes-text']);
  assert.equal(tab.dock.panel, 'notes');
  tab.toggleNotes();
  assert.equal(tab.calls.at(-1), 'closeDock');
  assert.equal(tab.dock.panel, null);
  tab.dock.panel = 'github';
  tab.toggleNotes();
  assert.equal(tab.dock.panel, 'notes', 'from the GitHub panel it switches to the notes');
});

test('notes brought back after a reload do not take the focus', () => {
  const tab = page();
  tab.openNotes({ focus: false });
  assert.deepEqual(tab.calls, ['hideTip', 'showDock notes']);
});

test('only the first click of a double-click counts, so Notes cannot open and at once close', () => {
  const tab = page();
  const runs = [];
  const click = tab.firstClick(() => runs.push('run'));
  for (const detail of [1, 2, 3, 0]) click({ detail });
  assert.equal(runs.length, 2, 'a click, and a keyboard press (detail 0), but not the second or third click');
});

test('the page wires the notes up and has their controls', () => {
  for (const wiring of [
    "$('notes-open').addEventListener('click', firstClick(toggleNotes));",
    "$('stop-manager').addEventListener('click', firstClick(() => { closeMenu($('manager-menu')); stopManager(); }));",
    "$('restart-manager').addEventListener('click', firstClick(() => { closeMenu($('manager-menu')); stopManager({ restart: true }); }));",
    "$('notes-text').addEventListener('input', () => { saveNotes(); void scheduleNotesPush(); });",
    "addEventListener('storage', notesStored);",
    "addEventListener('pageshow', refreshNotes);",
  ]) assert.ok(app.includes(`\n${wiring}\n`), wiring);

  const topbar = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>'));
  assert.match(topbar, /<button id="notes-open" class="btn notes-open" type="button" aria-controls="dock" aria-pressed="false">Notes<\/button>/);
  // `.menu-button:has(+ :popover-open)` turns the chevron, so nothing may come between a button and its menu.
  assert.match(topbar, />Settings<\/button>\s*<div id="settings-menu"/, 'the Settings menu comes right after its button');
  assert.match(topbar, />Manager<\/button>\s*<div id="manager-menu"/, 'the Manager menu comes right after its button');
  assert.match(html, /<section id="notes" class="dock-panel notes-panel" role="tabpanel" aria-labelledby="notes-title" hidden>/);
  assert.match(html, /<textarea id="notes-text" class="notes-text" aria-labelledby="notes-title" aria-describedby="notes-sub" autocomplete="off"/);
  assert.ok(html.includes(`<p id="notes-sub" class="dock-sub sub" aria-live="polite">${STATUS.saved}</p>`), 'the status line starts as the page writes it');
});

test('an empty manager receives notes this browser already has, and an empty panel does not create any', async () => {
  const tab = page();
  await tab.catchUpNotes(null);
  assert.equal(tab.pushes.length, 0);
  assert.equal(tab.notesView.acked, '');
  tab.type('checklist');
  await tab.catchUpNotes(null);
  assert.equal(tab.pushes.length, 1);
  assert.equal(tab.pushes[0].body.revision, null);
  assert.equal(tab.pushes[0].body.text, 'checklist');
  assert.equal(tab.area.value, 'checklist');
  assert.equal(tab.sub.writes, 0, 'the line stays quiet while the save succeeds');
});

test('a browser with no notes takes the manager copy', async () => {
  const tab = page();
  tab.api = async () => ({ notes: { revision: 'r9', text: 'from the host' } });
  await tab.pullNotes();
  assert.equal(tab.area.value, 'from the host');
  assert.equal(tab.storage.get(KEY), 'from the host');
  assert.equal(tab.storage.get('agentGuild.notesRevision'), 'r9');
  assert.equal(tab.sub.text, STATUS.saved);
});

test('an echo of this page\'s save does not move the caret', () => {
  const tab = page();
  tab.type('hello world');
  tab.adoptNotes({ revision: 'r1', text: 'hello world' });
  tab.area.setSelectionRange(1, 4);
  tab.applyServerNotes({ revision: 'r1', text: 'hello world' });
  assert.deepEqual([tab.area.selectionStart, tab.area.selectionEnd], [1, 4]);
});

test('notes from another browser keep a selection in the unchanged part', () => {
  const tab = page();
  tab.type('hello world');
  tab.adoptNotes({ revision: 'r1', text: 'hello world' });
  tab.document.activeElement = tab.area;
  tab.area.setSelectionRange(2, 2);
  tab.applyServerNotes({ revision: 'r2', text: 'hello world!' });
  assert.equal(tab.area.value, 'hello world!');
  assert.equal(tab.area.selectionStart, 2);
  assert.equal(tab.notesView.base, 'r2');
  assert.equal(tab.storage.get('agentGuild.notesRevision'), 'r2');
});

test('notes arriving while this page is mid-edit stay off the text being typed', () => {
  const tab = page();
  tab.adoptNotes({ revision: 'r1', text: 'hello' });
  tab.area.value = 'hello!';
  tab.notesView.saved = 'hello!';
  tab.area.setSelectionRange(6, 6);
  tab.applyServerNotes({ revision: 'r2', text: 'hello?' });
  assert.equal(tab.area.value, 'hello!');
  assert.deepEqual([tab.area.selectionStart, tab.area.selectionEnd], [6, 6]);
  assert.equal(tab.notesView.base, 'r2');
});

test('a conflict while typing sends the latest text once more, at the manager\'s revision', async () => {
  const tab = page();
  tab.area.value = 'mine';
  tab.notesView.saved = 'mine';
  tab.notesView.acked = '';
  tab.notesView.base = 'old';
  let n = 0;
  tab.api = async (_method, _path, body) => {
    n += 1;
    tab.pushes.push(body);
    if (n === 1) {
      tab.area.value = 'mine!';
      tab.notesView.saved = 'mine!';
      const error = new Error('Notes changed in another browser.');
      error.code = 'stale_notes';
      error.notes = { revision: 'fresh', text: 'theirs' };
      throw error;
    }
    if (n > 2) throw new Error('retried more than once');
    return { notes: { revision: 'rev-2', text: body.text } };
  };
  await tab.scheduleNotesPush(0);
  assert.equal(n, 2);
  // The body is created inside the page context, so compare its fields.
  assert.equal(tab.pushes[1].revision, 'fresh');
  assert.equal(tab.pushes[1].text, 'mine!');
  assert.equal(tab.area.value, 'mine!');
  assert.equal(tab.notesView.base, 'rev-2');
});

test('a conflict never replaces the text on screen: this page sends it once more at the manager\'s revision', async () => {
  const tab = page();
  tab.area.value = 'mine';
  tab.notesView.saved = 'mine';
  tab.notesView.acked = '';
  tab.notesView.base = 'old';
  tab.api = async (_method, _path, body) => {
    tab.pushes.push(body);
    if (body.revision === 'old') throw stale({ revision: 'fresh', text: 'theirs' });
    return { notes: { revision: 'rev-2', text: body.text } };
  };
  await tab.scheduleNotesPush(0);
  assert.equal(tab.area.value, 'mine');
  assert.equal(tab.pushes.length, 2);
  assert.equal(tab.pushes[1].revision, 'fresh');
  assert.equal(tab.notesView.acked, 'mine');
  assert.equal(tab.notesView.base, 'rev-2');
});

test('a second conflict in a row stops rather than looping', async () => {
  const tab = page();
  tab.area.value = 'mine';
  tab.notesView.saved = 'mine';
  tab.notesView.acked = '';
  tab.notesView.base = 'old';
  let n = 0;
  tab.api = async () => {
    n += 1;
    throw stale({ revision: `r${n}`, text: 'theirs' });
  };
  await tab.scheduleNotesPush(0);
  assert.equal(n, 2);
  assert.equal(tab.area.value, 'mine');
});

test('notes over the limit are not sent to the manager', async () => {
  const tab = page();
  tab.type('x'.repeat(LIMIT + 1));
  await tab.scheduleNotesPush(0);
  assert.equal(tab.pushes.length, 0);
  assert.equal(tab.sub.text, STATUS.long);
});

test('notes already in this browser reach an empty manager on the first hello', async () => {
  const tab = page({ storage: new Map([[KEY, 'from this browser']]) });
  await tab.catchUpNotes(null);
  assert.equal(tab.area.value, 'from this browser');
  assert.equal(tab.pushes.length, 1);
  assert.equal(tab.pushes[0].body.revision, null);
  assert.equal(tab.pushes[0].body.text, 'from this browser');
  assert.equal(tab.sub.writes, 0);
});

test('opening an empty notepad does not drop the revision or create notes', () => {
  const storage = new Map([['agentGuild.notesRevision', 'r1']]);
  const tab = page({ storage });
  tab.openNotes();
  assert.equal(storage.get('agentGuild.notesRevision'), 'r1');
  assert.equal(tab.pushes.length, 0);
  assert.equal(tab.notesView.base, 'r1');
});

test('a keystroke before hello is saved against the revision already in this browser', async () => {
  const storage = new Map([[KEY, 'hello'], ['agentGuild.notesRevision', 'r1']]);
  const tab = page({ storage });
  tab.refreshNotes();
  tab.type('hello!');
  assert.equal(storage.has('agentGuild.notesRevision'), false, 'a reload can see the keystrokes were not saved');
  assert.equal(tab.notesView.base, 'r1', 'the save still names the revision it started from');
  await tab.catchUpNotes('r1');
  assert.equal(tab.pushes.length, 1);
  assert.equal(tab.pushes[0].body.revision, 'r1');
  assert.equal(tab.pushes[0].body.text, 'hello!');
  assert.equal(tab.area.value, 'hello!');
});

test('another tab’s revision arrives without moving the caret when the text is unchanged', () => {
  const storage = new Map([[KEY, 'hello'], ['agentGuild.notesRevision', 'r1']]);
  const tab = page({ storage });
  tab.refreshNotes();
  tab.area.setSelectionRange(2, 2);
  storage.set('agentGuild.notesRevision', 'r2');
  tab.notesStored({ key: 'agentGuild.notesRevision' });
  assert.equal(tab.area.value, 'hello');
  assert.deepEqual([tab.area.selectionStart, tab.area.selectionEnd], [2, 2]);
  assert.equal(tab.notesView.base, 'r2');
  assert.equal(tab.pushes.length, 0);
});

test('a browser reopened with an old synced copy takes the newer notes another browser saved', async () => {
  // This browser last synced 'old' at r1; another browser has since saved r2.
  const storage = new Map([[KEY, 'old'], [REV, 'r1']]);
  const tab = page({ storage });
  tab.refreshNotes();
  tab.api = async (method, _path, body) => {
    tab.pushes.push({ method, body });
    if (method === 'GET') return { notes: { revision: 'r2', text: 'new from phone' } };
    throw new Error('no save expected');
  };
  await tab.catchUpNotes('r2');
  assert.deepEqual(tab.pushes.map((p) => p.method), ['GET'], 'the old copy is not sent');
  assert.equal(tab.area.value, 'new from phone');
  assert.equal(storage.get(KEY), 'new from phone');
  assert.equal(storage.get(REV), 'r2');
  assert.equal(tab.sub.text, STATUS.saved);
});

test('edits that never reached the manager are still sent after a reload, over its newer revision', async () => {
  const storage = new Map([[KEY, 'old'], [REV, 'r1']]);
  const first = page({ storage });
  first.refreshNotes();
  first.type('old, edited offline');
  assert.equal(storage.has(REV), false);
  const tab = page({ storage });
  tab.refreshNotes();
  tab.api = async (method, _path, body) => {
    tab.pushes.push({ method, body });
    if (method === 'GET') return { notes: { revision: 'r2', text: 'other' } };
    return { notes: { revision: 'r3', text: body.text } };
  };
  await tab.catchUpNotes('r2');
  assert.deepEqual(tab.pushes.map((p) => p.method), ['GET', 'PUT']);
  assert.equal(tab.pushes[1].body.revision, 'r2');
  assert.equal(tab.pushes[1].body.text, 'old, edited offline');
  assert.equal(tab.area.value, 'old, edited offline');
  assert.equal(storage.get(REV), 'r3');
});

test('an edit drops the stored revision before it stores the text, so no reload can see the new text as synced', () => {
  const storage = new Map([[KEY, 'hello'], [REV, 'r1']]);
  const tab = page({ storage });
  tab.refreshNotes();
  const seen = [];
  const { setItem } = tab.localStorage;
  tab.localStorage.setItem = (key, value) => {
    seen.push([key, storage.get(REV) ?? null]);
    return setItem(key, value);
  };
  tab.type('hello!');
  assert.deepEqual(seen, [[KEY, null]]);
});

test('a refused edit keeps the stored revision, which still names the stored text', () => {
  const storage = new Map([[KEY, 'hello'], [REV, 'r1']]);
  const tab = page({ storage });
  tab.refreshNotes();
  // At the quota the longer text is refused; the short revision fits in the space its removal just freed.
  const { setItem } = tab.localStorage;
  tab.localStorage.setItem = (key, value) => {
    if (key === KEY) throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
    return setItem(key, value);
  };
  tab.type('hello!');
  assert.equal(tab.sub.text, STATUS.refused);
  assert.equal(storage.get(KEY), 'hello');
  assert.equal(storage.get(REV), 'r1');
});

test('hiding the page during a save sends no second request beside it, and the screen never rolls back', async () => {
  const tab = page();
  tab.adoptNotes({ revision: 'r1', text: 'a' });
  let current = { revision: 'r1', text: 'a' };
  let release;
  let inFlight = 0;
  let most = 0;
  tab.api = async (_method, _path, body) => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    tab.pushes.push(body);
    if (tab.pushes.length === 1) await new Promise((resolve) => { release = resolve; });
    inFlight -= 1;
    if (body.revision !== current.revision) throw stale(current);
    current = { revision: `r${tab.pushes.length + 1}`, text: body.text };
    return { notes: current };
  };
  tab.type('ab');
  const first = tab.scheduleNotesPush(0);
  tab.type('abc');
  tab.document.visibilityState = 'hidden';
  tab.flushNotes();
  tab.flushNotes(); // pagehide right after visibilitychange
  assert.equal(tab.pushes.length, 1, 'the flush waits for the save under way');
  release();
  await first;
  assert.equal(most, 1);
  assert.equal(tab.pushes.length, 2);
  assert.equal(tab.pushes[1].text, 'abc');
  assert.equal(tab.pushes[1].revision, 'r2');
  assert.equal(tab.area.value, 'abc');
  assert.equal(tab.storage.get(KEY), 'abc');
  assert.equal(current.text, 'abc');
});

test('a hidden page sends small notes with keepalive and large ones without', async () => {
  const tab = page();
  tab.document.visibilityState = 'hidden';
  tab.type('short');
  await tab.scheduleNotesPush(0);
  assert.equal(tab.pushes[0].options.keepalive, true);
  tab.type('x'.repeat(70_000));
  await tab.scheduleNotesPush(0);
  assert.equal(tab.pushes[1].options.keepalive, false);
});

test('the status line says when notes are only in this browser, and clears once the manager has them', async () => {
  const tab = page();
  tab.type('todo');
  tab.api = async () => { throw new TypeError('Failed to fetch'); };
  await tab.scheduleNotesPush(0);
  assert.equal(tab.sub.text, STATUS.local);
  assert.ok(tab.sub.classes.has('warn'));
  assert.equal(tab.guarded(), false, 'the text is safe in this browser, so leaving is not blocked');
  tab.type('todo!');
  assert.equal(tab.sub.text, STATUS.local, 'typing does not flip the line');
  tab.api = async (_method, _path, body) => ({ notes: { revision: 'r1', text: body.text } });
  await tab.catchUpNotes(null);
  assert.equal(tab.sub.text, STATUS.saved);
  assert.equal(tab.sub.classes.has('warn'), false);
});

test('a manager that cannot read its notes file says so, and recovers once it can', async () => {
  const tab = page();
  tab.type('todo');
  await tab.catchUpNotes(undefined, true);
  assert.equal(tab.sub.text, STATUS.damaged);
  tab.api = async () => { throw Object.assign(new Error('Notes could not be read.'), { code: 'notes_unreadable' }); };
  await tab.scheduleNotesPush(0);
  assert.equal(tab.sub.text, STATUS.damaged, 'a failed save keeps the precise reason');
  tab.api = async (_method, _path, body) => ({ notes: { revision: 'r1', text: body.text } });
  await tab.catchUpNotes(null);
  assert.equal(tab.sub.text, STATUS.saved);
});

test('a storage problem outranks a sync problem on the status line', async () => {
  const tab = page();
  tab.setNotesSync('local');
  tab.type('x'.repeat(LIMIT + 1));
  assert.equal(tab.sub.text, STATUS.long);
  tab.type('ok');
  assert.equal(tab.sub.text, STATUS.local);
});

test('a manager that lost its notes file gets this browser\'s synced copy back', async () => {
  const storage = new Map([[KEY, 'kept'], [REV, 'r1']]);
  const tab = page({ storage });
  tab.refreshNotes();
  tab.api = async (_method, _path, body) => {
    tab.pushes.push(body);
    if (body.revision !== null) throw stale({ revision: null, text: '' });
    return { notes: { revision: 'r9', text: body.text } };
  };
  await tab.catchUpNotes(null);
  assert.equal(tab.pushes.at(-1).text, 'kept');
  assert.equal(tab.area.value, 'kept');
  assert.equal(storage.get(REV), 'r9');
});
