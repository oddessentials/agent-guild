import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CHANNEL_LABELS = {
  npm: 'npm',
  native: 'native',
  brew: 'Homebrew',
  winget: 'WinGet',
  legacy: 'legacy install',
  unknown: 'unknown install',
};

export const defaultFsx = {
  exists: (file) => fs.existsSync(file),
  realpath: (file) => {
    try { return fs.realpathSync.native(file); } catch { return file; }
  },
  readText: (file) => {
    try { return fs.readFileSync(file, 'utf8').slice(0, 8192); } catch { return ''; }
  },
  isFile: (file) => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  },
};

function pathModule(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function homeDir(env, platform) {
  return (platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();
}

export function expandHome(p, env, platform) {
  const m = pathModule(platform);
  if (p === '~') return homeDir(env, platform);
  if (p.startsWith('~/') || p.startsWith('~\\')) return m.join(homeDir(env, platform), p.slice(2));
  return p;
}

function normalize(p, platform) {
  const m = pathModule(platform);
  let out = m.normalize(p);
  if (platform === 'win32') out = out.toLowerCase();
  return out.length > 1 ? out.replace(/[\\/]+$/, '') : out;
}

function withoutLauncherExt(file, platform) {
  return platform === 'win32' ? file.replace(/\.(exe|cmd|bat|ps1|com)$/i, '') : file;
}

function matchesEntry(file, entry, platform) {
  const m = pathModule(platform);
  const f = normalize(file, platform);
  const e = normalize(entry, platform);
  if (f === e || withoutLauncherExt(f, platform) === e) return true;
  return f.startsWith(e.endsWith(m.sep) ? e : e + m.sep);
}

function matchesAny(files, entries, env, platform, fsx) {
  return entries.some((entry) => {
    const expanded = expandHome(entry, env, platform);
    return [expanded, fsx.realpath(expanded)].some((target) => files.some((file) => matchesEntry(file, target, platform)));
  });
}

function isInside(file, dir, platform) {
  const m = pathModule(platform);
  return normalize(file, platform).startsWith(normalize(dir, platform) + m.sep);
}

function npmOwner({ resolvedPath, realPath, pkg, platform, fsx }) {
  const m = pathModule(platform);
  const win = platform === 'win32';
  const segments = pkg.split('/');
  const owned = (prefix) => {
    const pkgDir = win ? m.join(prefix, 'node_modules', ...segments) : m.join(prefix, 'lib', 'node_modules', ...segments);
    if (!fsx.exists(m.join(pkgDir, 'package.json'))) return null;
    const npm = win ? m.join(prefix, 'npm.cmd') : m.join(prefix, 'bin', 'npm');
    return { prefix, pkgDir, npm: fsx.exists(npm) ? npm : null };
  };

  const dir = m.dirname(resolvedPath);
  const beside = owned(win ? dir : m.resolve(dir, '..'));
  if (beside) {
    if (isInside(realPath, beside.pkgDir, platform) || isInside(realPath, fsx.realpath(beside.pkgDir), platform)) return beside;
    const text = fsx.readText(resolvedPath).toLowerCase().replace(/\\/g, '/');
    if (text.includes(['node_modules', ...segments].join('/').toLowerCase())) return beside;
  }

  const inner = m.sep + m.join(...(win ? [] : ['lib']), 'node_modules', ...segments) + m.sep;
  const at = (win ? realPath.toLowerCase() : realPath).lastIndexOf(win ? inner.toLowerCase() : inner);
  return at > 0 ? owned(realPath.slice(0, at)) : null;
}

function brewOwner({ realPath, platform, fsx }) {
  if (platform === 'win32') return null;
  const segments = realPath.split('/');
  const index = segments.findIndex((s, i) => i > 0 && (s === 'Caskroom' || s === 'Cellar'));
  if (index === -1 || !segments[index + 1]) return null;
  const prefix = segments.slice(0, index).join('/') || '/';
  const brew = `${prefix}/bin/brew`;
  return { prefix, token: segments[index + 1], cask: segments[index] === 'Caskroom', brew: fsx.exists(brew) ? brew : null };
}

function wingetOwner({ realPath, id, platform }) {
  if (platform !== 'win32' || !id) return null;
  const segments = realPath.split(/[\\/]/);
  const index = segments.findIndex((s, i) => i > 0
    && s.toLowerCase() === 'winget'
    && segments[i - 1].toLowerCase() === 'microsoft'
    && (segments[i + 1] || '').toLowerCase() === 'packages');
  if (index === -1) return null;
  const folder = (segments[index + 2] || '').toLowerCase();
  return folder.startsWith(`${id.toLowerCase()}_`) ? { id } : null;
}

export function helpDescribes(text, args) {
  const words = args.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const named = new RegExp(`(?<![\\w-])${words.join('(?![\\w-]).*(?<![\\w-])')}(?![\\w-])`, 'i');
  const lines = String(text || '').split(/\r?\n/);
  return lines.some((line, i) => (/usage/i.test(line) && named.test(line))
    || (/^\s*usage:?\s*$/i.test(line) && named.test(lines[i + 1] || '')));
}

const EXACT_VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
const ALIASED_BUILD = new RegExp(`^npm:((?:@[^/@\\s]+/)?[^/@\\s]+)@(${EXACT_VERSION})$`);

export function platformDependency(manifest, pkg, platform, arch) {
  const spec = manifest?.optionalDependencies?.[`${pkg}-${platform}-${arch}`];
  const alias = typeof spec === 'string' ? spec.match(ALIASED_BUILD) : null;
  return alias ? { name: alias[1], version: alias[2] } : null;
}

export function formatCommand(file, args) {
  return [file, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
}

export function classifyInstall({
  resolvedPath, provider, env = process.env, platform = process.platform, fsx = defaultFsx, npmOnPath = null, wingetOnPath = null,
}) {
  const realPath = fsx.realpath(resolvedPath);
  const channels = provider.channels || {};
  const result = (channel, extra = {}) => ({ channel, resolvedPath, realPath, update: null, probe: false, guidance: null, ...extra });

  if (provider.package) {
    const owner = npmOwner({ resolvedPath, realPath, pkg: provider.package, platform, fsx });
    if (owner) {
      const npm = owner.npm || npmOnPath;
      if (!npm) return result('npm', { prefix: owner.prefix, guidance: `Installed by npm under ${owner.prefix}, but npm was not found.` });
      return result('npm', { prefix: owner.prefix, update: { file: npm, args: ['install', '-g', '--prefix', owner.prefix], package: provider.package } });
    }
  }

  const native = channels.native;
  if (native && matchesAny([resolvedPath, realPath], native.paths, env, platform, fsx)) {
    if (native.update.length === 0) {
      return result('native', { guidance: `${provider.tool} at ${resolvedPath} has no update command configured. Update it the way you installed it.` });
    }
    return result('native', { update: { file: resolvedPath, args: [...native.update] }, probe: true });
  }

  const brew = brewOwner({ realPath, platform, fsx });
  if (brew) {
    const owned = { brewPrefix: brew.prefix, token: brew.token, cask: brew.cask };
    if (!brew.brew) return result('brew', { ...owned, guidance: `Installed by Homebrew under ${brew.prefix}, but brew was not found at ${brew.prefix}/bin/brew.` });
    return result('brew', { ...owned, update: { file: brew.brew, args: brew.cask ? ['upgrade', '--cask', brew.token] : ['upgrade', brew.token] } });
  }

  const winget = wingetOwner({ realPath, id: channels.winget?.id, platform });
  if (winget) {
    if (!wingetOnPath) return result('winget', { wingetId: winget.id, guidance: 'Installed by WinGet, but winget was not found on PATH.' });
    return result('winget', { wingetId: winget.id, update: { file: wingetOnPath, args: ['upgrade', '--id', winget.id, '--exact'] } });
  }

  const legacy = channels.legacy;
  if (legacy && matchesAny([resolvedPath, realPath], legacy.paths, env, platform, fsx)) {
    return result('legacy', { guidance: legacy.guidance || `Installed by an older installer at ${resolvedPath}. Update it the way you installed it.` });
  }

  return result('unknown', { guidance: `Installed at ${resolvedPath} by a method Agent Guild does not recognise. Update it the way you installed it.` });
}

export function installationKey(install, provider, platform, fsx = defaultFsx) {
  switch (install.channel) {
    case 'npm':
      return provider.channels?.native?.sharedWithNpm ? 'native' : `npm:${normalize(fsx.realpath(install.prefix), platform)}`;
    case 'native':
      return 'native';
    case 'legacy':
      return 'legacy';
    case 'brew':
      return `brew:${install.brewPrefix}:${install.token}`;
    case 'winget':
      return `winget:${install.wingetId.toLowerCase()}`;
    default:
      return `path:${normalize(install.realPath, platform)}`;
  }
}

export function removalCommand(install, provider) {
  switch (install.channel) {
    case 'npm':
      return install.update ? formatCommand(install.update.file, ['uninstall', '-g', '--prefix', install.prefix, provider.package]) : null;
    case 'brew':
      return install.update ? formatCommand(install.update.file, install.cask ? ['uninstall', '--cask', install.token] : ['uninstall', install.token]) : null;
    case 'winget':
      return `winget uninstall --id ${install.wingetId} --exact`;
    case 'native':
      return provider.channels?.native?.uninstall || null;
    case 'legacy':
      return provider.channels?.legacy?.uninstall || null;
    default:
      return null;
  }
}

export function knownLaunchers({ provider, command, env = process.env, platform = process.platform, fsx = defaultFsx }) {
  if (!command || /[\\/]/.test(command)) return [];
  const m = pathModule(platform);
  const exts = platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  const firstFile = (base) => exts.map((ext) => base + ext).find((file) => fsx.isFile(file)) || null;
  const found = [];
  for (const channel of [provider.channels?.native, provider.channels?.legacy]) {
    for (const entry of channel?.paths || []) {
      const base = expandHome(entry, env, platform);
      const hit = firstFile(base) || firstFile(m.join(base, command));
      if (hit) found.push(hit);
    }
  }
  return found;
}

export function listInstallations({
  onPath = [], known = [], provider, env = process.env, platform = process.platform, fsx = defaultFsx, npmOnPath = null, wingetOnPath = null,
}) {
  const installs = new Map();
  const add = (file, isOnPath) => {
    const install = classifyInstall({ resolvedPath: file, provider, env, platform, fsx, npmOnPath, wingetOnPath });
    const key = installationKey(install, provider, platform, fsx);
    if (!installs.has(key)) installs.set(key, { ...install, key, onPath: isOnPath, removeCommand: removalCommand(install, provider) });
  };
  for (const file of onPath) add(file, true);
  for (const file of known) add(file, false);
  return [...installs.values()];
}
