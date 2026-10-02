import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildSpawnSpec, runSpec, killWindowsTree } from './command-resolver.mjs';

export const REPORT_COMMAND = 'agent-guild-report --hook';
export const PLUGIN_NAME = 'agent-guild';
const MANIFEST_DESCRIPTION = 'Reports to the Agent Guild session it runs in.';
const PROBE_TIMEOUT_MS = 20000;
const PROBE_RETRY_MS = 5 * 60 * 1000;

const handler = (extra = {}) => ({ type: 'command', command: REPORT_COMMAND, ...extra });
const groups = (events, extra) => Object.fromEntries(events.map((event) => [event, [{ ...extra?.[event]?.group, hooks: [handler(extra?.[event]?.handler)] }]]));

const shellEvents = (events, matcher) => Object.fromEntries(events.map((event) => [event, { group: { matcher } }]));

const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'PostModelSwitch', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Stop'];
const CLAUDE_MATCHERS = { PreToolUse: 'Bash|PowerShell', PermissionRequest: 'Bash|PowerShell', PostToolUse: 'Bash|PowerShell|TaskStop', PostToolUseFailure: 'Bash|PowerShell' };
const CLAUDE_BLOCKING = new Set(['SubagentStart', 'PreToolUse']);
export const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd'];
const CODEX_MATCHERS = { PermissionRequest: 'Bash', PostToolUse: 'Bash' };

// Only the start of a sub-agent or a command holds Claude Code up, so the start reaches the manager before its end.
const claudeHooks = () => Object.fromEntries(CLAUDE_EVENTS.map((event) => [event, [{
  ...(CLAUDE_MATCHERS[event] ? { matcher: CLAUDE_MATCHERS[event] } : {}),
  hooks: [handler(CLAUDE_BLOCKING.has(event) ? {} : { async: true })],
}]]));
const GROK_EVENTS = ['SessionStart', 'SubagentStart', 'SubagentStop', 'StopCancelled', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'];

// Antigravity CLI loads an installed plugin into every session, also those started outside Agent Guild, and runs
// its hooks in the plugin's folder, on Windows through cmd /C, which cannot take a quoted path. So the hook is a
// script in that folder: it reports only inside an Agent Guild Antigravity session, and always prints the JSON object
// Antigravity reads.
function antigravityFiles(manifest, platform) {
  const script = platform === 'win32'
    ? ['@echo off', `if "%AGENT_GUILD_REPORTING%"=="antigravity" call ${REPORT_COMMAND} --event %1`, 'echo {}', ''].join('\r\n')
    : ['#!/bin/sh', `if [ "$AGENT_GUILD_REPORTING" = antigravity ] && command -v agent-guild-report >/dev/null 2>&1; then ${REPORT_COMMAND} --event "$1"; else cat >/dev/null; fi`, "echo '{}'", ''].join('\n');
  const name = platform === 'win32' ? 'agent-guild-hook.cmd' : 'agent-guild-hook.sh';
  const command = platform === 'win32' ? `.\\${name} PreInvocation` : `sh ${name} PreInvocation`;
  return {
    'plugin.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'hooks.json': `${JSON.stringify({ [PLUGIN_NAME]: { PreInvocation: [{ type: 'command', command, timeout: 10 }] } }, null, 2)}\n`,
    [name]: script,
  };
}

export function bundleFiles(version, { platform = process.platform } = {}) {
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const manifest = { name: PLUGIN_NAME, version, description: MANIFEST_DESCRIPTION };
  return {
    claude: {
      '.claude-plugin/plugin.json': json(manifest),
      'hooks/hooks.json': json({ hooks: claudeHooks() }),
    },
    antigravity: antigravityFiles({ name: PLUGIN_NAME, description: MANIFEST_DESCRIPTION }, platform),
    grok: {
      '.grok-plugin/plugin.json': json(manifest),
      'hooks/hooks.json': json({
        hooks: groups(GROK_EVENTS, { SessionEnd: { handler: { timeout: 10 } }, ...shellEvents(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'], 'run_terminal_command') }),
      }),
    },
  };
}

export function writeBundles(dir, version, opts) {
  const out = {};
  for (const [name, files] of Object.entries(bundleFiles(version, opts))) {
    const root = path.join(dir, name);
    for (const [rel, contents] of Object.entries(files)) {
      const file = path.join(root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, contents);
      fs.renameSync(tmp, file);
    }
    out[name] = root;
  }
  return out;
}

const tomlString = (value) => `'${value}'`;

export function codexHookArgs() {
  const value = (event) => {
    const matcher = CODEX_MATCHERS[event] ? `matcher=${tomlString(CODEX_MATCHERS[event])},` : '';
    return `[{${matcher}hooks=[{type=${tomlString('command')},command=${tomlString(REPORT_COMMAND)}}]}]`;
  };
  return CODEX_EVENTS.flatMap((event) => ['-c', `hooks.${event}=${value(event)}`]);
}

export function codexTrustArgs(hooks) {
  if (hooks.some(({ key, hash }) => /['\n]/.test(key) || /['\n]/.test(hash))) return null;
  return ['-c', `hooks.state={${hooks.map(({ key, hash }) => `${tomlString(key)}={trusted_hash=${tomlString(hash)}}`).join(',')}}`];
}

export function codexHooksFrom(result) {
  const hooks = (result?.data || []).flatMap((entry) => entry.hooks || [])
    .filter((h) => h.source === 'sessionFlags' && h.command === REPORT_COMMAND && h.enabled !== false);
  const found = CODEX_EVENTS.map((event) => {
    const name = event.charAt(0).toLowerCase() + event.slice(1);
    return hooks.find((h) => h.eventName === name);
  });
  if (found.some((h) => !h || typeof h.key !== 'string' || typeof h.currentHash !== 'string')) return null;
  return found.map((h) => ({ key: h.key, hash: h.currentHash, trusted: h.trustStatus === 'trusted' }));
}

export function codexHooksList(resolved, args, { env, platform = process.platform, timeoutMs = PROBE_TIMEOUT_MS, tmpDir = os.tmpdir() } = {}) {
  const home = fs.mkdtempSync(path.join(tmpDir, 'agent-guild-codex-'));
  const spec = buildSpawnSpec(resolved, [...args, 'app-server'], env, platform);
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      endTree(child, platform);
      setTimeout(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }, () => {}), 500).unref();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Codex did not answer in time')), timeoutMs);
    timer.unref?.();
    try {
      const verbatim = typeof spec.args === 'string';
      child = spawn(spec.file, verbatim ? [spec.args] : spec.args, {
        cwd: home, env: { ...env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: verbatim,
      });
    } catch (err) {
      return finish(err);
    }
    let stderr = '';
    let buffer = '';
    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    child.on('error', (err) => finish(err));
    child.on('exit', (code) => finish(new Error(`Codex exited with code ${code}: ${stderr.trim().split('\n').find((l) => /error|caused/i.test(l)) || ''}`.trim())));
    child.stdin.on('error', () => {});
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          if (msg.error) return finish(new Error(msg.error.message || 'initialize failed'));
          send({ method: 'initialized' });
          send({ id: 2, method: 'hooks/list', params: { cwds: [home] } });
        } else if (msg.id === 2) {
          if (msg.error) return finish(new Error(msg.error.message || 'hooks/list failed'));
          return finish(null, msg.result);
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent-guild', title: null, version: '1' } } });
  });
}

function endTree(child, platform) {
  if (!child || child.exitCode !== null) return;
  try { child.stdin.end(); } catch { /* closed */ }
  if (platform === 'win32' && child.pid) return killWindowsTree(child.pid);
  try { child.kill(); } catch { /* gone */ }
}

export async function probeCodex(resolved, opts) {
  const hookArgs = codexHookArgs();
  const listed = codexHooksFrom(await codexHooksList(resolved, hookArgs, opts));
  if (!listed) return { args: [], trusted: false, error: 'Codex did not load the hooks' };
  if (listed.every((h) => h.trusted)) return { args: hookArgs, trusted: true };
  const trustArgs = codexTrustArgs(listed);
  if (trustArgs) {
    try {
      const again = codexHooksFrom(await codexHooksList(resolved, [...hookArgs, ...trustArgs], opts));
      if (again?.every((h) => h.trusted)) return { args: [...hookArgs, ...trustArgs], trusted: true };
    } catch { /* fall back to untrusted hooks, which Codex asks the user about */ }
  }
  return { args: hookArgs, trusted: false };
}

export function helpLists(text, flag) {
  return new RegExp(`^\\s+(?:-\\w, )?${flag.replace(/[-]/g, '\\-')}\\b`, 'm').test(text);
}

const geminiHome = (env, platform) => path.join((platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir(), '.gemini');

/** Where `agy plugin install` copies the plugin and where Antigravity CLI loads it from. */
export function antigravityPluginDir(env = {}, platform = process.platform) {
  return path.join(geminiHome(env, platform), 'config', 'plugins', PLUGIN_NAME);
}

/** The shared Antigravity settings, where `agy plugin disable` turns a plugin off. */
export function antigravityConfigFile(env = {}, platform = process.platform) {
  return path.join(geminiHome(env, platform), 'config', 'config.json');
}

/** True unless the settings turn the plugin off or cannot be read; no settings file means every plugin is on. */
export function antigravityPluginEnabled(configFile) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (err) {
    return err.code === 'ENOENT';
  }
  if (!config || typeof config !== 'object') return false;
  return config.plugins?.[PLUGIN_NAME]?.enabled !== false;
}

function readOr(file, fallback) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; }
}

/** "current" when the installed copy matches the bundle, "stale" when it is an older one of ours, "other" or null. */
export function antigravityInstalled(pluginDir, bundle) {
  const manifest = readOr(path.join(pluginDir, 'plugin.json'), null);
  if (manifest === null) return null;
  let description = null;
  try { description = JSON.parse(manifest)?.description; } catch { /* not ours */ }
  if (description !== MANIFEST_DESCRIPTION) return 'other';
  let names = [];
  try { names = fs.readdirSync(bundle); } catch { return 'stale'; }
  const same = names.every((name) => readOr(path.join(pluginDir, name), null) === readOr(path.join(bundle, name), ''));
  return same ? 'current' : 'stale';
}

const pending = (tool, when) => ({ state: 'pending', reason: `Agent Guild added its reporting hooks to this ${tool} session. They report once ${tool} ${when}.` });

export class SessionHooks {
  constructor({ registry, dir, version, probeTimeoutMs = PROBE_TIMEOUT_MS, probeRetryMs = PROBE_RETRY_MS }) {
    this.registry = registry;
    this.probeTimeoutMs = probeTimeoutMs;
    this.probeRetryMs = probeRetryMs;
    this.dir = dir;
    this.bundles = null;
    this.probes = new Map();
    if (dir) {
      try {
        this.bundles = writeBundles(dir, version, { platform: registry.platform });
      } catch (err) {
        console.warn(`[reporting] could not write the reporting hooks to ${dir}: ${err.message}`);
      }
    }
  }

  warm() {
    for (const provider of this.registry.providers) {
      if (provider.reporting === 'claude' || provider.reporting === 'codex' || provider.reporting === 'grok') this._probe(provider).catch(() => {});
    }
  }

  _probe(provider) {
    const resolved = this.registry.resolve(provider);
    if (!resolved) return Promise.resolve(null);
    let mtime = null;
    try { mtime = fs.statSync(resolved).mtimeMs; } catch { /* probe anyway */ }
    const cached = this.probes.get(provider.id);
    const fresh = cached && cached.resolved === resolved && cached.mtime === mtime && (cached.ok || Date.now() - cached.at < this.probeRetryMs);
    if (fresh) return cached.promise;
    const env = { ...this.registry.env, ...provider.env };
    const platform = this.registry.platform;
    const entry = { resolved, mtime, at: Date.now(), ok: false };
    entry.promise = (async () => {
      if (provider.reporting === 'codex') {
        const result = await probeCodex(resolved, { env, platform, timeoutMs: this.probeTimeoutMs });
        entry.ok = result.args.length > 0;
        return result;
      }
      const { stdout, stderr } = await runSpec(buildSpawnSpec(resolved, ['--help'], env, platform), { env, timeoutMs: this.probeTimeoutMs });
      entry.ok = true;
      return { pluginDir: helpLists(`${stdout}\n${stderr}`, '--plugin-dir') };
    })().catch((err) => ({ error: err.message }));
    this.probes.set(provider.id, entry);
    return entry.promise;
  }

  async launch(provider) {
    const mode = provider.reporting;
    if (!mode) return { args: [], reporting: null };
    const tool = provider.tool;
    if (!this.bundles) {
      return { args: [], reporting: { state: 'unavailable', reason: `Agent Guild could not write its reporting hooks, so ${tool} cannot report agents.` } };
    }
    if (mode === 'antigravity') {
      if (this.enabled(provider)) return { args: [], reporting: pending(tool, 'runs its first prompt') };
      return { args: [], reporting: { state: 'setup_required', reason: `Agent reporting is off for ${tool}. Turn it on from the ${tool} card; it applies to new sessions.` } };
    }
    const probe = await this._probe(provider);
    if (mode === 'codex') {
      if (probe?.args?.length) return { args: probe.args, reporting: pending(tool, 'runs its first prompt') };
      return { args: [], reporting: { state: 'unavailable', reason: `${tool} did not accept Agent Guild's reporting hooks${probe?.error ? ` (${probe.error})` : ''}.` } };
    }
    const dir = mode === 'claude' ? this.bundles.claude : this.bundles.grok;
    if (probe?.pluginDir) return { args: ['--plugin-dir', dir], reporting: pending(tool, 'starts its session') };
    if (probe?.error) {
      return { args: [], reporting: { state: 'unavailable', reason: `Could not check whether ${tool} can load Agent Guild's reporting hooks (${probe.error}).` } };
    }
    return {
      args: [],
      reporting: {
        state: 'unsupported',
        reason: `This version of ${tool} cannot load hooks for a single session, so Agent Guild cannot add its reporting hooks. Hooks you add to ${tool}'s own settings still report agents.`,
      },
    };
  }

  enabled(provider) {
    if (provider.reporting !== 'antigravity' || !this.bundles) return null;
    return this._installed(provider) === 'current' && this._pluginEnabled(provider);
  }

  _installed(provider) {
    return antigravityInstalled(antigravityPluginDir({ ...this.registry.env, ...provider.env }, this.registry.platform), this.bundles.antigravity);
  }

  _pluginEnabled(provider) {
    return antigravityPluginEnabled(antigravityConfigFile({ ...this.registry.env, ...provider.env }, this.registry.platform));
  }

  async setEnabled(provider, enabled) {
    if (provider.reporting !== 'antigravity') throw Object.assign(new Error(`${provider.tool} needs no setup for agent reporting`), { status: 400, code: 'not_applicable' });
    if (!this.bundles) throw Object.assign(new Error('Agent Guild could not write its reporting hooks'), { status: 500, code: 'reporting_unavailable' });
    const resolved = this.registry.resolve(provider);
    if (!resolved) throw Object.assign(new Error(`${provider.tool} is not installed`), { status: 409, code: 'provider_unavailable' });
    const installed = this._installed(provider);
    if (enabled ? installed === 'current' && this._pluginEnabled(provider) : !installed) return enabled;
    if (installed === 'other') {
      if (!enabled) return false;
      throw Object.assign(new Error(`${provider.tool} already has another plugin named "${PLUGIN_NAME}". Remove it with "${provider.command} plugin uninstall ${PLUGIN_NAME}" to turn on agent reporting.`), { status: 409, code: 'plugin_conflict' });
    }
    const env = { ...this.registry.env, ...provider.env };
    const run = async (args, what) => {
      try {
        await runSpec(buildSpawnSpec(resolved, args, env, this.registry.platform), { env, timeoutMs: 60000, cwd: this.dir });
      } catch (err) {
        const detail = `${err.stderr || ''}\n${err.stdout || ''}`.trim().split('\n').filter(Boolean).pop() || err.message;
        throw Object.assign(new Error(`${provider.tool} could not ${what} the Agent Guild plugin: ${detail}`), { status: 502, code: 'reporting_setup_failed' });
      }
    };
    if (installed && (!enabled || installed === 'stale')) await run(['plugin', 'uninstall', PLUGIN_NAME], 'remove');
    if (enabled && installed !== 'current') await run(['plugin', 'install', this.bundles.antigravity], 'install');
    if (enabled && !this._pluginEnabled(provider)) await run(['plugin', 'enable', PLUGIN_NAME], 'turn on');
    const now = this.enabled(provider);
    if (now !== enabled) {
      throw Object.assign(new Error(`${provider.tool} reported success, but the Agent Guild plugin is ${now ? 'still on' : 'not on'}`), { status: 502, code: 'reporting_setup_failed' });
    }
    return now;
  }
}
