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

function notSignedIn(message) {
  return Object.assign(new UsageError(message), { notSignedIn: true });
}

function shortPath(file) {
  const home = os.homedir();
  return file.startsWith(home) ? `~${file.slice(home.length)}` : file;
}

/** A finite number from a number or a numeric string, else null. */
export function toNumber(value) {
  if (typeof value === 'string' && value.trim() !== '') value = Number(value);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A percentage from a number or numeric string, or null when it is unknown. */
export function clampPercent(value) {
  const n = toNumber(value);
  if (n === null) return null;
  return Math.min(100, Math.max(0, Math.round(n * 10) / 10));
}

/** ISO time from an ISO string, epoch seconds or epoch milliseconds. */
export function toIso(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && /^\d+$/.test(value)) return toIso(Number(value));
  const ms = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The first value that is a non-blank string, trimmed, else null. */
function firstText(...values) {
  return values.find((v) => typeof v === 'string' && v.trim() !== '')?.trim() ?? null;
}

/** Adds a window, keeping labels within 40 characters and unique: a repeat gets " (2)", " (3)", … */
function addWindow(windows, window) {
  const base = String(window.label).slice(0, 35);
  let label = base;
  for (let n = 2; windows.some((w) => w.label.toLowerCase() === label.toLowerCase()); n++) label = `${base} (${n})`;
  windows.push({ ...window, label });
}

export function windowLabel(seconds, fallback = 'usage') {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return fallback;
  if (s % 86400 === 0) return `${s / 86400}-day`;
  return `${Math.round(s / 3600)}-hour`;
}

// ---- Claude Code ----------------------------------------------------------

/**
 * The directory Claude Code keeps credentials under. As in Claude Code,
 * CLAUDE_SECURESTORAGE_CONFIG_DIR wins when defined (empty means the
 * default directory), else CLAUDE_CONFIG_DIR, and paths are NFC-normalised.
 */
function claudeCredentialsDir(env) {
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const dir = (secure !== undefined ? secure : env.CLAUDE_CONFIG_DIR) || path.join(os.homedir(), '.claude');
  return dir.normalize('NFC');
}

export function claudeCredentialsFile(env = process.env) {
  return path.join(claudeCredentialsDir(env), '.credentials.json');
}

/** The keychain item Claude Code uses: the default one, or one keyed to a custom directory. */
export function claudeKeychainService(env = process.env) {
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const custom = secure !== undefined ? secure : env.CLAUDE_CONFIG_DIR;
  if (!custom) return CLAUDE_KEYCHAIN_SERVICE;
  const hash = crypto.createHash('sha256').update(claudeCredentialsDir(env)).digest('hex').slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${hash}`;
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
      throw notSignedIn(`Claude Code is not signed in on this machine (no ${keychain ? 'keychain item or ' : ''}${shortPath(file)})`);
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
  const multiplier = typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier.match(/_(\d+)x$/)?.[1] : null;
  const plan = oauth.subscriptionType ? `${oauth.subscriptionType}${multiplier ? ` ${multiplier}x` : ''}` : null;
  return { accessToken: oauth.accessToken, plan };
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
  // Per-model weekly windows arrive as rows in `limits`, the way Claude
  // Code's own /usage screen reads them; Fable is reported only there. A
  // plan-wide row named for a fixed window above ("Sonnet") repeats it and
  // is skipped. A row scoped to a surface as well ("Sonnet" in Cowork) is
  // a different limit and is kept under both names, as is a versioned
  // model ("Opus 4.8"), since whether it shares the family's pool is not
  // knowable here and a repeated meter loses nothing. Every row is shown:
  // `is_active` only marks the server's headline row.
  const fixed = windows.map((w) => w.label.toLowerCase());
  const rows = Array.isArray(body?.limits) ? body.limits.filter((row) => row && typeof row === 'object') : [];
  for (const row of rows) {
    if (row.kind !== 'weekly_scoped') continue;
    const { model, surface } = row.scope ?? {};
    const name = firstText(model?.display_name, model?.name, model?.id);
    const where = firstText(surface?.display_name, surface?.name, surface?.id);
    const used = clampPercent(row.percent);
    if (!name || used === null) continue;
    const label = where ? `7-day ${name} (${where})` : `7-day ${name}`;
    if (where || !fixed.includes(label.toLowerCase())) addWindow(windows, { label, usedPercent: used, resetsAt: toIso(row.resets_at) });
  }
  // Extra usage is the paid pool that takes over once the included windows
  // are spent. The share is computed from the spend and the monthly limit
  // (both in minor currency units) when both are known, else taken from
  // `utilization`, which is 0-100 like the windows above. Its period ends
  // when the `spend` row says, the headline one when several are listed.
  const extra = body?.extra_usage;
  if (extra?.is_enabled === true) {
    const limit = toNumber(extra.monthly_limit);
    const spent = toNumber(extra.used_credits);
    const used = clampPercent(limit !== null && limit > 0 && spent !== null ? (spent / limit) * 100 : extra.utilization);
    const spend = rows.filter((row) => row.kind === 'spend');
    const period = spend.find((row) => row.is_active === true) ?? spend[0];
    if (used !== null) windows.push({ label: 'Extra usage', usedPercent: used, resetsAt: toIso(period?.resets_at) });
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
    throw notSignedIn(`Codex CLI is not signed in on this machine (no ${shortPath(file)})`);
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
  const windows = codexWindows(body?.rate_limit ?? body?.rateLimit);
  // Limits metered apart from the plan's main windows, one entry per
  // feature or model (`limit_name`), each with its own windows.
  const additional = body?.additional_rate_limits ?? body?.additionalRateLimits;
  for (const entry of Array.isArray(additional) ? additional : []) {
    if (!entry || typeof entry !== 'object') continue;
    const name = firstText(entry.limit_name, entry.limitName, entry.metered_feature, entry.meteredFeature);
    if (!name) continue;
    // The name is shortened, never the window, so both windows of one limit stay apart.
    for (const w of codexWindows(entry.rate_limit ?? entry.rateLimit ?? entry)) addWindow(windows, { ...w, label: `${name.slice(0, 28)} ${w.label}` });
  }
  // Prepaid credits are a balance, not a window: null unless the account has
  // a finite, metered balance.
  const credits = body?.credits;
  const balance = toNumber(credits?.balance);
  return {
    plan: body?.plan_type ?? body?.planType ?? null,
    windows,
    credits: credits?.has_credits === true && credits.unlimited !== true ? balance : null,
  };
}

/**
 * The 5-hour and weekly windows of one Codex rate limit, in either key
 * style. A window of unstated length keeps its position as its label.
 */
function codexWindows(limits) {
  const windows = [];
  if (!limits || typeof limits !== 'object') return windows;
  for (const [key, position] of [['primary_window', 'primary'], ['primaryWindow', 'primary'], ['secondary_window', 'secondary'], ['secondaryWindow', 'secondary']]) {
    const w = limits[key];
    const used = clampPercent(w?.used_percent ?? w?.usedPercent);
    if (used === null) continue;
    const seconds = w.limit_window_seconds ?? w.limitWindowSeconds;
    const resetAt = w.reset_at ?? w.resetAt;
    const resetAfter = toNumber(w.reset_after_seconds ?? w.resetAfterSeconds);
    const resetsAt = toIso(resetAt) ?? (resetAfter !== null ? new Date(Date.now() + resetAfter * 1000).toISOString() : null);
    windows.push({ label: windowLabel(seconds, position), usedPercent: used, resetsAt });
  }
  return windows;
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
    const remaining = toNumber(w?.remainingPercent);
    const used = clampPercent(w?.usedPercent ?? (remaining === null ? undefined : 100 - remaining));
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

  /** Snapshots for every account of every provider that has a usage source. */
  all() {
    const jobs = [];
    for (const provider of this.registry.providers) {
      if (!provider.usage) continue;
      for (const account of this.registry.accountsFor(provider)) jobs.push(this.snapshot(provider, account));
    }
    return Promise.all(jobs);
  }

  snapshot(provider, account = this.registry.account(provider)) {
    const key = `${provider.id}\0${account.id}`;
    const entry = this.cache.get(key);
    const now = Date.now();
    if (entry?.inflight) return entry.inflight;
    if (entry && now - entry.at < entry.ttl) return Promise.resolve(entry.snapshot);
    const inflight = this._fetch(provider, account).then((snapshot) => {
      const ttl = snapshot.rateLimited ? RATE_LIMITED_TTL_MS : this.ttlMs;
      this.cache.set(key, { snapshot, at: Date.now(), ttl });
      return snapshot;
    });
    this.cache.set(key, { ...entry, inflight });
    return inflight;
  }

  async _fetch(provider, account) {
    const base = { providerId: provider.id, accountId: account.id, plan: null, windows: [], credits: null, signedIn: null, fetchedAt: new Date().toISOString(), error: null };
    const env = { ...this.env, ...provider.env, ...account.env };
    let signedIn = null;
    try {
      let result;
      if (provider.usage === 'claude') {
        const creds = await this.readers.claude({
          file: claudeCredentialsFile(env),
          keychain: this.platform === 'darwin',
          service: claudeKeychainService(env),
        });
        signedIn = true;
        result = await fetchClaudeUsage({ ...creds, version: this.registry.versions.get(provider.id)?.installed, fetchImpl: this.fetchImpl });
      } else if (provider.usage === 'codex') {
        const creds = await this.readers.codex({ file: codexAuthFile(env) });
        signedIn = true;
        result = await fetchCodexUsage({ ...creds, fetchImpl: this.fetchImpl });
      } else {
        result = await commandUsage(provider.usage, env, this.platform);
      }
      return { ...base, signedIn, ...result };
    } catch (err) {
      const message = err instanceof UsageError ? err.message : `usage check failed: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`;
      return { ...base, signedIn: err.notSignedIn ? false : signedIn, error: message, ...(err.rateLimited ? { rateLimited: true } : {}) };
    }
  }
}
