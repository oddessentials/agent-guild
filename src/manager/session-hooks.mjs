// Agent reporting hooks that the manager supplies to each coding tool, so
// sub-agents show on the card without the user editing the tool's settings.
//
// - Claude Code loads a plugin for one process with --plugin-dir.
// - Codex CLI takes hooks as -c config overrides for one process. Codex runs
//   a hook only once it is trusted; trust for exactly these handlers is
//   passed the same way, built from the keys and hashes Codex itself reports
//   for them, so nothing is written to ~/.codex. Both are probed against the
//   installed binary first: an override Codex does not understand would stop
//   it from starting.
// - Gemini CLI has no per-process mechanism. The user links an extension
//   holding the hooks, through Gemini's own `extensions link`, once.
// - Grok Build's interactive mode accepts no --plugin-dir in the versions
//   released so far; it is used when `grok --help` lists it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildSpawnSpec, runSpec } from './command-resolver.mjs';

export const REPORT_COMMAND = 'agent-guild-report --hook';
export const EXTENSION_NAME = 'agent-guild';
const PROBE_TIMEOUT_MS = 20000;
const PROBE_RETRY_MS = 5 * 60 * 1000;

const handler = (extra = {}) => ({ type: 'command', command: REPORT_COMMAND, ...extra });
const groups = (events, extra) => Object.fromEntries(events.map((event) => [event, [{ hooks: [handler(extra?.[event])] }]]));

const CLAUDE_EVENTS = ['SessionStart', 'SubagentStart', 'SubagentStop', 'PostModelSwitch'];
export const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop'];
const GROK_EVENTS = ['SessionStart', 'SubagentStart', 'SubagentStop', 'StopCancelled', 'SessionEnd'];

/**
 * The command Gemini's hooks run. Its extension stays linked for sessions
 * started outside Agent Guild, where the launcher folder is not on PATH, so
 * the launcher is named by its full path, quoted for the shell Gemini uses:
 * PowerShell on Windows, bash elsewhere. Outside a session it does nothing.
 */
export function geminiCommand(shimDir, platform = process.platform) {
  if (!shimDir) return REPORT_COMMAND;
  if (platform === 'win32') return `& '${path.win32.join(shimDir, 'agent-guild-report.cmd').replace(/'/g, "''")}' --hook`;
  return `'${path.posix.join(shimDir, 'agent-guild-report').replace(/'/g, `'\\''`)}' --hook`;
}

/** The files of each bundle, by path relative to the bundle's folder. */
export function bundleFiles(version, { shimDir = null, platform = process.platform } = {}) {
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const manifest = { name: EXTENSION_NAME, version, description: 'Reports sub-agents to the Agent Guild session they run in.' };
  const gemini = (name, matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [handler({ name: `Agent Guild ${name}`, command: geminiCommand(shimDir, platform) })] });
  return {
    claude: {
      '.claude-plugin/plugin.json': json(manifest),
      'hooks/hooks.json': json({ hooks: groups(CLAUDE_EVENTS) }),
    },
    gemini: {
      'gemini-extension.json': json(manifest),
      'hooks/hooks.json': json({
        hooks: {
          SessionStart: [gemini('session start')],
          BeforeTool: [gemini('agent start', 'invoke_agent')],
          AfterTool: [gemini('agent stop', 'invoke_agent')],
          BeforeAgent: [gemini('turn start')],
          AfterAgent: [gemini('turn end')],
          BeforeModel: [gemini('model')],
        },
      }),
    },
    grok: {
      '.grok-plugin/plugin.json': json(manifest),
      'hooks/hooks.json': json({ hooks: groups(GROK_EVENTS, { SessionEnd: { timeout: 10 } }) }),
    },
  };
}

/** Write every bundle under `dir`, replacing each file atomically. Returns their folders. */
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

/** TOML literal strings: no double quotes, which cmd.exe and argv parsing would have to escape. */
const tomlString = (value) => `'${value}'`;

export function codexHookArgs() {
  const value = `[{hooks=[{type=${tomlString('command')},command=${tomlString(REPORT_COMMAND)}}]}]`;
  return CODEX_EVENTS.flatMap((event) => ['-c', `hooks.${event}=${value}`]);
}

/** Trust for exactly the given hooks: [{ key, hash }] as Codex lists them. */
export function codexTrustArgs(hooks) {
  if (hooks.some(({ key, hash }) => /['\n]/.test(key) || /['\n]/.test(hash))) return null;
  return ['-c', `hooks.state={${hooks.map(({ key, hash }) => `${tomlString(key)}={trusted_hash=${tomlString(hash)}}`).join(',')}}`];
}

/** Our handlers in a Codex `hooks/list` result, one per event, or null when any is missing. */
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

/**
 * Ask a Codex binary which hooks it loads with `args`, through its app-server
 * and a private, empty CODEX_HOME, so the user's own ~/.codex is not read or
 * written. Resolves to the `hooks/list` result; rejects when Codex refuses
 * the arguments or does not answer in time.
 */
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
      try { child?.kill(); } catch { /* gone */ }
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

/** The arguments that load and trust our hooks in this Codex, or { args: [] } when it takes neither. */
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

/** True when `--help` output lists `flag` as an option of the command itself. */
export function helpLists(text, flag) {
  return new RegExp(`^\\s+(?:-\\w, )?${flag.replace(/[-]/g, '\\-')}\\b`, 'm').test(text);
}

/** Gemini's folder for this account: GEMINI_CLI_HOME, else the user's home. */
export function geminiHome(env = {}) {
  return env.GEMINI_CLI_HOME || os.homedir();
}

/** Whether Gemini has our extension linked to `bundle`, read from Gemini's own install record. */
export function geminiLinked(home, bundle) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'extensions', EXTENSION_NAME, '.gemini-extension-install.json'), 'utf8'));
    return record?.type === 'link' && typeof record.source === 'string' && path.resolve(record.source) === path.resolve(bundle);
  } catch {
    return false;
  }
}

/**
 * What each provider's sessions get for agent reporting, by the provider's
 * `reporting` key ("claude", "codex", "gemini" or "grok"). Capabilities are
 * probed once per binary and cached by its path and modification time.
 */
export class SessionHooks {
  /**
   * @param {object} opts
   * @param {import('./providers.mjs').ProviderRegistry} opts.registry
   * @param {string|null} opts.dir     where the plugin and extension folders are written
   * @param {string} opts.version
   * @param {string|null} [opts.shimDir]  the agent-guild-report launchers
   * @param {number} [opts.probeTimeoutMs]
   */
  constructor({ registry, dir, version, shimDir = null, probeTimeoutMs = PROBE_TIMEOUT_MS }) {
    this.registry = registry;
    this.probeTimeoutMs = probeTimeoutMs;
    this.bundles = null;
    this.probes = new Map();
    if (dir) {
      try {
        this.bundles = writeBundles(dir, version, { shimDir, platform: registry.platform });
      } catch (err) {
        console.warn(`[reporting] could not write the reporting hooks to ${dir}: ${err.message}`);
      }
    }
  }

  /** Start the probes for every installed provider, so the first session does not wait for them. */
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
    const fresh = cached && cached.resolved === resolved && cached.mtime === mtime && (cached.ok || Date.now() - cached.at < PROBE_RETRY_MS);
    if (fresh) return cached.promise;
    const env = { ...this.registry.env, ...provider.env };
    const platform = this.registry.platform;
    const entry = { resolved, mtime, at: Date.now(), ok: false };
    entry.promise = (async () => {
      if (provider.reporting === 'codex') {
        const result = await probeCodex(resolved, { env, platform, timeoutMs: this.probeTimeoutMs });
        entry.ok = true;
        return result;
      }
      const { stdout, stderr } = await runSpec(buildSpawnSpec(resolved, ['--help'], env, platform), { env, timeoutMs: this.probeTimeoutMs });
      entry.ok = true;
      return { pluginDir: helpLists(`${stdout}\n${stderr}`, '--plugin-dir') };
    })().catch((err) => ({ error: err.message }));
    this.probes.set(provider.id, entry);
    return entry.promise;
  }

  /**
   * Arguments to put before the provider's own, and the session's starting
   * reporting state: { args, reporting: { state, reason } | null }.
   */
  async launch(provider, account) {
    const mode = provider.reporting;
    if (!mode) return { args: [], reporting: null };
    const tool = provider.tool;
    if (!this.bundles) {
      return { args: [], reporting: { state: 'unavailable', reason: `Agent Guild could not write its reporting hooks, so ${tool} cannot report agents.` } };
    }
    if (mode === 'gemini') {
      if (this.enabled(provider, account)) return { args: [], reporting: { state: 'pending', reason: null } };
      return { args: [], reporting: { state: 'setup_required', reason: `Agent reporting is off for ${tool}. Turn it on from the ${tool} card; it applies to new sessions.` } };
    }
    const probe = await this._probe(provider);
    if (mode === 'codex') {
      if (probe?.args?.length) return { args: probe.args, reporting: { state: 'pending', reason: null } };
      return { args: [], reporting: { state: 'unavailable', reason: `${tool} did not accept Agent Guild's reporting hooks${probe?.error ? ` (${probe.error})` : ''}.` } };
    }
    const dir = mode === 'claude' ? this.bundles.claude : this.bundles.grok;
    if (probe?.pluginDir) return { args: ['--plugin-dir', dir], reporting: { state: 'pending', reason: null } };
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

  /** Per-account opt-in state for providers that need one: true, false, or null when not applicable. */
  enabled(provider, account) {
    if (provider.reporting !== 'gemini' || !this.bundles) return null;
    return geminiLinked(geminiHome({ ...this.registry.env, ...provider.env, ...account?.env }), this.bundles.gemini);
  }

  /** Link or unlink the Gemini extension for one account, through Gemini's own commands. */
  async setEnabled(provider, account, enabled) {
    if (provider.reporting !== 'gemini') throw Object.assign(new Error(`${provider.tool} needs no setup for agent reporting`), { status: 400, code: 'not_applicable' });
    if (!this.bundles) throw Object.assign(new Error('Agent Guild could not write its reporting hooks'), { status: 500, code: 'reporting_unavailable' });
    const resolved = this.registry.resolve(provider);
    if (!resolved) throw Object.assign(new Error(`${provider.tool} is not installed`), { status: 409, code: 'provider_unavailable' });
    const env = { ...this.registry.env, ...provider.env, ...account?.env };
    const args = enabled ? ['extensions', 'link', this.bundles.gemini, '--consent'] : ['extensions', 'uninstall', EXTENSION_NAME];
    if (enabled === this.enabled(provider, account)) return enabled;
    try {
      await runSpec(buildSpawnSpec(resolved, args, env, this.registry.platform), { env, timeoutMs: 60000 });
    } catch (err) {
      const detail = `${err.stderr || ''}\n${err.stdout || ''}`.trim().split('\n').filter(Boolean).pop() || err.message;
      throw Object.assign(new Error(`${provider.tool} could not ${enabled ? 'link' : 'remove'} the Agent Guild extension: ${detail}`), { status: 502, code: 'reporting_setup_failed' });
    }
    const now = this.enabled(provider, account);
    if (now !== enabled) {
      throw Object.assign(new Error(`${provider.tool} reported success, but the Agent Guild extension is ${now ? 'still linked' : 'not linked'}`), { status: 502, code: 'reporting_setup_failed' });
    }
    return now;
  }
}
