// Read-only environment snapshots. Discovery runs outside the manager: even a
// blocked filesystem lookup cannot hold up terminals or HTTP. Each scope
// reports its own fact and never fills a gap from another scope.
import os from 'node:os';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { killWindowsTree } from './command-resolver.mjs';
import { RUNTIMES } from './environment-probe.mjs';
import { resolveProjectCwd } from './environment-pins.mjs';

export const ENVIRONMENT_TIMEOUT_MS = 10000;
export const LAUNCH_DETAIL = 'Launch PATH, profiles not applied. The selected shell is not consulted.';
export const SESSION_DETAIL = 'Spawn PATH, before the shell startup files.';
export const MULTIPLEXER_DETAIL = 'This session is tmux or herdr. Its environment is not the spawn record.';
const PATH_ENV = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'NVM_DIR'];

function hostName() {
  try { return os.hostname(); } catch { return null; }
}

function cloneRow(row) {
  return {
    ...row,
    ...(row.alternatives ? { alternatives: row.alternatives.map((item) => ({ ...item })) } : {}),
    ...(row.runtimes ? { runtimes: row.runtimes.map((item) => ({ ...item })) } : {}),
  };
}

function pendingRuntimes() {
  return RUNTIMES.map(({ id, label }) => ({ id, label, status: 'pending', version: null, path: null }));
}

export function probePathEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (typeof value === 'string' && PATH_ENV.includes(key.toUpperCase())) out[key] = value;
  }
  return out;
}

function pathIdentity(env, cwd) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  return createHash('sha256').update(`${key ? env[key] : ''}\0${cwd || ''}`).digest('hex').slice(0, 16);
}

export class Environment extends EventEmitter {
  constructor({ env, forkWorker = fork, timeoutMs = ENVIRONMENT_TIMEOUT_MS, hostname = hostName(), sessionLookup = () => null } = {}) {
    super();
    this.env = env ?? process.env;
    this.forkWorker = forkWorker;
    this.timeoutMs = timeoutMs;
    this.host = hostname;
    this.sessionLookup = sessionLookup;
    this.closed = false;
    this.run = null;
    this.launch = null;
    this.projects = new Map();
    this.sessions = new Map();
    this.value = this.blankManager();
  }

  setSessionLookup(sessionLookup) { this.sessionLookup = sessionLookup; }

  snapshot() { return this.value; }

  blankManager() {
    return {
      scope: 'manager', host: this.host, platform: process.platform, revision: 0, refreshing: false, checkedAt: null, error: null,
      managerNode: { version: process.versions.node, path: process.execPath },
      runtimes: pendingRuntimes(),
      tools: [],
    };
  }

  // Never awaits discovery. A refresh reads the manager's current environment;
  // it does not reload shell profiles, the registry, or a client's working folder.
  // publishLaunch stores a labeled copy when this same helper finishes.
  refresh({ publishLaunch = false } = {}) {
    if (this.closed) return publishLaunch && this.launch ? this.launch : this.snapshot();
    if (this.run) {
      if (publishLaunch && !this.run.publishLaunch) {
        this.run.publishLaunch = true;
        this.armLaunch();
      }
      return publishLaunch ? this.launch : this.snapshot();
    }
    const run = { child: null, timer: null, rows: new Map(), tools: [], publishLaunch };
    this.run = run;
    this.value = { ...this.value, revision: this.value.revision + 1, refreshing: true, error: null };
    if (publishLaunch) this.armLaunch();
    const finish = (error = null) => {
      if (this.run !== run) return;
      this.run = null;
      clearTimeout(run.timer);
      this.stopWorker(run.child);
      this.value = {
        ...this.value, revision: this.value.revision + 1, refreshing: false, checkedAt: new Date().toISOString(), error,
        runtimes: RUNTIMES.map(({ id, label }) => run.rows.get(id) ?? {
          id, label, status: 'failed', version: null, path: null, detail: error || 'The environment check did not finish.',
        }),
        tools: run.tools,
      };
      if (!this.closed) this.emit('updated', this.snapshot());
      if (run.publishLaunch) this.storeLaunch();
    };
    try {
      // A preload in NODE_OPTIONS must not execute inside a passive scan.
      const env = { ...this.env };
      for (const key of Object.keys(env)) if (key.toUpperCase() === 'NODE_OPTIONS') delete env[key];
      run.child = this.forkWorker(new URL('./environment-probe.mjs', import.meta.url), ['--scan-environment'], {
        env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true, detached: process.platform !== 'win32',
      });
      run.child.on('message', (message) => {
        if (this.run !== run) return;
        if (message?.runtime && RUNTIMES.some((runtime) => runtime.id === message.runtime.id)) run.rows.set(message.runtime.id, message.runtime);
        if (Array.isArray(message?.tools)) run.tools = message.tools;
        if (message?.done) finish();
      });
      run.child.once('error', () => finish('Could not start the environment check.'));
      // Let messages already queued win. Exit is a failed check only when a runtime never reported.
      run.child.once('exit', () => setImmediate(() => {
        if (this.run !== run) return;
        finish(run.rows.size === RUNTIMES.length ? null : 'The environment check stopped before finishing.');
      }));
      run.timer = setTimeout(() => finish('The environment check timed out.'), this.timeoutMs);
      run.timer.unref();
    } catch { finish('Could not start the environment check.'); }
    if (!this.closed) this.emit('updated', this.snapshot());
    return publishLaunch ? this.launch : this.snapshot();
  }

  armLaunch() {
    const previous = this.launch;
    this.launch = {
      scope: 'launch', host: this.host, platform: process.platform,
      revision: (previous?.revision ?? 0) + 1, refreshing: true, checkedAt: previous?.checkedAt ?? null, error: null,
      detail: LAUNCH_DETAIL,
      runtimes: (previous?.runtimes ?? this.value.runtimes).map(cloneRow),
      tools: (previous?.tools ?? this.value.tools).map((tool) => ({ ...tool })),
    };
    if (!this.closed) this.emit('updated', this.launch);
  }

  storeLaunch() {
    this.launch = {
      scope: 'launch', host: this.host, platform: this.value.platform,
      revision: (this.launch?.revision ?? 0) + 1, refreshing: false, checkedAt: this.value.checkedAt, error: this.value.error,
      detail: LAUNCH_DETAIL,
      runtimes: this.value.runtimes.map(cloneRow),
      tools: this.value.tools.map((tool) => ({ ...tool })),
    };
    if (!this.closed) this.emit('updated', this.launch);
    return this.launch;
  }

  openLaunch({ refresh = false } = {}) {
    if (refresh) return this.refresh({ publishLaunch: true });
    if (this.launch?.checkedAt) return this.launch;
    if (this.value.checkedAt && !this.run) return this.storeLaunch();
    return this.refresh({ publishLaunch: true });
  }

  projectKey(dir) {
    return `project:${process.platform === 'win32' ? dir.toLowerCase() : dir}`;
  }

  openProject(cwd, { refresh = false } = {}) {
    const dir = resolveProjectCwd(cwd);
    const key = this.projectKey(dir);
    let entry = this.projects.get(key);
    if (!entry) {
      entry = { value: this.blankProject(dir), run: null, identityRun: null };
      this.projects.set(key, entry);
    }
    if (refresh || !entry.value.checkedAt) this.startProject(entry, dir, false);
    else this.startProject(entry, dir, true);
    return entry.value;
  }

  blankProject(cwd) {
    return {
      scope: 'project', host: this.host, platform: process.platform, cwd, revision: 0, refreshing: false,
      checkedAt: null, error: null, stale: false, detail: null, identity: null, pins: [],
    };
  }

  startProject(entry, dir, identityOnly) {
    if (this.closed) return;
    if (identityOnly) {
      if (entry.run || entry.identityRun) return;
      this.forkPins(entry, dir, true);
      return;
    }
    this.stopWorker(entry.identityRun?.child);
    entry.identityRun = null;
    if (entry.run) return;
    entry.value = { ...entry.value, revision: entry.value.revision + 1, refreshing: true, error: null, stale: false, detail: null };
    this.forkPins(entry, dir, false);
    if (!this.closed) this.emit('updated', entry.value);
  }

  forkPins(entry, dir, identityOnly) {
    const run = { child: null, timer: null, result: null, revision: entry.value.revision };
    if (identityOnly) entry.identityRun = run;
    else entry.run = run;
    const finish = (error = null) => {
      const current = identityOnly ? entry.identityRun : entry.run;
      if (current !== run) return;
      if (identityOnly) entry.identityRun = null;
      else entry.run = null;
      clearTimeout(run.timer);
      this.stopWorker(run.child);
      if (identityOnly) this.finishIdentity(entry, run, error);
      else this.finishProject(entry, error, run.result);
    };
    try {
      run.child = this.forkWorker(new URL('./environment-probe.mjs', import.meta.url), [identityOnly ? '--pin-identity' : '--scan-pins', dir], {
        env: probeProcessEnv(), execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true, detached: process.platform !== 'win32',
      });
      run.child.on('message', (message) => {
        if ((identityOnly ? entry.identityRun : entry.run) !== run) return;
        if (message?.done) finish(message.error && !run.result ? message.error : null);
        else if (message?.error) run.result = { error: message.error };
        else if (message?.identity) run.result = message;
      });
      run.child.once('error', () => finish(identityOnly ? 'identity' : 'Could not read the project pins.'));
      run.child.once('exit', () => setImmediate(() => {
        if ((identityOnly ? entry.identityRun : entry.run) !== run) return;
        finish(run.result ? null : (identityOnly ? 'identity' : 'The project check stopped before finishing.'));
      }));
      run.timer = setTimeout(() => finish(identityOnly ? 'identity' : 'The project check timed out.'), this.timeoutMs);
      run.timer.unref();
    } catch { finish(identityOnly ? 'identity' : 'Could not read the project pins.'); }
  }

  finishProject(entry, error, result) {
    const pins = Array.isArray(result?.pins) ? result.pins : entry.value.pins;
    const identity = result?.identity || entry.value.identity;
    entry.value = {
      ...entry.value, revision: entry.value.revision + 1, refreshing: false, checkedAt: new Date().toISOString(),
      error: result?.error || error, stale: false, detail: null, identity, pins,
    };
    if (!this.closed) this.emit('updated', entry.value);
  }

  finishIdentity(entry, run, error) {
    if (entry.run || entry.value.revision !== run.revision) return;
    if (error || !run.result?.identity || run.result.error) {
      entry.value = { ...entry.value, stale: true, detail: 'Could not confirm the pin files are unchanged.' };
    } else if (run.result.identity !== entry.value.identity) {
      entry.value = { ...entry.value, stale: true, detail: null };
    } else {
      entry.value = { ...entry.value, stale: false, detail: null };
    }
    if (!this.closed) this.emit('updated', entry.value);
  }

  openSession(id, { refresh = false } = {}) {
    const found = this.sessionLookup(id);
    if (!found) return null;
    if (found.multiplexer) return this.unavailableSession(id, found);
    const key = `session:${id}:${pathIdentity(found.pathEnv, found.spawnCwd)}`;
    for (const other of [...this.sessions.keys()]) {
      if (other.startsWith(`session:${id}:`) && other !== key) this.dropSession(other);
    }
    let entry = this.sessions.get(key);
    if (!entry) {
      entry = { value: this.blankSession(id, found), run: null };
      this.sessions.set(key, entry);
    }
    if (refresh || !entry.value.checkedAt) this.startSession(entry, found);
    return entry.value;
  }

  blankSession(id, found) {
    return {
      scope: 'session', host: this.host, platform: process.platform, sessionId: id, spawnCwd: found.spawnCwd,
      availability: 'ok', detail: SESSION_DETAIL, revision: 0, refreshing: false, checkedAt: null, error: null,
      runtimes: pendingRuntimes(), tools: [],
    };
  }

  unavailableSession(id, found) {
    const key = `session:${id}:unavailable`;
    const existing = this.sessions.get(key);
    if (existing) return existing.value;
    for (const other of [...this.sessions.keys()]) if (other.startsWith(`session:${id}:`) && other !== key) this.dropSession(other);
    const value = {
      scope: 'session', host: this.host, platform: process.platform, sessionId: id, spawnCwd: found.spawnCwd,
      availability: 'unavailable', detail: MULTIPLEXER_DETAIL, revision: 1, refreshing: false,
      checkedAt: new Date().toISOString(), error: null, runtimes: [], tools: [],
    };
    this.sessions.set(key, { value, run: null });
    return value;
  }

  startSession(entry, found) {
    if (this.closed || entry.run) return;
    const run = { child: null, timer: null, rows: new Map(), tools: [] };
    entry.run = run;
    entry.value = { ...entry.value, revision: entry.value.revision + 1, refreshing: true, error: null };
    const finish = (error = null) => {
      if (entry.run !== run) return;
      entry.run = null;
      clearTimeout(run.timer);
      this.stopWorker(run.child);
      entry.value = {
        ...entry.value, revision: entry.value.revision + 1, refreshing: false, checkedAt: new Date().toISOString(), error,
        runtimes: RUNTIMES.map(({ id, label }) => run.rows.get(id) ?? {
          id, label, status: 'failed', version: null, path: null, detail: error || 'The environment check did not finish.',
        }),
        tools: run.tools,
      };
      if (!this.closed) this.emit('updated', entry.value);
    };
    try {
      const env = probePathEnv(found.pathEnv);
      for (const key of Object.keys(env)) if (key.toUpperCase() === 'NODE_OPTIONS') delete env[key];
      run.child = this.forkWorker(new URL('./environment-probe.mjs', import.meta.url), ['--scan-environment'], {
        env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true, detached: process.platform !== 'win32',
      });
      run.child.on('message', (message) => {
        if (entry.run !== run) return;
        if (message?.runtime && RUNTIMES.some((runtime) => runtime.id === message.runtime.id)) run.rows.set(message.runtime.id, message.runtime);
        if (Array.isArray(message?.tools)) run.tools = message.tools;
        if (message?.done) finish();
      });
      run.child.once('error', () => finish('Could not start the environment check.'));
      run.child.once('exit', () => setImmediate(() => {
        if (entry.run !== run) return;
        finish(run.rows.size === RUNTIMES.length ? null : 'The environment check stopped before finishing.');
      }));
      run.timer = setTimeout(() => finish('The environment check timed out.'), this.timeoutMs);
      run.timer.unref();
    } catch { finish('Could not start the environment check.'); }
    if (!this.closed) this.emit('updated', entry.value);
  }

  forgetSession(id) {
    for (const key of [...this.sessions.keys()]) if (key.startsWith(`session:${id}:`)) this.dropSession(key);
  }

  dropSession(key) {
    const entry = this.sessions.get(key);
    if (!entry) return;
    clearTimeout(entry.run?.timer);
    this.stopWorker(entry.run?.child);
    this.sessions.delete(key);
  }

  stopWorker(child) {
    if (!child?.pid && !child) return;
    if (!child?.pid) return;
    if (process.platform === 'win32') killWindowsTree(child.pid);
    else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }
  }

  close() {
    this.closed = true;
    if (this.run) {
      clearTimeout(this.run.timer);
      this.stopWorker(this.run.child);
      this.run = null;
    }
    for (const entry of this.projects.values()) {
      clearTimeout(entry.run?.timer);
      clearTimeout(entry.identityRun?.timer);
      this.stopWorker(entry.run?.child);
      this.stopWorker(entry.identityRun?.child);
    }
    for (const entry of this.sessions.values()) {
      clearTimeout(entry.run?.timer);
      this.stopWorker(entry.run?.child);
    }
  }
}

function probeProcessEnv() {
  const env = {};
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'PATHEXT', 'ComSpec', 'COMSPEC']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}
