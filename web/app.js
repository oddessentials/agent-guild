// Agent Guild web page. A thin client of the session manager's local API:
// it never owns sessions, so closing the page leaves them running.

import { SOUNDS, MAX_ALERT_AGE_MS, playOnce, rearmSound, managerLossWatcher, stopWatcher, updateWatcher } from './alerts.js';
import { TerminalCopy } from './terminal-copy.js';
import { TerminalControls, bindTerminalViewport } from './terminal-controls.js';
import { topbarInline, dockMode, clampDockWidth, stageBesideDock, splitMode, clampRatio, bindSplitter, DOCK_MIN, SPLIT_RATIO_MIN } from './layout.js';
import { highlightParts, rankRepos, recentFirst, remember, repoForOrigin, repoKey } from './repo-search.js';
import { createActivityFavicon, isSessionWorking } from './activity-favicon.js';
import { createRemoteAccessUI } from './remote-access.js';
import { createEnvironmentUI } from './environment.js';
import { matchFolders, readRecentFolders, rememberFolder } from './folders.js';

const TOKEN_KEY = 'agentGuild.token';
const CWD_KEY = 'agentGuild.cwd';
const ACCOUNTS_KEY = 'agentGuild.accounts';
const SHELLS_KEY = 'agentGuild.shells';
const THEME_KEY = 'agentGuild.theme';
const SKIN_KEY = 'agentGuild.skin';
const NEWS_SEEN_KEY = 'agentGuild.newsSeen';
const NEWS_FILTER_KEY = 'agentGuild.newsFilter';
const CHANGELOG_SEEN_KEY = 'agentGuild.changelogSeen';
const GITHUB_ACCOUNT_KEY = 'agentGuild.githubAccount';
const CLONE_PARENT_KEY = 'agentGuild.cloneParent';
const HIDDEN_FOLDERS_KEY = 'agentGuild.showHiddenFolders';
const RECENT_CWDS_KEY = 'agentGuild.recentCwds';
const RECENT_CLONE_PARENTS_KEY = 'agentGuild.recentCloneParents';
const GITHUB_REPO_KEY = 'agentGuild.githubRepo';
const GITHUB_RECENT_KEY = 'agentGuild.githubRecent';
const GITHUB_VIEW_KEY = 'agentGuild.githubView';
const SESSION_ORDER_KEY = 'agentGuild.sessionOrder';
const SOUND_KEY = 'agentGuild.sound';
const VOICE_KEY = 'agentGuild.voice';
const NOTES_KEY = 'agentGuild.notes';
const NOTES_REV_KEY = 'agentGuild.notesRevision';
const DOCK_KEY = 'agentGuild.dock';
const DOCK_WIDTH_KEY = 'agentGuild.dockWidth';
const PANES_KEY = 'agentGuild.panes';
const SPLIT_RATIO_KEY = 'agentGuild.splitRatio';
const RELEASES_URL = 'https://github.com/oddessentials/agent-guild/releases';
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
const coarsePointer = window.matchMedia('(pointer: coarse)');
const activityFavicon = createActivityFavicon({ link: document.querySelector('link[rel="icon"]'), reducedMotion });

const $ = (id) => document.getElementById(id);
const state = {
  token: null,
  providers: [],
  usage: new Map(),
  accounts: {},
  shellPicks: {},
  stats: null,
  statsFor: new Map(),
  news: null,
  changelog: null,
  github: null,
  sessions: new Map(),
  views: new Map(),
  panes: [],
  focusedPane: 0,
  activeId: null,
  eventsSocket: null,
  eventsRetry: 0,
  pageAway: false,
  managerUnavailable: false,
  /** True while the events socket is open. */
  connected: false,
  folderOpener: null,
  folderOpening: false,
  /** The manager's operating system, from `hello`. */
  platform: null,
  /** The manager's own version check, from `hello` and `manager.upgrade`. */
  upgrade: null,
  /** The running manager's version and pid, from `hello`. */
  version: null,
  pid: null,
  /** False for a manager from before restarts, which only stops: `agent-guild restart` replaces it. */
  restartable: false,
  /** The double-click launcher file on this computer, or null when the install has none. */
  launcher: null,
  /** True from a shutdown request until the manager is reachable again. */
  stopping: false,
  /** True while the stop is a restart: a new manager is expected to take over. */
  restarting: false,
  /** After a stop: how many session processes did not confirm exiting, or null if the manager never said. */
  stopRemaining: null,
};

// ---- storage (may be unavailable, e.g. blocked site data) -----------------

function load(key) { try { return localStorage.getItem(key); } catch { return null; } }
function save(key, value) { try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); return true; } catch { return false; } }

// ---- helpers --------------------------------------------------------------

let toastTimer;
function toast(message, ms = 5000, action = null) {
  const el = $('toast');
  el.replaceChildren(message);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn toast-action';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      el.hidden = true;
      action.run();
    });
    el.append(button);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/**
 * Handles a click, but not the second click of a double-click, which lands on whatever the first one
 * opened, closed or uncovered.
 */
const firstClick = (run) => (e) => { if (e.detail < 2) run(); };

function setConnection(kind, label) {
  const el = $('connection');
  el.className = `connection ${kind}`;
  el.querySelector('.label').textContent = label;
  el.title = label;
  // The manager can only be stopped, restarted or upgraded while the page can reach it.
  state.connected = kind === 'ok';
  terminalControls.refresh();
  state.remoteAccessUI?.connectionChanged();
  $('manager').hidden = !state.connected;
  if (!state.connected) closeMenu($('manager-menu'));
  renderFolderTools();
  $('stop-manager').hidden = !state.connected;
  $('restart-manager').hidden = !state.connected || !state.restartable;
  renderUpgrade();
  guardLeaving();
}

// ---- the running version --------------------------------------------------

/** A development checkout runs as 0.0.0-development; releases carry a real version. */
function isDevelopmentBuild(version) {
  return !version || /^0\.0\.0(?:-|$)/.test(String(version));
}

function renderVersion() {
  const badge = $('version');
  const v = state.version;
  badge.hidden = !v;
  if (!v) return;
  const dev = isDevelopmentBuild(v);
  const unread = unreadRelease();
  const notes = unread ? `What’s new in v${unread}` : 'What’s new';
  badge.textContent = dev ? 'dev' : `v${v}`;
  badge.classList.toggle('unread', Boolean(unread));
  badge.title = [dev ? `Development build (${v})` : `Agent Guild ${v}`, state.pid && `session manager pid ${state.pid}`, notes].filter(Boolean).join(' · ');
  badge.setAttribute('aria-label', `${dev ? `Agent Guild development build ${v}` : `Agent Guild version ${v}`}. ${notes}${unread ? ', not read yet' : ''}`);
}

const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

function compareReleases(a, b) {
  const [x, y] = [a, b].map((version) => version.split('.').map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

function newestRelease(versions) {
  return versions.filter((v) => RELEASE_VERSION.test(v ?? '')).reduce((newest, v) => (newest && compareReleases(newest, v) >= 0 ? newest : v), null);
}

function seenRelease() {
  const saved = load(CHANGELOG_SEEN_KEY);
  return RELEASE_VERSION.test(saved ?? '') ? saved : changelogView.seen;
}

function markReleasesSeen(...versions) {
  const newest = newestRelease([seenRelease(), ...versions]);
  if (!newest) return;
  changelogView.seen = newest;
  save(CHANGELOG_SEEN_KEY, newest);
}

function unreadRelease() {
  if (!RELEASE_VERSION.test(state.version ?? '')) return null;
  if (!seenRelease()) markReleasesSeen(state.version);
  const newest = newestRelease([state.version, state.upgrade?.pendingVersion, state.upgrade?.latestVersion]);
  return compareReleases(newest, seenRelease()) > 0 ? newest : null;
}

// ---- theme ----------------------------------------------------------------

/** theme.js applied the saved or system theme before the first paint; this keeps the menu in step. */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector(`#settings-menu input[name="theme"][value="${theme}"]`).checked = true;
}

function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/** Repaints the page with `change`, revealed in a circle growing from the control that asked for it. */
function revealChange(control, change) {
  if (!document.startViewTransition || reducedMotion.matches) return change();
  const box = control.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const root = document.documentElement.style;
  root.setProperty('--reveal-x', `${Math.round(x)}px`);
  root.setProperty('--reveal-y', `${Math.round(y)}px`);
  root.setProperty('--reveal-r', `${Math.ceil(Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)))}px`);
  // The browser skips the animation (still applying the change) when the page is hidden or another transition starts.
  document.startViewTransition(change).ready.catch(() => {});
}

function changeTheme(input) {
  const theme = input.value === 'dark' ? 'dark' : 'light';
  save(THEME_KEY, theme);
  revealChange(input.closest('label'), () => applyTheme(theme));
}

// ---- skin -----------------------------------------------------------------

/** The skins theme.js offers; it applied the saved one before the first paint. */
const SKINS = window.agentGuildSkins ?? [{ id: 'guild', name: 'Guild' }];

function renderSkinChoices() {
  const choices = SKINS.map((skin) => {
    const label = document.createElement('label');
    label.className = 'choice';
    const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'skin', value: skin.id });
    input.checked = skin.id === document.documentElement.dataset.skin;
    label.append(input, Object.assign(document.createElement('span'), { textContent: skin.name }));
    return label;
  });
  $('skin-choices').append(...choices);
}

/**
 * Switches skin in place. Entrance and level-up animations are cleared first
 * so the new skin does not replay them on every card.
 */
function changeSkin(input) {
  const skin = input.value;
  if (!SKINS.some((s) => s.id === skin) || skin === document.documentElement.dataset.skin) return;
  save(SKIN_KEY, skin);
  for (const el of document.querySelectorAll('.deal, .enter, .level-up, .summon')) el.classList.remove('deal', 'enter', 'level-up', 'summon');
  revealChange(input.closest('label'), () => { document.documentElement.dataset.skin = skin; });
}

// ---- sound ----------------------------------------------------------------

const audio = {};
const stopAlert = stopWatcher();
const updateAlert = updateWatcher();
const managerLoss = managerLossWatcher({
  async reachable(signal) {
    const res = await fetch('/api/v1/health', { cache: 'no-store', signal });
    const health = await res.json();
    return res.ok && health.ok === true && health.name === 'agent-guild';
  },
  unavailable(at, fresh) {
    state.managerUnavailable = true;
    showManagerUnavailable();
    alertSound('stopped', `unavailable.${state.managerInstance}`, at, fresh, [`stopped.${state.managerInstance}`]);
  },
});

function soundOn() {
  return load(SOUND_KEY) === 'on';
}

/** Keep the tiny clips ready while the manager can still serve them. */
function prepareSounds() {
  if (!soundOn()) return;
  for (const [name, file] of Object.entries(SOUNDS)) {
    audio[name] ??= new Audio(file);
    audio[name].preload = 'auto';
    if (audio[name].error) audio[name].load();
  }
}

/** Plays a sound when sounds are on. Browsers allow it once the user has clicked or typed on the page. */
function playSound(name) {
  if (!soundOn()) return Promise.resolve(false);
  audio[name] ??= new Audio(SOUNDS[name]);
  audio[name].currentTime = 0;
  return audio[name].play().then(() => true);
}

/** Plays an alert in one open page only; `key` names the event. */
function alertSound(name, key, at = Date.now(), fresh = () => true, related = []) {
  if (soundOn()) playOnce(key, () => playSound(name), {
    fresh: () => !state.pageAway && soundOn() && fresh() && Date.now() - at <= MAX_ALERT_AGE_MS,
    related,
  });
}

const AUTOSTART_NOTE = 'Starts the session manager in the background when you sign in to the computer running Agent Guild. The page does not open.';
let autostartRequest = 0;
let autostartChanging = false;

/** The manager's sign-in setting; hidden when the manager has none. */
function renderAutostart(autostart) {
  $('autostart-choice').hidden = !autostart;
  $('autostart').checked = Boolean(autostart?.enabled);
  $('autostart').disabled = !autostart?.available;
  $('autostart-note').textContent = autostart?.reason || autostart?.note || AUTOSTART_NOTE;
}

async function loadAutostart({ afterChange = false } = {}) {
  if (!state.connected || (autostartChanging && !afterChange)) return;
  const request = ++autostartRequest;
  $('autostart').disabled = true;
  try {
    const { autostart } = await api('GET', '/autostart');
    if (request === autostartRequest) renderAutostart(autostart);
  } catch (err) {
    if (request !== autostartRequest) return;
    if (err instanceof AuthError) showAuth(err.message);
    else if (err.code === 'not_found') renderAutostart(null);
    else renderAutostart({ available: false, enabled: false, reason: `Could not read the startup setting: ${err.message}` });
  }
}

async function changeAutostart(input) {
  if (autostartChanging) return;
  autostartChanging = true;
  ++autostartRequest;
  const enabled = input.checked;
  input.disabled = true;
  try {
    renderAutostart((await api('PUT', '/autostart', { enabled })).autostart);
  } catch (err) {
    if (err instanceof AuthError) showAuth(err.message);
    else {
      toast(err.message);
      // An OS operation can partly succeed. Read back what actually happened.
      await loadAutostart({ afterChange: true });
    }
  } finally {
    autostartChanging = false;
  }
}

function changeSound(input) {
  save(SOUND_KEY, input.checked ? 'on' : null);
  prepareSounds();
  playSound('update').catch(() => {});
}

/** A hello identifies this manager lifetime, independent of connections. */
function managerConnected(msg) {
  prepareSounds();
  state.managerInstance = msg.startedAt && msg.pid ? `${msg.pid}.${msg.startedAt}` : null;
  stopAlert.connected(state.managerInstance);
  state.managerUnavailable = false;
  if (state.managerInstance) managerLoss.connected();
  else managerLoss.cancel();
  if (state.managerInstance) rearmSound(`unavailable.${state.managerInstance}`);
}

/** A confirmed manager stop; a browser socket closing never calls this. */
function managerGone() {
  managerLoss.cancel();
  state.managerUnavailable = false;
  const instance = stopAlert.stopped();
  if (instance) alertSound('stopped', `stopped.${instance}`, Date.now(),
    () => state.managerInstance === instance && !state.connected, [`unavailable.${instance}`]);
}

/** Places an open menu under its button, right-aligned with it and kept on screen. */
function placeMenu(menu, button) {
  if (!menu.matches(':popover-open') || !button) return;
  const box = button.getBoundingClientRect();
  const top = Math.round(box.bottom + 6);
  menu.style.top = `${top}px`;
  menu.style.maxHeight = `${innerHeight - top - 8}px`;
  menu.style.left = 'auto';
  menu.style.right = `${Math.max(8, Math.round(innerWidth - box.right))}px`;
  if (menu.getBoundingClientRect().left < 8) {
    menu.style.right = 'auto';
    menu.style.left = `${Math.max(8, Math.round(box.left))}px`;
  }
}

function closeMenu(menu) {
  if (menu.matches(':popover-open')) menu.hidePopover();
}

function menuItems(menu) {
  return [...menu.querySelectorAll('.menu-item')].filter((item) => !item.hidden && !item.disabled);
}

/** Arrow keys, Home and End move between the items; Tab leaves the menu and closes it. */
function moveInMenu(e) {
  if (e.key === 'Tab') return closeMenu(e.currentTarget);
  const items = menuItems(e.currentTarget);
  const at = items.indexOf(document.activeElement);
  const next = e.key === 'ArrowDown' ? items[(at + 1) % items.length]
    : e.key === 'ArrowUp' ? items[(at - 1 + items.length) % items.length]
    : e.key === 'Home' ? items[0]
    : e.key === 'End' ? items[items.length - 1]
    : null;
  if (!next) return;
  e.preventDefault();
  next.focus();
}

// ---- notes ----------------------------------------------------------------

/** Notes share the page's storage with every other setting, so they stay far below the browser's limit for it. */
const NOTES_LIMIT = 100000;
const NOTES_STATUS = {
  saved: 'Saved and synced across your browsers',
  local: 'Saved in this browser only. Syncs when the manager is back.',
  damaged: 'Not syncing: the manager’s notes file is damaged. Saved in this browser only.',
  long: `Not saved: notes hold up to ${NOTES_LIMIT.toLocaleString('en-US')} characters. Shorten them to save.`,
  refused: 'Not saved: the browser’s storage for this page is full or turned off. Copy what you need before you close the page.',
};
/** How long a burst of typing waits before one save to the manager. */
const NOTES_PUSH_MS = 400;
/** Browsers drop a keepalive request larger than 64 KiB, so a bigger notepad waits for the next open. */
const NOTES_KEEPALIVE_BYTES = 60 * 1024;
/**
 * `saved`: the notes as this page last read or wrote them in storage. `status`: whether the text in the
 * panel is saved, too `long` or `refused`; `sync`: whether the manager has it (`ok`), could not be reached
 * (`local`) or cannot read its notes file (`damaged`); `shown`: the status the line under the title shows.
 * `base`: the manager revision this page last saved from. `acked`: the text of that revision.
 * `flight`: the save to the manager under way. Text typed meanwhile is sent when it finishes.
 */
const notesView = { saved: '', status: 'saved', sync: 'ok', shown: 'saved', base: null, acked: null, timer: 0, flight: null };

/** Shows notes another tab saved since this page last read or wrote them. Saved notes win over text this page could not save. */
function refreshNotes() {
  let text;
  // Unlike load(), a read that fails is not taken for empty notes.
  try { text = localStorage.getItem(NOTES_KEY) ?? ''; } catch { return; }
  const revision = load(NOTES_REV_KEY);
  if (text === notesView.saved && revision === notesView.base) return;
  if (text !== notesView.saved) {
    notesView.saved = text;
    notesView.status = 'saved';
    $('notes-text').value = text;
  }
  // The revision is kept only while the stored text is the one it names, so that text is on the manager.
  if (revision) notesView.acked = text;
  if (revision !== notesView.base) notesView.base = revision;
  renderNotesStatus();
  guardLeaving();
}

/** Saves the notes on every change; emptying them removes the saved copy. This stays in the browser. */
function saveNotes() {
  const text = $('notes-text').value;
  if (text.length > NOTES_LIMIT) {
    notesView.status = 'long';
    renderNotesStatus();
    guardLeaving();
    return;
  }
  // A reload can tell these keystrokes have not reached the manager: the stored revision goes first, so
  // stored text never sits beside a revision it does not match. The revision in memory stays, for the save.
  // An empty panel is probed with the same text, and that must not look like a new edit.
  const revision = text !== notesView.saved ? load(NOTES_REV_KEY) : null;
  if (revision) save(NOTES_REV_KEY, null);
  if (!save(NOTES_KEY, text || null)) {
    // The stored text did not change, so it still matches its revision.
    if (revision) save(NOTES_REV_KEY, revision);
    notesView.status = 'refused';
  } else {
    notesView.status = 'saved';
    notesView.saved = text;
  }
  renderNotesStatus();
  guardLeaving();
}

/** The line under the title is a live region, so it is rewritten only when the status changes. */
function renderNotesStatus() {
  // A problem saving in this browser outranks one reaching the manager.
  const shown = notesView.status === 'saved' && notesView.sync !== 'ok' ? notesView.sync : notesView.status;
  if (notesView.shown === shown) return;
  notesView.shown = shown;
  const sub = $('notes-sub');
  sub.textContent = NOTES_STATUS[shown];
  sub.classList.toggle('warn', shown !== 'saved');
}

/** Whether the manager has the notes. Typing never changes this, so the line does not flicker. */
function setNotesSync(sync) {
  if (notesView.sync === sync) return;
  notesView.sync = sync;
  renderNotesStatus();
}

/** A save or read that failed. A file the manager cannot read is reported as such; anything else is unreachable. */
function notesFailed(error) {
  setNotesSync(error?.code === 'notes_unreadable' ? 'damaged' : 'local');
}

/** Another tab saved the notes, or cleared this page's storage. */
function notesStored(e) {
  if (e.key === NOTES_KEY || e.key === NOTES_REV_KEY || e.key === null) refreshNotes();
}

function openNotes({ focus = true } = {}) {
  hideTip();
  refreshNotes();
  // Saving an empty note changes nothing, but shows at once when the browser keeps nothing.
  if (notesView.status === 'saved' && !$('notes-text').value) saveNotes();
  showDock('notes');
  if (focus) $('notes-text').focus();
}

function toggleNotes() {
  if (dockShows('notes')) closeDock();
  else openNotes();
}

function sharedPrefix(left, right) {
  const end = Math.min(left.length, right.length);
  let i = 0;
  while (i < end && left.charCodeAt(i) === right.charCodeAt(i)) i += 1;
  return i;
}

/** Takes the manager's notes. A selection that still sits in the unchanged prefix stays put. */
function adoptNotes(notes) {
  const area = $('notes-text');
  const next = notes.text;
  if (typeof next !== 'string') return;
  if (next !== area.value) {
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const previous = area.value;
    const focused = document.activeElement === area;
    area.value = next;
    if (focused) {
      const keep = sharedPrefix(previous, next);
      if (start <= keep && end <= keep) area.setSelectionRange(start, end);
    }
  }
  notesView.saved = next;
  notesView.acked = next;
  notesView.base = notes.revision ?? null;
  notesView.status = 'saved';
  notesView.sync = 'ok';
  // Revision last, and only over text that was stored: a stored revision always names the stored text.
  save(NOTES_REV_KEY, null);
  if (save(NOTES_KEY, next || null)) save(NOTES_REV_KEY, notes.revision || null);
  renderNotesStatus();
  guardLeaving();
}

function notesPushable() {
  const text = $('notes-text').value;
  if (notesView.status !== 'saved' || text.length > NOTES_LIMIT) return false;
  if (text === notesView.acked) return false;
  if (notesView.base == null && text === '') return false;
  return true;
}

function scheduleNotesPush(delay = NOTES_PUSH_MS) {
  clearTimeout(notesView.timer);
  notesView.timer = 0;
  if (!notesPushable()) return Promise.resolve();
  if (delay === 0) return pushNotes();
  notesView.timer = setTimeout(() => { notesView.timer = 0; void pushNotes(); }, delay);
  return Promise.resolve();
}

/** The page is being hidden or closed: send what the debounce still holds. */
function flushNotes() {
  void scheduleNotesPush(0);
}

/**
 * One save to the manager at a time, so two of this page's own saves can never race each other. Text typed
 * while a save is under way follows it. A conflict sends this page's text once more at the manager's revision:
 * the latest typing wins, and the text on screen is never replaced by an older copy.
 */
function pushNotes() {
  // The save under way checks for newer text when it finishes.
  if (notesView.flight) return notesView.flight;
  const run = (async () => {
    let resent = false;
    for (;;) {
      if (!notesPushable()) return;
      const outcome = await sendNotes($('notes-text').value);
      if (outcome === 'stale' && !resent) resent = true;
      else if (outcome !== 'ok') return;
    }
  })();
  notesView.flight = run;
  return run.finally(() => { notesView.flight = null; });
}

/** @returns {Promise<'ok'|'stale'|'failed'>} `stale`: the manager moved on, and `base` now names its revision. */
async function sendNotes(text) {
  const body = { revision: notesView.base, text };
  // A hidden page may be closing: keepalive lets the save outlive it, for bodies the browser allows.
  const keepalive = document.visibilityState === 'hidden'
    && new TextEncoder().encode(JSON.stringify(body)).length <= NOTES_KEEPALIVE_BYTES;
  let payload;
  try {
    payload = (await api('PUT', '/notes', body, { keepalive })).notes;
  } catch (error) {
    if (error instanceof AuthError) {
      showAuth(error.message);
      return 'failed';
    }
    if (error.code !== 'stale_notes' || !error.notes || typeof error.notes.text !== 'string') {
      notesFailed(error);
      return 'failed';
    }
    // The manager already holds exactly this text, saved by another tab or an earlier request.
    if (error.notes.text === $('notes-text').value) {
      adoptNotes(error.notes);
      return 'ok';
    }
    notesView.base = error.notes.revision ?? null;
    return 'stale';
  }
  if (!payload || typeof payload.text !== 'string') {
    notesFailed();
    return 'failed';
  }
  if ($('notes-text').value === text) adoptNotes(payload);
  else {
    // Typing went on during the save: the newer text follows from this revision.
    notesView.base = payload.revision ?? notesView.base;
    setNotesSync('ok');
  }
  return 'ok';
}

/** Another browser's save. Our own echo matches the text already on screen and only adopts the revision. */
function applyServerNotes(notes) {
  if (!notes || typeof notes.text !== 'string') return;
  const area = $('notes-text');
  if (notes.text === area.value) {
    adoptNotes(notes);
    return;
  }
  if (notesView.acked !== null && area.value !== notesView.acked) {
    notesView.base = notes.revision ?? notesView.base;
    return;
  }
  adoptNotes(notes);
}

/** The notes part of hello. A missing revision means this manager cannot share notes. */
async function catchUpNotes(revision, unreadable) {
  if (unreadable) {
    setNotesSync('damaged');
    return;
  }
  if (revision === undefined) return;
  // Hello can arrive before the first read. Load this browser's copy before deciding, unless typing has started.
  if (notesView.saved === '' && $('notes-text').value === '' && notesView.acked === null) refreshNotes();
  const local = $('notes-text').value;
  // No file yet, or it was removed. Text this browser has is the first copy. An empty panel writes nothing.
  if (revision === null) notesView.acked = local ? null : '';
  if (revision === null || revision === notesView.base) {
    if (notesPushable()) await scheduleNotesPush(0);
    else setNotesSync('ok');
    return;
  }
  await pullNotes();
}

/** The manager moved on while this page was away. Its copy wins unless this browser has edits it never sent. */
async function pullNotes() {
  let notes;
  try {
    notes = (await api('GET', '/notes')).notes;
  } catch (error) {
    if (error instanceof AuthError) showAuth(error.message);
    else notesFailed(error);
    return;
  }
  if (!notes || typeof notes.text !== 'string') return;
  const local = $('notes-text').value;
  // `acked` is unknown only when this browser holds text no revision names: an edit that never reached the manager.
  const unsent = local !== notes.text && (notesView.acked === null ? local !== '' : local !== notesView.acked);
  if (!unsent) {
    adoptNotes(notes);
    return;
  }
  notesView.base = notes.revision ?? null;
  setNotesSync('ok');
  await scheduleNotesPush(0);
}

// ---- dock -----------------------------------------------------------------

const DOCK_PANELS = ['github', 'notes'];
const dockView = { panel: null, opener: null, width: clampDockWidth(Number.parseFloat(load(DOCK_WIDTH_KEY)), innerWidth) };

function dockShows(panel) {
  return dockView.panel === panel;
}

function applyDockLayout() {
  const root = document.documentElement;
  const mode = dockMode(innerWidth);
  const width = clampDockWidth(dockView.width, innerWidth);
  root.classList.toggle('dock-push', mode === 'push');
  root.classList.toggle('dock-full', mode === 'full');
  root.style.setProperty('--dock-w', `${width}px`);
  root.style.setProperty('--dock-space', dockView.panel && mode === 'push' ? `${width}px` : '0px');
  root.style.setProperty('--dock-stage-space', dockView.panel && stageBesideDock(innerWidth, width) ? `${width}px` : '0px');
  const splitter = $('dock-splitter');
  splitter.setAttribute('aria-valuemin', String(DOCK_MIN));
  splitter.setAttribute('aria-valuemax', String(clampDockWidth(Infinity, innerWidth)));
  splitter.setAttribute('aria-valuenow', String(width));
}

function renderDock() {
  $('dock').hidden = !dockView.panel;
  for (const name of DOCK_PANELS) {
    const shown = dockView.panel === name;
    $(name).hidden = !shown;
    $(`${name}-title`).setAttribute('aria-selected', String(shown));
    $(`${name}-title`).tabIndex = shown || !dockView.panel ? 0 : -1;
  }
  $('github-toggle').setAttribute('aria-pressed', String(dockShows('github')));
  $('notes-open').setAttribute('aria-pressed', String(dockShows('notes')));
  applyDockLayout();
  scheduleRuns();
}

function showDock(panel) {
  if (!dockView.panel) dockView.opener = document.activeElement;
  dockView.panel = panel;
  save(DOCK_KEY, panel);
  if ($('topbar-menu').matches(':popover-open')) $('topbar-menu').hidePopover();
  renderDock();
}

function closeDock({ focusOpener = true } = {}) {
  if (!dockView.panel) return;
  const hadFocus = $('dock').contains(document.activeElement);
  const fallback = dockShows('github') ? $('github-toggle') : $('notes-open');
  dockView.panel = null;
  save(DOCK_KEY, null);
  renderDock();
  if (focusOpener && hadFocus) {
    [dockView.opener, fallback, $('menu-toggle')].find((el) => el?.isConnected && el.checkVisibility?.())?.focus();
  }
  dockView.opener = null;
}

function dockMakesWayForTerminal() {
  if (dockView.panel && !stageBesideDock(innerWidth, clampDockWidth(dockView.width, innerWidth))) closeDock({ focusOpener: false });
}

function moveDockTab(e) {
  const tabs = DOCK_PANELS.map((name) => $(`${name}-title`));
  const at = tabs.indexOf(e.target);
  if (at === -1 || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
  e.preventDefault();
  const next = tabs[(at + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  next.click();
  next.focus();
}

// ---- upgrading the manager ------------------------------------------------

function renderUpgrade() {
  const u = state.upgrade;
  const button = $('upgrade');
  const note = $('upgrade-note');
  const offer = Boolean(state.connected && u?.available && u.command);
  button.hidden = !offer;
  if (offer) {
    button.textContent = `Upgrade to ${u.latestVersion}`;
    button.title = `Run "${u.command}" in a session. Sessions keep running; the new version is used once the manager is restarted.`;
  }
  // A newer version on disk is used by the next manager, so the restart
  // button becomes the way to pick it up.
  const restart = $('restart-manager');
  const pending = u?.pendingVersion;
  restart.classList.toggle('pending', Boolean(pending));
  $('manager').classList.toggle('pending', Boolean(pending) && state.restartable);
  restart.textContent = pending ? `Restart to use v${pending}` : 'Restart manager';
  restart.title = pending
    ? `Agent Guild ${pending} is installed, but this manager is still ${u.version}. Restarting ends every session and starts the new version; this page reconnects by itself.`
    : 'Stop the session manager and start it again. This ends every session; this page reconnects by itself.';
  const panelUpgrade = $('changelog-upgrade');
  panelUpgrade.hidden = button.hidden;
  panelUpgrade.textContent = button.textContent;
  panelUpgrade.title = button.title;
  const panelRestart = $('changelog-restart');
  panelRestart.hidden = restart.hidden || !pending;
  panelRestart.textContent = restart.textContent;
  panelRestart.title = restart.title;
  $('changelog-actions').hidden = panelUpgrade.hidden && panelRestart.hidden;
  let text = '';
  let title = '';
  const last = u?.lastInstall;
  if (u?.installing) {
    text = `Upgrading${u.latestVersion ? ` to v${u.latestVersion}` : ''}…`;
    title = 'npm is running in a session. Keep the manager running until it finishes.';
  } else if (pending && !state.restartable) {
    text = `v${pending} installed · run "agent-guild restart" to use it`;
    title = `Agent Guild ${pending} is installed, but this manager is still ${u.version} and cannot restart itself. Run "agent-guild restart" in a terminal when your sessions are done; this page reconnects by itself.`;
  } else if (last?.outcome === 'failed') {
    text = last.exitCode === null ? 'Upgrade failed' : `Upgrade failed (exit ${last.exitCode})`;
    title = 'See the upgrade session for npm\'s output, then run the upgrade again: the files on disk may be incomplete. On Windows, files in use cannot be replaced: stop the manager first and run the command yourself.';
  } else if (last?.outcome === 'unchanged') {
    text = 'Upgrade finished, but this copy was not replaced';
    title = `npm did not replace the files this manager runs from. Run${u.command ? ` "${u.command}"` : ' the npm install'} where Agent Guild is installed.`;
  } else if (u?.available && !u.command) {
    text = `v${u.latestVersion} available`;
    title = u.guidance || '';
  }
  note.hidden = !state.connected || !text;
  note.textContent = text;
  note.title = title;
}

function setUpgrade(upgrade, baseline = false) {
  const before = state.upgrade;
  state.upgrade = upgrade || null;
  if (updateAlert(state.upgrade, baseline)) alertSound('update', `update.${state.upgrade.latestVersion}`);
  renderUpgrade();
  renderVersion();
  if ($('changelog').open) renderChangelog();
  const pending = state.upgrade?.pendingVersion;
  if (pending && pending !== before?.pendingVersion) {
    toast(state.restartable
      ? `Agent Guild ${pending} is installed. Use "Restart to use v${pending}" in the top bar when your sessions are done.`
      : `Agent Guild ${pending} is installed. Run "agent-guild restart" in a terminal when your sessions are done.`, 10000);
  }
}

async function upgradeManager() {
  const button = $('upgrade');
  button.disabled = true;
  try {
    const { session } = await api('POST', '/upgrade');
    upsertSession(session);
    openPanel(session.id);
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    toast(err.message, 8000);
  } finally {
    button.disabled = false;
  }
}

function relativeTime(iso) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function untilTime(iso) {
  if (!iso) return '';
  const s = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (!Number.isFinite(s) || s <= 0) return 'resets now';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h >= 48) return `resets in ${Math.round(h / 24)} d`;
  if (h > 0) return `resets in ${h} h${m ? ` ${m} min` : ''}`;
  return `resets in ${Math.max(1, m)} min`;
}

function hueFor(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

function httpsHref(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function planLabel(plan) {
  const text = String(plan ?? '').trim();
  if (/[A-Z]/.test(text)) return text;
  return text.replace(/[_-]+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function paintProviderIcon(el, provider) {
  el.style.setProperty('--c', provider.color || '#64748b');
  el.dataset.provider = provider.id;
  if (provider.iconUrl) {
    el.classList.add('has-image');
    el.style.backgroundImage = `url(${JSON.stringify(provider.iconUrl)})`;
    el.textContent = '';
  } else {
    el.classList.remove('has-image');
    el.style.backgroundImage = '';
    el.textContent = provider.monogram || (provider.vendor || '?').charAt(0);
  }
  el.setAttribute('aria-hidden', 'true');
}

const FAMILIARS = ['flame', 'leaf', 'night', 'aether'];

const REPORTING_TEXT = {
  pending: 'waiting for hooks',
  unavailable: 'no reports yet',
  setup_required: 'reporting off',
  unsupported: 'not supported',
};

function paintReporting(row, s) {
  const reporting = s.status === 'running' ? s.reporting : null;
  const agents = row.querySelector('.agents');
  agents.dataset.empty = REPORTING_TEXT[reporting?.state] || 'none reported';
  agents.classList.toggle('reporting-attention', ['unavailable', 'setup_required', 'unsupported'].includes(reporting?.state));
  const why = row.querySelector('.reporting-why');
  const reason = reporting?.state !== 'active' ? reporting?.reason || '' : '';
  why.hidden = !reason;
  why.title = reason;
  why.setAttribute('aria-label', `Why agent reporting says ${agents.dataset.empty}: ${reason}`);
  why.onclick = () => toast(reason, 12000);
}

const MAX_SHELLS_SHOWN = 16;

function renderAgents(container, agents, shells = []) {
  const known = container.dataset.rendered ? new Set([...container.children].map((el) => el.dataset.agent)) : null;
  container.dataset.rendered = 'true';
  const familiar = (id, name, hue) => {
    const el = document.createElement('span');
    el.dataset.agent = id;
    if (known && !known.has(id)) el.classList.add('summon');
    el.style.setProperty('--c', `hsl(${hue} 65% 50%)`);
    el.dataset.familiar = FAMILIARS[hue % FAMILIARS.length];
    el.setAttribute('role', 'img');
    return el;
  };
  const agentEls = agents.map((agent) => {
    const el = familiar(agent.id, agent.name, hueFor(agent.name));
    el.classList.add('agent', agent.status);
    el.textContent = (agent.name || '?').charAt(0).toUpperCase();
    const detail = agent.detail ? ` — ${agent.detail}` : '';
    el.title = `${agent.name} (${agent.status})${detail}`;
    el.setAttribute('aria-label', el.title);
    return el;
  });
  const shellEls = shells.slice(0, MAX_SHELLS_SHOWN).map((shell) => {
    const el = familiar(shell.id, 'Shell', hueFor(shell.id));
    el.classList.add('agent', 'working', 'shell');
    el.textContent = '>';
    el.title = 'Shell command (running)';
    el.setAttribute('aria-label', el.title);
    return el;
  });
  if (shells.length > MAX_SHELLS_SHOWN) {
    const more = document.createElement('span');
    const hidden = shells.length - MAX_SHELLS_SHOWN;
    more.className = 'agent-overflow';
    more.dataset.agent = 'shell-overflow';
    more.textContent = `+${hidden}`;
    more.title = `${shells.length} shell commands running; ${hidden} more not drawn`;
    more.setAttribute('role', 'img');
    more.setAttribute('aria-label', more.title);
    shellEls.push(more);
  }
  container.replaceChildren(...agentEls, ...shellEls);
}

// ---- API ------------------------------------------------------------------

class AuthError extends Error {}

async function api(method, path, body, options = {}) {
  const res = await fetch(`/api/v1${path}`, {
    method,
    keepalive: options.keepalive === true,
    headers: {
      Authorization: `Bearer ${state.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new AuthError('The access token was rejected.');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.error?.message || `Request failed (HTTP ${res.status})`), data?.error);
  return data;
}

function renderFolderTools() {
  const paint = (id, feature, busy, label, text) => {
    const button = $(id);
    button.disabled = !state.connected || !feature?.available || busy;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-busy', String(busy));
    button.title = !state.connected ? text.offline
      : busy ? text.busy
        : !feature?.available ? feature?.reason || text.missing
          : label;
  };
  for (const id of ['cwd-pick', 'github-parent-pick']) {
    paint(id, { available: true }, false, 'Choose a folder…', { offline: 'Connect to the session manager to choose folders' });
  }
  paint('cwd-open', state.folderOpener, state.folderOpening, `Open working folder in ${state.folderOpener?.label || 'file manager'}`, {
    offline: 'Connect to the session manager to open folders',
    busy: 'Opening working folder…',
    missing: 'Opening folders is unavailable with this manager',
  });
}

async function openWorkingFolder() {
  if (!state.connected || !state.folderOpener?.available || state.folderOpening) return;
  state.folderOpening = true;
  renderFolderTools();
  try {
    await api('POST', '/open-folder', { cwd: $('cwd').value.trim() });
  } catch (err) {
    if (err instanceof AuthError) showAuth(err.message);
    else toast(err.message || 'Could not open the working folder.');
  } finally {
    state.folderOpening = false;
    renderFolderTools();
  }
}

// ---- recent folders ---------------------------------------------------------

const RECENT_FIELDS = {
  cwd: { input: 'cwd', list: 'cwd-recent', key: RECENT_CWDS_KEY, pick: (dir) => useFolder(dir) },
  clone: { input: 'github-parent', list: 'github-parent-recent', key: RECENT_CLONE_PARENTS_KEY, pick: (dir) => setCloneParent(dir) },
};
const recentView = { field: null, typed: false, active: -1 };

function recentFolders(field) {
  return readRecentFolders(load(RECENT_FIELDS[field].key));
}

function rememberRecent(field, dir) {
  if (dir) save(RECENT_FIELDS[field].key, JSON.stringify(rememberFolder(recentFolders(field), dir, { caseless: state.platform === 'win32' })));
}

function renderRecent(field) {
  const { input: inputId, list: listId } = RECENT_FIELDS[field];
  const input = $(inputId), list = $(listId);
  const open = recentView.field === field;
  const shown = open ? matchFolders(recentFolders(field), recentView.typed ? input.value : '') : [];
  if (open) recentView.active = Math.min(recentView.active, shown.length - 1);
  list.replaceChildren(...shown.map((dir, i) => {
    const option = el('li', 'cwd-recent-option', dir);
    option.id = `${listId}-${i}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(open && i === recentView.active));
    option.addEventListener('pointerdown', (e) => e.preventDefault());
    option.addEventListener('click', () => pickRecent(field, dir));
    return option;
  }));
  list.hidden = !shown.length;
  input.setAttribute('aria-expanded', String(!list.hidden));
  if (open && recentView.active >= 0) input.setAttribute('aria-activedescendant', `${listId}-${recentView.active}`);
  else input.removeAttribute('aria-activedescendant');
}

function showRecent(field, typed = false) {
  const previous = recentView.field;
  Object.assign(recentView, { field, typed, active: -1 });
  if (previous && previous !== field) renderRecent(previous);
  renderRecent(field);
}

function hideRecent(field) {
  if (recentView.field !== field) return;
  Object.assign(recentView, { field: null, active: -1 });
  renderRecent(field);
}

function pickRecent(field, dir) {
  hideRecent(field);
  RECENT_FIELDS[field].pick(dir);
}

function recentKeys(field, e) {
  const list = $(RECENT_FIELDS[field].list);
  const options = list.hidden ? [] : [...list.children];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (recentView.field !== field) showRecent(field);
    const count = list.children.length;
    if (!count) return;
    recentView.active = e.key === 'ArrowDown' ? (recentView.active + 1) % count : recentView.active <= 0 ? count - 1 : recentView.active - 1;
    renderRecent(field);
    $(`${RECENT_FIELDS[field].list}-${recentView.active}`).scrollIntoView?.({ block: 'nearest' });
  } else if (e.key === 'Enter' && recentView.active >= 0 && options[recentView.active]) {
    e.preventDefault();
    pickRecent(field, options[recentView.active].textContent);
  } else if (e.key === 'Escape' && options.length) {
    e.preventDefault();
    hideRecent(field);
  }
}

// ---- folder browser -------------------------------------------------------

const FOLDER_FIELDS = {
  cwd: { title: 'Choose working folder', input: 'cwd' },
  clone: { title: 'Choose clone folder', input: 'github-parent' },
};
const folderView = { field: null, listing: null, loading: false, error: null, request: 0, opener: null };

function chooseFolder(field) {
  if (!state.connected) return;
  const dialog = $('folder-browser');
  Object.assign(folderView, { field, listing: null, loading: false, error: null });
  $('folder-title').textContent = FOLDER_FIELDS[field].title;
  $('folder-filter').value = '';
  $('folder-hidden').checked = load(HIDDEN_FOLDERS_KEY) === '1';
  if (!dialog.open) {
    folderView.opener = document.activeElement;
    dialog.showModal();
  }
  browseTo($(FOLDER_FIELDS[field].input).value.trim());
}

function showNewFolder(open) {
  $('folder-new').hidden = !open;
  $('folder-new-open').setAttribute('aria-expanded', String(open));
  if (open) $('folder-new-name').value = '';
  renderFolderBrowser();
  (open ? $('folder-new-name') : $('folder-new-open')).focus();
}

async function createFolder(e) {
  e?.preventDefault();
  const parent = folderView.listing?.path;
  const name = $('folder-new-name').value.trim();
  if (!parent || !name || folderView.loading) return;
  const request = ++folderView.request;
  folderView.loading = true;
  folderView.error = null;
  renderFolderBrowser();
  try {
    const listing = await api('POST', '/folders', { path: parent, name });
    if (request !== folderView.request) return;
    folderView.listing = listing;
    $('folder-filter').value = '';
    $('folder-new').hidden = true;
    $('folder-new-open').setAttribute('aria-expanded', 'false');
  } catch (err) {
    if (request !== folderView.request) return;
    if (err instanceof AuthError) {
      $('folder-browser').close();
      return showAuth(err.message);
    }
    folderView.error = err.message || 'Could not create the folder.';
  }
  folderView.loading = false;
  renderFolderBrowser();
  if ($('folder-browser').open) ($('folder-new').hidden ? $('folder-use') : $('folder-new-name')).focus();
}

function newFolderKeys(e) {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  showNewFolder(false);
}

async function browseTo(dir) {
  $('folder-new').hidden = true;
  $('folder-new-open').setAttribute('aria-expanded', 'false');
  const request = ++folderView.request;
  folderView.loading = true;
  folderView.error = null;
  renderFolderBrowser();
  try {
    const listing = await api('GET', `/folders?path=${encodeURIComponent(dir)}`);
    if (request !== folderView.request) return;
    folderView.listing = listing;
    $('folder-filter').value = '';
  } catch (err) {
    if (request !== folderView.request) return;
    if (err instanceof AuthError) {
      $('folder-browser').close();
      return showAuth(err.message);
    }
    folderView.error = err.message || 'Could not list this folder.';
  }
  folderView.loading = false;
  renderFolderBrowser();
  if ($('folder-browser').open) ($('folder-list').querySelector('.folder-row') ?? $('folder-use')).focus();
}

function renderFolderBrowser() {
  const { listing, loading, error } = folderView;
  const query = $('folder-filter').value.trim().toLowerCase();
  const showHidden = $('folder-hidden').checked;
  $('folder-path').replaceChildren(...(listing?.segments ?? []).map((segment, i, all) => {
    const crumb = button(segment.name, () => browseTo(segment.path), 'folder-crumb');
    if (i === all.length - 1) crumb.setAttribute('aria-current', 'location');
    return crumb;
  }));
  $('folder-roots').replaceChildren(...(listing?.roots ?? []).map((root) => button(root.name, () => browseTo(root.path), 'btn folder-chip')));
  $('folder-up').disabled = loading || !listing?.parent;
  $('folder-home').disabled = loading;
  const note = $('folder-note');
  note.hidden = !listing?.note;
  note.textContent = listing?.note ? `${listing.note} was not found, so this shows the nearest folder that exists.` : '';
  const entries = (listing?.entries ?? []).filter((entry) => (showHidden || !entry.hidden) && (!query || entry.name.toLowerCase().includes(query)));
  $('folder-list').replaceChildren(...entries.map((entry) => {
    const row = button(entry.name, () => browseTo(entry.path), 'folder-row');
    row.classList.toggle('hidden-folder', entry.hidden);
    row.title = entry.path;
    return row;
  }));
  const status = $('folder-status');
  status.textContent = loading ? 'Loading folders…'
    : error ? error
      : !listing ? ''
        : !entries.length ? (listing.entries.length ? 'No folders match.' : 'No folders here.')
          : listing.truncated ? `Showing the first ${listing.entries.length.toLocaleString()} folders.` : '';
  status.classList.toggle('error', Boolean(error));
  $('folder-current').textContent = listing?.path ?? '';
  $('folder-use').disabled = loading || !listing;
  $('folder-new-open').disabled = loading || !listing;
  $('folder-new-create').disabled = loading || !listing || !$('folder-new-name').value.trim();
}

function folderBrowserClosed() {
  if (!$('folder-browser').open && folderView.opener?.isConnected) folderView.opener.focus();
}

function setCloneParent(dir) {
  $('github-parent').value = dir;
  save(CLONE_PARENT_KEY, dir);
  loadRepos();
}

function useBrowsedFolder() {
  const dir = folderView.listing?.path;
  if (!dir || folderView.loading) return;
  const field = folderView.field;
  $('folder-browser').close();
  rememberRecent(field, dir);
  if (field === 'clone') setCloneParent(dir);
  else useFolder(dir);
}

function moveInFolders(e) {
  const rows = [...$('folder-list').querySelectorAll('.folder-row')];
  const at = rows.indexOf(document.activeElement);
  const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: rows.length - 1 }[e.key];
  if (at === -1 || next === undefined) return;
  e.preventDefault();
  rows[Math.max(0, Math.min(rows.length - 1, next))].focus();
}

function folderBrowserKeys(e) {
  if (e.key !== 'Backspace' || e.target.matches('input') || !folderView.listing?.parent || folderView.loading) return;
  e.preventDefault();
  browseTo(folderView.listing.parent);
}

function wsUrl(path) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/api/v1${path}?token=${encodeURIComponent(state.token)}`;
}

// ---- providers ------------------------------------------------------------

function selectedAccount(provider) {
  const accounts = provider.accounts || [];
  return accounts.find((a) => a.id === state.accounts[provider.id]) || accounts[0] || { id: 'default', label: 'Default' };
}

function selectAccount(provider, id) {
  state.accounts[provider.id] = id;
  save(ACCOUNTS_KEY, JSON.stringify(state.accounts));
}

/** The shell the user picked for the provider, or null to start its default. */
function pickedShell(provider) {
  return provider.shells?.find((s) => s.id === state.shellPicks[provider.id] && s.id !== provider.defaultShell) ?? null;
}

function selectedShell(provider) {
  return pickedShell(provider) ?? provider.shells?.find((s) => s.id === provider.defaultShell) ?? null;
}

function selectShell(provider, id) {
  if (id === provider.defaultShell) delete state.shellPicks[provider.id];
  else state.shellPicks[provider.id] = id;
  save(SHELLS_KEY, JSON.stringify(state.shellPicks));
}

function renderShells(card, provider) {
  const host = card.querySelector('.shells');
  const shells = provider.shells || [];
  host.hidden = !provider.available || shells.length < 2;
  if (host.hidden) return host.replaceChildren();
  const selected = selectedShell(provider)?.id;
  const same = host.children.length === shells.length && shells.every((s, i) => host.children[i].dataset.shell === s.id);
  if (!same) {
    host.replaceChildren(...shells.map((shell) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'account-chip';
      chip.setAttribute('role', 'tab');
      chip.dataset.shell = shell.id;
      chip.addEventListener('click', () => {
        selectShell(provider, shell.id);
        renderShells(card, provider);
        renderUsage(card, provider);
      });
      return chip;
    }));
  }
  shells.forEach((shell, i) => {
    const chip = host.children[i];
    chip.setAttribute('aria-selected', String(shell.id === selected));
    chip.textContent = shell.label;
    chip.title = shell.multiplexer
      ? `Start new sessions inside ${shell.label}. Stopping or closing one detaches it; it keeps running in ${shell.label}.\n${shell.path}`
      : `Start new sessions in ${shell.label}${shell.id === provider.defaultShell ? ', used unless you pick another' : ''}\n${shell.path}`;
  });
}

function usageFor(provider, account = selectedAccount(provider)) {
  return state.usage.get(`${provider.id}/${account.id}`);
}

function renderAccounts(card, provider) {
  const host = card.querySelector('.accounts');
  const accounts = provider.accounts || [];
  host.hidden = accounts.length < 2;
  if (host.hidden) return host.replaceChildren();
  const selected = selectedAccount(provider).id;
  const same = host.children.length === accounts.length && accounts.every((a, i) => host.children[i].dataset.account === a.id);
  if (!same) {
    host.replaceChildren(...accounts.map((account) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'account-chip';
      chip.setAttribute('role', 'tab');
      chip.dataset.account = account.id;
      chip.addEventListener('click', () => {
        selectAccount(provider, account.id);
        renderAccounts(card, provider);
        renderUsage(card, provider);
        renderReportingSetup(card, provider);
      });
      return chip;
    }));
  }
  accounts.forEach((account, i) => {
    const chip = host.children[i];
    chip.classList.toggle('unsigned', usageFor(provider, account)?.signedIn === false);
    chip.setAttribute('aria-selected', String(account.id === selected));
    chip.textContent = account.label;
    chip.title = `Start new ${provider.tool} sessions as the ${account.label} account`;
  });
}

function renderReportingSetup(card, provider) {
  const row = card.querySelector('.reporting-row');
  row.hidden = !provider.available || typeof provider.reportingEnabled !== 'boolean';
  if (row.hidden) return;
  const on = provider.reportingEnabled;
  row.querySelector('.reporting-text').textContent = `Agent reporting ${on ? 'on' : 'off'}`;
  const button = row.querySelector('.reporting-toggle');
  button.textContent = on ? 'Turn off' : 'Turn on';
  button.title = on
    ? `Remove the Agent Guild plugin from ${provider.tool}. New sessions stop reporting their model.`
    : `Install the Agent Guild plugin into ${provider.tool} with "${provider.command} plugin install", so new sessions show their model and can be resumed. It does nothing in sessions started outside Agent Guild.`;
  button.onclick = async () => {
    button.disabled = true;
    try {
      await api('POST', `/providers/${provider.id}/reporting`, { enabled: !on });
      toast(on ? `Agent reporting is off for ${provider.tool}.` : `Agent reporting is on for ${provider.tool}. It applies to new sessions.`);
    } catch (err) {
      if (err instanceof AuthError) return showAuth(err.message);
      toast(err.message, 10000);
    } finally {
      button.disabled = false;
    }
  };
}

let dealt = false;

function renderProviders() {
  const list = $('providers');
  const focused = document.activeElement;
  const focusKey = focused?.dataset?.muxFocus;
  const tpl = $('provider-template');
  list.replaceChildren(...state.providers.map((provider) => {
    const node = tpl.content.firstElementChild.cloneNode(true);
    paintProviderIcon(node.querySelector('.provider-icon'), provider);
    node.querySelector('.vendor').textContent = provider.vendor;
    node.querySelector('.tool').textContent = provider.tool;
    const stateLine = node.querySelector('.state');
    stateLine.textContent = providerState(provider);
    const checkFailed = provider.available && provider.versionStatus === 'failed';
    stateLine.classList.toggle('update-available', provider.updateAvailable || checkFailed || Boolean(installNote(provider)));
    stateLine.title = [provider.resolvedPath, provider.updateCommand && `Update: ${provider.updateCommand}`].filter(Boolean).join('\n');
    node.dataset.id = provider.id;
    node.classList.toggle('unavailable', !provider.available);
    node.setAttribute('aria-label', `${provider.vendor} ${provider.tool}, ${!provider.available ? 'not installed' : checkFailed ? 'version check failed' : 'ready'}`);
    const start = node.querySelector('.new');
    const existing = node.querySelector('.existing');
    const hint = node.querySelector('.hint');
    start.hidden = !provider.available;
    start.addEventListener('click', () => startSession(provider, node));
    existing.hidden = !provider.available || !provider.resumable;
    existing.title = provider.historySource
      ? `Resume one of ${provider.tool}'s own earlier sessions`
      : `Resume one of ${provider.tool}'s own sessions by its id`;
    existing.addEventListener('click', () => showHistory(provider));
    const install = node.querySelector('.install');
    install.hidden = provider.available || !provider.installable;
    install.title = `Install ${provider.tool} using npm.${provider.npmNote ? ` ${provider.npmNote}` : ''}`;
    install.addEventListener('click', () => installProvider(provider, node));
    const update = node.querySelector('.update');
    update.hidden = !(provider.available && provider.updateCommand && (provider.updateAvailable || checkFailed));
    if (provider.installChannel !== 'npm') update.textContent = 'Update';
    else update.textContent = checkFailed ? 'Reinstall' : `Update to ${provider.latestVersion}`;
    update.title = provider.updateCommand ? `Run "${provider.updateCommand}" in a session` : '';
    update.addEventListener('click', () => installProvider(provider, node));
    renderHint(hint, provider);
    renderCopies(node.querySelector('.copies'), provider, node);
    renderVendorLinks(node, provider);
    renderAccounts(node, provider);
    renderShells(node, provider);
    state.environmentUI?.renderCard(node, provider);
    renderMultiplexers(node, provider);
    renderUsage(node, provider);
    renderReportingSetup(node, provider);
    renderModelStats(node, provider);
    return node;
  }));
  if (focusKey) {
    const controls = [...list.querySelectorAll('[data-mux-focus]')];
    const fallback = focusKey.split(':').slice(0, 2).join(':') + ':copies';
    const replacement = controls.find((node) => node.dataset.muxFocus === focusKey && !node.disabled)
      || controls.find((node) => node.dataset.muxFocus === fallback && !node.closest('[hidden]'))
      || controls.find((node) => node.dataset.muxFocus === focusKey.split(':')[0] + ':multiplexers');
    replacement?.focus({ preventScroll: true });
  }
  if (!dealt && state.providers.length) {
    dealt = true;
    if (!reducedMotion.matches) list.classList.add('deal');
  }
}

const openCopies = new Set();

function renderCopies(box, provider, card, actions = null) {
  const installs = provider.installs || [];
  const warnings = provider.warnings || [];
  box.hidden = actions ? installs.length === 0 : warnings.length === 0 && !installs.some((i) => i.uninstall);
  if (box.hidden) return;
  box.classList.toggle('warned', warnings.length > 0);
  const inUse = installs.some((i) => i.active);
  const older = installs.some((i) => i.newer);
  box.querySelector('summary').textContent = installs.every((i) => i.partial) ? 'Incomplete installation' : !inUse
    ? 'A copy exists off PATH'
    : installs.length === 1 ? 'Installation' : `${installs.length} copies installed${older ? ' · older copy in use' : ''}`;
  const key = actions?.key || provider.id;
  box.open = openCopies.has(key);
  box.addEventListener('toggle', () => (box.open ? openCopies.add(key) : openCopies.delete(key)));
  if (actions) box.querySelector('summary').dataset.muxFocus = key + ':copies';
  const line = (className, ...content) => {
    const span = document.createElement('span');
    span.className = className;
    span.append(...content);
    return span;
  };
  box.querySelector('ul').replaceChildren(...warnings.map((text) => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }), ...installs.map((install) => {
    const item = document.createElement('li');
    const channel = CHANNEL_LABELS[install.channel] || install.channel;
    const name = [channel, install.version && `v${install.version}`, installs.length > 1 && (install.active ? 'in use' : 'not in use')];
    const head = line('copy-head', line('copy-name', name.filter(Boolean).join(' · ')));
    const where = line('copy-path', install.displayPath);
    where.title = install.path;
    item.append(head, where);
    if (actions && install.updateCommand && (install.updateAvailable || install.versionStatus === 'failed')) {
      const update = document.createElement('button');
      update.type = 'button';
      update.className = 'btn copy-update';
      update.textContent = 'Update';
      update.title = `Run ${install.updateCommand}`;
      update.disabled = actions.busy;
      update.dataset.muxFocus = key + ':update:' + install.path;
      update.addEventListener('click', () => actions.update(install));
      head.append(update);
    } else if (actions && install.updateGuidance) item.append(line('copy-remove', install.updateGuidance));
    if (install.uninstall) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn danger copy-uninstall';
      button.textContent = 'Uninstall';
      button.setAttribute('aria-label', `Uninstall the ${channel} copy of ${provider.tool} at ${install.displayPath}`);
      button.title = install.uninstall.command
        ? [`Runs ${install.uninstall.command}`, ...install.uninstall.remove.map((p) => `then deletes ${p}`)].join('\n')
        : ['Deletes', ...install.uninstall.remove].join('\n');
      if (actions) {
        button.disabled = actions.busy;
        button.dataset.muxFocus = key + ':uninstall:' + install.path;
      }
      button.addEventListener('click', () => actions ? actions.uninstall(install) : uninstallCopy(provider, card, install));
      head.append(button);
    } else {
      item.append(line('copy-remove', install.uninstallGuidance));
    }
    return item;
  }));
}

const openMultiplexers = new Set();

function renderMultiplexers(card, provider) {
  const host = card.querySelector('.multiplexers');
  const tools = provider.multiplexers || [];
  host.hidden = tools.length === 0;
  if (host.hidden) return;
  host.open = openMultiplexers.has(provider.id);
  host.querySelector('summary').dataset.muxFocus = provider.id + ':multiplexers';
  host.addEventListener('toggle', () => host.open ? openMultiplexers.add(provider.id) : openMultiplexers.delete(provider.id));
  const refresh = host.querySelector('.multiplexer-refresh');
  refresh.dataset.muxFocus = provider.id + ':refresh';
  refresh.addEventListener('click', async () => {
    refresh.disabled = true;
    try {
      const result = await api('POST', '/providers/reload', {});
      state.providers = result.providers;
      renderProviders();
    } catch (err) {
      if (err instanceof AuthError) showAuth(err.message);
      else toast(err.message, 10000);
    } finally { refresh.disabled = false; }
  });
  host.querySelector('.multiplexer-list').replaceChildren(...tools.map((tool) => {
    const row = document.createElement('section');
    row.className = 'multiplexer-row';
    const title = document.createElement('strong');
    title.textContent = tool.tool;
    row.append(title);
    const key = provider.id + ':' + tool.id;
    if (tool.installable) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn primary';
      button.textContent = 'Install';
      button.disabled = tool.busy;
      button.title = tool.installCommand || '';
      button.dataset.muxFocus = key + ':install';
      button.addEventListener('click', () => manageMultiplexer(provider, tool, 'install'));
      row.append(button);
    }
    const note = document.createElement('p');
    note.className = 'multiplexer-note';
    note.textContent = [
      tool.busy ? 'Installation operation in progress…' : tool.guidance,
      tool.pendingCards ? `${tool.pendingCards} detached ${tool.tool} card(s) are waiting to be restored. Check the installation or remove finished cards, then Refresh.` : '',
      installNote(tool),
    ].filter(Boolean).join(' ');
    if (note.textContent) row.append(note);
    const copies = document.createElement('details');
    copies.className = 'copies';
    copies.append(document.createElement('summary'), document.createElement('ul'));
    row.append(copies);
    renderCopies(copies, { ...tool, id: key, warnings: [] }, card, {
      key, busy: tool.busy,
      update: (copy) => manageMultiplexer(provider, tool, 'update', copy),
      uninstall: (copy) => {
        const plan = copy.uninstall;
        const lines = [
          `Uninstall ${tool.tool} from ${copy.displayPath}?`,
          plan.command && `Runs: ${plan.command}`,
          ...plan.remove.map((p) => `Removes: ${p}`),
          plan.pathEntries && 'Removes only this installation’s entries from your user PATH.',
          'Your settings and session data are kept.',
        ].filter(Boolean);
        if (confirm(lines.join('\n'))) return manageMultiplexer(provider, tool, 'uninstall', copy);
      },
    });
    return row;
  }));
}

async function manageMultiplexer(provider, tool, kind, copy = null, force = false) {
  // Busy state also comes from the manager, covering other tabs and refreshes.
  tool.busy = true;
  renderProviders();
  try {
    const { session } = await api('POST', `/providers/${provider.id}/multiplexers/${tool.id}/${kind}`, { path: copy?.path, force });
    upsertSession(session);
    openPanel(session.id);
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    if (err.code === 'multiplexer_in_use' && !force) {
      const waiting = err.pending ? ` ${err.pending} detached cards are also waiting for the tool.` : '';
      if (confirm(`${err.message}${waiting} Continue anyway?`)) return manageMultiplexer(provider, tool, kind, copy, true);
    } else toast(err.message, 10000);
  } finally {
    // A successful operation stays busy until the manager sends fresh state.
    try {
      const result = await api('GET', '/providers');
      state.providers = result.providers;
    } catch { tool.busy = false; }
    renderProviders();
  }
}

function renderHint(hint, provider) {
  let text = '';
  if (!provider.available) text = provider.installable ? '' : provider.install || `${provider.command} was not found on PATH.`;
  else if (provider.versionStatus === 'failed') text = [provider.versionError, !provider.updateCommand && provider.updateGuidance].filter(Boolean).join(' ');
  else if (provider.updateAvailable && !provider.updateCommand) text = provider.updateGuidance || '';
  hint.hidden = !text;
  hint.replaceChildren(text);
  const docs = text && httpsHref(provider.docs);
  if (!docs) return;
  const link = document.createElement('a');
  link.className = 'console-link';
  link.href = docs;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Docs';
  hint.append(' ', link);
}

function renderVendorLinks(card, provider) {
  const usage = setVendorLink(card.querySelector('.usage-link'), provider.usageUrl, `${provider.vendor} usage console`);
  const billing = setVendorLink(card.querySelector('.billing-link'), provider.billingUrl, `${provider.vendor} billing console`);
  card.querySelector('.provider-links').hidden = !usage && !billing;
  setVendorLink(card.querySelector('.cloud-link'), provider.cloudUrl, `${provider.vendor} web app`);
}

/** Point a link at an https URL, or hide it. Returns whether it is shown. */
function setVendorLink(link, url, label) {
  const href = httpsHref(url);
  link.hidden = !href;
  if (!href) { link.removeAttribute('href'); return false; }
  link.href = href;
  link.title = `${label}: ${href}`;
  link.setAttribute('aria-label', `${label} (opens in a new tab)`);
  return true;
}

function renderTier(card, provider, usage) {
  const tier = card.querySelector('.tier');
  const label = provider.available && usage?.plan ? planLabel(usage.plan) : '';
  tier.hidden = !label;
  tier.textContent = label;
  tier.title = label ? `${provider.vendor} subscription: ${label}` : '';
}

/** One line for a prepaid credit balance, when the provider reports one. */
function creditsNote(usage) {
  if (typeof usage?.credits !== 'number' || !Number.isFinite(usage.credits)) return [];
  const note = document.createElement('div');
  note.className = 'usage-note';
  note.textContent = `Credits: ${usage.credits.toLocaleString(undefined, { maximumFractionDigits: 2 })} left`;
  note.title = note.textContent;
  return [note];
}

function renderUsage(card, provider) {
  const host = card.querySelector('.usage');
  const account = selectedAccount(provider);
  const usage = usageFor(provider, account);
  renderTier(card, provider, provider.usageSource ? usage : null);
  const start = card.querySelector('.new');
  const unsigned = Boolean(provider.available && usage?.signedIn === false);
  start.textContent = unsigned ? 'Sign in' : 'New';
  start.title = unsigned
    ? `Start a ${provider.tool} session and sign in as the ${account.label} account`
    : `Start a new ${provider.tool} session${provider.accounts?.length > 1 ? ` as the ${account.label} account` : ''}${provider.shells?.length > 1 ? ` in ${selectedShell(provider)?.label}` : ''}`;
  if (!provider.available || !provider.usageSource || !usage) return host.replaceChildren();
  if (usage.error || usage.windows.length === 0) {
    const note = document.createElement('div');
    note.className = 'usage-note';
    note.textContent = unsigned ? 'Not signed in yet' : `Usage: ${usage.error || 'no limits reported'}`;
    note.title = unsigned ? usage.error : note.textContent;
    return host.replaceChildren(note, ...creditsNote(usage));
  }
  host.replaceChildren(...usage.windows.map((w) => {
    const node = $('meter-template').content.firstElementChild.cloneNode(true);
    const left = Math.max(0, Math.round(100 - w.usedPercent));
    node.classList.toggle('low', left <= 25 && left > 10);
    node.classList.toggle('empty', left <= 10);
    node.querySelector('.meter-label').textContent = w.label;
    node.querySelector('.meter-fill').style.width = `${left}%`;
    node.querySelector('.meter-value').textContent = `${left}% left`;
    const when = untilTime(w.resetsAt);
    node.title = `${w.label}: ${Math.round(w.usedPercent)}% used${when ? `, ${when}` : ''}${usage.plan ? ` (${usage.plan} plan)` : ''}`;
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', node.title);
    return node;
  }), ...creditsNote(usage));
}

async function loadUsage() {
  let usage;
  try { ({ usage } = await api('GET', '/usage')); } catch { return; }
  state.usage = new Map(usage.map((u) => [`${u.providerId}/${u.accountId ?? 'default'}`, u]));
  for (const card of $('providers').children) {
    const provider = state.providers.find((p) => p.id === card.dataset.id);
    if (!provider) continue;
    renderAccounts(card, provider);
    renderUsage(card, provider);
  }
}

const ARTIFICIAL_ANALYSIS = 'Artificial Analysis';
const MODELS_SHOWN = 8;
const modelsView = { providerId: null, sessionId: null, focus: null, all: false, expanded: new Set() };
let modelsOpener = null;
let statsLoading = null;
let statsAgain = false;
let statsTimer;

function modelKey(s) {
  return s.model ? `${s.model.name}\n${s.model.displayName ?? ''}` : '';
}

function sessionModelId(s) {
  return state.statsFor.get(s.id) === modelKey(s) ? state.stats?.sessions[s.id] ?? null : null;
}

function loadStats() {
  if (statsLoading) {
    statsAgain = true;
    return statsLoading;
  }
  const asked = new Map([...state.sessions.values()].map((s) => [s.id, modelKey(s)]));
  statsLoading = api('GET', '/model-stats').then((stats) => {
    state.stats = stats;
    state.statsFor = asked;
    for (const card of $('providers').children) {
      const provider = state.providers.find((p) => p.id === card.dataset.id);
      if (provider) renderModelStats(card, provider);
    }
    renderSessions();
    if ($('models').open) {
      const body = document.querySelector('.models-body');
      const top = body.scrollTop;
      const focus = modelsFocus();
      const withTip = Boolean(tipFor?.closest('#models-list'));
      renderModels();
      body.scrollTop = top;
      restoreModelsFocus(focus, withTip);
    }
    if (tipFor && !tipFor.isConnected) hideTip();
  }, () => {}).finally(() => {
    statsLoading = null;
    if (statsAgain) {
      statsAgain = false;
      loadStats();
    }
  });
  return statsLoading;
}

function scheduleStats() {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(loadStats, 300);
}

function indexStats() {
  return state.stats?.stats.filter((stat) => stat.group === ARTIFICIAL_ANALYSIS) ?? [];
}

function ordinal(n) {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]}`;
}

function listJoin(items) {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function formatTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1e6) return `${Number((n / 1e6).toFixed(2))}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

function formatPrice(n) {
  return `$${Number(n.toFixed(n < 1 ? 3 : 2))}`;
}

function formatDate(iso, options = { year: 'numeric', month: 'short', day: 'numeric' }) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, options);
}

function statValue(stat, entry) {
  return stat.group === ARTIFICIAL_ANALYSIS ? String(entry.value) : `Elo ${entry.value}`;
}

function statPlace(entry) {
  return `${entry.tied ? 'tied ' : ''}${ordinal(entry.place)} of ${entry.of}`;
}

function statSummary(stat, entry) {
  if (!entry) return `${stat.label}: no published result`;
  const value = `${stat.label} ${statValue(stat, entry)}`;
  if (entry.level === null) return `${value}: no other model has this result to compare with`;
  const rank = entry.rank === null ? '' : `, Design Arena rank ${entry.rank}`;
  return `${value}: level ${entry.level}, tier ${entry.tier}, ${statPlace(entry)}${rank}`;
}

function levelValue(entry) {
  if (!entry) return ['—'];
  if (entry.level === null) return [String(entry.value)];
  const tier = document.createElement('span');
  tier.className = 'stat-tier';
  tier.textContent = entry.tier;
  const level = document.createElement('span');
  level.className = 'level';
  level.textContent = entry.level;
  return [tier, level];
}

function tierClass(entry) {
  return entry?.tier ? `tier-${entry.tier.toLowerCase()}` : '';
}

function statRow(stat, card, { detail = false } = {}) {
  const node = $('stat-template').content.firstElementChild.cloneNode(true);
  const entry = card.stats[stat.id];
  node.querySelector('.stat-name').textContent = detail ? stat.label : stat.short;
  const info = node.querySelector('.info');
  info.dataset.stat = stat.id;
  info.setAttribute('aria-label', `${stat.label}: ${stat.about}`);
  const reading = node.querySelector('.stat-reading');
  reading.querySelector('.stat-value').replaceChildren(...levelValue(entry));
  node.classList.toggle('unmeasured', !entry);
  if (entry?.tier) {
    node.classList.add(tierClass(entry));
    reading.querySelector('.stat-fill').style.width = `${entry.level}%`;
  }
  if (detail) {
    const rank = entry?.rank == null ? '' : ` · Rank ${entry.rank}`;
    reading.querySelector('.stat-note').textContent = !entry ? 'No published result'
      : entry.level === null ? statValue(stat, entry) : `${statPlace(entry)} · ${statValue(stat, entry)}${rank}`;
  }
  reading.title = statSummary(stat, entry);
  reading.setAttribute('aria-label', reading.title);
  return node;
}

let tipFor = null;
let quietFocus = false;

function showTip(button) {
  const stat = state.stats?.stats.find((s) => s.id === button.dataset.stat);
  if (!stat) return;
  const tip = $('tip');
  $('tip-title').textContent = stat.label;
  $('tip-source').textContent = stat.group;
  $('tip-text').textContent = stat.about;
  const host = $('models').open ? $('models') : document.body;
  if (tip.parentElement !== host) host.append(tip);
  tip.hidden = false;
  const box = button.getBoundingClientRect();
  const left = Math.min(Math.max(8, box.left + box.width / 2 - tip.offsetWidth / 2), innerWidth - tip.offsetWidth - 8);
  const below = box.bottom + 8 + tip.offsetHeight <= innerHeight;
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(below ? box.bottom + 8 : box.top - tip.offsetHeight - 8)}px`;
  tipFor = button;
}

function hideTip() {
  $('tip').hidden = true;
  tipFor = null;
}

function renderModelStats(card, provider) {
  const host = card.querySelector('.model-stats');
  const stats = state.stats;
  const entry = stats?.providers[provider.id];
  if (!entry) {
    if (!stats?.error || !provider.modelPattern) return host.replaceChildren();
    const note = document.createElement('div');
    note.className = 'usage-note';
    note.textContent = `Benchmarks: ${stats.error}`;
    note.title = note.textContent;
    return host.replaceChildren(note);
  }
  const featured = stats.models[entry.featured];
  const count = entry.models.length;
  const complete = indexStats().every((stat) => featured.stats[stat.id]);
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'model-stats-head';
  head.textContent = `${featured.name} · ${count} model${count === 1 ? '' : 's'}`;
  head.setAttribute('aria-label', head.textContent);
  head.title = `${featured.name} is the newest ${provider.tool} model with ${complete ? 'all three Artificial Analysis indexes' : 'published benchmarks'}. Open to compare ${count === 1 ? 'it' : `all ${count}`}.`;
  head.addEventListener('click', () => showModels({ providerId: provider.id, focus: featured.id }));
  host.replaceChildren(head, ...indexStats().map((stat) => statRow(stat, featured)));
}

function modelStatsLine(s) {
  const id = sessionModelId(s);
  const card = id ? state.stats.models[id] : null;
  if (!card) return '';
  return indexStats().map((stat) => {
    const entry = card.stats[stat.id];
    return `${stat.short} ${entry?.tier ? `${entry.tier} ${entry.level}` : '—'}`;
  }).join(' · ');
}

function modelsFocus() {
  const active = document.activeElement;
  const row = active?.closest?.('#models-list .model');
  return row ? { id: row.dataset.id, stat: active.dataset.stat ?? null } : null;
}

function restoreModelsFocus(focus, withTip) {
  const row = focus && [...$('models-list').children].find((el) => el.dataset.id === focus.id);
  if (!row) return;
  const info = focus.stat && row.querySelector(`.info[data-stat="${focus.stat}"]`);
  quietFocus = true;
  (info || row.querySelector('.model-toggle')).focus({ preventScroll: true });
  quietFocus = false;
  if (withTip && info) showTip(info);
}

function showModels({ providerId = null, sessionId = null, focus = null }) {
  Object.assign(modelsView, { providerId, sessionId, focus, all: false, expanded: new Set(focus ? [focus] : []) });
  const dialog = $('models');
  renderModels();
  if (!dialog.open) {
    modelsOpener = document.activeElement;
    dialog.showModal();
  }
  const toggle = $('models-list').querySelector('[aria-expanded="true"]');
  toggle?.focus();
  toggle?.scrollIntoView({ block: 'nearest' });
}

function openSessionModel(id) {
  const s = state.sessions.get(id);
  if (!s?.model) return;
  if (!state.stats || state.statsFor.get(id) !== modelKey(s)) scheduleStats();
  showModels({ sessionId: id, focus: sessionModelId(s) });
}

function unmatchedText(s) {
  const stats = state.stats;
  if (!stats) return 'Loading benchmarks from OpenRouter…';
  if (!stats.pool) return `Benchmarks are unavailable: ${stats.error}.`;
  if (!(s.id in stats.sessions) || state.statsFor.get(s.id) !== modelKey(s)) return 'Looking this model up in OpenRouter’s catalog…';
  const names = [s.model.name, s.model.displayName].filter((name, i, all) => name && all.indexOf(name) === i);
  return `OpenRouter’s catalog has no model named ${names.map((name) => `“${name}”`).join(' or ')}.`;
}

function sourceText(stats, { levels = true } = {}) {
  if (!stats?.retrievedAt) return '';
  const parts = [`Benchmarks from Artificial Analysis and Design Arena via OpenRouter, fetched ${relativeTime(stats.retrievedAt)}.`];
  if (stats.stale) parts.push(`The last refresh failed (${stats.error}), so these results may be out of date.`);
  if (stats.pool && levels) {
    parts.push('Artificial Analysis results are index scores. Design Arena results are Elo ratings from real users\' head-to-head votes, and Rank is the model\'s place on Design Arena\'s own leaderboard.');
    parts.push(`Level 0–100 is a model's standing on each benchmark among the models ${listJoin(stats.pool.tools)} run; 100 is the best result.`);
    parts.push('Tier: S 90+, A 75+, B 50+, C 25+, D below 25.');
  }
  return parts.join(' ');
}

function usedBy(id) {
  return [...state.sessions.values()]
    .filter((s) => s.status === 'running' && sessionModelId(s) === id)
    .map((s) => s.name);
}

function badge(kind, label, title) {
  const el = document.createElement('span');
  el.className = `badge ${kind}`;
  el.textContent = label;
  el.title = title;
  return el;
}

function modelFacts(card) {
  const list = document.createElement('dl');
  list.className = 'model-facts';
  const fact = (term, value) => {
    if (!value) return;
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = term;
    dd.textContent = value;
    row.append(dt, dd);
    list.append(row);
  };
  fact('Context', card.context ? `${formatTokens(card.context)} tokens` : '');
  fact('Max output', card.maxOutput ? `${formatTokens(card.maxOutput)} tokens` : '');
  fact('Input', card.input.join(', '));
  fact('Reasoning effort', card.reasoning.join(', '));
  if (card.price.input !== null && card.price.output !== null) {
    fact('Price', `${formatPrice(card.price.input)} input · ${formatPrice(card.price.output)} output per 1M tokens`);
  }
  fact('Created', card.created ? formatDate(card.created) : '');
  fact('Expires', card.expires ? formatDate(card.expires, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '');
  const link = document.createElement('a');
  link.className = 'console-link';
  link.href = httpsHref(`https://openrouter.ai/${card.id}`) ?? '';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'OpenRouter';
  link.setAttribute('aria-label', `${card.name} on OpenRouter (opens in a new tab)`);
  const facts = document.createElement('div');
  facts.className = 'model-more';
  facts.append(list, link);
  return facts;
}

function modelDetail(card) {
  const groups = [];
  for (const stat of state.stats.stats) {
    if (groups.at(-1)?.name !== stat.group) groups.push({ name: stat.group, stats: [] });
    groups.at(-1).stats.push(stat);
  }
  const sections = groups.map(({ name, stats }) => {
    const section = document.createElement('div');
    section.className = 'model-group';
    const heading = document.createElement('h4');
    heading.textContent = name;
    section.append(heading);
    if (stats.some((stat) => card.stats[stat.id])) {
      section.append(...stats.map((stat) => statRow(stat, card, { detail: true })));
    } else {
      const none = document.createElement('p');
      none.className = 'model-none';
      none.textContent = 'No published results';
      section.append(none);
    }
    return section;
  });
  return [...sections, modelFacts(card)];
}

function modelRow(card) {
  const node = $('model-template').content.firstElementChild.cloneNode(true);
  node.dataset.id = card.id;
  const toggle = node.querySelector('.model-toggle');
  const detail = node.querySelector('.model-detail');
  node.querySelector('.model-name').textContent = card.name;
  const users = usedBy(card.id);
  const badges = [];
  if (users.length) badges.push(badge('in-use', 'In use', `Used by ${listJoin(users)}`));
  if (card.new) badges.push(badge('new', 'New', `Created ${formatDate(card.created)}`));
  if (card.expires) {
    const day = formatDate(card.expires, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    badges.push(badge('expires', `Expires ${day}`, `OpenRouter lists this model as expiring on ${formatDate(card.expires, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })}`));
  }
  node.querySelector('.model-title').append(...badges);
  for (const stat of indexStats()) {
    const entry = card.stats[stat.id];
    const cell = document.createElement('span');
    cell.className = ['model-index', tierClass(entry), entry ? '' : 'unmeasured'].filter(Boolean).join(' ');
    cell.replaceChildren(...levelValue(entry));
    cell.title = statSummary(stat, entry);
    toggle.append(cell);
  }
  const context = document.createElement('span');
  context.className = 'model-context';
  context.textContent = formatTokens(card.context);
  context.title = card.context ? `Context: ${card.context.toLocaleString()} tokens` : 'Context: not listed';
  toggle.append(context);
  const summary = indexStats().map((stat) => statSummary(stat, card.stats[stat.id])).join('. ');
  toggle.setAttribute('aria-description', summary);
  const expand = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    if (open && !detail.childElementCount) detail.replaceChildren(...modelDetail(card));
    detail.hidden = !open;
  };
  expand(modelsView.expanded.has(card.id));
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    if (open) modelsView.expanded.add(card.id);
    else modelsView.expanded.delete(card.id);
    expand(open);
  });
  return node;
}

function renderModels() {
  const stats = state.stats;
  const session = modelsView.sessionId ? state.sessions.get(modelsView.sessionId) : null;
  const provider = session?.provider ?? state.providers.find((p) => p.id === modelsView.providerId);
  if (!provider || (modelsView.sessionId && !session?.model)) return $('models').close();
  paintProviderIcon($('models-icon'), provider);
  const list = stats?.providers[provider.id]?.models ?? [];
  let ids = list;
  let title = `${provider.tool} models`;
  let note = '';
  if (session) {
    const id = sessionModelId(session);
    if (id && !modelsView.focus) {
      modelsView.focus = id;
      modelsView.expanded.add(id);
    }
    if (!id) {
      ids = [];
      title = `${provider.tool} · ${modelText(session)}`;
      note = unmatchedText(session);
    } else if (!list.includes(id)) {
      ids = [id];
      title = `${provider.tool} · ${stats.models[id].name}`;
    }
  } else if (!stats) {
    note = 'Loading benchmarks from OpenRouter…';
  } else if (list.length === 0) {
    note = stats.error ? `Benchmarks are unavailable: ${stats.error}.` : `OpenRouter lists no benchmarked ${provider.tool} models.`;
  }
  $('models-title').textContent = title;
  $('models-sub').textContent = ids.length > 1
    ? `${ids.length} models with published benchmarks, newest first`
    : session ? `Reported by ${session.name} as “${session.model.name}”` : '';
  const all = modelsView.all || ids.length <= MODELS_SHOWN || ids.indexOf(modelsView.focus) >= MODELS_SHOWN;
  const shown = all ? ids : ids.slice(0, MODELS_SHOWN);
  const columns = $('models-columns');
  columns.hidden = shown.length === 0;
  columns.replaceChildren(...['Model', ...indexStats().map((stat) => stat.short), 'Context'].map((label) => {
    const span = document.createElement('span');
    span.textContent = label;
    return span;
  }));
  $('models-list').replaceChildren(...shown.map((id) => modelRow(stats.models[id])));
  const more = $('models-more');
  more.hidden = all;
  more.textContent = `Show ${ids.length - shown.length} older models`;
  $('models-note').textContent = note;
  $('models-note').hidden = !note;
  $('models-source').textContent = sourceText(stats, { levels: shown.length > 0 });
  $('models-source').hidden = !$('models-source').textContent;
}

function closeModels() {
  if ($('models').open) $('models').close();
}

const NEWS_LATEST = 5;
const NEWS_POLL_MS = 10 * 60 * 1000;
const NEWS_FILTERS = [['all', 'All'], ['news', 'News'], ['releases', 'Releases'], ['research', 'Research']];
const newsView = { shown: null, since: Infinity, filter: 'all', opener: null };
let newsLoading = null;
let newsAgain = false;
let newsLoadedAt = 0;

function newsSeen() {
  const seen = Date.parse(load(NEWS_SEEN_KEY));
  return Number.isFinite(seen) ? seen : null;
}

function newestTime(items) {
  return items.reduce((newest, item) => Math.max(newest, Date.parse(item.publishedAt) || 0), 0);
}

function loadNews() {
  if (newsLoading) {
    newsAgain = true;
    return newsLoading;
  }
  newsLoading = api('GET', '/news').then(setNews, () => {}).finally(() => {
    newsLoading = null;
    newsLoadedAt = Date.now();
    if (newsAgain) {
      newsAgain = false;
      loadNews();
    }
  });
  return newsLoading;
}

function setNews(news) {
  state.news = news;
  if (newsSeen() === null && news.items.length) save(NEWS_SEEN_KEY, new Date(newestTime(news.items)).toISOString());
  renderLatestNews();
  if ($('news').open) updateNewsPanel();
}

function webHref(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function newsTitle(item) {
  const href = webHref(item.url);
  const title = document.createElement(href ? 'a' : 'span');
  title.className = 'news-link';
  title.textContent = item.title;
  if (href) {
    title.href = href;
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    title.setAttribute('aria-description', 'Opens in a new tab');
  }
  return title;
}

function newsMeta(item) {
  const meta = document.createElement('span');
  meta.className = 'news-meta';
  const time = document.createElement('time');
  time.dateTime = item.publishedAt;
  time.textContent = relativeTime(item.publishedAt);
  time.title = new Date(item.publishedAt).toLocaleString();
  meta.append(`${item.source} · `, time);
  return meta;
}

function isNew(item, since) {
  return Date.parse(item.publishedAt) > since;
}

function newBadge() {
  return badge('new', 'New', 'Published since you last opened the news');
}

function latestNews(items) {
  const sources = new Set();
  const latest = [];
  for (const item of items) {
    if (item.category !== 'news' || sources.has(item.source)) continue;
    sources.add(item.source);
    latest.push(item);
    if (latest.length === NEWS_LATEST) break;
  }
  return latest;
}

function failureLines(news) {
  const groups = new Map();
  for (const source of news.sources) if (source.error) groups.set(source.error, [...(groups.get(source.error) ?? []), source]);
  return [...groups].map(([error, sources]) => {
    if (sources.length === 1) {
      const [source] = sources;
      return `${source.name}: ${error} · ${source.okAt ? `showing items fetched ${relativeTime(source.okAt)}` : 'nothing fetched yet'}`;
    }
    const names = [...new Set(sources.map((source) => source.name))];
    return `${names.length <= 3 ? listJoin(names) : `${sources.length} sources`}: ${error}`;
  });
}

function newsNote(news) {
  if (!news || (news.refreshing && news.items.length === 0)) return 'Loading news…';
  const failed = news.sources.filter((s) => s.error);
  if (news.items.length === 0 && failed.length > 0 && failed.length === news.sources.length) {
    return `News could not be loaded. ${failureLines(news)[0]}. Agent Guild tries again in a few minutes.`;
  }
  return 'No news from the last 30 days.';
}

function renderLatestNews() {
  const news = state.news;
  const list = $('news-latest');
  const seen = newsSeen() ?? Infinity;
  const items = news ? latestNews(news.items) : [];
  const focused = document.activeElement?.closest?.('#news-latest .news-row')?.dataset.id;
  list.replaceChildren(...items.map((item) => {
    const row = document.createElement('li');
    row.className = 'news-row';
    row.dataset.id = item.id;
    row.append(newsTitle(item), ...(isNew(item, seen) ? [newBadge()] : []), newsMeta(item));
    return row;
  }));
  if (focused) [...list.children].find((row) => row.dataset.id === focused)?.querySelector('.news-link')?.focus({ preventScroll: true });
  list.hidden = items.length === 0;
  const fresh = news ? news.items.filter((item) => item.category === 'news' && isNew(item, seen)).length : 0;
  $('news-count').textContent = fresh ? `· ${fresh} new` : '';
  $('news-note').textContent = items.length ? '' : newsNote(news);
  $('news-note').hidden = items.length > 0;
}

function dayLabel(time) {
  const date = new Date(time);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function newsEntry(item) {
  const entry = document.createElement('li');
  entry.className = 'news-item';
  entry.dataset.id = item.id;
  const head = document.createElement('div');
  head.className = 'news-head';
  head.append(newsTitle(item), ...(isNew(item, newsView.since) ? [newBadge()] : []));
  entry.append(head, newsMeta(item));
  if (item.summary) {
    const summary = document.createElement('p');
    summary.className = 'news-summary';
    const discussion = webHref(item.discussion);
    if (discussion) {
      const link = document.createElement('a');
      link.className = 'news-discussion';
      link.href = discussion;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = item.summary;
      link.setAttribute('aria-description', `Opens the discussion on ${item.source} in a new tab`);
      summary.append(link);
    } else {
      summary.textContent = item.summary;
    }
    entry.append(summary);
  }
  return entry;
}

function renderNewsFilters() {
  $('news-filters').replaceChildren(...NEWS_FILTERS.map(([id, label]) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'news-filter';
    chip.textContent = label;
    chip.setAttribute('aria-pressed', String(id === newsView.filter));
    chip.addEventListener('click', () => {
      newsView.filter = id;
      save(NEWS_FILTER_KEY, id);
      for (const other of $('news-filters').children) other.setAttribute('aria-pressed', String(other === chip));
      newsView.shown = state.news;
      renderNewsList();
      document.querySelector('.news-body').scrollTop = 0;
    });
    return chip;
  }));
}

function renderNewsList() {
  const shown = newsView.shown;
  const items = (shown?.items ?? []).filter((item) => newsView.filter === 'all' || item.category === newsView.filter);
  const groups = [];
  for (const item of items) {
    const label = dayLabel(Date.parse(item.publishedAt));
    if (groups.at(-1)?.label !== label) groups.push({ label, items: [] });
    groups.at(-1).items.push(item);
  }
  $('news-list').replaceChildren(...groups.map((group) => {
    const section = document.createElement('section');
    section.className = 'news-group';
    const heading = document.createElement('h3');
    heading.className = 'news-day';
    heading.textContent = group.label;
    const list = document.createElement('ul');
    list.className = 'news-items';
    list.append(...group.items.map(newsEntry));
    section.append(heading, list);
    return section;
  }));
  const label = NEWS_FILTERS.find(([id]) => id === newsView.filter)[1];
  $('news-empty').textContent = items.length ? '' : newsView.filter === 'all' || !shown ? newsNote(shown) : `Nothing in ${label} from the last 30 days.`;
  $('news-empty').hidden = items.length > 0;
  $('news-fresh').hidden = true;
  const fresh = (shown?.items ?? []).filter((item) => isNew(item, newsView.since)).length;
  $('news-sub').textContent = fresh ? `${fresh} new since your last visit` : 'Newest first';
}

function renderNewsStatus() {
  const news = state.news;
  const status = $('news-status');
  status.hidden = !news;
  if (!news) return;
  const updated = news.refreshing ? 'checking for news…' : news.refreshedAt ? `updated ${relativeTime(news.refreshedAt)}` : '';
  const lines = [[`${news.sources.length} source${news.sources.length === 1 ? '' : 's'}`, updated].filter(Boolean).join(' · '), ...failureLines(news)];
  status.replaceChildren(...lines.map((text) => {
    const line = document.createElement('span');
    line.textContent = text;
    return line;
  }));
}

function updateNewsPanel() {
  renderNewsStatus();
  if (!newsView.shown?.items.length) {
    newsView.shown = state.news;
    renderNewsList();
    return;
  }
  const shownIds = new Set(newsView.shown.items.map((item) => item.id));
  const added = state.news.items.filter((item) => !shownIds.has(item.id) && (newsView.filter === 'all' || item.category === newsView.filter)).length;
  const fresh = $('news-fresh');
  fresh.hidden = added === 0;
  fresh.textContent = `Show ${added} new item${added === 1 ? '' : 's'}`;
}

function showFreshNews() {
  const before = new Set(newsView.shown.items.map((item) => item.id));
  newsView.shown = state.news;
  renderNewsList();
  const first = [...$('news-list').querySelectorAll('.news-item')].find((entry) => !before.has(entry.dataset.id));
  (first?.querySelector('.news-link') ?? $('news-close')).focus();
}

function openNews() {
  const dialog = $('news');
  const saved = load(NEWS_FILTER_KEY);
  newsView.filter = NEWS_FILTERS.some(([id]) => id === saved) ? saved : 'all';
  newsView.since = newsSeen() ?? Infinity;
  newsView.shown = state.news;
  renderNewsFilters();
  renderNewsList();
  renderNewsStatus();
  if (!dialog.open) {
    newsView.opener = document.activeElement;
    dialog.showModal();
  }
  ($('news-list').querySelector('.news-link') ?? $('news-close')).focus();
  if (!state.news) loadNews();
}

function closeNews() {
  if ($('news').open) $('news').close();
}

function tickNews() {
  for (const time of document.querySelectorAll('#news-latest time, #news-list time')) time.textContent = relativeTime(time.dateTime);
  if ($('news').open) renderNewsStatus();
}

const RELEASE_BADGES = {
  running: ['in-use', 'Running', 'The session manager runs this version'],
  installed: ['installed', 'Installed', 'Installed. Restart the session manager to use it.'],
  newer: ['new', 'New', 'Released after the version the session manager runs'],
};
const changelogView = { opener: null, failed: null, seen: null };
let changelogLoading = null;
let changelogAgain = false;

function loadChangelog() {
  if (changelogLoading) {
    changelogAgain = true;
    return changelogLoading;
  }
  changelogLoading = api('GET', '/changelog').then((changelog) => {
    state.changelog = changelog;
    changelogView.failed = null;
  }, (err) => {
    if (err instanceof AuthError) return showAuth(err.message);
    changelogView.failed = state.connected ? err.message : 'the session manager is not reachable';
  }).finally(() => {
    changelogLoading = null;
    if ($('changelog').open) {
      markReleasesSeen(state.changelog?.releases[0]?.version);
      renderVersion();
      renderChangelog();
    }
    if (changelogAgain) {
      changelogAgain = false;
      loadChangelog();
    }
  });
  return changelogLoading;
}

function openChangelog() {
  const dialog = $('changelog');
  renderChangelog();
  if (!dialog.open) {
    changelogView.opener = document.activeElement;
    dialog.showModal();
  }
  ($('changelog-list').querySelector('a') ?? $('changelog-close')).focus();
  markReleasesSeen(state.version, state.upgrade?.pendingVersion, state.upgrade?.latestVersion, state.changelog?.releases[0]?.version);
  renderVersion();
  loadChangelog();
}

function closeChangelog() {
  if ($('changelog').open) $('changelog').close();
}

function releasesLink(label) {
  const link = document.createElement('a');
  link.className = 'console-link';
  link.href = RELEASES_URL;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = label;
  link.setAttribute('aria-description', 'Opens in a new tab');
  return link;
}

function releaseStatus(version) {
  const running = state.version;
  if (!RELEASE_VERSION.test(running ?? '')) return null;
  const order = compareReleases(version, running);
  if (order <= 0) return order === 0 ? 'running' : null;
  const installed = state.upgrade?.pendingVersion;
  return RELEASE_VERSION.test(installed ?? '') && compareReleases(version, installed) <= 0 ? 'installed' : 'newer';
}

function changeRun(run) {
  const href = run.url ? webHref(run.url) : null;
  let node;
  if (href) {
    node = document.createElement('a');
    node.className = 'console-link';
    node.href = href;
    node.target = '_blank';
    node.rel = 'noopener noreferrer';
    node.textContent = run.text;
  } else if (run.code) {
    node = document.createElement('code');
    node.textContent = run.text;
  } else {
    node = document.createTextNode(run.text);
  }
  if (!run.strong) return node;
  const strong = document.createElement('strong');
  strong.append(node);
  return strong;
}

function changeGroup(section) {
  const group = document.createElement('div');
  group.className = 'changelog-group';
  if (section.title) {
    const title = document.createElement('h4');
    title.className = 'changelog-type';
    title.classList.toggle('breaking', /breaking/i.test(section.title));
    title.textContent = section.title;
    group.append(title);
  }
  const list = document.createElement('ul');
  list.className = 'changelog-changes';
  list.append(...section.changes.map((runs) => {
    const item = document.createElement('li');
    item.append(...runs.map(changeRun));
    return item;
  }));
  group.append(list);
  return group;
}

function releaseEntry(release) {
  const entry = document.createElement('li');
  entry.className = 'changelog-release';
  entry.dataset.version = release.version;
  const heading = document.createElement('h3');
  heading.className = 'news-head';
  const href = webHref(release.url);
  const title = document.createElement(href ? 'a' : 'span');
  title.className = 'news-link';
  title.textContent = `v${release.version}`;
  if (href) {
    title.href = href;
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    title.setAttribute('aria-description', 'Opens the release on GitHub in a new tab');
  }
  heading.append(title);
  const status = releaseStatus(release.version);
  if (status) heading.append(badge(...RELEASE_BADGES[status]));
  entry.append(heading);
  if (release.publishedAt) {
    const time = document.createElement('time');
    time.className = 'news-meta';
    time.dateTime = release.publishedAt;
    time.textContent = relativeTime(release.publishedAt);
    time.title = new Date(release.publishedAt).toLocaleString();
    entry.append(time);
  }
  entry.append(...release.sections.map(changeGroup));
  return entry;
}

function changelogSummary() {
  const v = state.version;
  if (!v) return 'Agent Guild releases, newest first';
  if (isDevelopmentBuild(v)) return `Development build (${v}) · releases, newest first`;
  const u = state.upgrade;
  const parts = [`Running v${v}`];
  if (u?.pendingVersion) parts.push(`v${u.pendingVersion} installed`);
  const newer = state.changelog?.releases.some((release) => compareReleases(release.version, v) > 0);
  if (u?.available && u.latestVersion) parts.push(`v${u.latestVersion} available`);
  else if (!u?.pendingVersion && u?.latestVersion === v && !newer) parts.push('the latest release');
  return parts.join(' · ');
}

function changelogNote(changelog) {
  if (changelog?.releases.length) return [];
  if (changelogView.failed) return [`Release notes could not be loaded: ${changelogView.failed}. `, releasesLink('Read them on GitHub')];
  if (!changelog || changelog.refreshing) return ['Loading release notes…'];
  if (changelog.error) return [`Release notes could not be loaded. GitHub Releases: ${changelog.error}. `, releasesLink('Read them on GitHub')];
  return ['No releases yet.'];
}

function renderChangelogStatus(changelog) {
  const lines = [];
  if (changelog) {
    const updated = changelog.refreshing ? 'checking for new releases…' : changelog.okAt ? `updated ${relativeTime(changelog.okAt)}` : '';
    lines.push(['From GitHub Releases', updated].filter(Boolean).join(' · '));
    if (changelog.error && changelog.releases.length) lines.push(`The last check failed (${changelog.error}); showing notes fetched ${relativeTime(changelog.okAt)}.`);
  }
  lines.push(releasesLink('All releases on GitHub'));
  $('changelog-status').replaceChildren(...lines.map((content) => {
    const line = document.createElement('span');
    line.append(content);
    return line;
  }));
  $('changelog-status').hidden = false;
}

function renderChangelog() {
  const changelog = state.changelog;
  const releases = changelog?.releases ?? [];
  $('changelog-sub').textContent = changelogSummary();
  const list = $('changelog-list');
  const body = list.parentElement;
  const top = body.scrollTop;
  const entry = document.activeElement?.closest?.('#changelog-list .changelog-release');
  const focus = entry && { version: entry.dataset.version, index: [...entry.querySelectorAll('a')].indexOf(document.activeElement) };
  list.replaceChildren(...releases.map(releaseEntry));
  list.hidden = releases.length === 0;
  const note = changelogNote(changelog);
  $('changelog-note').replaceChildren(...note);
  $('changelog-note').hidden = note.length === 0;
  renderChangelogStatus(changelog);
  body.scrollTop = top;
  if (focus) {
    const again = [...list.children].find((el) => el.dataset.version === focus.version);
    (again?.querySelectorAll('a')[focus.index] ?? again?.querySelector('a') ?? $('changelog-close')).focus({ preventScroll: true });
  }
}

const CHANNEL_LABELS = {
  npm: 'npm', native: 'native', brew: 'Homebrew', winget: 'WinGet', system: 'system package', legacy: 'legacy install', unknown: 'unknown install',
};

function installNote(provider) {
  const last = provider.lastInstall;
  if (!last) return '';
  if (last.outcome === 'failed') {
    const what = { install: 'Install', uninstall: 'Uninstall' }[last.kind] || 'Update';
    return last.exitCode === null ? `${what} failed` : `${what} failed (exit ${last.exitCode})`;
  }
  if (last.kind === 'uninstall') return last.outcome === 'remaining' ? 'Uninstalled copy is still present' : '';
  if (last.verification === 'failed') return `Installation completed, but ${provider.tool} verification failed`;
  if (last.outcome === 'missing') return 'Installed, but not found on PATH';
  if (last.outcome === 'unchanged') return 'No version change after update';
  return '';
}

function providerState(provider) {
  const note = installNote(provider);
  if (!provider.available) return note ? `Not installed · ${note}` : 'Not installed';
  const checkFailed = provider.versionStatus === 'failed';
  const named = provider.installChannel && (provider.installChannel !== 'unknown' || provider.updateAvailable || checkFailed);
  const channel = named ? CHANNEL_LABELS[provider.installChannel] || provider.installChannel : '';
  if (checkFailed) {
    const unverified = note && provider.lastInstall.outcome !== 'failed' && provider.lastInstall.verification === 'failed';
    return (unverified ? [note, channel] : ['Version check failed', channel, note]).filter(Boolean).join(' · ');
  }
  const parts = ['Ready'];
  if (provider.installedVersion) parts.push(`v${provider.installedVersion}`);
  else if (provider.versionStatus === 'unavailable') parts.push('Version unavailable');
  if (channel) parts.push(channel);
  if (provider.updateAvailable) parts.push(`${provider.latestVersion} ${provider.installChannel === 'npm' ? 'available' : 'released'}`);
  if (note) parts.push(note);
  return parts.join(' · ');
}

function uninstallCopy(provider, card, install) {
  const what = install.uninstall.command
    ? [`Runs: ${install.uninstall.command}`, ...install.uninstall.remove.map((p) => `Then deletes: ${p}`)]
    : install.uninstall.remove.map((p) => `Deletes: ${p}`);
  if (!confirm([`Uninstall ${provider.tool} from ${install.displayPath}?`, '', ...what, '', 'Your sign-in, settings and history are kept.'].join('\n'))) return;
  return installProvider(provider, card, { path: install.path });
}

async function installProvider(provider, card, { force = false, path = null } = {}) {
  card.classList.add('busy');
  try {
    const { session } = path
      ? await api('POST', `/providers/${provider.id}/uninstall`, { path, force })
      : await api('POST', `/providers/${provider.id}/install`, { force });
    upsertSession(session);
    openPanel(session.id);
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    if (err.code === 'provider_in_use') {
      card.classList.remove('busy');
      const n = err.running;
      const what = `${n} ${provider.tool} session${n === 1 ? ' is' : 's are'} running`;
      const [doing, verb] = path ? ['Removing', 'Uninstall'] : ['Updating', 'Update'];
      if (confirm(`${what}. ${doing} ${provider.tool} while it runs can break ${n === 1 ? 'that session' : 'those sessions'}. ${verb} anyway?`)) {
        return installProvider(provider, card, { force: true, path });
      }
      return;
    }
    toast(err.message, 8000);
  } finally {
    card.classList.remove('busy');
  }
}

/**
 * Start a session. A resumed session starts in the folder its transcript
 * names, since Claude Code only finds a session from there;
 * when that folder is gone, the working folder is used instead.
 */
async function startSession(provider, card, { resume, cwd, account = selectedAccount(provider).id } = {}) {
  const working = $('cwd').value.trim();
  save(CWD_KEY, working);
  card?.classList.add('busy');
  try {
    const body = { providerId: provider.id, account, shell: pickedShell(provider)?.id, cwd: cwd || working || undefined, cols: 120, rows: 32, resume };
    let session;
    try {
      ({ session } = await api('POST', '/sessions', body));
    } catch (err) {
      if (err.code !== 'bad_cwd' || !cwd) throw err;
      toast(`${cwd} no longer exists; starting in the working folder instead.`, 8000);
      ({ session } = await api('POST', '/sessions', { ...body, cwd: working || undefined }));
    }
    upsertSession(session);
    rememberRecent('cwd', session.cwd);
    closeHistory({ focusOpener: false });
    openPanel(session.id);
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    toast(err.message, 8000);
  } finally {
    card?.classList.remove('busy');
  }
}

// ---- session history ------------------------------------------------------

const HISTORY_LIMIT = 200;
const historyView = { providerId: null, accountId: null, snapshot: null, loading: false };
let historyOpener = null;

function historyProvider() {
  return state.providers.find((p) => p.id === historyView.providerId) ?? null;
}

function toolSessionId(s) {
  return s.toolSessionId || s.resume || null;
}

function shortId(id) {
  return id.length > 12 ? id.slice(0, 8) : id;
}

function copyText(text, what) {
  navigator.clipboard?.writeText(text).then(() => toast(`Copied ${what}`, 2500), () => toast(text, 10000));
}

function copyId(id) {
  copyText(id, id);
}

function paintIdButton(button, id) {
  button.hidden = !id;
  if (!id) return;
  button.textContent = shortId(id);
  button.title = `Session id ${id}. Click to copy it.`;
  button.setAttribute('aria-label', `Copy session id ${id}`);
}

function runningOn(providerId, accountId, id) {
  return [...state.sessions.values()].find((s) =>
    s.status === 'running' && s.task === null && s.provider.id === providerId && (s.account?.id ?? 'default') === accountId && toolSessionId(s) === id) ?? null;
}

function showHistory(provider) {
  const account = selectedAccount(provider);
  const same = historyView.providerId === provider.id && historyView.accountId === account.id;
  if (!same) Object.assign(historyView, { providerId: provider.id, accountId: account.id, snapshot: null, loading: false });
  const dialog = $('history');
  $('history-filter').value = '';
  $('history-id').value = '';
  renderHistory();
  if (!dialog.open) {
    historyOpener = document.activeElement;
    dialog.showModal();
  }
  if (provider.historySource) loadHistory();
  else $('history-id').focus();
}

async function loadHistory() {
  const provider = historyProvider();
  if (!provider || historyView.loading) return;
  const { providerId, accountId } = historyView;
  historyView.loading = true;
  renderHistory();
  try {
    const { history } = await api('GET', `/providers/${providerId}/history?account=${encodeURIComponent(accountId)}&limit=${HISTORY_LIMIT}`);
    if (historyView.providerId === providerId && historyView.accountId === accountId) historyView.snapshot = history;
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    if (historyView.providerId === providerId) historyView.snapshot = { sessions: [], total: 0, error: err.message };
  } finally {
    historyView.loading = false;
    renderHistory();
  }
}

function historyText(entry) {
  return `${entry.title ?? ''}\n${entry.cwd ?? ''}\n${entry.id}`.toLowerCase();
}

function folderName(dir) {
  const parts = dir.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts.at(-1) || dir;
}

function sameFolder(a, b) {
  const clean = (dir) => (dir || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  return clean(a) === clean(b);
}

function historyEntry(id) {
  return historyView.snapshot?.sessions.find((entry) => entry.id === id) ?? null;
}

function resumeFromHistory(provider, id, cwd) {
  const running = runningOn(provider.id, historyView.accountId, id);
  if (running) {
    closeHistory({ focusOpener: false });
    openPanel(running.id);
  } else startSession(provider, null, { resume: id, cwd: cwd || undefined, account: historyView.accountId });
}

function buildHistoryRow(id) {
  const node = $('history-template').content.firstElementChild.cloneNode(true);
  node.dataset.id = id;
  const idButton = node.querySelector('.session-id');
  paintIdButton(idButton, id);
  idButton.addEventListener('click', () => copyId(id));
  node.querySelector('.history-resume').addEventListener('click', () => {
    const provider = historyProvider();
    const entry = historyEntry(id);
    if (provider && entry) resumeFromHistory(provider, id, entry.cwd);
  });
  return node;
}

function updateHistoryRow(node, provider, entry) {
  const running = runningOn(provider.id, historyView.accountId, entry.id);
  node.classList.toggle('untitled', !entry.title);
  node.classList.toggle('running', Boolean(running));
  node.querySelector('.history-title').textContent = entry.title ?? 'Untitled session';
  node.querySelector('.history-title').title = entry.title ?? '';
  const meta = node.querySelector('.history-meta');
  const when = entry.updatedAt ? `updated ${relativeTime(entry.updatedAt)}` : '';
  meta.textContent = [entry.cwd && folderName(entry.cwd), when, running && `open in Agent Guild as ${running.name}`].filter(Boolean).join(' · ');
  meta.title = [entry.cwd, entry.startedAt && `started ${new Date(entry.startedAt).toLocaleString()}`].filter(Boolean).join('\n');
  const action = node.querySelector('.history-resume');
  action.textContent = running ? 'Open' : 'Resume';
  action.title = running
    ? `This session is running in Agent Guild as "${running.name}". Open it instead of resuming it twice.`
    : `Resume this ${provider.tool} session${entry.cwd ? ` in ${entry.cwd}` : ''}`;
  action.setAttribute('aria-label', `${action.textContent} ${entry.title ?? entry.id}`);
}

/** Rows are kept and updated in place, so a refresh never drops keyboard focus from a row's buttons. */
function renderHistoryRows(provider, shown) {
  const list = $('history-list');
  const rows = new Map([...list.children].map((node) => [node.dataset.id, node]));
  const wanted = new Set(shown.map((entry) => entry.id));
  for (const [id, node] of rows) if (!wanted.has(id)) node.remove();
  shown.forEach((entry, index) => {
    let node = rows.get(entry.id);
    if (!node) node = buildHistoryRow(entry.id);
    updateHistoryRow(node, provider, entry);
    if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
  });
}

function renderHistory() {
  const provider = historyProvider();
  if (!provider) return closeHistory();
  const account = provider.accounts?.find((a) => a.id === historyView.accountId);
  paintProviderIcon($('history-icon'), provider);
  $('history-title').textContent = `${provider.tool} sessions`;
  const snapshot = historyView.snapshot;
  const filter = $('history-filter').value.trim().toLowerCase();
  const working = $('cwd').value.trim();
  const here = $('history-here');
  here.disabled = !working;
  here.parentElement.title = working ? `Only sessions started in ${working}` : 'Set a working folder above to filter by it';
  const all = snapshot?.sessions ?? [];
  const shown = all.filter((entry) => (!filter || historyText(entry).includes(filter)) && (!here.checked || here.disabled || sameFolder(entry.cwd, working)));
  const parts = [];
  if ((provider.accounts?.length ?? 0) > 1 && account) parts.push(`${account.label} account`);
  if (snapshot && !snapshot.error) {
    parts.push(snapshot.total === 0 ? 'no sessions found' : `${snapshot.total} session${snapshot.total === 1 ? '' : 's'}, newest first`);
    if (shown.length !== all.length) parts.push(`${shown.length} shown`);
  }
  $('history-sub').textContent = parts.join(' · ');
  renderHistoryRows(provider, shown);
  let note = '';
  if (!provider.historySource) note = `Agent Guild cannot list ${provider.tool}'s sessions. Enter the id of one to resume it.`;
  else if (historyView.loading && !snapshot) note = `Reading ${provider.tool}'s sessions…`;
  else if (snapshot?.error) note = `Sessions could not be read: ${snapshot.error}`;
  else if (snapshot && all.length === 0) note = `No ${provider.tool} sessions were found${account && account.id !== 'default' ? ` for the ${account.label} account` : ''}.`;
  else if (snapshot && shown.length === 0) note = 'No session matches the filter.';
  $('history-note').textContent = note;
  $('history-note').hidden = !note;
  $('history-filter').disabled = !provider.historySource;
  here.parentElement.hidden = !provider.historySource;
}

/** Closing to open a session leaves focus with the terminal; otherwise it returns to the opener. */
function closeHistory({ focusOpener = true } = {}) {
  if (!$('history').open) return;
  if (!focusOpener) historyOpener = false;
  $('history').close();
}

function resumeById(event) {
  event.preventDefault();
  const provider = historyProvider();
  const id = $('history-id').value.trim();
  if (provider && id) resumeFromHistory(provider, id, null);
}

// ---- GitHub ---------------------------------------------------------------

const GITHUB_SCOPES = {
  repo: 'Read and write access to your repositories, private ones included, so you can browse repositories and create or edit issues.',
  'write:public_key': 'Add the SSH key Agent Guild creates for this account.',
};
const githubView = { accountId: null, repos: null, reposFor: null, loading: null, error: null, parentError: null, card: null, started: new Map(), announced: new Set() };
let githubLoading = null;

function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

function button(label, onClick, className = 'btn') {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function externalLink(label, href, className = 'console-link') {
  const link = el('a', className, label);
  link.href = webHref(href) ?? '';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.setAttribute('aria-description', 'Opens in a new tab');
  return link;
}

function githubAccount() {
  return state.github?.accounts.find((a) => a.id === githubView.accountId) ?? null;
}

function selectGitHubAccount(id) {
  if (githubView.accountId === id) return;
  githubView.accountId = id;
  githubView.repos = null;
  githubView.reposFor = null;
  githubView.error = null;
  save(GITHUB_ACCOUNT_KEY, id === null ? null : String(id));
}

let githubAgain = false;

function loadGitHub() {
  if (githubLoading) {
    githubAgain = true;
    return githubLoading;
  }
  githubLoading = api('GET', '/github').then(({ github }) => setGitHub(github), (err) => {
    if (err instanceof AuthError) return showAuth(err.message);
    toast(err.message, 8000);
  }).finally(() => {
    githubLoading = null;
    if (githubAgain) {
      githubAgain = false;
      loadGitHub();
    }
  });
  return githubLoading;
}

function setGitHub(github) {
  const before = state.github?.signIn;
  state.github = github;
  const branches = githubPick.data.branches;
  if (branches && !github.accounts.some((a) => a.id === branches.repo.accountId && !a.needsSignIn)) {
    // Replace the generation even while the dock is closed; signing in again must
    // never make an earlier account's pending answer current.
    githubPick.data.branches = { ...branches, value: null, loading: false, nextPage: null,
      error: `Sign in as @${branches.repo.login} in Repositories to see its branches.` };
  }
  const done = github.signIn?.status === 'done' && before?.status === 'pending' ? github.signIn : null;
  if (done) {
    selectGitHubAccount(done.accountId);
    Object.assign(githubView, { repos: null, reposFor: null, error: null });
  }
  if (!githubAccount()) selectGitHubAccount(github.accounts[0]?.id ?? null);
  const account = githubAccount();
  if (done && account) {
    toast(done.again
      ? `You are already signed in as @${account.login}; that sign-in was renewed. To add another account, switch to it on github.com first.`
      : `Signed in to GitHub as @${account.login}.`, done.again ? 10000 : 4000);
  }
  if (!dockShows('github')) return;
  ensureAllRepos();
  renderGitHub();
  ensureRepos();
}

function cloneParent() {
  return $('github-parent').value.trim();
}

function reposKey(account) {
  return account ? `${account.id}\n${cloneParent()}` : null;
}

function ensureRepos() {
  const account = githubAccount();
  if (!account || account.needsSignIn) return;
  const key = reposKey(account);
  if (githubView.reposFor !== key && githubView.loading !== key) loadRepos();
}

async function loadRepos({ refresh = false } = {}) {
  const account = githubAccount();
  if (!account) return;
  const key = reposKey(account);
  const parent = cloneParent();
  githubView.loading = key;
  renderGitHub();
  const ask = (withParent) => {
    const query = new URLSearchParams();
    if (withParent && parent) query.set('parent', parent);
    if (refresh) query.set('refresh', '1');
    return api('GET', `/github/accounts/${account.id}/repos?${query}`);
  };
  let result = null;
  let error = null;
  let parentError = null;
  try {
    try {
      result = (await ask(true)).repos;
    } catch (err) {
      if (err.code !== 'bad_cwd') throw err;
      parentError = err.message;
      result = (await ask(false)).repos;
    }
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    error = err.message;
  }
  if (githubView.loading !== key) return;
  Object.assign(githubView, { loading: null, reposFor: key, error, parentError });
  if (result || !githubView.repos || githubView.repos.accountId !== account.id) githubView.repos = result;
  renderGitHub();
}

async function startGitHubSignIn() {
  try {
    setGitHub((await api('POST', '/github/sign-in')).github);
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    toast(err.message, 8000);
  }
}

async function cancelGitHubSignIn() {
  try {
    setGitHub((await api('DELETE', '/github/sign-in')).github);
  } catch (err) {
    toast(err.message);
  }
}

async function setupGitHubSsh(account) {
  try {
    const result = await api('POST', `/github/accounts/${account.id}/ssh`);
    if (result.account.ssh.status === 'ready') toast(`SSH is ready for @${account.login}.`, 4000);
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    toast(err.message, 8000);
  }
  loadGitHub();
}

async function signOutGitHub(account) {
  const text = `Sign out of @${account.login}? Agent Guild forgets this sign-in. Its SSH key stays in the Agent Guild data folder and on your GitHub account, so existing clones keep working.\n\nTo remove Agent Guild's access entirely, revoke it on GitHub; GitHub then also removes the SSH keys Agent Guild added.`;
  if (!confirm(text)) return;
  try {
    const { github } = await api('DELETE', `/github/accounts/${account.id}`);
    if (githubView.accountId === account.id) selectGitHubAccount(null);
    setGitHub(github);
  } catch (err) {
    toast(err.message);
  }
}

function openGitHub({ focus = true } = {}) {
  $('github-parent').value = load(CLONE_PARENT_KEY) ?? $('cwd').value.trim();
  $('github-filter').value = '';
  githubView.card = null;
  githubPick.followed = null;
  githubPick.origins.clear();
  showDock('github');
  renderGitHub();
  if (githubAccount() && !githubAccount().needsSignIn) loadRepos();
  loadGitHub();
  if (githubPick.repo) {
    loadView('actions');
    if (['issues', 'pulls', 'branches'].includes(githubShownView())) loadView(githubShownView());
  }
  followTerminal();
  if (focus) ($('github-card').querySelector('.btn.primary') ?? $('dock-close')).focus();
}

function closeGitHub({ focusOpener = true } = {}) {
  if (dockShows('github')) closeDock({ focusOpener });
}

function toggleGitHub() {
  if (dockShows('github')) closeDock();
  else openGitHub();
}

function renderGitHub() {
  const github = state.github;
  const account = githubAccount();
  const repos = githubView.repos?.accountId === account?.id ? githubView.repos : null;
  renderGitHubChips(github);
  renderGitHubCard(github, account);
  renderGitHubStatus(github, account);
  renderGitHubRepos(github, account, repos);
  renderGitHubViews();
}

function githubAvatar(account) {
  if (account.avatar?.startsWith('data:image/')) {
    const img = el('img', 'github-avatar');
    img.src = account.avatar;
    img.alt = '';
    return img;
  }
  const mono = el('span', 'github-avatar', account.login.charAt(0).toUpperCase());
  mono.style.setProperty('--c', `hsl(${hueFor(account.login)} 45% 45%)`);
  return mono;
}

function renderGitHubChips(github) {
  const accounts = github?.accounts ?? [];
  const host = $('github-chips');
  const focused = document.activeElement?.closest?.('#github-chips .account-chip')?.dataset.account;
  host.replaceChildren(...accounts.map((account) => {
    const chip = el('button', `account-chip github-chip${account.needsSignIn ? ' unsigned' : ''}`, githubAvatar(account), el('span', null, account.login));
    chip.type = 'button';
    chip.setAttribute('role', 'tab');
    chip.dataset.account = account.id;
    chip.setAttribute('aria-selected', String(account.id === githubView.accountId));
    chip.title = account.needsSignIn ? `@${account.login}: sign in again` : `${account.name ? `${account.name} · ` : ''}@${account.login}${account.ssh.status === 'ready' ? ' · SSH ready' : ' · SSH not set up'}`;
    chip.addEventListener('click', () => {
      selectGitHubAccount(account.id);
      githubView.card = null;
      renderGitHub();
      ensureRepos();
    });
    return chip;
  }));
  if (focused) [...host.children].find((chip) => chip.dataset.account === focused)?.focus({ preventScroll: true });
  const pending = github?.signIn?.status === 'pending';
  $('github-add').hidden = accounts.length === 0 || pending;
}

function minutesLeft(iso) {
  return Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 60000));
}

function scopeList(github) {
  return el('ul', 'github-scopes', ...(github.scopes ?? []).map((scope) => el('li', null, el('code', null, scope), ` ${GITHUB_SCOPES[scope] ?? ''}`)));
}

function signInCard(github) {
  return [
    el('h3', null, 'Sign in to GitHub'),
    el('p', null, 'See your repositories and clone them over SSH, with a key Agent Guild keeps for each account.'),
    el('p', 'github-small', 'GitHub will ask you to allow Agent Guild to:'),
    scopeList(github),
    el('p', 'github-small', 'Your sign-in stays in the Agent Guild data folder on this computer; this page never receives it.'),
    el('div', 'github-actions', button('Sign in with GitHub', startGitHubSignIn, 'btn primary')),
  ];
}

function codeCard(signIn) {
  const code = signIn.userCode;
  const open = externalLink('Open GitHub', signIn.verificationUri, 'btn primary');
  open.addEventListener('click', () => navigator.clipboard?.writeText(code).catch(() => {}));
  open.title = `Copies the code and opens ${signIn.verificationUri}`;
  const codeText = el('span', 'github-code-text', code);
  codeText.setAttribute('aria-label', `Code ${[...code].join(' ')}`);
  return [
    el('h3', null, 'Enter this code on GitHub'),
    el('div', 'github-code', codeText, button('Copy', () => copyText(code, 'the code'))),
    el('div', 'github-actions', open, button('Cancel', cancelGitHubSignIn)),
    el('p', 'github-small github-waiting', `Waiting for you to approve Agent Guild on GitHub. The code expires in ${minutesLeft(signIn.expiresAt)} min.`),
    el('p', 'github-small', 'Adding another account? Switch to it on github.com before you enter the code.'),
  ];
}

function signInResultCard(signIn) {
  const text = signIn.status === 'expired' ? 'The code expired before it was entered on GitHub.'
    : signIn.status === 'denied' ? 'The sign-in was declined on GitHub.'
    : `The sign-in did not finish: ${signIn.error || 'GitHub refused it'}.`;
  return [
    el('h3', null, 'Not signed in'),
    el('p', null, text),
    el('div', 'github-actions', button('Try again', startGitHubSignIn, 'btn primary'), button('Dismiss', cancelGitHubSignIn)),
  ];
}

function signInAgainCard(account) {
  return [
    el('h3', null, `Sign in again as @${account.login}`),
    el('p', null, `GitHub no longer accepts Agent Guild's sign-in for @${account.login}. If github.com is signed in to another account, switch to @${account.login} there first.`),
    el('div', 'github-actions', button('Sign in again', startGitHubSignIn, 'btn primary'), button('Sign out', () => signOutGitHub(account))),
  ];
}

function sshCard(github, account) {
  const ssh = account.ssh;
  const missing = !github.tools.ssh || !github.tools.sshKeygen;
  const step = (done, text) => el('li', done ? 'done' : null, text);
  const parts = [
    el('h3', null, `Set up SSH for @${account.login}`),
    el('p', null, 'Agent Guild clones over SSH with a key of its own for each account, so your other SSH keys and settings are never used or changed.'),
    el('ol', 'github-steps',
      step(Boolean(ssh.key), 'Create a key for this account in the Agent Guild data folder'),
      step(false, 'Add its public key to your GitHub account'),
      step(false, `Check that GitHub signs in as @${account.login}`)),
  ];
  if (missing) {
    parts.push(el('p', 'github-error', 'OpenSSH (ssh and ssh-keygen) was not found. On Windows, add the "OpenSSH Client" optional feature in Settings, or install Git for Windows; on Linux, install the openssh-client package. Then check again.'));
  } else if (ssh.error) {
    parts.push(el('p', 'github-error', ssh.error.message));
  }
  const setup = button(ssh.settingUp ? 'Setting up…' : ssh.error || ssh.key ? 'Check again' : 'Set up SSH', () => setupGitHubSsh(account), 'btn primary');
  setup.disabled = ssh.settingUp || missing;
  const actions = el('div', 'github-actions', setup);
  if (ssh.error?.manual && ssh.publicKey) {
    actions.append(button('Copy public key', () => copyText(ssh.publicKey, 'the public key')), externalLink('Open GitHub SSH settings', github.newKeyUrl, 'btn'));
  }
  parts.push(actions);
  const approve = externalLink('request access', github.appUrl);
  parts.push(el('p', 'github-small', 'Organizations that restrict third-party apps accept this key only once an owner approves Agent Guild: ', approve, '.'));
  return parts;
}

function renderGitHubCard(github, account) {
  const card = $('github-card');
  let kind = null;
  let build = null;
  const signIn = github?.signIn;
  if (!github) kind = null;
  else if (signIn?.status === 'pending') [kind, build] = [`code:${signIn.userCode}:${minutesLeft(signIn.expiresAt)}`, () => codeCard(signIn)];
  else if (signIn && signIn.status !== 'done') [kind, build] = [`result:${signIn.status}`, () => signInResultCard(signIn)];
  else if (!account) [kind, build] = ['welcome', () => signInCard(github)];
  else if (account.needsSignIn) [kind, build] = [`again:${account.id}`, () => signInAgainCard(account)];
  else if (account.ssh.status !== 'ready') {
    const { settingUp, key, error } = account.ssh;
    [kind, build] = [`ssh:${account.id}:${settingUp}:${Boolean(key)}:${error?.message}:${github.tools.ssh && github.tools.sshKeygen}`, () => sshCard(github, account)];
  }
  card.hidden = !kind;
  if (kind === githubView.card) return;
  const hadFocus = card.contains(document.activeElement);
  githubView.card = kind;
  card.replaceChildren(...(build ? build() : []));
  if (hadFocus) (card.querySelector('.btn.primary:not(:disabled)') ?? card.querySelector('button, a'))?.focus({ preventScroll: true });
}

function renderGitHubStatus(github, account) {
  const strip = $('github-status');
  strip.hidden = !account || account.needsSignIn;
  if (strip.hidden) return strip.replaceChildren();
  const ssh = account.ssh;
  const text = ssh.status === 'ready'
    ? el('span', 'github-ready', 'SSH ready', el('span', 'github-small', ` · checked ${relativeTime(ssh.verifiedAt)}`))
    : el('span', 'github-small', 'SSH not set up yet');
  const actions = el('span', 'github-status-actions');
  if (ssh.status === 'ready') {
    const check = button(ssh.settingUp ? 'Checking…' : 'Check SSH', () => setupGitHubSsh(account));
    check.disabled = ssh.settingUp;
    check.title = `Check that GitHub still signs in as @${account.login} with Agent Guild's key`;
    actions.append(check);
  }
  actions.append(button('Sign out', () => signOutGitHub(account)));
  const focused = strip.contains(document.activeElement) ? document.activeElement.textContent : null;
  strip.replaceChildren(text, actions);
  if (focused) [...strip.querySelectorAll('button')].find((b) => b.textContent === focused)?.focus({ preventScroll: true });
}

function runningClone(target) {
  return [...state.sessions.values()].find((s) => s.task === 'clone' && s.status === 'running' && s.clone?.path === target) ?? null;
}

function cloneBlocker(github, account) {
  if (!github.tools.git) return 'Git was not found. Install it from git-scm.com, then reopen this dialog.';
  if (account.ssh.status !== 'ready') return `Set up SSH for @${account.login} first.`;
  if (githubView.parentError) return githubView.parentError;
  if (!cloneParent()) return 'Choose the folder to clone into below.';
  return null;
}

function buildRepoRow(fullName) {
  const node = $('github-repo-template').content.firstElementChild.cloneNode(true);
  node.dataset.repo = fullName;
  node.querySelector('.github-action').addEventListener('click', (event) => {
    const repo = githubView.repos?.repos.find((r) => r.fullName === fullName);
    if (repo) repoAction(repo, event.currentTarget);
  });
  return node;
}

function repoAction(repo, control) {
  const running = runningClone(repo.target);
  if (running) {
    openPanel(running.id);
  } else if (repo.local === 'cloned') {
    useFolder(repo.target);
  } else {
    cloneRepo(repo, control);
  }
}

function updateRepoRow(node, repo, blocker) {
  const name = node.querySelector('.repo-name');
  name.replaceChildren(el('span', 'repo-owner', `${repo.owner}/`), repo.name);
  name.title = repo.url;
  const title = node.querySelector('.history-title');
  title.replaceChildren(name,
    ...(repo.private ? [badge('', 'Private', 'Only people with access can see it')] : []),
    ...(repo.fork ? [badge('', 'Fork', 'A fork of another repository')] : []),
    ...(repo.archived ? [badge('', 'Archived', 'Read-only on GitHub')] : []));
  const running = runningClone(repo.target);
  const conflict = repo.local === 'conflict';
  const meta = node.querySelector('.history-meta');
  meta.textContent = conflict
    ? `${repo.target} already exists and is not a clone of ${repo.fullName}`
    : [running && 'Cloning…', repo.local === 'cloned' && `Cloned in ${repo.target}`, repo.description, repo.language, repo.pushedAt && `pushed ${relativeTime(repo.pushedAt)}`].filter(Boolean).join(' · ');
  meta.title = [repo.description, repo.target].filter(Boolean).join('\n');
  node.classList.toggle('conflict', conflict);
  node.classList.toggle('running', Boolean(running) || repo.local === 'cloned');
  const action = node.querySelector('.github-action');
  action.hidden = conflict && !running;
  action.className = `btn github-action${running ? '' : ' primary'}`;
  action.textContent = running ? 'Show' : repo.local === 'cloned' ? 'Use folder' : 'Clone';
  action.disabled = !running && repo.local !== 'cloned' && Boolean(blocker);
  action.title = running ? `Show the session cloning ${repo.fullName}`
    : repo.local === 'cloned' ? `Make ${repo.target} the working folder, so new sessions start there`
    : blocker || `Clone ${repo.fullName} into ${repo.target} over SSH`;
  action.setAttribute('aria-label', `${action.textContent} ${repo.fullName}`);
}

function renderGitHubRepos(github, account, repos) {
  const ready = Boolean(github && account && !account.needsSignIn);
  $('github-tools').hidden = !ready;
  const list = $('github-list');
  const filter = $('github-filter').value.trim().toLowerCase();
  const shown = ready && repos ? repos.repos.filter((repo) => !filter || `${repo.fullName}\n${repo.description ?? ''}`.toLowerCase().includes(filter)) : [];
  const blocker = ready ? cloneBlocker(github, account) : null;
  const rows = new Map([...list.children].map((node) => [node.dataset.repo, node]));
  const wanted = new Set(shown.map((repo) => repo.fullName));
  for (const [id, node] of rows) if (!wanted.has(id)) node.remove();
  shown.forEach((repo, index) => {
    const node = rows.get(repo.fullName) ?? buildRepoRow(repo.fullName);
    updateRepoRow(node, repo, blocker);
    if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
  });
  const note = $('github-note');
  const lines = [];
  if (ready) {
    if (githubView.loading && !repos) lines.push('Loading repositories…');
    else if (githubView.error) lines.push(`Repositories could not be loaded: ${githubView.error}`);
    else if (repos && repos.repos.length === 0) lines.push(`@${account.login} has no repositories yet.`);
    else if (repos && shown.length === 0) lines.push('No repository matches the filter.');
    if (githubView.parentError) lines.push(githubView.parentError);
    if (repos?.truncated) lines.push(`Showing the ${repos.repos.length} most recently pushed repositories.`);
    if (repos) lines.push(['Missing an organization\'s repositories? Its owners may need to approve Agent Guild: ', externalLink('request access', github.appUrl), '.']);
  }
  note.replaceChildren(...lines.map((line) => el('span', null, ...[line].flat())));
  note.hidden = lines.length === 0;
  $('github-refresh').disabled = Boolean(githubView.loading);
  if (!ready) showCreate(false);
  renderCreate();
}

async function startClone(account, fullName) {
  const parent = cloneParent();
  const { session } = await api('POST', '/github/clone', { account: account.id, repo: fullName, parent });
  githubView.started.set(session.id, parent);
  upsertSession(session);
  openPanel(session.id);
}

async function cloneRepo(repo, control) {
  const account = githubAccount();
  if (!account) return;
  control.disabled = true;
  try {
    await startClone(account, repo.fullName);
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    toast(err.message, 8000);
    if (err.code === 'clone_exists' || err.code === 'folder_conflict') loadRepos();
  } finally {
    control.disabled = false;
  }
}

function showCreate(open) {
  const form = $('github-create');
  form.hidden = !open;
  $('github-new').setAttribute('aria-expanded', String(open));
  if (!open) return;
  $('github-create-name').value = '';
  $('github-create-description').value = '';
  $('github-create-error').hidden = true;
  renderCreate();
  $('github-create-name').focus();
}

function renderCreate() {
  const form = $('github-create');
  const account = githubAccount();
  if (form.hidden || !account) return;
  const repos = githubView.repos?.accountId === account.id ? githubView.repos : null;
  const owners = repos?.owners ?? [account.login];
  const select = $('github-create-owner');
  const chosen = select.value;
  if ([...select.options].map((o) => o.value).join('\n') !== owners.join('\n')) {
    select.replaceChildren(...owners.map((owner) => {
      const option = el('option', null, owner === account.login ? `${owner} (you)` : owner);
      option.value = owner;
      return option;
    }));
    select.value = owners.includes(chosen) ? chosen : owners[0];
  }
  const blocker = cloneBlocker(state.github, account);
  const clone = $('github-create-clone');
  clone.disabled = Boolean(blocker);
  if (blocker) clone.checked = false;
  const name = $('github-create-name').value.trim();
  $('github-create-clone-label').textContent = blocker ? 'Clone it' : `Clone it into ${cloneParent()}${name ? `/${name}` : ''}`;
  clone.parentElement.title = blocker ?? '';
}

async function createRepo(event) {
  event.preventDefault();
  const account = githubAccount();
  if (!account) return;
  const submit = $('github-create-submit');
  const error = $('github-create-error');
  const owner = $('github-create-owner').value;
  const name = $('github-create-name').value.trim();
  const clone = $('github-create-clone').checked && !$('github-create-clone').disabled;
  submit.disabled = true;
  error.hidden = true;
  try {
    const { repo } = await api('POST', `/github/accounts/${account.id}/repos`, {
      owner,
      name,
      description: $('github-create-description').value.trim() || null,
      private: $('github-create-private').checked,
      readme: $('github-create-readme').checked,
    });
    showCreate(false);
    githubView.reposFor = null;
    if (clone) {
      toast(`Created ${repo.fullName} on GitHub.`, 4000);
      await startClone(account, repo.fullName);
    } else {
      toast(`Created ${repo.fullName} on GitHub.`, 6000);
      await loadRepos();
    }
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    if ($('github-create').hidden) {
      toast(err.message, 8000);
      loadRepos();
    } else {
      error.textContent = err.message;
      error.hidden = false;
    }
  } finally {
    submit.disabled = false;
  }
}

function clonedPath(s) {
  return s.task === 'clone' && s.status === 'exited' && s.exitCode === 0 && s.clone?.path ? s.clone.path : null;
}

function noticeClone(s) {
  if (s.task !== 'clone' || s.status !== 'exited' || githubView.announced.has(s.id)) return;
  githubView.announced.add(s.id);
  githubView.reposFor = null;
  githubPick.origins.clear();
  if (dockShows('github')) loadRepos();
  if (!githubView.started.has(s.id)) return;
  if (clonedPath(s)) {
    rememberRecent('clone', githubView.started.get(s.id));
    toast(`Cloned ${s.clone.repo} into ${s.clone.path}.`, 12000, { label: 'Use folder', run: () => useFolder(s.clone.path) });
  } else toast(`Cloning ${s.clone?.repo ?? 'the repository'} did not finish. Its session shows why.`, 8000);
}

function useFolder(dir) {
  $('cwd').value = dir;
  save(CWD_KEY, dir);
  if (dockShows('github')) renderGitHub();
  toast(`New sessions start in ${dir}.`, 4000);
}

// ---- GitHub repository views ------------------------------------------------

const GITHUB_VIEWS = ['repos', 'issues', 'actions', 'pulls', 'branches'];
const RUNS_POLL_MS = 6000;
const RUNS_IDLE_POLL_MS = 30000;
const BODY_LIMIT = 48000;
const GITHUB_REQUEST_LIMIT = 64 * 1024;
const PICKER_LIMIT = 200;
/**
 * `list`: every account's repositories from /github/repos; `repo`: the picked one. `data[view]` is
 * `{ stamp, value, error, loading }` for the picked repository. `followed`: the session whose folder last picked the repository.
 */
const githubPick = {
  list: null, listFor: null, loadingFor: null, error: null,
  repo: null, query: '', active: 0, open: false, recent: [],
  view: 'repos', issueState: 'open', editing: null, data: {}, followed: null, origins: new Map(),
};
let runsTimer = 0;
let reposRequest = null;

function usableGitHubAccounts() {
  return (state.github?.accounts ?? []).filter((a) => !a.needsSignIn);
}

function githubAccountsStamp() {
  return usableGitHubAccounts().map((a) => a.id).join(',');
}

/** The view on screen: Repositories while no account can be used or a sign-in needs the card. */
function githubShownView() {
  const signIn = state.github?.signIn;
  if (!usableGitHubAccounts().length || (signIn && signIn.status !== 'done')) return 'repos';
  return githubPick.view;
}

function repoPath(repo) {
  return `/github/accounts/${repo.accountId}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

function issueAccountError(repo) {
  const account = state.github?.accounts.find((a) => a.id === repo.accountId);
  return account && !account.needsSignIn ? null
    : `Sign in as @${account?.login ?? repo.login} in Repositories to change issues in ${repo.fullName}.`;
}

function ensureAllRepos() {
  const stamp = githubAccountsStamp();
  if (!stamp) {
    reposRequest = null;
    Object.assign(githubPick, { list: null, listFor: null, loadingFor: null });
    return;
  }
  if (githubPick.listFor !== stamp && githubPick.loadingFor !== stamp) loadAllRepos();
}

async function loadAllRepos({ refresh = false } = {}) {
  const stamp = githubAccountsStamp();
  const request = reposRequest = {};
  githubPick.loadingFor = stamp;
  renderGitHubViews();
  let list = null;
  let error = null;
  try {
    list = await api('GET', `/github/repos${refresh ? '?refresh=1' : ''}`);
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    error = err.message;
  }
  if (reposRequest !== request || githubAccountsStamp() !== stamp) return;
  Object.assign(githubPick, { loadingFor: null, error, listFor: stamp });
  if (list) githubPick.list = list;
  restorePick();
  renderGitHubViews();
  followTerminal();
}

/** Keeps the picked repository in step with the list, or picks the one from the last visit. */
function restorePick() {
  const repos = githubPick.list?.repos ?? [];
  const wanted = githubPick.repo ? repoKey(githubPick.repo) : load(GITHUB_REPO_KEY);
  const found = repos.find((repo) => repoKey(repo) === wanted) ?? null;
  if (found) pickRepo(found);
  // A failed or expired account must not discard its draft or switch its identity.
  else if (githubPick.repo && githubPick.list && !githubPick.editing && !issueAccountError(githubPick.repo)
    && !githubPick.list.errors?.some((error) => error.accountId === githubPick.repo.accountId)) {
    Object.assign(githubPick, { repo: null, data: {} });
  }
}

function pickRepo(repo, { chosen = false } = {}) {
  const same = githubPick.repo && repoKey(githubPick.repo) === repoKey(repo);
  githubPick.repo = repo;
  save(GITHUB_REPO_KEY, repoKey(repo));
  if (chosen) {
    githubPick.recent = remember(githubPick.recent, repo);
    save(GITHUB_RECENT_KEY, JSON.stringify(githubPick.recent));
  }
  if (!same) {
    Object.assign(githubPick, { data: {}, editing: null });
    $('github-branches-filter').value = '';
    $('github-branches').scrollTop = 0;
  }
  if ((!same || chosen) && githubView.accountId !== repo.accountId && state.github?.accounts.some((a) => a.id === repo.accountId)) {
    selectGitHubAccount(repo.accountId);
    githubView.card = null;
    if (dockShows('github')) {
      renderGitHub();
      ensureRepos();
    }
  }
  if (same) return renderGitHubViews();
  renderGitHubViews();
  if (!dockShows('github')) return;
  loadView('actions');
  if (['issues', 'pulls', 'branches'].includes(githubShownView())) loadView(githubShownView());
}

/** Picks the repository whose clone holds the focused terminal's folder, once for each terminal focused. */
async function followTerminal() {
  const s = state.sessions.get(state.activeId);
  if (!s?.cwd || !dockShows('github') || !githubPick.list || githubPick.followed === s.id) return;
  githubPick.followed = s.id;
  let origin = githubPick.origins.get(s.cwd);
  if (origin === undefined) {
    try {
      origin = (await api('GET', `/github/origin?cwd=${encodeURIComponent(s.cwd)}`)).repo;
    } catch (err) {
      if (err instanceof AuthError) return showAuth(err.message);
      origin = null;
    }
    githubPick.origins.set(s.cwd, origin);
  }
  const repo = repoForOrigin(githubPick.list?.repos ?? [], origin, githubPick.recent);
  if (repo && state.activeId === s.id && githubPick.followed === s.id) pickRepo(repo);
}

async function loadView(view) {
  if (view === 'branches') return loadBranches();
  const repo = githubPick.repo;
  if (!repo || view === 'repos') return;
  const query = view === 'issues' ? `?state=${githubPick.issueState}` : '';
  const key = repoKey(repo);
  const stamp = `${key}${query}`;
  const before = githubPick.data[view];
  const request = { key, stamp, value: before?.stamp === stamp ? before.value : null, error: null, loading: true };
  githubPick.data[view] = request;
  renderGitHubViews();
  let value = null;
  let error = null;
  try {
    value = await api('GET', `${repoPath(repo)}/${view}${query}`);
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    error = err.message;
  }
  const slot = githubPick.data[view];
  if (slot !== request) return;
  githubPick.data[view] = { key, stamp, value: value ?? slot.value, error, loading: false };
  renderGitHubViews();
  if (view === 'actions') scheduleRuns();
}

// Each object is a listing generation, scoped to the selected account/repository.
// A retry continues that generation; Refresh replaces it and starts at page one.
function branchesCurrent(request) {
  return githubPick.data.branches === request && githubPick.repo && repoKey(githubPick.repo) === request.key
    && state.github?.accounts.some((a) => a.id === request.repo.accountId && !a.needsSignIn);
}

function branchesVisible() {
  return dockShows('github') && githubShownView() === 'branches' && document.visibilityState === 'visible';
}

async function loadBranches({ resume = false } = {}) {
  const repo = githubPick.repo;
  if (!repo || !state.github?.accounts.some((a) => a.id === repo.accountId && !a.needsSignIn)) return;
  const before = viewData('branches');
  if (resume && (!before || before.loading || before.nextPage === null)) return;
  const request = resume ? before : {
    key: repoKey(repo), repo, value: before?.value ?? null, loading: false, error: null,
    nextPage: 1, received: false, rows: new Map(), defaultBranch: null, metadataError: null,
  };
  githubPick.data.branches = request;
  request.loading = true;
  request.error = null;
  renderGitHubViews();
  try {
    while (request.nextPage !== null && branchesVisible() && branchesCurrent(request)) {
      const page = request.nextPage;
      const result = await api('GET', `${repoPath(repo)}/branches?page=${page}`);
      if (!branchesCurrent(request)) return;
      // A malformed response must not masquerade as a complete, empty list.
      if (!Array.isArray(result.branches) || (result.nextPage !== null
        && (!Number.isSafeInteger(result.nextPage) || result.nextPage <= page))) {
        throw new Error('Could not read the next page of branches. Try again.');
      }
      if (page === 1) {
        request.defaultBranch = result.defaultBranch;
        request.metadataError = result.metadataError;
      }
      for (const branch of result.branches) request.rows.set(branch.name, branch);
      request.nextPage = result.nextPage;
      request.received = true;
      request.value = { ...result, branches: [...request.rows.values()],
        defaultBranch: request.defaultBranch, metadataError: request.metadataError };
      renderGitHubViews();
    }
  } catch (err) {
    if (!branchesCurrent(request)) return;
    if (err instanceof AuthError) { showAuth(err.message); return; }
    request.error = err.message;
  } finally {
    if (branchesCurrent(request)) {
      request.loading = false;
      renderGitHubViews();
    }
  }
}

/** Keep the first visible branch at the same pixel offset when earlier rows arrive. */
function branchAnchor(panel, list) {
  const { top, bottom } = panel.getBoundingClientRect();
  const row = [...list.children].find((node) => {
    const rect = node.getBoundingClientRect();
    return rect.bottom > top && rect.top < bottom;
  });
  return row ? { name: row.dataset.branch, offset: row.getBoundingClientRect().top - top } : null;
}

async function copyBranch(name, control) {
  const request = viewData('branches');
  control.disabled = true;
  let message;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(name);
    message = `Copied branch name: ${name}`;
  } catch {
    message = 'Could not copy. Select the branch name and copy it using your browser.';
  } finally {
    control.disabled = false;
  }
  if (request === viewData('branches') && branchesVisible() && control.isConnected) toast(message);
}

function renderBranches({ preserveAnchor = true } = {}) {
  const panel = $('github-branches');
  const list = $('github-branches-list');
  const repo = githubPick.repo;
  const key = repo ? repoKey(repo) : '';
  const same = panel.dataset.repo === key;
  const anchor = same && preserveAnchor ? branchAnchor(panel, list) : null;
  const focused = list.contains(document.activeElement) ? document.activeElement : null;
  const oldScroll = same ? panel.scrollTop : 0;
  if (!same) { list.replaceChildren(); panel.dataset.repo = key; }
  $('github-branches-pick').hidden = Boolean(repo);
  $('github-branches-content').hidden = !repo;
  if (!repo) return;
  const slot = viewData('branches');
  const value = slot?.value;
  const query = $('github-branches-filter').value.trim().toLocaleLowerCase();
  $('github-branches-clear').disabled = !$('github-branches-filter').value;
  const refresh = $('github-branches-refresh');
  const usable = state.github?.accounts.some((a) => a.id === repo.accountId && !a.needsSignIn);
  refresh.disabled = Boolean(slot?.loading) || !usable;
  refresh.textContent = slot?.loading ? (value ? 'Refreshing…' : 'Loading…') : 'Refresh';
  const out = $('github-branches-out');
  out.href = value?.url ?? `https://github.com/${repo.fullName}/branches`;
  out.title = `Open ${repo.fullName} branches on GitHub`;
  const branches = (value?.branches ?? []).filter((b) => b.name.toLocaleLowerCase().includes(query)).sort((a, b) =>
    Number(b.name === value.defaultBranch) - Number(a.name === value.defaultBranch)
      || a.name.localeCompare(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const complete = Boolean(value && value.nextPage === null && (!slot.error || slot.received));
  const count = value?.branches.length ?? 0;
  let status = !value ? (slot?.error ? 'Branches could not be loaded.' : 'Loading branches…')
    : query ? `${branches.length} of ${count} loaded branches match.`
      : `${count} ${count === 1 ? 'branch' : 'branches'}${complete ? '' : ' loaded'}.`;
  if (value && !slot.received) status += slot.loading ? ' Refreshing…' : ' Showing previous results.';
  else if (!complete && value) status += slot.loading ? ' Loading more…' : ' Listing incomplete.';
  if (complete && !branches.length) status = query ? `No branches match “${$('github-branches-filter').value.trim()}”.` : 'No remote branches yet.';
  const statusNode = $('github-branches-status');
  if (statusNode.textContent !== status) statusNode.textContent = status;
  const failure = $('github-branches-error');
  failure.hidden = !slot?.error;
  failure.querySelector('span').textContent = slot?.error ?? '';
  $('github-branches-retry').disabled = Boolean(slot?.loading) || slot?.nextPage === null || !usable;
  const metadata = $('github-branches-metadata');
  metadata.hidden = !value?.metadataError;
  metadata.textContent = value?.metadataError ? 'Branches loaded, but the default branch could not be identified. Refresh to try again.' : '';
  const existing = new Map([...list.children].map((row) => [row.dataset.branch, row]));
  const wanted = new Set(branches.map((branch) => branch.name));
  let cursor = list.firstElementChild;
  for (const branch of branches) {
    let row = existing.get(branch.name);
    if (!row) {
      const copy = button('Copy name', () => copyBranch(branch.name, copy));
      copy.setAttribute('aria-label', `Copy branch name ${branch.name}`);
      row = recordRow(`branch:${branch.name}`, branch.name, '', copy, branch.url);
      row.classList.add('github-branch');
      row.dataset.branch = branch.name;
      row.setAttribute('role', 'listitem');
      row.querySelector('.history-title').append(el('span', 'github-branch-badges'));
    }
    const badges = row.querySelector('.github-branch-badges');
    const badgeState = `${branch.name === value.defaultBranch}:${branch.protected}`;
    if (badges.dataset.state !== badgeState) {
      badges.dataset.state = badgeState;
      badges.replaceChildren(...[
        branch.name === value.defaultBranch ? badge('', 'Default', 'Default branch') : null,
        branch.protected ? badge('', 'Protected', 'Protected by branch protection or rulesets') : null,
      ].filter(Boolean));
    }
    row.querySelector('.history-meta').textContent = branch.sha ? branch.sha.slice(0, 7) : '';
    row.querySelector('.history-meta').title = branch.sha ?? '';
    if (row === cursor) cursor = cursor.nextElementSibling;
    else list.insertBefore(row, cursor);
  }
  for (const row of [...list.children]) if (!wanted.has(row.dataset.branch)) row.remove();
  if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
  panel.scrollTop = oldScroll;
  if (anchor) {
    const row = [...list.children].find((node) => node.dataset.branch === anchor.name);
    if (row) panel.scrollTop += row.getBoundingClientRect().top - panel.getBoundingClientRect().top - anchor.offset;
  }
}

function viewData(view) {
  const slot = githubPick.data[view];
  const repo = githubPick.repo;
  return slot && repo && slot.key === repoKey(repo) ? slot : null;
}

/** Runs are polled only while their tab is on screen in a visible page, faster while one is going. */
function scheduleRuns() {
  clearTimeout(runsTimer);
  if (!dockShows('github') || githubShownView() !== 'actions' || !githubPick.repo || document.visibilityState !== 'visible') return;
  runsTimer = setTimeout(() => loadView('actions'), viewData('actions')?.value?.running ? RUNS_POLL_MS : RUNS_IDLE_POLL_MS);
}

function switchGitHubView(view, { focus = false } = {}) {
  if (!GITHUB_VIEWS.includes(view)) return;
  githubPick.view = view;
  save(GITHUB_VIEW_KEY, view);
  renderGitHubViews();
  if (focus) $(`github-view-${view}`).focus();
  if (view === 'repos') ensureRepos();
  else loadView(view);
  scheduleRuns();
}

function moveGitHubView(e) {
  const at = GITHUB_VIEWS.indexOf(e.target.dataset?.view);
  if (at === -1) return;
  const next = e.key === 'ArrowRight' ? (at + 1) % GITHUB_VIEWS.length
    : e.key === 'ArrowLeft' ? (at - 1 + GITHUB_VIEWS.length) % GITHUB_VIEWS.length
    : e.key === 'Home' ? 0 : e.key === 'End' ? GITHUB_VIEWS.length - 1 : -1;
  if (next === -1) return;
  e.preventDefault();
  switchGitHubView(GITHUB_VIEWS[next], { focus: true });
}

// The picker: a combobox over every account's repositories.

function pickerOptions() {
  const accounts = new Set(usableGitHubAccounts().map((a) => a.id));
  const repos = (githubPick.list?.repos ?? []).filter((repo) => accounts.has(repo.accountId));
  const ranked = rankRepos(repos, githubPick.query);
  const options = githubPick.query.trim() ? ranked : recentFirst(ranked, githubPick.recent);
  return { options: options.slice(0, PICKER_LIMIT), truncated: options.length > PICKER_LIMIT };
}

function setPickerOpen(open) {
  githubPick.open = open;
  const input = $('github-repo');
  input.setAttribute('aria-expanded', String(open));
  $('github-repo-list').hidden = !open;
  if (!open) input.removeAttribute('aria-activedescendant');
  else renderPickerList();
}

function highlighted(text, query) {
  return highlightParts(text, query).map((part) => (part.match ? el('mark', null, part.text) : part.text));
}

function renderPickerList() {
  if (!githubPick.open) return;
  const list = $('github-repo-list');
  const input = $('github-repo');
  const { options, truncated } = pickerOptions();
  githubPick.active = Math.min(githubPick.active, Math.max(0, options.length - 1));
  const accounts = new Map((state.github?.accounts ?? []).map((a) => [a.id, a]));
  const several = accounts.size > 1;
  const items = options.map((repo, index) => {
    const account = accounts.get(repo.accountId);
    const meta = [several && `@${repo.login}`, repo.description, repo.language, repo.pushedAt && `pushed ${relativeTime(repo.pushedAt)}`].filter(Boolean).join(' · ');
    const item = el('li', 'github-option',
      account ? githubAvatar(account) : null,
      el('span', 'github-option-text', el('span', 'github-option-name', ...highlighted(repo.fullName, githubPick.query)), meta && el('span', 'github-option-meta', meta)),
      repo.private ? badge('', 'Private', 'Only people with access can see it') : null,
      repo.archived ? badge('', 'Archived', 'Read-only on GitHub') : null);
    item.id = `github-repo-option-${index}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(index === githubPick.active));
    item.addEventListener('pointerdown', (e) => e.preventDefault());
    item.addEventListener('click', () => choosePickerRepo(repo));
    return item;
  });
  if (!items.length) {
    const empty = el('li', 'github-option-empty', githubPick.list ? 'No repository matches.' : 'Loading repositories…');
    empty.setAttribute('role', 'presentation');
    items.push(empty);
  }
  if (truncated) {
    const hint = el('li', 'github-option-empty', `Showing ${PICKER_LIMIT} matches; refine your search.`);
    hint.setAttribute('role', 'presentation');
    items.push(hint);
  }
  list.replaceChildren(...items);
  const active = items[githubPick.active];
  if (active?.id) {
    input.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  } else input.removeAttribute('aria-activedescendant');
}

function choosePickerRepo(repo) {
  githubPick.query = '';
  githubPick.followed = state.activeId;
  setPickerOpen(false);
  pickRepo(repo, { chosen: true });
  $('github-repo').value = repo.fullName;
}

function pickerKey(e) {
  const { options } = pickerOptions();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!githubPick.open) {
      githubPick.active = 0;
      return setPickerOpen(true);
    }
    if (!options.length) return;
    githubPick.active = (githubPick.active + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
    renderPickerList();
  } else if (e.key === 'Enter' && githubPick.open) {
    e.preventDefault();
    if (options[githubPick.active]) choosePickerRepo(options[githubPick.active]);
  } else if (e.key === 'Escape' && (githubPick.open || githubPick.query)) {
    e.preventDefault();
    githubPick.query = '';
    setPickerOpen(false);
    e.target.value = githubPick.repo?.fullName ?? '';
    e.target.select();
  }
}

// Rendering the views.

function renderPickerNote() {
  const note = $('github-picker-note');
  const lines = [];
  if (githubPick.loadingFor && !githubPick.list) lines.push('Loading repositories…');
  if (githubPick.error) lines.push(`Repositories could not be loaded: ${githubPick.error}`);
  for (const failed of githubPick.list?.errors ?? []) lines.push(`@${failed.login}: ${failed.message}`);
  if (githubPick.list?.truncated) lines.push('An account has more repositories than the 1,000 most recently pushed shown here.');
  if (githubPick.list && !githubPick.repo && !lines.length) lines.push(githubPick.list.repos.length ? 'Pick a repository to see its issues, Actions runs and pull requests.' : 'Your accounts have no repositories yet.');
  note.replaceChildren(...lines.map((line) => el('span', null, line)));
  note.hidden = !lines.length;
  note.classList.toggle('warn', Boolean(githubPick.error || githubPick.list?.errors?.length));
}

function renderGitHubViews() {
  const usable = usableGitHubAccounts().length > 0;
  const shown = githubShownView();
  const account = githubAccount();
  const repo = githubPick.repo;
  const repos = githubView.repos?.accountId === account?.id ? githubView.repos : null;
  $('github-accounts').hidden = shown !== 'repos' || !state.github?.accounts.length;
  $('github-sub').textContent = shown !== 'repos'
    ? (repo ? `${repo.fullName} · Acting as @${state.github?.accounts.find((a) => a.id === repo.accountId)?.login ?? repo.login}` : 'Repositories from all your accounts')
    : !state.github ? 'Loading…' : !account ? 'Sign in to browse your repositories'
      : [`@${account.login}`, account.name, repos && `${repos.repos.length} ${repos.repos.length === 1 ? 'repository' : 'repositories'}`].filter(Boolean).join(' · ');
  $('github-picker').hidden = !usable;
  $('github-views').hidden = !usable;
  const input = $('github-repo');
  if (document.activeElement !== input) input.value = githubPick.repo?.fullName ?? '';
  $('github-repo-reload').disabled = Boolean(githubPick.loadingFor);
  if (usable) renderPickerNote();
  else $('github-picker-note').hidden = true;
  for (const view of GITHUB_VIEWS) {
    const tab = $(`github-view-${view}`);
    tab.setAttribute('aria-selected', String(view === shown));
    tab.tabIndex = view === shown ? 0 : -1;
  }
  $('github-repos').hidden = shown !== 'repos';
  $('github-issues').hidden = shown !== 'issues';
  $('github-runs').hidden = shown !== 'actions';
  $('github-pulls').hidden = shown !== 'pulls';
  $('github-branches').hidden = shown !== 'branches';
  const ready = Boolean(state.github && githubAccount() && !githubAccount().needsSignIn);
  $('github-clone-into').hidden = !ready || shown !== 'repos';
  const running = Boolean(viewData('actions')?.value?.running);
  $('github-running').hidden = !running;
  $('github-view-actions').setAttribute('aria-label', running ? 'Actions, a workflow is running' : 'Actions');
  renderPickerList();
  if (shown === 'issues') renderIssues();
  else if (shown === 'actions') renderRuns();
  else if (shown === 'pulls') renderPulls();
  else if (shown === 'branches') renderBranches();
}

/** Rebuilds a panel and puts the focus back on the control with the same `data-key`. */
function redraw(panel, children) {
  const key = panel.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  panel.replaceChildren(...children.filter(Boolean));
  if (key) panel.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

function keyed(node, key) {
  node.dataset.key = key;
  return node;
}

function viewTools(view, ...controls) {
  const slot = viewData(view);
  const refresh = keyed(button(slot?.loading ? 'Refreshing…' : 'Refresh', () => loadView(view)), 'refresh');
  refresh.disabled = Boolean(slot?.loading);
  const href = slot?.value?.url ?? `https://github.com/${githubPick.repo.fullName}/${view === 'pulls' ? 'pulls' : view}`;
  const open = keyed(externalLink('GitHub', href, 'btn github-out'), 'out');
  open.title = `Open ${githubPick.repo.fullName} on GitHub`;
  return el('div', 'github-view-tools', ...controls, el('span', 'github-spacer'), refresh, open);
}

function viewStatus(view, empty) {
  const slot = viewData(view);
  if (slot?.error) {
    const line = el('p', 'github-error', slot.error);
    line.setAttribute('role', 'alert');
    return line;
  }
  if (!slot?.value) return el('p', 'github-view-note', 'Loading…');
  if (empty) return el('p', 'github-view-note', empty);
  return null;
}

function noRepoNote(what) {
  return el('p', 'github-view-note', githubPick.list ? `Pick a repository above to see its ${what}.` : 'Loading repositories…');
}

function recordRow(key, title, meta, side, href) {
  const head = href ? keyed(externalLink(title, href, 'github-record-title'), `${key}:title`) : title;
  return el('article', 'history-row github-record', el('div', 'history-main', el('div', 'history-title', head), el('div', 'history-meta', meta)), side);
}

function renderIssues() {
  const panel = $('github-issues');
  const repo = githubPick.repo;
  if (!repo) return redraw(panel, [noRepoNote('issues')]);
  if (githubPick.editing !== null) return renderIssueEditor(panel, repo);
  const slot = viewData('issues');
  const blocked = issueAccountError(repo);
  const issues = slot?.value?.issues ?? [];
  const filter = el('div', 'github-segment', ...['open', 'closed'].map((value) => {
    const choice = keyed(button(value === 'open' ? 'Open' : 'Closed', () => {
      if (githubPick.issueState === value) return;
      githubPick.issueState = value;
      loadView('issues');
    }), `state:${value}`);
    choice.setAttribute('aria-pressed', String(githubPick.issueState === value));
    return choice;
  }));
  filter.setAttribute('role', 'group');
  filter.setAttribute('aria-label', 'Show issues');
  const create = keyed(button('New issue', () => editIssue('new'), 'btn primary'), 'new');
  create.disabled = Boolean(blocked);
  const rows = issues.map((issue) => {
    const edit = keyed(button('Edit', () => editIssue(issue.number)), `edit:${issue.number}`);
    edit.disabled = Boolean(blocked);
    edit.setAttribute('aria-label', `Edit #${issue.number} ${issue.title}`);
    const meta = [issue.user, issue.updatedAt && `updated ${relativeTime(issue.updatedAt)}`, issue.comments && `${issue.comments} comment${issue.comments === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
    return recordRow(`issue:${issue.number}`, `#${issue.number} ${issue.title}`, meta, edit, issue.url);
  });
  redraw(panel, [
    viewTools('issues', filter, create),
    blocked && el('p', 'github-error', blocked),
    viewStatus('issues', slot?.value && !issues.length ? `No ${githubPick.issueState} issues.` : null),
    rows.length ? el('div', 'history-list', ...rows) : null,
    slot?.value?.truncated ? el('p', 'github-view-note', 'Showing the 30 most recently updated.') : null,
  ]);
}

function editIssue(target) {
  if (!githubPick.repo || issueAccountError(githubPick.repo)) return;
  githubPick.editing = { target };
  renderGitHubViews();
  $('github-issues').querySelector('input')?.focus();
}

function leaveIssueEditor() {
  if (githubPick.editing?.pending) return;
  githubPick.editing = null;
  renderGitHubViews();
  $('github-issues').querySelector('[data-key="new"]')?.focus();
}

function issuePayloadError(payload) {
  if (payload.title !== undefined) {
    if (!payload.title.trim()) return 'Enter a title for the issue.';
    if (payload.title.trim().length > 256) return 'Keep the title to 256 characters or fewer.';
  }
  if (payload.body?.length > BODY_LIMIT) return 'Keep the description to 48,000 characters or fewer, or edit it on GitHub.';
  if (new TextEncoder().encode(JSON.stringify(payload)).length > GITHUB_REQUEST_LIMIT) {
    return 'This issue is too large to send here. Shorten the description or edit it on GitHub.';
  }
  return null;
}

function renderIssueEditor(panel, repo) {
  const editor = githubPick.editing;
  if (editor.form && panel.contains(editor.form)) return editor.update();
  const issue = editor.target === 'new' ? null : viewData('issues')?.value?.issues.find((i) => i.number === editor.target) ?? null;
  if (editor.target !== 'new' && !issue) {
    githubPick.editing = null;
    return renderIssues();
  }
  const key = repoKey(repo);
  const title = el('input');
  Object.assign(title, { type: 'text', required: true, value: issue?.title ?? '', spellcheck: true, autocomplete: 'off' });
  const body = el('textarea', 'github-issue-body');
  Object.assign(body, { value: issue?.body ?? '', placeholder: 'Describe the issue (Markdown)' });
  // Compare the browser's initialized values: textareas normalize CRLF to LF.
  const initial = { title: title.value, body: body.value };
  const longBody = Boolean(issue && issuePayloadError({ body: initial.body }));
  const context = el('p', 'github-small');
  const accountError = el('p', 'github-error');
  accountError.setAttribute('role', 'alert');
  const error = el('p', 'github-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const form = el('form', 'github-card github-issue-form',
    el('h3', null, issue ? `Edit #${issue.number} in ${repo.fullName}` : `New issue in ${repo.fullName}`),
    context,
    el('div', 'github-fields', el('label', 'wide', el('span', null, 'Title'), title), el('label', 'wide', el('span', null, 'Description'), body)),
    longBody && el('p', 'github-small', 'This description is too long to edit here. Title and state changes keep it intact. ', externalLink('Edit on GitHub', issue.url)),
    accountError, error);
  form.noValidate = true;
  editor.form = form;
  const changes = () => {
    const payload = {};
    if (!issue || title.value !== initial.title) payload.title = title.value;
    if (!issue || (!longBody && body.value !== initial.body)) payload.body = body.value;
    return payload;
  };
  const dirty = () => title.value !== initial.title || (!longBody && body.value !== initial.body);
  const current = () => githubPick.editing === editor && githubPick.repo && repoKey(githubPick.repo) === key;
  const visible = () => dockShows('github') && githubShownView() === 'issues';
  const fail = (message) => {
    error.textContent = message;
    error.hidden = false;
  };
  const send = async (control, nextState) => {
    if (editor.pending || !current()) return;
    const payload = changes();
    if (nextState) payload.state = nextState;
    if (!Object.keys(payload).length) return;
    const invalid = issueAccountError(repo) || issuePayloadError(payload);
    if (invalid) return fail(invalid);
    const login = state.github.accounts.find((a) => a.id === repo.accountId).login;
    const ownedFocus = form.contains(document.activeElement);
    editor.pending = true;
    editor.update();
    const pendingFocus = document.activeElement;
    const mayFocus = () => visible() && (form.contains(document.activeElement) || (ownedFocus && document.activeElement === pendingFocus));
    error.hidden = true;
    try {
      const result = issue
        ? await api('PATCH', `${repoPath(repo)}/issues/${issue.number}`, payload)
        : await api('POST', `${repoPath(repo)}/issues`, payload);
      const verb = nextState === 'closed' ? 'Closed' : nextState === 'open' ? 'Reopened' : issue ? 'Saved' : 'Created';
      toast(`${verb} #${result.issue.number} in ${repo.fullName} as @${login}.`, 4000);
      if (!current()) return;
      const focus = mayFocus();
      githubPick.editing = null;
      if (!issue) githubPick.issueState = 'open';
      delete githubPick.data.issues;
      if (!visible()) return;
      // A new editor may open while the refresh is pending. Focus only the list we drew.
      renderGitHubViews();
      const newButton = panel.querySelector('[data-key="new"]');
      const refreshFocus = document.activeElement;
      await loadView('issues');
      if (focus && visible() && !githubPick.editing && githubPick.repo && repoKey(githubPick.repo) === key
        && (document.activeElement === refreshFocus || document.activeElement === newButton)) {
        panel.querySelector('[data-key="new"]')?.focus();
      }
    } catch (err) {
      if (err instanceof AuthError) return showAuth(err.message);
      const message = err.code === 'too_large' ? 'This issue is too large to send here. Shorten the description or edit it on GitHub.' : err.message;
      if (current()) {
        fail(message);
        const focus = mayFocus();
        editor.pending = false;
        editor.update();
        if (focus) control.focus();
      } else toast(`${repo.fullName} · @${login}: ${message}`, 8000);
    } finally {
      editor.pending = false;
      if (current()) editor.update();
    }
  };
  const submit = el('button', 'btn primary', issue ? 'Save' : 'Create issue');
  submit.type = 'submit';
  const actions = el('div', 'github-actions', submit);
  let toggle;
  const closing = issue?.state === 'open';
  if (issue) {
    toggle = button('', () => send(toggle, closing ? 'closed' : 'open'), closing ? 'btn danger' : 'btn');
    actions.append(toggle);
  }
  actions.append(button('Cancel', leaveIssueEditor));
  if (issue) actions.append(externalLink('Open on GitHub', issue.url, 'btn github-out'));
  form.append(actions);
  editor.update = () => {
    const blocked = issueAccountError(repo);
    context.textContent = `Acting as @${state.github?.accounts.find((a) => a.id === repo.accountId)?.login ?? repo.login}`;
    if (accountError.textContent !== (blocked ?? '')) accountError.textContent = blocked ?? '';
    accountError.hidden = !blocked;
    for (const b of form.querySelectorAll('button')) b.disabled = Boolean(editor.pending);
    submit.disabled = Boolean(editor.pending || blocked || (issue && !dirty()));
    submit.textContent = editor.pending ? 'Saving…' : issue ? 'Save' : 'Create issue';
    title.readOnly = Boolean(editor.pending);
    body.readOnly = Boolean(editor.pending || longBody);
    form.setAttribute('aria-busy', String(Boolean(editor.pending)));
    if (toggle) {
      toggle.disabled = Boolean(editor.pending || blocked);
      toggle.textContent = dirty() ? (closing ? 'Save and close' : 'Save and reopen') : closing ? 'Close issue' : 'Reopen issue';
    }
  };
  form.addEventListener('input', () => {
    error.hidden = true;
    editor.update();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    send(submit);
  });
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (!editor.pending && !dirty()) leaveIssueEditor();
  });
  editor.update();
  panel.replaceChildren(form);
}

function runTone(run) {
  if (run.status !== 'completed') return 'run';
  if (run.conclusion === 'success' || run.conclusion === 'skipped' || run.conclusion === 'neutral') return 'ok';
  if (run.conclusion === 'failure' || run.conclusion === 'timed_out' || run.conclusion === 'startup_failure') return 'bad';
  return '';
}

function runLabel(run) {
  return String(run.status === 'completed' && run.conclusion ? run.conclusion : run.status).replaceAll('_', ' ');
}

function renderRuns() {
  const panel = $('github-runs');
  if (!githubPick.repo) return redraw(panel, [noRepoNote('Actions runs')]);
  const slot = viewData('actions');
  const runs = slot?.value?.runs ?? [];
  const banner = slot?.value ? el('p', `github-running-note${slot.value.running ? ' on' : ''}`, slot.value.running ? 'A workflow is running. This list refreshes every few seconds.' : 'No workflow is running.') : null;
  const rows = runs.map((run) => {
    const meta = [run.name !== run.title && run.name, run.branch && `on ${run.branch}`, run.event, run.runNumber && `#${run.runNumber}`, run.updatedAt && relativeTime(run.updatedAt)].filter(Boolean).join(' · ');
    return recordRow(`run:${run.id}`, run.title, meta, badge(runTone(run), runLabel(run), `Status: ${runLabel(run)}`), run.url);
  });
  redraw(panel, [
    viewTools('actions'),
    banner,
    viewStatus('actions', slot?.value && !runs.length ? 'No workflow runs yet.' : null),
    rows.length ? el('div', 'history-list', ...rows) : null,
    slot?.value?.truncated ? el('p', 'github-view-note', 'Showing the 30 latest runs.') : null,
  ]);
}

function renderPulls() {
  const panel = $('github-pulls');
  if (!githubPick.repo) return redraw(panel, [noRepoNote('pull requests')]);
  const slot = viewData('pulls');
  const pulls = slot?.value?.pulls ?? [];
  const rows = pulls.map((pull) => {
    const meta = [pull.user, pull.head && pull.base && `${pull.head} → ${pull.base}`, pull.updatedAt && `updated ${relativeTime(pull.updatedAt)}`].filter(Boolean).join(' · ');
    return recordRow(`pull:${pull.number}`, `#${pull.number} ${pull.title}`, meta, pull.draft ? badge('', 'Draft', 'Not ready for review') : null, pull.url);
  });
  redraw(panel, [
    viewTools('pulls'),
    viewStatus('pulls', slot?.value && !pulls.length ? 'No open pull requests.' : null),
    rows.length ? el('div', 'history-list', ...rows) : null,
    slot?.value?.truncated ? el('p', 'github-view-note', 'Showing the 30 most recently updated.') : null,
  ]);
}

// ---- session cards --------------------------------------------------------

const cards = new Map();
let sessionsShown = false;
/** Session ids in the order the user arranged the cards, kept in this browser. */
let sessionOrder = parseOrder(load(SESSION_ORDER_KEY));

const MODEL_SOURCES = { report: 'reported by the tool', screen: 'seen on the tool\'s screen', args: 'from the --model argument' };

function modelText(s) {
  return s.model ? s.model.displayName || s.model.name : '';
}

function modelTitle(s) {
  if (!s.model) return '';
  const id = s.model.displayName && s.model.displayName !== s.model.name ? ` (${s.model.name})` : '';
  return `Model ${modelText(s)}${id}, ${MODEL_SOURCES[s.model.source] || s.model.source}`;
}

function accountLabel(s) {
  if (!s.account) return '';
  const provider = state.providers.find((p) => p.id === s.provider.id);
  return (provider?.accounts?.length ?? 0) > 1 || s.account.id !== 'default' ? s.account.label : '';
}

function statusText(s) {
  if (s.status === 'exited') {
    // A multiplexer's client exits 1 when detached by Stop: its exit code tells the user nothing.
    if (s.multiplexer) return 'Closed';
    if (s.signal) return `Exited (${s.signal})`;
    return s.exitCode === 0 || s.exitCode === null ? 'Exited' : `Exited (${s.exitCode})`;
  }
  return isSessionWorking(s) ? 'Working' : 'Running';
}

function buildCard(session) {
  const node = $('session-template').content.firstElementChild.cloneNode(true);
  node.dataset.id = session.id;
  const open = (e) => openPanel(session.id, { beside: e.ctrlKey || e.metaKey });
  node.addEventListener('click', (e) => { if (!e.target.closest('button')) open(e); });
  node.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === node) open(e); });
  node.querySelector('.open').addEventListener('click', open);
  node.querySelector('.stop').addEventListener('click', () => stopSession(session.id));
  node.querySelector('.remove').addEventListener('click', () => removeSession(session.id));
  node.querySelector('.rename').addEventListener('click', () => renameSession(session.id));
  node.querySelector('.resume').addEventListener('click', () => resumeCard(session.id));
  node.querySelector('.use-folder').addEventListener('click', () => {
    const path = state.sessions.get(session.id)?.clone?.path;
    if (path) useFolder(path);
  });
  node.querySelector('.session-id').addEventListener('click', () => {
    const id = toolSessionId(state.sessions.get(session.id) ?? session);
    if (id) copyId(id);
  });
  node.querySelector('.model-pill').addEventListener('click', () => openSessionModel(session.id));
  node.querySelector('.drag-handle').addEventListener('keydown', (e) => moveByKey(e, session.id));
  // Skins name their own keyframes, so the one-shot classes clear on any animation they run.
  node.addEventListener('animationend', (e) => {
    if (e.target.classList.contains('level-up')) e.target.classList.remove('level-up');
    else if (e.target.classList.contains('summon')) e.target.classList.remove('summon');
    else if (e.target === node) node.classList.remove('enter');
  });
  return node;
}

function resumable(s) {
  const provider = state.providers.find((p) => p.id === s.provider.id);
  const id = toolSessionId(s);
  return Boolean(s.status === 'exited' && s.task === null && id && provider?.available && provider.resumable
    && !runningOn(s.provider.id, s.account?.id ?? 'default', id));
}

/** A stopped tmux or herdr card whose multiplexer still has its session. */
function reattachable(s) {
  return Boolean(s.status === 'exited' && s.multiplexer?.reattachable);
}

async function reattachSession(id) {
  try {
    upsertSession((await api('POST', `/sessions/${id}/reattach`)).session);
    openPanel(id);
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    toast(err.message, 8000);
  }
}

function resumeCard(id) {
  const s = state.sessions.get(id);
  if (s && reattachable(s)) return reattachSession(id);
  if (!s || !resumable(s)) return;
  const provider = state.providers.find((p) => p.id === s.provider.id);
  const account = provider.accounts?.find((a) => a.id === s.account?.id)?.id;
  startSession(provider, cards.get(id), { resume: toolSessionId(s), cwd: s.cwd, account });
}

function sessionLevel(s) {
  const end = s.status === 'exited'
    ? Date.parse(s.exitedAt ?? s.lastOutputAt ?? s.createdAt)
    : Date.now();
  const hours = (end - Date.parse(s.createdAt)) / 3_600_000;
  return Number.isFinite(hours) ? Math.max(0, Math.floor(hours)) + 1 : 1;
}

function updateCard(node, s) {
  node.dataset.provider = s.provider.id;
  paintProviderIcon(node.querySelector('.provider-icon'), s.provider);
  const level = sessionLevel(s);
  const badge = node.querySelector('.level-badge');
  if (badge.textContent && Number(badge.textContent) < level) badge.classList.add('level-up');
  badge.textContent = level;
  badge.title = `Level ${level}`;
  node.querySelector('.name').textContent = s.name;
  node.querySelector('.drag-handle').setAttribute('aria-label', `Move ${s.name}`);
  const id = toolSessionId(s);
  const resumed = s.resume && s.resume !== id ? ` · resumed ${s.resume}` : s.resume ? ' · resumed' : '';
  node.querySelector('.meta-text').textContent = [s.provider.vendor, s.provider.tool, accountLabel(s), `started ${relativeTime(s.createdAt)}${resumed}`].filter(Boolean).join(' · ');
  paintIdButton(node.querySelector('.session-id'), id);
  const pill = node.querySelector('.status-pill');
  pill.textContent = statusText(s);
  pill.className = `status-pill ${s.status === 'exited' ? 'exited' : isSessionWorking(s) ? 'active' : 'quiet'}`;
  const model = node.querySelector('.model-pill');
  model.hidden = !s.model;
  model.textContent = modelText(s);
  model.title = [modelTitle(s), modelStatsLine(s)].filter(Boolean).join('\n');
  model.setAttribute('aria-label', `Benchmarks for ${modelText(s)}`);
  model.className = `model-pill ${s.model?.source || ''}`;
  const cwd = node.querySelector('.cwd-line');
  // The LRM keeps a leading "/" in place under the right-to-left truncation style.
  cwd.textContent = `\u200E${s.cwd}`;
  cwd.title = s.cwd;
  renderAgents(node.querySelector('.agents'), s.agents, s.shells || []);
  paintReporting(node.querySelector('.agents-row'), s);
  node.classList.toggle('exited', s.status === 'exited');
  const stop = node.querySelector('.stop');
  stop.hidden = s.status !== 'running';
  stop.textContent = s.multiplexer ? 'Detach' : 'Stop';
  stop.title = s.multiplexer ? `Detach from ${s.multiplexer.label}; it keeps running. Reattach with: ${s.multiplexer.attach}` : '';
  node.querySelector('.remove').hidden = s.status === 'running';
  const useButton = node.querySelector('.use-folder');
  useButton.hidden = !clonedPath(s);
  useButton.title = clonedPath(s) ? `Make ${s.clone.path} the working folder, so new sessions start there` : '';
  const resume = node.querySelector('.resume');
  resume.hidden = !resumable(s) && !reattachable(s);
  resume.textContent = s.multiplexer ? 'Reattach' : 'Resume';
  resume.title = s.multiplexer
    ? `Attach this card to its ${s.multiplexer.label} session again, as ${s.multiplexer.attach} would`
    : `Start ${s.provider.tool} again on this session${id ? ` (${id})` : ''} in ${s.cwd}`;
  const modelLabel = s.model ? `, model ${modelText(s)}` : '';
  const accountName = accountLabel(s) ? `, ${accountLabel(s)} account` : '';
  const shellCount = (s.shells || []).length;
  const reportingNote = s.status === 'running' && REPORTING_TEXT[s.reporting?.state] ? `, agent reporting: ${REPORTING_TEXT[s.reporting.state]}` : '';
  node.setAttribute('aria-label', `${s.name}, ${s.provider.vendor}${accountName}${modelLabel}, ${statusText(s)}, ${s.agents.length} agents${shellCount ? `, ${shellCount} shell command${shellCount === 1 ? '' : 's'} running` : ''}${reportingNote}`);
}

function renderSessions() {
  const grid = $('sessions');
  const sessions = orderSessions(state.sessions.values(), sessionOrder);
  activityFavicon.setWorking(sessions.some(isSessionWorking));
  for (const [id, node] of cards) {
    if (state.sessions.has(id)) continue;
    if (drag?.id === id) releaseDrag();
    node.remove();
    cards.delete(id);
  }
  sessions.forEach((s, index) => {
    let node = cards.get(s.id);
    if (!node) {
      node = buildCard(s);
      cards.set(s.id, node);
      if (sessionsShown) node.classList.add('enter');
    }
    updateCard(node, s);
    // With one card there is nothing to reorder.
    node.querySelector('.drag-handle').hidden = sessions.length < 2;
    // Move a card only when it is out of place: re-inserting a node drops
    // keyboard focus and can swallow a click that is in progress.
    if (grid.children[index] !== node) grid.insertBefore(node, grid.children[index] || null);
  });
  const running = sessions.filter((s) => s.status === 'running').length;
  $('session-count').textContent = sessions.length ? `· ${running} running` : '';
  $('empty').hidden = sessions.length > 0;
  guardLeaving();
  if (state.activeId) updatePanel();
  if ($('history').open) renderHistory();
  if (state.stats && sessions.some((s) => s.model && state.statsFor.get(s.id) !== modelKey(s))) scheduleStats();
}

function confirmLeaving(event) {
  event.preventDefault();
  event.returnValue = true;
}

function guardLeaving() {
  const running = state.connected && [...state.sessions.values()].some((s) => s.status === 'running');
  // Notes that could not be saved are lost with the page.
  const unsaved = notesView.status !== 'saved' && $('notes-text').value !== '';
  if (running || unsaved) addEventListener('beforeunload', confirmLeaving);
  else removeEventListener('beforeunload', confirmLeaving);
}

function upsertSession(session) {
  // An exit is final for the process it ended. A reply sent before it, such as Stop's, can
  // arrive after the exit was announced and must not show the session running again; a
  // reattached tmux or herdr session runs a newer process, started after that exit.
  const known = state.sessions.get(session.id);
  if (known?.status === 'exited' && session.status !== 'exited' && !(Date.parse(session.startedAt) > Date.parse(known.exitedAt))) return;
  state.sessions.set(session.id, session);
  renderSessions();
  noticeClone(session);
}

function dropSession(id) {
  state.sessions.delete(id);
  const view = state.views.get(id);
  const pane = state.panes.indexOf(id);
  if (pane !== -1) closePane(pane, { focusTerminal: paneNodes[pane].contains(document.activeElement) });
  if (view) { view.dispose(); state.views.delete(id); }
  renderSessions();
}

/** What happens to a running session when it is stopped, for the confirmation. */
function stopNote(s) {
  const mux = s.multiplexer;
  return mux ? `${mux.label} keeps running it. Reattach it from its card, or in a terminal with: ${mux.attach}` : `The ${s.provider.tool} process will be ended.`;
}

async function stopSession(id) {
  const s = state.sessions.get(id);
  if (!s || s.status !== 'running') return;
  if (!confirm(`${s.multiplexer ? 'Detach' : 'Stop'} "${s.name}"? ${stopNote(s)}`)) return;
  try { upsertSession((await api('POST', `/sessions/${id}/stop`)).session); } catch (err) { toast(err.message); }
}

async function removeSession(id) {
  const s = state.sessions.get(id);
  if (!s) return;
  // The card goes, so only the terminal can reattach it.
  const question = s.multiplexer ? `Detach it and remove it? ${s.multiplexer.label} keeps running it. Reattach it in a terminal with: ${s.multiplexer.attach}` : 'End it and remove it?';
  if (s.status === 'running' && !confirm(`"${s.name}" is still running. ${question}`)) return;
  try { await api('DELETE', `/sessions/${id}`); dropSession(id); } catch (err) { toast(err.message); }
}

async function renameSession(id) {
  const s = state.sessions.get(id);
  if (!s) return;
  const name = prompt('Session name', s.name);
  if (name === null || !name.trim()) return;
  try { upsertSession((await api('PATCH', `/sessions/${id}`, { name })).session); } catch (err) { toast(err.message); }
}

// ---- reordering session cards ---------------------------------------------

/** The saved card order: session ids. Anything unreadable counts as no order. */
function parseOrder(raw) {
  try {
    const ids = JSON.parse(raw);
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** Sessions in the user's order. Any the order does not name, such as new ones, follow oldest first. */
function orderSessions(sessions, order) {
  const rank = new Map(order.map((id, index) => [id, index]));
  const at = (s) => rank.get(s.id) ?? Infinity;
  return [...sessions].sort((a, b) => (at(a) - at(b)) || a.createdAt.localeCompare(b.createdAt));
}

/** The ids with one of them moved to a new index. */
function moveId(ids, id, index) {
  const rest = ids.filter((other) => other !== id);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, id);
  return rest;
}

const shownIds = () => orderSessions(state.sessions.values(), sessionOrder).map((s) => s.id);
const sameOrder = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);
const REORDER_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
/** How close to the top or bottom of the window a carried card scrolls the page. */
const SCROLL_EDGE = 72;

/** The card being carried, or null. */
let drag = null;

function saveOrder() {
  sessionOrder = shownIds();
  save(SESSION_ORDER_KEY, JSON.stringify(sessionOrder));
}

function announceOrder(id) {
  const ids = shownIds();
  const s = state.sessions.get(id);
  if (s) $('reorder-status').textContent = `${s.name} moved to position ${ids.indexOf(id) + 1} of ${ids.length}.`;
}

/** Plays a card's move from where it was drawn to where it now sits. Returns the animation, if any. */
function slideFrom(node, was) {
  for (const animation of node.getAnimations()) if (animation.id === 'reorder') animation.cancel();
  if (reducedMotion.matches) return null;
  const now = node.getBoundingClientRect();
  const dx = was.left + was.width / 2 - (now.left + now.width / 2);
  const dy = was.top + was.height / 2 - (now.top + now.height / 2);
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return null;
  const slide = node.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], { duration: 260, easing: REORDER_EASE });
  slide.id = 'reorder';
  return slide;
}

/** Lays the cards out in a new order, sliding each one from its old place. */
function arrange(order) {
  const focused = $('sessions').contains(document.activeElement) ? document.activeElement : null;
  const was = new Map([...cards.values()].map((node) => [node, node.getBoundingClientRect()]));
  sessionOrder = order;
  renderSessions();
  // Moving a card can take keyboard focus with it, as when another tab reorders the cards.
  if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
  for (const [node, rect] of was) if (node !== drag?.node) slideFrom(node, rect);
}

function moveByKey(e, id) {
  if (drag || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const step = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[e.key];
  if (!step && e.key !== 'Home' && e.key !== 'End') return;
  e.preventDefault();
  const ids = shownIds();
  const from = ids.indexOf(id);
  const to = e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : from + step;
  if (from === -1 || to < 0 || to >= ids.length || to === from) return;
  arrange(moveId(ids, id, to));
  saveOrder();
  announceOrder(id);
}

/** A card's place in the grid, ignoring the transforms that animate it. */
function layoutBox(node) {
  return { left: node.offsetLeft, top: node.offsetTop, right: node.offsetLeft + node.offsetWidth, bottom: node.offsetTop + node.offsetHeight };
}

function startDrag(e, handle) {
  const node = handle.closest('.session-card');
  const grid = $('sessions');
  if (drag || !node || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
  e.preventDefault();
  // Where on the card, as drawn, it was picked up: it may still be sliding into place.
  const seen = node.getBoundingClientRect();
  drag = {
    id: node.dataset.id, node, grid, pointerId: e.pointerId,
    before: sessionOrder, start: shownIds(),
    grabX: e.clientX - seen.left, grabY: e.clientY - seen.top,
    x: e.clientX, y: e.clientY,
    // The card just stepped over; it is not a target again until the pointer leaves it.
    passed: null, frame: 0,
  };
  // The grid is never moved, so it keeps the pointer while the cards inside it are.
  try { grid.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
  // A card picked up again while it settles would otherwise be held in place by that animation.
  for (const animation of node.getAnimations()) if (animation.id === 'reorder') animation.cancel();
  node.classList.remove('settling');
  // The card lifts around the point it was picked up by, which stays under the pointer.
  node.style.transformOrigin = `${drag.grabX}px ${drag.grabY}px`;
  node.classList.add('dragging');
  follow();
  grid.getBoundingClientRect(); // the outline appears where the card is, rather than gliding in
  grid.classList.add('reordering');
  document.documentElement.classList.add('reordering');
  if (e.pointerType !== 'mouse' && navigator.userActivation?.hasBeenActive) navigator.vibrate?.(8);
}

/** Puts the carried card under the pointer and the outline where it will land. */
function follow() {
  const { node, grid } = drag;
  const origin = grid.getBoundingClientRect();
  const box = layoutBox(node);
  node.style.translate = `${drag.x - drag.grabX - origin.left - box.left}px ${drag.y - drag.grabY - origin.top - box.top}px`;
  grid.style.setProperty('--slot-x', `${box.left}px`);
  grid.style.setProperty('--slot-y', `${box.top}px`);
  grid.style.setProperty('--slot-w', `${box.right - box.left}px`);
  grid.style.setProperty('--slot-h', `${box.bottom - box.top}px`);
}

/** Moves the carried card to the place the pointer is over, if that is another card's. */
function retarget() {
  const { node, grid } = drag;
  const origin = grid.getBoundingClientRect();
  // The middle of the carried card, not the grip at its corner, picks the place, the same in every direction.
  const x = drag.x - drag.grabX - origin.left + node.offsetWidth / 2;
  const y = drag.y - drag.grabY - origin.top + node.offsetHeight / 2;
  const over = (n) => {
    const box = layoutBox(n);
    return x >= box.left && x < box.right && y >= box.top && y < box.bottom;
  };
  if (drag.passed && !(drag.passed.isConnected && over(drag.passed))) drag.passed = null;
  const shown = [...grid.children];
  let target = shown.find((n) => n !== node && n !== drag.passed && over(n));
  // Past the last card, beside it or below it, is the last place.
  const last = shown.at(-1);
  if (!target && last !== node && last !== drag.passed) {
    const box = layoutBox(last);
    if (y >= box.bottom || (y >= box.top && x >= box.right)) target = last;
  }
  if (!target) return;
  const next = moveId(shownIds(), drag.id, shown.indexOf(target));
  if (sameOrder(next, shownIds())) return;
  arrange(next);
  drag.passed = target;
}

/** Scrolls the page while the pointer is near its top or bottom edge. Returns whether it moved. */
function autoScroll() {
  const top = topbar.getBoundingClientRect().bottom;
  const bottom = window.innerHeight;
  let pull = 0;
  if (drag.y < top + SCROLL_EDGE) pull = -(top + SCROLL_EDGE - drag.y) / SCROLL_EDGE;
  else if (drag.y > bottom - SCROLL_EDGE) pull = (drag.y - bottom + SCROLL_EDGE) / SCROLL_EDGE;
  const step = Math.round(Math.max(-1, Math.min(1, pull)) * 18);
  if (!step) return false;
  const was = window.scrollY;
  window.scrollBy(0, step);
  return window.scrollY !== was;
}

function scheduleDragFrame() {
  if (drag && !drag.frame) drag.frame = requestAnimationFrame(dragFrame);
}

function dragFrame() {
  drag.frame = 0;
  const scrolled = autoScroll();
  retarget();
  if (!drag) return;
  follow();
  if (scrolled) drag.frame = requestAnimationFrame(dragFrame);
}

/** Lets go of the carried card without touching the order, as when its session is removed. */
function releaseDrag() {
  if (!drag) return null;
  const ended = drag;
  drag = null;
  cancelAnimationFrame(ended.frame);
  // The grid keeps the pointer until the button comes up, which ends the capture: a drag cancelled with
  // Escape or by leaving the window must not end in a click that opens the card under the pointer.
  ended.node.style.translate = '';
  ended.node.classList.remove('dragging');
  ended.grid.classList.remove('reordering');
  document.documentElement.classList.remove('reordering');
  return ended;
}

/** Drops the carried card where it is, or with `keep` false puts every card back. */
function endDrag(keep) {
  if (!drag) return;
  const { node } = drag;
  const was = node.getBoundingClientRect();
  const ended = releaseDrag();
  if (!keep) arrange(ended.before);
  // Compare only the sessions there before and after: one created or removed meanwhile is no move.
  const now = shownIds().filter((id) => ended.start.includes(id));
  const moved = !sameOrder(now, ended.start.filter((id) => now.includes(id)));
  if (keep && moved) {
    saveOrder();
    announceOrder(ended.id);
  }
  node.classList.add('settling');
  const settle = slideFrom(node, was);
  const done = () => {
    if (node.classList.contains('dragging')) return; // picked up again
    node.classList.remove('settling');
    node.style.transformOrigin = '';
  };
  if (settle) settle.finished.then(done, done);
  else done();
}

// ---- terminal views -------------------------------------------------------

const TERMINAL_THEME = {
  background: '#0f1115',
  foreground: '#e6e9ef',
  cursor: '#e6e9ef',
  selectionBackground: '#3a4050',
};

/**
 * The session manager answers terminal queries (cursor position, device
 * attributes, mode and colour reports) once for every session. If each
 * attached page answered too, replies would be duplicated into the
 * program's input. Swallow the queries here before xterm.js replies.
 */
function suppressQueryReplies(term) {
  const swallow = () => true;
  const csi = [
    { final: 'n' }, // DSR, including cursor position
    { prefix: '?', final: 'n' },
    { final: 'c' }, // primary device attributes
    { prefix: '>', final: 'c' }, // secondary device attributes
    { prefix: '=', final: 'c' }, // tertiary device attributes
    { intermediates: '$', final: 'p' }, // DECRQM (ANSI modes)
    { prefix: '?', intermediates: '$', final: 'p' }, // DECRQM (private modes)
    { prefix: '>', final: 'q' }, // XTVERSION
  ];
  for (const id of csi) term.parser.registerCsiHandler(id, swallow);
  term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, swallow); // DECRQSS
  for (const code of [4, 10, 11, 12]) {
    term.parser.registerOscHandler(code, (data) => data.includes('?'));
  }
}

/** The text an OSC 52 sequence ("c;<base64>") asks to copy, or null for a clipboard query or anything unreadable. */
function osc52Text(data) {
  const payload = data.slice(data.indexOf(';') + 1);
  if (!data.includes(';') || !payload || payload === '?' || payload.length > 4 * 1024 * 1024) return null;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** The line a terminal shows when its process ends. A tmux or herdr client's exit code says nothing about the session it showed. */
function exitLine(s, { exitCode, signal }) {
  if (s?.multiplexer) return '[closed]';
  return `[process exited with ${signal ? `signal ${signal}` : `code ${exitCode ?? 0}`}]`;
}

class TerminalView {
  constructor(sessionId) {
    this.id = sessionId;
    this.el = document.createElement('div');
    this.term = new window.Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace',
      fontSize: coarsePointer.matches ? 14 : 13,
      scrollback: 5000,
      macOptionIsMeta: true,
      // Option-drag selects text even while a program reads the mouse, as Shift-drag does elsewhere.
      macOptionClickForcesSelection: true,
      theme: TERMINAL_THEME,
    });
    this.fit = new window.FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new window.WebLinksAddon.WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener,noreferrer')));
    this.term.attachCustomKeyEventHandler((e) => this.handleKey(e));
    suppressQueryReplies(this.term);
    // Programs copy with OSC 52: tmux's copy mode, and herdr where it cannot reach the
    // system clipboard itself. Only the open terminal may write it; nothing reads it.
    this.term.parser.registerOscHandler(52, (data) => {
      const text = osc52Text(data);
      if (text !== null && state.activeId === this.id) navigator.clipboard?.writeText(text).catch(() => {});
      return true;
    });
    this.term.onData((data) => {
      this.send({ type: 'input', data });
    });
    this.opened = false;
    this.disposed = false;
    this.retry = 0;
    this.sent = { cols: 0, rows: 0 };
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.connect();
  }

  handleKey(e) {
    if (e.type !== 'keydown') return true;
    const key = e.key.toLowerCase();
    // Copy: Ctrl+Shift+C, or Ctrl+C when text is selected (Windows Terminal style).
    if (!isMac && e.ctrlKey && key === 'c' && (e.shiftKey || this.term.hasSelection())) {
      const text = this.term.getSelection();
      if (text) navigator.clipboard?.writeText(text).catch(() => {});
      this.term.clearSelection();
      e.preventDefault();
      return false;
    }
    // Paste: let the browser deliver a native paste event for Ctrl+V / Ctrl+Shift+V.
    if (!isMac && e.ctrlKey && key === 'v') return false;
    return true;
  }

  connect() {
    if (this.disposed || state.remoteRevoked) return;
    this.inputReady = false;
    this.inputSnapshot = null;
    terminalControls.refresh();
    const ws = new WebSocket(wsUrl(`/sessions/${this.id}/terminal`));
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.sent = { cols: 0, rows: 0 }; this.sendSize(); };
    ws.onmessage = (event) => { if (!this.disposed && this.ws === ws) this.onMessage(JSON.parse(event.data)); };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.inputReady = false;
      this.inputSnapshot = null;
      terminalControls.refresh();
      if (this.disposed || event.code === 4403 || event.code === 4404 || event.code === 4410) return;
      const delay = Math.min(5000, 300 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'snapshot':
        this.inputReady = false;
        this.inputSnapshot = msg;
        this.inputRun = msg.session.startedAt;
        terminalControls.refresh();
        this.term.reset();
        this.term.resize(msg.cols, msg.rows);
        {
          const ws = this.ws;
          this.term.write(msg.data, () => {
            if (this.disposed || this.ws !== ws || ws.readyState !== WebSocket.OPEN || this.inputSnapshot !== msg) return;
            this.inputReady = msg.session.status === 'running';
            this.inputSnapshot = null;
            this.sent = { cols: 0, rows: 0 };
            this.refit();
            terminalControls.refresh();
          });
        }
        break;
      case 'data':
        this.term.write(msg.data);
        break;
      case 'exit':
        this.inputReady = false;
        this.inputSnapshot = null;
        terminalControls.refresh();
        if (dictation?.id === this.id) stopDictation();
        this.term.write(`\r\n\x1b[2m${exitLine(state.sessions.get(this.id), msg)}\x1b[0m\r\n`);
        break;
      default:
        break;
    }
  }

  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  sendSize() {
    const { cols, rows } = this.term;
    if (terminalSizesHeld || !this.el.isConnected || (cols === this.sent.cols && rows === this.sent.rows)) return;
    this.sent = { cols, rows };
    this.send({ type: 'resize', cols, rows });
  }

  mount(host, { focus = true } = {}) {
    host.replaceChildren(this.el);
    if (!this.opened) { this.term.open(this.el); this.enableTouchScroll(); this.opened = true; }
    this.resizeObserver.observe(host);
    this.refit();
    if (focus) this.term.focus();
  }

  /**
   * xterm.js 6 scrolls only for the mouse wheel, so a one-finger drag would
   * scroll the page behind the panel instead. Turn the drag into scrolling.
   * Full-screen programs and programs that read the mouse get a wheel event,
   * which xterm turns into arrow keys or mouse reports as it does for a real
   * wheel. Scrollback uses scrollLines, because xterm's scrollback reads the
   * legacy wheelDeltaY that a constructed WheelEvent leaves at 0.
   */
  enableTouchScroll() {
    let lastY = null;
    let pending = 0;
    this.el.addEventListener('touchstart', (e) => {
      lastY = e.touches.length === 1 ? e.touches[0].clientY : null;
      pending = 0;
    }, { passive: true });
    this.el.addEventListener('touchmove', (e) => {
      if (lastY === null || e.touches.length !== 1) return;
      e.preventDefault();
      const touch = e.touches[0];
      const delta = lastY - touch.clientY;
      lastY = touch.clientY;
      if (this.term.buffer.active.type === 'alternate' || this.term.modes.mouseTrackingMode !== 'none') {
        const target = this.el.querySelector('.xterm-screen') || this.el;
        target.dispatchEvent(new WheelEvent('wheel', {
          deltaY: delta, deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          clientX: touch.clientX, clientY: touch.clientY, bubbles: true, cancelable: true,
        }));
        return;
      }
      pending += delta;
      const lineHeight = this.el.querySelector('.xterm-rows')?.firstElementChild?.offsetHeight || 17;
      const lines = Math.trunc(pending / lineHeight);
      if (lines) { this.term.scrollLines(lines); pending -= lines * lineHeight; }
    }, { passive: false });
    const end = () => { lastY = null; };
    this.el.addEventListener('touchend', end);
    this.el.addEventListener('touchcancel', end);
  }

  unmount() {
    this.resizeObserver.disconnect();
    this.el.remove();
  }

  scheduleFit() {
    cancelAnimationFrame(this.fitFrame);
    this.fitFrame = requestAnimationFrame(() => this.refit());
  }

  refit() {
    if (!this.el.isConnected) return;
    try { this.fit.fit(); } catch { /* not measurable yet */ }
    this.sendSize();
  }

  dispose() {
    this.disposed = true;
    this.inputReady = false;
    this.inputSnapshot = null;
    terminalControls.refresh();
    this.resizeObserver.disconnect();
    this.ws?.close();
    this.term.dispose();
    this.el.remove();
  }
}

// ---- terminal panel -------------------------------------------------------

const terminalControls = new TerminalControls({
  element: $('terminal-controls'), panel: $('terminal-panel'),
  getCurrent: () => {
    const session = state.sessions.get(state.activeId);
    const view = state.views.get(state.activeId);
    if (!session || session.status !== 'running' || !view?.inputReady || view.disposed
      || session.startedAt !== view.inputRun || view.ws?.readyState !== WebSocket.OPEN
      || !state.connected || state.pageAway || state.remoteRevoked || state.stopping
      || $('app').hidden || $('terminal-panel').hidden || !view.el.isConnected) return null;
    return { term: view.term, socket: view.ws, run: session.startedAt, name: session.name };
  },
});
bindTerminalViewport($('terminal-panel'), $('terminal-controls'));

const terminalCopy = new TerminalCopy({
  opener: $('panel-copy'), dialog: $('terminal-copy'),
  getCurrent: () => {
    const session = state.sessions.get(state.activeId);
    const view = state.views.get(state.activeId);
    return session && view ? { id: session.id, name: session.name, term: view.term } : null;
  },
});

const paneNodes = [...document.querySelectorAll('.terminal-pane')];
const sessionMenu = { mode: 'switch', invoker: null };
let terminalSizesHeld = false;
let panesRestored = false;
let splitRatio = clampRatio(Number.parseFloat(load(SPLIT_RATIO_KEY)));

/**
 * `beside`: into the other pane instead of the focused one. Two panes never show the same session, whose terminal has one size.
 * `restoring`: brought back from the last visit, under a dock that was also brought back and stays on top.
 */
function openPanel(id, { beside = false, restoring = false } = {}) {
  if (!state.sessions.has(id)) return;
  let index = state.panes.indexOf(id);
  if (index === -1) {
    index = !state.panes.length ? 0 : !beside ? state.focusedPane : state.panes.length < 2 ? 1 : 1 - state.focusedPane;
    const replaced = state.panes[index];
    if (replaced) state.views.get(replaced)?.unmount();
    state.panes[index] = id;
    if (!state.views.has(id)) state.views.set(id, new TerminalView(id));
  }
  $('terminal-panel').hidden = false;
  if (!restoring) dockMakesWayForTerminal();
  focusPane(index, { focusTerminal: !restoring || !dockView.panel });
}

function focusPane(index, { focusTerminal = true } = {}) {
  const id = state.panes[index];
  if (!id) return;
  if (state.activeId !== id) { terminalCopy.close(); terminalControls.cancel(); }
  if (dictation && dictation.id !== id) stopDictation();
  state.focusedPane = index;
  state.activeId = id;
  layoutPanes();
  updatePanel();
  if (focusTerminal) state.views.get(id)?.term.focus();
  savePanes();
  followTerminal();
}

function closePane(index, { focusTerminal = true } = {}) {
  const id = state.panes[index];
  if (!id) return;
  if (state.panes.length < 2) return closePanel();
  state.views.get(id)?.unmount();
  state.panes.splice(index, 1);
  focusPane(0, { focusTerminal });
}

function closePanel() {
  terminalControls.cancel();
  terminalCopy.close();
  stopDictation();
  for (const id of state.panes) state.views.get(id)?.unmount();
  state.panes = [];
  state.focusedPane = 0;
  state.activeId = null;
  $('terminal-panel').hidden = true;
  closeMenu($('panel-sessions'));
  renderVoice();
  savePanes();
}

function stageSplit() {
  const box = $('terminal-panel').getBoundingClientRect();
  const controls = $('terminal-controls');
  return splitMode(box.width, box.height - (controls.hidden ? 0 : controls.offsetHeight));
}

function layoutPanes() {
  if ($('terminal-panel').hidden) return;
  const split = state.panes.length === 2 ? stageSplit() : null;
  const panes = $('terminal-panes');
  if (split) panes.dataset.split = split;
  else delete panes.dataset.split;
  panes.style.setProperty('--ratio', String(splitRatio));
  const splitter = $('pane-splitter');
  splitter.hidden = !split;
  splitter.setAttribute('aria-orientation', split === 'rows' ? 'horizontal' : 'vertical');
  splitter.setAttribute('aria-valuemin', String(Math.round(SPLIT_RATIO_MIN * 100)));
  splitter.setAttribute('aria-valuemax', String(Math.round((1 - SPLIT_RATIO_MIN) * 100)));
  splitter.setAttribute('aria-valuenow', String(Math.round(splitRatio * 100)));
  paneNodes.forEach((pane, index) => {
    const id = state.panes[index];
    const shown = Boolean(id) && (split !== null || index === state.focusedPane);
    pane.hidden = !shown;
    pane.classList.toggle('focused', index === state.focusedPane);
    const view = id ? state.views.get(id) : null;
    const host = pane.querySelector('.terminal-host');
    if (shown && view && view.el.parentNode !== host) view.mount(host, { focus: false });
    else if (!shown && view && view.el.parentNode === host) view.unmount();
  });
  renderPaneLabels();
}

function renderPaneLabels() {
  const split = $('terminal-panes').dataset.split;
  paneNodes.forEach((pane, index) => {
    const s = state.sessions.get(state.panes[index]);
    pane.querySelector('.pane-name').textContent = s ? `${s.name} · ${statusText(s)}` : '';
    pane.setAttribute('aria-label', s ? s.name : '');
  });
  const others = [...state.sessions.keys()].some((id) => !state.panes.includes(id));
  $('panel-split').hidden = state.panes.length !== 1 || !others || stageSplit() === null;
  const swap = $('panel-swap');
  const other = state.panes.length === 2 && !split ? state.sessions.get(state.panes[1 - state.focusedPane]) : null;
  swap.hidden = !other;
  swap.textContent = other ? `Show ${other.name}` : '';
  swap.title = other ? `Switch to ${other.name}, the other open terminal` : '';
}

/** The button the session menu opened from, or the switcher once that button is gone, as Split is after a split. */
function sessionInvoker() {
  return sessionMenu.invoker?.checkVisibility?.() ? sessionMenu.invoker : $('panel-switch');
}

function renderSessionMenu() {
  const menu = $('panel-sessions');
  const beside = sessionMenu.mode === 'beside';
  const sessions = orderSessions(state.sessions.values(), sessionOrder).filter((s) => !beside || !state.panes.includes(s.id));
  const items = sessions.map((s) => {
    const item = el('button', 'menu-item', s.name, el('span', 'menu-note', [statusText(s), folderName(s.cwd)].filter(Boolean).join(' · ')));
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    if (s.id === state.activeId) item.setAttribute('aria-current', 'true');
    item.addEventListener('click', () => {
      closeMenu(menu);
      openPanel(s.id, { beside });
    });
    return item;
  });
  menu.replaceChildren(...(items.length ? items : [el('p', 'menu-empty', 'No other sessions')]));
}

function holdTerminalSizes() {
  terminalSizesHeld = true;
  document.documentElement.classList.add('resizing');
}

function releaseTerminalSizes() {
  terminalSizesHeld = false;
  document.documentElement.classList.remove('resizing');
  for (const id of state.panes) state.views.get(id)?.refit();
}

function savePanes() {
  save(PANES_KEY, state.panes.length ? JSON.stringify({ panes: state.panes, focused: state.focusedPane }) : null);
}

function restorePanes() {
  if (panesRestored) return;
  panesRestored = true;
  let saved;
  try { saved = JSON.parse(load(PANES_KEY)); } catch { return; }
  const ids = Array.isArray(saved?.panes) ? saved.panes.filter((id) => typeof id === 'string' && state.sessions.has(id)).slice(0, 2) : [];
  if (!ids.length || state.panes.length) return;
  openPanel(ids[0], { restoring: true });
  if (ids[1]) openPanel(ids[1], { beside: true, restoring: true });
  if (saved.focused === 0 && ids[1]) focusPane(0, { focusTerminal: !dockView.panel });
}

function updatePanel() {
  terminalControls.refresh();
  renderVoice();
  const s = state.sessions.get(state.activeId);
  if (!s) return;
  paintProviderIcon($('panel-icon'), s.provider);
  $('panel-title').textContent = s.name;
  const id = toolSessionId(s);
  $('panel-sub').textContent = [s.provider.tool, accountLabel(s), modelText(s), statusText(s), s.cwd, id && `session ${id}`].filter(Boolean).join(' · ');
  $('panel-sub').title = modelTitle(s);
  renderAgents($('panel-agents'), s.agents, s.shells || []);
  const stop = $('panel-stop');
  stop.textContent = s.status !== 'running' ? 'Remove' : s.multiplexer ? 'Detach' : 'Stop';
  renderPaneLabels();
}

// ---- voice input ----------------------------------------------------------

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const VOICE_RETRY_DELAYS = [250, 500, 1000];
let dictation = null;

function voiceOn() {
  return Boolean(Recognition) && load(VOICE_KEY) === 'on';
}

function renderVoice() {
  if (dictation) keepDictating(dictation);
  $('voice-choice').hidden = !Recognition;
  $('voice').checked = voiceOn();
  $('panel-voice').hidden = !voiceOn() || state.sessions.get(state.activeId)?.status !== 'running';
  $('panel-voice').setAttribute('aria-pressed', String(Boolean(dictation)));
}

function changeVoice(input) {
  save(VOICE_KEY, input.checked ? 'on' : null);
  renderVoice();
}

/** Dictated words as terminal input: one line of text, no control characters, so nothing is ever submitted. */
function dictatedText(text, first) {
  const clean = text.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean && (first ? clean : ` ${clean}`);
}

function canDictate(current) {
  const session = state.sessions.get(current.id);
  return voiceOn() && state.activeId === current.id && session?.status === 'running'
    && session.startedAt === current.startedAt && state.views.has(current.id)
    && !state.pageAway && !state.stopping && document.visibilityState === 'visible'
    && !$('app').hidden && !$('terminal-panel').hidden;
}

/** Every async continuation belongs to one explicit click and one run of the session. */
function keepDictating(current) {
  if (dictation !== current) return false;
  if (canDictate(current)) return true;
  stopDictation();
  return false;
}

async function startDictation() {
  const id = state.activeId;
  const session = state.sessions.get(id);
  if (!session || dictation) return;
  const current = {
    id, startedAt: session.startedAt, lang: navigator.language || 'en-US',
    android: /Android/i.test(navigator.userAgent || ''), processLocally: false,
    rec: null, timer: null, first: true, emptyRetries: 0,
  };
  if (!canDictate(current)) return;
  // Register before awaiting availability so another click or leaving the terminal cancels startup too.
  dictation = current;
  renderVoice();
  state.views.get(id)?.term.focus();
  try {
    // Browsers without this API start in the click handler, without an unnecessary await.
    if (typeof Recognition.available === 'function') {
      current.processLocally = await Recognition.available({ langs: [current.lang], processLocally: true }) === 'available';
    }
  } catch { /* cloud recognition */ }
  listenForDictation(current);
}

function listenForDictation(current) {
  if (!keepDictating(current)) return;
  let rec;
  try {
    rec = new Recognition();
    current.rec = rec;
    rec.lang = current.lang;
    rec.continuous = !current.android;
    rec.interimResults = true;
    if (current.processLocally) rec.processLocally = true;
  } catch {
    stopDictation();
    toast('Voice input could not start.');
    return;
  }
  // A new recognizer per Android phrase avoids cumulative transcripts from continuous mode.
  let committed = 0;
  let heard = false;
  const preview = $('voice-preview');
  rec.onresult = (e) => {
    if (current.rec !== rec || !keepDictating(current)) return;
    let interim = '';
    for (let i = Math.max(e.resultIndex, committed); i < e.results.length; i += 1) {
      const result = e.results[i];
      if (!result.isFinal) { interim += result[0].transcript; continue; }
      committed = i + 1;
      const text = dictatedText(result[0].transcript, current.first);
      if (!text) continue;
      state.views.get(current.id)?.term.paste(text);
      current.first = false;
      current.emptyRetries = 0;
      heard = true;
    }
    preview.textContent = interim.trim();
    preview.hidden = !preview.textContent;
  };
  rec.onerror = (e) => {
    if (current.rec !== rec || !keepDictating(current)) return;
    if (current.android && e.error === 'no-speech') return; // bounded retry after end
    stopDictation();
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Voice input needs permission to use the microphone.');
    else if (e.error === 'network') toast('Voice input could not reach the speech service. Check your connection.');
    else if (e.error === 'audio-capture') toast('No microphone was found.');
    else if (e.error === 'language-not-supported') toast(`Voice input does not support ${current.lang}.`);
    else if (e.error !== 'aborted' && e.error !== 'no-speech') toast('Voice input stopped. Press Dictate to try again.');
  };
  rec.onend = () => {
    if (current.rec !== rec || !keepDictating(current)) return;
    current.rec = null;
    preview.hidden = true;
    preview.textContent = '';
    if (!current.android) return stopDictation();
    if (!heard && current.emptyRetries >= VOICE_RETRY_DELAYS.length) {
      stopDictation();
      toast('Voice input stopped after repeated silence. Press Dictate to try again.');
      return;
    }
    const delay = heard ? VOICE_RETRY_DELAYS[0] : VOICE_RETRY_DELAYS[current.emptyRetries++];
    current.timer = setTimeout(() => {
      current.timer = null;
      listenForDictation(current);
    }, delay);
  };
  try {
    rec.start();
  } catch {
    if (current.rec !== rec || !keepDictating(current)) return;
    stopDictation();
    toast('Voice input could not start.');
  }
}

function stopDictation() {
  const current = dictation;
  if (!current) return;
  dictation = null;
  clearTimeout(current.timer);
  try { current.rec?.abort(); } catch { /* already ended */ }
  $('voice-preview').hidden = true;
  $('voice-preview').textContent = '';
  $('panel-voice').setAttribute('aria-pressed', 'false');
}

// ---- stopping the manager -------------------------------------------------

/**
 * Stop the session manager, or stop it and start it again. The manager
 * refuses while sessions are running unless told to force, so the warning is
 * enforced for every client and the count in the dialog is the manager's,
 * not this page's possibly stale list.
 */
async function stopManager({ force = false, restart = false } = {}) {
  const buttons = [$('stop-manager'), $('restart-manager')];
  for (const button of buttons) button.disabled = true;
  try {
    const body = force || restart ? { ...(force && { force: true }), ...(restart && { restart: true }) } : undefined;
    const answer = await api('POST', '/shutdown', body);
    // A manager that does not say it will restart only stops.
    enterStopping(answer.running, restart && answer.restart === true);
    if (restart && answer.restart !== true) {
      toast('This manager cannot restart itself. Run "agent-guild restart" in a terminal to start the new one.', 12000);
    }
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    if (err.code === 'sessions_running') {
      const n = err.running;
      const what = `${n} session${n === 1 ? ' is' : 's are'} still running`;
      const them = n === 1 ? 'it' : 'all of them';
      const verb = restart ? 'Restarting' : 'Stopping';
      if (confirm(`${what}. ${verb} the session manager ends ${them}. ${restart ? 'Restart' : 'Stop'} anyway?`)) {
        return stopManager({ force: true, restart });
      }
      return;
    }
    toast(err.message, 8000);
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

/** How long to wait for a restarted manager before telling the user how to start one by hand. */
const RESTART_WAIT_MS = 30000;
let restartTimer;

/** The manager is going down, by this page's request or another client's. */
function enterStopping(running = 0, restart = false) {
  if (restart) state.restarting = true;
  if (state.stopping) return;
  state.stopping = true;
  state.stopRemaining = null;
  closePanel();
  closeModels();
  closeNews();
  closeChangelog();
  closeHistory();
  closeGitHub();
  for (const view of state.views.values()) view.dispose();
  state.views.clear();
  state.sessions.clear();
  renderSessions();
  $('app').hidden = true;
  const n = Number(running) || 0;
  const ending = n ? `Ending ${n} running session${n === 1 ? '' : 's'}. ` : '';
  if (state.restarting) {
    showStopped('restarting', 'Restarting the session manager…', `${ending}A new manager starts in a moment and this page reconnects to it by itself.`);
    clearTimeout(restartTimer);
    restartTimer = setTimeout(restartGaveUp, RESTART_WAIT_MS);
  } else {
    showStopped('stopping', 'Stopping the session manager…', `${ending}This can take a few seconds.`);
  }
  setConnection('down', state.restarting ? 'Restarting the session manager…' : 'Stopping the session manager…');
}

/** The manager is back: a `hello` arrived while the page was waiting out a stop. */
function leaveStopping() {
  state.stopping = false;
  state.restarting = false;
  clearTimeout(restartTimer);
  $('stopped').hidden = true;
  $('app').hidden = false;
}

/** A restarted manager did not come back in time; the user has to start one by hand. */
function restartGaveUp() {
  if (!state.stopping || !state.restarting) return;
  state.restarting = false;
  setConnection('down', state.stopRemaining === null ? 'Manager unavailable' : 'Session manager stopped');
  showStopped('stopped', 'The session manager did not come back',
    `Nothing answered within ${Math.round(RESTART_WAIT_MS / 1000)} seconds of the restart. Check manager.log in the Agent Guild data folder, then start it yourself.`);
}

function showStopped(phase, title, text) {
  const el = $('stopped');
  el.classList.toggle('stopping', phase === 'stopping');
  el.classList.toggle('restarting', phase === 'restarting');
  $('stopped-title').textContent = title;
  $('stopped-text').textContent = text;
  // How to start again is only useful once the manager is really gone; a
  // restart brings it back without the user doing anything.
  $('stopped-help').hidden = phase !== 'stopped';
  if (phase === 'stopped') renderStoppedHelp();
  el.hidden = false;
}

/** Instructions for starting the manager again, worded for this computer. */
function renderStoppedHelp() {
  const windows = /Win/.test(navigator.platform || navigator.userAgent);
  $('stopped-how').textContent = isMac
    ? 'To start again, open Terminal (search for it with Spotlight) and run:'
    : windows
      ? 'To start again, open Windows Terminal or PowerShell (search for it in the Start menu) and run:'
      : 'To start again, open a terminal and run:';
  const launcher = state.launcher;
  $('stopped-launcher').hidden = !launcher;
  $('stopped-launcher-path').textContent = launcher || '';
}

async function copyCommand() {
  const button = $('copy-command');
  try {
    await navigator.clipboard.writeText('agent-guild open');
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = 'Copy'; }, 1500);
  } catch {
    toast('Could not copy. Select the command and copy it yourself.');
  }
}

/**
 * The manager has stopped. Only a manager.stopped event with nothing
 * remaining confirms that every process exited; a timeout, or a socket that
 * dropped without the event, must not be announced as a clean stop.
 */
function showManagerStopped() {
  const n = state.stopRemaining;
  const sessions = n === 0 ? 'Every session has ended.'
    : n > 0 ? `${n} session process${n === 1 ? '' : 'es'} did not confirm exiting in time and may still be running. Check your system's process list.`
    : 'The manager went away before confirming that every session had ended.';
  if (state.restarting) {
    setConnection('down', 'Restarting the session manager…');
    return showStopped('restarting', 'Restarting the session manager…', `${sessions} Waiting for the new manager; this page reconnects to it by itself.`);
  }
  setConnection('down', 'Session manager stopped');
  showStopped('stopped', 'Session manager stopped', sessions);
}

// ---- events ---------------------------------------------------------------

function showManagerUnavailable() {
  setConnection('down', 'Manager unavailable. Trying to reconnect…');
  if (state.stopping) {
    clearTimeout(restartTimer);
    showStopped('stopped', 'Manager unavailable', 'The manager stopped responding before confirming shutdown. Sessions may still be running. This page will reconnect automatically.');
  }
}

function connectEvents() {
  if (state.pageAway || state.remoteRevoked) return;
  const ws = new WebSocket(wsUrl('/events'));
  state.eventsSocket = ws;
  ws.onopen = () => {
    if (state.pageAway || state.eventsSocket !== ws) return;
    managerLoss.cancel();
    state.eventsRetry = 0;
    setConnection('ok', 'Connected to session manager');
  };
  ws.onmessage = (event) => {
    if (state.pageAway || state.eventsSocket !== ws) return;
    const msg = JSON.parse(event.data);
    if (msg.type === 'hello') {
      // The manager is back after a stop or restart; the page picks up where it was.
      if (state.stopping) leaveStopping();
      state.version = msg.version || null;
      state.pid = msg.pid || null;
      state.restartable = typeof msg.pid === 'number';
      state.launcher = typeof msg.launcher === 'string' ? msg.launcher : null;
      state.folderOpener = msg.folderOpener || null;
      state.platform = msg.platform || null;
      state.remoteAccessUI?.setAvailable(msg.remoteAccess);
      renderVersion();
      setConnection('ok', 'Connected to session manager');
      state.sessions = new Map(msg.sessions.map((s) => [s.id, s]));
      for (const id of [...state.views.keys()]) if (!state.sessions.has(id)) dropSession(id);
      managerConnected(msg);
      state.environmentUI?.connected(msg.pid);
      renderSessions();
      if (!sessionsShown && load(DOCK_KEY) === 'github' && !dockView.panel) openGitHub({ focus: false });
      restorePanes();
      sessionsShown = true;
      setUpgrade(msg.upgrade, true);
      loadNews();
      // A changelog.updated sent while the socket was down is lost; catch up the open panel.
      if ($('changelog').open) loadChangelog();
      if (dockShows('github')) loadGitHub();
      catchUpNotes(msg.notesRevision, msg.notesUnreadable === true);
    } else if (msg.type === 'notes.updated') {
      applyServerNotes(msg.notes);
    } else if (msg.type === 'environment.updated') {
      state.environmentUI?.updated(msg.environment);
    } else if (msg.type === 'remote-access.updated') {
      state.remoteAccessUI?.updated();
    } else if (msg.type === 'news.updated') {
      loadNews();
    } else if (msg.type === 'github.updated') {
      if (dockShows('github')) loadGitHub();
    } else if (msg.type === 'changelog.updated') {
      if ($('changelog').open) loadChangelog();
    } else if (msg.type === 'manager.upgrade') {
      setUpgrade(msg.upgrade);
    } else if (msg.type === 'manager.stopping') {
      enterStopping(msg.running, msg.restart === true);
    } else if (msg.type === 'manager.stopped') {
      enterStopping(0, msg.restart === true);
      state.stopRemaining = Number(msg.remaining) || 0;
      showManagerStopped();
      managerGone();
    } else if (msg.type === 'session.created' || msg.type === 'session.updated') {
      upsertSession(msg.session);
    } else if (msg.type === 'session.removed') {
      dropSession(msg.sessionId);
    } else if (msg.type === 'providers.updated') {
      state.providers = msg.providers;
      renderProviders();
      if ($('history').open) renderHistory();
      scheduleStats();
    }
  };
  ws.onclose = (event) => {
    if (state.pageAway || state.eventsSocket !== ws) return;
    state.environmentUI?.disconnected();
    if (event?.code === 4403) {
      state.remoteRevoked = true;
      managerLoss.cancel();
      state.remoteAccessUI?.close();
      setConnection('down', 'Remote access changed. Your terminals are still running. Reopen an enabled address to reconnect.');
      return;
    }
    if (state.managerUnavailable) {
      showManagerUnavailable();
    } else if (state.stopping && state.stopRemaining !== null) {
      showManagerStopped();
    } else {
      setConnection('down', 'Connection interrupted. Trying to reconnect…');
    }
    managerLoss.disconnected();
    // Keep trying: after a stop, a relaunched manager brings the page back by itself.
    const delay = Math.min(5000, 500 * 2 ** state.eventsRetry++);
    setTimeout(async () => {
      if (state.pageAway || state.eventsSocket !== ws) return;
      try { await loadProviders(); } catch (err) { if (err instanceof AuthError) return showAuth(err.message); }
      if (!state.pageAway && state.eventsSocket === ws) connectEvents();
    }, delay);
  };
}

async function loadProviders() {
  const { providers } = await api('GET', '/providers');
  state.providers = providers;
  renderProviders();
}

// ---- auth & boot ----------------------------------------------------------

function readTokenFromHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('token');
  if (token) {
    // Keep the token out of the address bar and browser history.
    history.replaceState(null, '', location.pathname + location.search);
  }
  return token;
}

let usageTimer;
let statsInterval;
let newsTimer;

function showAuth(message = '') {
  state.environmentUI?.close();
  state.remoteAccessUI?.setAvailable(null);
  managerLoss.cancel();
  closePanel();
  closeModels();
  closeNews();
  closeChangelog();
  closeHistory();
  closeGitHub();
  $('app').hidden = true;
  $('terminal-panel').hidden = true;
  $('stopped').hidden = true;
  state.stopping = false;
  state.restarting = false;
  clearTimeout(restartTimer);
  $('auth').hidden = false;
  $('auth-error').textContent = message;
  setConnection('down', 'Not connected');
}

async function boot() {
  $('app').hidden = true;
  $('auth').hidden = true;
  $('stopped').hidden = true;
  if (!state.token) return showAuth();
  try {
    await loadProviders();
  } catch (err) {
    if (err instanceof AuthError) {
      save(TOKEN_KEY, null);
      return showAuth(`${err.message} Open the page again with "agent-guild open".`);
    }
    setConnection('down', 'Session manager not reachable. Run "agent-guild open" to start it.');
  }
  save(TOKEN_KEY, state.token);
  $('app').hidden = false;
  if (load(DOCK_KEY) === 'notes' && !dockView.panel) openNotes({ focus: false });
  connectEvents();
  loadUsage();
  clearInterval(usageTimer);
  usageTimer = setInterval(loadUsage, 60000);
  loadStats();
  clearInterval(statsInterval);
  statsInterval = setInterval(loadStats, 60 * 60 * 1000);
  clearInterval(newsTimer);
  newsTimer = setInterval(() => { if (document.visibilityState === 'visible') loadNews(); }, NEWS_POLL_MS);
}

$('auth-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const token = $('auth-token').value.trim();
  if (!token) return;
  state.token = token;
  boot();
});
$('panel-close').addEventListener('click', closePanel);
paneNodes.forEach((pane, index) => {
  pane.querySelector('.pane-close').addEventListener('click', () => closePane(index));
  pane.addEventListener('focusin', () => { if (state.focusedPane !== index) focusPane(index, { focusTerminal: false }); });
  pane.addEventListener('pointerdown', () => { if (state.focusedPane !== index) focusPane(index, { focusTerminal: false }); });
});
const splitAxis = () => ($('terminal-panes').dataset.split === 'rows' ? 'y' : 'x');
const setSplitRatio = (ratio) => {
  splitRatio = clampRatio(ratio);
  layoutPanes();
};
bindSplitter($('pane-splitter'), {
  axis: splitAxis,
  start: () => splitRatio,
  move: (delta, from) => {
    holdTerminalSizes();
    const box = $('terminal-panes').getBoundingClientRect();
    setSplitRatio(from + delta / Math.max(1, (splitAxis() === 'x' ? box.width : box.height) - 8));
  },
  end: () => {
    save(SPLIT_RATIO_KEY, String(splitRatio));
    releaseTerminalSizes();
  },
  home: () => setSplitRatio(SPLIT_RATIO_MIN),
  endKey: () => setSplitRatio(1 - SPLIT_RATIO_MIN),
});
let terminalLayoutFrame;
const terminalLayoutObserver = new ResizeObserver(() => {
  cancelAnimationFrame(terminalLayoutFrame);
  terminalLayoutFrame = requestAnimationFrame(layoutPanes);
});
for (const node of [$('terminal-panel'), $('terminal-controls')]) terminalLayoutObserver.observe(node);
$('panel-voice').addEventListener('click', () => {
  if (dictation) {
    const { id } = dictation;
    stopDictation();
    state.views.get(id)?.term.focus();
  } else startDictation();
});
$('models-close').addEventListener('click', closeModels);
$('history-close').addEventListener('click', closeHistory);
$('history').addEventListener('click', (e) => { if (e.target === $('history')) closeHistory(); });
$('history').addEventListener('close', () => {
  if (historyOpener !== false) {
    const opener = historyOpener?.isConnected ? historyOpener
      : $('providers').querySelector(`.provider[data-id="${historyView.providerId}"] .existing`);
    opener?.focus();
  }
  historyOpener = null;
});
$('history-filter').addEventListener('input', renderHistory);
$('github-open').addEventListener('click', () => openGitHub());
$('github-toggle').addEventListener('click', firstClick(toggleGitHub));
$('github-title').addEventListener('click', () => { if (!dockShows('github')) openGitHub(); });
$('notes-title').addEventListener('click', () => { if (!dockShows('notes')) openNotes(); });
$('dock').querySelector('.dock-tabs').addEventListener('keydown', moveDockTab);
$('dock-close').addEventListener('click', () => closeDock());
$('dock').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || (e.target.type === 'search' && e.target.value)) return;
  e.preventDefault();
  closeDock();
});
bindSplitter($('dock-splitter'), {
  start: () => clampDockWidth(dockView.width, innerWidth),
  move: (delta, from) => {
    holdTerminalSizes();
    dockView.width = clampDockWidth(from - delta, innerWidth);
    applyDockLayout();
  },
  end: () => {
    save(DOCK_WIDTH_KEY, String(dockView.width));
    releaseTerminalSizes();
  },
  home: () => { dockView.width = DOCK_MIN; applyDockLayout(); },
  endKey: () => { dockView.width = clampDockWidth(Infinity, innerWidth); applyDockLayout(); },
});
$('github-add').addEventListener('click', startGitHubSignIn);
$('github-filter').addEventListener('input', () => renderGitHub());
$('github-refresh').addEventListener('click', () => loadRepos({ refresh: true }));
$('github-new').addEventListener('click', () => showCreate($('github-create').hidden));
$('github-create').addEventListener('submit', createRepo);
$('github-create-cancel').addEventListener('click', () => {
  showCreate(false);
  $('github-new').focus();
});
$('github-create').addEventListener('input', () => {
  $('github-create-error').hidden = true;
  renderCreate();
});
const openPicker = (e) => {
  if (githubPick.open) return;
  githubPick.query = '';
  githubPick.active = 0;
  setPickerOpen(true);
  e.target.select();
};
$('github-repo').addEventListener('focus', openPicker);
$('github-repo').addEventListener('click', openPicker);
// Releasing a press would put the caret where it was let go; the press that opens the list keeps the name selected.
let pickerPressOpens = false;
$('github-repo').addEventListener('mousedown', () => { pickerPressOpens = !githubPick.open; });
$('github-repo').addEventListener('mouseup', (e) => { if (pickerPressOpens) e.preventDefault(); });
$('github-repo').addEventListener('input', (e) => {
  githubPick.query = e.target.value;
  githubPick.active = 0;
  if (githubPick.open) renderPickerList();
  else setPickerOpen(true);
});
$('github-repo').addEventListener('keydown', pickerKey);
$('github-repo').addEventListener('blur', (e) => {
  setPickerOpen(false);
  githubPick.query = '';
  e.target.value = githubPick.repo?.fullName ?? '';
});
$('github-repo-reload').addEventListener('click', () => loadAllRepos({ refresh: true }));
$('github-views').addEventListener('click', (e) => {
  const view = e.target.closest?.('[data-view]')?.dataset.view;
  if (view) switchGitHubView(view);
});
$('github-views').addEventListener('keydown', moveGitHubView);
$('github-branches-refresh').addEventListener('click', () => loadView('branches'));
$('github-branches-retry').addEventListener('click', () => loadBranches({ resume: true }));
$('github-branches-filter').addEventListener('input', () => {
  $('github-branches').scrollTop = 0;
  renderBranches({ preserveAnchor: false });
});
$('github-branches-clear').addEventListener('click', () => {
  $('github-branches-filter').value = '';
  $('github-branches').scrollTop = 0;
  renderBranches({ preserveAnchor: false });
  $('github-branches-filter').focus();
});
$('github-parent').addEventListener('change', () => setCloneParent(cloneParent()));
$('github-parent-pick').addEventListener('click', firstClick(() => chooseFolder('clone')));
$('history-here').addEventListener('change', renderHistory);
$('history-form').addEventListener('submit', resumeById);
$('models').addEventListener('click', (e) => { if (e.target === $('models')) closeModels(); });
$('models').addEventListener('close', () => {
  hideTip();
  const opener = modelsOpener?.isConnected ? modelsOpener
    : modelsView.sessionId ? cards.get(modelsView.sessionId)?.querySelector('.model-pill')
    : $('providers').querySelector(`.provider[data-id="${modelsView.providerId}"] .model-stats-head`);
  opener?.focus();
  modelsOpener = null;
});
document.addEventListener('pointerover', (e) => {
  const info = e.target.closest?.('.info');
  if (info && e.pointerType !== 'touch') showTip(info);
});
document.addEventListener('pointerout', (e) => {
  if (tipFor && e.target === tipFor && document.activeElement !== tipFor) hideTip();
});
document.addEventListener('pointerdown', (e) => { if (tipFor && !e.target.closest?.('.info')) hideTip(); });
document.addEventListener('click', (e) => {
  const info = e.target.closest?.('.info');
  if (info) showTip(info);
});
document.addEventListener('focusin', (e) => { if (!quietFocus && e.target.matches?.('.info')) showTip(e.target); });
document.addEventListener('focusout', (e) => { if (e.target === tipFor) hideTip(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !tipFor) return;
  hideTip();
  e.preventDefault();
  e.stopPropagation();
}, true);
addEventListener('scroll', () => { if (tipFor) hideTip(); }, true);
addEventListener('resize', () => { if (tipFor) hideTip(); });
$('notes-open').addEventListener('click', firstClick(toggleNotes));
$('notes-text').addEventListener('input', () => { saveNotes(); void scheduleNotesPush(); });
addEventListener('storage', notesStored);
// On load, and again for a page back from the back/forward cache, which may have missed another tab's notes.
addEventListener('pageshow', refreshNotes);
$('news-all').addEventListener('click', openNews);
$('news-close').addEventListener('click', closeNews);
$('news-fresh').addEventListener('click', showFreshNews);
$('news').addEventListener('click', (e) => { if (e.target === $('news')) closeNews(); });
$('news').addEventListener('close', () => {
  const newest = newestTime(newsView.shown?.items ?? []);
  if (newest > (newsSeen() ?? 0)) save(NEWS_SEEN_KEY, new Date(newest).toISOString());
  renderLatestNews();
  const opener = newsView.opener?.isConnected && !newsView.opener.closest('[hidden]') ? newsView.opener : $('news-all');
  opener.focus();
  newsView.opener = null;
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    stopDictation();
    flushNotes();
  }
  if (document.visibilityState === 'visible' && state.connected && Date.now() - newsLoadedAt > 60000) loadNews();
  if (document.visibilityState === 'visible' && dockShows('github') && githubShownView() === 'actions') loadView('actions');
  else scheduleRuns();
  if (branchesVisible() && !viewData('branches')?.error) loadBranches({ resume: true });
});
addEventListener('pagehide', () => {
  flushNotes();
  state.pageAway = true;
  activityFavicon.setPaused(true);
  terminalCopy.close();
  stopDictation();
  managerLoss.cancel();
  state.eventsSocket?.close();
});
addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  state.pageAway = false;
  activityFavicon.setPaused(false);
  connectEvents();
});
$('version').addEventListener('click', openChangelog);
$('changelog-close').addEventListener('click', closeChangelog);
$('changelog').addEventListener('click', (e) => { if (e.target === $('changelog')) closeChangelog(); });
$('changelog').addEventListener('close', () => {
  const opener = changelogView.opener?.isConnected && !changelogView.opener.closest('[hidden]') ? changelogView.opener : $('version');
  opener.focus();
  changelogView.opener = null;
});
$('changelog-upgrade').addEventListener('click', () => {
  closeChangelog();
  upgradeManager();
});
$('changelog-restart').addEventListener('click', () => {
  closeChangelog();
  stopManager({ restart: true });
});
addEventListener('storage', (e) => {
  if (e.key === CHANGELOG_SEEN_KEY) renderVersion();
  else if (e.key === SOUND_KEY) { $('sound').checked = soundOn(); prepareSounds(); }
  else if (e.key === VOICE_KEY) renderVoice();
  // Another tab reordered the cards.
  else if (e.key === SESSION_ORDER_KEY && !drag) arrange(parseOrder(e.newValue));
});
$('sessions').addEventListener('pointerdown', (e) => {
  const handle = e.target.closest?.('.drag-handle');
  if (handle) startDrag(e, handle);
});
$('sessions').addEventListener('pointermove', (e) => {
  if (drag?.pointerId !== e.pointerId) return;
  // A mouse released outside the window sends no pointerup.
  if (e.pointerType === 'mouse' && !(e.buttons & 1)) return endDrag(true);
  drag.x = e.clientX;
  drag.y = e.clientY;
  scheduleDragFrame();
});
$('sessions').addEventListener('pointerup', (e) => { if (drag?.pointerId === e.pointerId) endDrag(true); });
$('sessions').addEventListener('pointercancel', (e) => { if (drag?.pointerId === e.pointerId) endDrag(false); });
// The loss from the last drop can arrive after a quick new pickup, which holds the capture again.
$('sessions').addEventListener('lostpointercapture', (e) => {
  if (drag?.pointerId === e.pointerId && !drag.grid.hasPointerCapture(e.pointerId)) endDrag(true);
});
// A long press on the grip would open the context menu on a touch screen.
$('sessions').addEventListener('contextmenu', (e) => { if (e.target.closest?.('.drag-handle')) e.preventDefault(); });
// The page can move under a carried card without the pointer moving.
addEventListener('scroll', scheduleDragFrame, { passive: true });
addEventListener('resize', scheduleDragFrame);
document.addEventListener('keydown', (e) => {
  if (!drag || e.key !== 'Escape') return;
  e.preventDefault();
  endDrag(false);
});
addEventListener('blur', () => endDrag(false));
$('models-more').addEventListener('click', () => {
  const before = $('models-list').childElementCount;
  modelsView.all = true;
  renderModels();
  $('models-list').children[before]?.querySelector('.model-toggle')?.focus();
});
$('stop-manager').addEventListener('click', firstClick(() => { closeMenu($('manager-menu')); stopManager(); }));
$('restart-manager').addEventListener('click', firstClick(() => { closeMenu($('manager-menu')); stopManager({ restart: true }); }));
$('copy-command').addEventListener('click', copyCommand);
$('upgrade').addEventListener('click', upgradeManager);
$('settings-menu').addEventListener('change', (e) => {
  if (e.target.name === 'skin') changeSkin(e.target);
  else if (e.target.name === 'theme') changeTheme(e.target);
  else if (e.target.name === 'sound') changeSound(e.target);
  else if (e.target.name === 'voice') changeVoice(e.target);
  else if (e.target.name === 'autostart') changeAutostart(e.target);
});
/**
 * Runs `opened` once a menu shows and `closed` once it hides. Chrome skips the toggle event of a menu
 * that closes and opens again within a task, so this follows beforetoggle, which always fires.
 */
function onMenu(menu, opened, closed = () => {}) {
  menu.addEventListener('beforetoggle', (e) => {
    const opening = e.newState === 'open';
    requestAnimationFrame(() => {
      if (menu.matches(':popover-open') === opening) (opening ? opened : closed)(menu);
    });
  });
}
/** A menu closed with its focus inside, or with nothing focused after it, hands the focus back to its button. */
function returnFocus(menu, invoker) {
  const at = document.activeElement;
  if ((!at || at === document.body || menu.contains(at)) && invoker?.checkVisibility?.()) invoker.focus();
}
onMenu($('settings-menu'), (menu) => {
  loadAutostart();
  placeMenu(menu, $('settings'));
  menu.querySelector('input:checked')?.focus();
}, (menu) => returnFocus(menu, $('settings')));
onMenu($('manager-menu'), (menu) => {
  placeMenu(menu, $('manager'));
  menuItems(menu)[0]?.focus();
}, (menu) => returnFocus(menu, $('manager')));
$('panel-sessions').addEventListener('beforetoggle', (e) => { if (e.newState === 'open') renderSessionMenu(); });
onMenu($('panel-sessions'), (menu) => {
  placeMenu(menu, sessionInvoker());
  (menu.querySelector('.menu-item[aria-current="true"]') ?? menuItems(menu)[0])?.focus();
}, (menu) => returnFocus(menu, sessionInvoker()));
for (const menu of [$('manager-menu'), $('panel-sessions')]) menu.addEventListener('keydown', moveInMenu);
// Recorded only on the click that opens the menu: a click that closes it leaves what the open menu showed.
const sessionMenuFrom = (mode, invoker) => () => {
  if (!$('panel-sessions').matches(':popover-open')) Object.assign(sessionMenu, { mode, invoker });
};
$('panel-switch').addEventListener('click', sessionMenuFrom('switch', $('panel-switch')));
$('panel-split').addEventListener('click', sessionMenuFrom('beside', $('panel-split')));
$('panel-swap').addEventListener('click', () => focusPane(1 - state.focusedPane));
window.addEventListener('resize', () => {
  if (topbarInline(innerWidth)) closeMenu($('topbar-menu'));
  applyDockLayout();
  placeMenu($('settings-menu'), $('settings'));
  placeMenu($('manager-menu'), $('manager'));
  placeMenu($('panel-sessions'), sessionInvoker());
});
$('providers').addEventListener('animationend', (e) => {
  if (e.target === e.currentTarget.lastElementChild) e.currentTarget.classList.remove('deal');
});
let tiltFrame = 0;
$('providers').addEventListener('pointermove', (e) => {
  const card = e.target.closest('.provider');
  if (!card || !finePointer.matches || reducedMotion.matches) return;
  const box = card.getBoundingClientRect();
  const x = ((e.clientX - box.left) / box.width) * 2 - 1;
  const y = ((e.clientY - box.top) / box.height) * 2 - 1;
  cancelAnimationFrame(tiltFrame);
  tiltFrame = requestAnimationFrame(() => {
    card.style.setProperty('--px', x.toFixed(3));
    card.style.setProperty('--py', y.toFixed(3));
  });
});
$('providers').addEventListener('pointerout', (e) => {
  const card = e.target.closest('.provider');
  if (card && !card.contains(e.relatedTarget)) {
    cancelAnimationFrame(tiltFrame);
    card.style.removeProperty('--px');
    card.style.removeProperty('--py');
  }
});
applyTheme(currentTheme());
renderSkinChoices();
$('sound').checked = soundOn();
renderVoice();
// Follow the system setting until the user picks a theme.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (!load(THEME_KEY)) applyTheme(e.matches ? 'dark' : 'light');
});
$('panel-stop').addEventListener('click', () => {
  const s = state.sessions.get(state.activeId);
  if (!s) return;
  if (s.status === 'running') stopSession(s.id);
  else removeSession(s.id);
});
$('cwd').value = load(CWD_KEY) || '';
$('cwd-pick').addEventListener('click', firstClick(() => chooseFolder('cwd')));
for (const [field, { input }] of Object.entries(RECENT_FIELDS)) {
  $(input).addEventListener('focus', () => showRecent(field));
  $(input).addEventListener('click', () => { if (recentView.field !== field) showRecent(field); });
  $(input).addEventListener('input', () => showRecent(field, true));
  $(input).addEventListener('blur', () => hideRecent(field));
  $(input).addEventListener('keydown', (e) => recentKeys(field, e));
}
$('folder-cancel').addEventListener('click', () => $('folder-browser').close());
$('folder-browser').addEventListener('click', (e) => { if (e.target === $('folder-browser')) $('folder-browser').close(); });
$('folder-browser').addEventListener('close', folderBrowserClosed);
$('folder-browser').addEventListener('keydown', folderBrowserKeys);
$('folder-list').addEventListener('keydown', moveInFolders);
$('folder-up').addEventListener('click', () => browseTo(folderView.listing.parent));
$('folder-home').addEventListener('click', () => browseTo('~'));
$('folder-filter').addEventListener('input', renderFolderBrowser);
$('folder-hidden').addEventListener('change', (e) => {
  save(HIDDEN_FOLDERS_KEY, e.target.checked ? '1' : null);
  renderFolderBrowser();
});
$('folder-use').addEventListener('click', useBrowsedFolder);
$('folder-new-open').addEventListener('click', () => showNewFolder($('folder-new').hidden));
$('folder-new-cancel').addEventListener('click', () => showNewFolder(false));
$('folder-new').addEventListener('submit', createFolder);
$('folder-new-name').addEventListener('input', renderFolderBrowser);
$('folder-new-name').addEventListener('keydown', newFolderKeys);
$('cwd-open').addEventListener('click', firstClick(openWorkingFolder));
try { state.accounts = JSON.parse(load(ACCOUNTS_KEY)) || {}; } catch { state.accounts = {}; }
try { state.shellPicks = JSON.parse(load(SHELLS_KEY)) || {}; } catch { state.shellPicks = {}; }
githubView.accountId = Number(load(GITHUB_ACCOUNT_KEY)) || null;
try { githubPick.recent = JSON.parse(load(GITHUB_RECENT_KEY)) || []; } catch { githubPick.recent = []; }
if (!Array.isArray(githubPick.recent)) githubPick.recent = [];
if (GITHUB_VIEWS.includes(load(GITHUB_VIEW_KEY))) githubPick.view = load(GITHUB_VIEW_KEY);
if (typeof state.accounts !== 'object' || Array.isArray(state.accounts)) state.accounts = {};
if (typeof state.shellPicks !== 'object' || Array.isArray(state.shellPicks)) state.shellPicks = {};
setInterval(renderSessions, 30000);
setInterval(tickNews, 30000);
setInterval(() => { if (dockShows('github') && state.github) renderGitHub(); }, 30000);

// The terminal panel and the dock sit below the top bar; publish where it ends so they never cover its controls.
const topbar = document.querySelector('.topbar');
const publishTopbarHeight = () => document.documentElement.style.setProperty('--topbar-h', `${Math.max(0, Math.round(topbar.getBoundingClientRect().bottom))}px`);
let topbarFrame;
const scheduleTopbarHeight = () => {
  cancelAnimationFrame(topbarFrame);
  topbarFrame = requestAnimationFrame(publishTopbarHeight);
};
new ResizeObserver(scheduleTopbarHeight).observe(topbar);
addEventListener('scroll', scheduleTopbarHeight, { passive: true });
publishTopbarHeight();
applyDockLayout();

state.remoteAccessUI = createRemoteAccessUI({ api, getToken: () => state.token, isConnected: () => state.connected, onAuthError: showAuth });
state.environmentUI = createEnvironmentUI({ api, onAuthError: showAuth, isAuthError: (err) => err instanceof AuthError });
state.token = readTokenFromHash() || load(TOKEN_KEY);
boot();
