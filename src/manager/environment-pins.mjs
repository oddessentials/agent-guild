// Project pin files only. A pin is what a file asks for, never proof that a
// runtime is installed or which binary a shell would execute.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PIN_LIMIT = 64 * 1024;
export const PIN_TEXT_MAX = 128;

export const PIN_NAMES = [
  '.nvmrc', '.node-version', '.python-version', 'package.json', 'pyproject.toml',
  'rust-toolchain.toml', 'rust-toolchain', 'go.mod', 'global.json', '.tool-versions',
];

const TOOL_VERSIONS = {
  node: ['tool-versions-node', 'Node.js'],
  nodejs: ['tool-versions-node', 'Node.js'],
  python: ['tool-versions-python', 'Python'],
  go: ['tool-versions-go', 'Go'],
  golang: ['tool-versions-go', 'Go'],
  rust: ['tool-versions-rust', 'Rust'],
  dotnet: ['tool-versions-dotnet', '.NET SDK'],
  'dotnet-sdk': ['tool-versions-dotnet', '.NET SDK'],
};

function pin(id, label, source, status, version = null, detail = null) {
  return { id, label, source, version, status, detail };
}

function configured(id, label, source, version) {
  const text = typeof version === 'string' ? version.trim() : '';
  if (!text) return pin(id, label, source, 'invalid', null, 'The pin is empty.');
  if (text.length > PIN_TEXT_MAX) return pin(id, label, source, 'invalid', null, 'The pin is longer than 128 characters.');
  return pin(id, label, source, 'configured', text);
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function versionLine(text) {
  for (const raw of stripBom(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    return line;
  }
  return null;
}

function textPin(id, label, source, text) {
  const line = versionLine(text);
  if (line === null) return [pin(id, label, source, 'invalid', null, 'The pin file has no version.')];
  return [configured(id, label, source, line)];
}

function packagePins(text) {
  let data;
  try { data = JSON.parse(stripBom(text)); } catch {
    return [pin('package-json', 'package.json', 'package.json', 'invalid', null, 'package.json could not be read as JSON.')];
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return [pin('package-json', 'package.json', 'package.json', 'invalid', null, 'package.json could not be read as JSON.')];
  }
  const pins = [];
  if (data.engines !== undefined) {
    if (!data.engines || typeof data.engines !== 'object' || Array.isArray(data.engines)) {
      pins.push(pin('engines', 'package.json', 'package.json', 'invalid', null, 'engines is not an object.'));
    } else {
      for (const [key, id, label] of [['node', 'engines-node', 'Node.js'], ['npm', 'engines-npm', 'npm']]) {
        if (data.engines[key] === undefined) continue;
        if (typeof data.engines[key] !== 'string') pins.push(pin(id, label, 'package.json', 'invalid', null, `engines.${key} is not a string.`));
        else pins.push(configured(id, label, 'package.json', data.engines[key]));
      }
    }
  }
  if (data.packageManager !== undefined) {
    if (typeof data.packageManager !== 'string') pins.push(pin('package-manager', 'packageManager', 'package.json', 'invalid', null, 'packageManager is not a string.'));
    else {
      const name = data.packageManager.split('@')[0].trim();
      pins.push(configured('package-manager', name || 'packageManager', 'package.json', data.packageManager));
    }
  }
  return pins;
}

function pythonRequires(text) {
  const lines = stripBom(text).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  const keys = lines.filter((line) => /^requires-python\s*=/.test(line));
  if (!keys.length) return [];
  if (keys.length !== 1) return [pin('requires-python', 'Python', 'pyproject.toml', 'invalid', null, 'requires-python is not a single-line string.')];
  const match = /^requires-python\s*=\s*(["'])([^"']+)\1\s*(?:#.*)?$/.exec(keys[0]);
  if (!match) return [pin('requires-python', 'Python', 'pyproject.toml', 'invalid', null, 'requires-python is not a single-line string.')];
  return [configured('requires-python', 'Python', 'pyproject.toml', match[2])];
}

function rustToml(text) {
  let section = '';
  let channel = null;
  let saw = false;
  let bad = false;
  for (const raw of stripBom(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const heading = /^\[([^\]]+)\]$/.exec(line);
    if (heading) {
      section = heading[1].trim();
      if (section === 'toolchain') saw = true;
      continue;
    }
    if (section !== 'toolchain' || !/^channel\s*=/.test(line)) continue;
    const match = /^channel\s*=\s*(["'])([^"']+)\1\s*(?:#.*)?$/.exec(line);
    if (!match || channel !== null) bad = true;
    else channel = match[2];
  }
  if (bad || (saw && channel === null)) return [pin('rust-toolchain', 'Rust', 'rust-toolchain.toml', 'invalid', null, 'rust-toolchain channel is not a single-line string.')];
  return channel === null ? [] : [configured('rust-toolchain', 'Rust', 'rust-toolchain.toml', channel)];
}

function rustFile(text) {
  const line = versionLine(text);
  if (line === null) return [pin('rust-toolchain-file', 'Rust', 'rust-toolchain', 'invalid', null, 'The pin file has no version.')];
  if (line.startsWith('[')) return [pin('rust-toolchain-file', 'Rust', 'rust-toolchain', 'invalid', null, 'rust-toolchain is not a single version line.')];
  return [configured('rust-toolchain-file', 'Rust', 'rust-toolchain', line)];
}

function goMod(text) {
  let language = null;
  let toolchain = null;
  let bad = false;
  for (const raw of stripBom(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    if (/^go\s/.test(line)) {
      const match = /^go\s+(\S+)$/.exec(line);
      if (!match || language !== null) bad = true;
      else language = match[1];
    } else if (/^toolchain\s/.test(line)) {
      const match = /^toolchain\s+(\S+)$/.exec(line);
      if (!match || toolchain !== null) bad = true;
      else toolchain = match[1];
    }
  }
  if (bad) return [pin('go-mod', 'Go', 'go.mod', 'invalid', null, 'go.mod has a version line that could not be read.')];
  const pins = [];
  if (language) pins.push(configured('go-language', 'Go language', 'go.mod', language));
  if (toolchain) pins.push(configured('go-toolchain', 'Go toolchain', 'go.mod', toolchain));
  return pins;
}

function globalJson(text) {
  let data;
  try { data = JSON.parse(stripBom(text)); } catch {
    return [pin('global-json', '.NET SDK', 'global.json', 'invalid', null, 'global.json could not be read as JSON.')];
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.sdk === undefined) return [];
  if (!data.sdk || typeof data.sdk !== 'object' || Array.isArray(data.sdk) || typeof data.sdk.version !== 'string') {
    return [pin('global-json', '.NET SDK', 'global.json', 'invalid', null, 'sdk.version is not a string.')];
  }
  return [configured('global-json', '.NET SDK', 'global.json', data.sdk.version)];
}

function toolVersions(text) {
  const pins = [];
  const used = new Set();
  let bad = false;
  for (const raw of stripBom(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const gap = line.search(/\s/);
    const name = (gap === -1 ? line : line.slice(0, gap)).toLowerCase();
    const known = TOOL_VERSIONS[name];
    if (!known) continue;
    const version = gap === -1 ? '' : line.slice(gap).trim();
    if (!version) bad = true;
    else {
      let id = known[0];
      let n = 2;
      while (used.has(id)) id = `${known[0]}-${n++}`;
      used.add(id);
      pins.push(configured(id, known[1], '.tool-versions', version));
    }
  }
  if (bad) return [pin('tool-versions', '.tool-versions', '.tool-versions', 'invalid', null, '.tool-versions has a line that could not be read.')];
  return pins;
}

const PARSERS = {
  '.nvmrc': (text) => textPin('nvmrc', 'Node.js', '.nvmrc', text),
  '.node-version': (text) => textPin('node-version', 'Node.js', '.node-version', text),
  '.python-version': (text) => textPin('python-version', 'Python', '.python-version', text),
  'package.json': packagePins,
  'pyproject.toml': pythonRequires,
  'rust-toolchain.toml': rustToml,
  'rust-toolchain': rustFile,
  'go.mod': goMod,
  'global.json': globalJson,
  '.tool-versions': toolVersions,
};

function inside(file, root) {
  const child = path.resolve(file);
  const base = path.resolve(root);
  const left = process.platform === 'win32' ? child.toLowerCase() : child;
  const right = process.platform === 'win32' ? base.toLowerCase() : base;
  return left.startsWith(right.endsWith(path.sep) ? right : right + path.sep);
}

const FILE_LABELS = {
  '.nvmrc': 'Node.js', '.node-version': 'Node.js', '.python-version': 'Python', 'package.json': 'package.json',
  'pyproject.toml': 'Python', 'rust-toolchain.toml': 'Rust', 'rust-toolchain': 'Rust', 'go.mod': 'Go',
  'global.json': '.NET SDK', '.tool-versions': '.tool-versions',
};

function readPin(file, realRoot) {
  const name = path.basename(file);
  const label = FILE_LABELS[name] || name;
  let listed;
  try { listed = fs.lstatSync(file); } catch (err) {
    if (err.code === 'ENOENT') return { identity: { name, state: 'absent' } };
    return { identity: { name, state: 'rejected' }, failure: pin(name, label, name, 'unreadable', null, 'The pin file could not be read.') };
  }
  let real = file;
  if (listed.isSymbolicLink()) {
    try { real = fs.realpathSync(file); } catch {
      return { identity: { name, state: 'rejected' }, failure: pin(name, label, name, 'unreadable', null, 'The pin file could not be read.') };
    }
    if (!inside(real, realRoot)) {
      return { identity: { name, state: 'rejected' }, failure: pin(name, label, name, 'unreadable', null, 'The pin is outside the project folder.') };
    }
  }
  let stat;
  try { stat = fs.statSync(real); } catch {
    return { identity: { name, state: 'rejected' }, failure: pin(name, label, name, 'unreadable', null, 'The pin file could not be read.') };
  }
  if (!stat.isFile()) {
    return { identity: { name, state: 'rejected' }, failure: pin(name, label, name, 'unreadable', null, 'The pin is not a file.') };
  }
  if (stat.size > PIN_LIMIT) {
    return { identity: { name, state: 'file', mtimeMs: stat.mtimeMs, size: stat.size }, failure: pin(name, label, name, 'unreadable', null, 'The pin file is larger than 64 KiB.') };
  }
  return { identity: { name, state: 'file', mtimeMs: stat.mtimeMs, size: stat.size }, file: real };
}

/** Pins and file identity for one project folder. Does not change the process working directory. */
export function scanPins(cwd, { identityOnly = false } = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return { error: 'Could not read the project pins.' };
  let root;
  try { root = fs.statSync(cwd); } catch { return { error: 'Could not read the project pins.' }; }
  if (!root.isDirectory()) return { error: 'Could not read the project pins.' };
  let realRoot;
  try { realRoot = fs.realpathSync(cwd); } catch { return { error: 'Could not read the project pins.' }; }
  const identity = [];
  const pins = [];
  for (const name of PIN_NAMES) {
    const read = readPin(path.join(cwd, name), realRoot);
    identity.push(read.identity);
    if (identityOnly) continue;
    if (read.failure) pins.push(read.failure);
    else if (read.file) {
      let text;
      try { text = fs.readFileSync(read.file); } catch {
        pins.push(pin(name, FILE_LABELS[name] || name, name, 'unreadable', null, 'The pin file could not be read.'));
        continue;
      }
      if (text.length > PIN_LIMIT) {
        pins.push(pin(name, FILE_LABELS[name] || name, name, 'unreadable', null, 'The pin file is larger than 64 KiB.'));
        continue;
      }
      pins.push(...PARSERS[name](text.toString('utf8')));
    }
  }
  return { identity: JSON.stringify(identity), ...(identityOnly ? {} : { pins }), cwd: process.cwd() };
}

/** A working folder for a project check. Empty input is refused and does not become the home directory. */
export function resolveProjectCwd(cwd, { homedir = os.homedir, stat = fs.statSync } = {}) {
  if (typeof cwd !== 'string' || !cwd.trim()) {
    throw Object.assign(new Error('A working folder is required.'), { status: 400, code: 'cwd_required' });
  }
  let dir = cwd.trim();
  if (dir === '~' || dir.startsWith('~/') || dir.startsWith('~\\')) dir = path.join(homedir(), dir.slice(1));
  dir = path.resolve(dir);
  let info;
  try { info = stat(dir); } catch {
    throw Object.assign(new Error(`working directory does not exist: ${dir}`), { status: 400, code: 'bad_cwd' });
  }
  if (!info.isDirectory()) throw Object.assign(new Error(`working directory is not a folder: ${dir}`), { status: 400, code: 'bad_cwd' });
  return dir;
}
