import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { expandHome, homeDir } from './install-channels.mjs';
import { envValue } from './multiplexer-paths.mjs';
import { renameRetrying } from './yard-art.mjs';

export const HERMES_EXPIRY_MS = 90 * 1000;
const SWEEP_MS = 15 * 1000;
const MAX_HELPERS = 64;
const SHELL_TOOLS = new Set(['terminal', 'process']);
const PREFIX = 'hermes:';

const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROFILE_MARKERS = ['config.yaml', '.env', 'SOUL.md', 'profile.yaml', 'auth.json', 'state.db'];

const text = (value) => (typeof value === 'string' && value ? value : null);
const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

/** One name for a Hermes home, however its path is spelled. */
export function hermesHomeKey(dir, platform = process.platform) {
  let real;
  try { real = fs.realpathSync.native(dir); } catch { real = pathFor(platform).resolve(dir); }
  return platform === 'win32' ? real.toLowerCase() : real;
}

/** The root `hermes -p` resolves profiles in, for a process started with `env`. */
export function hermesRoot(env, platform) {
  const p = pathFor(platform);
  const get = (name) => (platform === 'win32' ? envValue(env, name) : env[name]);
  const raw = (get('HERMES_HOME') ?? '').trim();
  if (!raw) {
    const suffix = get('HERMES_DATA_DIR_SUFFIX') ?? '';
    const home = homeDir(env, platform);
    if (platform !== 'win32') return p.join(home, `.hermes${suffix}`);
    return p.join((get('LOCALAPPDATA') ?? '').trim() || p.join(home, 'AppData', 'Local'), `hermes${suffix}`);
  }
  const reference = platform === 'win32' ? /%([^%]+)%|\$\{([^}]+)\}|\$(\w+)/g : /\$\{([^}]+)\}|\$(\w+)/g;
  const expanded = raw.replace(reference, (whole, ...names) => get(names.find((name) => typeof name === 'string')) ?? whole);
  const dir = p.resolve(expandHome(expanded, env, platform));
  return p.basename(p.dirname(dir)) === 'profiles' ? p.dirname(p.dirname(dir)) : dir;
}

/** Hermes's root as the default account, then each profile Hermes itself lists there. */
export function hermesProfiles(env, platform) {
  const p = pathFor(platform);
  const root = hermesRoot(env, platform);
  const profiles = p.join(root, 'profiles');
  const marked = (file) => {
    try {
      const stat = fs.lstatSync(file);
      return stat.isFile() || stat.isSymbolicLink();
    } catch {
      return false;
    }
  };
  const isDir = (dir) => {
    try { return fs.statSync(dir).isDirectory(); } catch { return false; }
  };
  let names = [];
  try { names = fs.readdirSync(profiles).sort(); } catch { /* no profiles yet */ }
  names = names.filter((name) => name !== 'default' && PROFILE_ID_RE.test(name) && isDir(p.join(profiles, name))
    && PROFILE_MARKERS.some((file) => marked(p.join(profiles, name, file))) && !fs.existsSync(p.join(profiles, '.deleted', name)));
  // `root` is the absolute HERMES_HOME every command of the account runs with, so none resolves a relative one elsewhere.
  const account = (id, label, dir) => ({ id, label, dir, profile: id, root, home: hermesHomeKey(dir, platform) });
  return [account('default', 'Default', root), ...names.map((name) => account(name, name, p.join(profiles, name)))];
}

/**
 * Which report token each Hermes home has. `valid.json`, read only by the manager, is the one record of the tokens it
 * accepts; every change to it is made synchronously and saved before it counts. Each home's plugin reads a copy, one file
 * per home that only the user can read, holding the token, the home and the manager's address, one per line.
 */
export class HermesTokens {
  constructor(dir) {
    this.dir = dir;
    /** The homes whose file still names an address the manager has left. */
    this.stale = new Set();
    /** The homes the cards have, once told; a token of any other home is refused. */
    this.homes = null;
    this.queues = new Map();
    this.setups = new Map();
    /** Why the saved record could not be read, until a change replaces it; no token is accepted meanwhile. */
    this.unreadable = null;
    /** True while a file whose token was revoked could not be deleted yet, so the next prune tries again. */
    this.leftover = false;
    this.record = this._load();
  }

  get recordFile() {
    return path.join(this.dir, 'valid.json');
  }

  /** The saved record. None saved yet is an empty record; one that cannot be read accepts nothing and says why. */
  _load() {
    let text;
    try {
      text = fs.readFileSync(this.recordFile, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') this._unreadable(err.code || err.message);
      return new Map();
    }
    let saved;
    try { saved = JSON.parse(text); } catch { /* reported below */ }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
      this._unreadable('it is not a valid record');
      return new Map();
    }
    return new Map(Object.entries(saved).filter(([home, token]) => home && typeof token === 'string' && token));
  }

  _unreadable(reason) {
    this.unreadable = reason;
    console.error(`[hermes] no report token is accepted: ${this.recordFile} could not be read (${reason})`);
  }

  /** The only way the record changes: the change counts once it is saved, and not at all when saving fails. */
  _commit(change) {
    const next = new Map(this.record);
    change(next);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.recordFile}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(next)), { mode: 0o600 });
      fs.renameSync(tmp, this.recordFile);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    this.record = next;
    this.unreadable = null;
  }

  _carded(home) {
    return !this.homes || this.homes.has(home);
  }

  /** Runs one home's file work whole, after whatever was asked for that home before. The record never waits on it. */
  _serial(home, work, queues = this.queues) {
    const run = (queues.get(home) ?? Promise.resolve()).then(work);
    const settled = run.catch(() => {});
    queues.set(home, settled);
    settled.then(() => { if (queues.get(home) === settled) queues.delete(home); });
    return run;
  }

  /**
   * Runs one whole turning on or off of a home's reporting, its failure handling included, after any asked for that home
   * before, so a request never acts on what another changed meanwhile. It may use the token methods, which never wait on it.
   */
  setup(home, work) {
    return this._serial(home, work, this.setups);
  }

  /** The file a home's plugin reads its token from. */
  file(home) {
    return path.join(this.dir, `${crypto.createHash('sha256').update(home).digest('hex').slice(0, 32)}.token`);
  }

  _read(file) {
    try {
      const [token, home, url = ''] = fs.readFileSync(file, 'utf8').split('\n');
      return token && home ? { file, token, home, url } : null;
    } catch {
      return null;
    }
  }

  _files() {
    let names = [];
    try { names = fs.readdirSync(this.dir).filter((name) => name.endsWith('.token')); } catch { /* none yet */ }
    return names.map((name) => this._read(path.join(this.dir, name))).filter(Boolean);
  }

  /** The home's accepted token, or null. */
  get(home) {
    return this._carded(home) ? this.record.get(home) ?? null : null;
  }

  /** Deletes the file of a home whose token is revoked, waiting out a reader that holds it. False when it is still there. */
  async _delete(home) {
    if (this.record.has(home)) return true;
    const file = this.file(home);
    if (fs.existsSync(file)) {
      const gone = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        await renameRetrying(file, gone);
      } catch {
        return false;
      }
      fs.rmSync(gone, { force: true });
    }
    this.stale.delete(home);
    return true;
  }

  async _write(home, token, url) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.file(home);
    const next = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(next, `${token}\n${home}\n${url ?? ''}\n`, { mode: 0o600 });
    try {
      await renameRetrying(next, file);
    } catch (err) {
      fs.rmSync(next, { force: true });
      throw err;
    }
  }

  /**
   * The home's token, saved in the record first when it has none, then copied to the home's file with the manager's address.
   * A copy that cannot be written leaves the home stale, so it does not count as reporting.
   */
  ensure(home, url = '') {
    let token;
    try {
      if (!this._carded(home)) throw new Error('No card has this Hermes home any more');
      token = this.record.get(home);
      if (!token) {
        token = crypto.randomBytes(24).toString('hex');
        this._commit((record) => record.set(home, token));
      }
    } catch (err) {
      return Promise.reject(err);
    }
    return this._serial(home, async () => {
      if (this.record.get(home) !== token) throw new Error('Reporting for this Hermes home was turned off meanwhile');
      const known = this._read(this.file(home));
      if (known?.token !== token || known.url !== (url ?? '')) {
        try {
          await this._write(home, token, url);
        } catch (err) {
          this.stale.add(home);
          throw err;
        }
      }
      this.stale.delete(home);
      return token;
    });
  }

  /** Gives every home the manager's address, as after a start on another port. A file that cannot be replaced keeps its contents and its home is stale. */
  async refresh(url) {
    for (const home of [...this.record.keys()]) {
      await this._serial(home, async () => {
        const token = this.get(home);
        const known = this._read(this.file(home));
        if (!token || (known?.token === token && known.url === url)) return;
        try {
          await this._write(home, token, url);
          this.stale.delete(home);
        } catch (err) {
          this.stale.add(home);
          console.error(`[hermes] could not give ${home} the manager's address: ${this.file(home)} could not be replaced (${err.code || err.message})`);
        }
      });
    }
  }

  /**
   * Revokes the home's token: rejects, changing nothing, when the record cannot be saved. Once saved the token is refused,
   * then its file is deleted; resolves false when the file is still there, and a later prune deletes it.
   */
  remove(home) {
    try {
      if (this.record.has(home)) this._commit((record) => record.delete(home));
    } catch (err) {
      return Promise.reject(err);
    }
    return this._serial(home, () => this._delete(home)).then((done) => {
      if (!done) this.leftover = true;
      return done;
    });
  }

  /**
   * Takes the homes the cards have now and revokes the token of every other home, saved before anything else. Then it deletes
   * every file whose token is not accepted; resolves true when none is left.
   */
  prune(homes) {
    const same = this.homes && homes.size === this.homes.size && [...homes].every((home) => this.homes.has(home));
    this.homes = homes;
    const gone = [...this.record.keys()].filter((home) => !homes.has(home));
    try {
      if (gone.length) this._commit((record) => { for (const home of gone) record.delete(home); });
    } catch (err) {
      return Promise.reject(err);
    }
    if (same && !gone.length && !this.leftover) return Promise.resolve(true);
    this.leftover = false;
    const orphans = new Set(this._files().map((entry) => entry.home).filter((home) => !this.record.has(home)));
    return Promise.all([...orphans].map((home) => this._serial(home, () => this._delete(home)))).then((done) => {
      const clean = done.every(Boolean);
      if (!clean) this.leftover = true;
      return clean;
    });
  }

  account(token) {
    if (typeof token !== 'string' || !token) return null;
    const given = Buffer.from(token);
    for (const [home, known] of this.record) {
      if (!this._carded(home)) continue;
      const expected = Buffer.from(known);
      if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) return home;
    }
    return null;
  }
}

function newInstance(now) {
  return { seq: 0, at: now, sessions: new Map(), subagents: new Map(), tools: new Map(), waits: new Map() };
}

/**
 * What the Hermes plugin reports, per account and per reporting process (instance). Emits `changed` with an account id.
 */
export class HermesLive extends EventEmitter {
  constructor({ now = Date.now, expiryMs = HERMES_EXPIRY_MS, sweepMs = SWEEP_MS } = {}) {
    super();
    this.now = now;
    this.expiryMs = expiryMs;
    this.accounts = new Map();
    this.muted = new Set();
    this.timer = sweepMs ? setInterval(() => this.sweep(), sweepMs) : null;
    this.timer?.unref?.();
  }

  close() {
    clearInterval(this.timer);
  }

  /** Clears what an account reports and refuses its reports, while its reporting is being turned off. */
  mute(accountId) {
    this.muted.add(accountId);
    this.accounts.delete(accountId);
    this.emit('changed', accountId);
  }

  unmute(accountId) {
    this.muted.delete(accountId);
  }

  receive(accountId, instanceId, messages) {
    if (this.muted.has(accountId)) return;
    if (typeof instanceId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(instanceId)) throw Object.assign(new Error('instance must be an id'), { status: 400, code: 'bad_request' });
    if (!Array.isArray(messages)) throw Object.assign(new Error('messages must be an array'), { status: 400, code: 'bad_request' });
    let instances = this.accounts.get(accountId);
    if (!instances) this.accounts.set(accountId, instances = new Map());
    let inst = instances.get(instanceId);
    if (!inst) instances.set(instanceId, inst = newInstance(this.now()));
    inst.at = this.now();
    for (const message of messages) {
      if (!message || typeof message !== 'object' || !Number.isSafeInteger(message.seq) || message.seq <= inst.seq) continue;
      inst.seq = message.seq;
      if (message.open && typeof message.open === 'object') this._reconcile(inst, message.open);
      else if (typeof message.event === 'string') this._event(accountId, inst, message.event, message.data && typeof message.data === 'object' ? message.data : {});
    }
    this.emit('changed', accountId);
  }

  _entity(inst, sid) {
    return inst.subagents.get(sid) ?? inst.sessions.get(sid) ?? null;
  }

  _session(inst, sid, data) {
    if (inst.subagents.has(sid)) return inst.subagents.get(sid);
    const session = inst.sessions.get(sid) ?? { platform: null, working: false };
    inst.sessions.set(sid, session);
    session.platform = text(data.platform) ?? session.platform;
    return session;
  }

  _forget(inst, sid) {
    inst.sessions.delete(sid);
    for (const [id, tool] of inst.tools) if (tool.sid === sid) inst.tools.delete(id);
    for (const [id, owner] of inst.waits) if (owner === sid) inst.waits.delete(id);
  }

  _event(accountId, inst, event, data) {
    const sid = text(data.session_id);
    const call = text(data.tool_call_id) && `${sid ?? ''}:${data.tool_call_id}`;
    const child = text(data.child_session_id);
    switch (event) {
      case 'on_session_start':
        if (sid) this._session(inst, sid, data);
        break;
      case 'on_session_end': {
        const entity = sid && this._entity(inst, sid);
        if (entity) entity.working = false;
        break;
      }
      case 'on_session_finalize':
      case 'on_session_delete':
        if (sid) this._forget(inst, sid);
        break;
      case 'pre_llm_call':
      case 'pre_tool_call':
        if (sid) this._session(inst, sid, data).working = true;
        if (event === 'pre_tool_call' && call) inst.tools.set(call, { sid, shell: SHELL_TOOLS.has(data.tool_name) });
        break;
      case 'post_tool_call':
        if (call) inst.tools.delete(call);
        break;
      case 'subagent_start':
        if (child) inst.subagents.set(child, { parent: text(data.parent_session_id), role: text(data.child_role), goal: text(data.child_goal), working: true });
        break;
      case 'subagent_stop':
        if (child) {
          inst.subagents.delete(child);
          this._forget(inst, child);
        }
        break;
      case 'pre_approval_request':
        if (call) inst.waits.set(`approval:${call}`, sid);
        break;
      case 'post_approval_response':
        if (call) inst.waits.delete(`approval:${call}`);
        break;
      case 'on_human_input_request':
        if (text(data.request_id)) inst.waits.set(`input:${data.request_id}`, sid);
        break;
      case 'on_human_input_resolved':
        if (text(data.request_id)) inst.waits.delete(`input:${data.request_id}`);
        break;
      default:
    }
  }

  _reconcile(inst, open) {
    const items = (kind) => new Map(Object.entries(open[kind] && typeof open[kind] === 'object' && !Array.isArray(open[kind]) ? open[kind] : {})
      .map(([id, facts]) => [id, facts && typeof facts === 'object' ? facts : {}]));
    const sessions = items('sessions');
    const subagents = items('subagents');
    const tools = items('tools');
    const waits = items('waits');
    const working = new Set(Array.isArray(open.working) ? open.working.filter((id) => typeof id === 'string') : []);
    for (const sid of [...inst.sessions.keys()]) {
      if (subagents.has(sid)) inst.sessions.delete(sid);
      else if (!sessions.has(sid)) this._forget(inst, sid);
    }
    for (const [sid, facts] of sessions) {
      if (subagents.has(sid)) continue;
      const session = inst.sessions.get(sid) ?? { platform: null, working: false };
      session.platform = text(facts.platform) ?? session.platform;
      inst.sessions.set(sid, session);
    }
    for (const child of [...inst.subagents.keys()]) if (!subagents.has(child)) inst.subagents.delete(child);
    for (const [child, facts] of subagents) {
      const agent = inst.subagents.get(child) ?? { parent: null, role: null, goal: null, working: true };
      agent.parent = text(facts.parent_session_id) ?? agent.parent;
      agent.role = text(facts.child_role) ?? agent.role;
      agent.goal = text(facts.child_goal) ?? agent.goal;
      inst.subagents.set(child, agent);
    }
    for (const session of inst.sessions.values()) session.working = false;
    for (const sid of working) {
      const entity = this._entity(inst, sid);
      if (entity) entity.working = true;
    }
    for (const call of [...inst.tools.keys()]) if (!tools.has(call)) inst.tools.delete(call);
    for (const [call, facts] of tools) if (!inst.tools.has(call)) inst.tools.set(call, { sid: text(facts.session_id), shell: SHELL_TOOLS.has(facts.tool_name) });
    for (const key of [...inst.waits.keys()]) if (!waits.has(key)) inst.waits.delete(key);
    for (const [key, facts] of waits) if (!inst.waits.has(key)) inst.waits.set(key, text(facts.session_id));
  }

  /** Drops the instances that have not reported for the expiry time. */
  sweep() {
    const now = this.now();
    for (const [accountId, instances] of this.accounts) {
      let dropped = false;
      for (const [id, inst] of instances) {
        if (now - inst.at >= this.expiryMs) {
          instances.delete(id);
          dropped = true;
        }
      }
      if (!instances.size) this.accounts.delete(accountId);
      if (dropped) this.emit('changed', accountId);
    }
  }

  _shown(accountId) {
    const agents = new Map();
    const shells = new Map();
    const add = (agent) => {
      if (agents.get(agent.agentId)?.status !== 'waiting') agents.set(agent.agentId, agent);
    };
    for (const inst of this.accounts.get(accountId)?.values() ?? []) {
      const waiting = new Set(inst.waits.values());
      for (const [sid, session] of inst.sessions) {
        if (waiting.has(sid) || session.working) add({ agentId: `${PREFIX}${sid}`, name: session.platform ?? 'hermes', kind: 'session', status: waiting.has(sid) ? 'waiting' : 'working' });
      }
      for (const [child, agent] of inst.subagents) {
        add({ agentId: `${PREFIX}${child}`, name: agent.goal ?? agent.role ?? 'subagent', kind: agent.role ?? 'subagent', status: waiting.has(child) ? 'waiting' : 'working', detail: agent.goal ?? '' });
      }
      for (const [call, tool] of inst.tools) if (tool.shell && tool.sid) shells.set(`${PREFIX}${call}`, { key: `${PREFIX}${call}`, agentId: `${PREFIX}${tool.sid}` });
    }
    const rank = { waiting: 0, working: 1 };
    return { agents: [...agents.values()].sort((a, b) => rank[a.status] - rank[b.status]), shells: [...shells.values()] };
  }

  view(accountId) {
    const { agents, shells } = this._shown(accountId);
    return { agents: agents.slice(0, MAX_HELPERS), shells };
  }

  live(accountId) {
    if (!this.accounts.has(accountId)) return null;
    const { agents, shells } = this._shown(accountId);
    return {
      working: agents.filter((a) => a.status === 'working').length,
      waiting: agents.filter((a) => a.status === 'waiting').length,
      agents: agents.slice(0, MAX_HELPERS).map((a) => ({ id: a.agentId, name: a.name, status: a.status, detail: a.detail ?? '' })),
      shells: shells.map((s) => ({ id: s.key })),
    };
  }
}
