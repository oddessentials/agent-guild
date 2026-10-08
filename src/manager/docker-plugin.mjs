// The Docker Agent CLI plugin: which copy `docker agent` runs, who owns each copy, and Agent Guild's own installs.
//
// The Docker CLI looks for a plugin in the folders `cliPluginsExtraDirs` names in its config.json, then in
// <config dir>/cli-plugins, then in the system folders, and runs the first it finds; `docker info` reports that copy,
// its version and the copies it shadows, without asking the daemon (measured: about 200 ms, daemon stopped or not).
//
// Agent Guild installs its own copy only into <config dir>/cli-plugins, and owns it only while that file is the one it
// recorded: the receipt names its path and SHA-256. Every change to it is written ahead to a journal, with the hashes
// it expects, before any file is touched, and `reconcile` decides from the files on disk how an interrupted change
// ends: finished, undone, or a conflict it reports and leaves alone. A replaced or removed copy is renamed to a backup
// first, so a running Docker Agent keeps its file (Windows refuses to delete a running .exe but allows renaming it,
// and the Docker CLI does not load docker-agent.exe.old-*); backups are deleted later, only while their hash matches.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSpawnSpec, runSpec } from './command-resolver.mjs';

export const PLUGIN_RELEASES = 'https://api.github.com/repos/docker/docker-agent/releases/latest';
const MAX_APPLIED = 32;
const INFO_TIMEOUT_MS = 15000;

const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);
const homeOf = (env, platform) => (platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();

/** The Docker CLI's config folder: DOCKER_CONFIG, else ~/.docker. */
export function dockerConfigDir(env = process.env, platform = process.platform) {
  return env.DOCKER_CONFIG || pathFor(platform).join(homeOf(env, platform), '.docker');
}

/** The file of plugin `name` in a plugin folder. */
export function pluginFile(dir, name, platform = process.platform) {
  return pathFor(platform).join(dir, `docker-${name}${platform === 'win32' ? '.exe' : ''}`);
}

/** Where Agent Guild installs plugin `name`: <config dir>/cli-plugins. */
export function pluginTarget(name, env = process.env, platform = process.platform) {
  return pluginFile(pathFor(platform).join(dockerConfigDir(env, platform), 'cli-plugins'), name, platform);
}

/** The folders config.json's cliPluginsExtraDirs names; the Docker CLI searches them before the config folder. */
export function extraPluginDirs(env = process.env, platform = process.platform) {
  try {
    const config = JSON.parse(fs.readFileSync(pathFor(platform).join(dockerConfigDir(env, platform), 'config.json'), 'utf8'));
    return Array.isArray(config?.cliPluginsExtraDirs) ? config.cliPluginsExtraDirs.filter((d) => typeof d === 'string' && d) : [];
  } catch {
    return [];
  }
}

/**
 * The copy of plugin `name` `docker` runs: { path, version, shadowed, error }, path null when it finds none. Read
 * from `docker info`, which resolves plugins as running them does.
 */
export async function readPlugin({ docker, name, env = process.env, platform = process.platform, run = runSpec }) {
  let stdout;
  try {
    ({ stdout } = await run(buildSpawnSpec(docker, ['info', '--format', '{{json .ClientInfo.Plugins}}'], env, platform), { env, timeoutMs: INFO_TIMEOUT_MS }));
  } catch (err) {
    const detail = String(err.stderr || err.message || err).trim().split(/\r?\n/)[0].slice(0, 200);
    return { path: null, version: null, shadowed: [], error: `docker info failed: ${detail}` };
  }
  let plugins;
  try { plugins = JSON.parse(stdout); } catch { return { path: null, version: null, shadowed: [], error: 'docker info did not list its plugins' }; }
  const found = (Array.isArray(plugins) ? plugins : []).find((p) => p?.Name === name);
  if (!found) return { path: null, version: null, shadowed: [], error: null };
  const shadowed = Array.isArray(found.ShadowedPaths) ? found.ShadowedPaths.filter((p) => typeof p === 'string') : [];
  const version = typeof found.Version === 'string' ? found.Version.replace(/^v/, '') : null;
  // A file named like a plugin that does not answer as one is listed with Err.
  const error = found.Err ? `Docker cannot load ${found.Path}: ${typeof found.Err === 'string' ? found.Err : JSON.stringify(found.Err)}` : null;
  return { path: typeof found.Path === 'string' ? found.Path : null, version, shadowed, error };
}

/** "agent-guild", "docker-desktop" or "other": who manages a copy. Only Agent Guild's own may be changed. */
export function ownerOf(file, { target, receipt, platform = process.platform, env = process.env, hash = sha256File }) {
  const p = pathFor(platform);
  const same = (a, b) => (platform === 'win32' ? p.resolve(a).toLowerCase() === p.resolve(b).toLowerCase() : p.resolve(a) === p.resolve(b));
  let real = file;
  try { real = fs.realpathSync.native(file); } catch { /* keep the path */ }
  const programFiles = env.ProgramW6432 || env.ProgramFiles || 'C:\\Program Files';
  const desktop = platform === 'win32'
    ? same(p.dirname(real), p.join(programFiles, 'Docker', 'cli-plugins'))
    : /\/Docker\.app\/Contents\//.test(real) || real.startsWith('/opt/docker-desktop/');
  if (desktop) return 'docker-desktop';
  if (!receipt?.managed || !same(file, target) || !same(receipt.managed.path, target)) return 'other';
  try { if (fs.lstatSync(file).isSymbolicLink()) return 'other'; } catch { return 'other'; }
  return hash(file) === receipt.managed.sha256 ? 'agent-guild' : 'other';
}

/** SHA-256 of a file, hex, or null when it cannot be read; cached by path, size and modification time. */
const hashCache = new Map();
export function sha256File(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const key = `${file}\0${stat.size}\0${stat.mtimeMs}`;
  if (hashCache.has(key)) return hashCache.get(key);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const h = crypto.createHash('sha256');
    const buffer = Buffer.alloc(1 << 20);
    for (let n; (n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) h.update(buffer.subarray(0, n));
    const digest = h.digest('hex');
    if (hashCache.size > 64) hashCache.clear();
    hashCache.set(key, digest);
    return digest;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The release asset for this computer: { version, url, sha256, name }, or throws saying why there is none. */
export async function latestRelease({ fetchImpl = fetch, platform = process.platform, arch = process.arch, url = PLUGIN_RELEASES } = {}) {
  const os = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[platform];
  const cpu = { x64: 'amd64', arm64: 'arm64' }[arch];
  if (!os || !cpu) throw new Error(`Docker Agent publishes no build for ${platform}-${arch}`);
  const response = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json' } });
  // GitHub allows 60 unauthenticated API requests an hour per network address.
  if ((response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
    const when = Number.isFinite(reset) && reset > 0 ? ` after ${new Date(reset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ' within the hour';
    throw new Error(`GitHub's limit of 60 release lookups an hour from this network is used up; try again${when}`);
  }
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for the latest Docker Agent release`);
  const release = await response.json();
  const name = `docker-agent-${os}-${cpu}${platform === 'win32' ? '.exe' : ''}`;
  const asset = (release.assets || []).find((a) => a.name === name);
  if (!asset) throw new Error(`the latest Docker Agent release (${release.tag_name}) has no ${name}`);
  const sha256 = /^sha256:([a-f0-9]{64})$/.exec(asset.digest || '')?.[1];
  // Without a published hash a download cannot be checked, so it is not installed.
  if (!sha256) throw new Error(`the latest Docker Agent release (${release.tag_name}) publishes no SHA-256 for ${name}`);
  return { version: String(release.tag_name || '').replace(/^v/, ''), url: asset.browser_download_url, sha256, name };
}

// ---- receipt and journal ------------------------------------------------

/** Agent Guild's record of its own install of one plugin, and the journal of a change in progress. */
export class PluginLedger {
  constructor(dir, name) {
    this.dir = dir;
    this.receiptFile = path.join(dir, `docker-${name}.receipt.json`);
    this.journalFile = path.join(dir, `docker-${name}.journal.json`);
  }

  /** { managed: { path, sha256, version } | null, applied: [op ids], pending: [{ path, sha256 }], conflict } */
  receipt() {
    const raw = readJson(this.receiptFile);
    return {
      managed: raw?.managed && typeof raw.managed.path === 'string' && typeof raw.managed.sha256 === 'string' ? raw.managed : null,
      applied: Array.isArray(raw?.applied) ? raw.applied.filter((id) => typeof id === 'string') : [],
      pending: Array.isArray(raw?.pending) ? raw.pending.filter((e) => typeof e?.path === 'string' && typeof e?.sha256 === 'string') : [],
      conflict: typeof raw?.conflict === 'string' ? raw.conflict : null,
    };
  }

  journal() {
    return readJson(this.journalFile);
  }

  writeReceipt(receipt) {
    writeAtomic(this.receiptFile, { ...receipt, applied: receipt.applied.slice(-MAX_APPLIED) });
  }

  writeJournal(journal) {
    writeAtomic(this.journalFile, journal);
  }

  clearJournal() {
    fs.rmSync(this.journalFile, { force: true });
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// The whole file or none of it: written beside, flushed, then renamed over.
function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, 'w');
  try {
    fs.writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

/**
 * Ends an interrupted Install, Update or Remove from the files on disk: { outcome, message }, outcome "none" (no
 * journal), "committed", "undone" or "conflict". Each step is safe to repeat, so a crash during reconciliation is
 * reconciled again. The staged download is the journal's own (its name carries the operation id), so it is always
 * Agent Guild's to delete; a file at the target that matches neither expected hash is never touched.
 */
export function reconcile(ledger, { hash = sha256File } = {}) {
  const journal = ledger.journal();
  const receipt = ledger.receipt();
  if (!journal || typeof journal.id !== 'string') {
    if (journal) ledger.clearJournal();
    return { outcome: 'none', message: null };
  }
  const finish = (outcome, message, changes = {}) => {
    const next = { ...receipt, ...changes };
    if (!next.applied.includes(journal.id)) next.applied = [...next.applied, journal.id];
    next.conflict = outcome === 'conflict' ? message : null;
    ledger.writeReceipt(next);
    removeQuietly(journal.staged);
    ledger.clearJournal();
    return { outcome, message };
  };
  // The receipt already took this operation: only the journal was left.
  if (receipt.applied.includes(journal.id)) {
    removeQuietly(journal.staged);
    ledger.clearJournal();
    return { outcome: 'committed', message: null };
  }
  const target = hash(journal.target);
  const backup = hash(journal.backup);
  const pendingBackup = backup !== null && backup === journal.previous ? [{ path: journal.backup, sha256: backup }] : [];
  const pending = [...receipt.pending, ...pendingBackup];

  if (journal.op === 'remove') {
    if (target === null && backup !== null && backup === journal.previous) {
      return finish('committed', null, { managed: null, pending });
    }
    if (target !== null && target === journal.previous && backup === null) return finish('undone', null);
    if (target !== null && target === journal.previous) {
      // The copy is still there and a backup of the same file too: removal never took effect.
      return finish('undone', null, { pending });
    }
    if (target === null && backup === null) {
      return finish('conflict', `Removing Docker Agent was interrupted, and both ${journal.target} and Agent Guild's backup of it are gone. Nothing else was changed.`, { managed: null });
    }
    const what = target === null
      ? `${journal.target} is gone and ${journal.backup} is not the copy Agent Guild moved there`
      : `${journal.target} is now a file Agent Guild did not write`;
    return finish('conflict', `Removing Docker Agent was interrupted, and ${what}. It was left as it is.`, { managed: null, pending });
  }

  // Install or Update.
  if (target !== null && target === journal.expected) {
    return finish('committed', null, { managed: { path: journal.target, sha256: journal.expected, version: journal.version }, pending });
  }
  if (target === null && backup !== null && backup === journal.previous) {
    // The old copy was moved aside and the new one never arrived: put the old one back.
    fs.renameSync(journal.backup, journal.target);
    return finish('undone', null);
  }
  if ((target === null && journal.previous === null) || (target !== null && target === journal.previous)) {
    return finish('undone', null, { pending });
  }
  const what = target === null ? `${journal.target} is gone` : `${journal.target} is now a file Agent Guild did not write`;
  return finish('conflict', `${journal.op === 'install' ? 'Installing' : 'Updating'} Docker Agent was interrupted, and ${what}. It was left as it is.`, { managed: null, pending });
}

/** Deletes backups that are still exactly what was recorded; a backup a running Docker Agent holds waits (EPERM). */
export function sweepBackups(ledger, { hash = sha256File } = {}) {
  const receipt = ledger.receipt();
  if (receipt.pending.length === 0) return receipt;
  const pending = receipt.pending.filter((entry) => {
    const now = hash(entry.path);
    if (now === null) return false;
    if (now !== entry.sha256) return false;
    try {
      fs.rmSync(entry.path);
      return false;
    } catch {
      return true;
    }
  });
  const next = { ...receipt, pending };
  if (pending.length !== receipt.pending.length) ledger.writeReceipt(next);
  return next;
}

function removeQuietly(file) {
  if (typeof file !== 'string' || !file) return;
  try { fs.rmSync(file, { force: true }); } catch { /* left for the next reconciliation */ }
}
