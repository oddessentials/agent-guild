import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSpawnSpec, resolveCommand, runSpec } from './command-resolver.mjs';
import { antigravityConfigFile } from './session-hooks.mjs';
import { parse as parseToml } from 'smol-toml';
import { stableExecPath } from './autostart.mjs';
import { PACKAGE_SCRIPT } from './launch.mjs';
import { dataDir, dataDirFor } from './config.mjs';

export const SERVER_NAME = 'agent-guild';
export const MCP_MODES = ['claude', 'codex', 'antigravity', 'grok'];
export const MCP_ACTIONS = ['on', 'off', 'replace'];
const STATE_TTL_MS = 60 * 1000;
const RUN_TIMEOUT_MS = 30000;
const PACKAGE = /^@oddessentials\/agent-guild(?:@[^\s/]+)?$/;
const HOME_FLAG = '--home=';

export function ownServer(execPath = process.execPath, home = dataDir()) {
  return { command: stableExecPath(execPath), args: [PACKAGE_SCRIPT, 'mcp', `${HOME_FLAG}${path.resolve(home)}`] };
}

const homeOf = (env, platform) => (platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

export const fingerprint = (value) => crypto.createHash('sha256').update(canonical(value)).digest('hex').slice(0, 32);

const isStringList = (list) => Array.isArray(list) && list.every((a) => typeof a === 'string');
const stringMap = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const quote = (arg) => (/[\s"]/.test(arg) || arg === '' ? JSON.stringify(arg) : arg);
const commandLine = (command, args) => [command, ...args].map(quote).join(' ');

function readJsonFile(file, { emptyIsNone = false } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: true };
    return { error: `${file} cannot be read: ${err.message}` };
  }
  if (emptyIsNone && !text.trim()) return { missing: true };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: `${file} is not valid JSON` };
  }
}

function statOf(file) {
  try {
    const s = fs.statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
}

/** The agent-guild entry of a JSON file's mcpServers, as each tool's own reader sees it. */
function entryInFile(file, options) {
  const read = readJsonFile(file, options);
  if (read.missing) return { entry: null };
  if (read.error) return { error: read.error };
  const servers = read.value?.mcpServers;
  if (servers === undefined) return { entry: null };
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return { error: `${file} has mcpServers in a form Agent Guild does not recognize` };
  return { entry: Object.hasOwn(servers, SERVER_NAME) ? servers[SERVER_NAME] : null };
}

function fromJson(raw, enabled) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { raw, invalid: true };
  const url = raw.url ?? raw.httpUrl ?? raw.serverUrl;
  const remote = (raw.type !== undefined && raw.type !== 'stdio') || (raw.command === undefined && url !== undefined);
  return { raw, remote: remote ? String(url ?? raw.type) : null, command: raw.command, args: raw.args ?? [], env: raw.env ?? {}, envVars: [], cwd: raw.cwd ?? null, enabled };
}

function lastLine(err) {
  return `${err.stderr || ''}\n${err.stdout || ''}`.trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() || err.message;
}

// Grok Build exits 0 and lists what it could read when its config.toml does not parse; only stderr says so.
const grokConfigError = (stderr) => String(stderr || '').split('\n').map((l) => l.trim()).find((l) => /\bERROR\b.*\bconfig\b/.test(l)) ?? null;

const TOOLS = {
  claude: {
    // Claude Code starts MCP servers from Node, which keeps the first of Windows variables that differ only in case.
    firstKeyWins: true,
    file: (env, platform) => path.join(env.CLAUDE_CONFIG_DIR || homeOf(env, platform), '.claude.json'),
    async read(ctx) {
      const found = entryInFile(this.file(ctx.env, ctx.platform));
      return found.error ? found : { entry: found.entry === null ? null : fromJson(found.entry, true) };
    },
    add: (own) => [['mcp', 'add', '-s', 'user', SERVER_NAME, '--', own.command, ...own.args]],
    remove: () => [['mcp', 'remove', '-s', 'user', SERVER_NAME]],
    replace: (own) => [['mcp', 'remove', '-s', 'user', SERVER_NAME], ['mcp', 'add', '-s', 'user', SERVER_NAME, '--', own.command, ...own.args]],
  },
  codex: {
    async read(ctx) {
      const { stdout } = await ctx.run(['mcp', 'list', '--json']);
      const list = parseList(stdout);
      if (!list) return { error: 'its MCP server list was not in a form Agent Guild recognizes' };
      const item = list.find((e) => e?.name === SERVER_NAME);
      if (!item) return { entry: null };
      const t = item.transport ?? {};
      return {
        entry: {
          raw: item,
          remote: t.type && t.type !== 'stdio' ? String(t.url ?? t.type) : null,
          command: t.command,
          args: t.args ?? [],
          env: t.env ?? {},
          envVars: Array.isArray(t.env_vars) ? t.env_vars.map((v) => (typeof v === 'string' ? v : v?.name)).filter(Boolean) : [],
          cwd: t.cwd ?? null,
          enabled: item.enabled !== false,
        },
      };
    },
    // Codex hands an MCP server only some of its environment; these two are not among them.
    drops: ['AGENT_GUILD_HOME', 'XDG_CONFIG_HOME'],
    add: (own) => [['mcp', 'add', SERVER_NAME, '--', own.command, ...own.args]],
    // Codex has no enable: adding again replaces the entry, and with it `enabled = false`.
    enable: (own) => [['mcp', 'add', SERVER_NAME, '--', own.command, ...own.args]],
    remove: () => [['mcp', 'remove', SERVER_NAME]],
    replace: (own) => [['mcp', 'add', SERVER_NAME, '--', own.command, ...own.args]],
  },
  antigravity: {
    file: (env, platform) => path.join(path.dirname(antigravityConfigFile(env, platform)), 'mcp_config.json'),
    async read(ctx) {
      const found = entryInFile(this.file(ctx.env, ctx.platform), { emptyIsNone: true });
      if (found.error || found.entry === null) return found;
      return { entry: fromJson(found.entry, found.entry?.disabled !== true) };
    },
    add: (own) => [['mcp', 'add', SERVER_NAME, '--', own.command, ...own.args]],
    enable: () => [['mcp', 'enable', SERVER_NAME]],
    remove: () => [['mcp', 'remove', SERVER_NAME]],
    replace: (own) => [['mcp', 'add', SERVER_NAME, '--', own.command, ...own.args]],
  },
  grok: {
    async read(ctx) {
      const listed = await ctx.run(['mcp', 'list', '--json']);
      const broken = grokConfigError(listed.stderr);
      if (broken) return { error: broken };
      const list = parseList(listed.stdout);
      if (!list) return { error: 'its MCP server list was not in a form Agent Guild recognizes' };
      const item = list.find((e) => e?.name === SERVER_NAME && (e.scope === undefined || e.scope === 'user'));
      if (item) return { entry: { ...fromJson(item, item.enabled !== false), raw: item } };
      // Grok Build also loads the servers in Claude Code's and Cursor's settings, which its list leaves out. `inspect`
      // names them without starting them; `mcp doctor` would start them.
      const inspected = await ctx.run(['inspect', '--json']).catch((err) => err);
      if (grokConfigError(inspected.stderr)) return { error: grokConfigError(inspected.stderr) };
      if (inspected instanceof Error) return { error: `grok inspect failed: ${lastLine(inspected)}` };
      let report;
      try { report = JSON.parse(inspected.stdout); } catch { report = null; }
      if (!Array.isArray(report?.mcpServers)) return { error: 'grok inspect gave an answer Agent Guild does not recognize' };
      const server = report.mcpServers.find((s) => s?.name === SERVER_NAME);
      if (!server) return { entry: null };
      const from = { claude: 'Claude Code', cursor: 'Cursor' }[server.vendor];
      const file = server.source?.path;
      if (!from || typeof file !== 'string') return { error: `Grok Build takes agent-guild from ${typeof file === 'string' ? `${file}, which` : 'a source'} Agent Guild cannot read` };
      // Listed, but not loaded: Grok Build's compatibility settings keep that tool's servers out.
      if (server.disabled === true || server.compatibilityStatus === 'disabled') {
        const why = server.compatibilityStatus === 'disabled' ? `, because its ${from} compatibility is off` : '';
        return { entry: null, raw: { source: file, loaded: false }, note: `Grok Build does not load the agent-guild server in ${from}'s settings${why}.` };
      }
      const found = entryInFile(path.resolve(file));
      if (found.error) return found;
      if (found.entry === null) return { error: `Grok Build reports agent-guild in ${file}, but it is not there` };
      const off = grokOffList(ctx.env, ctx.platform);
      if (off.error) return off;
      const enabled = !off.names.includes(SERVER_NAME);
      return { entry: { ...fromJson(found.entry, enabled), from, raw: { source: file, entry: found.entry, enabled } } };
    },
    add: (own) => [['mcp', 'add', '-s', 'user', SERVER_NAME, '--', own.command, ...own.args]],
    enable: () => [['mcp', 'enable', SERVER_NAME]],
    disable: () => [['mcp', 'disable', SERVER_NAME]],
    remove: () => [['mcp', 'remove', '-s', 'user', SERVER_NAME]],
    // A name on Grok Build's own off list stays off whatever entry holds it.
    replace: (own) => [['mcp', 'add', '-s', 'user', SERVER_NAME, '--', own.command, ...own.args], ['mcp', 'enable', SERVER_NAME]],
  },
};

/** The names `grok mcp disable` turned off: `disabled_mcp_servers` at the top of Grok Build's config.toml. */
function grokOffList(env, platform) {
  const file = path.join(env.GROK_HOME || path.join(homeOf(env, platform), '.grok'), 'config.toml');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return err.code === 'ENOENT' ? { names: [] } : { error: `${file} cannot be read: ${err.message}` };
  }
  let config;
  try {
    config = parseToml(text);
  } catch {
    return { error: `${file} is not valid TOML` };
  }
  const names = config.disabled_mcp_servers ?? [];
  if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) return { error: `${file} has disabled_mcp_servers in a form Agent Guild does not recognize` };
  return { names };
}

function parseList(stdout) {
  try {
    const list = JSON.parse(stdout);
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

const samePath = (a, b, platform) => {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const norm = (x) => p.resolve(x).replace(/[\\/]+$/, '');
  return platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

/** How a recognized entry starts Agent Guild's MCP server: the program to find, and the flags after `mcp`. */
function launchOf(command, args, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const base = p.basename(command).toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, '');
  let rest;
  let script = null;
  if (base === 'agent-guild') rest = args;
  else if (base === 'npx') {
    let i = 0;
    while (args[i] === '-y' || args[i] === '--yes') i++;
    if (!PACKAGE.test(args[i] ?? '')) return null;
    rest = args.slice(i + 1);
  } else if (/^node(\d+)?$/.test(base)) {
    script = args[0];
    if (!script || p.basename(script) !== 'agent-guild.mjs' || p.basename(p.dirname(script)) !== 'bin') return null;
    rest = args.slice(1);
  } else return null;
  if (rest[0] !== 'mcp') return null;
  const flags = rest.slice(1);
  if (!flags.every((f) => f === '--allow-input' || f.startsWith(HOME_FLAG))) return null;
  // As bin/agent-guild.mjs reads it: the first --home=, and none when that one is empty.
  const home = flags.find((f) => f.startsWith(HOME_FLAG))?.slice(HOME_FLAG.length) || null;
  return { script, home, allowInput: flags.includes('--allow-input') };
}

/**
 * The environment a tool gives an MCP server, `{ KEY: { value, fromEntry } }`, with Windows keys in upper case.
 * On Windows, Codex CLI, Grok Build and Antigravity CLI let the entry's variable win in any case; Claude Code, on
 * Node, keeps the lexicographically first of keys that differ only in case (`firstKeyWins`).
 */
export function serverEnv(toolEnv, entryEnv, { platform, firstKeyWins = false, drops = [], envVars = [] }) {
  const fold = (k) => (platform === 'win32' ? k.toUpperCase() : k);
  const merged = new Map();
  for (const [k, v] of Object.entries(toolEnv)) {
    if (!drops.includes(fold(k)) || envVars.some((name) => fold(name) === fold(k))) merged.set(k, { value: v, fromEntry: false });
  }
  for (const [k, v] of Object.entries(entryEnv)) merged.set(k, { value: String(v), fromEntry: true });
  const keys = [...merged.keys()];
  if (firstKeyWins) keys.sort();
  const out = {};
  for (const k of keys) if (!firstKeyWins || !Object.hasOwn(out, fold(k))) out[fold(k)] = merged.get(k);
  return out;
}

/**
 * What an entry is to this manager. `env` is the environment the tool runs with; `drops` the variables the
 * tool keeps from its MCP servers unless the entry passes them on.
 */
export function classify(entry, { own, home, env, platform, drops = [], firstKeyWins = false, tool }) {
  if (!entry) return { state: 'off' };
  const command = typeof entry.command === 'string' ? entry.command : null;
  const shown = command && isStringList(entry.args) ? commandLine(command, entry.args) : null;
  const conflict = (detail) => ({ state: 'conflict', detail, command: shown });
  if (entry.invalid) return conflict('Agent Guild does not recognize');
  if (entry.remote) return conflict(`connects to ${entry.remote}`);
  if (!shown) return conflict('Agent Guild does not recognize');
  const launch = launchOf(command, entry.args, platform);
  if (!launch) return conflict('runs something other than Agent Guild\'s MCP server');
  const entryEnv = stringMap(entry.env);
  const p = platform === 'win32' ? path.win32 : path.posix;
  const vars = serverEnv(env, entryEnv, { platform, firstKeyWins, drops, envVars: entry.envVars ?? [] });
  const values = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v.value]));
  const relevant = [command, ...entry.args, ...['AGENT_GUILD_HOME', 'APPDATA', 'XDG_CONFIG_HOME', 'HOME', 'USERPROFILE', 'PATH'].map((k) => (vars[k]?.fromEntry ? vars[k].value : ''))];
  if (relevant.some((v) => String(v).includes('${'))) return conflict('uses variables Agent Guild cannot resolve');
  const program = resolveCommand(command, values, platform);
  if (!program) return conflict(`runs ${command}, which is not installed`);
  if (launch.script && !fs.existsSync(p.isAbsolute(launch.script) ? launch.script : p.resolve(entry.cwd || os.homedir(), launch.script))) {
    return conflict(`runs ${launch.script}, which does not exist`);
  }
  let target;
  if (launch.home !== null) {
    if (!p.isAbsolute(launch.home)) return conflict('names a relative data folder');
    target = launch.home;
  } else if (vars.AGENT_GUILD_HOME?.value && vars.AGENT_GUILD_HOME.fromEntry) {
    if (!p.isAbsolute(vars.AGENT_GUILD_HOME.value)) return conflict('names a relative data folder');
    target = vars.AGENT_GUILD_HOME.value;
  } else if (vars.AGENT_GUILD_HOME?.value) {
    return conflict(`names no data folder, so AGENT_GUILD_HOME decides which Agent Guild it reaches wherever ${tool} starts`);
  } else {
    target = dataDirFor(values, platform);
  }
  if (!samePath(target, home, platform)) return conflict(`reaches the Agent Guild data folder ${target}, not this one, ${home}`);
  const managed = !entry.from && command === own.command && entry.args.length === own.args.length && entry.args.every((a, i) => a === own.args[i])
    && Object.keys(entryEnv).length === 0 && !entry.envVars?.length && !entry.cwd;
  return { state: entry.enabled === false ? 'disabled' : 'on', managed, command: shown, allowInput: launch.allowInput };
}

function refusal(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export class McpConnect {
  constructor({ registry, own, home = dataDir(), prepareAccount, dir = os.homedir(), ttlMs = STATE_TTL_MS }) {
    this.registry = registry;
    this.prepareAccount = prepareAccount;
    this.own = own;
    this.home = home;
    this.dir = dir;
    this.ttlMs = ttlMs;
    this.cache = new Map();
    this.reading = new Map();
    this.reads = 0;
    this.busy = new Set();
  }

  _tool(provider) {
    return MCP_MODES.includes(provider.mcp) ? TOOLS[provider.mcp] : null;
  }

  _accounts(provider) {
    return this.registry.accountsFor(provider).map((account) => ({
      id: account.id, label: account.label, dir: account.dir, account, env: { ...this.registry.env, ...provider.env, ...account.env },
    }));
  }

  _signature(provider) {
    return JSON.stringify(this._accounts(provider).map((a) => [a.id, a.label, a.dir, provider.homeVar ? a.env[provider.homeVar] ?? null : null]));
  }

  // A settings file read directly is read again as soon as it changes.
  _files(provider) {
    const tool = this._tool(provider);
    if (!tool.file) return null;
    return JSON.stringify(this._accounts(provider).map((a) => statOf(tool.file(a.env, this.registry.platform))));
  }

  async _run(provider, resolved, env, args) {
    return runSpec(buildSpawnSpec(resolved, args, env, this.registry.platform), { env, cwd: this.dir, timeoutMs: RUN_TIMEOUT_MS, killTree: true });
  }

  async readAccount(provider, resolved, account) {
    const tool = this._tool(provider);
    // A managed home that does not exist yet holds no settings, and some tools create it when asked.
    if (account.dir && !fs.existsSync(account.dir)) return { state: 'off', fingerprint: fingerprint(null) };
    const platform = this.registry.platform;
    const ctx = { env: account.env, platform, run: (args) => this._run(provider, resolved, account.env, args) };
    let read;
    try {
      read = await tool.read(ctx);
    } catch (err) {
      return { state: 'error', detail: `${provider.command} mcp list failed: ${lastLine(err)}`, fingerprint: null };
    }
    if (read.error) return { state: 'error', detail: read.error, fingerprint: null };
    const result = classify(read.entry, { own: this.own, home: this.home, env: account.env, platform, drops: tool.drops, firstKeyWins: tool.firstKeyWins, tool: provider.tool });
    return { ...result, ...(read.note && { detail: read.note }), from: read.entry?.from ?? null, fingerprint: fingerprint(read.entry?.raw ?? read.raw ?? null) };
  }

  async _readAll(provider, resolved) {
    return Promise.all(this._accounts(provider).map(async (account) => ({ id: account.id, label: account.label, ...await this.readAccount(provider, resolved, account) })));
  }

  refresh(provider, { force = false } = {}) {
    const resolved = this.registry.resolve(provider);
    if (!this._tool(provider) || !resolved) return Promise.resolve(null);
    const sig = this._signature(provider);
    const files = this._files(provider);
    const cached = this.cache.get(provider.id);
    if (!force && cached && cached.resolved === resolved && cached.sig === sig && cached.files === files && Date.now() - cached.at < this.ttlMs) return Promise.resolve(cached.accounts);
    // A forced read follows a change, so a read that started before it must not be the one kept.
    const pending = this.reading.get(provider.id);
    if (!force && pending?.sig === sig && pending.files === files) return pending.job;
    const seq = ++this.reads;
    const job = this._readAll(provider, resolved).then((accounts) => {
      if (this.reading.get(provider.id)?.seq !== seq) return accounts;
      this.reading.delete(provider.id);
      // Accounts that changed during the read make its result obsolete.
      const current = this.registry.get(provider.id);
      if (!current || this._signature(current) !== sig) return accounts;
      const before = this.cache.get(provider.id);
      this.cache.set(provider.id, { resolved, sig, files, accounts, at: Date.now() });
      // A page showing "checking" for a new account set needs this read even when every state is the same.
      if (before?.sig !== sig || JSON.stringify(accounts) !== JSON.stringify(before.accounts)) this.registry.emit?.('updated');
      return accounts;
    }, (err) => {
      if (this.reading.get(provider.id)?.seq === seq) this.reading.delete(provider.id);
      throw err;
    });
    this.reading.set(provider.id, { seq, sig, files, job });
    return job;
  }

  describe(provider) {
    if (!this._tool(provider) || !this.registry.resolve(provider)) return null;
    this.refresh(provider).catch(() => {});
    const cached = this.cache.get(provider.id);
    if (!cached || cached.sig !== this._signature(provider)) {
      return { mode: provider.mcp, accounts: this._accounts(provider).map(({ id, label }) => ({ id, label, state: 'checking', managed: false, from: null, command: null, allowInput: false, detail: null, fingerprint: null })) };
    }
    return {
      mode: provider.mcp,
      accounts: cached.accounts.map(({ id, label, state, managed, from, command, allowInput, detail, fingerprint: print }) => ({
        id, label, state, managed: Boolean(managed), from: from ?? null, command: command ?? null, allowInput: Boolean(allowInput), detail: detail ?? null, fingerprint: print ?? null,
      })),
    };
  }

  /** Changes one account, only if its entry is still the one the caller saw (`expect`, its fingerprint). */
  async change(provider, accountId, action, expect) {
    const tool = this._tool(provider);
    if (!tool) throw refusal(400, 'not_applicable', `${provider.tool} has no MCP settings Agent Guild can change`);
    const resolved = this.registry.resolve(provider);
    if (!resolved) throw refusal(409, 'provider_unavailable', `${provider.tool} is not installed`);
    const account = this._accounts(provider).find((a) => a.id === accountId);
    if (!account) throw refusal(404, 'unknown_account', `${provider.tool} has no account "${accountId}"`);
    if (this.busy.has(provider.id)) throw refusal(409, 'busy', `${provider.tool}'s MCP settings are already being changed`);
    this.busy.add(provider.id);
    try {
      return await this._change(provider, resolved, tool, account, action, expect);
    } finally {
      this.busy.delete(provider.id);
      await this.refresh(provider, { force: true }).catch(() => {});
    }
  }

  async _change(provider, resolved, tool, account, action, expect) {
    // The cache is for display only: every change acts on a fresh read of the account.
    const now = await this.readAccount(provider, resolved, account);
    if (now.state === 'error') throw refusal(409, 'unreadable', `Agent Guild cannot read ${provider.tool}'s MCP settings: ${now.detail}`);
    if (now.fingerprint !== expect) throw refusal(409, 'changed', `${provider.tool}'s MCP settings changed since the card showed them. Nothing was changed.`);
    let steps;
    let want;
    if (action === 'on') {
      want = 'on';
      if (now.state === 'on') return { outcome: 'unchanged', state: now.state };
      if (now.state === 'conflict') throw refusal(409, 'conflict', `${provider.tool} has another server named agent-guild. Replace it instead.`);
      if (now.state === 'off') steps = tool.add(this.own);
      else if (now.from) steps = tool.enable();
      else if (provider.mcp === 'codex' && !now.managed) throw refusal(409, 'needs_replace', 'Codex CLI can turn this server on only by replacing it.');
      else steps = tool.enable(this.own);
    } else if (action === 'off') {
      if (now.state === 'off' || now.state === 'disabled') return { outcome: 'unchanged', state: now.state };
      if (now.state === 'conflict') throw refusal(409, 'conflict', `${provider.tool}'s server named agent-guild is not Agent Guild's, so Agent Guild leaves it as it is.`);
      want = now.from ? 'disabled' : 'off';
      steps = now.from ? tool.disable() : tool.remove();
    } else {
      want = 'on';
      if (now.state === 'off') steps = tool.add(this.own);
      else if (now.managed) return now.state === 'on' ? { outcome: 'unchanged', state: now.state } : this._change(provider, resolved, tool, account, 'on', expect);
      else steps = tool.replace(this.own);
    }
    try {
      if (want === 'on' && account.dir) this.prepareAccount(provider, account.account);
      for (const args of steps) await this._run(provider, resolved, account.env, args);
    } catch (err) {
      const after = await this.readAccount(provider, resolved, account);
      return { outcome: 'failed', state: after.state, detail: `${provider.command} mcp failed: ${lastLine(err)}` };
    }
    let after = await this.readAccount(provider, resolved, account);
    // Removing its own entry can leave the tool loading one from another tool's settings.
    if (action === 'off' && after.state === 'on' && after.from && tool.disable) {
      try {
        for (const args of tool.disable()) await this._run(provider, resolved, account.env, args);
      } catch (err) {
        return { outcome: 'failed', state: after.state, detail: `${provider.command} mcp failed: ${lastLine(err)}` };
      }
      after = await this.readAccount(provider, resolved, account);
      want = 'disabled';
    }
    if (after.state !== want) return { outcome: 'failed', state: after.state, detail: after.detail ?? `${provider.tool} reported success, but the server is ${after.state}` };
    return { outcome: 'changed', state: after.state };
  }
}
