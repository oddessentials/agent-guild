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

function matchesAny(file, entries, env, platform) {
  return entries.some((entry) => matchesEntry(file, expandHome(entry, env, platform), platform));
}

function isInside(file, dir, platform) {
  const m = pathModule(platform);
  return normalize(file, platform).startsWith(normalize(dir, platform) + m.sep);
}

function npmOwner({ resolvedPath, realPath, pkg, platform, fsx }) {
  const m = pathModule(platform);
  const dir = m.dirname(resolvedPath);
  const segments = pkg.split('/');
  const prefix = platform === 'win32' ? dir : m.resolve(dir, '..');
  const pkgDir = platform === 'win32'
    ? m.join(prefix, 'node_modules', ...segments)
    : m.join(prefix, 'lib', 'node_modules', ...segments);
  if (!fsx.exists(m.join(pkgDir, 'package.json'))) return null;
  if (!isInside(realPath, pkgDir, platform) && !isInside(realPath, fsx.realpath(pkgDir), platform)) {
    const text = fsx.readText(resolvedPath).toLowerCase();
    const needle = ['node_modules', ...segments].join('/').toLowerCase();
    if (!text.replace(/\\/g, '/').includes(needle)) return null;
  }
  const npm = platform === 'win32' ? m.join(prefix, 'npm.cmd') : m.join(dir, 'npm');
  return { prefix, npm: fsx.exists(npm) ? npm : null };
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
      if (!npm) return result('npm', { guidance: `Installed by npm under ${owner.prefix}, but npm was not found.` });
      return result('npm', { update: { file: npm, args: ['install', '-g', '--prefix', owner.prefix], package: provider.package } });
    }
  }

  const native = channels.native;
  if (native && (matchesAny(resolvedPath, native.paths, env, platform) || matchesAny(realPath, native.paths, env, platform))) {
    if (native.update.length === 0) {
      return result('native', { guidance: `${provider.tool} at ${resolvedPath} has no update command configured. Update it the way you installed it.` });
    }
    return result('native', { update: { file: resolvedPath, args: [...native.update] }, probe: true });
  }

  const brew = brewOwner({ realPath, platform, fsx });
  if (brew) {
    if (!brew.brew) return result('brew', { guidance: `Installed by Homebrew under ${brew.prefix}, but brew was not found at ${brew.prefix}/bin/brew.` });
    return result('brew', { update: { file: brew.brew, args: brew.cask ? ['upgrade', '--cask', brew.token] : ['upgrade', brew.token] } });
  }

  const winget = wingetOwner({ realPath, id: channels.winget?.id, platform });
  if (winget) {
    if (!wingetOnPath) return result('winget', { guidance: 'Installed by WinGet, but winget was not found on PATH.' });
    return result('winget', { update: { file: wingetOnPath, args: ['upgrade', '--id', winget.id, '--exact'] } });
  }

  const legacy = channels.legacy;
  if (legacy && (matchesAny(resolvedPath, legacy.paths, env, platform) || matchesAny(realPath, legacy.paths, env, platform))) {
    return result('legacy', { guidance: legacy.guidance || `Installed by an older installer at ${resolvedPath}. Update it the way you installed it.` });
  }

  return result('unknown', { guidance: `Installed at ${resolvedPath} by a method Agent Guild does not recognise. Update it the way you installed it.` });
}
