// Remaining usage per provider, read from the same sign-in the coding tool
// uses. Credentials never leave the manager; clients only get percentages.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveCommand, buildSpawnSpec, runSpec } from './command-resolver.mjs';

export const USAGE_TTL_MS = 60 * 1000;
const RATE_LIMITED_TTL_MS = 5 * 60 * 1000;
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

export class UsageError extends Error {}

function shortPath(file) {
  const home = os.homedir();
  return file.startsWith(home) ? `~${file.slice(home.length)}` : file;
}

export function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, Math.round(n * 10) / 10));
}

/** ISO time from an ISO string, epoch seconds or epoch milliseconds. */
export function toIso(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && /^\d+$/.test(value)) return toIso(Number(value));
  const ms = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function windowLabel(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return 'usage';
  if (s % 86400 === 0) return `${s / 86400}-day`;
  return `${Math.round(s / 3600)}-hour`;
}

// ---- Claude Code ----------------------------------------------------------

export function claudeCredentialsFile(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
}

/** The keychain item Claude Code uses: keyed to CLAUDE_CONFIG_DIR when set. */
export function claudeKeychainService(env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR;
  if (!dir) return CLAUDE_KEYCHAIN_SERVICE;
  return `${CLAUDE_KEYCHAIN_SERVICE}-${crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;
}

function readKeychainItem(service) {
  const spec = { file: 'security', args: ['find-generic-password', '-s', service, '-w'] };
  return runSpec(spec, { timeoutMs: 30000 }).then((r) => r.stdout, () => null);
}

/**
 * Claude Code keeps its OAuth token in the macOS keychain, and in
 * .credentials.json elsewhere or when the keychain is unavailable.
 */
export async function readClaudeCredentials({
  file = claudeCredentialsFile(),
  keychain = process.platform === 'darwin',
  service = CLAUDE_KEYCHAIN_SERVICE,
  readKeychain = readKeychainItem,
} = {}) {
  let raw = null;
  if (keychain) raw = await readKeychain(service);
  if (raw === null) {
    try {
      raw = await fs.promises.readFile(file, 'utf8');
    } catch {
      throw new UsageError(`Claude Code is not signed in on this machine (no ${keychain ? 'keychain item or ' : ''}${shortPath(file)})`);
    }
  }
  let creds;
  try { creds = JSON.parse(raw); } catch { throw new UsageError('Claude Code credentials could not be parsed'); }
  const oauth = creds?.claudeAiOauth || creds;
  if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken) {
    throw new UsageError('Claude Code is signed in with an API key, which has no subscription usage');
  }
  if (Number.isFinite(oauth.expiresAt) && oauth.expiresAt < Date.now()) {
    throw new UsageError('Claude Code sign-in has expired; run claude once to refresh it');
  }
  return { accessToken: oauth.accessToken, plan: oauth.subscriptionType || null };
}

export async function fetchClaudeUsage({ accessToken, plan = null, version = null, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(CLAUDE_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': `claude-code/${version || '2.1.0'}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw httpUsageError(res.status, 'sign in again in Claude Code');
  const body = await res.json();
  const windows = [];
  for (const [key, label] of [['five_hour', '5-hour'], ['seven_day', '7-day'], ['seven_day_opus', '7-day Opus'], ['seven_day_sonnet', '7-day Sonnet']]) {
    const w = body?.[key];
    const used = clampPercent(w?.utilization);
    if (used !== null) windows.push({ label, usedPercent: used, resetsAt: toIso(w.resets_at) });
  }
  return { plan, windows };
}

// ---- Codex CLI ------------------------------------------------------------

export function codexAuthFile(env = process.env) {
  return path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
}

export async function readCodexCredentials({ file = codexAuthFile() } = {}) {
  let raw;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch {
    throw new UsageError(`Codex CLI is not signed in on this machine (no ${shortPath(file)})`);
  }
  let auth;
  try { auth = JSON.parse(raw); } catch { throw new UsageError('Codex CLI credentials could not be parsed'); }
  const token = auth?.tokens?.access_token;
  if (typeof token !== 'string' || !token) {
    throw new UsageError('Codex CLI is signed in with an API key, which has no subscription usage');
  }
  return { accessToken: token, accountId: auth.tokens.account_id || null };
}

export async function fetchCodexUsage({ accessToken, accountId = null, fetchImpl = fetch } = {}) {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'agent-guild' };
  if (accountId) headers['ChatGPT-Account-Id'] = accountId;
  const res = await fetchImpl(CODEX_USAGE_URL, { headers, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw httpUsageError(res.status, 'sign in again in Codex CLI');
  const body = await res.json();
  const limits = body?.rate_limit ?? body?.rateLimit ?? {};
  const windows = [];
  for (const key of ['primary_window', 'primaryWindow', 'secondary_window', 'secondaryWindow']) {
    const w = limits[key];
    const used = clampPercent(w?.used_percent ?? w?.usedPercent);
    if (used === null) continue;
    const seconds = w.limit_window_seconds ?? w.limitWindowSeconds;
    const resetAt = w.reset_at ?? w.resetAt;
    const resetAfter = w.reset_after_seconds ?? w.resetAfterSeconds;
    const resetsAt = toIso(resetAt) ?? (Number.isFinite(Number(resetAfter)) ? new Date(Date.now() + Number(resetAfter) * 1000).toISOString() : null);
    windows.push({ label: windowLabel(seconds), usedPercent: used, resetsAt });
  }
  return { plan: body?.plan_type ?? body?.planType ?? null, windows };
}

// ---- any command that prints JSON ------------------------------------------

export async function commandUsage({ command, args = [] }, env, platform = process.platform) {
  const resolved = resolveCommand(command, env, platform);
  if (!resolved) throw new UsageError(`usage command "${command}" was not found on PATH`);
  const spec = buildSpawnSpec(resolved, args, env, platform);
  let stdout;
  try {
    ({ stdout } = await runSpec(spec, { env }));
  } catch (err) {
    throw new UsageError(`usage command failed: ${String(err.stderr || err.message).trim().slice(0, 200)}`);
  }
  let body;
  try { body = JSON.parse(stdout); } catch { throw new UsageError('usage command did not print JSON'); }
  if (!Array.isArray(body?.windows)) throw new UsageError('usage command output has no "windows" array');
  const windows = [];
  for (const w of body.windows) {
    const used = clampPercent(w?.usedPercent ?? (w?.remainingPercent === undefined ? undefined : 100 - Number(w.remainingPercent)));
    if (used === null) continue;
    windows.push({ label: String(w.label || 'usage').slice(0, 40), usedPercent: used, resetsAt: toIso(w.resetsAt) });
  }
  return { plan: body.plan ? String(body.plan).slice(0, 40) : null, windows };
}

function httpUsageError(status, signInHint) {
  if (status === 401 || status === 403) return new UsageError(`usage endpoint refused the sign-in (HTTP ${status}); ${signInHint}`);
  if (status === 429) return Object.assign(new UsageError('usage endpoint is rate limiting requests; retrying later'), { rateLimited: true });
  return new UsageError(`usage endpoint answered HTTP ${status}`);
}

// ---- monitor ----------------------------------------------------------------

export class UsageMonitor {
  /**
   * @param {object} opts
   * @param {import('./providers.mjs').ProviderRegistry} opts.registry
   * @param {object} [opts.env]
   * @param {Function} [opts.fetchImpl]
   * @param {number} [opts.ttlMs]
   * @param {object} [opts.readers]  credential readers, replaceable in tests
   */
  constructor({ registry, env = process.env, platform = process.platform, fetchImpl = fetch, ttlMs = USAGE_TTL_MS, readers = {} } = {}) {
    this.registry = registry;
    this.env = env;
    this.platform = platform;
    this.fetchImpl = fetchImpl;
    this.ttlMs = ttlMs;
    this.readers = { claude: readClaudeCredentials, codex: readCodexCredentials, ...readers };
    this.cache = new Map();
  }

  /** Snapshots for every provider that has a usage source. */
  all() {
    return Promise.all(this.registry.providers.filter((p) => p.usage).map((p) => this.snapshot(p)));
  }

  snapshot(provider) {
    const entry = this.cache.get(provider.id);
    const now = Date.now();
    if (entry?.inflight) return entry.inflight;
    if (entry && now - entry.at < entry.ttl) return Promise.resolve(entry.snapshot);
    const inflight = this._fetch(provider).then((snapshot) => {
      const ttl = snapshot.rateLimited ? RATE_LIMITED_TTL_MS : this.ttlMs;
      this.cache.set(provider.id, { snapshot, at: Date.now(), ttl });
      return snapshot;
    });
    this.cache.set(provider.id, { ...entry, inflight });
    return inflight;
  }

  async _fetch(provider) {
    const base = { providerId: provider.id, plan: null, windows: [], fetchedAt: new Date().toISOString(), error: null };
    const env = { ...this.env, ...provider.env };
    try {
      let result;
      if (provider.usage === 'claude') {
        const creds = await this.readers.claude({
          file: claudeCredentialsFile(env),
          keychain: this.platform === 'darwin',
          service: claudeKeychainService(env),
        });
        result = await fetchClaudeUsage({ ...creds, version: this.registry.versions.get(provider.id)?.installed, fetchImpl: this.fetchImpl });
      } else if (provider.usage === 'codex') {
        const creds = await this.readers.codex({ file: codexAuthFile(env) });
        result = await fetchCodexUsage({ ...creds, fetchImpl: this.fetchImpl });
      } else {
        result = await commandUsage(provider.usage, env, this.platform);
      }
      return { ...base, ...result };
    } catch (err) {
      const message = err instanceof UsageError ? err.message : `usage check failed: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`;
      return { ...base, error: message, ...(err.rateLimited ? { rateLimited: true } : {}) };
    }
  }
}
