// The phone view: a second client of the manager's API (docs/api.md), served
// beside the full page at /mobile/. It is a view and nothing more: it keeps the
// access token and a few display preferences, and owns no session, setting or
// state of its own. It shows a terminal at the size the manager uses, so a
// glance from a phone never reflows the terminal on the desk; Fit resizes it
// on purpose, and stops by itself when another client resizes.

import { TerminalControls, bindTerminalViewport } from '/terminal-controls.js';
import { readRecentFolders, rememberFolder } from '/folders.js';
import {
  DEFAULT_FONT_SIZE, FONT_SIZES, dictatedText, exitLine, folderName, orderSessions, relativeTime, sessionState,
  sessionSummary, stateLabel, stepFontSize, tokenFromHash, tokenFromInput,
} from '/mobile/model.js';

const $ = (id) => document.getElementById(id);
// Shared with the full page, so one sign-in, theme and recent-folder list serve both.
const TOKEN_KEY = 'agentGuild.token';
const THEME_KEY = 'agentGuild.theme';
const RECENT_KEY = 'agentGuild.recentCwds';
const CWD_KEY = 'agentGuild.mobile.cwd';
const FONT_KEY = 'agentGuild.mobile.fontSize';
const TERMINAL_THEME = { background: '#0f1115', foreground: '#e6e9ef', cursor: '#e6e9ef', selectionBackground: '#3a4050' };
const RELATIVE_TIME_MS = 30000;

function load(key) { try { return localStorage.getItem(key); } catch { return null; } }
function save(key, value) {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

class AuthError extends Error {}

const state = {
  token: null, connected: false, away: false, revoked: false, stopping: false, restarting: false, platform: null,
  sessions: new Map(), providers: [], events: null, retry: 0, terminal: null,
  fontSize: FONT_SIZES.includes(Number(load(FONT_KEY))) ? Number(load(FONT_KEY)) : DEFAULT_FONT_SIZE,
};

// ---- API -----------------------------------------------------------------

async function api(method, path, body) {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${state.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new AuthError('The access token was rejected.');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.error?.message || `Request failed (HTTP ${res.status})`), data?.error);
  return data;
}

function wsUrl(path) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/api/v1${path}?token=${encodeURIComponent(state.token)}`;
}

// ---- small UI -------------------------------------------------------------

function setConnection(kind, text) {
  const el = $('connection');
  el.classList.toggle('ok', kind === 'ok');
  el.classList.toggle('down', kind === 'down');
  el.querySelector('.label').textContent = text;
  el.title = text;
  controls.refresh();
}

function notice(text) {
  $('notice').textContent = text || '';
  $('notice').hidden = !text;
}

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

/** Asks before something that ends or removes a session. Resolves to true for yes. */
function confirmAction({ title, text, action }) {
  return new Promise((resolve) => {
    const dialog = $('confirm');
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-yes').textContent = action;
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true });
    dialog.showModal();
  });
}

function closeDialogs() {
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
}

// ---- sessions list --------------------------------------------------------

/** Rows are kept and updated in place, so an activity change under a finger does not swap the element being tapped. */
function renderList() {
  const list = $('sessions');
  const ordered = orderSessions([...state.sessions.values()]);
  const known = new Map([...list.children].map((li) => [li.dataset.id, li]));
  const rows = ordered.map((session) => {
    const signature = JSON.stringify([session.name, session.cwd, sessionState(session), stateLabel(session), sessionSummary(session),
      relativeTime(session.lastOutputAt || session.createdAt), session.provider.color, session.provider.monogram]);
    let li = known.get(session.id);
    if (!li) {
      li = document.createElement('li');
      li.dataset.id = session.id;
      li.append(rowButton(session));
    }
    if (li.dataset.signature !== signature) {
      li.dataset.signature = signature;
      li.className = `row ${sessionState(session)}`;
      fillRow(li.firstElementChild, session);
    }
    return li;
  });
  for (const [id, li] of known) if (!state.sessions.has(id)) li.remove();
  // append moves a row already in the list, so only the order changes.
  if (rows.some((li, index) => list.children[index] !== li)) list.append(...rows);
  $('empty').hidden = ordered.length > 0;
}

function rowButton(session) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'row-button';
  button.addEventListener('click', () => openTerminal(session.id));
  return button;
}

function fillRow(button, session) {
  const mark = document.createElement('span');
  mark.className = 'mark';
  mark.style.setProperty('--color', session.provider.color);
  mark.textContent = session.provider.monogram;
  mark.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.className = 'row-text';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = session.name;
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = [folderName(session.cwd), sessionSummary(session)].filter(Boolean).join(' · ');
  text.append(name, meta);
  const status = document.createElement('span');
  status.className = 'status';
  const chip = document.createElement('span');
  chip.className = 'chip';
  chip.textContent = stateLabel(session);
  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = relativeTime(session.lastOutputAt || session.createdAt);
  status.append(chip, when);
  button.replaceChildren(mark, text, status);
}

// ---- terminal ---------------------------------------------------------------

/**
 * The manager answers the program's terminal queries once for every session
 * (docs/api.md, "Terminal queries: clients must not answer"). Swallow them
 * here before xterm.js replies, as the full page does.
 */
function suppressQueryReplies(term) {
  const swallow = () => true;
  const csi = [
    { final: 'n' }, { prefix: '?', final: 'n' },
    { final: 'c' }, { prefix: '>', final: 'c' }, { prefix: '=', final: 'c' },
    { intermediates: '$', final: 'p' }, { prefix: '?', intermediates: '$', final: 'p' },
    { prefix: '>', final: 'q' },
  ];
  for (const id of csi) term.parser.registerCsiHandler(id, swallow);
  term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, swallow);
  for (const code of [4, 10, 11, 12]) term.parser.registerOscHandler(code, (data) => data.includes('?'));
}

class TerminalView {
  constructor(session) {
    this.id = session.id;
    this.run = session.startedAt;
    /** The size the manager has, kept while this view observes; Fit goes back to it. */
    this.observed = { cols: session.cols, rows: session.rows };
    this.fitting = false;
    this.sent = null;
    this.ready = false;
    this.disposed = false;
    this.retry = 0;
    this.ws = null;
    this.term = new window.Terminal({
      cols: session.cols, rows: session.rows, cursorBlink: false, scrollback: 5000, allowProposedApi: true,
      fontFamily: 'ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace', fontSize: state.fontSize, theme: TERMINAL_THEME,
    });
    this.fit = new window.FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    suppressQueryReplies(this.term);
    this.term.onData((data) => this.send({ type: 'input', data }));
    this.term.open($('term-host'));
    this.term.textarea?.addEventListener('focus', renderKeyboard);
    this.term.textarea?.addEventListener('blur', renderKeyboard);
    this.enableTouchScroll();
    this.resizeObserver = new ResizeObserver(() => this.refit());
    this.resizeObserver.observe($('term-host'));
    this.connect();
  }

  connect() {
    if (this.disposed || state.away || state.revoked) return;
    const previous = this.ws;
    this.ws = null;
    previous?.close();
    this.ready = false;
    controls.refresh();
    const ws = new WebSocket(wsUrl(`/sessions/${this.id}/terminal`));
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.retry = 0;
      this.sent = null;
      if (this.fitting) this.refit({ force: true });
    };
    ws.onmessage = (event) => { if (!this.disposed && this.ws === ws) this.onMessage(JSON.parse(event.data)); };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ready = false;
      controls.refresh();
      if (this.disposed || state.away || [4403, 4404, 4410].includes(event.code)) return;
      const delay = Math.min(5000, 300 * 2 ** this.retry++);
      setTimeout(() => { if (this.ws === ws) this.connect(); }, delay);
    };
  }

  onMessage(msg) {
    if (msg.type === 'snapshot') {
      this.run = msg.session.startedAt;
      this.observed = { cols: msg.cols, rows: msg.rows };
      this.term.reset();
      if (this.fitting) this.refit({ force: true });
      else this.term.resize(msg.cols, msg.rows);
      const ws = this.ws;
      this.term.write(msg.data, () => {
        if (this.disposed || this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        this.ready = msg.session.status === 'running';
        controls.refresh();
      });
    } else if (msg.type === 'data') {
      this.term.write(msg.data);
    } else if (msg.type === 'resize') {
      this.onResized(msg);
    } else if (msg.type === 'exit') {
      this.ready = false;
      controls.refresh();
      stopDictation();
      this.term.write(`\r\n\x1b[2m${exitLine(state.sessions.get(this.id), msg)}\x1b[0m\r\n`);
    } else if (msg.type === 'removed') {
      closeTerminal();
    }
  }

  /** Another client's size, or the echo of this view's own fit. The last client to resize wins, so Fit yields. */
  onResized({ cols, rows }) {
    if (this.fitting && this.sent && cols === this.sent.cols && rows === this.sent.rows) return;
    if (this.fitting) {
      this.fitting = false;
      this.sent = null;
      renderFit();
      toast('Another client resized the terminal; showing its size.');
    }
    this.observed = { cols, rows };
    this.term.resize(cols, rows);
  }

  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  setFitting(on) {
    if (this.fitting === on) return;
    this.fitting = on;
    if (on) this.refit({ force: true });
    else {
      this.sent = null;
      this.term.resize(this.observed.cols, this.observed.rows);
      this.send({ type: 'resize', cols: this.observed.cols, rows: this.observed.rows });
    }
    renderFit();
  }

  refit({ force = false } = {}) {
    if (!this.fitting || this.disposed) return;
    try { this.fit.fit(); } catch { return; }
    const { cols, rows } = this.term;
    if (!force && this.sent && cols === this.sent.cols && rows === this.sent.rows) return;
    this.sent = { cols, rows };
    this.send({ type: 'resize', cols, rows });
  }

  setFontSize(size) {
    this.term.options.fontSize = size;
    if (this.fitting) this.refit({ force: true });
  }

  /**
   * xterm.js scrolls only for the mouse wheel. A one-finger drag up or down
   * scrolls the terminal here; a sideways drag is left to the browser, which
   * pans a terminal wider than the phone. Full-screen programs and programs
   * that read the mouse get a wheel event, as on the full page.
   */
  enableTouchScroll() {
    const host = $('term-host');
    let last = null;
    let axis = null;
    let pending = 0;
    host.addEventListener('touchstart', (event) => {
      last = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
      axis = null;
      pending = 0;
    }, { passive: true });
    host.addEventListener('touchmove', (event) => {
      if (!last || event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!axis) {
        const dx = Math.abs(touch.clientX - last.x);
        const dy = Math.abs(touch.clientY - last.y);
        if (dx < 4 && dy < 4) return;
        axis = dx > dy ? 'x' : 'y';
      }
      if (axis === 'x' || !event.cancelable) return;
      event.preventDefault();
      const delta = last.y - touch.clientY;
      last = { x: touch.clientX, y: touch.clientY };
      if (this.term.buffer.active.type === 'alternate' || this.term.modes.mouseTrackingMode !== 'none') {
        const target = host.querySelector('.xterm-screen') || host;
        target.dispatchEvent(new WheelEvent('wheel', {
          deltaY: delta, deltaMode: WheelEvent.DOM_DELTA_PIXEL, clientX: touch.clientX, clientY: touch.clientY, bubbles: true, cancelable: true,
        }));
        return;
      }
      pending += delta;
      const lineHeight = host.querySelector('.xterm-rows')?.firstElementChild?.offsetHeight || 17;
      const lines = Math.trunc(pending / lineHeight);
      if (lines) {
        this.term.scrollLines(lines);
        pending -= lines * lineHeight;
      }
    }, { passive: false });
    const end = () => { last = null; axis = null; };
    host.addEventListener('touchend', end);
    host.addEventListener('touchcancel', end);
  }

  /** The page went to the background: drop the socket; the snapshot brings the screen back on return. */
  suspend() {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.ready = false;
    controls.refresh();
  }

  resume() {
    if (!this.ws) this.connect();
  }

  dispose() {
    this.disposed = true;
    this.resizeObserver.disconnect();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.term.dispose();
    $('term-host').replaceChildren();
  }
}

function openTerminal(id, { push = true } = {}) {
  const session = state.sessions.get(id);
  if (!session) return;
  if (state.terminal?.id !== id) {
    state.terminal?.dispose();
    state.terminal = new TerminalView(session);
  }
  $('list').hidden = true;
  $('terminal').hidden = false;
  if (push) history.pushState({ terminal: id }, '');
  syncTerminal();
  renderFit();
  renderKeyboard();
  renderDictate();
}

function closeTerminal() {
  if (!state.terminal) return;
  stopDictation();
  closeDialogs();
  state.terminal.dispose();
  state.terminal = null;
  $('terminal').hidden = true;
  if ($('auth').hidden) $('list').hidden = false;
  if (history.state?.terminal) history.back();
}

/** The open terminal's header and menu follow its session; a session that runs again gets a fresh screen. */
function syncTerminal() {
  const view = state.terminal;
  if (!view) return;
  const session = state.sessions.get(view.id);
  if (!session) return closeTerminal();
  $('terminal-name').textContent = session.name;
  $('terminal-state').textContent = stateLabel(session);
  $('terminal-state').dataset.state = sessionState(session);
  const running = session.status === 'running';
  $('stop').hidden = !running;
  $('interrupt').hidden = !running;
  $('remove').hidden = running;
  $('reattach').hidden = !session.multiplexer?.reattachable;
  if (running && session.startedAt !== view.run && view.ws?.readyState === WebSocket.OPEN) view.connect();
  renderFit();
  controls.refresh();
}

function renderFit() {
  const view = state.terminal;
  const session = view && state.sessions.get(view.id);
  const on = Boolean(view?.fitting);
  $('fit-toggle').setAttribute('aria-pressed', String(on));
  $('fit-toggle').textContent = on ? 'Stop fitting to this phone' : 'Fit to this phone';
  $('fit-badge').hidden = !on;
  const others = session ? Math.max(0, (session.attachedClients || 1) - 1) : 0;
  const size = view ? `${view.observed.cols}×${view.observed.rows}` : '';
  $('fit-help').textContent = on
    ? 'The terminal is sized for this phone, for every attached client. Stop fitting to go back to the size the manager had.'
    : others
      ? `Shown at the manager's size, ${size}. Fitting resizes it for the ${others === 1 ? 'other client' : `${others} other clients`} too.`
      : `Shown at the manager's size, ${size}. Fitting resizes it to this phone; drag sideways to see the rest.`;
}

function renderKeyboard() {
  const focused = Boolean(state.terminal && document.activeElement === state.terminal.term.textarea);
  $('keyboard').setAttribute('aria-pressed', String(focused));
  $('keyboard').setAttribute('aria-label', focused ? 'Hide keyboard' : 'Show keyboard');
}

/** The open terminal while input can reach its running process, else null. The same gate serves every key. */
function currentTarget() {
  const view = state.terminal;
  const session = view && state.sessions.get(view.id);
  if (!view || !session || session.status !== 'running' || !view.ready || view.disposed || session.startedAt !== view.run
    || view.ws?.readyState !== WebSocket.OPEN || state.away || state.revoked || $('terminal').hidden
    || document.visibilityState !== 'visible' || document.querySelector('dialog[open]')) return null;
  return { term: view.term, socket: view.ws, run: session.startedAt, name: session.name };
}

const controls = new TerminalControls({ element: $('terminal-controls'), panel: $('terminal'), getCurrent: currentTarget });
bindTerminalViewport($('terminal'), $('terminal-controls'));

/** A key of this page's own, beside the shared six: it keeps typing focus and the keyboard as they are. */
function bindKey(id, press) {
  const button = $(id);
  button.addEventListener('pointerdown', (event) => { if (event.isPrimary) event.preventDefault(); });
  button.addEventListener('click', () => {
    const target = currentTarget();
    if (target) press(target);
  });
}
bindKey('key-tab', ({ term }) => term.input('\t'));
$('keyboard').addEventListener('pointerdown', (event) => { if (event.isPrimary) event.preventDefault(); });
$('keyboard').addEventListener('click', () => {
  const term = state.terminal?.term;
  if (!term) return;
  if (document.activeElement === term.textarea) term.blur();
  else term.focus();
  renderKeyboard();
});

// ---- dictation ----------------------------------------------------------------

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let dictation = null;

function renderDictate() {
  $('dictate').hidden = !Recognition;
  $('dictate').setAttribute('aria-pressed', String(Boolean(dictation)));
}

/** Dictated words go to the terminal as typed text; Enter is never pressed for you. */
function startDictation() {
  const target = currentTarget();
  if (!target || dictation || !Recognition) return;
  const rec = new Recognition();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = false;
  rec.continuous = true;
  const current = { rec, term: target.term, first: true };
  dictation = current;
  rec.onresult = (event) => {
    if (dictation !== current) return;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (!result.isFinal) continue;
      const text = dictatedText(result[0]?.transcript, current.first);
      if (!text || currentTarget()?.term !== current.term) continue;
      current.term.input(text);
      current.first = false;
    }
  };
  rec.onend = () => { if (dictation === current) { dictation = null; renderDictate(); } };
  rec.onerror = () => { if (dictation === current) { dictation = null; renderDictate(); } };
  try { rec.start(); } catch { dictation = null; }
  renderDictate();
}

function stopDictation() {
  const current = dictation;
  dictation = null;
  try { current?.rec.stop(); } catch { /* already stopped */ }
  renderDictate();
}

$('dictate').addEventListener('click', () => { if (dictation) stopDictation(); else startDictation(); });

// ---- session menu -------------------------------------------------------------

$('menu-open').addEventListener('click', () => { renderFit(); $('menu').showModal(); });
$('menu-close').addEventListener('click', () => $('menu').close());
$('fit-toggle').addEventListener('click', () => {
  state.terminal?.setFitting(!state.terminal.fitting);
  $('menu').close();
});
for (const [id, direction] of [['font-smaller', -1], ['font-larger', 1]]) {
  $(id).addEventListener('click', () => {
    state.fontSize = stepFontSize(state.fontSize, direction);
    save(FONT_KEY, String(state.fontSize));
    state.terminal?.setFontSize(state.fontSize);
  });
}
$('interrupt').addEventListener('click', async () => {
  const view = state.terminal;
  $('menu').close();
  if (!view || !(await confirmAction({ title: 'Send Ctrl+C?', text: 'This interrupts whatever the tool is doing, as Ctrl+C in a terminal does.', action: 'Send Ctrl+C' }))) return;
  if (state.terminal === view) view.send({ type: 'input', data: '\x03' });
});
$('stop').addEventListener('click', async () => {
  const view = state.terminal;
  const session = view && state.sessions.get(view.id);
  $('menu').close();
  if (!session || !(await confirmAction({ title: `Stop ${session.name}?`, text: session.multiplexer ? `This closes the ${session.multiplexer.label} client; the session inside keeps running.` : 'This ends the tool. The screen stays until the session is removed.', action: 'Stop session' }))) return;
  try { await api('POST', `/sessions/${session.id}/stop`); } catch (err) { if (err instanceof AuthError) showAuth(err.message); else toast(err.message); }
});
$('remove').addEventListener('click', async () => {
  const view = state.terminal;
  const session = view && state.sessions.get(view.id);
  $('menu').close();
  if (!session || !(await confirmAction({ title: `Remove ${session.name}?`, text: 'The session and its screen leave the list on every device.', action: 'Remove session' }))) return;
  try {
    await api('DELETE', `/sessions/${session.id}`);
    state.sessions.delete(session.id);
    renderList();
    closeTerminal();
  } catch (err) { if (err instanceof AuthError) showAuth(err.message); else toast(err.message); }
});
$('reattach').addEventListener('click', async () => {
  const view = state.terminal;
  $('menu').close();
  if (!view) return;
  try {
    const { session } = await api('POST', `/sessions/${view.id}/reattach`);
    state.sessions.set(session.id, session);
    renderList();
    syncTerminal();
  } catch (err) { if (err instanceof AuthError) showAuth(err.message); else toast(err.message); }
});

// ---- new session ----------------------------------------------------------------

const newView = { providerId: null };

const providerChoices = () => state.providers.filter((provider) => provider.available);

function renderNewProviders() {
  const choices = providerChoices();
  if (!choices.some((provider) => provider.id === newView.providerId)) newView.providerId = choices[0]?.id ?? null;
  $('new-providers').replaceChildren(...choices.map((provider) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice-btn';
    button.dataset.id = provider.id;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(provider.id === newView.providerId));
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.style.setProperty('--color', provider.color);
    mark.textContent = provider.monogram;
    mark.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = provider.tool;
    button.append(mark, label);
    button.addEventListener('click', () => { newView.providerId = provider.id; renderNewProviders(); });
    return button;
  }));
  $('new-none').hidden = choices.length > 0;
  renderNewOptions();
}

function fillSelect(select, options, wanted) {
  const keep = options.some((option) => option.id === wanted) ? wanted : options[0]?.id;
  select.replaceChildren(...options.map((option) => {
    const el = document.createElement('option');
    el.value = option.id;
    el.textContent = option.label;
    el.selected = option.id === keep;
    return el;
  }));
}

function renderNewOptions() {
  const provider = state.providers.find((candidate) => candidate.id === newView.providerId);
  const accounts = provider?.accounts ?? [];
  $('new-account-row').hidden = accounts.length < 2;
  fillSelect($('new-account'), accounts, $('new-account').value);
  const shells = provider?.shells ?? [];
  $('new-shell-row').hidden = shells.length < 2;
  fillSelect($('new-shell'), shells, $('new-shell').value || provider?.defaultShell);
  $('new-existing').hidden = !(provider?.resumable && provider?.historySource);
  $('new-history').hidden = true;
  $('new-start').disabled = !provider;
}

function renderRecent() {
  const recent = readRecentFolders(load(RECENT_KEY));
  $('new-recent').replaceChildren(...recent.map((dir) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'btn';
    chip.textContent = folderName(dir);
    chip.title = dir;
    chip.addEventListener('click', () => { $('new-cwd').value = dir; });
    return chip;
  }));
}

function openNew() {
  $('new-error').hidden = true;
  $('new-cwd').value = load(CWD_KEY) || readRecentFolders(load(RECENT_KEY))[0] || '';
  renderRecent();
  renderNewProviders();
  $('new').showModal();
}

async function startSession({ resume = null, cwd = null } = {}) {
  const provider = state.providers.find((candidate) => candidate.id === newView.providerId);
  if (!provider) return;
  const folder = (cwd ?? $('new-cwd').value).trim();
  const body = { providerId: provider.id, cols: 120, rows: 32 };
  if (!$('new-account-row').hidden) body.account = $('new-account').value;
  if (!$('new-shell-row').hidden) body.shell = $('new-shell').value;
  if (folder) body.cwd = folder;
  if (resume) body.resume = resume;
  $('new-start').disabled = true;
  $('new-error').hidden = true;
  try {
    const { session } = await api('POST', '/sessions', body);
    state.sessions.set(session.id, session);
    save(CWD_KEY, session.cwd);
    save(RECENT_KEY, JSON.stringify(rememberFolder(readRecentFolders(load(RECENT_KEY)), session.cwd, { caseless: state.platform === 'win32' })));
    $('new').close();
    renderList();
    openTerminal(session.id);
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    $('new-error').textContent = err.message;
    $('new-error').hidden = false;
  } finally {
    $('new-start').disabled = false;
  }
}

function historyNote(text) {
  const li = document.createElement('li');
  li.className = 'note';
  li.textContent = text;
  return li;
}

async function loadHistory() {
  const provider = state.providers.find((candidate) => candidate.id === newView.providerId);
  if (!provider) return;
  const cwd = $('new-cwd').value.trim();
  const query = new URLSearchParams({ limit: '20' });
  if (!$('new-account-row').hidden) query.set('account', $('new-account').value);
  if (cwd) query.set('cwd', cwd);
  $('new-history').hidden = false;
  $('new-history').replaceChildren(historyNote('Loading…'));
  try {
    const { history } = await api('GET', `/providers/${provider.id}/history?${query}`);
    const rows = history.sessions.map((earlier) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      const title = document.createElement('span');
      title.textContent = earlier.title || earlier.id;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = [folderName(earlier.cwd), relativeTime(earlier.updatedAt)].filter(Boolean).join(' · ');
      button.append(title, meta);
      button.addEventListener('click', () => startSession({ resume: earlier.id, cwd: earlier.cwd || cwd }));
      li.append(button);
      return li;
    });
    $('new-history').replaceChildren(...(rows.length ? rows : [historyNote(history.error || (cwd ? 'No earlier sessions in this folder.' : 'No earlier sessions.'))]));
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    $('new-history').replaceChildren(historyNote(err.message));
  }
}

$('new-open').addEventListener('click', openNew);
$('new-cancel').addEventListener('click', () => $('new').close());
$('new-start').addEventListener('click', () => startSession());
$('new-existing').addEventListener('click', loadHistory);
$('new-cwd').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); startSession(); } });

// ---- folder browser ---------------------------------------------------------------

const folderView = { listing: null };

async function browse(target) {
  $('folder-status').textContent = 'Loading…';
  try {
    const listing = await api('GET', `/folders?path=${encodeURIComponent(target ?? '')}`);
    folderView.listing = listing;
    $('folder-current').textContent = listing.path;
    $('folder-up').disabled = !listing.parent;
    renderFolders();
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    $('folder-status').textContent = err.message;
  }
}

function renderFolders() {
  const listing = folderView.listing;
  if (!listing) return;
  const entries = listing.entries.filter((entry) => $('folder-hidden').checked || !entry.hidden);
  $('folder-list').replaceChildren(...entries.map((entry) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = entry.name;
    button.addEventListener('click', () => browse(entry.path));
    li.append(button);
    return li;
  }));
  $('folder-status').textContent = listing.note || (entries.length ? (listing.truncated ? 'Showing the first folders only.' : '') : 'No folders here.');
}

$('new-browse').addEventListener('click', () => { $('folders').showModal(); browse($('new-cwd').value.trim()); });
$('folder-up').addEventListener('click', () => { if (folderView.listing?.parent) browse(folderView.listing.parent); });
$('folder-home').addEventListener('click', () => browse(''));
$('folder-hidden').addEventListener('change', renderFolders);
$('folder-use').addEventListener('click', () => {
  if (folderView.listing) $('new-cwd').value = folderView.listing.path;
  $('folders').close();
});
$('folder-cancel').addEventListener('click', () => $('folders').close());
$('confirm-yes').addEventListener('click', () => $('confirm').close('yes'));
$('confirm-no').addEventListener('click', () => $('confirm').close('no'));

// ---- events -------------------------------------------------------------------------

function connectEvents() {
  if (state.away || state.revoked || !state.token) return;
  const ws = new WebSocket(wsUrl('/events'));
  state.events = ws;
  ws.onopen = () => {
    if (state.events !== ws) return;
    state.retry = 0;
    setConnection('ok', 'Connected');
  };
  ws.onmessage = (event) => {
    if (state.events !== ws) return;
    const msg = JSON.parse(event.data);
    if (msg.type === 'hello') {
      state.connected = true;
      state.stopping = false;
      state.restarting = false;
      state.platform = msg.platform || null;
      notice(null);
      setConnection('ok', `Connected · Agent Guild ${msg.version}`);
      state.sessions = new Map(msg.sessions.map((session) => [session.id, session]));
      renderList();
      if (state.terminal && !state.sessions.has(state.terminal.id)) closeTerminal();
      else syncTerminal();
    } else if (msg.type === 'session.created' || msg.type === 'session.updated') {
      state.sessions.set(msg.session.id, msg.session);
      renderList();
      syncTerminal();
    } else if (msg.type === 'session.removed') {
      state.sessions.delete(msg.sessionId);
      renderList();
      if (state.terminal?.id === msg.sessionId) closeTerminal();
    } else if (msg.type === 'providers.updated') {
      state.providers = msg.providers;
      renderNewProviders();
    } else if (msg.type === 'manager.stopping') {
      state.stopping = true;
      state.restarting = msg.restart === true;
      notice(msg.restart ? 'The manager is restarting. This page reconnects by itself.' : 'The manager is stopping; its sessions are ending.');
    } else if (msg.type === 'manager.stopped') {
      state.restarting = msg.restart === true;
      notice(msg.restart ? 'Waiting for the new manager…' : 'The manager stopped. Start it again on its computer with "agent-guild open"; this page reconnects by itself.');
    }
  };
  ws.onclose = (event) => {
    if (state.events !== ws) return;
    state.connected = false;
    if (event.code === 4403) {
      state.revoked = true;
      setConnection('down', 'Remote access changed');
      notice('Remote access changed on the manager. Your terminals keep running. Open an enabled address to reconnect.');
      state.terminal?.suspend();
      return;
    }
    setConnection('down', state.stopping ? (state.restarting ? 'Waiting for the manager…' : 'Manager stopped') : 'Reconnecting…');
    const delay = Math.min(5000, 500 * 2 ** state.retry++);
    setTimeout(async () => {
      if (state.away || state.events !== ws) return;
      try { await loadProviders(); } catch (err) { if (err instanceof AuthError) return showAuth(err.message); }
      if (!state.away && state.events === ws) connectEvents();
    }, delay);
  };
}

/** The page is leaving the screen: drop both sockets so the manager sees the phone go, and reconnect on return. */
function suspendAll() {
  if (state.away) return;
  state.away = true;
  const ws = state.events;
  state.events = null;
  ws?.close();
  state.terminal?.suspend();
  stopDictation();
}

function resumeAll() {
  if (!state.away) return;
  state.away = false;
  if (!state.token || state.revoked || !$('auth').hidden) return;
  connectEvents();
  state.terminal?.resume();
}

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') suspendAll(); else resumeAll(); });
addEventListener('pagehide', suspendAll);
addEventListener('pageshow', (event) => { if (event.persisted) resumeAll(); });
addEventListener('popstate', (event) => {
  if (event.state?.terminal && state.sessions.has(event.state.terminal)) openTerminal(event.state.terminal, { push: false });
  else if (state.terminal) {
    // The entry is already gone, so close without stepping back again.
    const view = state.terminal;
    state.terminal = null;
    stopDictation();
    closeDialogs();
    view.dispose();
    $('terminal').hidden = true;
    if ($('auth').hidden) $('list').hidden = false;
  }
});
$('back').addEventListener('click', closeTerminal);
setInterval(() => { if (!$('list').hidden && document.visibilityState === 'visible') renderList(); }, RELATIVE_TIME_MS);

// ---- auth and boot -------------------------------------------------------------------

async function loadProviders() {
  const { providers } = await api('GET', '/providers');
  state.providers = providers;
  renderNewProviders();
}

function showAuth(message = '') {
  closeTerminal();
  closeDialogs();
  const ws = state.events;
  state.events = null;
  ws?.close();
  state.connected = false;
  $('list').hidden = true;
  $('auth').hidden = false;
  $('auth-error').textContent = message;
  $('more').hidden = true;
  setConnection('down', 'Not connected');
}

async function boot() {
  $('auth').hidden = true;
  $('auth-error').textContent = '';
  state.revoked = false;
  try {
    await loadProviders();
  } catch (err) {
    if (err instanceof AuthError) {
      save(TOKEN_KEY, null);
      state.token = null;
      return showAuth(err.message);
    }
    setConnection('down', 'Session manager not reachable');
  }
  save(TOKEN_KEY, state.token);
  $('list').hidden = Boolean(state.terminal);
  $('more').hidden = false;
  renderList();
  connectEvents();
}

$('auth-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const token = tokenFromInput($('auth-token').value);
  if (!token) {
    $('auth-error').textContent = 'Paste the sign-in link, or the access token from "agent-guild url".';
    return;
  }
  $('auth-token').value = '';
  state.token = token;
  boot();
});
$('sign-out').addEventListener('click', () => {
  $('more-menu').hidePopover?.();
  save(TOKEN_KEY, null);
  state.token = null;
  showAuth();
});

function renderTheme() {
  $('theme-toggle').textContent = document.documentElement.dataset.theme === 'dark' ? 'Light mode' : 'Dark mode';
}
$('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  save(THEME_KEY, next);
  renderTheme();
  $('more-menu').hidePopover?.();
});
renderTheme();
renderDictate();

// The token arrives in the sign-in link's hash. Keep it out of the address bar and history.
const fromHash = tokenFromHash(location.hash);
history.replaceState({ list: true }, '', location.pathname + location.search);
state.token = fromHash || load(TOKEN_KEY);
if (state.token) boot();
else showAuth();
