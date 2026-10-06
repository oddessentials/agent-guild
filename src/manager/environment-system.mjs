// System facts and the Docker engine, for the environment helper. Reads only:
// os, a few small files, one registry query on Windows, and one GET /version
// on a local Docker socket or pipe. No docker process is started and a remote
// engine is never contacted. Where systemd starts the engine on demand
// (docker.socket, podman.socket), opening its socket starts it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';

const DOCKER_TIMEOUT_MS = 1500;
const DOCKER_LIMIT = 256 * 1024;
const REGISTRY_TIMEOUT_MS = 3000;
const LXSS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss';
// Linux's system sockets belong to the docker group; a rootless or Podman socket does not.
const GROUP_SOCKETS = ['/var/run/docker.sock', '/run/docker.sock'];

function value(env, name) {
  return env[Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase())];
}

function readText(file, read) {
  try { return read(file, 'utf8'); } catch { return null; }
}

export function isWsl({ env = process.env, release = os.release() } = {}) {
  return Boolean(value(env, 'WSL_DISTRO_NAME')) || /microsoft|wsl/i.test(release);
}

// WSL 1 kernels end in "-Microsoft"; WSL 2 kernels name WSL2. Newer WSL registers interop as WSLInterop-late.
export function wslInteropEnabled({ read = fs.readFileSync } = {}) {
  return ['WSLInterop', 'WSLInterop-late'].some((name) => /^enabled/.test(readText(`/proc/sys/fs/binfmt_misc/${name}`, read) || ''));
}

function normalArch(name) {
  const lower = String(name || '').toLowerCase();
  if (['x86_64', 'amd64', 'x64'].includes(lower)) return 'x64';
  if (['aarch64', 'arm64', 'aarch64_be'].includes(lower)) return 'arm64';
  return lower || null;
}

function linuxName(read) {
  for (const file of ['/etc/os-release', '/usr/lib/os-release']) {
    const text = readText(file, read);
    const match = text?.match(/^PRETTY_NAME=(["']?)(.+)\1\s*$/m);
    if (match) return match[2];
  }
  return 'Linux';
}

function macName(read) {
  const text = readText('/System/Library/CoreServices/SystemVersion.plist', read);
  const version = text?.match(/<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  return version ? `macOS ${version}` : 'macOS';
}

// Windows lists WSL distributions under the user's Lxss key. Reading it does not start WSL.
export async function wslDistributions({ env, cwd, run, kills = null } = {}) {
  const reg = path.win32.join(value(env, 'SystemRoot') || 'C:\\Windows', 'System32', 'reg.exe');
  const result = await run(reg, ['query', LXSS, '/s'], { env, cwd, kills, timeoutMs: REGISTRY_TIMEOUT_MS });
  if (result.error) return null;
  if (result.code !== 0) return /unable to find/i.test(result.output) ? [] : null;
  const fallback = result.output.match(/^\s+DefaultDistribution\s+REG_SZ\s+(\S+)/m)?.[1]?.toLowerCase();
  const distros = new Map();
  let key = null;
  for (const line of result.output.split(/\r?\n/)) {
    if (/^HKEY_/.test(line)) key = line.trim().split('\\').pop().toLowerCase();
    const name = line.match(/^\s+DistributionName\s+REG_SZ\s+(.+?)\s*$/)?.[1];
    const version = line.match(/^\s+Version\s+REG_DWORD\s+0x([0-9a-f]+)/i)?.[1];
    if (!key || !key.startsWith('{')) continue;
    const entry = distros.get(key) || { name: null, version: null, default: key === fallback };
    if (name) entry.name = name;
    if (version) entry.version = parseInt(version, 16);
    distros.set(key, entry);
  }
  return [...distros.values()].filter((entry) => entry.name)
    .sort((a, b) => Number(b.default) - Number(a.default) || a.name.localeCompare(b.name));
}

export async function systemInfo({
  env = process.env, cwd, platform = process.platform, run, kills = null,
  read = fs.readFileSync, release = os.release(), version = os.version(),
  arch = process.arch, machine = os.machine(), cpus = os.cpus(), threads = os.availableParallelism(), memory = os.totalmem(),
} = {}) {
  // Node says 'unknown' for a CPU it cannot name, such as many arm64 cores on Linux.
  const model = cpus[0]?.model?.trim();
  const info = {
    os: null, osDetail: null, arch: normalArch(arch), hostArch: null,
    cpu: { model: model && model !== 'unknown' ? model : null, threads }, memory, wsl: null, wslDistributions: null,
  };
  // Linux names the kernel's architecture, which can differ from Node's
  // without emulation (a 32-bit build on a 64-bit kernel), so only Windows
  // and macOS name a host architecture.
  const host = platform === 'win32' || platform === 'darwin' ? normalArch(machine) : null;
  if (host && host !== info.arch) info.hostArch = host;
  if (platform === 'win32') {
    info.os = version || 'Windows';
    info.osDetail = `Version ${release}`;
    try { info.wslDistributions = await wslDistributions({ env, cwd, run, kills }); } catch { /* the row is left out */ }
  } else if (platform === 'darwin') {
    info.os = macName(read);
    info.osDetail = `Darwin ${release}`;
  } else {
    info.os = linuxName(read);
    info.osDetail = `Kernel ${release}`;
    if (isWsl({ env, release })) {
      info.wsl = { version: /WSL2/i.test(release) ? 2 : 1, distro: value(env, 'WSL_DISTRO_NAME') || null, interop: wslInteropEnabled({ read }) };
    }
  }
  return info;
}

// Which engine the docker command would use: DOCKER_HOST, then DOCKER_CONTEXT,
// then the config's current context, then the platform default.
export function dockerEndpoint({ env = process.env, platform = process.platform, read = fs.readFileSync } = {}) {
  const host = value(env, 'DOCKER_HOST');
  if (host) return { endpoint: host, context: null, source: 'DOCKER_HOST' };
  const home = platform === 'win32' ? value(env, 'USERPROFILE') || os.homedir() : value(env, 'HOME') || os.homedir();
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const configDir = value(env, 'DOCKER_CONFIG') || join(home, '.docker');
  let context = value(env, 'DOCKER_CONTEXT');
  let source = 'DOCKER_CONTEXT';
  if (!context) {
    try { context = JSON.parse(read(join(configDir, 'config.json'), 'utf8')).currentContext; } catch { /* no config */ }
    source = 'config';
  }
  if (!context || context === 'default') {
    return { endpoint: platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock', context: 'default', source: 'default' };
  }
  const id = createHash('sha256').update(context).digest('hex');
  try {
    const meta = JSON.parse(read(join(configDir, 'contexts', 'meta', id, 'meta.json'), 'utf8'));
    const endpoint = meta?.Endpoints?.docker?.Host;
    if (typeof endpoint === 'string' && endpoint) return { endpoint, context, source };
  } catch { /* reported below */ }
  return { endpoint: null, context, source, error: `Docker context ${context} was not found.` };
}

// A local socket or named pipe, or null for an engine reached over the network.
export function localSocket(endpoint) {
  if (/^unix:\/\//i.test(endpoint)) return endpoint.replace(/^unix:\/\//i, '') || null;
  if (/^npipe:/i.test(endpoint)) {
    const name = endpoint.replace(/^npipe:/i, '').replace(/^[/\\]+\.?[/\\]+pipe[/\\]+/i, '');
    return name && !/[/\\]/.test(name) ? `\\\\.\\pipe\\${name}` : null;
  }
  return null;
}

export function requestVersion(socketPath, { timeoutMs = DOCKER_TIMEOUT_MS, request = http.request } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    try {
      const req = request({ socketPath, path: '/version', method: 'GET', headers: { Host: 'docker' }, timeout: timeoutMs }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > DOCKER_LIMIT) { req.destroy(); finish({ error: 'too_large' }); }
        });
        res.on('end', () => finish({ status: res.statusCode, body }));
        res.on('error', () => finish({ error: 'read' }));
      });
      req.on('timeout', () => { req.destroy(); finish({ error: 'timeout' }); });
      req.on('error', (err) => finish({ error: err.code || 'error' }));
      req.end();
    } catch (err) { finish({ error: err.code || 'error' }); }
  });
}

export async function dockerInfo({ env = process.env, platform = process.platform, read = fs.readFileSync, resolve, query = requestVersion } = {}) {
  const cli = resolve('docker', env, platform);
  const target = dockerEndpoint({ env, platform, read });
  const row = {
    status: 'failed', version: null, platform: null, os: null, arch: null, wsl2: false,
    context: target.context, endpoint: target.endpoint, cli, detail: null,
  };
  if (target.error) return { ...row, detail: target.error };
  const socket = localSocket(target.endpoint);
  if (!socket) return { ...row, status: 'remote', detail: 'This engine is reached over the network, so it is not checked.' };
  const result = await query(socket);
  if (result.error === 'EACCES' || result.error === 'EPERM') {
    return { ...row, status: 'denied', detail: platform === 'win32'
      ? 'The engine is running, but this user cannot open its pipe.'
      : `The engine socket exists, but this user cannot open it.${platform === 'linux' && GROUP_SOCKETS.includes(socket) ? ' Adding the user to the docker group allows it.' : ''}` };
  }
  if (['ENOENT', 'ECONNREFUSED', 'ENOTSOCK'].includes(result.error)) {
    return cli
      ? { ...row, status: 'stopped', detail: 'The Docker engine is not running.' }
      : { ...row, status: 'not_found', detail: 'No docker command on PATH and no engine answered.' };
  }
  if (result.error === 'timeout') return { ...row, detail: 'The engine did not answer in time.' };
  if (result.error || result.status !== 200) return { ...row, detail: 'The engine did not give a usable answer.' };
  let data;
  try { data = JSON.parse(result.body); } catch { return { ...row, detail: 'The engine did not give a usable answer.' }; }
  const version = typeof data?.Version === 'string' ? data.Version : null;
  if (!version) return { ...row, detail: 'The engine did not give a usable answer.' };
  const text = (item) => typeof item === 'string' && item ? item.slice(0, 200) : null;
  return {
    ...row, status: 'running', version,
    platform: text(data.Platform?.Name), os: text(data.Os), arch: text(data.Arch),
    wsl2: data.Os === 'linux' && /microsoft-standard-WSL2/i.test(data.KernelVersion || ''),
  };
}
