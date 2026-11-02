import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSpawnSpec, runSpec } from './command-resolver.mjs';
import { antigravityConfigFile } from './session-hooks.mjs';
import { stableExecPath } from './autostart.mjs';
import { PACKAGE_SCRIPT } from './launch.mjs';

export const SERVER_NAME = 'agent-guild';
export const MCP_MODES = ['claude', 'codex', 'antigravity', 'grok'];
const STATE_TTL_MS = 60 * 1000;
const RUN_TIMEOUT_MS = 30000;

export function ownServer(execPath = process.execPath, home = process.env.AGENT_GUILD_HOME) {
  return { command: stableExecPath(execPath), args: [PACKAGE_SCRIPT, 'mcp', ...(home ? [`--home=${path.resolve(home)}`] : [])] };
}

const homeOf = (env, platform) => (platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();

export function classify(entry, own, { enabled = true, command, args, remote = null } = {}) {
  if (entry === undefined || entry === null) return { state: 'off' };
  if (remote) return { state: 'other', detail: `agent-guild is already set to ${remote}` };
  if (typeof command !== 'string' || !Array.isArray(args) || !args.every((a) => typeof a === 'string')) {
    return { state: 'unknown', detail: 'its MCP settings name the agent-guild server in a form Agent Guild does not recognize' };
  }
  if (command !== own.command || args.length !== own.args.length || args.some((a, i) => a !== own.args[i])) {
    return { state: 'other', detail: `agent-guild is already set to run ${[command, ...args].join(' ')}` };
  }
  return { state: enabled === false ? 'disabled' : 'on' };
}

function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: true };
    return { error: `${file} cannot be read: ${err.message}` };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: `${file} is not valid JSON` };
  }
}

function fromServersFile(file, own, enabledOf) {
  const read = readJsonFile(file);
  if (read.missing) return { state: 'off' };
  if (read.error) return { state: 'unknown', detail: read.error };
  const servers = read.value?.mcpServers;
  if (servers === undefined) return { state: 'off' };
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return { state: 'unknown', detail: `${file} has mcpServers in a form Agent Guild does not recognize` };
  const entry = Object.hasOwn(servers, SERVER_NAME) ? servers[SERVER_NAME] : undefined;
  if (entry === undefined) return { state: 'off' };
  if (!entry || typeof entry !== 'object') return classify(entry, own);
  const remote = entry.type !== undefined && entry.type !== 'stdio' ? String(entry.url ?? entry.type) : null;
  return classify(entry, own, { enabled: enabledOf(entry), command: entry.command, args: entry.args ?? [], remote });
}

function fromList(stdout, own, pick) {
  let list;
  try { list = JSON.parse(stdout); } catch { list = null; }
  if (!Array.isArray(list)) return { state: 'unknown', detail: 'its MCP server list was not in a form Agent Guild recognizes' };
  const entry = list.find((item) => item?.name === SERVER_NAME && pick.match(item));
  if (!entry) return { state: 'off' };
  return classify(entry, own, pick.fields(entry));
}

const TOOLS = {
  claude: {
    file: (env, platform) => path.join(env.CLAUDE_CONFIG_DIR || homeOf(env, platform), '.claude.json'),
    read(ctx) { return fromServersFile(this.file(ctx.env, ctx.platform), ctx.own, () => true); },
    add: (own) => ['mcp', 'add', '-s', 'user', SERVER_NAME, '--', own.command, ...own.args],
    remove: () => ['mcp', 'remove', '-s', 'user', SERVER_NAME],
  },
  codex: {
    list: ['mcp', 'list', '--json'],
    pick: {
      match: () => true,
      fields: (e) => ({ enabled: e.enabled, command: e.transport?.command, args: e.transport?.args ?? [], remote: e.transport?.type && e.transport.type !== 'stdio' ? String(e.transport.url ?? e.transport.type) : null }),
    },
    add: (own) => ['mcp', 'add', SERVER_NAME, '--', own.command, ...own.args],
    // Adding again replaces the entry, and with it the `enabled = false` that turned it off.
    enable: (own) => ['mcp', 'add', SERVER_NAME, '--', own.command, ...own.args],
    remove: () => ['mcp', 'remove', SERVER_NAME],
  },
  antigravity: {
    file: (env, platform) => path.join(path.dirname(antigravityConfigFile(env, platform)), 'mcp_config.json'),
    read(ctx) { return fromServersFile(this.file(ctx.env, ctx.platform), ctx.own, (entry) => entry.disabled !== true); },
    add: (own) => ['mcp', 'add', SERVER_NAME, '--', own.command, ...own.args],
    enable: () => ['mcp', 'enable', SERVER_NAME],
    remove: () => ['mcp', 'remove', SERVER_NAME],
  },
  grok: {
    list: ['mcp', 'list', '--json'],
    pick: { match: (e) => e.scope === undefined || e.scope === 'user', fields: (e) => ({ enabled: e.enabled, command: e.command, args: e.args ?? [], remote: e.url ? String(e.url) : null }) },
    add: (own) => ['mcp', 'add', '-s', 'user', SERVER_NAME, '--', own.command, ...own.args],
    enable: () => ['mcp', 'enable', SERVER_NAME],
    remove: () => ['mcp', 'remove', '-s', 'user', SERVER_NAME],
  },
};

function lastLine(err) {
  return `${err.stderr || ''}\n${err.stdout || ''}`.trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() || err.message;
}

function refusal(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export function summarize(accounts) {
  const count = (state) => accounts.filter((a) => a.state === state).length;
  const total = accounts.length;
  const on = count('on');
  const state = on === total ? 'on'
    : count('off') === total ? 'off'
      : on > 0 ? 'partial'
        : count('unknown') ? 'unknown'
          : count('other') ? 'other'
            : count('disabled') ? 'disabled'
              : 'off';
  return { state, on, total };
}

export class McpConnect {
  constructor({ registry, own, prepareAccount, dir = os.homedir(), ttlMs = STATE_TTL_MS }) {
    this.registry = registry;
    this.prepareAccount = prepareAccount;
    this.own = own;
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

  async _run(provider, resolved, env, args) {
    return runSpec(buildSpawnSpec(resolved, args, env, this.registry.platform), { env, cwd: this.dir, timeoutMs: RUN_TIMEOUT_MS, killTree: true });
  }

  async readAccount(provider, resolved, account) {
    const tool = this._tool(provider);
    // A managed home that does not exist yet holds no settings, and some tools create it when asked.
    if (account.dir && !fs.existsSync(account.dir)) return { state: 'off' };
    const ctx = { env: account.env, platform: this.registry.platform, own: this.own };
    if (tool.read) return tool.read(ctx);
    try {
      const { stdout } = await this._run(provider, resolved, account.env, tool.list);
      return fromList(stdout, this.own, tool.pick);
    } catch (err) {
      return { state: 'unknown', detail: `${provider.command} ${tool.list.join(' ')} failed: ${lastLine(err)}` };
    }
  }

  async _readAll(provider, resolved) {
    return Promise.all(this._accounts(provider).map(async (account) => ({ id: account.id, label: account.label, ...await this.readAccount(provider, resolved, account) })));
  }

  refresh(provider, { force = false } = {}) {
    const resolved = this.registry.resolve(provider);
    if (!this._tool(provider) || !resolved) return Promise.resolve(null);
    const sig = this._signature(provider);
    const cached = this.cache.get(provider.id);
    if (!force && cached && cached.resolved === resolved && cached.sig === sig && Date.now() - cached.at < this.ttlMs) return Promise.resolve(cached.accounts);
    // A forced read follows a change, so a read that started before it must not be the one kept.
    const pending = this.reading.get(provider.id);
    if (!force && pending?.sig === sig) return pending.job;
    const seq = ++this.reads;
    const job = this._readAll(provider, resolved).then((accounts) => {
      if (this.reading.get(provider.id)?.seq !== seq) return accounts;
      this.reading.delete(provider.id);
      // Accounts that changed during the read make its result obsolete.
      const current = this.registry.get(provider.id);
      if (!current || this._signature(current) !== sig) return accounts;
      const before = this.cache.get(provider.id);
      this.cache.set(provider.id, { resolved, sig, accounts, at: Date.now() });
      // A page showing "checking" for a new account set needs this read even when every state is the same.
      if (before?.sig !== sig || JSON.stringify(accounts) !== JSON.stringify(before.accounts)) this.registry.emit?.('updated');
      return accounts;
    }, (err) => {
      if (this.reading.get(provider.id)?.seq === seq) this.reading.delete(provider.id);
      throw err;
    });
    this.reading.set(provider.id, { seq, sig, job });
    return job;
  }

  describe(provider) {
    if (!this._tool(provider) || !this.registry.resolve(provider)) return null;
    this.refresh(provider).catch(() => {});
    const cached = this.cache.get(provider.id);
    if (!cached || cached.sig !== this._signature(provider)) return { state: 'checking', on: 0, total: provider.accounts.length, accounts: [] };
    return { ...summarize(cached.accounts), accounts: cached.accounts.map(({ id, label, state, detail }) => ({ id, label, state, detail: detail ?? null })) };
  }

  async setEnabled(provider, enabled) {
    const tool = this._tool(provider);
    if (!tool) throw refusal(400, 'not_applicable', `${provider.tool} has no MCP settings Agent Guild can change`);
    const resolved = this.registry.resolve(provider);
    if (!resolved) throw refusal(409, 'provider_unavailable', `${provider.tool} is not installed`);
    if (this.busy.has(provider.id)) throw refusal(409, 'busy', `${provider.tool}'s MCP settings are already being changed`);
    this.busy.add(provider.id);
    try {
      const results = [];
      for (const account of this._accounts(provider)) {
        results.push({ id: account.id, label: account.label, ...await this._change(provider, resolved, tool, account, enabled) });
      }
      await this.refresh(provider, { force: true });
      return results;
    } finally {
      this.busy.delete(provider.id);
    }
  }

  async _change(provider, resolved, tool, account, enabled) {
    // The cache is for display only: every change acts on a fresh read of the account.
    const now = await this.readAccount(provider, resolved, account);
    const want = enabled ? 'on' : 'off';
    if (now.state === want) return { outcome: 'unchanged', state: now.state };
    if (now.state === 'unknown' || now.state === 'other') return { outcome: 'skipped', state: now.state, detail: now.detail };
    const args = !enabled ? tool.remove() : now.state === 'disabled' ? tool.enable(this.own) : tool.add(this.own);
    try {
      if (enabled && account.dir) this.prepareAccount(provider, account.account);
      await this._run(provider, resolved, account.env, args);
    } catch (err) {
      return { outcome: 'failed', state: now.state, detail: `${provider.command} ${args.slice(0, 2).join(' ')} failed: ${lastLine(err)}` };
    }
    const after = await this.readAccount(provider, resolved, account);
    if (after.state !== want) return { outcome: 'failed', state: after.state, detail: after.detail ?? `${provider.tool} reported success, but the server is ${after.state}` };
    return { outcome: enabled ? 'added' : 'removed', state: after.state };
  }
}
