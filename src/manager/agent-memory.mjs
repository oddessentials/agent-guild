// What each coding tool remembers about a working folder, read from where the
// tool itself keeps it. Each tool's own rules for naming a folder's memory are
// reproduced here: Claude Code 2.1, Codex 0.162 and Grok Build 1.0.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blake3 } from '@noble/hashes/blake3.js';
import { resolveCommand, buildSpawnSpec, runSpec } from './command-resolver.mjs';
import { claudeConfigDir, codexHome, grokHome } from './session-history.mjs';

export const MEMORY_SOURCES = new Set(['claude', 'codex', 'grok']);
export const MAX_FILES = 500;
export const MAX_READ_BYTES = 512 * 1024;
const MAX_DEPTH = 6;
const HEAD_BYTES = 4096;

export class MemoryError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const caseless = (platform) => platform === 'win32' || platform === 'darwin';

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function readJson(file) {
  const text = readText(file);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// ---- Claude Code --------------------------------------------------------------

/** Java's String.hashCode, as Claude Code hashes a long project path. */
function stringHash(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return hash;
}

/** The folder name Claude Code gives a project under `<config>/projects`. */
export function claudeProjectSlug(dir) {
  const slug = dir.replace(/[^a-zA-Z0-9]/g, '-');
  return slug.length <= 200 ? slug : `${slug.slice(0, 200)}-${Math.abs(stringHash(dir)).toString(36)}`;
}

/**
 * The folder Claude Code keys a project's memory on: the main checkout of the git repository holding
 * `cwd`, so a linked worktree shares it, else `cwd` itself. A `.git` file is followed only when the
 * worktree's own records point back at it, as Claude Code does.
 */
export function claudeProjectRoot(cwd, pathApi = path) {
  let dir = cwd;
  for (;;) {
    let stat = null;
    try { stat = fs.lstatSync(pathApi.join(dir, '.git')); } catch { /* keep walking up */ }
    if (stat?.isSymbolicLink()) return cwd;
    if (stat?.isDirectory()) return dir;
    if (stat?.isFile()) return linkedWorktreeMain(dir, pathApi) ?? dir;
    const parent = pathApi.dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
}

function linkedWorktreeMain(root, pathApi) {
  const same = (a, b) => (caseless(process.platform) ? a.toLowerCase() === b.toLowerCase() : a === b);
  const pointer = readText(pathApi.join(root, '.git'))?.trim();
  if (!pointer?.startsWith('gitdir:')) return null;
  const gitDir = pathApi.resolve(root, pointer.slice(7).trim());
  const common = readText(pathApi.join(gitDir, 'commondir'))?.trim();
  if (!common) return null;
  const commonDir = pathApi.resolve(gitDir, common);
  if (!same(pathApi.dirname(gitDir), pathApi.join(commonDir, 'worktrees'))) return null;
  const back = readText(pathApi.join(gitDir, 'gitdir'))?.trim();
  if (!back || !same(pathApi.resolve(gitDir, back), pathApi.join(root, '.git'))) return null;
  if (pathApi.basename(commonDir) !== '.git') return fs.existsSync(pathApi.join(commonDir, '.git')) ? null : commonDir;
  return pathApi.dirname(commonDir);
}

/** `autoMemoryDirectory` as Claude Code reads it: `~/` expands, and a drive or root is refused. */
function claudeCustomDir(value) {
  if (typeof value !== 'string' || !value) return null;
  let dir = value;
  if (dir.startsWith('~/') || dir.startsWith('~\\')) dir = path.join(os.homedir(), dir.slice(2));
  dir = path.resolve(dir).replace(/[/\\]+$/, '');
  if (dir.length < 3 || /^[A-Za-z]:$/.test(dir) || dir.includes('\0')) return null;
  return dir;
}

function claudeProjectOverride(root) {
  for (const name of ['settings.json', 'settings.local.json']) {
    if (readJson(path.join(root, '.claude', name))?.autoMemoryDirectory !== undefined) return `.claude/${name}`;
  }
  return null;
}

async function claudeScopes(env, cwd, platform) {
  const config = claudeConfigDir(env);
  const root = claudeProjectRoot(cwd).normalize('NFC');
  const override = claudeProjectOverride(root);
  const overrideNote = override ? `${override} in this project sets autoMemoryDirectory. Claude Code uses it once the folder is trusted, so its memory may be kept elsewhere.` : null;
  const custom = claudeCustomDir(readJson(path.join(config, 'settings.json'))?.autoMemoryDirectory);
  if (custom) {
    return [{ id: 'project', label: 'This project', dir: custom, note: overrideNote ?? 'Your Claude Code settings keep memory in this folder for every project.' }];
  }
  const base = env.CLAUDE_CODE_REMOTE_MEMORY_DIR || config;
  const named = base === config && env.CLAUDE_CONFIG_DIR && /^[A-Za-z0-9_-]{1,64}$/.test(env.CLAUDE_CODE_PROJECT_DIR_NAME || '')
    && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(env.CLAUDE_CODE_PROJECT_DIR_NAME) ? env.CLAUDE_CODE_PROJECT_DIR_NAME : null;
  const slug = named ?? claudeProjectSlug(root);
  const projects = path.join(base, 'projects');
  let names = [slug];
  if (caseless(platform)) {
    try {
      const found = (await fs.promises.readdir(projects)).filter((name) => name.toLowerCase() === slug.toLowerCase()).sort();
      if (found.length) names = found;
    } catch { /* no projects yet */ }
  }
  return names.map((name, i) => ({
    id: i === 0 ? 'project' : `project-${i + 1}`,
    label: names.length > 1 ? `This project (${name})` : 'This project',
    dir: path.join(projects, name, 'memory'),
    note: overrideNote,
  }));
}

// ---- Codex ------------------------------------------------------------------

async function codexScopes(env) {
  const home = codexHome(env);
  const note = 'Codex keeps one memory for every folder, and writes it only while its memories feature is on ([features] memories = true in config.toml).';
  const scopes = [{ id: 'all', label: 'All folders', dir: path.join(home, 'memories'), note, noteWhenEmpty: true }];
  const v2 = path.join(home, 'memories_v2');
  if (fs.existsSync(v2)) scopes.push({ id: 'all-v2', label: 'All folders (memories v2)', dir: v2, note, noteWhenEmpty: true });
  return scopes;
}

// ---- Grok Build -------------------------------------------------------------

/** A git remote URL as Grok Build reduces it to `org/repo`, or null. */
export function normalizeRemoteUrl(url) {
  const colon = url.indexOf(':');
  if (colon < 0) return null;
  const head = url.slice(0, colon);
  let rest;
  if (head.includes('@') && !head.includes('/')) rest = url.slice(colon + 1);
  else {
    const afterScheme = url.split('//')[1];
    if (afterScheme === undefined) return null;
    const slash = afterScheme.indexOf('/');
    if (slash < 0) return null;
    rest = afterScheme.slice(slash + 1);
  }
  while (rest.endsWith('.git')) rest = rest.slice(0, -4);
  rest = rest.replace(/\/+$/, '').replace(/^\/+/, '');
  return rest && rest.includes('/') ? rest : null;
}

/** Grok Build's slug: lowercase, runs of anything but a-z0-9 become one `-`, cut to `max` characters. */
export function grokSlug(text, max = 40) {
  const collapsed = [...text.toLowerCase()].map((c) => (/^[a-z0-9]$/.test(c) ? c : '-')).join('').replace(/-+/g, '-');
  return [...collapsed].slice(0, max).join('').replace(/^-+|-+$/g, '');
}

/**
 * The folder Grok Build keeps a workspace's memory in: named for the repository's `origin`
 * (`org/repo`, so clones and worktrees share it), else for the folder's real path.
 */
export function grokWorkspaceId({ repo, realPath }, pathApi = path) {
  const [source, input] = repo
    ? [repo.split('/').at(-1), repo]
    : [pathApi.basename(realPath) || 'workspace', realPath];
  const slug = grokSlug(source) || 'workspace';
  return `${slug}-${Buffer.from(blake3(Buffer.from(input, 'utf8'))).toString('hex').slice(0, 8)}`;
}

function realDir(dir) {
  try { return fs.realpathSync.native(dir); } catch { return dir; }
}

function isTempFolder(real, raw) {
  const temp = realDir(os.tmpdir());
  const within = (dir, parent) => {
    const rel = path.relative(parent, dir);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const norm = (p) => p.replaceAll('\\', '/');
  return within(real, temp)
    || ['/tmp/', '/var/tmp/', '/private/tmp/', '/private/var/tmp/'].some((prefix) => norm(raw).startsWith(prefix) || norm(real).startsWith(prefix))
    || [raw, real].some((p) => /\/(?:private\/)?var\/folders\//.test(norm(p)) && norm(p).includes('/T/'));
}

/** The `origin` URL of the repository holding `cwd`: a string, null when there is none, or undefined without git. */
export async function originUrl(cwd, env, platform = process.platform) {
  const git = resolveCommand('git', env, platform);
  if (!git) return undefined;
  try {
    const { stdout } = await runSpec(buildSpawnSpec(git, ['-C', cwd, 'config', '--local', '--get', 'remote.origin.url'], env, platform), { env, timeoutMs: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function grokScopes(env, cwd, platform, findOrigin) {
  const root = path.join(grokHome(env), 'memory-v2');
  const global = { id: 'global', label: 'Global', dir: path.join(root, 'global'), note: null };
  const real = realDir(cwd);
  if (isTempFolder(real, cwd)) {
    return [{ id: 'project', label: 'This project', dir: null, note: 'Grok Build keeps no project memory for a folder inside the temporary folder.' }, global];
  }
  const url = await findOrigin(cwd, env, platform);
  const repo = url ? normalizeRemoteUrl(url) : null;
  const project = {
    id: 'project',
    label: 'This project',
    dir: path.join(root, 'workspaces', grokWorkspaceId({ repo, realPath: real })),
    note: url === undefined ? 'git was not found, so this folder was matched by its path. Grok Build matches a repository by its origin remote, so this may not be the memory it uses.' : null,
  };
  return [project, global];
}

// ---- files ------------------------------------------------------------------

const FILE_ORDER = ['memory_summary.md', 'MEMORY.md', 'topics/', 'observations/'];

function fileRank(rel) {
  const i = FILE_ORDER.findIndex((prefix) => (prefix.endsWith('/') ? rel.startsWith(prefix) : rel === prefix));
  return i < 0 ? FILE_ORDER.length : i;
}

/** Markdown files under `dir`, without following links or entering dot folders or Grok's archive. */
async function listFiles(dir) {
  const files = [];
  let truncated = false;
  const walk = async (folder, rel, depth) => {
    let entries;
    try { entries = await fs.promises.readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const child = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !(depth === 0 && entry.name === 'archive')) await walk(child, childRel, depth + 1);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        if (files.length >= MAX_FILES) { truncated = true; return; }
        try {
          const stat = await fs.promises.stat(child);
          files.push({ path: childRel, fullPath: child, folder, title: await headingOf(child), bytes: stat.size, modified: stat.mtime.toISOString() });
        } catch { /* gone since the listing */ }
      }
    }
  };
  await walk(dir, '', 0);
  files.sort((a, b) => fileRank(a.path) - fileRank(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, truncated };
}

/** The first `# ` heading in a file's head, after any frontmatter, or null. */
async function headingOf(file) {
  let text;
  try {
    const handle = await fs.promises.open(file, 'r');
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
      text = buffer.toString('utf8', 0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  let i = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end < 0) return null;
    i = end + 1;
  }
  for (; i < lines.length; i++) {
    const heading = /^#\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (heading) return heading[1].slice(0, 200);
  }
  return null;
}

function within(file, dir) {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ---- monitor ----------------------------------------------------------------

export class AgentMemory {
  constructor({ env = process.env, platform = process.platform, resolveCwd, findOrigin = originUrl }) {
    this.env = env;
    this.platform = platform;
    this.resolveCwd = resolveCwd;
    this.findOrigin = findOrigin;
  }

  async scopes(provider, account, cwd) {
    if (!MEMORY_SOURCES.has(provider.memory)) throw new MemoryError(400, 'memory_unsupported', `${provider.tool} has no memory source configured`);
    const folder = this.resolveCwd(cwd);
    const env = { ...this.env, ...provider.env, ...account.env };
    if (provider.memory === 'claude') return { folder, scopes: await claudeScopes(env, folder, this.platform) };
    if (provider.memory === 'codex') return { folder, scopes: await codexScopes(env) };
    return { folder, scopes: await grokScopes(env, folder, this.platform, this.findOrigin) };
  }

  async list(provider, account, cwd) {
    const { folder, scopes } = await this.scopes(provider, account, cwd);
    const listed = await Promise.all(scopes.map(async ({ noteWhenEmpty, ...scope }) => {
      const { files, truncated } = scope.dir ? await listFiles(scope.dir) : { files: [], truncated: false };
      return { ...scope, note: noteWhenEmpty && files.length ? null : scope.note, files, truncated };
    }));
    return { providerId: provider.id, accountId: account.id, folder, scopes: listed, fetchedAt: new Date().toISOString() };
  }

  async read(provider, account, cwd, scopeId, rel) {
    const { scopes } = await this.scopes(provider, account, cwd);
    const scope = scopes.find((s) => s.id === scopeId);
    if (!scope?.dir) throw new MemoryError(404, 'memory_not_found', 'That memory section does not exist for this folder.');
    const parts = typeof rel === 'string' ? rel.split('/') : [];
    if (!parts.length || parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.') || /[\\\0:]/.test(part)) || !/\.md$/i.test(rel)) {
      throw new MemoryError(400, 'bad_memory_path', 'Only markdown files inside a memory folder can be read.');
    }
    const file = path.join(scope.dir, ...parts);
    let real, stat;
    try {
      stat = await fs.promises.lstat(file);
      real = await fs.promises.realpath(file);
    } catch {
      throw new MemoryError(404, 'memory_file_gone', 'This file is gone. Refresh the list.');
    }
    if (!stat.isFile() || !within(real, await fs.promises.realpath(scope.dir))) {
      throw new MemoryError(400, 'bad_memory_path', 'Only markdown files inside a memory folder can be read.');
    }
    const handle = await fs.promises.open(real, 'r');
    try {
      const size = (await handle.stat()).size;
      const buffer = Buffer.alloc(Math.min(size, MAX_READ_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return { scope: scope.id, path: rel, bytes: size, modified: stat.mtime.toISOString(), truncated: size > MAX_READ_BYTES, text: buffer.toString('utf8', 0, bytesRead) };
    } finally {
      await handle.close();
    }
  }
}
