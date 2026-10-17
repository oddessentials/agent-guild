import fs from 'node:fs';
import { buildSpawnSpec, runSpec } from './command-resolver.mjs';

export const HELP_TIMEOUT_MS = 10000;
export const HELP_MAX_BYTES = 256 * 1024;
const ENTRY_RE = /^(--?[A-Za-z0-9][\w-]*)( <value>)?$/;

export function normalizeLaunchFlags(raw, id, warnings) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push(`provider "${id}": ignored launchFlags; it must be a list`);
    return [];
  }
  const flags = [];
  for (const entry of raw) {
    const match = typeof entry === 'string' ? entry.trim().match(ENTRY_RE) : null;
    if (!match) {
      warnings.push(`provider "${id}": skipped launch flag ${JSON.stringify(entry)}`);
      continue;
    }
    if (!flags.some((f) => f.flag === match[1])) flags.push({ flag: match[1], value: Boolean(match[2]) });
  }
  return flags;
}

const indentOf = (line) => line.length - line.trimStart().length;

export function helpEntry(help, flag) {
  const lines = help.split(/\r?\n/);
  const names = new RegExp(`^(\\s+)(?:-[\\w-]+,\\s*)*${flag.replace(/-/g, '\\-')}(?:,\\s*-[\\w-]+)*(?=[\\s=\\[]|$)`);
  let at = -1;
  let found = null;
  lines.forEach((line, i) => {
    const match = line.match(names);
    if (match && (!found || match[1].length < found[1].length)) [at, found] = [i, match];
  });
  if (!found) return null;
  const indent = lines[at].indexOf(flag, found[1].length);
  const [head, ...first] = lines[at].slice(found[0].length).split(/ {2,}/);
  const placeholder = head.trim();
  const value = !placeholder ? 'none' : placeholder.startsWith('[') || placeholder.includes('[=') ? 'optional' : 'required';
  const paragraphs = [[first.join(' ').trim()].filter(Boolean)];
  for (const line of lines.slice(at + 1)) {
    if (!line.trim()) {
      paragraphs.push([]);
      continue;
    }
    if (indentOf(line) <= indent) break;
    const text = line.trim();
    if (text.startsWith('- ')) paragraphs.push([]);
    paragraphs.at(-1).push(text);
  }
  return { value, about: paragraphs.map((p) => p.join(' ')).filter(Boolean).join('\n') };
}

export function offeredFlags(help, entries) {
  return entries.flatMap(({ flag, value }) => {
    const entry = helpEntry(help, flag);
    return entry ? [{ flag, value: value ? 'required' : entry.value, about: entry.about }] : [];
  });
}

export class LaunchFlags {
  constructor(registry, { timeoutMs = HELP_TIMEOUT_MS, maxBytes = HELP_MAX_BYTES } = {}) {
    this.registry = registry;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.cache = new Map();
  }

  async list(provider) {
    if (!provider.launchFlags.length) return { flags: [], error: null };
    const resolved = this.registry.resolve(provider);
    if (!resolved) return { flags: [], error: `${provider.tool} is not installed.` };
    let mtime = null;
    try { mtime = fs.statSync(resolved).mtimeMs; } catch { /* read it anyway */ }
    const key = JSON.stringify([resolved, mtime, this.registry.versions?.get(provider.id)?.installed ?? null, provider.args, provider.launchFlags]);
    const cached = this.cache.get(provider.id);
    if (cached?.key === key && !cached.failed) return cached.promise;
    const entry = { key, failed: false };
    entry.promise = this._help(provider, resolved).then(
      (help) => ({ flags: offeredFlags(help, provider.launchFlags), error: null }),
      (err) => {
        entry.failed = true;
        return { flags: [], error: `Could not read ${provider.tool}'s help: ${err.message}` };
      },
    );
    this.cache.set(provider.id, entry);
    return entry.promise;
  }

  async _help(provider, resolved) {
    const env = { ...this.registry.env, ...provider.env };
    const spec = buildSpawnSpec(resolved, [...provider.args, '--help'], env, this.registry.platform);
    let out;
    try {
      out = await runSpec(spec, { env, timeoutMs: this.timeoutMs, maxBuffer: this.maxBytes });
    } catch (err) {
      if (err.killed) throw new Error(`it took longer than ${this.timeoutMs / 1000} seconds`);
      if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error(`it printed more than ${Math.round(this.maxBytes / 1024)} KB`);
      if (!`${err.stdout ?? ''}${err.stderr ?? ''}`.trim()) throw err;
      out = err;
    }
    return `${out.stdout ?? ''}\n${out.stderr ?? ''}`;
  }
}
