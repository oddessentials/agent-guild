// Read-only snapshot of the manager environment. Discovery runs outside the
// manager: even a blocked filesystem lookup cannot hold up terminals or HTTP.
import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { killWindowsTree } from './command-resolver.mjs';
import { RUNTIMES } from './environment-probe.mjs';

export const ENVIRONMENT_TIMEOUT_MS = 10000;

export class Environment extends EventEmitter {
  constructor({ env, forkWorker = fork, timeoutMs = ENVIRONMENT_TIMEOUT_MS } = {}) {
    super();
    this.env = env ?? process.env;
    this.forkWorker = forkWorker;
    this.timeoutMs = timeoutMs;
    this.closed = false;
    this.run = null;
    this.value = {
      scope: 'manager', platform: process.platform, revision: 0, refreshing: false, checkedAt: null, error: null,
      managerNode: { version: process.versions.node, path: process.execPath },
      runtimes: RUNTIMES.map(({ id, label }) => ({ id, label, status: 'pending', version: null, path: null })),
      tools: [],
    };
  }

  snapshot() { return this.value; }

  // Never awaits discovery. A refresh reads the manager's current environment;
  // it does not reload shell profiles, the registry, or a client's working folder.
  refresh() {
    if (this.closed || this.run) return this.snapshot();
    const run = { child: null, timer: null, rows: new Map(), tools: [] };
    this.run = run;
    this.value = { ...this.value, revision: this.value.revision + 1, refreshing: true, error: null };
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
      if (!this.closed) this.emit('updated');
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
        if (message?.runtime && RUNTIMES.some((r) => r.id === message.runtime.id)) run.rows.set(message.runtime.id, message.runtime);
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
    this.emit('updated');
    return this.snapshot();
  }

  stopWorker(child) {
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
  }
}
