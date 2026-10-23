import { createReader } from './read-aloud.js';

const TOKEN_KEY = 'agentGuild.token';
const REFRESH_MS = 5000;
const SIGN_IN = 'Scan the code in Agent Guild on your computer: Settings, Meta glasses.';
const UPDATE = 'Update Agent Guild on this computer to use it on your glasses.';
const UNREACHABLE = 'Can’t reach Agent Guild. Trying again.';
const LOADING = 'Loading the answer…';

const $ = (id) => document.getElementById(id);
const rows = [...document.querySelectorAll('#list .row')];
const load = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
const save = (value) => { try { value === null ? localStorage.removeItem(TOKEN_KEY) : localStorage.setItem(TOKEN_KEY, value); } catch {} };

class SignedOut extends Error {}

let token = new URLSearchParams(location.hash.slice(1)).get('token');
if (token) save(token);
else token = load();
history.replaceState(null, '', location.pathname + location.search);

const state = { sessions: null, problem: '', selected: null, open: null, openName: '', reply: null, timer: null, run: 0 };
const reader = window.speechSynthesis && window.SpeechSynthesisUtterance
  ? createReader({ synth: window.speechSynthesis, Utterance: window.SpeechSynthesisUtterance, changed: () => renderDetail() })
  : null;

async function get(path) {
  const res = await fetch(`/api/v1${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (res.status === 401) throw new SignedOut();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function signOut() {
  token = null;
  save(null);
  state.run++;
  clearTimeout(state.timer);
  state.sessions = null;
  state.problem = SIGN_IN;
  showList();
}

async function refresh() {
  const run = ++state.run;
  clearTimeout(state.timer);
  try {
    const { sessions } = await get('/sessions');
    if (run !== state.run) return;
    state.sessions = sessions;
    state.problem = sessions.some((s) => typeof s.label !== 'string') ? UPDATE : '';
  } catch (error) {
    if (run !== state.run) return;
    if (error instanceof SignedOut) return signOut();
    state.sessions = null;
    state.problem = UNREACHABLE;
  }
  renderList();
  renderDetail();
  loadReply();
  state.timer = setTimeout(refresh, REFRESH_MS);
}

const listed = () => (state.problem ? [] : state.sessions || []);

function renderList() {
  const sessions = listed();
  const at = Math.max(0, sessions.findIndex((s) => s.id === state.selected));
  state.selected = sessions[at]?.id ?? null;
  const start = Math.floor(at / rows.length) * rows.length;
  rows.forEach((row, i) => {
    const session = sessions[start + i];
    row.hidden = !session;
    row.dataset.id = session?.id ?? '';
    row.querySelector('.name').textContent = session?.name ?? '';
    row.querySelector('.label').textContent = session?.label ?? '';
  });
  $('count').textContent = sessions.length > rows.length ? `${at + 1} of ${sessions.length}` : '';
  $('list-note').textContent = state.problem || (!state.sessions ? 'Connecting…' : sessions.length ? '' : 'No active sessions');
  const row = rows[at - start];
  if (!$('list').hidden && state.selected && document.activeElement !== row) row.focus();
}

function move(step) {
  const sessions = listed();
  const at = sessions.findIndex((s) => s.id === state.selected);
  if (at < 0) return;
  state.selected = sessions[Math.min(sessions.length - 1, Math.max(0, at + step))].id;
  renderList();
}

function renderDetail() {
  if (!state.open) return;
  const session = state.sessions?.find((s) => s.id === state.open);
  $('detail-name').textContent = session?.name ?? state.openName;
  $('detail-label').textContent = state.problem || (session ? session.label : 'No longer listed');
  $('listen').textContent = reader?.session === state.open ? 'Stop' : 'Listen';
}

function note(text) {
  $('detail-note').textContent = text;
}

function loadReply() {
  const session = state.sessions?.find((s) => s.id === state.open);
  if (!session) return;
  const id = session.reply?.id ?? null;
  const key = `${session.id} ${session.startedAt} ${id}`;
  if (state.reply?.key === key) return;
  const entry = { key, spoken: id === null ? null : undefined };
  state.reply = entry;
  if (id === null) return;
  get(`/sessions/${encodeURIComponent(session.id)}/reply`).then(({ reply }) => {
    if (state.reply !== entry) return;
    entry.spoken = reply === null ? null : typeof reply.spoken === 'string' ? reply.spoken : false;
    if ($('detail-note').textContent === LOADING) note('');
  }).catch((error) => {
    if (error instanceof SignedOut) return signOut();
    if (state.reply === entry) state.reply = null;
  });
}

function showSession(id) {
  const session = state.sessions?.find((s) => s.id === id);
  if (!session) return false;
  reader?.stop();
  state.open = id;
  state.selected = id;
  state.openName = session.name;
  state.reply = null;
  $('list').hidden = true;
  $('detail').hidden = false;
  note('');
  renderDetail();
  loadReply();
  $('listen').focus();
  return true;
}

function openSession(id) {
  if (state.sessions?.some((s) => s.id === id)) {
    history.pushState({ session: id }, '');
    showSession(id);
  }
}

function showList() {
  reader?.stop();
  state.open = null;
  state.reply = null;
  $('detail').hidden = true;
  $('list').hidden = false;
  renderList();
}

function back() {
  if (history.state?.session) history.back();
  else showList();
}

function listen() {
  if (!reader) return note('This display can’t read aloud.');
  if (reader.session === state.open) return reader.stop();
  const reply = state.reply;
  if (!reply || reply.spoken === undefined) return note(LOADING);
  if (reply.spoken === null) return note('No answer to play yet.');
  if (reply.spoken === false) return note(UPDATE);
  note('');
  reader.speak(state.open, reply.spoken);
}

function activate(element) {
  if (rows.includes(element)) openSession(element.dataset.id);
  else if (element === $('listen')) listen();
  else if (element === $('back')) back();
}

for (const button of [...rows, $('listen'), $('back')]) button.addEventListener('click', () => activate(button));

document.addEventListener('keydown', (event) => {
  const onList = !$('list').hidden;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (onList) move(event.key === 'ArrowDown' ? 1 : -1);
    else (event.key === 'ArrowDown' ? $('back') : $('listen')).focus();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    activate(document.activeElement);
  } else if (!onList && (event.key === 'Escape' || event.key === 'Backspace')) {
    event.preventDefault();
    back();
  }
});

addEventListener('popstate', () => { if (!showSession(history.state?.session)) showList(); });

document.addEventListener('visibilitychange', () => {
  if (!token) return;
  if (document.visibilityState === 'visible') refresh();
  else {
    state.run++;
    clearTimeout(state.timer);
    reader?.stop();
  }
});

if (token) refresh();
else {
  state.problem = SIGN_IN;
  renderList();
}
