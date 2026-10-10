// The instruction files each coding tool loads when a session starts in a working folder:
// CLAUDE.md, AGENTS.md, GEMINI.md and rules files people wrote for it. Each tool's own rules are
// reproduced for Claude Code 2.1.296, Codex 0.162.1 and Antigravity CLI 1.3.2; Grok Build 1.0.50
// is asked with `grok inspect --json`. Nothing here creates or edits a file.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCommand, buildSpawnSpec, runSpec } from './command-resolver.mjs';
import { claudeConfigDir, codexHome } from './session-history.mjs';
import { claudeProjectRoot, MAX_READ_BYTES, MemoryError } from './agent-memory.mjs';

export const INSTRUCTION_SOURCES = new Set(['claude', 'codex', 'grok', 'google']);
export const GROK_INSPECT_TIMEOUT_MS = 3000;
const CODEX_MAX_BYTES = 32 * 1024;

function statFile(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function readJson(file) {
  const text = readText(file);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** `dir` and every folder above it, outermost first. */
function foldersDown(dir) {
  const folders = [];
  for (let at = dir; ; at = path.dirname(at)) {
    folders.unshift(at);
    if (path.dirname(at) === at) return folders;
  }
}

/** The folders of `folders` at or below `ceiling`, or all of them without one. */
function within(folders, ceiling) {
  if (!ceiling) return folders;
  const top = folders.findIndex((dir) => path.relative(ceiling, dir) === '');
  return top < 0 ? folders : folders.slice(top);
}

/** Markdown files directly inside `dir`, by name. */
function markdownIn(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => /\.md$/i.test(name)).sort().map((name) => path.join(dir, name)).filter(statFile);
  } catch {
    return [];
  }
}

const row = (file, scope, skipped = null, note = null) => ({ file, scope, skipped, note });

// ---- Claude Code ----------------------------------------------------------

/** A glob as picomatch reads it with `dot: true`: `*`, `**`, `?`, `[...]` and `{a,b}`. */
export function globPattern(glob) {
  let out = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const segment = (i === 0 || glob[i - 1] === '/') && (i + 2 === glob.length || glob[i + 2] === '/');
      if (segment && glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end < 0) out += '\\[';
      else { out += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`; i = end; }
    } else if (c === '{') { braces++; out += '(?:'; }
    else if (c === '}' && braces) { braces--; out += ')'; }
    else if (c === ',' && braces) out += '|';
    else if (c === '\\' && i + 1 < glob.length) out += `\\${glob[++i]}`;
    else out += c.replace(/[.+^$()|\]{}]/g, '\\$&');
  }
  try { return new RegExp(`^${out}$`); } catch { return null; }
}

function claudeExcludes(config, cwd, platform) {
  const sources = [path.join(config, 'settings.json'), path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')];
  const patterns = sources.flatMap((file) => {
    const value = readJson(file)?.claudeMdExcludes;
    return Array.isArray(value) ? value.filter((p) => typeof p === 'string' && p) : [];
  });
  const regexes = patterns.map((p) => globPattern(platform === 'win32' ? p.replaceAll('\\', '/') : p)).filter(Boolean);
  return (file) => {
    const slashed = file.replaceAll('\\', '/');
    return regexes.some((re) => re.test(slashed));
  };
}

function claudeRows(env, cwd, platform, ceiling) {
  const config = claudeConfigDir(env);
  const excluded = claudeExcludes(config, cwd, platform);
  const keep = (file, scope) => row(file, scope, excluded(file) ? 'Matches claudeMdExcludes in Claude Code settings.' : null);
  const rows = [path.join(config, 'CLAUDE.md')].filter(statFile).concat(markdownIn(path.join(config, 'rules'))).map((file) => keep(file, 'global'));
  // Walking through the home folder meets ~/.claude/CLAUDE.md again; a global file is not a project one.
  const global = new Set(rows.map((r) => realPath(r.file)));
  const found = (files) => files.filter((file) => statFile(file) && !global.has(realPath(file))).map((file) => keep(file, 'project'));
  const agents = [];
  let claudeFile = null;
  for (const dir of within(foldersDown(cwd), ceiling)) {
    const own = found([path.join(dir, 'CLAUDE.md'), path.join(dir, '.claude', 'CLAUDE.md'), path.join(dir, 'CLAUDE.local.md')]);
    claudeFile ??= own.find((r) => !r.skipped)?.file ?? null;
    const agentRows = found([path.join(dir, 'AGENTS.md'), path.join(dir, '.claude', 'AGENTS.md')]);
    agents.push(...agentRows);
    rows.push(...own, ...agentRows, ...found(markdownIn(path.join(dir, '.claude', 'rules'))));
  }
  if (claudeFile) {
    for (const r of agents) r.skipped ??= `Skipped because ${realPath(claudeFile)} was found.`;
  }
  return { rows };
}

// ---- Codex ------------------------------------------------------------------

/** A TOML basic string's body, unescaped; null when it holds an escape JSON does not share. */
function basic(body) {
  try { return JSON.parse(`"${body}"`); } catch { return null; }
}

/** A TOML string, array of strings or integer, as a value in config.toml; undefined for anything else. */
function tomlValue(text) {
  const value = text.trim();
  if (/^-?\d[\d_]*$/.test(value)) return Number(value.replaceAll('_', ''));
  const quoted = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(value);
  if (quoted) return quoted[2] ?? basic(quoted[1]);
  if (value.startsWith('[')) {
    const items = [];
    const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
    for (let m; (m = re.exec(value));) items.push(m[2] ?? basic(m[1]));
    return items;
  }
  return undefined;
}

function tomlKey(text) {
  const key = text.trim();
  const quoted = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)')$/.exec(key);
  return quoted ? quoted[2] ?? basic(quoted[1]) : key;
}

/**
 * The parts of config.toml that decide which AGENTS.md files load: three top-level keys and each
 * project's `trust_level`, from `[projects.'<path>']` tables or inline tables under `[projects]`.
 */
export function codexConfig(text) {
  const top = {};
  const trust = new Map();
  let table = '';
  const lines = (text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/^\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const header = /^\[([^\[].*)\]\s*(?:#.*)?$/.exec(line);
    if (header) { table = header[1].trim(); continue; }
    const eq = /^((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+))\s*=\s*(.*)$/.exec(line);
    if (!eq) continue;
    let value = eq[2];
    if (value.startsWith('[')) {
      while (!/\]\s*(?:#.*)?$/.test(value) && i + 1 < lines.length) value += ` ${lines[++i].trim()}`;
    }
    const key = tomlKey(eq[1]);
    if (!table) top[key] = tomlValue(value);
    else if (table.startsWith('projects.') && key === 'trust_level') trust.set(tomlKey(table.slice(9)), tomlValue(value));
    else if (table === 'projects') {
      const level = /trust_level\s*=\s*("[^"]*"|'[^']*')/.exec(value);
      trust.set(key, level ? tomlValue(level[1]) : undefined);
    }
  }
  const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string') : undefined);
  return {
    rootMarkers: strings(top.project_root_markers) ?? ['.git'],
    fallbackNames: strings(top.project_doc_fallback_filenames) ?? [],
    maxBytes: Number.isInteger(top.project_doc_max_bytes) && top.project_doc_max_bytes >= 0 ? top.project_doc_max_bytes : CODEX_MAX_BYTES,
    trust,
  };
}

/** Codex's own project lookup: the working folder, then the repository root, each real path before its spelling. */
function codexUntrusted(trust, cwd, platform) {
  const fold = (key) => (platform === 'win32' ? key.toLowerCase() : key);
  const root = claudeProjectRoot(cwd);
  const keys = [cwd, root].flatMap((p) => [realPath(p), p]).map(fold);
  const entries = [...trust].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const key of keys) {
    const hit = trust.has(key) ? [key, trust.get(key)] : entries.find(([candidate]) => fold(candidate) === key);
    if (hit) return hit[1] === 'untrusted';
  }
  return false;
}

function exists(file) {
  try { fs.statSync(file); return true; } catch { return false; }
}

function codexRows(env, cwd, platform) {
  const home = codexHome(env);
  const config = codexConfig(readText(path.join(home, 'config.toml')));
  const rows = [];
  const override = path.join(home, 'AGENTS.override.md');
  const global = path.join(home, 'AGENTS.md');
  const blank = (file) => !(readText(file) ?? '').trim();
  if (statFile(override) && !blank(override)) {
    rows.push(row(override, 'global'));
    if (statFile(global)) rows.push(row(global, 'global', 'AGENTS.override.md is used instead.'));
  } else {
    if (statFile(override)) rows.push(row(override, 'global', 'Empty, so Codex reads AGENTS.md instead.'));
    if (statFile(global)) rows.push(row(global, 'global', blank(global) ? 'Empty, so Codex skips it.' : null));
  }
  if (codexUntrusted(config.trust, cwd, platform)) {
    return { rows, projectNote: 'Folder not trusted. config.toml marks it untrusted, so Codex loads no project files here.' };
  }
  let root = null;
  if (config.rootMarkers.length) {
    for (let dir = cwd; ; dir = path.dirname(dir)) {
      if (config.rootMarkers.some((marker) => exists(path.join(dir, marker)))) { root = dir; break; }
      if (path.dirname(dir) === dir) break;
    }
  }
  const folders = root ? foldersDown(cwd).slice(foldersDown(root).length - 1) : [cwd];
  const names = ['AGENTS.override.md', 'AGENTS.md'];
  for (const name of config.fallbackNames) {
    const bad = name === '.' || name === '..' || /[/\0]/.test(name) || (platform === 'win32' && /[\\:]/.test(name));
    if (name && !bad && !names.includes(name)) names.push(name);
  }
  let remaining = config.maxBytes;
  for (const dir of folders) {
    const found = names.map((name) => path.join(dir, name)).filter(statFile);
    if (!found.length) continue;
    const [chosen, ...others] = found;
    if (remaining === 0) {
      rows.push(row(chosen, 'project', config.maxBytes === 0 ? 'project_doc_max_bytes is 0, so Codex loads no project files.' : `Codex stops here: the ${config.maxBytes}-byte project_doc_max_bytes budget is used up.`));
    } else {
      const data = fs.readFileSync(chosen);
      const kept = data.subarray(0, remaining);
      if (!kept.toString('utf8').trim()) rows.push(row(chosen, 'project', 'Empty, so Codex skips it.'));
      else {
        rows.push(row(chosen, 'project', null, data.length > remaining ? `Codex reads only the first ${remaining} bytes (project_doc_max_bytes).` : null));
        remaining -= kept.length;
      }
    }
    for (const other of others) rows.push(row(other, 'project', `${path.basename(chosen)} in this folder is used instead.`));
  }
  return { rows };
}

// ---- Grok Build -------------------------------------------------------------

/** `grok inspect --json` run in `cwd`, parsed. Throws with a message for the card when it cannot answer. */
export async function grokInspect(command, cwd, env, platform = process.platform) {
  const grok = resolveCommand(command, env, platform);
  if (!grok) throw new Error('Grok Build was not found, so its instruction files could not be listed.');
  let stdout;
  try {
    ({ stdout } = await runSpec(buildSpawnSpec(grok, ['inspect', '--json'], env, platform), { env, cwd, timeoutMs: GROK_INSPECT_TIMEOUT_MS }));
  } catch (err) {
    throw new Error(err.killed ? `grok inspect did not answer within ${GROK_INSPECT_TIMEOUT_MS / 1000} seconds.` : `grok inspect failed: ${(err.stderr || err.message || '').trim().split('\n')[0]}`);
  }
  try { return JSON.parse(stdout); } catch { throw new Error('grok inspect did not return JSON.'); }
}

async function grokRows(env, cwd, platform, inspect, command) {
  const report = await inspect(command, cwd, env, platform);
  const listed = Array.isArray(report?.projectInstructions) ? report.projectInstructions.filter((f) => typeof f?.path === 'string') : [];
  const rows = listed.map((f) => row(path.resolve(cwd, f.path), f.scope === 'global' ? 'global' : 'project'));
  return { rows, projectNote: report?.projectTrusted === false ? 'Folder not trusted. Grok Build loads no project files here until you trust it.' : null };
}

// ---- Google (Antigravity CLI) -----------------------------------------------

/** A rule file loads at session start only with `trigger: always_on` in its frontmatter. */
function alwaysOn(file) {
  const lines = (readText(file) ?? '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return false;
  for (let i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
    const trigger = /^trigger\s*:\s*["']?([\w-]+)["']?\s*(?:#.*)?$/.exec(lines[i].trim());
    if (trigger) return trigger[1] === 'always_on';
  }
  return false;
}

function googleRows(env, cwd, platform) {
  const gemini = path.join((platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir(), '.gemini');
  const rules = (dir) => markdownIn(path.join(dir, 'rules')).filter(alwaysOn);
  const global = ['GEMINI.md', 'AGENTS.md', path.join('config', 'GEMINI.md'), path.join('config', 'AGENTS.md')]
    .map((name) => path.join(gemini, name)).filter(statFile).concat(rules(path.join(gemini, 'config')));
  let root = cwd;
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (exists(path.join(dir, '.git'))) { root = dir; break; }
    if (path.dirname(dir) === dir) break;
  }
  const project = foldersDown(cwd).slice(foldersDown(root).length - 1).flatMap((dir) => [
    ...['GEMINI.md', 'AGENTS.md'].map((name) => path.join(dir, name)).filter(statFile),
    ...['.agents', '.agent', '_agents', '_agent'].flatMap((name) => rules(path.join(dir, name))),
  ]);
  return { rows: [...global.map((file) => row(file, 'global')), ...project.map((file) => row(file, 'project'))] };
}

// ---- monitor ----------------------------------------------------------------

/** The file's real path, its name in the case it has on disk. */
function realPath(file) {
  let real;
  try { real = fs.realpathSync.native(file); } catch { return file; }
  const name = path.basename(real);
  try {
    const names = fs.readdirSync(path.dirname(real));
    if (names.includes(name)) return real;
    const onDisk = names.find((other) => other.toLowerCase() === name.toLowerCase());
    return onDisk ? path.join(path.dirname(real), onDisk) : real;
  } catch {
    return real;
  }
}

export class InstructionFiles {
  /** `ceiling` (tests only) is the highest folder Claude Code's walk reaches. */
  constructor({ env = process.env, platform = process.platform, resolveCwd, inspect = grokInspect, ceiling = null }) {
    this.env = env;
    this.platform = platform;
    this.resolveCwd = resolveCwd;
    this.inspect = inspect;
    this.ceiling = ceiling;
  }

  async list(provider, account, cwd) {
    const source = provider.instructions;
    if (!INSTRUCTION_SOURCES.has(source)) throw new MemoryError(400, 'instructions_unsupported', `${provider.tool} has no instruction files configured`);
    const folder = this.resolveCwd(cwd);
    const env = { ...this.env, ...provider.env, ...account.env };
    const base = { providerId: provider.id, accountId: account.id, folder, fetchedAt: new Date().toISOString() };
    let resolved;
    try {
      resolved = source === 'claude' ? claudeRows(env, folder, this.platform, this.ceiling)
        : source === 'codex' ? codexRows(env, folder, this.platform)
          : source === 'google' ? googleRows(env, folder, this.platform)
            : await grokRows(env, folder, this.platform, this.inspect, provider.command || 'grok');
    } catch (err) {
      if (source !== 'grok') throw err;
      return { ...base, count: null, note: err.message, scopes: [] };
    }
    const seen = new Set();
    const files = [];
    for (const r of resolved.rows) {
      const real = realPath(r.file);
      const key = this.platform === 'win32' ? real.toLowerCase() : real;
      const stat = statFile(real);
      if (seen.has(key) || !stat) continue;
      seen.add(key);
      files.push({ index: files.length, path: real, scope: r.scope, bytes: stat.size, modified: stat.mtime.toISOString(), skipped: r.skipped, note: r.note });
    }
    const scopes = [
      { id: 'global', label: 'Global', note: null, files: files.filter((f) => f.scope === 'global') },
      { id: 'project', label: 'Project', note: resolved.projectNote ?? null, files: files.filter((f) => f.scope === 'project') },
    ];
    return { ...base, count: files.filter((f) => !f.skipped).length, note: null, scopes };
  }

  /** Reads the file at `index` of a freshly resolved list, only while it is still `expected` there. */
  async read(provider, account, cwd, index, expected) {
    const { scopes } = await this.list(provider, account, cwd);
    const entry = scopes.flatMap((s) => s.files).find((f) => String(f.index) === String(index));
    if (!entry || entry.path !== expected) throw new MemoryError(404, 'instruction_file_gone', 'This file is no longer in the list. Refresh it.');
    if (!/\.md$/i.test(entry.path)) throw new MemoryError(400, 'bad_instruction_path', 'Only markdown files can be read.');
    let handle;
    try { handle = await fs.promises.open(entry.path, 'r'); } catch { throw new MemoryError(404, 'instruction_file_gone', 'This file is no longer in the list. Refresh it.'); }
    try {
      const stat = await handle.stat();
      const buffer = Buffer.alloc(Math.min(stat.size, MAX_READ_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return { index: entry.index, scope: entry.scope, path: entry.path, bytes: stat.size, modified: stat.mtime.toISOString(), truncated: stat.size > MAX_READ_BYTES, text: buffer.toString('utf8', 0, bytesRead) };
    } finally {
      await handle.close();
    }
  }
}
