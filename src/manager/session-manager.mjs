// Owns every Session. The HTTP/WebSocket layer and any future front end talk
// to this object; nothing here knows about browsers.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Session, newId, clampDimension } from './session.mjs';

export const MAX_SESSIONS = 32;

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
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
   */
  constructor({ registry, baseEnv, getApiUrl, sessionDefaults = {} }) {
    super();
    this.registry = registry;
    this.baseEnv = baseEnv;
    this.getApiUrl = getApiUrl;
    this.sessionDefaults = sessionDefaults;
    this.sessions = new Map();
    /** Removed sessions whose process has not exited yet. */
    this.exiting = new Set();
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

  create({ providerId, cwd, cols, rows, name, args, resume } = {}) {
    const provider = this.registry.get(String(providerId || ''));
    if (!provider) throw httpError(404, `unknown provider "${providerId}"`, 'unknown_provider');
    if (this.sessions.size >= MAX_SESSIONS) {
      throw httpError(429, `session limit reached (${MAX_SESSIONS}); remove finished sessions first`, 'too_many_sessions');
    }
    if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))) {
      throw httpError(400, 'args must be an array of strings', 'bad_args');
    }
    const resumeId = cleanResumeId(resume);
    const workDir = this.resolveCwd(cwd);
    const spawnSpec = this.registry.spawnSpec(provider, args || [], resumeId);
    const description = this.registry.describe(provider);
    const id = newId();
    const reportToken = crypto.randomBytes(16).toString('hex');

    const env = mergeEnv([this.baseEnv, provider.env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      AGENT_GUILD_SESSION_ID: id,
      AGENT_GUILD_PROVIDER: provider.id,
      AGENT_GUILD_URL: this.getApiUrl(),
      AGENT_GUILD_REPORT_TOKEN: reportToken,
    }]);

    let session;
    try {
      session = new Session({
        ...this.sessionDefaults,
        id,
        provider: description,
        spawnSpec,
        cwd: workDir,
        env,
        cols: clampDimension(cols, 120, 2, 1000),
        rows: clampDimension(rows, 32, 1, 500),
        name,
        reportToken,
        resume: resumeId,
      });
    } catch (err) {
      throw httpError(500, `could not start ${provider.tool}: ${err.message}`, 'spawn_failed');
    }

    session.on('changed', () => {
      if (this.sessions.has(id)) this.emit('event', { type: 'session.updated', session: session.toJSON() });
    });
    session.on('warning', (msg) => console.warn(`[session ${id}] ${msg}`));
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
    session._broadcast({ type: 'removed' });
    if (session.status === 'running') {
      this.exiting.add(session);
      session.exited.then(() => this.exiting.delete(session));
    }
    session.dispose();
    this.emit('event', { type: 'session.removed', sessionId: id });
  }

  /** Accepts either the session's own report token or the API token. */
  reportAgent(id, report, { reportToken, trusted = false } = {}) {
    const session = this.sessions.get(id);
    // Without the API token, an unknown session and a wrong token look the
    // same, so the endpoint does not reveal which session ids exist.
    if (!trusted && !(session && timingSafeEqualString(reportToken, session.reportToken))) {
      throw httpError(401, 'invalid report token', 'unauthorized');
    }
    if (!session) throw httpError(404, `no session with id "${id}"`, 'not_found');
    return session.reportAgent(report, 'api');
  }

  /**
   * End every session and wait, up to `timeoutMs`, for the processes to
   * exit. Waiting matters on Windows, where ending a ConPTY process is slow.
   */
  async shutdown({ graceMs = 1500, timeoutMs = 5000 } = {}) {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    const running = [...sessions.filter((s) => s.status === 'running'), ...this.exiting].map((s) => s.exited);
    for (const session of sessions) session.dispose({ graceMs });
    if (running.length === 0) return;
    let timer;
    await Promise.race([
      Promise.all(running),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    clearTimeout(timer);
  }
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
