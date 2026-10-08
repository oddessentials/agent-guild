// Locate a provider's command on PATH and turn it into something node-pty can
// spawn on every platform.

import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

function isExecutableFile(file, platform) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (platform === 'win32') return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function windowsExtensions(env) {
  const raw = env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  const exts = raw.split(';').map((e) => e.trim().toLowerCase()).filter(Boolean);
  // npm installs PowerShell shims too; accept them as a last resort.
  if (!exts.includes('.ps1')) exts.push('.ps1');
  return exts;
}

export function pathKey(env, platform = process.platform) {
  // Windows environment keys are case-insensitive ("Path" is common).
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || (platform === 'win32' ? 'Path' : 'PATH');
}

function getPath(env) {
  return env[pathKey(env)] || '';
}

function candidateGroups(command, env, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const hasExt = platform === 'win32' && p.extname(command) !== '';
  const withExts = (base) =>
    platform === 'win32' && !hasExt ? windowsExtensions(env).map((e) => base + e) : [base];

  if (command.includes('/') || (platform === 'win32' && command.includes('\\'))) return [withExts(p.resolve(command))];
  const groups = [];
  const delimiter = platform === 'win32' ? ';' : ':';
  for (const dir of getPath(env).split(delimiter)) {
    if (!dir) continue;
    const clean = dir.replace(/^"(.*)"$/, '$1');
    groups.push(withExts(p.join(clean, command)));
  }
  return groups;
}

/**
 * Resolve `command` to an absolute path, or return null when it is not
 * installed. Commands that already contain a path separator are checked as-is.
 * `isExecutable` is injectable so tests can simulate another platform.
 * `onSkip` drops a candidate before that check, without touching the filesystem.
 */
export function resolveCommand(command, env = process.env, platform = process.platform, {
  isExecutable = (file) => isExecutableFile(file, platform),
  onSkip = () => false,
} = {}) {
  if (!command) return null;
  for (const group of candidateGroups(command, env, platform)) {
    const hit = group.find((candidate) => !onSkip(candidate) && isExecutable(candidate));
    if (hit) return hit;
  }
  return null;
}

export function resolveAllCommands(command, env = process.env, platform = process.platform, {
  isExecutable = (file) => isExecutableFile(file, platform),
} = {}) {
  if (!command) return [];
  const seen = new Set();
  const hits = [];
  for (const group of candidateGroups(command, env, platform)) {
    const hit = group.find((c) => isExecutable(c));
    const id = hit && (platform === 'win32' ? hit.toLowerCase() : hit);
    if (!hit || seen.has(id)) continue;
    seen.add(id);
    hits.push(hit);
  }
  return hits;
}

/** End a Windows process and, unless `tree` is false, every process it started. */
export function killWindowsTree(pid, done = () => {}, { tree = true } = {}) {
  execFile('taskkill', ['/PID', String(pid), ...(tree ? ['/T'] : []), '/F'], { windowsHide: true, timeout: 5000 }, (err) => done(err));
}

/** SIGKILL a process group started with `detached`, so nothing it started outlives it. */
export function killGroup(pid) {
  if (!(pid > 0)) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
}

// A child in its own session no longer gets the terminal's Ctrl+C, so these
// end it when this process exits or is stopped by a signal.
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const pendingKills = new Set();

function killPending() {
  for (const kill of pendingKills) kill();
}

function unhook() {
  process.off('exit', killPending);
  for (const signal of STOP_SIGNALS) process.off(signal, onStopSignal);
}

function onStopSignal(signal) {
  killPending();
  pendingKills.clear();
  unhook();
  // With no handler of its own left, the process ends as the signal would have ended it.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

/** Run `kill` if this process exits or is stopped before the returned release is called. */
export function endWithProcess(kill) {
  if (!pendingKills.size) {
    process.on('exit', killPending);
    for (const signal of STOP_SIGNALS) process.on(signal, onStopSignal);
  }
  pendingKills.add(kill);
  return () => {
    pendingKills.delete(kill);
    if (!pendingKills.size) unhook();
  };
}

/** Quote one argument for a cmd.exe command line. */
export function quoteForCmd(arg) {
  const s = String(arg);
  if (s !== '' && !/[\s"&|<>^()%!,;=]/.test(s)) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * Build the file/args pair passed to node-pty. On Windows, batch shims
 * (claude.cmd, codex.cmd, ...) must run through cmd.exe and PowerShell shims
 * through powershell.exe; ConPTY cannot execute them directly.
 */
export function buildSpawnSpec(resolvedPath, args = [], env = process.env, platform = process.platform) {
  if (platform !== 'win32') return { file: resolvedPath, args: [...args] };
  const ext = path.win32.extname(resolvedPath).toLowerCase();
  // Absolute paths: a bare name is looked up on the child's PATH, which a
  // provider's own env may not carry.
  const system32 = path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32');
  if (ext === '.cmd' || ext === '.bat') {
    const comspec = env.ComSpec || env.COMSPEC || path.win32.join(system32, 'cmd.exe');
    const inner = [resolvedPath, ...args].map(quoteForCmd).join(' ');
    // A raw command-line string: /s strips the outer quotes and keeps the rest.
    return { file: comspec, args: `/d /s /c "${inner}"` };
  }
  if (ext === '.ps1') {
    return {
      file: path.win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolvedPath, ...args],
    };
  }
  return { file: resolvedPath, args: [...args] };
}

/**
 * Run a file in its own process group, which execFile cannot do, and at the
 * time limit SIGKILL the whole group. Settles as execFile would.
 */
function runInOwnGroup(file, args, { env, cwd, timeoutMs, input }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, { env, cwd, detached: true });
    } catch (err) {
      return reject(Object.assign(err, { stdout: '', stderr: '' }));
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const end = () => killGroup(child.pid);
    const release = endWithProcess(end);
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      release();
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      end();
      // A process that left the group may still hold the pipes.
      child.stdout.destroy();
      child.stderr.destroy();
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', finish);
    child.on('close', (code, signal) => {
      if (code === 0 && !timedOut) return finish(null);
      finish(Object.assign(new Error(`Command failed: ${[file, ...args].join(' ')}`), { code, signal, killed: timedOut }));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

/**
 * Run a spawn spec to completion without a terminal, with `input` on its
 * stdin. Resolves with its output; rejects with the error carrying stdout
 * and stderr. At the time limit the child gets SIGTERM; with `killTree`, it
 * and everything it started are killed outright, for wrappers such as .cmd
 * shims and Docker CLI plugins whose own children would otherwise live on.
 */
export function runSpec(spec, { env, timeoutMs = 15000, cwd, input, killTree = false } = {}) {
  const tree = killTree && timeoutMs > 0;
  if (tree && process.platform !== 'win32') return runInOwnGroup(spec.file, spec.args, { env, cwd, timeoutMs, input });
  return new Promise((resolve, reject) => {
    const opts = { env, cwd, timeout: tree ? 0 : timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 };
    let args = spec.args;
    if (typeof args === 'string') {
      opts.windowsVerbatimArguments = true;
      args = [args];
    }
    let timer = null;
    let timedOut = false;
    try {
      const child = execFile(spec.file, args, opts, (err, stdout, stderr) => {
        clearTimeout(timer);
        if (err) reject(Object.assign(err, { stdout, stderr }, timedOut && { killed: true }));
        else resolve({ stdout, stderr });
      });
      // taskkill /T finds the children through the wrapper, so it runs before the wrapper goes.
      if (tree && child.pid) {
        timer = setTimeout(() => {
          timedOut = true;
          killWindowsTree(child.pid);
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, timeoutMs);
      }
      if (input !== undefined) child.stdin.end(input);
    } catch (err) {
      reject(err);
    }
  });
}
