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
  isLink: (file) => {
    try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; }
  },
};

function pathModule(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function homeDir(env, platform) {
  return (platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();
}

export function homeRelative(p, env, platform) {
  const m = pathModule(platform);
  const home = homeDir(env, platform);
  return isInside(p, home, platform) ? `~${m.sep}${m.relative(home, p)}` : p;
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

function isInside(file, dir, platform) {
  const m = pathModule(platform);
  return normalize(file, platform).startsWith(normalize(dir, platform) + m.sep);
}

function samePath(a, b, platform) {
  return normalize(a, platform) === normalize(b, platform);
}

function ownsLocation({ resolvedPath, realPath }, entries, env, platform, fsx) {
  const exts = platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
  return entries.some((entry) => {
    const expanded = expandHome(entry, env, platform);
    const inside = (dir) => isInside(resolvedPath, dir, platform) || isInside(realPath, dir, platform);
    if (inside(expanded) || inside(fsx.realpath(expanded))) return true;
    return exts.map((ext) => expanded + ext)
      .filter((launcher) => fsx.isFile(launcher) && !fsx.isLink(launcher))
      .some((launcher) => samePath(resolvedPath, launcher, platform) || samePath(realPath, fsx.realpath(launcher), platform));
  });
}

function npmPrefixAt(prefix, segments, platform, fsx) {
  const m = pathModule(platform);
  const win = platform === 'win32';
  const pkgDir = win ? m.join(prefix, 'node_modules', ...segments) : m.join(prefix, 'lib', 'node_modules', ...segments);
  if (!fsx.exists(m.join(pkgDir, 'package.json'))) return null;
  const npm = win ? m.join(prefix, 'npm.cmd') : m.join(prefix, 'bin', 'npm');
  return { prefix, pkgDir, npm: fsx.exists(npm) ? npm : null };
}

function npmBeside({ resolvedPath, realPath, pkg, platform, fsx }) {
  const m = pathModule(platform);
  const segments = pkg.split('/');
  const dir = m.dirname(resolvedPath);
  const beside = npmPrefixAt(platform === 'win32' ? dir : m.resolve(dir, '..'), segments, platform, fsx);
  if (!beside) return null;
  if (isInside(realPath, beside.pkgDir, platform) || isInside(realPath, fsx.realpath(beside.pkgDir), platform)) return beside;
  if (fsx.isLink(resolvedPath)) return null;
  const text = fsx.readText(resolvedPath).toLowerCase().replace(/\\/g, '/');
  return text.includes(['node_modules', ...segments].join('/').toLowerCase()) ? beside : null;
}

function npmLinkedInto({ realPath, pkg, platform, fsx }) {
  const m = pathModule(platform);
  const win = platform === 'win32';
  const segments = pkg.split('/');
  const inner = m.sep + m.join(...(win ? [] : ['lib']), 'node_modules', ...segments) + m.sep;
  const at = (win ? realPath.toLowerCase() : realPath).lastIndexOf(win ? inner.toLowerCase() : inner);
  return at > 0 ? npmPrefixAt(realPath.slice(0, at), segments, platform, fsx) : null;
}

function brewOwner({ realPath, names, platform, fsx }) {
  if (platform === 'win32') return null;
  const segments = realPath.split('/');
  const index = segments.findIndex((s, i) => i > 0 && (s === 'Caskroom' || s === 'Cellar'));
  if (index === -1 || !names.includes(segments[index + 1])) return null;
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

/** Whether `<tool> <update args> --help` shows the update command. Go programs exit 2 after their help; a failure that reports an error does not count. */
export function updateHelpAccepted({ stdout = '', stderr = '' }, args, { failed = false } = {}) {
  const text = `${stdout}\n${stderr}`;
  if (failed && /\b(?:error|unknown|unrecogni[sz]ed|invalid)\b/i.test(text)) return false;
  return helpDescribes(text, args);
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

  const ownedByNpm = (owner) => {
    const npm = owner.npm || npmOnPath;
    if (!npm) return result('npm', { prefix: owner.prefix, guidance: `Installed by npm under ${owner.prefix}, but npm was not found.` });
    return result('npm', { prefix: owner.prefix, update: { file: npm, args: ['install', '-g', '--prefix', owner.prefix], package: provider.package } });
  };
  const npmArgs = { resolvedPath, realPath, pkg: provider.package, platform, fsx };

  const beside = provider.package ? npmBeside(npmArgs) : null;
  if (beside) return ownedByNpm(beside);

  const brew = brewOwner({ realPath, names: channels.brew?.names || [], platform, fsx });
  if (brew) {
    const owned = { brewPrefix: brew.prefix, token: brew.token, cask: brew.cask, brewFile: brew.brew };
    if (!brew.brew) return result('brew', { ...owned, guidance: `Installed by Homebrew under ${brew.prefix}, but brew was not found at ${brew.prefix}/bin/brew.` });
    if (channels.brew.autoUpdates) return result('brew', { ...owned, guidance: `${provider.tool} updates itself; Homebrew does not upgrade it.` });
    return result('brew', { ...owned, update: { file: brew.brew, args: brew.cask ? ['upgrade', '--cask', brew.token] : ['upgrade', brew.token] } });
  }

  const linked = provider.package ? npmLinkedInto(npmArgs) : null;
  if (linked) return ownedByNpm(linked);

  const native = channels.native;
  if (native && ownsLocation({ resolvedPath, realPath }, native.paths, env, platform, fsx)) {
    if (native.update.length === 0) {
      return result('native', { guidance: `${provider.tool} at ${resolvedPath} has no update command configured. Update it the way you installed it.` });
    }
    return result('native', { update: { file: resolvedPath, args: [...native.update] }, probe: true });
  }

  const winget = wingetOwner({ realPath, id: channels.winget?.id, platform });
  if (winget) {
    if (!wingetOnPath) return result('winget', { wingetId: winget.id, guidance: 'Installed by WinGet, but winget was not found on PATH.' });
    return result('winget', { wingetId: winget.id, update: { file: wingetOnPath, args: ['upgrade', '--id', winget.id, '--exact'] } });
  }

  const legacy = channels.legacy;
  if (legacy && ownsLocation({ resolvedPath, realPath }, legacy.paths, env, platform, fsx)) {
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

function ownedPaths(entries, env, platform) {
  const m = pathModule(platform);
  const home = homeDir(env, platform);
  return (entries || []).map((entry) => expandHome(entry, env, platform))
    .filter((p) => m.isAbsolute(p) && isInside(p, home, platform) && m.relative(home, p).split(/[\\/]+/).length >= 2)
    .map((p) => m.normalize(p));
}

// Links may sit outside home, e.g. /usr/local/bin: the runner deletes one only
// when it is a symlink into the removed paths, which stay inside home.
function linkPaths(entries, env, platform) {
  const m = pathModule(platform);
  return (entries || []).map((entry) => expandHome(entry, env, platform))
    .filter((p) => (platform === 'win32' ? /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(p) : m.isAbsolute(p)))
    .map((p) => m.normalize(p));
}

function removalFor(channel, env, platform) {
  const remove = ownedPaths(channel?.remove, env, platform);
  return remove.length > 0 ? { remove, links: linkPaths(channel.links, env, platform) } : null;
}

export function uninstallPlan(install, provider, env, platform, fsx = defaultFsx) {
  const channels = provider.channels || {};
  const plan = (run, removal = null, launcher = null) => ({ run, remove: removal?.remove || [], links: removal?.links || [], launcher });
  switch (install.channel) {
    case 'npm': {
      if (!install.update) return null;
      const run = { file: install.update.file, args: ['uninstall', '-g', '--prefix', install.prefix, provider.package] };
      const removal = channels.native?.sharedWithNpm ? removalFor(channels.native, env, platform) : null;
      const launcher = removal ? knownLaunchers({ provider, command: provider.command, env, platform, fsx })[0] : null;
      return plan(run, removal, launcher);
    }
    case 'brew':
      return install.brewFile ? plan({ file: install.brewFile, args: install.cask ? ['uninstall', '--cask', install.token] : ['uninstall', install.token] }) : null;
    case 'winget':
      return install.update ? plan({ file: install.update.file, args: ['uninstall', '--id', install.wingetId, '--exact'] }) : null;
    case 'native':
    case 'legacy': {
      const removal = removalFor(channels[install.channel], env, platform);
      return removal ? plan(null, removal, install.resolvedPath) : null;
    }
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
    const existing = installs.get(key);
    if (!existing) installs.set(key, { ...install, key, onPath: isOnPath, uninstall: uninstallPlan(install, provider, env, platform, fsx) });
    // A shared native copy also needs its npm owner removed, whichever comes first on PATH.
    else if (install.channel === 'npm' && !existing.uninstall?.run) {
      existing.uninstall = uninstallPlan(install, provider, env, platform, fsx);
      if (!existing.uninstall) existing.guidance = install.guidance;
    }
  };
  for (const file of onPath) add(file, true);
  for (const file of known) add(file, false);
  return [...installs.values()];
}
