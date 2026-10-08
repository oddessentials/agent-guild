import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildSpawnSpec, runSpec, killWindowsTree } from './command-resolver.mjs';
import { compareVersions, probeVersion } from './versions.mjs';

export const REPORT_COMMAND = 'agent-guild-report --hook';
export const PLUGIN_NAME = 'agent-guild';
const MANIFEST_DESCRIPTION = 'Reports to the Agent Guild session it runs in.';
const PROBE_TIMEOUT_MS = 20000;
const PROBE_RETRY_MS = 5 * 60 * 1000;

const handler = (extra = {}) => ({ type: 'command', command: REPORT_COMMAND, ...extra });
const groups = (events, extra) => Object.fromEntries(events.map((event) => [event, [{ ...extra?.[event]?.group, hooks: [handler(extra?.[event]?.handler)] }]]));

const shellEvents = (events, matcher) => Object.fromEntries(events.map((event) => [event, { group: { matcher } }]));

// Shell commands and monitors are the only tool calls reported. StopFailure (an API error) ends a turn like Stop, and
// PermissionDenied (auto mode) ends a command that PreToolUse started, since no PostToolUse follows a denial.
const CLAUDE_SHELL_TOOLS = 'Bash|PowerShell|Monitor';
const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'PostModelSwitch', 'PreToolUse', 'PermissionRequest', 'PermissionDenied', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure'];
const CLAUDE_MATCHERS = { PreToolUse: CLAUDE_SHELL_TOOLS, PermissionRequest: CLAUDE_SHELL_TOOLS, PermissionDenied: CLAUDE_SHELL_TOOLS, PostToolUse: `${CLAUDE_SHELL_TOOLS}|TaskStop`, PostToolUseFailure: CLAUDE_SHELL_TOOLS };
const CLAUDE_BLOCKING = new Set(['SubagentStart', 'PreToolUse']);
export const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd'];
const CODEX_MATCHERS = { PermissionRequest: 'Bash', PostToolUse: 'Bash' };

// Only the start of a sub-agent or a command holds Claude Code up, so the start reaches the manager before its end.
const claudeHooks = () => Object.fromEntries(CLAUDE_EVENTS.map((event) => [event, [{
  ...(CLAUDE_MATCHERS[event] ? { matcher: CLAUDE_MATCHERS[event] } : {}),
  hooks: [handler(CLAUDE_BLOCKING.has(event) ? {} : { async: true })],
}]]));
const GROK_EVENTS = ['SessionStart', 'SubagentStart', 'SubagentStop', 'StopCancelled', 'StopFailure', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'];

// Docker Agent takes one hook command per event on its command line. These flags cover the session's own
// shell commands and turns, and its sub-agents, each of which runs in a session of its own. The model needs a
// hooks.d drop-in, since before_llm_call has no flag.
export const DOCKER_HOOK_FLAGS = ['--hook-session-start', '--hook-pre-tool-use', '--hook-post-tool-use', '--hook-stop', '--hook-session-end'];
export const dockerHookArgs = () => DOCKER_HOOK_FLAGS.flatMap((flag) => [flag, REPORT_COMMAND]);
// From 1.80.0, `--session` with an id Docker Agent has not seen creates the session under that id. Agent Guild names
// the main session that way, so its hook can tell it from the sub-agents' sessions. hooks.d drop-ins load from 1.100.0.
export const DOCKER_SESSION_VERSION = '1.80.0';
export const DOCKER_DROPIN_VERSION = '1.100.0';
const DOCKER_DROPIN_MARKER = '# Written by Agent Guild';

/** The value of a `--session` the user passed to Docker Agent: undefined without one, null for a relative one (-1). */
export function dockerSessionArg(args) {
  for (let i = 0; i < args.length; i++) {
    const value = args[i] === '--session' ? args[i + 1] : args[i].startsWith('--session=') ? args[i].slice(10) : undefined;
    if (value !== undefined) return value && !/^-\d+$/.test(value) ? value : null;
  }
  return undefined;
}

/** Docker Agent's model drop-in, in the config folder `docker agent` reads (DOCKER_AGENT_CONFIG_DIR, else ~/.config/cagent). */
export function dockerDropinFile(env = {}, platform = process.platform) {
  const dir = env.DOCKER_AGENT_CONFIG_DIR || env.CAGENT_CONFIG_DIR
    || path.join((platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir(), '.config', 'cagent');
  return path.join(dir, 'hooks.d', `${PLUGIN_NAME}.yaml`);
}

// before_llm_call runs before every model call of every Docker Agent session, so the command checks for an Agent Guild
// session before starting Node. Docker Agent runs hooks in PowerShell on Windows and in $SHELL elsewhere, whatever
// shell that is, so the check there runs in sh.
export function dockerDropin(platform = process.platform) {
  const command = platform === 'win32'
    ? `if ($env:AGENT_GUILD_SESSION_ID) { ${REPORT_COMMAND} }`
    : `sh -c '[ -z "$AGENT_GUILD_SESSION_ID" ] || exec ${REPORT_COMMAND}'`;
  return [
    `${DOCKER_DROPIN_MARKER}: it shows the model of each Docker Agent session Agent Guild starts.`,
    '# Turn it off from the Docker Agent card. Outside Agent Guild it does nothing.',
    'before_llm_call:',
    '  - type: command',
    `    command: '${command.replaceAll("'", "''")}'`,
    '',
  ].join('\n');
}

/** "current" when the drop-in is this version's, "stale" when an older one of ours, "other" or null. */
export function dockerDropinState(file, platform = process.platform) {
  const text = readOr(file, null);
  if (text === null) return null;
  if (!text.startsWith(DOCKER_DROPIN_MARKER)) return 'other';
  return text === dockerDropin(platform) ? 'current' : 'stale';
}

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
      if (['claude', 'codex', 'grok', 'docker'].includes(provider.reporting)) this._probe(provider).catch(() => {});
    }
  }

  _probe(provider) {
    const resolved = this.registry.resolve(provider);
    if (!resolved) return Promise.resolve(null);
    let mtime = null;
    try { mtime = fs.statSync(resolved).mtimeMs; } catch { /* probe anyway */ }
    const cached = this.probes.get(provider.id);
    // A probe still running is shared. A finished one is reused while the binary is the same, for good when it found the
    // hooks and for the retry interval when it did not, unless it asked to be rechecked by the next session (Docker Agent).
    const fresh = cached && cached.resolved === resolved && cached.mtime === mtime
      && (!cached.done || (!cached.recheck && (cached.ok || Date.now() - cached.at < this.probeRetryMs)));
    if (fresh) return cached.promise;
    const env = { ...this.registry.env, ...provider.env };
    const platform = this.registry.platform;
    const entry = { resolved, mtime, at: Date.now(), ok: false, done: false, recheck: false, error: false, hookFlags: null, version: null };
    entry.promise = (async () => {
      if (provider.reporting === 'codex') {
        const result = await probeCodex(resolved, { env, platform, timeoutMs: this.probeTimeoutMs });
        entry.ok = result.args.length > 0;
        return result;
      }
      // Docker Agent's run flags are listed by `docker agent run --help`, after the provider's own args, and what
      // Agent Guild adds depends on its version.
      const docker = provider.reporting === 'docker';
      const helpArgs = docker ? [...provider.args, '--help'] : ['--help'];
      const [{ stdout, stderr }, version] = await Promise.all([
        runSpec(buildSpawnSpec(resolved, helpArgs, env, platform), { env, timeoutMs: this.probeTimeoutMs }),
        docker ? probeVersion(buildSpawnSpec(resolved, provider.versionArgs, env, platform), { env, timeoutMs: this.probeTimeoutMs }) : null,
      ]);
      const help = `${stdout}\n${stderr}`;
      const hookFlags = DOCKER_HOOK_FLAGS.every((flag) => helpLists(help, flag));
      entry.ok = !docker || hookFlags;
      // Docker Agent is a plugin of the docker command checked here, and installing, updating or removing the plugin
      // leaves docker's path and mtime as they were. So every Docker answer is asked again by the next session; its
      // help takes well under a second. When the plugin has come or gone, the card's version line is refreshed too,
      // as after an install (finishInstall), rather than at its hourly check, and a new version redraws the card's
      // model reporting row.
      if (docker) {
        entry.recheck = true;
        entry.hookFlags = hookFlags;
        entry.version = hookFlags ? version.version : null;
        if (cached?.done && !cached.error && cached.hookFlags !== hookFlags) this.registry.refreshVersions?.({ force: true, ids: [provider.id] }).catch(() => {});
        if (cached?.version !== entry.version) this.registry.emit?.('updated');
      }
      return { pluginDir: helpLists(help, '--plugin-dir'), hookFlags, version: entry.version };
    })().catch((err) => { entry.error = true; return { error: err.message }; }).finally(() => { entry.done = true; });
    this.probes.set(provider.id, entry);
    return entry.promise;
  }

  /**
   * What a new session of `provider` needs for reporting: `args` for its command line, `env` for its process,
   * `toolSessionId` when Agent Guild names the tool's session itself, and the card's first `reporting` state.
   * `resume` and `args` are the session's own.
   */
  async launch(provider, options = null) {
    const { resume = null, args = [] } = options ?? {};
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
    if (mode === 'docker') {
      if (probe?.hookFlags) {
        if (!probe.version || compareVersions(probe.version, DOCKER_SESSION_VERSION) < 0) {
          const which = probe.version ? `this is ${probe.version}` : 'its version could not be read';
          return { args: [], reporting: { state: 'unsupported', reason: `Agent Guild reports ${tool} ${DOCKER_SESSION_VERSION} or later; ${which}. Update ${tool} to see its agents and shell commands here.` } };
        }
        // The main session's id: the one resumed, the user's own --session, or a new one Agent Guild names. A relative
        // --session (-1) names none, and every session then reports as the main one.
        const own = dockerSessionArg(args);
        const toolSessionId = resume || (own === undefined ? crypto.randomUUID() : own);
        const named = resume || own !== undefined ? [] : ['--session', toolSessionId];
        // A drop-in an older Agent Guild wrote is brought up to date; it was turned on, and stays on.
        if (this._dropinState(provider) === 'stale') {
          try { this._writeDropin(provider); } catch (err) { console.warn(`[reporting] could not update ${this._dropinFile(provider)}: ${err.message}`); }
        }
        // Docker Agent fires session_start when the first prompt runs, not when its TUI opens.
        return {
          args: [...dockerHookArgs(), ...named],
          env: toolSessionId ? { AGENT_GUILD_TOOL_SESSION: toolSessionId } : null,
          toolSessionId,
          reporting: pending(tool, 'runs its first prompt'),
        };
      }
      if (probe?.error) {
        return { args: [], reporting: { state: 'unavailable', reason: `Could not check whether ${tool} takes Agent Guild's reporting hooks (${probe.error}).` } };
      }
      return {
        args: [],
        reporting: {
          state: 'unsupported',
          // Without the plugin, `docker agent run --help` prints the Docker CLI's own help and succeeds.
          reason: `${tool} is not installed, or this version takes no hook flags, so Agent Guild cannot add its reporting hooks. Hooks you add to ${tool}'s own settings still report.`,
        },
      };
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

  /** Whether the card's reporting switch is on, or null when the card shows no switch. */
  enabled(provider) {
    if (provider.reporting === 'docker') {
      if (!this._dockerDropins(provider)) return null;
      const state = this._dropinState(provider);
      return state === 'other' ? null : Boolean(state);
    }
    if (provider.reporting !== 'antigravity' || !this.bundles) return null;
    return this._installed(provider) === 'current' && this._pluginEnabled(provider);
  }

  /** Why the card's reporting switch cannot be used, or null. */
  note(provider) {
    if (provider.reporting !== 'docker') return null;
    const version = this.probes.get(provider.id)?.version;
    if (!version || compareVersions(version, DOCKER_SESSION_VERSION) < 0) return null;
    if (!this._dockerDropins(provider)) return `Model reporting needs ${provider.tool} ${DOCKER_DROPIN_VERSION} or later.`;
    if (this._dropinState(provider) === 'other') {
      return `Model reporting is off: ${this._dropinFile(provider)} was not written by Agent Guild. Remove it to turn model reporting on here.`;
    }
    return null;
  }

  /** Docker Agent's model drop-in needs hooks.d, which the version the last probe found must load. */
  _dockerDropins(provider) {
    const version = this.probes.get(provider.id)?.version;
    return Boolean(version && compareVersions(version, DOCKER_DROPIN_VERSION) >= 0);
  }

  _dropinFile(provider) {
    return dockerDropinFile({ ...this.registry.env, ...provider.env }, this.registry.platform);
  }

  _dropinState(provider) {
    return dockerDropinState(this._dropinFile(provider), this.registry.platform);
  }

  _writeDropin(provider) {
    const file = this._dropinFile(provider);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Docker Agent reads the folder at every start, so the file appears whole or not at all.
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, dockerDropin(this.registry.platform));
    fs.renameSync(temp, file);
  }

  _setDockerModel(provider, enabled) {
    if (!this._dockerDropins(provider)) {
      throw Object.assign(new Error(`Model reporting needs ${provider.tool} ${DOCKER_DROPIN_VERSION} or later`), { status: 409, code: 'provider_unsupported' });
    }
    const state = this._dropinState(provider);
    if (state === 'other') {
      if (!enabled) return false;
      throw Object.assign(new Error(`${this._dropinFile(provider)} was not written by Agent Guild. Remove it to turn on model reporting.`), { status: 409, code: 'plugin_conflict' });
    }
    try {
      if (enabled && state !== 'current') this._writeDropin(provider);
      if (!enabled && state) fs.rmSync(this._dropinFile(provider), { force: true });
    } catch (err) {
      throw Object.assign(new Error(`Agent Guild could not ${enabled ? 'write' : 'remove'} ${this._dropinFile(provider)}: ${err.message}`), { status: 500, code: 'reporting_setup_failed' });
    }
    return this.enabled(provider);
  }

  _installed(provider) {
    return antigravityInstalled(antigravityPluginDir({ ...this.registry.env, ...provider.env }, this.registry.platform), this.bundles.antigravity);
  }

  _pluginEnabled(provider) {
    return antigravityPluginEnabled(antigravityConfigFile({ ...this.registry.env, ...provider.env }, this.registry.platform));
  }

  async setEnabled(provider, enabled) {
    if (provider.reporting === 'docker') return this._setDockerModel(provider, enabled);
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
