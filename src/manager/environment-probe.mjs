// Passive discovery only. This module is also the isolated helper entry point.
// Never source profiles, invoke package managers, or use a project directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveCommand, killWindowsTree } from './command-resolver.mjs';

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
  const binary = head[0] === 0x4d && head[1] === 0x5a // PE
    || head[0] === 0x7f && head.subarray(1, 4).toString() === 'ELF'
    || ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(head.subarray(0, 4).toString('hex'));
  if (binary) {
    // rustup dispatches using argv[0]; preserve its rustc proxy's name.
    return { file: id === 'rust' && /\/rustup(?:\.exe)?$/.test(normalized) ? file : real };
  }
  const text = head.toString('utf8');
  if (id === 'r' && platform !== 'win32' && text.startsWith('#!') && /R_HOME_DIR=/.test(text) && /--version/.test(text)) return { file: real };
  return { error: 'A script launcher was found. Passive detection does not execute unrecognized wrappers.' };
}

const WINDOWS_ALIAS = 'A Windows execution alias was found. A runtime behind this alias has not been verified.';

function windowsAlias(file) {
  return /[\\/]windowsapps[\\/]/i.test(file);
}

// The helper has a second, independent overall deadline in Environment. A
// timeout here resolves immediately, even if a descendant retains stdout.
// The kill is recorded for directory cleanup and does not delay this result.
export function runProbe(file, args, { env, cwd, timeoutMs = TIMEOUT_MS, spawnProcess = spawn, kills = null } = {}) {
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
        if (size > LIMIT) return finish({ error: 'Version check produced too much output.' }, true);
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
    // Two batches bound concurrency while giving each runtime its own result.
    for (let i = 0; i < RUNTIMES.length; i += 3) {
      await Promise.all(RUNTIMES.slice(i, i + 3).map(async (definition) => {
        const runtime = await scanRuntime(definition, { env, cwd, kills });
        process.send({ runtime });
      }));
    }
    finished = true;
  } finally {
    await releaseScanDirectory(cwd, kills);
  }
  if (finished) process.send({ done: true });
}
