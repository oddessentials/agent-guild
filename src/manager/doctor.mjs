// Installation and tooling health diagnostics for Agent Guild.
//
// Checks:
// - Node.js version (minimum 22 required)
// - Platform and OS details
// - Terminal PTY subsystem (node-pty native bindings, C library)
// - Data directory permissions and configuration files
// - Session manager health, port availability, and version alignment
// - Availability and versions of AI coding tools and terminal multiplexers

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {
  DEFAULT_HOST,
  VERSION,
  dataDir,
  ensureDataDir,
  paths,
  readRuntimeFile,
  resolvePort,
} from './config.mjs';
import { ptyProblem, loadPty, glibcVersion } from './pty.mjs';
import { defaultBoot } from './launch.mjs';
import { startupState, startupSummary, unitPort } from './systemd-service.mjs';
import { resolveCommand } from './command-resolver.mjs';
import { probeVersion } from './versions.mjs';

export const MIN_NODE_MAJOR = 22;

const KNOWN_TOOLS = [
  {
    id: 'google',
    name: 'Antigravity CLI',
    command: 'agy',
    versionArgs: ['--version'],
    install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    docs: 'https://antigravity.google/docs/cli/install',
  },
  {
    id: 'anthropic',
    name: 'Claude Code',
    command: 'claude',
    versionArgs: ['--version'],
    install: 'curl -fsSL https://claude.ai/install.sh | bash',
    docs: 'https://code.claude.com/docs/en/setup',
  },
  {
    id: 'openai',
    name: 'Codex CLI',
    command: 'codex',
    versionArgs: ['--version'],
    install: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    docs: 'https://github.com/openai/codex',
  },
  {
    id: 'xai',
    name: 'Grok Build',
    command: 'grok',
    versionArgs: ['--version'],
    install: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    docs: 'https://docs.x.ai/build/overview',
  },
  {
    id: 'docker',
    name: 'Docker Agent',
    command: 'docker',
    versionArgs: ['agent', 'version'],
    install: 'sh -c \'d="${DOCKER_CONFIG:-$HOME/.docker}/cli-plugins" && mkdir -p "$d" && curl -fsSL "https://github.com/docker/docker-agent/releases/latest/download/docker-agent-$(uname -s | tr "[:upper:]" "[:lower:]")-$(uname -m | sed "s/x86_64/amd64/;s/aarch64/arm64/")" -o "$d/docker-agent.tmp" && chmod +x "$d/docker-agent.tmp" && mv -f "$d/docker-agent.tmp" "$d/docker-agent"\'',
    docs: 'https://docker.github.io/docker-agent/getting-started/installation/',
  },
  {
    id: 'tmux',
    name: 'tmux',
    command: 'tmux',
    versionArgs: ['-V'],
    docs: 'https://github.com/tmux/tmux/wiki/Installing',
  },
  {
    id: 'herdr',
    name: 'herdr',
    command: 'herdr',
    versionArgs: ['--version'],
    docs: 'https://herdr.dev/docs/install/',
  },
];

/** Check if port is available to listen on host. */
export function checkPortAvailable(port, host = DEFAULT_HOST) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve(false);
      else resolve(null);
    });
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, host);
  });
}

/** Check manager health via HTTP. */
async function checkHealth(url, timeoutMs = 1000) {
  try {
    const res = await fetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.name === 'agent-guild' ? body : null;
  } catch {
    return null;
  }
}

/**
 * Perform all diagnostic checks. All dependencies can be injected for testing.
 */
export async function diagnose({
  nodeVersion = process.versions.node,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  dir = dataDir(),
  port = resolvePort(),
  fetchHealth = checkHealth,
  testPortAvailable = checkPortAvailable,
  checkPtyProblem = ptyProblem,
  verifyLoadPty = loadPty,
  tools = KNOWN_TOOLS,
} = {}) {
  // 1. Node.js check
  const nodeMajor = Number(nodeVersion.split('.')[0]);
  const nodeOk = nodeMajor >= MIN_NODE_MAJOR;
  const node = {
    version: nodeVersion,
    major: nodeMajor,
    ok: nodeOk,
  };

  // 2. Platform & OS
  const glibc = platform === 'linux' ? glibcVersion() : null;
  const sys = {
    platform,
    arch,
    type: os.type(),
    release: os.release(),
    glibc,
  };

  // 3. PTY subsystem
  let ptyOk = true;
  let ptyError = checkPtyProblem({ platform });
  if (ptyError) {
    ptyOk = false;
  } else {
    try {
      verifyLoadPty();
    } catch (err) {
      ptyOk = false;
      ptyError = err.message;
    }
  }
  const pty = {
    ok: ptyOk,
    error: ptyError,
  };

  // 4. Data directory & configuration
  let dirExists = false;
  let dirWritable = false;
  let writeError = null;
  try {
    ensureDataDir(dir);
    dirExists = fs.existsSync(dir);
    const probe = path.join(dir, `.doctor-probe-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    dirWritable = true;
  } catch (err) {
    writeError = err.message;
  }

  const tokenPath = path.join(dir, 'auth-token');
  const hasToken = fs.existsSync(tokenPath);

  let providersConfig = null;
  const userProvidersPath = path.join(dir, 'providers.json');
  if (fs.existsSync(userProvidersPath)) {
    try {
      JSON.parse(fs.readFileSync(userProvidersPath, 'utf8'));
      providersConfig = { exists: true, valid: true };
    } catch (err) {
      providersConfig = { exists: true, valid: false, error: err.message };
    }
  }

  const storage = {
    dir,
    exists: dirExists,
    writable: dirWritable,
    writeError,
    hasToken,
    providersConfig,
  };

  // 5. Session manager & port
  const runtime = readRuntimeFile();
  const url = runtime?.url || `http://${DEFAULT_HOST}:${port}`;
  const health = await fetchHealth(url);
  let managerInfo = null;

  if (health) {
    let sessionsCount = null;
    if (hasToken) {
      try {
        const token = fs.readFileSync(tokenPath, 'utf8').trim();
        const res = await fetch(`${url}/api/v1/sessions`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok) {
          const body = await res.json();
          sessionsCount = Array.isArray(body.sessions) ? body.sessions.length : null;
        }
      } catch { /* optional */ }
    }
    managerInfo = {
      running: true,
      url,
      port,
      pid: health.pid,
      version: health.version,
      versionMatch: health.version === VERSION,
      sessionsCount,
    };
  } else {
    const isFree = await testPortAvailable(port, DEFAULT_HOST);
    managerInfo = {
      running: false,
      url,
      port,
      portFree: isFree === true,
      portConflict: isFree === false,
    };
  }

  // Systemd startup check on Linux
  let startup = null;
  const boot = defaultBoot();
  if (boot) {
    try {
      const read = await boot.read();
      if (read?.enabled) {
        const uPort = unitPort(await boot.text().catch(() => null));
        startup = startupSummary(startupState(read.show, { port: uPort }));
      }
    } catch { /* systemd not accessible */ }
  }
  managerInfo.startup = startup;

  // 6. AI Assistants & Tools
  const toolResults = [];
  for (const tool of tools) {
    const resolved = resolveCommand(tool.command, env, platform);
    if (resolved) {
      const spec = { command: resolved, args: tool.versionArgs || ['--version'] };
      const probe = await probeVersion(spec, { env, timeoutMs: 3000 });
      toolResults.push({
        ...tool,
        found: true,
        path: resolved,
        version: probe.version,
      });
    } else {
      toolResults.push({
        ...tool,
        found: false,
      });
    }
  }

  const fatalIssues = [
    !nodeOk && 'Node.js version is below requirement (>= 22)',
    !ptyOk && (ptyError || 'node-pty native bindings failed to load'),
    !dirWritable && `Data directory is not writable (${writeError})`,
    managerInfo.portConflict && `Port ${port} is in use by another process`,
    providersConfig && !providersConfig.valid && `providers.json contains invalid JSON: ${providersConfig.error}`,
  ].filter(Boolean);

  return {
    version: VERSION,
    node,
    sys,
    pty,
    storage,
    manager: managerInfo,
    tools: toolResults,
    fatalIssues,
    healthy: fatalIssues.length === 0,
  };
}

/**
 * Format the diagnostics object as human-readable markdown / terminal text.
 */
export function formatDiagnostics(diag) {
  const lines = [];
  lines.push(`Agent Guild Doctor (v${diag.version})`);
  lines.push('');

  // 1. Environment
  lines.push('Environment:');
  if (diag.node.ok) {
    lines.push(`  ✔ Node.js v${diag.node.version} (meets requirement >= ${MIN_NODE_MAJOR})`);
  } else {
    lines.push(`  ✖ Node.js v${diag.node.version} (unsupported; Node.js ${MIN_NODE_MAJOR} or newer is required)`);
  }

  const glibcNote = diag.sys.glibc ? ` · glibc ${diag.sys.glibc}` : '';
  lines.push(`  ✔ Platform: ${diag.sys.platform} (${diag.sys.arch} · ${diag.sys.type} ${diag.sys.release}${glibcNote})`);

  if (diag.pty.ok) {
    lines.push('  ✔ Terminal subsystem (node-pty): functional');
  } else {
    lines.push('  ✖ Terminal subsystem (node-pty): problem detected');
    for (const msgLine of String(diag.pty.error || '').split('\n')) {
      lines.push(`    ${msgLine}`);
    }
  }
  lines.push('');

  // 2. Data Directory & Files
  lines.push('Data Directory & Configuration:');
  lines.push(`  ✔ Location: ${diag.storage.dir}`);
  if (diag.storage.writable) {
    lines.push('  ✔ Permissions: directory is writable');
  } else {
    lines.push(`  ✖ Permissions: cannot write to data directory (${diag.storage.writeError})`);
  }

  if (diag.storage.hasToken) {
    lines.push('  ✔ Access token: present');
  } else {
    lines.push('  ℹ Access token: not yet generated (created automatically on first launch)');
  }

  if (diag.storage.providersConfig) {
    if (diag.storage.providersConfig.valid) {
      lines.push('  ✔ Custom tools (providers.json): valid');
    } else {
      lines.push(`  ✖ Custom tools (providers.json): invalid syntax (${diag.storage.providersConfig.error})`);
    }
  } else {
    lines.push('  ✔ Custom tools (providers.json): default configuration');
  }
  lines.push('');

  // 3. Session Manager
  lines.push('Session Manager:');
  if (diag.manager.running) {
    lines.push(`  ✔ Status: running at ${diag.manager.url} (pid ${diag.manager.pid})`);
    if (diag.manager.versionMatch) {
      lines.push(`  ✔ Version: v${diag.manager.version} (matches installed package)`);
    } else {
      lines.push(`  ! Version: running v${diag.manager.version}, installed v${diag.version} (run "agent-guild stop" then start again to update)`);
    }
    if (typeof diag.manager.sessionsCount === 'number') {
      lines.push(`  ℹ Active sessions: ${diag.manager.sessionsCount}`);
    }
  } else if (diag.manager.portConflict) {
    lines.push(`  ✖ Status: not running, but port ${diag.manager.port} is in use by another process`);
  } else {
    lines.push(`  ℹ Status: not running (port ${diag.manager.port} is available)`);
  }

  if (diag.manager.startup) {
    lines.push(`  ✔ Startup service: ${diag.manager.startup}`);
  }
  lines.push('');

  // 4. Tools
  lines.push('Coding Assistants & Multiplexers:');
  for (const t of diag.tools) {
    if (t.found) {
      const v = t.version ? `v${t.version}` : 'installed';
      lines.push(`  ✔ ${t.name} (${t.command}): ${v} (${t.path})`);
    } else {
      const tip = t.install ? ` · install: ${t.install}` : t.docs ? ` · ${t.docs}` : '';
      lines.push(`  ℹ ${t.name} (${t.command}): not found on PATH${tip}`);
    }
  }
  lines.push('');

  // Summary
  if (diag.healthy) {
    lines.push('Doctor found no fatal problems.');
  } else {
    const count = diag.fatalIssues.length;
    lines.push(`Doctor found ${count} fatal problem${count === 1 ? '' : 's'} (see ✖ above).`);
  }

  return lines.join('\n');
}

/**
 * Run doctor command and output to console. Returns true if healthy, false if fatal issues found.
 */
export async function runDoctor(opts = {}) {
  const out = opts.log || console.log;
  const diag = await diagnose(opts);
  out(formatDiagnostics(diag));
  return diag.healthy;
}
