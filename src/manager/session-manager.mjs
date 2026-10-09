// Owns every Session. The HTTP/WebSocket layer and any future front end talk
// to this object; nothing here knows about browsers.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Session, newId, clampDimension, cleanName } from './session.mjs';
import { prependPath } from './report-shims.mjs';
import { buildSpawnSpec, runSpec } from './command-resolver.mjs';
import { tmuxNewSession } from './shells.mjs';
import { HerdrAgents, herdrAgentReports, herdrSocket } from './herdr.mjs';
import { CHANNEL_LABELS } from './install-channels.mjs';
import { DockerSessions } from './docker-sessions.mjs';
import { SELF_PROVIDER } from './self-update.mjs';
import { GITHUB_PROVIDER, dropsFromCloneEnv, parseRepo } from './github.mjs';
import { pathIdentity } from './multiplexer-paths.mjs';

export const MAX_SESSIONS = 32;

// The hooks.json earlier versions copied into Codex CLI accounts; an untouched copy would run every hook twice.
const SEEDED_CODEX_HOOKS = '59d1cfb54cda5fd81add1edee7cf0cac56e4b2afec4c26ff207b675eeaaf70ce';

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

function isFolder(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

/**
 * Layer environment objects. On Windows, variable names are
 * case-insensitive, so a later "PATH" must replace an inherited "Path"
 * rather than sit beside it.
 */
export function mergeEnv(layers, platform = process.platform) {
  const out = {};
  const keyFor = new Map();
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer || {})) {
      if (value === undefined || value === null) continue;
      if (platform === 'win32') {
        const existing = keyFor.get(key.toUpperCase());
        if (existing !== undefined && existing !== key) delete out[existing];
        keyFor.set(key.toUpperCase(), key);
      }
      out[key] = String(value);
    }
  }
  return out;
}

export class SessionManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./providers.mjs').ProviderRegistry} opts.registry
   * @param {object} opts.baseEnv   environment the tools inherit
   * @param {() => string} opts.getApiUrl  base URL handed to tools for reporting
   * @param {object} [opts.sessionDefaults] passed through to Session
   * @param {string|null} [opts.shimDir]  folder with the agent-guild-report launchers, put first on PATH
   * @param {import('./self-update.mjs').SelfUpdate|null} [opts.selfUpdate]  the manager's own upgrade
   * @param {import('./github.mjs').GitHub|null} [opts.github]
   */
  constructor({ registry, baseEnv, getApiUrl, sessionDefaults = {}, shimDir = null, selfUpdate = null, github = null, sessionHooks = null, store = null }) {
    super();
    this.registry = registry;
    this.baseEnv = baseEnv;
    this.getApiUrl = getApiUrl;
    this.sessionDefaults = sessionDefaults;
    this.shimDir = shimDir;
    this.selfUpdate = selfUpdate;
    this.github = github;
    this.sessionHooks = sessionHooks;
    this.sessions = new Map();
    /** Removed sessions whose process has not exited yet. */
    this.exiting = new Set();
    /** True once shutdown has begun; no new session may start after that. */
    this.closing = false;
    this.installing = new Set();
    /** Session id → how a tmux or herdr card attaches again, and whether its multiplexer session is still there. */
    this.multiplexers = new Map();
    /** Session id → the watcher that shows a running herdr card the agents herdr sees. */
    this.watchers = new Map();
    /** Keeps the tmux and herdr cards across restarts: { load(), save(cards) }, or null. */
    this.store = store;
    this.restoring = false;
    this.pendingCards = new Map();
    this.multiplexerOperations = new Set();
    this.multiplexerStarts = new Map();
    this.pendingRestore = null;
    if (this.registry) this.registry.multiplexerState = (provider, id) => ({
      busy: this.multiplexerOperations.has(id),
      pendingCards: [...this.pendingCards.values()].filter((c) => c.provider === provider && c.shell === id).length,
    });
    this.registry?.on?.('updated', () => {
      this._restorePending().catch((err) => console.warn('[sessions] pending cards:', err.message));
    });
  }

  list() {
    return [...this.sessions.values()].map((s) => s.toJSON());
  }

  get(id) {
    const session = this.sessions.get(id);
    if (!session) throw httpError(404, `no session with id "${id}"`, 'not_found');
    return session;
  }

  resolveCwd(cwd) {
    if (cwd === undefined || cwd === null || String(cwd).trim() === '') return os.homedir();
    let dir = String(cwd).trim();
    if (dir === '~' || dir.startsWith('~/') || dir.startsWith('~\\')) dir = path.join(os.homedir(), dir.slice(1));
    dir = path.resolve(dir);
    let stat;
    try { stat = fs.statSync(dir); } catch { throw httpError(400, `working directory does not exist: ${dir}`, 'bad_cwd'); }
    if (!stat.isDirectory()) throw httpError(400, `working directory is not a folder: ${dir}`, 'bad_cwd');
    return dir;
  }

  async create({ providerId, cwd, cols, rows, name, args, resume, account, shell } = {}) {
    const provider = this.registry.get(String(providerId || ''));
    if (!provider) throw httpError(404, `unknown provider "${providerId}"`, 'unknown_provider');
    if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))) {
      throw httpError(400, 'args must be an array of strings', 'bad_args');
    }
    if (account !== undefined && account !== null && typeof account !== 'string') throw httpError(400, 'account must be a string', 'bad_account');
    if (shell !== undefined && shell !== null && typeof shell !== 'string') throw httpError(400, 'shell must be a string', 'bad_shell');
    const resumeId = cleanResumeId(resume);
    const workDir = this.resolveCwd(cwd);
    const signIn = this.registry.account(provider, account);
    const runShell = this.registry.shellFor(provider, shell);
    const hooks = this.sessionHooks ? await this.sessionHooks.launch(provider, { resume: resumeId, args: args || [] }) : { args: [], reporting: null };
    // Checked after the await, so an install that started meanwhile is seen.
    if (this.installing.has(provider.id) || this.installsRunningFor(provider.id) > 0) {
      throw httpError(409, `${provider.tool} is being installed, updated or removed; start it once that finishes`, 'install_in_progress');
    }
    this.prepareAccount(provider, signIn, { hooksSupplied: hooks.args.length > 0 });
    const sessionName = cleanName(name)
      || (provider.accounts.length > 1 ? `${provider.tool} · ${signIn.label}` : null)
      || (runShell && this.registry.shellsFor(provider).shells.length > 1 ? `${provider.tool} · ${runShell.label}` : null);
    const extraEnv = hooks.env ? { ...runShell?.env, ...hooks.env } : runShell?.env;
    const options = { provider, cwd: workDir, cols, rows, name: sessionName, resume: resumeId, account: signIn, reporting: hooks.reporting, extraEnv };
    if (runShell?.multiplexer) return this._withMultiplexerStart(provider.id, runShell.id, () => this._startMultiplexer(options, runShell, args || []));
    const spawnSpec = this.registry.spawnSpec(provider, args || [], resumeId, hooks.args, runShell);
    const session = this._spawn({ ...options, spawnSpec });
    // A session id Agent Guild chose is known before the tool reports it, so the card can resume it at once.
    if (hooks.toolSessionId) session.reportToolSession({ toolSessionId: hooks.toolSessionId }, 'launch');
    // Every Docker Agent session is tracked, with or without Agent Guild's own hook flags: hooks the user configured
    // report through the same route.
    if (provider.reporting === 'docker') session.docker = new DockerSessions(session, { mainId: hooks.toolSessionId ?? null });
    const model = modelFromArgs([...provider.args, ...(args || [])]);
    if (model) session.setModel({ name: model }, 'args');
    return session;
  }

  /**
   * A Shell session in tmux or herdr. Its client is the session's process;
   * the multiplexer's server outlives it and gives its own environment to
   * every session it starts later, outside Agent Guild too, so the client
   * never carries this session's identity. A tmux card gets a tmux session
   * of its own, made first with that identity, so tools in it report to the
   * card as they would in a shell. A herdr card shows the agents herdr sees.
   */
  async _startMultiplexer(options, shell, args) {
    const { provider, account } = options;
    const id = newId();
    const reportToken = crypto.randomBytes(16).toString('hex');
    // A name of its own, so the card can say how to reattach it.
    const muxName = `guild-${newId(3)}`;
    const mux = this._multiplexer({ provider, account, shell, id, reportToken, muxName });
    const spawnSpec = this.registry.spawnSpec(provider, shell.id === 'tmux' ? [] : args, options.resume, [], mux.named);
    if (shell.id === 'tmux') {
      this._assertCanSpawn();
      const own = this._sessionEnv({ id, reportToken, provider, account, extraEnv: shell.env });
      const env = Object.fromEntries(Object.entries(own).filter(([key]) => mux.dropEnv(key) || key.toUpperCase() === 'PATH'));
      const cols = clampDimension(options.cols, 120, 2, 1000);
      const rows = clampDimension(options.rows, 32, 1, 500);
      // Outside the try: a folder or argument tmux cannot take is the request's fault, refused before tmux runs.
      const input = tmuxNewSession({ name: muxName, cwd: options.cwd, cols, rows, env, args });
      try {
        await mux.run(['-u', 'start-server', ';', 'source-file', '-'], { cwd: options.cwd, input });
      } catch (err) {
        throw httpError(500, `tmux could not make a session: ${(err.stderr || err.message).trim()}`, 'spawn_failed');
      }
    }
    let session;
    try {
      session = this._spawn({
        ...options, id, reportToken, spawnSpec, dropEnv: mux.dropEnv,
        multiplexer: { label: shell.label, attach: shell.multiplexer.attach.replaceAll('{name}', muxName), reattachable: false },
      });
    } catch (err) {
      if (shell.id === 'tmux') mux.run(['kill-session', '-t', `=${muxName}`]).catch(() => {});
      throw err;
    }
    this._track(session, { spawnSpec, mux, shell, card: {
      id, reportToken, provider: provider.id, account: account.id, shell: shell.id,
      muxName, name: session.name, cwd: session.cwd, createdAt: session.createdAt,
      // Herdr's request arguments belong to its client and must survive rebinding.
      // Tmux's request arguments belong to the already-running inner session.
      ...(shell.id === 'herdr' ? { args: [...args] } : {}),
    } });
    this._watchHerdr(session);
    return session;
  }

  /** How to run a card's tmux or herdr client, and tell whether the multiplexer still has the card's session. */
  _multiplexer({ provider, account, shell, id, reportToken, muxName }) {
    const named = { ...shell, args: shell.args.map((arg) => arg.replaceAll('{name}', muxName)) };
    const dropEnv = (key) => key.startsWith('AGENT_GUILD_');
    const clientEnv = this._sessionEnv({ id, reportToken, provider, account, extraEnv: shell.env, dropEnv });
    const run = (args, extra = {}) => runSpec(buildSpawnSpec(shell.path, args, clientEnv, this.registry.platform), { env: clientEnv, ...extra });
    // tmux keeps the card's own session by name; a herdr card's session is herdr's, there while its server runs.
    const alive = shell.id === 'tmux'
      ? () => run(['has-session', '-t', `=${muxName}`]).then(() => true, () => false)
      : () => run(['session', 'list', '--json']).then(({ stdout }) => herdrSocket(JSON.parse(stdout), clientEnv, this.registry.platform) !== null, () => false);
    return { named, dropEnv, clientEnv, run, alive };
  }

  /** Keep a tmux or herdr card for Reattach, here and, through the store, across restarts. */
  _track(session, { spawnSpec, mux, shell, card }) {
    const installationKey = this.registry.multiplexers?.identityFor(this.registry.get(card.provider), shell.id, shell.path);
    const shellPath = shell.path;
    // Keep old stores readable. Newly known installations carry a stable key,
    // since an update can change a Cellar or Windows release realpath.
    card.shellPath = shellPath;
    if (installationKey) card.installationKey = installationKey;
    const tracked = { spawnSpec, alive: mux.alive, shellPath, checking: false, herdr: shell.id === 'herdr' ? { path: shell.path, env: mux.clientEnv } : null, card };
    this.multiplexers.set(session.id, tracked);
    this.pendingCards.delete(session.id);
    this._saveCards();
    session.on('exit', () => this._checkMultiplexer(session, tracked));
    session.on('changed', () => {
      if (card.name === session.name) return;
      card.name = session.name;
      this._saveCards();
    });
  }

  _saveCards() {
    // A stopping manager leaves the file as it is, for the next one to bring the cards back.
    if (!this.store || this.restoring || this.closing) return;
    try {
      this.store.save([...this.multiplexers.values()].map(({ card }) => card).concat([...this.pendingCards.values()]));
    } catch (err) {
      console.warn(`[sessions] could not save the tmux and herdr cards: ${err.message}`);
    }
  }

  /**
   * Bring back the tmux and herdr cards the previous manager had, closed and
   * ready to reattach, with their own ids and report tokens so whatever runs
   * inside reports to them again. A card whose session is gone stays gone.
   */
  async restore() {
    this.restoring = true;
    try {
      // All at once, so a multiplexer slow to answer holds up the start once, not once a card.
      await Promise.all((this.store?.load() ?? []).map((card) => this._withMultiplexerStart(card?.provider, card?.shell, () => this._restoreCard(card)).catch((err) => {
        if (['too_many_sessions', 'install_in_progress'].includes(err.code)) this.pendingCards.set(card.id, card);
        console.warn(`[sessions] did not bring back the card ${card?.name ?? card?.id}: ${err.message}`);
      })));
    } finally {
      this.restoring = false;
    }
    this._saveCards();
  }

  async _restoreCard(card) {
    if (typeof card?.id !== 'string' || !/^[a-f0-9]{1,32}$/.test(card.id) || this.sessions.has(card.id)) return;
    if (typeof card.reportToken !== 'string' || !/^[a-f0-9]{32}$/.test(card.reportToken)) return;
    if (typeof card.muxName !== 'string' || !/^guild-[0-9a-f]{6}$/.test(card.muxName)) return;
    const provider = this.registry.get(String(card.provider));
    if (!provider || !['tmux', 'herdr'].includes(card.shell)) return;
    if (card.shell === 'herdr' && card.args !== undefined && (!Array.isArray(card.args) || card.args.some((arg) => typeof arg !== 'string'))) return;
    const shells = this.registry.shellsFor(provider)?.shells || [];
    const shell = shells.find((s) => s.id === card.shell && s.multiplexer);
    if (!shell) {
      this.pendingCards.set(card.id, card);
      return;
    }
    if (this.multiplexerOperations.has(card.shell)) {
      this.pendingCards.set(card.id, card);
      return;
    }
    const account = this.registry.account(provider, card.account);
    const mux = this._multiplexer({ provider, account, shell, id: card.id, reportToken: card.reportToken, muxName: card.muxName });
    if (!(await mux.alive()) || this.closing) {
      if (!this.closing) this.pendingCards.delete(card.id);
      return;
    }
    const spawnSpec = this.registry.spawnSpec(provider, shell.id === 'herdr' ? card.args ?? [] : [], null, [], mux.named);
    const session = this._spawn({
      provider, spawnSpec: null, cwd: typeof card.cwd === 'string' ? card.cwd : os.homedir(), name: card.name, account,
      id: card.id, reportToken: card.reportToken, dropEnv: mux.dropEnv, extraEnv: shell.env,
      createdAt: typeof card.createdAt === 'string' && !Number.isNaN(Date.parse(card.createdAt)) ? card.createdAt : undefined,
      multiplexer: { label: shell.label, attach: shell.multiplexer.attach.replaceAll('{name}', card.muxName), reattachable: true },
    });
    this._track(session, { spawnSpec, mux, shell, card: { ...card, name: session.name, cwd: session.cwd, createdAt: session.createdAt } });
  }

  /** Attach a stopped tmux or herdr session's card to its multiplexer session again, keeping its id and report token. */
  async reattach(id) {
    const tracked = this.multiplexers.get(id);
    if (!tracked) return this._reattach(id);
    return this._withMultiplexerStart(tracked.card.provider, tracked.card.shell, () => this._reattach(id));
  }

  _rebindMultiplexer(mux) {
    const provider = this.registry.get(mux.card.provider);
    const shell = provider && this.registry.shellsFor(provider)?.shells.find((s) => s.id === mux.card.shell && s.multiplexer);
    if (!shell) return false;
    const fresh = this._multiplexer({ provider, account: this.registry.account(provider, mux.card.account), shell, id: mux.card.id, reportToken: mux.card.reportToken, muxName: mux.card.muxName });
    mux.spawnSpec = this.registry.spawnSpec(provider, shell.id === 'herdr' ? mux.card.args ?? [] : [], null, [], fresh.named);
    mux.alive = fresh.alive;
    mux.shellPath = shell.path;
    mux.card.shellPath = shell.path;
    const key = this.registry.multiplexers?.identityFor(provider, shell.id, shell.path);
    if (key) mux.card.installationKey = key;
    else delete mux.card.installationKey;
    if (mux.herdr) mux.herdr = { path: shell.path, env: fresh.clientEnv };
    this._saveCards();
    return true;
  }

  async _checkMultiplexer(session, tracked) {
    const sequence = tracked.checkSequence = (tracked.checkSequence || 0) + 1;
    tracked.checking = true;
    let alive = false;
    try {
      this._rebindMultiplexer(tracked);
      alive = await tracked.alive();
    } catch {}
    if (tracked.checkSequence !== sequence) return;
    session.multiplexer.reattachable = alive;
    tracked.checking = false;
    session._changed();
  }

  async _reattach(id) {
    const session = this.get(id);
    const mux = this.multiplexers.get(id);
    if (!mux) throw httpError(400, `${session.name} is not in tmux or herdr`, 'not_reattachable');
    if (this.closing) throw httpError(503, 'the session manager is stopping', 'manager_stopping');
    if (session.status === 'running') throw httpError(409, `${session.name} is still attached`, 'session_running');
    // As the page offers it: only once the manager has found, after the client closed or at a restart, that the multiplexer still has the session.
    if (!session.multiplexer.reattachable) throw httpError(409, `${session.multiplexer.label} no longer has the session ${session.name} ran in`, 'multiplexer_session_gone');
    // Refresh closures as well as the spawn spec: the previous executable
    // may have disappeared in a native or Homebrew update.
    if (!this._rebindMultiplexer(mux)) throw httpError(409, 'Install the multiplexer and refresh this page before reattaching.', 'shell_unavailable');
    const alive = await mux.alive();
    if (this.sessions.get(id) !== session || session.status === 'running') throw httpError(409, `${session.name} changed meanwhile`, 'session_running');
    if (!alive) {
      session.multiplexer.reattachable = false;
      session._changed();
      throw httpError(409, `${session.multiplexer.label} no longer has the session ${session.name} ran in`, 'multiplexer_session_gone');
    }
    try {
      // The client can run anywhere, and the card's folder may be gone by now.
      session.reattach(mux.spawnSpec, { cwd: isFolder(session.cwd) ? session.cwd : os.homedir() });
    } catch (err) {
      throw httpError(500, `could not attach to ${session.multiplexer.label}: ${err.message}`, 'spawn_failed');
    }
    session.multiplexer.reattachable = false;
    this._watchHerdr(session);
    return session;
  }

  /** While a herdr card runs, its agents are the ones herdr reports. */
  _watchHerdr(session) {
    const herdr = this.multiplexers.get(session.id)?.herdr;
    if (!herdr) return;
    this.watchers.get(session.id)?.stop();
    const watcher = new HerdrAgents({ herdr: herdr.path, env: herdr.env, platform: this.registry.platform, onAgents: (agents) => showHerdrAgents(session, agents) });
    this.watchers.set(session.id, watcher);
    // herdr's server may still be starting; each burst of output from the client tries again until connected.
    const poke = () => { if (session.status === 'running') watcher.poke(); };
    session.on('changed', poke);
    session.once('exit', () => {
      session.off('changed', poke);
      watcher.stop();
      if (this.watchers.get(session.id) === watcher) this.watchers.delete(session.id);
    });
  }

  prepareAccount(provider, account, { hooksSupplied = false } = {}) {
    if (!account.dir) return;
    try {
      fs.mkdirSync(account.dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw httpError(500, `could not prepare the ${account.label} account folder ${account.dir}: ${err.message}`, 'account_unavailable');
    }
    if (provider.reporting !== 'codex' || !hooksSupplied || !provider.hooks) return;
    const target = path.join(account.dir, ...provider.hooks.path.split('/'));
    try {
      if (crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') === SEEDED_CODEX_HOOKS) fs.unlinkSync(target);
    } catch { /* absent or unreadable: nothing of ours to remove */ }
  }

  /**
   * Refuses while sessions of that provider are running unless `force` is
   * set, because replacing a tool under a running process can break it.
   */
  async install(providerId, { force = false } = {}) {
    const { provider, guard } = this._installGuard(providerId, force, 'updating the tool now may break them');
    this.installing.add(provider.id);
    try {
      if (this.registry.installed(provider)) {
        const { spec, channel } = await this.registry.updateSpec(provider);
        guard();
        const name = `Update ${provider.tool} (${CHANNEL_LABELS[channel]})`;
        return this._spawn({ provider, spawnSpec: spec, cwd: os.homedir(), name, task: 'install', installKind: 'update' });
      }
      const spawnSpec = await this.registry.installSpec(provider);
      guard();
      return this._spawn({ provider, spawnSpec, cwd: os.homedir(), name: `Install ${provider.tool}`, task: 'install', installKind: 'install' });
    } finally {
      this.installing.delete(provider.id);
    }
  }

  uninstall(providerId, copyPath, { force = false } = {}) {
    if (typeof copyPath !== 'string' || !copyPath) throw httpError(400, 'path must name the copy to remove', 'bad_request');
    const { provider, guard } = this._installGuard(providerId, force, 'removing the tool now may break them');
    const { spec, channel } = this.registry.uninstallSpec(provider, copyPath);
    guard();
    const name = `Uninstall ${provider.tool} (${CHANNEL_LABELS[channel]})`;
    return this._spawn({ provider, spawnSpec: spec, cwd: os.homedir(), name, task: 'install', installKind: 'uninstall', installPath: copyPath });
  }

  _installGuard(providerId, force, risk) {
    const provider = this.registry.get(String(providerId || ''));
    if (!provider) throw httpError(404, `unknown provider "${providerId}"`, 'unknown_provider');
    if (this.closing) throw httpError(503, 'the session manager is stopping', 'manager_stopping');
    const guard = () => {
      const running = this.runningFor(provider.id);
      if (running > 0 && !force) {
        const err = httpError(409, `${running} ${provider.tool} session(s) are running; ${risk}`, 'provider_in_use');
        err.running = running;
        throw err;
      }
    };
    guard();
    if (this.installing.has(provider.id) || this.installsRunningFor(provider.id) > 0) {
      throw httpError(409, `${provider.tool} is already being installed, updated or removed`, 'install_in_progress');
    }
    return { provider, guard };
  }

  installsRunningFor(providerId) {
    let n = 0;
    for (const s of [...this.sessions.values(), ...this.exiting]) if (s.status === 'running' && s.task === 'install' && !s.multiplexerInstall && s.provider.id === providerId) n++;
    return n;
  }

  async _withMultiplexerStart(providerId, id, start) {
    // Multiple @shell providers can share the same executable.
    const key = id;
    if (this.multiplexerOperations.has(key)) throw httpError(409, `${id} is being installed, updated or removed; try again when it finishes.`, 'install_in_progress');
    this.multiplexerStarts.set(key, (this.multiplexerStarts.get(key) || 0) + 1);
    try { return await start(); }
    finally {
      const count = this.multiplexerStarts.get(key) - 1;
      if (count) this.multiplexerStarts.set(key, count);
      else this.multiplexerStarts.delete(key);
    }
  }

  dependentsOf(providerId, id, copy = null) {
    const platform = this.registry.platform;
    const same = (a, b) => pathIdentity(a, platform) === pathIdentity(b, platform);
    let running = 0;
    for (const [sessionId, tracked] of this.multiplexers) {
      if (tracked.card.shell !== id) continue;
      if (copy && tracked.card.installationKey && tracked.card.installationKey !== copy.key) continue;
      if (copy && !tracked.card.installationKey && tracked.shellPath
        && !same(tracked.shellPath, copy.resolvedPath)
        && !same(this.registry.multiplexers.fsx.realpath(tracked.shellPath), copy.realPath)) continue;
      const session = this.sessions.get(sessionId);
      if (session?.status === 'running' || session?.multiplexer?.reattachable || tracked.checking) running++;
    }
    const pending = [...this.pendingCards.values()].filter((c) => c.provider === providerId && c.shell === id).length;
    return { running, pending };
  }

  async manageMultiplexer(providerId, id, kind, { path: copyPath = null, force = false } = {}) {
    const provider = this.registry.get(providerId);
    if (!provider) throw httpError(404, 'Unknown provider', 'unknown_provider');
    this.registry.multiplexers.get(provider, id);
    if (!['install', 'update', 'uninstall'].includes(kind)) throw httpError(400, 'Unknown operation', 'bad_request');
    this._assertCanSpawn();
    const key = id;
    if (this.multiplexerOperations.has(key) || this.multiplexerStarts.has(key)) throw httpError(409, `${id} has another operation in progress. Try again shortly.`, 'install_in_progress');
    this.multiplexerOperations.add(key);
    this.registry.emit('updated');
    let started = false;
    try {
      const prepared = await this.registry.multiplexers.prepare(provider, id, kind, copyPath);
      if (id === 'herdr' && kind === 'uninstall') await this.registry.multiplexers.assertHerdrStopped(provider, prepared.copy, prepared.extraEnv);
      // Herdr supports updates with servers and panes running, including brew.
      // Uninstall's server check is never bypassed by force.
      if (id === 'tmux') {
        const { running, pending } = this.dependentsOf(providerId, id, prepared.copy);
        if (running && !force) throw Object.assign(httpError(409, `${running} tmux card(s) depend on this installation. Changing it may prevent reattachment.`, 'multiplexer_in_use'), { running, pending });
      }
      this._assertCanSpawn();
      const session = this._spawn({
        provider, spawnSpec: prepared.spec, extraEnv: prepared.extraEnv, cwd: os.homedir(),
        name: `${{ install: 'Install', update: 'Update', uninstall: 'Uninstall' }[kind]} ${id}`,
        task: 'install', multiplexerInstall: { id, kind },
      });
      started = true;
      // Keep the lock through refresh, and even if the installer card is removed.
      session.exited.then(async () => {
        try {
          await this.registry.multiplexers.finish(provider, id, kind, prepared.copy, session.exitCode);
          if (kind === 'update') {
            // A detach during replacement may have probed a vanished release.
            // Recheck closed cards once discovery has the new executable.
            await Promise.all([...this.multiplexers].map(([cardId, tracked]) => {
              const card = this.sessions.get(cardId);
              return tracked.card.shell === id && card?.status === 'exited'
                ? this._checkMultiplexer(card, tracked) : null;
            }));
          }
        }
        catch (err) { console.warn('[multiplexers] could not refresh:', err.message); }
        finally {
          this.multiplexerOperations.delete(key);
          this.registry.emit('updated');
          await this._restorePending();
        }
      }).catch((err) => console.warn('[multiplexers]', err.message));
      return session;
    } finally {
      if (!started) {
        this.multiplexerOperations.delete(key);
        this.registry.emit('updated');
      }
    }
  }

  _restorePending() {
    if (this.pendingRestore) {
      this.pendingRestoreAgain = true;
      return this.pendingRestore;
    }
    if (this.restoring || this.closing || !this.pendingCards.size) return Promise.resolve();
    this.pendingRestore = (async () => {
      const before = this.pendingCards.size;
      do {
        this.pendingRestoreAgain = false;
        for (const card of [...this.pendingCards.values()]) {
          if (this.closing) break;
          if (this.multiplexerOperations.has(card.shell)) continue;
          try { await this._withMultiplexerStart(card.provider, card.shell, () => this._restoreCard(card)); }
          catch (err) {
            // A capacity limit is temporary; never discard a recoverable card.
            if (!['too_many_sessions', 'install_in_progress'].includes(err.code)) this.pendingCards.delete(card.id);
          }
        }
      } while (this.pendingRestoreAgain && !this.closing);
      this._saveCards();
      if (before !== this.pendingCards.size) this.registry.emit?.('updated');
    })().finally(() => { this.pendingRestore = null; });
    return this.pendingRestore;
  }

  /**
   * Upgrade the manager itself: a visible session running npm. Sessions
   * keep running; the new version is used once the manager is restarted.
   */
  async upgrade() {
    if (!this.selfUpdate) throw httpError(400, 'this manager cannot upgrade itself', 'not_updatable');
    if (this.closing) throw httpError(503, 'the session manager is stopping', 'manager_stopping');
    const inProgress = () => httpError(409, 'Agent Guild is already being upgraded', 'upgrade_in_progress');
    if (this.selfUpdate.installing) throw inProgress();
    const { spec, version } = await this.selfUpdate.spec();
    if (this.selfUpdate.installing) throw inProgress();
    const session = this._spawn({
      provider: SELF_PROVIDER, description: SELF_PROVIDER, spawnSpec: spec,
      cwd: os.homedir(), name: `Upgrade Agent Guild to ${version}`, task: 'upgrade',
    });
    // The lock is held until the npm process has exited, not until the
    // session is removed: a removed session's process may still be writing
    // the package, and two installers must not touch it at once.
    this.selfUpdate.beginInstall();
    session.exited.then(() => this.selfUpdate.finishInstall({ exitCode: session.exitCode, version }));
    return session;
  }

  /** Clone a GitHub repository into a folder under `parent`, in a visible session. */
  clone({ account, repo, parent } = {}) {
    if (!this.github) throw httpError(400, 'this manager has no GitHub integration', 'github_unavailable');
    if (this.closing) throw httpError(503, 'the session manager is stopping', 'manager_stopping');
    if (parent === undefined || parent === null || String(parent).trim() === '') throw httpError(400, 'parent must name the folder to clone into', 'bad_cwd');
    const dir = this.resolveCwd(parent);
    const target = path.join(dir, parseRepo(repo).name);
    for (const s of this.sessions.values()) {
      if (s.status === 'running' && s.task === 'clone' && s.clone?.path === target) {
        throw httpError(409, `${s.clone.repo} is already being cloned into ${target}`, 'clone_in_progress');
      }
    }
    const spec = this.github.cloneSpec({ accountId: account, repo, parent: dir });
    return this._spawn({
      provider: GITHUB_PROVIDER, description: GITHUB_PROVIDER, spawnSpec: spec.spawnSpec, cwd: dir,
      name: `Clone ${spec.fullName}`, task: 'clone', extraEnv: spec.env, dropEnv: dropsFromCloneEnv,
      clone: { repo: spec.fullName, path: spec.target, accountId: spec.account.id },
    });
  }

  runningFor(providerId) {
    let n = 0;
    for (const s of [...this.sessions.values(), ...this.exiting]) if (s.status === 'running' && s.task === null && s.provider.id === providerId) n++;
    return n;
  }

  /**
   * Sessions whose process is still running, install sessions included,
   * except tmux and herdr ones: stopping the manager only detaches those,
   * and their cards come back.
   */
  runningCount() {
    let n = 0;
    for (const s of this.sessions.values()) if (s.status === 'running' && !s.multiplexer) n++;
    return n;
  }

  _assertCanSpawn() {
    if (this.closing) throw httpError(503, 'the session manager is stopping', 'manager_stopping');
    if (this.sessions.size >= MAX_SESSIONS) {
      throw httpError(429, `session limit reached (${MAX_SESSIONS}); remove finished sessions first`, 'too_many_sessions');
    }
  }

  /** The environment of a session's process. */
  _sessionEnv({ id, reportToken, provider, account = null, extraEnv = null, dropEnv = null }) {
    // The tool's hooks run `agent-guild-report` by name, so the launchers
    // go first on PATH, after any provider PATH override.
    let env = prependPath(mergeEnv([this.baseEnv, provider.env, account?.env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      AGENT_GUILD_SESSION_ID: id,
      AGENT_GUILD_PROVIDER: provider.id,
      AGENT_GUILD_REPORTING: provider.reporting || '',
      AGENT_GUILD_URL: this.getApiUrl(),
      AGENT_GUILD_REPORT_TOKEN: reportToken,
      AGENT_GUILD_NODE: process.execPath,
    }]), this.shimDir);
    // The tool runs in its own terminal, not in the terminal or multiplexer
    // the manager was started from: Claude Code would otherwise open
    // agent-team panes in that tmux window, outside the page, tools would
    // tune their output to a terminal program that is not there, and herdr
    // would refuse to start, taking itself to be nested in a herdr pane.
    for (const key of [
      'TMUX', 'TMUX_PANE', 'STY', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'ZELLIJ', 'ZELLIJ_SESSION_NAME', 'ZELLIJ_PANE_ID',
      'HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_SOCKET_PATH', 'HERDR_BIN_PATH',
    ]) delete env[key];
    if (dropEnv) for (const key of Object.keys(env)) if (dropEnv(key)) delete env[key];
    if (extraEnv) env = mergeEnv([env, extraEnv]);
    return env;
  }

  _spawn({
    provider, description = this.registry.describe(provider), spawnSpec, cwd, cols, rows, name, resume = null, task = null, installKind = null, installPath = null, account = null,
    extraEnv = null, dropEnv = null, clone = null, reporting = null, multiplexer = null,
    id = newId(), reportToken = crypto.randomBytes(16).toString('hex'), createdAt, multiplexerInstall = null,
  }) {
    this._assertCanSpawn();
    const env = this._sessionEnv({ id, reportToken, provider, account, extraEnv, dropEnv });

    let session;
    try {
      session = new Session({
        ...this.sessionDefaults,
        id,
        provider: description,
        spawnSpec,
        cwd,
        env,
        cols: clampDimension(cols, 120, 2, 1000),
        rows: clampDimension(rows, 32, 1, 500),
        name,
        reportToken,
        resume,
        task,
        account: account ? { id: account.id, label: account.label } : null,
        clone,
        reporting,
        multiplexer,
        createdAt,
      });
    } catch (err) {
      throw httpError(500, `could not start ${provider.tool}: ${err.message}`, 'spawn_failed');
    }

    session.on('changed', () => {
      if (this.sessions.has(id)) this.emit('event', { type: 'session.updated', session: session.toJSON() });
    });
    session.on('warning', (msg) => console.warn(`[session ${id}] ${msg}`));
    session.multiplexerInstall = multiplexerInstall;
    if (task === 'install' && !multiplexerInstall) {
      session.on('exit', () => {
        this.registry.finishInstall(provider.id, { exitCode: session.exitCode, kind: installKind, path: installPath }).catch(() => {});
      });
    }
    this.sessions.set(id, session);
    this.emit('event', { type: 'session.created', session: session.toJSON() });
    return session;
  }

  stop(id) {
    const session = this.get(id);
    session.kill();
    return session;
  }

  /** Remove a session from the list, ending its process if still running. */
  remove(id) {
    const session = this.get(id);
    this.sessions.delete(id);
    if (this.multiplexers.delete(id)) this._saveCards();
    this.watchers.get(id)?.stop();
    this.watchers.delete(id);
    session._broadcast({ type: 'removed' });
    if (session.status === 'running') {
      this.exiting.add(session);
      session.exited.then(() => this.exiting.delete(session));
    }
    session.dispose();
    this.emit('event', { type: 'session.removed', sessionId: id });
  }

  /** Accepts either the session's own report token or the API token. */
  reportAgent(id, report, auth) {
    return this._reportingSession(id, auth).reportAgent(report, 'api');
  }

  reportModel(id, report, auth) {
    return this._reportingSession(id, auth).reportModel(report);
  }

  reportToolSession(id, report, auth) {
    return this._reportingSession(id, auth).reportToolSession(report);
  }

  reportHello(id, auth) {
    return this._reportingSession(id, auth).reportHello();
  }

  reportShell(id, report, auth) {
    return this._reportingSession(id, auth).reportShell(report);
  }

  /**
   * A Docker Agent hook event. A session that was not started as Docker Agent (a Shell card the user ran it in, with
   * its own hooks) becomes one at its first event; the first Docker session heard from is then its main one.
   */
  reportDocker(id, event, auth) {
    const session = this._reportingSession(id, auth);
    session.docker ??= new DockerSessions(session);
    session.docker.report(event);
  }

  _reportingSession(id, { reportToken, trusted = false } = {}) {
    const session = this.sessions.get(id);
    // Without the API token, an unknown session and a wrong token look the
    // same, so the endpoint does not reveal which session ids exist.
    if (!trusted && !(session && timingSafeEqualString(reportToken, session.reportToken))) {
      throw httpError(401, 'invalid report token', 'unauthorized');
    }
    if (!session) throw httpError(404, `no session with id "${id}"`, 'not_found');
    return session;
  }

  /**
   * End every session and wait, up to `timeoutMs`, for the processes to
   * exit. Waiting matters on Windows, where ending a ConPTY process is slow.
   * Resolves to `{ remaining }`: how many processes had not confirmed their
   * exit when the wait ended, so a caller can tell a timeout from a clean
   * teardown.
   */
  async shutdown({ graceMs = 1500, timeoutMs = 5000 } = {}) {
    this.closing = true;
    for (const watcher of this.watchers.values()) watcher.stop();
    this.watchers.clear();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    const pending = new Set([...sessions.filter((s) => s.status === 'running'), ...this.exiting]);
    for (const session of pending) session.exited.then(() => pending.delete(session));
    for (const session of sessions) session.dispose({ graceMs });
    if (pending.size === 0) return { remaining: 0 };
    let timer;
    await Promise.race([
      Promise.all([...pending].map((s) => s.exited)),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    clearTimeout(timer);
    return { remaining: pending.size };
  }
}

/** Show a herdr card the agents herdr lists, and drop the ones it no longer lists. */
function showHerdrAgents(session, agents) {
  if (session.status !== 'running') return;
  const reports = herdrAgentReports(agents);
  const listed = new Set(reports.map((report) => report.agentId));
  for (const id of [...session.agents.keys()]) if (id.startsWith('herdr:') && !listed.has(id)) session.reportAgent({ agentId: id, remove: true }, 'herdr');
  for (const report of reports) {
    try { session.reportAgent(report, 'herdr'); } catch { /* more agents than a card holds */ }
  }
}

/** The model named by a --model, --model=, or -m argument, or null. */
export function modelFromArgs(args) {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--model' || args[i] === '-m') && args[i + 1]) return args[i + 1];
    if (args[i].startsWith('--model=') && args[i].length > 8) return args[i].slice(8);
  }
  return null;
}

const MAX_RESUME_ID = 200;

/** A session id or name to resume: one printable line, or null when absent. */
export function cleanResumeId(resume) {
  if (resume === undefined || resume === null) return null;
  const id = String(resume).trim();
  if (!id || id.length > MAX_RESUME_ID || /\p{Cc}/u.test(id)) {
    throw httpError(400, `resume must be a printable id of at most ${MAX_RESUME_ID} characters`, 'bad_resume');
  }
  return id;
}

export function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
