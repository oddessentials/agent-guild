// Past sessions of each coding tool, read from where the tool itself keeps
// them. Only the head of a transcript is read, and a file is parsed again
// only when its size or mtime changed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { resolveCommand, buildSpawnSpec, runSpec } from './command-resolver.mjs';
import { toIso } from './usage.mjs';
import { antigravityUserConversation } from '../report/hooks.mjs';
import { ANTIGRAVITY_ID, transcriptFile, readAntigravityTranscript, historyError } from './antigravity-transcript.mjs';

export const HISTORY_TTL_MS = 5 * 1000;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;
const HEAD_BYTES = 256 * 1024;
const MAX_TITLE = 120;
const MAX_ID = 200;
const MAX_WALK_DEPTH = 4;

export class HistoryError extends Error {}

const TAG_RE = /^<[a-z][a-z0-9_-]*[\s>]/i;

function shortPath(file) {
  const home = os.homedir();
  return file.startsWith(home) ? `~${file.slice(home.length)}` : file;
}

/** One line of prompt text, or null for an empty or tool-inserted (`<tag>…`) message. */
function promptTitle(text) {
  if (typeof text !== 'string') return null;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean || TAG_RE.test(clean)) return null;
  return clean.slice(0, MAX_TITLE);
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part === 'string' ? part : part && typeof part.text === 'string' ? part.text : '')).filter(Boolean).join('\n');
}

function parseLines(text) {
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* a cut-off or foreign line */ }
  }
  return records;
}

async function readHead(file, bytes = HEAD_BYTES) {
  if (file.endsWith('.zst')) {
    if (typeof zlib.createZstdDecompress !== 'function') return null;
    const source = fs.createReadStream(file);
    const inflate = source.pipe(zlib.createZstdDecompress());
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of inflate) {
        chunks.push(chunk);
        size += chunk.length;
        if (size >= bytes) break;
      }
    } finally {
      source.destroy();
    }
    return Buffer.concat(chunks).subarray(0, bytes).toString('utf8');
  }
  const handle = await fs.promises.open(file, 'r');
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(bytes), 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readDir(dir) {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw new HistoryError(`${shortPath(dir)} could not be read: ${err.message}`);
  }
}

async function readText(file) {
  try { return await fs.promises.readFile(file, 'utf8'); } catch { return null; }
}

function newestFirst(a, b) {
  return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || (b.startedAt ?? '').localeCompare(a.startedAt ?? '') || a.id.localeCompare(b.id);
}

export function cleanEntry({ id, title, cwd, startedAt, updatedAt }) {
  const cleanId = String(id ?? '').trim();
  if (!cleanId || cleanId.length > MAX_ID || /\p{Cc}/u.test(cleanId)) return null;
  const folder = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : null;
  return {
    id: cleanId,
    title: typeof title === 'string' && title.trim() ? title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) : null,
    cwd: folder,
    startedAt: toIso(startedAt),
    updatedAt: toIso(updatedAt),
  };
}

function dedupe(entries) {
  const byId = new Map();
  for (const entry of entries) {
    const known = byId.get(entry.id);
    if (!known || newestFirst(entry, known) < 0) byId.set(entry.id, entry);
  }
  return [...byId.values()].sort(newestFirst);
}

export class FileMemo {
  constructor() {
    this.entries = new Map();
  }

  async entry(file, stat, parse) {
    const known = this.entries.get(file);
    if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.entry;
    let entry = null;
    try { entry = await parse(); } catch { /* unreadable or not a transcript */ }
    this.entries.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, entry });
    return entry;
  }

  prune(root, seen) {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    for (const file of this.entries.keys()) {
      if (file.startsWith(prefix) && !seen.has(file)) this.entries.delete(file);
    }
  }
}

async function statFile(file) {
  try {
    const stat = await fs.promises.stat(file);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

// ---- Claude Code ----------------------------------------------------------

export function claudeConfigDir(env = process.env) {
  return (env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')).normalize('NFC');
}

function claudeEntry(id, text, stat) {
  let cwd = null;
  let startedAt = null;
  let title = null;
  let seenUser = false;
  for (const record of parseLines(text)) {
    if (!record || typeof record !== 'object') continue;
    if (cwd === null && typeof record.cwd === 'string') cwd = record.cwd;
    if (startedAt === null && record.timestamp) startedAt = record.timestamp;
    if (record.type === 'custom-title' && typeof record.customTitle === 'string' && record.customTitle.trim()) title = record.customTitle;
    if (record.type !== 'user' || record.isSidechain === true) continue;
    seenUser = true;
    if (title === null) title = promptTitle(contentText(record.message?.content));
  }
  if (cwd === null && !seenUser) return null;
  return cleanEntry({ id, title, cwd, startedAt, updatedAt: stat.mtime });
}

/** Sessions under `<dir>/projects/<folder>/<id>.jsonl`; sub-agent transcripts sit in sub-folders and are not listed. */
export async function listClaudeSessions(dir, memo = new FileMemo()) {
  const root = path.join(dir, 'projects');
  const entries = [];
  const seen = new Set();
  for (const project of await readDir(root)) {
    if (!project.isDirectory()) continue;
    const folder = path.join(root, project.name);
    for (const item of await readDir(folder)) {
      if (!item.isFile() || !item.name.endsWith('.jsonl')) continue;
      const file = path.join(folder, item.name);
      const stat = await statFile(file);
      if (!stat) continue;
      seen.add(file);
      const id = item.name.slice(0, -'.jsonl'.length);
      const entry = await memo.entry(file, stat, async () => claudeEntry(id, await readHead(file), stat));
      if (entry) entries.push(entry);
    }
  }
  memo.prune(root, seen);
  return dedupe(entries);
}

// ---- Codex CLI ------------------------------------------------------------

export function codexHome(env = process.env) {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function codexPrompt(record) {
  const payload = record?.payload;
  if (!payload || typeof payload !== 'object') return null;
  if (record.type === 'event_msg') {
    if (payload.type === 'user_message') return promptTitle(payload.message);
    if (payload.type === 'item_completed' && payload.item?.type === 'UserMessage') return promptTitle(contentText(payload.item.content));
    return null;
  }
  if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user') return promptTitle(contentText(payload.content));
  return null;
}

function codexEntry(text, stat) {
  const records = parseLines(text);
  const meta = records.find((r) => r?.type === 'session_meta')?.payload;
  if (!meta || typeof meta !== 'object') return null;
  const id = meta.id ?? meta.session_id;
  if (typeof meta.source === 'object' && meta.source !== null) return null;
  if (meta.parent_thread_id || (meta.thread_source && meta.thread_source !== 'user')) return null;
  let title = null;
  for (const record of records) {
    title = codexPrompt(record);
    if (title) break;
  }
  return cleanEntry({ id, title, cwd: meta.cwd, startedAt: meta.timestamp ?? records[0]?.timestamp, updatedAt: stat.mtime });
}

async function walk(dir, depth, onFile) {
  for (const item of await readDir(dir)) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (depth > 0) await walk(file, depth - 1, onFile);
    } else if (item.isFile()) await onFile(file, item.name);
  }
}

/** Rollouts under `<dir>/sessions/YYYY/MM/DD/rollout-*.jsonl`, uncompressed or zstd-compressed. Sub-agent threads are skipped. */
export async function listCodexSessions(dir, memo = new FileMemo()) {
  const root = path.join(dir, 'sessions');
  const entries = [];
  const seen = new Set();
  await walk(root, MAX_WALK_DEPTH, async (file, name) => {
    if (!/^rollout-.*\.jsonl(\.zst)?$/.test(name)) return;
    const stat = await statFile(file);
    if (!stat) return;
    seen.add(file);
    const entry = await memo.entry(file, stat, async () => {
      const head = await readHead(file);
      return head === null ? null : codexEntry(head, stat);
    });
    if (entry) entries.push(entry);
  });
  memo.prune(root, seen);
  return dedupe(entries);
}

// ---- Antigravity CLI ------------------------------------------------------

export function antigravityDir(env = process.env, platform = process.platform) {
  return path.join((platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir(), '.gemini', 'antigravity-cli');
}

/** Only local, absolute file URIs; never turn a remote URI into a launch folder. */
export function antigravityWorkspaces(raw, platform = process.platform) {
  let values;
  try { values = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(values)) return [];
  const folders = [];
  for (const value of values) {
    try {
      if (typeof value !== 'string') continue;
      const url = new URL(value);
      if (url.protocol !== 'file:' || url.hostname || url.search || url.hash) continue;
      // The explicit windows option is available on all supported Node 22 releases.
      const folder = fileURLToPath(url, { windows: platform === 'win32' });
      if (/\p{Cc}/u.test(folder) || !folder) continue;
      if (!folders.some((known) => sameHistoryFolder(known, folder, platform))) folders.push(folder);
    } catch { /* malformed URI or a path for another OS */ }
  }
  return folders;
}

export function sameHistoryFolder(a, b, platform = process.platform) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const normalize = (value) => {
    if (typeof value !== 'string' || !api.isAbsolute(value)) return null;
    const normalized = api.normalize(value).replace(platform === 'win32' ? /[\\/]+$/ : /\/+$/, '') || '/';
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const left = normalize(a), right = normalize(b);
  return left !== null && right !== null && left === right;
}

function antigravityEntry(id, text, stat) {
  let first;
  try { first = JSON.parse((text ?? '').split('\n', 1)[0]); } catch { return null; }
  if (!antigravityUserConversation(first) || typeof first.content !== 'string') return null;
  const request = first.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/)?.[1];
  return cleanEntry({ id, title: promptTitle(request), startedAt: first.created_at, updatedAt: stat.mtime });
}

/** Legacy fallback. Multiple cache paths for one id cannot identify a launch folder. */
async function antigravityFolders(dir, platform) {
  const folders = new Map();
  let latest = null;
  try { latest = JSON.parse(await readText(path.join(dir, 'cache', 'last_conversations.json'))); } catch { /* none yet */ }
  if (!latest || typeof latest !== 'object') return folders;
  for (const [folder, id] of Object.entries(latest)) {
    if (!ANTIGRAVITY_ID.test(id) || !sameHistoryFolder(folder, folder, platform)) continue;
    if (folders.has(id) && !sameHistoryFolder(folders.get(id), folder, platform)) folders.set(id, null);
    else if (!folders.has(id)) folders.set(id, folder);
  }
  return folders;
}

// Verified against CLI 1.3.1. This is a disposable index shared with the desktop app.
// Selecting named columns validates the schema; no raw_summary or conversation blobs are decoded.
async function antigravitySummaries(dir) {
  const file = path.join(dir, 'conversation_summaries.db');
  let db;
  try {
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular database');
    const { DatabaseSync } = await loadSqlite();
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare(`SELECT conversation_id, title, preview, workspace_uris, app_data_dir,
      parent_conversation_id, nesting_depth, step_count FROM conversation_summaries`).all();
    return { rows: new Map(rows.filter((r) => typeof r.conversation_id === 'string').map((r) => [r.conversation_id, r])), note: null };
  } catch {
    return { rows: new Map(), note: 'Some session folders and titles may be unavailable. Showing readable local transcripts.' };
  } finally { db?.close(); }
}

/** Conversations under `<dir>/brain/<id>/.system_generated/logs/transcript.jsonl`. */
export async function listAntigravitySessions(dir, memo = new FileMemo(), { platform = process.platform, withStatus = false } = {}) {
  const root = path.join(dir, 'brain');
  const folders = await antigravityFolders(dir, platform);
  const summaries = await antigravitySummaries(dir);
  const entries = [];
  const seen = new Set();
  for (const item of await readDir(root)) {
    if (!item.isDirectory() || !ANTIGRAVITY_ID.test(item.name)) continue;
    const summary = summaries.rows.get(item.name);
    if (summary && (summary.app_data_dir !== 'antigravity-cli' || summary.parent_conversation_id !== ''
      || summary.nesting_depth !== 0 || !(summary.step_count > 0))) continue;
    // A cached summary without a readable user transcript is never a resumable history entry.
    let file;
    try { file = await transcriptFile(dir, item.name); } catch { continue; }
    const stat = await statFile(file);
    if (!stat) continue;
    seen.add(file);
    const entry = await memo.entry(file, stat, async () => antigravityEntry(item.name, await readHead(file), stat));
    if (entry) {
      const workspaces = summary ? antigravityWorkspaces(summary.workspace_uris, platform) : [];
      const cwd = workspaces.length === 1 ? workspaces[0] : workspaces.length ? null : folders.get(entry.id) ?? null;
      const title = promptTitle(summary?.title) || promptTitle(summary?.preview) || entry.title;
      entries.push({ ...entry, title, cwd, ...(withStatus ? { workspaces: workspaces.length ? workspaces : cwd ? [cwd] : [] } : {}) });
    }
  }
  memo.prune(root, seen);
  const sessions = dedupe(entries);
  return withStatus ? { sessions, note: sessions.length ? summaries.note : null } : sessions;
}

// ---- Docker Agent ---------------------------------------------------------

export function dockerAgentDataDir(env = process.env) {
  return env.DOCKER_AGENT_DATA_DIR || env.CAGENT_DATA_DIR || path.join(os.homedir(), '.cagent');
}

let sqlite = null;
async function loadSqlite() {
  if (!sqlite) {
    // Node.js 22 to 24 print "SQLite is an experimental feature" to stderr when the module loads; the manager's log
    // need not carry it. The warning is emitted synchronously by the import, so the filter covers only that call.
    const emitWarning = process.emitWarning;
    process.emitWarning = (warning, ...rest) => {
      if (/SQLite/.test(String(warning?.message ?? warning))) return;
      emitWarning.call(process, warning, ...rest);
    };
    try {
      sqlite = await import('node:sqlite');
    } catch {
      throw new HistoryError('Docker Agent history needs Node.js 22.13 or newer, which has node:sqlite');
    } finally {
      process.emitWarning = emitWarning;
    }
  }
  return sqlite;
}

// A session's title, else its first user message; the newest message dates it. A sub-agent's session has a parent.
const DOCKER_SESSIONS_SQL = `
  select s.id, s.title, s.created_at, s.working_dir,
    (select i.message_json from session_items i where i.session_id = s.id and i.item_type = 'message' order by i.position limit 1) as first_message,
    (select max(json_extract(i.message_json, '$.created_at')) from session_items i where i.session_id = s.id) as updated_at
  from sessions s where s.parent_id is null order by s.created_at desc limit ${MAX_LIMIT}`;

function dockerEntry(row) {
  let title = typeof row.title === 'string' && row.title.trim() ? row.title : null;
  if (!title && typeof row.first_message === 'string') {
    try {
      const message = JSON.parse(row.first_message);
      if (message?.role === 'user') title = promptTitle(contentText(message.content));
    } catch { /* not a message */ }
  }
  return cleanEntry({ id: row.id, title, cwd: row.working_dir, startedAt: row.created_at, updatedAt: row.updated_at ?? row.created_at });
}

/** Sessions in `<dir>/session.db`, Docker Agent's SQLite store, opened read-only. */
export async function listDockerSessions(dir) {
  const file = path.join(dir, 'session.db');
  if (!(await statFile(file))) return [];
  const { DatabaseSync } = await loadSqlite();
  let db = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    return dedupe(db.prepare(DOCKER_SESSIONS_SQL).all().map(dockerEntry).filter(Boolean));
  } catch (err) {
    throw new HistoryError(`${shortPath(file)} could not be read: ${err.message}`);
  } finally {
    db?.close();
  }
}

// ---- Grok Build -----------------------------------------------------------

export function grokHome(env = process.env) {
  return env.GROK_HOME || path.join(os.homedir(), '.grok');
}

/** The folder a Grok Build session bucket stands for: its percent-encoded name, else its `.cwd` file. */
async function grokBucketCwd(bucket) {
  let decoded = null;
  try { decoded = decodeURIComponent(path.basename(bucket)); } catch { /* not percent-encoded */ }
  if (decoded && (decoded.startsWith('/') || /^[A-Za-z]:[\\/]/.test(decoded))) return decoded;
  return (await readText(path.join(bucket, '.cwd')))?.trim() || null;
}

function grokPrompt(text) {
  const parts = [];
  let promptId;
  for (const record of parseLines(text)) {
    const update = record?.params?.update;
    if (update?.sessionUpdate !== 'user_message_chunk' || update.content?.type !== 'text') continue;
    if (update.content._meta?.bash_command || update._meta?.host_turn === true) continue;
    const id = record.params._meta?.promptId ?? null;
    if (parts.length && id !== promptId) break;
    promptId = id;
    parts.push(update.content.text);
  }
  return promptTitle(parts.join(''));
}

async function grokEntry(folder, summary, stat, bucketCwd) {
  const info = summary?.info;
  if (!summary || typeof summary !== 'object') return null;
  if (summary.hidden === true || String(summary.session_kind ?? '').startsWith('subagent')) return null;
  let title = [summary.generated_title, summary.session_summary].find((t) => typeof t === 'string' && t.trim()) ?? null;
  if (summary.num_messages === 0 && !title) return null;
  if (title === null) {
    const updates = await readHead(path.join(folder, 'updates.jsonl')).catch(() => null);
    if (updates) title = grokPrompt(updates);
  }
  return cleanEntry({
    id: info?.id ?? path.basename(folder),
    title,
    cwd: typeof info?.cwd === 'string' && info.cwd ? info.cwd : bucketCwd,
    startedAt: summary.created_at,
    updatedAt: summary.last_active_at ?? summary.updated_at ?? stat.mtime,
  });
}

/** Sessions under `<dir>/sessions/<percent-encoded folder>/<id>/summary.json`. Hidden and sub-agent sessions are skipped. */
export async function listGrokSessions(dir, memo = new FileMemo()) {
  const root = path.join(dir, 'sessions');
  const entries = [];
  const seen = new Set();
  for (const bucket of await readDir(root)) {
    if (!bucket.isDirectory()) continue;
    const bucketDir = path.join(root, bucket.name);
    const cwd = await grokBucketCwd(bucketDir);
    for (const item of await readDir(bucketDir)) {
      if (!item.isDirectory()) continue;
      const folder = path.join(bucketDir, item.name);
      const file = path.join(folder, 'summary.json');
      const stat = await statFile(file);
      if (!stat) continue;
      seen.add(file);
      const entry = await memo.entry(file, stat, async () => grokEntry(folder, JSON.parse(await readText(file)), stat, cwd));
      if (entry) entries.push(entry);
    }
  }
  memo.prune(root, seen);
  return dedupe(entries);
}

// ---- any command that prints JSON ------------------------------------------

export async function commandHistory({ command, args = [] }, env, platform = process.platform) {
  const resolved = resolveCommand(command, env, platform);
  if (!resolved) throw new HistoryError(`history command "${command}" was not found on PATH`);
  const spec = buildSpawnSpec(resolved, args, env, platform);
  let stdout;
  try {
    ({ stdout } = await runSpec(spec, { env }));
  } catch (err) {
    throw new HistoryError(`history command failed: ${String(err.stderr || err.message).trim().slice(0, 200)}`);
  }
  let body;
  try { body = JSON.parse(stdout); } catch { throw new HistoryError('history command did not print JSON'); }
  if (!Array.isArray(body?.sessions)) throw new HistoryError('history command output has no "sessions" array');
  return dedupe(body.sessions.map((s) => (s && typeof s === 'object' ? cleanEntry(s) : null)).filter(Boolean));
}

// ---- monitor ----------------------------------------------------------------

export class SessionHistory {
  /**
   * @param {object} opts
   * @param {import('./providers.mjs').ProviderRegistry} opts.registry
   * @param {object} [opts.env]
   * @param {number} [opts.ttlMs]
   * @param {object} [opts.readers]  session listers by source, replaceable in tests
   */
  constructor({ registry, env = process.env, platform = process.platform, ttlMs = HISTORY_TTL_MS, readers = {} } = {}) {
    this.registry = registry;
    this.env = env;
    this.platform = platform;
    this.ttlMs = ttlMs;
    this.readers = { claude: listClaudeSessions, codex: listCodexSessions, antigravity: listAntigravitySessions, grok: listGrokSessions, docker: listDockerSessions, ...readers };
    this.memo = new FileMemo();
    this.cache = new Map();
  }

  static sourceDir(source, env, platform = process.platform) {
    if (source === 'claude') return claudeConfigDir(env);
    if (source === 'codex') return codexHome(env);
    if (source === 'antigravity') return antigravityDir(env, platform);
    if (source === 'grok') return grokHome(env);
    if (source === 'docker') return dockerAgentDataDir(env);
    return null;
  }

  async list(provider, account = this.registry.account(provider), { limit, cwd, query } = {}) {
    const n = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(limit)) || DEFAULT_LIMIT));
    const snapshot = await this.snapshot(provider, account);
    const search = typeof query === 'string' ? query.trim().toLowerCase().slice(0, 500) : '';
    const sessions = snapshot.sessions.filter((entry) =>
      (!cwd || (entry.workspaces ?? [entry.cwd]).some((folder) => sameHistoryFolder(folder, cwd, this.platform)))
      && (!search || [entry.id, entry.title, ...(entry.workspaces ?? [entry.cwd])].join('\n').toLowerCase().includes(search)));
    return { ...snapshot, total: sessions.length, sessions: sessions.slice(0, n) };
  }

  async detail(provider, account, id, cursor) {
    if (provider.history !== 'antigravity') throw historyError(400, 'history_detail_unsupported', 'This tool has no conversation preview.');
    if (!ANTIGRAVITY_ID.test(id)) throw historyError(400, 'bad_history_id', 'Invalid conversation id.');
    // Revalidate membership, even if the client still has an older list open.
    const snapshot = await this._read(provider, account);
    if (!snapshot.sessions.some((s) => s.id === id)) throw historyError(404, 'history_unavailable', 'This conversation transcript is unavailable.');
    const env = { ...this.env, ...provider.env, ...account.env };
    return readAntigravityTranscript(antigravityDir(env, this.platform), id, cursor);
  }

  snapshot(provider, account) {
    const key = `${provider.id}\0${account.id}`;
    const entry = this.cache.get(key);
    const now = Date.now();
    if (entry?.inflight) return entry.inflight;
    if (entry && now - entry.at < this.ttlMs) return Promise.resolve(entry.snapshot);
    const inflight = this._read(provider, account).then((snapshot) => {
      this.cache.set(key, { snapshot, at: Date.now() });
      return snapshot;
    });
    this.cache.set(key, { ...entry, inflight });
    return inflight;
  }

  async _read(provider, account) {
    const base = { providerId: provider.id, accountId: account.id, sessions: [], total: 0, fetchedAt: new Date().toISOString(), error: null };
    const env = { ...this.env, ...provider.env, ...account.env };
    try {
      const result = typeof provider.history === 'string'
        ? await this.readers[provider.history](SessionHistory.sourceDir(provider.history, env, this.platform), this.memo, { platform: this.platform, withStatus: true })
        : await commandHistory(provider.history, env, this.platform);
      const sessions = Array.isArray(result) ? result : result.sessions;
      return { ...base, sessions, total: sessions.length, ...(Array.isArray(result) ? {} : { note: result.note }) };
    } catch (err) {
      const message = err instanceof HistoryError ? err.message : `history could not be read: ${err.message}`;
      return { ...base, error: message };
    }
  }
}
