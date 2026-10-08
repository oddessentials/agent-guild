// Recover the user's real PATH and locale on macOS and Linux.
//
// An app started from Finder, the Dock, or a login item does not inherit the
// PATH that the user's shell profile builds (Homebrew, nvm, ~/.local/bin, ...),
// which is exactly where CLI coding tools usually live. Like VS Code, we ask
// the user's login shell for its PATH and merge it in.
//
// launchd starts a sign-in manager with no locale at all, where Terminal.app
// would set LANG to the region's UTF-8 locale. Without one, tmux writes
// non-ASCII characters as underscores, so a macOS manager with no locale
// takes Terminal.app's, and there a locale the login shell exports wins.

import fs from 'node:fs';
import { execFile, spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const START = '__AGENT_GUILD_PATH_START__';
const END = '__AGENT_GUILD_PATH_END__';

export function mergePathLists(primary, secondary, delimiter = path.delimiter) {
  const seen = new Set();
  const out = [];
  for (const list of [primary, secondary]) {
    for (const entry of (list || '').split(delimiter)) {
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      out.push(entry);
    }
  }
  return out.join(delimiter);
}

/** The variables that choose a locale, in the order they take effect. */
export const LOCALE_VARS = ['LC_ALL', 'LC_CTYPE', 'LANG'];

/** The non-empty `names` in `env` output captured between the two markers, or null without the markers. */
export function parseEnvOutput(stdout, names) {
  if (typeof stdout !== 'string') return null;
  const start = stdout.indexOf(START);
  const end = stdout.indexOf(END, start);
  if (start === -1 || end === -1) return null;
  const found = {};
  for (const line of stdout.slice(start + START.length, end).split(/\r?\n/)) {
    const eq = line.indexOf('=');
    const name = line.slice(0, eq);
    if (eq > 0 && names.includes(name) && line.length > eq + 1 && !(name in found)) found[name] = line.slice(eq + 1);
  }
  return found;
}

/** Pull PATH out of `env` output captured between the two markers. */
export function parsePathFromEnvOutput(stdout) {
  return parseEnvOutput(stdout, ['PATH'])?.PATH ?? null;
}

/** How long a login shell may take to report its environment. */
export const LOGIN_SHELL_TIMEOUT_MS = 8000;

// Read the exported PATH from `env` rather than expanding $PATH: fish, for
// one, expands "$PATH" to a space-separated list.
const LOGIN_SHELL_ARGS = ['-l', '-i', '-c', `printf '%s' ${START}; command env; printf '%s' ${END}`];

// The login shell runs in its own session, as it does under a manager started
// at sign-in or boot, so it cannot prompt on this terminal and the time limit
// ends it with everything its profile started. Interactive shells ignore
// SIGTERM, so the limit uses SIGKILL.
function endLoginShell(pid) {
  if (!(pid > 0)) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
}

/**
 * PATH and the locale variables the user's login shell exports, as
 * { vars, failure }. Without them vars is null and failure says why, as a
 * phrase that follows "the login shell".
 */
export function probeLoginShell({ shell, env = process.env, timeoutMs = LOGIN_SHELL_TIMEOUT_MS } = {}) {
  if (process.platform === 'win32' || !shell) return { vars: null, failure: null };
  const result = spawnSync(shell, LOGIN_SHELL_ARGS, {
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...env, AGENT_GUILD_RESOLVING_ENV: '1' },
  });
  if (result.error?.code === 'ETIMEDOUT') {
    endLoginShell(result.pid);
    return { vars: null, failure: `did not finish within ${timeoutMs / 1000} seconds` };
  }
  if (result.error) {
    const why = { ENOENT: 'does not exist', EACCES: 'cannot be run (permission denied)' }[result.error.code];
    return { vars: null, failure: why || `could not start (${result.error.code || result.error.message})` };
  }
  const vars = parseEnvOutput(result.stdout, ['PATH', ...LOCALE_VARS]);
  if (!vars) return { vars: null, failure: `${result.signal ? `was ended by ${result.signal}` : `exited with status ${result.status}`} before reporting its environment` };
  return { vars, failure: vars.PATH ? null : 'reported no PATH' };
}

/** PATH and the locale variables the user's login shell exports, or null. */
export function loginShellEnv(options) {
  return probeLoginShell(options).vars;
}

function readAppleLocale() {
  const result = spawnSync('/usr/bin/defaults', ['read', '-g', 'AppleLocale'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
  return result.error ? null : result.stdout;
}

/**
 * The locale Terminal.app gives its shells: the system region's UTF-8 locale,
 * or en_US.UTF-8 when macOS has none for it. `AppleLocale` may carry a script
 * (`zh-Hans_CN`) and options (`en_US@rg=gbzzzz`), which locale names do not.
 */
export function macLocale({ read = readAppleLocale, exists = (name) => fs.existsSync(path.join('/usr/share/locale', name)) } = {}) {
  const region = String(read() || '').trim().split('@')[0].replace(/-[A-Za-z]+(?=_)/, '');
  const name = `${region}.UTF-8`;
  return /^[A-Za-z]+_[A-Za-z]+$/.test(region) && exists(name) ? name : 'en_US.UTF-8';
}

/**
 * Returns a copy of process.env whose PATH also contains the login shell's
 * PATH entries. Set AGENT_GUILD_SKIP_SHELL_ENV=1 to disable the lookup.
 */
export function trimPathExt(env, platform = process.platform) {
  if (platform !== 'win32') return env;
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATHEXT');
  if (key) env[key] = env[key].split(';').map((ext) => ext.trim()).filter(Boolean).join(';');
  return env;
}

/** `platform`, `env`, `shellEnv` and `locale` are replaceable in tests. */
export function resolveBaseEnv({ platform = process.platform, env: source = process.env, shellEnv = loginShellEnv, locale = macLocale } = {}) {
  const env = trimPathExt({ ...source }, platform);
  // Set before asking the shell, so macOS's /etc/zprofile keeps it rather than putting its C.UTF-8 in its place.
  if (platform === 'darwin' && !LOCALE_VARS.some((name) => env[name])) env.LANG = locale();
  if (env.AGENT_GUILD_SKIP_SHELL_ENV === '1') return env;
  const shell = shellEnv({ shell: env.SHELL, env }) || {};
  if (shell.PATH) env.PATH = mergePathLists(shell.PATH, env.PATH);
  if (platform === 'darwin') for (const name of LOCALE_VARS) if (shell[name]) env[name] = shell[name];
  return env;
}

export function weavePaths(current, discovered, { delimiter = path.delimiter, caseInsensitive = process.platform === 'win32' } = {}) {
  const id = (entry) => (caseInsensitive ? entry.toLowerCase() : entry).replace(/(?<=.)[\\/]+$/, '');
  const unique = (list) => {
    const seen = new Set();
    return (list || '').split(delimiter).filter((entry) => entry && !seen.has(id(entry)) && seen.add(id(entry)));
  };
  const out = unique(current);
  const fresh = unique(discovered);
  const indexOf = (entry) => out.findIndex((e) => id(e) === id(entry));
  fresh.forEach((entry, i) => {
    if (indexOf(entry) !== -1) return;
    for (let j = i - 1; j >= 0; j--) {
      const at = indexOf(fresh[j]);
      if (at !== -1) return void out.splice(at + 1, 0, entry);
    }
    for (let j = i + 1; j < fresh.length; j++) {
      const at = indexOf(fresh[j]);
      if (at !== -1) return void out.splice(at, 0, entry);
    }
    out.push(entry);
  });
  return out.join(delimiter);
}

export function parseRegValue(stdout, name = 'Path') {
  const pattern = new RegExp(`^\\s+${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)$`, 'i');
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = line.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

export function expandWindowsVars(value, env) {
  return value.replace(/%([^%;]+)%/g, (whole, name) => {
    const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
    return key ? env[key] : whole;
  });
}

function queryRegistry(key, env, timeoutMs) {
  const system32 = path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32');
  return new Promise((resolve) => {
    execFile(path.win32.join(system32, 'reg.exe'), ['query', key, '/v', 'Path'], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

export async function readWindowsPath({ env = process.env, timeoutMs = 5000, query = queryRegistry } = {}) {
  const machine = parseRegValue(await query('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', env, timeoutMs));
  if (!machine) return null;
  const user = parseRegValue(await query('HKCU\\Environment', env, timeoutMs));
  return [machine, user].filter(Boolean).map((value) => expandWindowsVars(value, env)).join(';');
}

export function readLoginShellPath({ shell = process.env.SHELL, timeoutMs = LOGIN_SHELL_TIMEOUT_MS } = {}) {
  if (!shell) return Promise.resolve(null);
  return new Promise((resolve) => {
    let stdout = '';
    let child;
    try {
      child = spawn(shell, LOGIN_SHELL_ARGS, {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, AGENT_GUILD_RESOLVING_ENV: '1' },
      });
    } catch {
      return resolve(null);
    }
    // In its own session the shell would outlive a manager that exits mid-read, so it goes too.
    const end = () => endLoginShell(child.pid);
    const done = (value) => { clearTimeout(timer); process.off('exit', end); resolve(value); };
    const timer = setTimeout(() => { end(); done(null); }, timeoutMs);
    process.once('exit', end);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', () => done(null));
    child.on('close', () => done(parsePathFromEnvOutput(stdout)));
  });
}

export function pathReader(platform = process.platform, env = process.env) {
  if (env.AGENT_GUILD_SKIP_SHELL_ENV === '1') return null;
  return platform === 'win32' ? () => readWindowsPath({ env }) : () => readLoginShellPath({ shell: env.SHELL });
}
