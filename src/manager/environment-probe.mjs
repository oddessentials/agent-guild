// Passive discovery only. This module is also the isolated helper entry point.
// Never source profiles, invoke package managers, or use a project directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveCommand, killWindowsTree } from './command-resolver.mjs';
import { scanPins } from './environment-pins.mjs';
import { systemInfo, dockerInfo, isWsl, wslInteropEnabled } from './environment-system.mjs';

export const RUNTIMES = [
  { id: 'node', label: 'Node.js', command: 'node', args: ['--version'], pattern: /^v(\d+\.\d+\.\d+(?:-[\w.-]+)?)\s*$/m },
  { id: 'python', label: 'Python', command: 'python', args: ['--version'], pattern: /^Python (\d+\.\d+\.\d+(?:[\w.+-]*)?)/m },
  { id: 'go', label: 'Go', command: 'go', args: ['version'], pattern: /^go version go(\d+\.\d+(?:\.\d+)?(?:[\w.-]*)?)(?:\s|$)/m },
  { id: 'dotnet', label: '.NET SDK', command: 'dotnet', args: ['--version'], pattern: /^(\d+\.\d+\.\d+(?:-[\w.-]+)?)\s*$/m },
  { id: 'r', label: 'R', command: 'R', args: ['--version'], pattern: /^R version (\d+\.\d+\.\d+(?:[\w.-]*)?)/m },
  { id: 'rust', label: 'Rust', command: 'rustc', args: ['--version'], pattern: /^rustc (\d+\.\d+\.\d+(?:-[\w.-]+)?)(?:\s|$)/m },
];
const LIMIT = 32 * 1024;
const TIMEOUT_MS = 1800;

function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(LIMIT);
    return bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0));
  } finally { fs.closeSync(fd); }
}

function value(env, name) {
  return env[Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase())];
}

export function probeEnv(env) {
  const out = { ...env };
  // Overrides apply only to the helper's probes, never the manager or sessions.
  const overrides = {
    NODE_OPTIONS: '', GOTOOLCHAIN: 'local', GOENV: 'off', GOWORK: 'off',
    RUSTUP_AUTO_INSTALL: '0', PYTHON_MANAGER_AUTOMATIC_INSTALL: 'false',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: 'true', DOTNET_NOLOGO: '1',
    COREPACK_ENABLE_NETWORK: '0', UV_OFFLINE: '1', UV_PYTHON_DOWNLOADS: 'never',
  };
  for (const key of Object.keys(out)) if (Object.hasOwn(overrides, key.toUpperCase())) delete out[key];
  return { ...out, ...overrides };
}

// Do not execute unknown script shims. Most version managers link to native
// runtimes; following the link makes their normal installations work directly.
// R's Unix launcher is itself an official shell script and exits on --version.
export function passiveExecutable(file, id, { platform = process.platform, env = process.env, realpath = fs.realpathSync, read = readHead } = {}) {
  const real = realpath(file);
  const normalized = real.replaceAll('\\', '/').toLowerCase();
  if (/\/(?:shims|\.nodejs)\//.test(normalized) || /\/(?:mise|asdf|volta)(?:\.exe)?$/.test(normalized)) {
    return { error: 'A version-manager shim was found. Its runtime cannot be checked without activating the manager.' };
  }
  if (platform === 'win32' && windowsAlias(normalized)) {
    return { error: WINDOWS_ALIAS };
  }
  const head = read(real);
  if (nativeProgram(head)) {
    // rustup dispatches using argv[0]; preserve its rustc proxy's name.
    return { file: id === 'rust' && /\/rustup(?:\.exe)?$/.test(normalized) ? file : real };
  }
  const text = head.toString('utf8');
  if (id === 'r' && platform !== 'win32' && text.startsWith('#!') && /R_HOME_DIR=/.test(text) && /--version/.test(text)) return { file: real };
  return { error: 'A script launcher was found. Passive detection does not execute unrecognized wrappers.' };
}

const WINDOWS_ALIAS = 'A Windows execution alias was found. A runtime behind this alias has not been verified.';

function nativeProgram(head) {
  return head[0] === 0x4d && head[1] === 0x5a // PE
    || head[0] === 0x7f && head.subarray(1, 4).toString() === 'ELF'
    || ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(head.subarray(0, 4).toString('hex'));
}

function windowsAlias(file) {
  return /[\\/]windowsapps[\\/]/i.test(file);
}

// The helper has a second, independent overall deadline in Environment. A
// timeout here resolves immediately, even if a descendant retains stdout.
// The kill is recorded for directory cleanup and does not delay this result.
export function runProbe(file, args, { env, cwd, timeoutMs = TIMEOUT_MS, limit = LIMIT, spawnProcess = spawn, kills = null } = {}) {
  return new Promise((resolve) => {
    let child, timer, size = 0, output = '', settled = false;
    const stop = () => {
      if (!child?.pid) return;
      const pending = new Promise((done) => {
        let ended = false;
        // Keep cleanup alive after the child is unref'd, even if 'close' never arrives.
        const backup = setTimeout(finishKill, 2000);
        function finishKill() {
          if (ended) return;
          ended = true;
          clearTimeout(backup);
          done();
        }
        // 'close' waits for the process to end. Do not settle when stdio is only destroyed.
        child.once('close', finishKill);
        if (process.platform === 'win32') killWindowsTree(child.pid, finishKill);
        else { try { child.kill('SIGKILL'); } catch { finishKill(); } }
      });
      if (Array.isArray(kills)) kills.push(pending);
      try { child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); } catch { /* the kill is already recorded */ }
    };
    const finish = (result, kill = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (kill) try { stop(); } catch { /* the probe result still stands */ }
      resolve({ output, ...result });
    };
    try {
      child = spawnProcess(file, args, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      timer = setTimeout(() => finish({ error: 'Version check timed out.' }, true), timeoutMs);
      for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) return finish({ error: 'Version check produced too much output.' }, true);
        output += chunk.toString();
      });
      child.on('error', () => finish({ error: 'Could not run the resolved executable.' }, true));
      child.on('close', (code) => finish({ code }));
    } catch { finish({ error: 'Could not run the resolved executable.' }, true); }
  });
}

const unavailable = {
  node: /no (?:default |installed )?(?:node|version)|version .*not installed/i,
  python: /no (?:suitable |installed )?(?:python|runtime)|python was not found|no runtimes? (?:are )?installed/i,
  go: /cannot find GOROOT|toolchain .*not available/i,
  dotnet: /no .NET SDKs were found|compatible .NET SDK was not found|SDK .*not found/i,
  rust: /no default is configured|toolchain .*not installed|could not choose a version|toolchain .*is not installable/i,
};

export async function scanRuntime(definition, { env, cwd, platform = process.platform, resolve = resolveCommand, inspect = passiveExecutable, run = runProbe, kills = null } = {}) {
  const { id, label, command, args, pattern } = definition;
  const base = { id, label, status: 'not_found', version: null, path: null, command, detail: null };
  const one = async (name) => {
    // A Windows execution alias must not be inspected or spawned. A later real binary still wins.
    let alias = null;
    const file = resolve(name, env, platform, {
      onSkip(candidate) {
        if (platform !== 'win32' || !windowsAlias(candidate)) return false;
        if (!alias || path.win32.extname(candidate).toLowerCase() === '.exe') alias = candidate;
        return true;
      },
    });
    if (!file) {
      if (!alias) return { ...base, command: name };
      return { ...base, command: name, path: alias, status: 'unavailable', detail: WINDOWS_ALIAS };
    }
    const row = { ...base, command: name, path: file };
    try {
      const executable = inspect(file, id, { platform, env });
      if (executable.error) return { ...row, status: 'unavailable', detail: executable.error };
      const result = await run(executable.file, args, { env: { ...probeEnv(env), DOTNET_CLI_HOME: cwd, DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false' }, cwd, kills });
      if (result.error) return { ...row, status: 'failed', detail: result.error };
      const version = result.code === 0 ? pattern.exec(result.output)?.[1] : null;
      if (version) return { ...row, status: 'ok', version };
      const missing = unavailable[id]?.test(result.output);
      return { ...row, status: missing ? 'unavailable' : 'failed', detail: missing
        ? 'The launcher was found, but it could not provide a local runtime.'
        : result.code === 0 ? 'The version response was not recognized.' : 'The version command did not complete successfully.' };
    } catch { return { ...row, status: 'failed', detail: 'Could not inspect the resolved executable.' }; }
  };
  // Fixed on every OS: python wins if it resolves, even when its probe fails.
  let row = await one(command);
  if (id === 'python') {
    const other = await one('python3');
    if (!row.path) row = other;
    else if (other.path && other.path !== row.path) row.alternatives = [other];
  }
  if (id === 'dotnet' && row.path && row.status !== 'failed') {
    try {
      const executable = inspect(row.path, id, { platform, env });
      if (!executable.error) {
        const result = await run(executable.file, ['--list-runtimes'], { env: { ...probeEnv(env), DOTNET_CLI_HOME: cwd }, cwd, kills });
        if (result.code === 0) row.runtimes = result.output.split(/\r?\n/).map((line) => line.match(/^(Microsoft\.[\w.]+) (\d+\.\d+\.\d+(?:-[\w.-]+)?) \[/))
          .filter(Boolean).map((match) => ({ name: match[1], version: match[2] }));
      }
    } catch { /* SDK result remains usable */ }
  }
  return row;
}

export function detectTools({ env, platform = process.platform, resolve = resolveCommand, exists = fs.existsSync } = {}) {
  const tools = [];
  const add = (id, label, file) => { if (file) tools.push({ id, label, path: file, status: 'detected' }); };
  if (platform === 'win32') add('nvm-windows', 'NVM for Windows', resolve('nvm', env, platform));
  else {
    const home = value(env, 'HOME') || os.homedir();
    const dir = value(env, 'NVM_DIR') || path.posix.join(home, '.nvm');
    const file = path.posix.join(dir, 'nvm.sh');
    if (path.posix.isAbsolute(file) && exists(file)) add('nvm', 'nvm', file);
  }
  for (const name of ['vfox', 'uv', 'pnpm']) add(name, name, resolve(name, env, platform));
  return tools;
}

// Design tools an agent can drive from a terminal. A version is read only from
// a native program whose real name is the tool's own: a snap, a Flatpak
// launcher or another wrapper is reported by presence. Windows `convert` is a
// disk utility, so ImageMagick is only `magick` there.
export const DESIGN_TOOLS = [
  {
    id: 'blender', label: 'Blender', args: ['--version', '--factory-startup'],
    commands: () => ['blender'],
    pattern: /^Blender (\d+\.\d+(?:\.\d+)?)/m, program: /^blender(?:\.exe)?$/i, installed: /^Blender\b/i,
  },
  {
    id: 'ffmpeg', label: 'FFmpeg', args: ['-version'],
    commands: () => ['ffmpeg'],
    pattern: /^ffmpeg version n?(\d+(?:\.\d+)+|N-\d+)/m, program: /^ffmpeg(?:\.exe)?$/i, installed: /^FFmpeg\b/i,
  },
  {
    // GIMP's window program on Windows does not print its version; the console build does.
    id: 'gimp', label: 'GIMP', args: ['--version'],
    commands: (platform) => platform === 'win32' ? ['gimp-console'] : ['gimp-console', 'gimp'],
    pattern: /version (\d+\.\d+\.\d+)/, installed: /^GIMP\b/i,
    program: (platform) => platform === 'win32' ? /^gimp-console(?:-[\d.]+)?\.exe$/i : /^gimp(?:-console)?(?:-[\d.]+)?$/i,
  },
  {
    id: 'inkscape', label: 'Inkscape', args: ['--version'],
    commands: () => ['inkscape'],
    pattern: /^Inkscape (\d+\.\d+(?:\.\d+)?)/m, program: /^inkscape(?:\.com|\.exe)?$/i, installed: /^Inkscape\b/i,
  },
  {
    id: 'imagemagick', label: 'ImageMagick', args: ['-version'],
    commands: (platform) => platform === 'win32' ? ['magick'] : ['magick', 'convert'],
    pattern: /^Version: ImageMagick (\d+\.\d+\.\d+(?:-\d+)?)/m, program: /^(?:magick|convert)(?:-im\d[\w.]*)?(?:\.exe)?$/i, installed: /^ImageMagick\b/i,
  },
];
const DESIGN_TIMEOUT_MS = 3000;
const REGISTRY_LIMIT = 1024 * 1024;
const UNINSTALL_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];
// Paths inside an install folder, Windows. A RegExp segment matches a directory entry.
const WINDOWS_FILES = {
  blender: [['blender.exe']],
  ffmpeg: [['bin', 'ffmpeg.exe'], ['ffmpeg.exe'], [/^ffmpeg-/i, 'bin', 'ffmpeg.exe']],
  gimp: [['bin', 'gimp-console.exe'], ['bin', /^gimp-console-[\d.]+\.exe$/i]],
  inkscape: [['bin', 'inkscape.com'], ['bin', 'inkscape.exe']],
  imagemagick: [['magick.exe']],
};

// Usual install locations, used only when PATH has no match. Each entry is an
// absolute root followed by segments below it.
export function designLocations(id, { platform = process.platform, env = process.env, registry = [] } = {}) {
  if (platform === 'win32') {
    const programFiles = [value(env, 'ProgramFiles'), value(env, 'ProgramW6432'), 'C:\\Program Files'].filter(Boolean);
    const profile = value(env, 'USERPROFILE');
    const local = value(env, 'LOCALAPPDATA') || (profile && path.win32.join(profile, 'AppData', 'Local'));
    const folders = {
      blender: programFiles.map((root) => [root, 'Blender Foundation', /^Blender/i]),
      ffmpeg: [],
      gimp: [...programFiles.map((root) => [root, /^GIMP/i]), ...(local ? [[local, 'Programs', /^GIMP/i]] : [])],
      inkscape: programFiles.map((root) => [root, 'Inkscape']),
      imagemagick: programFiles.map((root) => [root, /^ImageMagick/i]),
    }[id];
    return [...registry.map((dir) => [dir]), ...folders].flatMap((folder) => WINDOWS_FILES[id].map((file) => [...folder, ...file]));
  }
  const home = value(env, 'HOME') || os.homedir();
  const bins = platform === 'darwin'
    ? ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin']
    : ['/usr/local/bin', '/usr/bin', '/snap/bin', '/home/linuxbrew/.linuxbrew/bin'];
  const flatpaks = ['/var/lib/flatpak/exports/bin', path.posix.join(home, '.local/share/flatpak/exports/bin')];
  const apps = ['/Applications', path.posix.join(home, 'Applications')];
  const inBins = (names) => bins.flatMap((dir) => names.map((name) => [dir, name]));
  const flatpak = (app) => platform === 'linux' ? flatpaks.map((dir) => [dir, app]) : [];
  const bundle = (app, file) => platform === 'darwin' ? apps.map((dir) => [dir, app, 'Contents', 'MacOS', file]) : [];
  return {
    blender: [...bundle(/^Blender.*\.app$/i, 'Blender'), ...inBins(['blender']), ...flatpak('org.blender.Blender')],
    ffmpeg: inBins(['ffmpeg']),
    gimp: [...bundle(/^GIMP.*\.app$/i, /^gimp(?:-[\d.]+)?$/i), ...inBins(['gimp-console', 'gimp']), ...flatpak('org.gimp.GIMP')],
    inkscape: [...bundle(/^Inkscape.*\.app$/i, 'inkscape'), ...inBins(['inkscape']), ...flatpak('org.inkscape.Inkscape')],
    imagemagick: inBins(platform === 'darwin' ? ['magick'] : ['magick', 'convert']),
  }[id];
}

// The first existing file among the locations, in order. Directory listings are sorted.
export function findInstalled(locations, { platform = process.platform, readdir = fs.readdirSync, isFile = (file) => isExecutable(file, platform) } = {}) {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  for (const [root, ...segments] of locations) {
    let paths = [root];
    for (const segment of segments) {
      paths = paths.flatMap((dir) => {
        if (typeof segment === 'string') return [join(dir, segment)];
        try { return readdir(dir).filter((name) => segment.test(name)).sort().map((name) => join(dir, name)); } catch { return []; }
      });
    }
    const hit = paths.find((file) => isFile(file));
    if (hit) return hit;
  }
  return null;
}

function isExecutable(file, platform) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

// Install folders from Windows uninstall entries whose name is a design tool.
// Each query is bounded; a failed query adds nothing.
export async function windowsInstallFolders({ env, cwd, run = runProbe, kills = null } = {}) {
  const reg = path.win32.join(value(env, 'SystemRoot') || 'C:\\Windows', 'System32', 'reg.exe');
  const query = (args) => run(reg, ['query', ...args], { env, cwd, kills, timeoutMs: DESIGN_TIMEOUT_MS, limit: REGISTRY_LIMIT })
    .then((result) => result.code === 0 ? result.output : '');
  const entries = (output, name) => {
    const found = [];
    let key = null;
    for (const line of output.split(/\r?\n/)) {
      if (/^HKEY_/.test(line)) key = line.trim();
      const match = line.match(new RegExp(`^\\s+${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.+?)\\s*$`));
      if (key && match) found.push({ key, value: match[1] });
    }
    return found;
  };
  const named = (await Promise.all(UNINSTALL_KEYS.map((root) => query([root, '/s', '/v', 'DisplayName']))))
    .flatMap((output) => entries(output, 'DisplayName'))
    .map(({ key, value: name }) => ({ key, tool: DESIGN_TOOLS.find((tool) => tool.installed.test(name)) }))
    .filter(({ tool }) => tool);
  const folders = Object.fromEntries(DESIGN_TOOLS.map(({ id }) => [id, []]));
  await Promise.all(named.map(async ({ key, tool }) => {
    const folder = entries(await query([key, '/v', 'InstallLocation']), 'InstallLocation')[0]?.value.replace(/^"(.*)"$/, '$1');
    if (folder && path.win32.isAbsolute(folder)) folders[tool.id].push(folder);
  }));
  return folders;
}

// A Homebrew cask's command wrapper is exactly `exec "<program in the app>" "$@"`.
// Only that exact form is followed; any other script stays unchecked.
const HOMEBREW_WRAPPER = /\/Caskroom\/[^/]+\/[^/]+\/\.homebrew-command-wrappers\/[^/]+$/;

function homebrewTarget(head) {
  return head.toString('utf8').match(/^#!\/bin\/(?:ba)?sh\nexec "(\/[^"$`\\\n]+)"\s+"\$@"\n?$/)?.[1] ?? null;
}

// Why a found program's version is not read, or the program to run.
export function designProgram(file, tool, { platform = process.platform, realpath = fs.realpathSync, read = readHead } = {}) {
  let real = realpath(file);
  const normalized = real.replaceAll('\\', '/');
  if (/\/flatpak\/exports\/bin\//.test(file.replaceAll('\\', '/'))) return { reason: 'A Flatpak app. Its version is not checked.' };
  if (/(?:^|\/)snap$/.test(normalized)) return { reason: 'A snap. Its version is not checked.' };
  const head = read(real);
  if (!nativeProgram(head)) {
    const target = platform === 'darwin' && HOMEBREW_WRAPPER.test(normalized) ? homebrewTarget(head) : null;
    if (!target) return { reason: 'A launcher script. Its version is not checked.' };
    real = realpath(target);
    if (!nativeProgram(read(real))) return { reason: 'A launcher script. Its version is not checked.' };
  }
  const name = path.posix.basename(real.replaceAll('\\', '/'));
  const program = typeof tool.program === 'function' ? tool.program(platform) : tool.program;
  if (!program.test(name)) return { reason: `This runs ${name}, so its version is not checked.` };
  return { file: real };
}

// GTK programs write a D-Bus keyring and profile folders even for --version.
// Point every home and profile location at the scan's own temporary folder.
export function designEnv(env, cwd) {
  const out = probeEnv(env);
  const overrides = { DBUS_SESSION_BUS_ADDRESS: 'disabled:' };
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'INKSCAPE_PROFILE_DIR', 'GIMP2_DIRECTORY', 'GIMP3_DIRECTORY']) overrides[key] = cwd;
  for (const key of Object.keys(out)) if (Object.hasOwn(overrides, key.toUpperCase())) delete out[key];
  return { ...out, ...overrides };
}

export async function scanDesignTool(tool, {
  env, cwd, platform = process.platform, resolve = resolveCommand, installed = async () => null,
  inspect = designProgram, run = runProbe, kills = null, wslInterop = false,
} = {}) {
  const { id, label, args, pattern } = tool;
  const base = { id, label, status: 'not_found', version: null, path: null, command: null, detail: null };
  let command = null, file = null;
  for (const name of tool.commands(platform)) {
    file = resolve(name, env, platform, { onSkip: (candidate) => platform === 'win32' && windowsAlias(candidate) });
    if (file) { command = name; break; }
  }
  // WSL puts the Windows PATH on its own. Agents there run a Windows program by its .exe name.
  if (!file && wslInterop) {
    for (const name of tool.commands('win32').map((name) => `${name}.exe`)) {
      file = resolve(name, env, platform);
      if (file) return { ...base, status: 'on_path', path: file, command: name, detail: 'A Windows program, run through WSL. Its version is not checked.' };
    }
  }
  const onPath = Boolean(file);
  if (!file) file = await installed(id);
  if (!file) return { ...base, detail: 'Not on PATH or in the usual install locations.' };
  const row = { ...base, status: onPath ? 'on_path' : 'not_on_path', path: file, command };
  try {
    const program = inspect(file, tool, { platform });
    if (program.reason) return { ...row, detail: program.reason };
    const result = await run(program.file, args, { env: designEnv(env, cwd), cwd, kills, timeoutMs: DESIGN_TIMEOUT_MS });
    const version = !result.error && result.code === 0 ? pattern.exec(result.output)?.[1] : null;
    if (version) return { ...row, version };
    return { ...row, detail: result.error === 'Version check timed out.' ? 'The version check timed out.'
      : result.error ? 'Could not read its version.' : 'Its version response was not recognized.' };
  } catch { return { ...row, detail: 'Could not read its version.' }; }
}

export async function scanDesignTools({ env, cwd, platform = process.platform, resolve = resolveCommand, kills = null, send = () => {} } = {}) {
  let folders = null;
  // Read the registry at most once, and only when some tool is missing from PATH.
  const registry = () => folders ??= platform === 'win32'
    ? windowsInstallFolders({ env, cwd, kills }).catch(() => ({}))
    : Promise.resolve({});
  const installed = async (id) => findInstalled(designLocations(id, { platform, env, registry: (await registry())[id] || [] }), { platform });
  const wslInterop = platform === 'linux' && isWsl({ env }) && wslInteropEnabled();
  // Bounded concurrency: cold starts of large applications compete for the disk.
  const queue = [...DESIGN_TOOLS];
  await Promise.all([0, 1, 2].map(async () => {
    for (let tool = queue.shift(); tool; tool = queue.shift()) {
      send(await scanDesignTool(tool, { env, cwd, platform, resolve, installed, kills, wslInterop }));
    }
  }));
}

// Windows cannot remove a process's current working directory, and a probe
// killed at its deadline can still hold that directory. Cleanup must not
// decide whether the scan succeeded.
export async function releaseScanDirectory(cwd, kills = [], {
  chdir = (dir) => process.chdir(dir),
  remove = fs.rmSync,
  tmpdir = os.tmpdir,
} = {}) {
  await Promise.all(kills).catch(() => {});
  let temp = '';
  try { temp = tmpdir(); } catch { /* removal is skipped below */ }
  try { if (temp) chdir(temp); } catch { /* still try to remove the scan directory */ }
  if (!cwd || !temp) return;
  if (path.dirname(cwd) !== path.resolve(temp) || !path.basename(cwd).startsWith('agent-guild-environment-')) return;
  try {
    remove(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
  } catch { /* a leftover lock must not fail the scan */ }
}

if ((process.argv[2] === '--scan-pins' || process.argv[2] === '--pin-identity') && process.send) {
  // Read the named folder by absolute path. Never chdir into it: a project
  // directory can activate tools on entry, and this check must not.
  const started = process.cwd();
  const result = scanPins(process.argv[3], { identityOnly: process.argv[2] === '--pin-identity' });
  process.send({ ...result, cwd: process.cwd() });
  if (process.cwd() !== started) process.chdir(started);
  process.send({ done: true });
}

if (process.argv[2] === '--scan-environment' && process.send) {
  // A fresh temporary directory contains no project files. Manager env is
  // retained; no selected shell, project or session is inspected or changed.
  let cwd;
  let finished = false;
  const kills = [];
  try {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-environment-'));
    process.chdir(cwd);
    const env = { ...process.env };
    process.send({ tools: detectTools({ env }) });
    await Promise.all([
      (async () => {
        // Two batches bound concurrency while giving each runtime its own result.
        for (let i = 0; i < RUNTIMES.length; i += 3) {
          await Promise.all(RUNTIMES.slice(i, i + 3).map(async (definition) => {
            const runtime = await scanRuntime(definition, { env, cwd, kills });
            process.send({ runtime });
          }));
        }
      })(),
      scanDesignTools({ env, cwd, kills, send: (design) => process.send({ design }) }),
      dockerInfo({ env, resolve: resolveCommand })
        .catch(() => ({ status: 'failed', detail: 'The Docker check did not finish.' }))
        .then((docker) => process.send({ docker })),
      // System facts are the same for every scope, so only the manager asks.
      process.argv.includes('--system') && systemInfo({ env, cwd, run: runProbe, kills })
        .catch(() => null)
        .then((system) => process.send({ system })),
    ]);
    finished = true;
  } finally {
    await releaseScanDirectory(cwd, kills);
  }
  if (finished) process.send({ done: true });
}
