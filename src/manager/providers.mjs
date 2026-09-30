// Provider registry: which coding tools can be launched and how.
//
// Built-in defaults live in config/providers.default.json. Users customise
// them with providers.json in the data directory: entries are merged by `id`,
// new ids are appended, and `"enabled": false` hides a provider. Any field can
// be overridden per platform under a "win32", "darwin" or "linux" key.

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { resolveCommand, buildSpawnSpec, runSpec } from './command-resolver.mjs';
import { compareVersions, installedVersion, latestVersion, DEFAULT_NPM_REGISTRY } from './versions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULTS_FILE = path.resolve(here, '../../config/providers.default.json');
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const PLATFORM_KEYS = ['win32', 'darwin', 'linux'];
const VERSION_TTL_MS = 60 * 60 * 1000;
const FAILED_PROBE_TTL_MS = 5 * 60 * 1000;

function fileMtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

export function defaultShell(env = process.env, platform = process.platform) {
  if (platform === 'win32') return 'powershell.exe';
  return env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Keep string, number and boolean values as strings; drop anything else. */
function normalizeEnv(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (['string', 'number', 'boolean'].includes(typeof value)) out[key] = String(value);
  }
  return out;
}

/** "claude", "codex", "gemini", a { command, args } that prints usage JSON, or null. */
function normalizeUsage(usage) {
  if (usage === 'claude' || usage === 'codex' || usage === 'gemini') return usage;
  if (usage && typeof usage === 'object' && typeof usage.command === 'string' && usage.command) {
    return { command: usage.command, args: Array.isArray(usage.args) ? usage.args.map(String) : [] };
  }
  return null;
}

function normalize(raw, platform) {
  const merged = { ...raw, ...(raw[platform] || {}) };
  for (const key of PLATFORM_KEYS) delete merged[key];
  return {
    id: merged.id,
    vendor: String(merged.vendor || merged.id),
    tool: String(merged.tool || merged.command || ''),
    command: String(merged.command || ''),
    package: merged.package ? String(merged.package) : null,
    versionArgs: Array.isArray(merged.versionArgs) && merged.versionArgs.length ? merged.versionArgs.map(String) : null,
    usage: normalizeUsage(merged.usage),
    modelPattern: merged.modelPattern ? String(merged.modelPattern) : null,
    args: Array.isArray(merged.args) ? merged.args.map(String) : [],
    resumeArgs: Array.isArray(merged.resumeArgs) ? merged.resumeArgs.map(String) : [],
    env: normalizeEnv(merged.env),
    color: String(merged.color || '#64748B'),
    monogram: String(merged.monogram || String(merged.vendor || merged.id).charAt(0)).slice(0, 2),
    icon: merged.icon ? String(merged.icon) : null,
    install: String(merged.install || ''),
    docs: String(merged.docs || ''),
    enabled: merged.enabled !== false,
  };
}

/**
 * Load providers. Returns { providers, warnings } so a broken user file never
 * prevents the manager from starting.
 */
export function loadProviders({ userFile, platform = process.platform } = {}) {
  const warnings = [];
  const byId = new Map();
  const order = [];
  const add = (entry, source) => {
    if (!entry || typeof entry !== 'object' || !ID_RE.test(entry.id || '')) {
      warnings.push(`${source}: skipped provider with invalid id ${JSON.stringify(entry && entry.id)}`);
      return;
    }
    if (byId.has(entry.id)) {
      byId.set(entry.id, { ...byId.get(entry.id), ...entry });
    } else {
      byId.set(entry.id, { ...entry });
      order.push(entry.id);
    }
  };

  for (const entry of readJson(DEFAULTS_FILE).providers) add(entry, 'defaults');

  if (userFile && fs.existsSync(userFile)) {
    try {
      const user = readJson(userFile);
      const list = Array.isArray(user) ? user : user.providers;
      if (!Array.isArray(list)) throw new Error('expected a "providers" array');
      for (const entry of list) add(entry, userFile);
    } catch (err) {
      warnings.push(`${userFile}: ${err.message}; using built-in providers only`);
    }
  }

  const providers = order.map((id) => normalize(byId.get(id), platform)).filter((p) => p.enabled);
  return { providers, warnings };
}

export class ProviderRegistry extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.userFile]
   * @param {object} [opts.env]
   * @param {string} [opts.platform]
   * @param {string} [opts.iconDir]
   * @param {string} [opts.registryUrl]   npm registry for lookups and installs; default: npm's own configuration
   * @param {boolean} [opts.checkUpdates] false skips registry lookups entirely
   * @param {Function} [opts.fetchImpl]
   */
  constructor({ userFile, env, platform = process.platform, iconDir, registryUrl = null, checkUpdates = true, fetchImpl } = {}) {
    super();
    this.userFile = userFile;
    this.env = env || process.env;
    this.platform = platform;
    this.iconDir = iconDir;
    this.registryUrl = registryUrl || null;
    this.checkUpdates = checkUpdates;
    this.fetchImpl = fetchImpl;
    this.versions = new Map();
    this._refreshing = null;
    this._npmRegistry = null;
    this.reload();
  }

  reload() {
    const { providers, warnings } = loadProviders({ userFile: this.userFile, platform: this.platform });
    this.providers = providers;
    this.warnings = warnings;
    this._npmRegistry = null;
    for (const w of warnings) console.warn(`[providers] ${w}`);
    this.emit('updated');
  }

  /**
   * The registry that installs use: the configured one, else npm's global
   * configuration, which is what `npm install -g` reads (a project .npmrc
   * in the launch directory does not apply to it).
   */
  npmRegistryUrl() {
    if (this.registryUrl) return Promise.resolve(this.registryUrl);
    this._npmRegistry ??= (async () => {
      const npm = this.resolveNpm();
      if (!npm) return DEFAULT_NPM_REGISTRY;
      try {
        const spec = buildSpawnSpec(npm, ['config', 'get', 'registry', '--global'], this.env, this.platform);
        const url = (await runSpec(spec, { env: this.env, timeoutMs: 10000 })).stdout.trim();
        return /^https?:\/\/\S+$/.test(url) ? url : DEFAULT_NPM_REGISTRY;
      } catch {
        return DEFAULT_NPM_REGISTRY;
      }
    })();
    return this._npmRegistry;
  }

  /**
   * Check installed and latest versions. Cheap when nothing changed: a
   * tool is re-run only when its file changed, hourly, or a few minutes
   * after a failed probe, and the registry is asked hourly, unless `force`.
   * Emits "updated" when a version changed.
   */
  refreshVersions({ force = false, ids = null } = {}) {
    const run = () => this._refreshVersions({ force, ids });
    const pending = this._refreshing ? this._refreshing.then(run, run) : run();
    this._refreshing = pending;
    pending.finally(() => { if (this._refreshing === pending) this._refreshing = null; }).catch(() => {});
    return pending;
  }

  async _refreshVersions({ force, ids }) {
    const now = Date.now();
    let changed = false;
    const providers = this.providers.filter((p) => !ids || ids.includes(p.id));
    const lookups = this.checkUpdates && providers.some((p) => p.package);
    const registryUrl = lookups ? await this.npmRegistryUrl() : null;
    await Promise.all(providers.map(async (provider) => {
      const entry = this.versions.get(provider.id) ||
        { installed: null, installedPath: null, installedMtime: null, installedAt: 0, latest: null, latestAt: 0 };
      const resolved = provider.versionArgs ? this.resolve(provider) : null;
      if (resolved) {
        const mtime = fileMtime(resolved);
        const ttl = entry.installed === null ? FAILED_PROBE_TTL_MS : VERSION_TTL_MS;
        const stale = entry.installedPath !== resolved || entry.installedMtime !== mtime || now - entry.installedAt > ttl;
        if (force || stale) {
          const spec = buildSpawnSpec(resolved, provider.versionArgs, this.env, this.platform);
          const installed = await installedVersion(spec, { env: { ...this.env, ...provider.env } });
          changed ||= installed !== entry.installed;
          Object.assign(entry, { installed, installedPath: resolved, installedMtime: mtime, installedAt: now });
        }
      } else if (entry.installedPath !== null) {
        Object.assign(entry, { installed: null, installedPath: null, installedMtime: null, installedAt: 0 });
        changed = true;
      }
      if (provider.package && lookups && (force || now - entry.latestAt > VERSION_TTL_MS)) {
        const latest = await latestVersion(provider.package, { registryUrl, fetchImpl: this.fetchImpl });
        changed ||= latest !== entry.latest;
        Object.assign(entry, { latest, latestAt: now });
      }
      this.versions.set(provider.id, entry);
    }));
    if (changed) this.emit('updated');
  }

  /** Tell clients the list changed (a tool was installed) and re-check versions. */
  notifyChanged(ids = null) {
    this.emit('updated');
    this.refreshVersions({ force: true, ids }).catch(() => {});
  }

  get(id) {
    return this.providers.find((p) => p.id === id) || null;
  }

  commandFor(provider) {
    return provider.command === '@shell' ? defaultShell(this.env, this.platform) : provider.command;
  }

  resolve(provider) {
    return resolveCommand(this.commandFor(provider), { ...this.env, ...provider.env }, this.platform);
  }

  resolveNpm() {
    return resolveCommand('npm', this.env, this.platform);
  }

  iconUrl(provider) {
    if (provider.icon) return provider.icon;
    if (this.iconDir && fs.existsSync(path.join(this.iconDir, `${provider.id}.svg`))) {
      return `/icons/${provider.id}.svg`;
    }
    return null;
  }

  /** Public description, including whether the tool is installed. */
  describe(provider) {
    const resolvedPath = this.resolve(provider);
    const versions = this.versions.get(provider.id);
    const installed = resolvedPath ? versions?.installed ?? null : null;
    const latest = versions?.latest ?? null;
    return {
      id: provider.id,
      vendor: provider.vendor,
      tool: provider.tool,
      command: this.commandFor(provider),
      package: provider.package,
      args: provider.args,
      resumable: provider.resumeArgs.length > 0,
      installable: Boolean(provider.package && this.resolveNpm()),
      installedVersion: installed,
      latestVersion: latest,
      updateAvailable: Boolean(installed && latest && compareVersions(latest, installed) > 0),
      usageSource: provider.usage === null ? null : typeof provider.usage === 'string' ? provider.usage : 'command',
      modelPattern: provider.modelPattern,
      color: provider.color,
      monogram: provider.monogram,
      iconUrl: this.iconUrl(provider),
      install: provider.install,
      docs: provider.docs,
      available: Boolean(resolvedPath),
      resolvedPath,
    };
  }

  list() {
    return this.providers.map((p) => this.describe(p));
  }

  /** Spawn spec for node-pty, or throws with a user-facing message. */
  spawnSpec(provider, extraArgs = [], resume = null) {
    const resolved = this.resolve(provider);
    if (!resolved) {
      const hint = provider.install ? ` ${provider.install}` : '';
      const err = new Error(`${provider.tool} ("${this.commandFor(provider)}") was not found on PATH.${hint}`);
      err.status = 409;
      err.code = 'provider_unavailable';
      throw err;
    }
    let resumeArgs = [];
    if (resume !== null) {
      if (provider.resumeArgs.length === 0) {
        const err = new Error(`${provider.tool} has no resumeArgs configured, so an existing session cannot be resumed`);
        err.status = 400;
        err.code = 'resume_unsupported';
        throw err;
      }
      resumeArgs = provider.resumeArgs.map((arg) => arg.replaceAll('{id}', resume));
    }
    return buildSpawnSpec(resolved, [...provider.args, ...resumeArgs, ...extraArgs], this.env, this.platform);
  }

  /** Spawn spec that installs or updates the provider's npm package. */
  installSpec(provider) {
    if (!provider.package) {
      const err = new Error(`${provider.tool} has no npm package configured; install it by hand: ${provider.install || provider.docs || 'see its documentation'}`);
      err.status = 400;
      err.code = 'not_installable';
      throw err;
    }
    const npm = this.resolveNpm();
    if (!npm) {
      const err = new Error('npm was not found on PATH. Install Node.js from https://nodejs.org and restart the session manager.');
      err.status = 409;
      err.code = 'npm_unavailable';
      throw err;
    }
    const args = ['install', '-g', `${provider.package}@latest`];
    if (this.registryUrl) args.push('--registry', this.registryUrl);
    return buildSpawnSpec(npm, args, this.env, this.platform);
  }
}
