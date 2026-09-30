// Provider registry: which coding tools can be launched and how.
//
// Built-in defaults live in config/providers.default.json. Users customise
// them with providers.json in the data directory: entries are merged by `id`,
// new ids are appended, and `"enabled": false` hides a provider. Any field can
// be overridden per platform under a "win32", "darwin" or "linux" key.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCommand, buildSpawnSpec } from './command-resolver.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULTS_FILE = path.resolve(here, '../../config/providers.default.json');
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const PLATFORM_KEYS = ['win32', 'darwin', 'linux'];

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

function normalize(raw, platform) {
  const merged = { ...raw, ...(raw[platform] || {}) };
  for (const key of PLATFORM_KEYS) delete merged[key];
  return {
    id: merged.id,
    vendor: String(merged.vendor || merged.id),
    tool: String(merged.tool || merged.command || ''),
    command: String(merged.command || ''),
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

export class ProviderRegistry {
  constructor({ userFile, env, platform = process.platform, iconDir } = {}) {
    this.userFile = userFile;
    this.env = env || process.env;
    this.platform = platform;
    this.iconDir = iconDir;
    this.reload();
  }

  reload() {
    const { providers, warnings } = loadProviders({ userFile: this.userFile, platform: this.platform });
    this.providers = providers;
    this.warnings = warnings;
    for (const w of warnings) console.warn(`[providers] ${w}`);
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
    return {
      id: provider.id,
      vendor: provider.vendor,
      tool: provider.tool,
      command: this.commandFor(provider),
      args: provider.args,
      resumable: provider.resumeArgs.length > 0,
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
}
