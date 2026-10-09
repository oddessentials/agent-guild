// The copies of a Docker CLI plugin, as the Docker CLI finds them.
//
// `docker agent` is the docker-agent plugin, which the Docker CLI loads from the first folder that has it:
// each folder in cliPluginsExtraDirs of its config file, then <config dir>/cli-plugins (~/.docker, or
// DOCKER_CONFIG), then the system folders (docker/cli, cli-plugins/manager). `docker info` lists every
// plugin with the path it runs from and the paths it shadows, and needs no engine for that.
//
// A copy's channel says who put it there, so the card offers to remove only a downloaded one:
// - download: in <config dir>/cli-plugins, not a link; the card's install command writes here.
// - desktop: Docker Desktop's, in %ProgramFiles%\Docker\cli-plugins or inside Docker.app (on macOS Desktop
//   links ~/.docker/cli-plugins/docker-agent into the app).
// - system: a Linux or macOS system plugin folder, a package's.
// - unknown: anywhere else, such as a cliPluginsExtraDirs folder.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSpawnSpec, runSpec } from './command-resolver.mjs';
import { diagnosticLine, parseVersion } from './versions.mjs';

export const PLUGIN_INFO_ARGS = ['info', '--format', '{{json .ClientInfo.Plugins}}'];
export const PLUGIN_METADATA_ARGS = ['docker-cli-plugin-metadata'];
const INFO_TIMEOUT_MS = 15000;

const LINUX_SYSTEM_DIRS = ['/usr/local/lib/docker/cli-plugins', '/usr/local/libexec/docker/cli-plugins', '/usr/lib/docker/cli-plugins', '/usr/libexec/docker/cli-plugins'];

export const defaultFsx = {
  realpath: (file) => {
    try { return fs.realpathSync.native(file); } catch { return file; }
  },
  isLink: (file) => {
    try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; }
  },
};

function pathModule(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function normalize(p, platform) {
  const m = pathModule(platform);
  const out = m.normalize(p);
  return platform === 'win32' ? out.toLowerCase() : out;
}

function inside(file, dir, platform) {
  const m = pathModule(platform);
  const d = normalize(dir, platform).replace(/[\\/]+$/, '');
  return normalize(file, platform).startsWith(d + m.sep);
}

export function homeDir(env, platform) {
  return (platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();
}

/** The Docker CLI's config folder: DOCKER_CONFIG, else ~/.docker. */
export function dockerConfigDir(env, platform = process.platform) {
  const configured = typeof env.DOCKER_CONFIG === 'string' && env.DOCKER_CONFIG.trim();
  return configured ? pathModule(platform).resolve(configured) : pathModule(platform).join(homeDir(env, platform), '.docker');
}

/** The folder the card's install command writes to. */
export function downloadDir(env, platform = process.platform) {
  return pathModule(platform).join(dockerConfigDir(env, platform), 'cli-plugins');
}

/** 'download', 'desktop', 'system' or 'unknown' for a plugin file. */
export function copyChannel(file, env, platform = process.platform, fsx = defaultFsx) {
  const real = fsx.realpath(file);
  if (platform === 'win32') {
    const desktop = path.win32.join(env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files', 'Docker', 'cli-plugins');
    if (inside(file, desktop, platform) || inside(real, desktop, platform)) return 'desktop';
  } else if (platform === 'darwin') {
    if (/\/Docker\.app\//.test(real) || /\/Docker\.app\//.test(file)) return 'desktop';
  }
  // A download is Agent Guild's to remove only when nothing on its path is a link: the remover refuses those.
  const download = downloadDir(env, platform);
  if (inside(file, download, platform) && !fsx.isLink(file) && normalize(fsx.realpath(download), platform) === normalize(download, platform)) return 'download';
  if (platform !== 'win32' && LINUX_SYSTEM_DIRS.some((dir) => inside(real, dir, platform))) return 'system';
  return 'unknown';
}

/**
 * What `docker info` says about the plugin named `name`: `{ copies: [{ path, active, error? }] }` with the copy docker
 * would run first (`error` is docker's reason when it cannot run that copy: a wrong platform's build, a corrupt file),
 * `{ copies: [] }` when no copy is installed, or `{ error }` when docker could not say. `run` runs a spawn spec and
 * resolves `{ stdout }`.
 */
export async function readPlugin(docker, name, { env = process.env, platform = process.platform, run = runSpec, timeoutMs = INFO_TIMEOUT_MS } = {}) {
  const command = path.basename(docker).replace(/\.(?:exe|cmd|bat)$/i, '');
  let stdout;
  try {
    ({ stdout } = await run(buildSpawnSpec(docker, PLUGIN_INFO_ARGS, env, platform), { env, timeoutMs, killTree: true }));
  } catch (err) {
    const detail = err.killed ? `no answer within ${Math.round(timeoutMs / 1000)} seconds` : diagnosticLine(`${err.stderr || ''}\n${err.stdout || ''}`) || String(err.message || err).slice(0, 240);
    return { error: `${command} info failed: ${detail}` };
  }
  let plugins;
  try {
    plugins = JSON.parse(stdout);
  } catch {
    return { error: `${command} info did not list its plugins as JSON` };
  }
  if (!Array.isArray(plugins)) return { copies: [] };
  const entry = plugins.find((p) => p && typeof p === 'object' && p.Name === name && typeof p.Path === 'string');
  if (!entry) return { copies: [] };
  // Docker lists a copy it cannot load with Err, as text; the plugin is then not usable, and docker still lists no other.
  const broken = typeof entry.Err === 'string' && entry.Err.trim() ? entry.Err.trim().slice(0, 240) : entry.Err ? 'docker could not load it' : null;
  const copies = [{ path: entry.Path, active: true, ...(broken ? { error: broken } : {}) }];
  for (const shadowed of Array.isArray(entry.ShadowedPaths) ? entry.ShadowedPaths : []) {
    if (typeof shadowed === 'string' && shadowed && !copies.some((c) => c.path === shadowed)) copies.push({ path: shadowed, active: false });
  }
  return { copies };
}

/** The version a plugin file reports through the CLI plugin protocol, or null. */
export async function pluginVersion(file, { env = process.env, platform = process.platform, run = runSpec, timeoutMs = INFO_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await run(buildSpawnSpec(file, PLUGIN_METADATA_ARGS, env, platform), { env, timeoutMs, killTree: true });
    return parseVersion(JSON.parse(stdout)?.Version);
  } catch {
    return null;
  }
}
