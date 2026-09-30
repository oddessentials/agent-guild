// Agent Guild web page. A thin client of the session manager's local API:
// it never owns sessions, so closing the page leaves them running.

const TOKEN_KEY = 'agentGuild.token';
const CWD_KEY = 'agentGuild.cwd';
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const $ = (id) => document.getElementById(id);
const state = {
  token: null,
  providers: [],
  usage: new Map(),
  sessions: new Map(),
  views: new Map(),
  activeId: null,
  eventsSocket: null,
  eventsRetry: 0,
};

// ---- storage (may be unavailable, e.g. blocked site data) -----------------

function load(key) { try { return localStorage.getItem(key); } catch { return null; } }
function save(key, value) { try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* ignore */ } }

// ---- helpers --------------------------------------------------------------

let toastTimer;
function toast(message, ms = 5000) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function setConnection(kind, label) {
  const el = $('connection');
  el.className = `connection ${kind}`;
  el.querySelector('.label').textContent = label;
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

// Helper-agent art (web/art/familiars); picked by name so an agent keeps its familiar.
const FAMILIARS = ['flame', 'leaf', 'night', 'aether'];

function renderAgents(container, agents) {
  container.replaceChildren(...agents.map((agent) => {
    const el = document.createElement('span');
    el.className = `agent ${agent.status}`;
    el.style.setProperty('--c', `hsl(${hueFor(agent.name)} 65% 50%)`);
    el.dataset.familiar = FAMILIARS[hueFor(agent.name) % FAMILIARS.length];
    el.textContent = (agent.name || '?').charAt(0).toUpperCase();
    const detail = agent.detail ? ` — ${agent.detail}` : '';
    el.title = `${agent.name} (${agent.status})${detail}`;
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', el.title);
    return el;
  }));
}

// ---- API ------------------------------------------------------------------

class AuthError extends Error {}

async function api(method, path, body) {
  const res = await fetch(`/api/v1${path}`, {
    method,
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

function wsUrl(path) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/api/v1${path}?token=${encodeURIComponent(state.token)}`;
}

// ---- providers ------------------------------------------------------------

function renderProviders() {
  const list = $('providers');
  const tpl = $('provider-template');
  list.replaceChildren(...state.providers.map((provider) => {
    const node = tpl.content.firstElementChild.cloneNode(true);
    paintProviderIcon(node.querySelector('.provider-icon'), provider);
    node.querySelector('.vendor').textContent = provider.vendor;
    node.querySelector('.tool').textContent = provider.tool;
    node.querySelector('.state').textContent = providerState(provider);
    node.querySelector('.state').classList.toggle('update-available', provider.updateAvailable);
    node.dataset.id = provider.id;
    node.classList.toggle('unavailable', !provider.available);
    node.setAttribute('aria-label', `${provider.vendor} ${provider.tool}, ${provider.available ? 'ready' : 'not installed'}`);
    const start = node.querySelector('.new');
    const existing = node.querySelector('.existing');
    const hint = node.querySelector('.hint');
    start.hidden = !provider.available;
    start.title = `Start a new ${provider.tool} session`;
    start.addEventListener('click', () => startSession(provider, node));
    existing.hidden = !provider.available || !provider.resumable;
    existing.title = `Resume one of ${provider.tool}'s own sessions by its id`;
    existing.addEventListener('click', () => resumeSession(provider, node));
    const install = node.querySelector('.install');
    install.hidden = provider.available || !provider.installable;
    install.title = `Run "npm install -g ${provider.package}@latest" in a session`;
    install.addEventListener('click', () => installProvider(provider, node));
    const update = node.querySelector('.update');
    update.hidden = !(provider.available && provider.installable && provider.updateAvailable);
    update.textContent = `Update to ${provider.latestVersion}`;
    update.title = install.title;
    update.addEventListener('click', () => installProvider(provider, node));
    hint.hidden = provider.available || provider.installable;
    hint.textContent = provider.install || `${provider.command} was not found on PATH.`;
    renderConsoleLinks(node, provider);
    renderUsage(node, provider);
    return node;
  }));
}

function renderConsoleLinks(card, provider) {
  let any = false;
  for (const [selector, url, what] of [['.usage-link', provider.usageUrl, 'usage'], ['.billing-link', provider.billingUrl, 'billing']]) {
    const link = card.querySelector(selector);
    const href = httpsHref(url);
    link.hidden = !href;
    if (!href) { link.removeAttribute('href'); continue; }
    any = true;
    link.href = href;
    link.title = `${provider.vendor} ${what} console: ${href}`;
    link.setAttribute('aria-label', `${provider.vendor} ${what} console (opens in a new tab)`);
  }
  card.querySelector('.provider-links').hidden = !any;
}

function renderTier(card, provider, usage) {
  const tier = card.querySelector('.tier');
  const label = provider.available && usage?.plan ? planLabel(usage.plan) : '';
  tier.hidden = !label;
  tier.textContent = label;
  tier.title = label ? `${provider.vendor} subscription: ${label}` : '';
}

function renderUsage(card, provider) {
  const host = card.querySelector('.usage');
  const usage = state.usage.get(provider.id);
  renderTier(card, provider, provider.usageSource ? usage : null);
  if (!provider.available || !provider.usageSource || !usage) return host.replaceChildren();
  if (usage.error || usage.windows.length === 0) {
    const note = document.createElement('div');
    note.className = 'usage-note';
    note.textContent = `Usage: ${usage.error || 'no limits reported'}`;
    note.title = note.textContent;
    return host.replaceChildren(note);
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
  }));
}

async function loadUsage() {
  let usage;
  try { ({ usage } = await api('GET', '/usage')); } catch { return; }
  state.usage = new Map(usage.map((u) => [u.providerId, u]));
  for (const card of $('providers').children) {
    const provider = state.providers.find((p) => p.id === card.dataset.id);
    if (provider) renderUsage(card, provider);
  }
}

function providerState(provider) {
  if (!provider.available) return 'Not installed';
  const parts = ['Ready'];
  if (provider.installedVersion) parts.push(`v${provider.installedVersion}`);
  if (provider.updateAvailable) parts.push(`${provider.latestVersion} available`);
  return parts.join(' · ');
}

async function installProvider(provider, card, { force = false } = {}) {
  card.classList.add('busy');
  try {
    const { session } = await api('POST', `/providers/${provider.id}/install`, { force });
    upsertSession(session);
    openPanel(session.id);
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    if (err.code === 'provider_in_use') {
      card.classList.remove('busy');
      const n = err.running;
      const what = `${n} ${provider.tool} session${n === 1 ? ' is' : 's are'} running`;
      if (confirm(`${what}. Updating ${provider.tool} while it runs can break ${n === 1 ? 'that session' : 'those sessions'}. Update anyway?`)) {
        return installProvider(provider, card, { force: true });
      }
      return;
    }
    toast(err.message, 8000);
  } finally {
    card.classList.remove('busy');
  }
}

async function startSession(provider, card, { resume } = {}) {
  const cwd = $('cwd').value.trim();
  save(CWD_KEY, cwd);
  card.classList.add('busy');
  try {
    const body = { providerId: provider.id, cwd: cwd || undefined, cols: 120, rows: 32, resume };
    const { session } = await api('POST', '/sessions', body);
    upsertSession(session);
    openPanel(session.id);
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    toast(err.message, 8000);
  } finally {
    card.classList.remove('busy');
  }
}

function resumeSession(provider, card) {
  const id = prompt(`${provider.tool} session id or name to resume`);
  if (id === null || !id.trim()) return;
  startSession(provider, card, { resume: id.trim() });
}

// ---- session cards --------------------------------------------------------

const cards = new Map();

const MODEL_SOURCES = { report: 'reported by the tool', screen: 'seen on the tool\'s screen', args: 'from the --model argument' };

function modelText(s) {
  return s.model ? s.model.displayName || s.model.name : '';
}

function modelTitle(s) {
  if (!s.model) return '';
  const id = s.model.displayName && s.model.displayName !== s.model.name ? ` (${s.model.name})` : '';
  return `Model ${modelText(s)}${id}, ${MODEL_SOURCES[s.model.source] || s.model.source}`;
}

function statusText(s) {
  if (s.status === 'exited') {
    if (s.signal) return `Exited (${s.signal})`;
    return s.exitCode === 0 || s.exitCode === null ? 'Exited' : `Exited (${s.exitCode})`;
  }
  return s.activity === 'active' ? 'Working' : 'Running';
}

function buildCard(session) {
  const node = $('session-template').content.firstElementChild.cloneNode(true);
  node.dataset.id = session.id;
  const open = () => openPanel(session.id);
  node.addEventListener('click', (e) => { if (!e.target.closest('button')) open(); });
  node.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === node) open(); });
  node.querySelector('.open').addEventListener('click', open);
  node.querySelector('.stop').addEventListener('click', () => stopSession(session.id));
  node.querySelector('.remove').addEventListener('click', () => removeSession(session.id));
  node.querySelector('.rename').addEventListener('click', () => renameSession(session.id));
  return node;
}

// Session length as a character level: one level per hour running, starting at 1.
function sessionLevel(s) {
  const hours = (Date.now() - Date.parse(s.createdAt)) / 3_600_000;
  return Number.isFinite(hours) ? Math.max(1, Math.floor(hours)) : 1;
}

function updateCard(node, s) {
  node.dataset.provider = s.provider.id;
  paintProviderIcon(node.querySelector('.provider-icon'), s.provider);
  const level = sessionLevel(s);
  const badge = node.querySelector('.level-badge');
  badge.textContent = level;
  badge.title = `Level ${level}`;
  node.querySelector('.name').textContent = s.name;
  const resumed = s.resume ? ` · resumed ${s.resume}` : '';
  node.querySelector('.meta').textContent = `${s.provider.vendor} · ${s.provider.tool} · started ${relativeTime(s.createdAt)}${resumed}`;
  const pill = node.querySelector('.status-pill');
  pill.textContent = statusText(s);
  pill.className = `status-pill ${s.status === 'exited' ? 'exited' : s.activity}`;
  const model = node.querySelector('.model-pill');
  model.hidden = !s.model;
  model.textContent = modelText(s);
  model.title = modelTitle(s);
  model.className = `model-pill ${s.model?.source || ''}`;
  const cwd = node.querySelector('.cwd-line');
  // The LRM keeps a leading "/" in place under the right-to-left truncation style.
  cwd.textContent = `\u200E${s.cwd}`;
  cwd.title = s.cwd;
  renderAgents(node.querySelector('.agents'), s.agents);
  node.classList.toggle('exited', s.status === 'exited');
  node.querySelector('.stop').hidden = s.status !== 'running';
  node.querySelector('.remove').hidden = s.status === 'running';
  const modelLabel = s.model ? `, model ${modelText(s)}` : '';
  node.setAttribute('aria-label', `${s.name}, ${s.provider.vendor}${modelLabel}, ${statusText(s)}, ${s.agents.length} agents`);
}

function renderSessions() {
  const grid = $('sessions');
  const sessions = [...state.sessions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const [id, node] of cards) {
    if (!state.sessions.has(id)) { node.remove(); cards.delete(id); }
  }
  sessions.forEach((s, index) => {
    let node = cards.get(s.id);
    if (!node) { node = buildCard(s); cards.set(s.id, node); }
    updateCard(node, s);
    // Move a card only when it is out of place: re-inserting a node drops
    // keyboard focus and can swallow a click that is in progress.
    if (grid.children[index] !== node) grid.insertBefore(node, grid.children[index] || null);
  });
  const running = sessions.filter((s) => s.status === 'running').length;
  $('session-count').textContent = sessions.length ? `· ${running} running` : '';
  $('empty').hidden = sessions.length > 0;
  if (state.activeId) updatePanel();
}

function upsertSession(session) {
  state.sessions.set(session.id, session);
  renderSessions();
}

function dropSession(id) {
  state.sessions.delete(id);
  const view = state.views.get(id);
  if (view) { view.dispose(); state.views.delete(id); }
  if (state.activeId === id) closePanel();
  renderSessions();
}

async function stopSession(id) {
  const s = state.sessions.get(id);
  if (!s || s.status !== 'running') return;
  if (!confirm(`Stop "${s.name}"? The ${s.provider.tool} process will be ended.`)) return;
  try { upsertSession((await api('POST', `/sessions/${id}/stop`)).session); } catch (err) { toast(err.message); }
}

async function removeSession(id) {
  const s = state.sessions.get(id);
  if (!s) return;
  if (s.status === 'running' && !confirm(`"${s.name}" is still running. End it and remove it?`)) return;
  try { await api('DELETE', `/sessions/${id}`); dropSession(id); } catch (err) { toast(err.message); }
}

async function renameSession(id) {
  const s = state.sessions.get(id);
  if (!s) return;
  const name = prompt('Session name', s.name);
  if (name === null || !name.trim()) return;
  try { upsertSession((await api('PATCH', `/sessions/${id}`, { name })).session); } catch (err) { toast(err.message); }
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

class TerminalView {
  constructor(sessionId) {
    this.id = sessionId;
    this.el = document.createElement('div');
    this.term = new window.Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
      macOptionIsMeta: true,
      theme: TERMINAL_THEME,
    });
    this.fit = new window.FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new window.WebLinksAddon.WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener,noreferrer')));
    this.term.attachCustomKeyEventHandler((e) => this.handleKey(e));
    suppressQueryReplies(this.term);
    this.term.onData((data) => this.send({ type: 'input', data }));
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
    if (this.disposed) return;
    const ws = new WebSocket(wsUrl(`/sessions/${this.id}/terminal`));
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.sent = { cols: 0, rows: 0 }; this.sendSize(); };
    ws.onmessage = (event) => this.onMessage(JSON.parse(event.data));
    ws.onclose = (event) => {
      if (this.disposed || event.code === 4404 || event.code === 4410) return;
      const delay = Math.min(5000, 300 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'snapshot':
        this.term.reset();
        this.term.resize(msg.cols, msg.rows);
        this.term.write(msg.data, () => { this.sent = { cols: 0, rows: 0 }; this.refit(); });
        break;
      case 'data':
        this.term.write(msg.data);
        break;
      case 'exit': {
        const how = msg.signal ? `signal ${msg.signal}` : `code ${msg.exitCode ?? 0}`;
        this.term.write(`\r\n\x1b[2m[process exited with ${how}]\x1b[0m\r\n`);
        break;
      }
      default:
        break;
    }
  }

  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  sendSize() {
    const { cols, rows } = this.term;
    if (!this.el.isConnected || (cols === this.sent.cols && rows === this.sent.rows)) return;
    this.sent = { cols, rows };
    this.send({ type: 'resize', cols, rows });
  }

  mount(host) {
    host.replaceChildren(this.el);
    if (!this.opened) { this.term.open(this.el); this.opened = true; }
    this.resizeObserver.observe(host);
    this.refit();
    this.term.focus();
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
    this.resizeObserver.disconnect();
    this.ws?.close();
    this.term.dispose();
    this.el.remove();
  }
}

// ---- terminal panel -------------------------------------------------------

function openPanel(id) {
  if (!state.sessions.has(id)) return;
  if (state.activeId && state.activeId !== id) state.views.get(state.activeId)?.unmount();
  state.activeId = id;
  let view = state.views.get(id);
  if (!view) { view = new TerminalView(id); state.views.set(id, view); }
  $('terminal-panel').hidden = false;
  updatePanel();
  view.mount($('terminal-host'));
}

function closePanel() {
  if (state.activeId) state.views.get(state.activeId)?.unmount();
  state.activeId = null;
  $('terminal-panel').hidden = true;
}

function updatePanel() {
  const s = state.sessions.get(state.activeId);
  if (!s) return;
  paintProviderIcon($('panel-icon'), s.provider);
  $('panel-title').textContent = s.name;
  $('panel-sub').textContent = [s.provider.tool, modelText(s), statusText(s), s.cwd].filter(Boolean).join(' · ');
  $('panel-sub').title = modelTitle(s);
  renderAgents($('panel-agents'), s.agents);
  const stop = $('panel-stop');
  stop.textContent = s.status === 'running' ? 'Stop' : 'Remove';
}

// ---- events ---------------------------------------------------------------

function connectEvents() {
  const ws = new WebSocket(wsUrl('/events'));
  state.eventsSocket = ws;
  ws.onopen = () => {
    state.eventsRetry = 0;
    setConnection('ok', 'Connected to session manager');
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'hello') {
      state.sessions = new Map(msg.sessions.map((s) => [s.id, s]));
      for (const id of [...state.views.keys()]) if (!state.sessions.has(id)) dropSession(id);
      renderSessions();
    } else if (msg.type === 'session.created' || msg.type === 'session.updated') {
      upsertSession(msg.session);
    } else if (msg.type === 'session.removed') {
      dropSession(msg.sessionId);
    } else if (msg.type === 'providers.updated') {
      state.providers = msg.providers;
      renderProviders();
    }
  };
  ws.onclose = () => {
    setConnection('down', 'Session manager not reachable. Run "agent-guild open" to start it.');
    const delay = Math.min(5000, 500 * 2 ** state.eventsRetry++);
    setTimeout(async () => {
      try { await loadProviders(); } catch (err) { if (err instanceof AuthError) return showAuth(err.message); }
      connectEvents();
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

function showAuth(message = '') {
  $('app').hidden = true;
  $('terminal-panel').hidden = true;
  $('auth').hidden = false;
  $('auth-error').textContent = message;
  setConnection('down', 'Not connected');
}

async function boot() {
  $('app').hidden = true;
  $('auth').hidden = true;
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
  connectEvents();
  loadUsage();
  clearInterval(usageTimer);
  usageTimer = setInterval(loadUsage, 60000);
}

$('auth-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const token = $('auth-token').value.trim();
  if (!token) return;
  state.token = token;
  boot();
});
$('panel-close').addEventListener('click', closePanel);
$('panel-stop').addEventListener('click', () => {
  const s = state.sessions.get(state.activeId);
  if (!s) return;
  if (s.status === 'running') stopSession(s.id);
  else removeSession(s.id);
});
$('cwd').value = load(CWD_KEY) || '';
setInterval(renderSessions, 30000);

state.token = readTokenFromHash() || load(TOKEN_KEY);
boot();
