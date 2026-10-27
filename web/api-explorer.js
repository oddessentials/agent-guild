// docs/api.md as a page, with its read-only routes and sockets live. Unlinked: a developer opens /api.html.
// Everything the manager answers is shown as text, never as HTML, and the token is never shown.
import markdownit from './vendor/markdown-it.mjs';
import { endpoints, READS, SOCKETS } from './api-doc.js';

const TOKEN_KEY = 'agentGuild.token';
const MAX_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 2048;

const $ = (id) => document.getElementById(id);
const load = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
const save = (value) => { try { localStorage.setItem(TOKEN_KEY, value); } catch {} };

// The page's own sign-in, kept by the main page; a #token= link also works, and leaves the address at once.
let token = new URLSearchParams(location.hash.slice(1)).get('token');
if (token) {
  save(token);
  history.replaceState(null, '', location.pathname + location.search);
} else token = load();

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// GitHub's heading ids, so the doc's links between its sections work here too.
const slug = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');

function render(markdown) {
  const md = markdownit({ html: false });
  md.core.ruler.push('heading_ids', (state) => {
    state.tokens.forEach((t, i) => { if (t.type === 'heading_open') t.attrSet('id', slug(state.tokens[i + 1].content)); });
  });
  $('doc').innerHTML = md.render(markdown);
}

const fill = (path, values) => path.replace(/:([a-z]+)/gi, (_, name) => encodeURIComponent(values[name]));

function fields(entry) {
  const inputs = new Map();
  for (const name of [...entry.params, ...entry.query]) {
    const param = entry.params.includes(name);
    const input = el('input', { name, required: param, placeholder: param ? `:${name}` : name, autocomplete: 'off', spellcheck: false });
    if (name === 'id') input.setAttribute('list', 'session-ids');
    inputs.set(name, input);
  }
  return inputs;
}

function prettyJson(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function requestPanel(entry) {
  const inputs = fields(entry);
  const sent = el('p', { className: 'sent' });
  const status = el('p', { className: 'status' });
  const out = el('pre');
  const form = el('form', {}, ...[...inputs].map(([name, input]) => el('label', {}, name, input)), el('button', { type: 'submit' }, `Send GET`));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries([...inputs].map(([name, input]) => [name, input.value.trim()]));
    const search = new URLSearchParams(entry.query.filter((name) => values[name]).map((name) => [name, values[name]]));
    const url = `/api/v1${fill(entry.path, values)}${search.size ? `?${search}` : ''}`;
    sent.textContent = `GET ${url}  ·  Authorization: Bearer •••`;
    status.textContent = 'Waiting…';
    out.textContent = '';
    const started = performance.now();
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      const text = await res.text();
      status.textContent = `${res.status} ${res.statusText}  ·  ${Math.round(performance.now() - started)} ms`;
      out.textContent = prettyJson(text);
    } catch {
      status.textContent = 'No answer: Agent Guild may have stopped.';
    }
  });
  return el('div', { className: 'try' }, form, sent, status, out);
}

function socketPanel(path) {
  const inputs = fields({ params: [...path.matchAll(/:([a-z]+)/gi)].map(([, name]) => name), query: [] });
  const button = el('button', { type: 'submit' }, 'Connect');
  const status = el('p', { className: 'status' });
  const log = el('pre');
  const lines = [];
  let socket = null;
  const add = (text) => {
    lines.push(text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)} … (${text.length} characters)` : text);
    if (lines.length > MAX_MESSAGES) lines.shift();
    log.textContent = lines.join('\n');
  };
  const form = el('form', {}, ...[...inputs].map(([name, input]) => el('label', {}, name, input)), button);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (socket) return socket.close();
    const values = Object.fromEntries([...inputs].map(([name, input]) => [name, input.value.trim()]));
    const route = `/api/v1${fill(path, values)}`;
    lines.length = 0;
    log.textContent = '';
    // Listening only: nothing is ever sent, and a terminal without `page` cannot claim or resize.
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${route}?token=${encodeURIComponent(token)}`);
    status.textContent = `Connecting to ${route}…`;
    button.textContent = 'Disconnect';
    socket.onopen = () => { status.textContent = `Listening to ${route}`; };
    socket.onmessage = ({ data }) => add(typeof data === 'string' ? data : '(binary message)');
    socket.onclose = ({ code }) => {
      status.textContent = `Closed (${code})`;
      button.textContent = 'Connect';
      socket = null;
    };
  });
  return el('div', { className: 'try' }, form, status, log);
}

function addPanels(markdown) {
  const documented = new Map(endpoints(markdown).map((entry) => [`${entry.method} ${entry.path}`, entry]));
  for (const row of $('doc').querySelectorAll('tbody tr')) {
    const [method, route] = [...row.cells].map((cell) => cell.textContent.trim());
    const entry = documented.get(`${method} ${route?.split('?')[0]}`);
    if (!entry || entry.method !== 'GET') continue;
    if (!READS.has(entry.path)) {
      row.cells[row.cells.length - 1].append(el('span', { className: 'not-sent' }, 'Not sent from here: it can do more than read.'));
      continue;
    }
    const cell = el('td', { colSpan: row.cells.length }, requestPanel(entry));
    row.after(el('tr', {}, cell));
  }
  for (const heading of $('doc').querySelectorAll('h3')) {
    const path = heading.textContent.match(/^GET \/api\/v1(\/\S+)$/)?.[1];
    if (SOCKETS.has(path)) heading.after(socketPanel(path));
  }
}

async function listSessions() {
  try {
    const res = await fetch('/api/v1/sessions', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (res.status === 401) $('note').textContent = 'Agent Guild refused the sign-in this browser keeps. Open Agent Guild again, then reload.';
    if (!res.ok) return;
    const { sessions = [] } = await res.json();
    $('session-ids').replaceChildren(...sessions.map((s) => el('option', { value: s.id, label: `${s.name ?? ''} (${s.status})` })));
  } catch { /* each request says so itself */ }
}

const res = await fetch('./api.md', { cache: 'no-cache' }).catch(() => null);
if (!res?.ok) $('note').textContent = 'This Agent Guild does not serve its API doc.';
else {
  const markdown = await res.text();
  render(markdown);
  if (!token) $('note').textContent = 'Open Agent Guild in this browser once, then reload: the explorer uses its sign-in.';
  else {
    addPanels(markdown);
    listSessions();
  }
}
