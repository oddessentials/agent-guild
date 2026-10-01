// Agent Guild web page. A thin client of the session manager's local API:
// it never owns sessions, so closing the page leaves them running.

const TOKEN_KEY = 'agentGuild.token';
const CWD_KEY = 'agentGuild.cwd';
const ACCOUNTS_KEY = 'agentGuild.accounts';
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
  /** True from a shutdown request until the manager is reachable again. */
  stopping: false,
  /** After a stop: how many session processes did not confirm exiting, or null if the manager never said. */
  stopRemaining: null,
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
  // The manager can only be stopped while the page can reach it.
  $('stop-manager').hidden = kind !== 'ok';
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

function storedAccounts() {
  try { return JSON.parse(load(ACCOUNTS_KEY)) || {}; } catch { return {}; }
}

function selectedAccount(provider) {
  const accounts = provider.accounts || [];
  const wanted = storedAccounts()[provider.id];
  return accounts.find((a) => a.id === wanted) || accounts[0] || { id: 'default', label: 'Default' };
}

function selectAccount(provider, id) {
  save(ACCOUNTS_KEY, JSON.stringify({ ...storedAccounts(), [provider.id]: id }));
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

function renderProviders() {
  const list = $('providers');
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
    existing.title = `Resume one of ${provider.tool}'s own sessions by its id`;
    existing.addEventListener('click', () => resumeSession(provider, node));
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
    renderCopies(node.querySelector('.copies'), provider);
    renderConsoleLinks(node, provider);
    renderAccounts(node, provider);
    renderUsage(node, provider);
    return node;
  }));
}

const openCopies = new Set();

function renderCopies(box, provider) {
  const installs = provider.installs || [];
  const warnings = provider.warnings || [];
  box.hidden = warnings.length === 0;
  if (box.hidden) return;
  const inUse = installs.some((i) => i.active);
  const older = installs.some((i) => i.newer);
  box.querySelector('summary').textContent = !inUse
    ? 'A copy exists off PATH'
    : `${installs.length} copies installed${older ? ' · older copy in use' : ''}`;
  box.open = openCopies.has(provider.id);
  box.addEventListener('toggle', () => (box.open ? openCopies.add(provider.id) : openCopies.delete(provider.id)));
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
    const name = [CHANNEL_LABELS[install.channel] || install.channel, install.version && `v${install.version}`, install.active ? 'in use' : 'not in use'];
    item.append(line('copy-name', name.filter(Boolean).join(' · ')), line('copy-path', install.path));
    if (install.removeCommand) {
      const code = document.createElement('code');
      code.textContent = install.removeCommand;
      item.append(line('copy-remove', 'To remove it: ', code));
    } else {
      item.append(line('copy-remove', 'No removal command is known for this copy.'));
    }
    return item;
  }));
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
  link.textContent = 'Docs ↗';
  hint.append(' ', link);
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
    : `Start a new ${provider.tool} session${provider.accounts?.length > 1 ? ` as the ${account.label} account` : ''}`;
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

const CHANNEL_LABELS = {
  npm: 'npm', native: 'native', brew: 'Homebrew', winget: 'WinGet', legacy: 'legacy install', unknown: 'unknown install',
};

function installNote(provider) {
  const last = provider.lastInstall;
  if (!last) return '';
  if (last.outcome === 'failed') {
    const what = last.kind === 'install' ? 'Install' : 'Update';
    return last.exitCode === null ? `${what} failed` : `${what} failed (exit ${last.exitCode})`;
  }
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
    const body = { providerId: provider.id, account: selectedAccount(provider).id, cwd: cwd || undefined, cols: 120, rows: 32, resume };
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

function accountLabel(s) {
  if (!s.account) return '';
  const provider = state.providers.find((p) => p.id === s.provider.id);
  return (provider?.accounts?.length ?? 0) > 1 || s.account.id !== 'default' ? s.account.label : '';
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
  badge.textContent = level;
  badge.title = `Level ${level}`;
  node.querySelector('.name').textContent = s.name;
  const resumed = s.resume ? ` · resumed ${s.resume}` : '';
  node.querySelector('.meta').textContent = [s.provider.vendor, s.provider.tool, accountLabel(s), `started ${relativeTime(s.createdAt)}${resumed}`].filter(Boolean).join(' · ');
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
  const accountName = accountLabel(s) ? `, ${accountLabel(s)} account` : '';
  node.setAttribute('aria-label', `${s.name}, ${s.provider.vendor}${accountName}${modelLabel}, ${statusText(s)}, ${s.agents.length} agents`);
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
  $('panel-sub').textContent = [s.provider.tool, accountLabel(s), modelText(s), statusText(s), s.cwd].filter(Boolean).join(' · ');
  $('panel-sub').title = modelTitle(s);
  renderAgents($('panel-agents'), s.agents);
  const stop = $('panel-stop');
  stop.textContent = s.status === 'running' ? 'Stop' : 'Remove';
}

// ---- stopping the manager -------------------------------------------------

/**
 * Stop the session manager. The manager refuses while sessions are running
 * unless told to force, so the warning is enforced for every client and the
 * count in the dialog is the manager's, not this page's possibly stale list.
 */
async function stopManager({ force = false } = {}) {
  const button = $('stop-manager');
  button.disabled = true;
  try {
    const { running } = await api('POST', '/shutdown', force ? { force: true } : undefined);
    enterStopping(running);
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    if (err.code === 'sessions_running') {
      const n = err.running;
      const what = `${n} session${n === 1 ? ' is' : 's are'} still running`;
      const them = n === 1 ? 'it' : 'all of them';
      if (confirm(`${what}. Stopping the session manager ends ${them}. Stop anyway?`)) {
        return stopManager({ force: true });
      }
      return;
    }
    toast(err.message, 8000);
  } finally {
    button.disabled = false;
  }
}

/** The manager is going down, by this page's request or another client's. */
function enterStopping(running = 0) {
  if (state.stopping) return;
  state.stopping = true;
  state.stopRemaining = null;
  closePanel();
  for (const view of state.views.values()) view.dispose();
  state.views.clear();
  state.sessions.clear();
  renderSessions();
  $('app').hidden = true;
  const n = Number(running) || 0;
  showStopped('stopping', 'Stopping the session manager…',
    n ? `Ending ${n} running session${n === 1 ? '' : 's'}. This can take a few seconds.` : 'This can take a few seconds.');
  setConnection('down', 'Stopping the session manager…');
}

function showStopped(phase, title, text) {
  const el = $('stopped');
  el.classList.toggle('stopping', phase === 'stopping');
  $('stopped-title').textContent = title;
  $('stopped-text').textContent = text;
  el.hidden = false;
}

/**
 * The manager has stopped. Only a manager.stopped event with nothing
 * remaining confirms that every process exited; a timeout, or a socket that
 * dropped without the event, must not be announced as a clean stop.
 */
function showManagerStopped() {
  setConnection('down', 'Session manager stopped');
  const n = state.stopRemaining;
  if (n === 0) return showStopped('stopped', 'Session manager stopped', 'Every session has ended.');
  if (n > 0) {
    return showStopped('stopped', 'Session manager stopped',
      `${n} session process${n === 1 ? '' : 'es'} did not confirm exiting in time and may still be running. Check your system's process list.`);
  }
  showStopped('stopped', 'Session manager stopped', 'The manager went away before confirming that every session had ended.');
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
      if (state.stopping) {
        // The manager is back after a stop; the page picks up where it was.
        state.stopping = false;
        $('stopped').hidden = true;
        $('app').hidden = false;
      }
      state.sessions = new Map(msg.sessions.map((s) => [s.id, s]));
      for (const id of [...state.views.keys()]) if (!state.sessions.has(id)) dropSession(id);
      renderSessions();
    } else if (msg.type === 'manager.stopping') {
      enterStopping(msg.running);
    } else if (msg.type === 'manager.stopped') {
      enterStopping();
      state.stopRemaining = Number(msg.remaining) || 0;
      showManagerStopped();
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
    if (state.stopping) {
      showManagerStopped();
    } else {
      setConnection('down', 'Session manager not reachable. Run "agent-guild open" to start it.');
    }
    // Keep trying: after a stop, a relaunched manager brings the page back by itself.
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
  $('stopped').hidden = true;
  state.stopping = false;
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
$('stop-manager').addEventListener('click', () => stopManager());
$('panel-stop').addEventListener('click', () => {
  const s = state.sessions.get(state.activeId);
  if (!s) return;
  if (s.status === 'running') stopSession(s.id);
  else removeSession(s.id);
});
$('cwd').value = load(CWD_KEY) || '';
setInterval(renderSessions, 30000);

// The terminal panel sits below the top bar, which wraps onto two rows on
// narrow screens; publish its height so the panel never covers its controls.
const topbar = document.querySelector('.topbar');
const publishTopbarHeight = () => document.documentElement.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`);
new ResizeObserver(publishTopbarHeight).observe(topbar);
publishTopbarHeight();

state.token = readTokenFromHash() || load(TOKEN_KEY);
boot();
