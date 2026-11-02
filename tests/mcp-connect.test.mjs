import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import vm from 'node:vm';
import WebSocket from 'ws';
import { createManagerServer } from '../src/manager/server.mjs';
import { fileURLToPath } from 'node:url';
import { ProviderRegistry } from '../src/manager/providers.mjs';
import { McpConnect, SERVER_NAME, classify, ownServer } from '../src/manager/mcp-connect.mjs';
import { dataDir } from '../src/manager/config.mjs';
import { SessionManager } from '../src/manager/session-manager.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const win = process.platform === 'win32';
const codingTool = path.join(here, 'fixtures', 'fake-coding-tool.mjs');
const systemDirs = win
  ? ['System32', ''].map((dir) => path.join(process.env.SystemRoot || 'C:\\Windows', dir))
  : ['/usr/bin', '/bin'];
const TOOLS = { anthropic: 'claude', openai: 'codex', google: 'agy', xai: 'grok' };

function writeScript(file, name) {
  if (win) fs.writeFileSync(`${file}.cmd`, `@echo off\r\n"${process.execPath}" "${codingTool}" ${name} %*\r\n`);
  else fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${codingTool}" ${name} "$@"\n`, { mode: 0o755 });
}

function setup(t, { accounts = { anthropic: ['work', 'broken'], openai: ['work'], xai: ['work'] } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-mcp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const name of Object.values(TOOLS)) writeScript(path.join(bin, name), name);
  const home = path.join(root, 'home');
  const log = path.join(root, 'mcp.log');
  const env = {
    PATH: [bin, ...systemDirs].join(path.delimiter), HOME: home, USERPROFILE: home, FAKE_MCP_LOG: log,
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), GROK_HOME: path.join(root, 'grok'),
    ...(win && { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: '.COM;.EXE;.BAT;.CMD' }),
  };
  const userFile = path.join(root, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({
    providers: Object.keys(TOOLS).map((id) => ({ id, usage: null, history: null, accounts: (accounts[id] ?? []).map((a) => ({ id: a, label: a })) })),
  }));
  for (const dir of [home, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, env.GROK_HOME]) fs.mkdirSync(dir, { recursive: true });
  const registry = new ProviderRegistry({ userFile, env, platform: process.platform, checkUpdates: false, accountsDir: path.join(root, 'accounts') });
  const manager = new SessionManager({ registry, baseEnv: {}, getApiUrl: () => '' });
  const own = { command: process.execPath, args: [path.join(root, 'Agent Guild', 'bin', 'agent-guild.mjs'), 'mcp'] };
  const mcp = new McpConnect({ registry, own, prepareAccount: (p, account) => manager.prepareAccount(p, account), dir: root });
  const provider = (id) => registry.get(id);
  const homeOf = (id, account = 'default') => {
    if (account !== 'default') return path.join(root, 'accounts', id, account);
    return { anthropic: env.CLAUDE_CONFIG_DIR, openai: env.CODEX_HOME, google: home, xai: env.GROK_HOME }[id];
  };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  const clearCalls = () => fs.rmSync(log, { force: true });
  const setAccounts = (id, list) => {
    const config = JSON.parse(fs.readFileSync(userFile, 'utf8'));
    config.providers.find((p) => p.id === id).accounts = list.map((a) => (typeof a === 'string' ? { id: a, label: a } : a));
    fs.writeFileSync(userFile, JSON.stringify(config));
    registry.reload({ accountsOnly: true });
  };
  return { root, registry, own, mcp, provider, homeOf, calls, clearCalls, setAccounts };
}

function storeFile(id, dir) {
  if (id === 'anthropic') return path.join(dir, '.claude.json');
  if (id === 'google') return path.join(dir, '.gemini', 'config', 'mcp_config.json');
  return path.join(dir, 'fake-mcp.json');
}

function seed(id, dir, { command, args, enabled = true }) {
  const entry = id === 'anthropic' ? { type: 'stdio', command, args, env: {} }
    : id === 'google' ? { args, command, disabled: !enabled }
      : { command, args, enabled };
  const value = id === 'anthropic' || id === 'google' ? { theme: 'dark', mcpServers: { [SERVER_NAME]: entry } } : { servers: { [SERVER_NAME]: entry } };
  fs.mkdirSync(path.dirname(storeFile(id, dir)), { recursive: true });
  fs.writeFileSync(storeFile(id, dir), JSON.stringify(value));
}

function writeRaw(id, dir, text) {
  fs.mkdirSync(path.dirname(storeFile(id, dir)), { recursive: true });
  fs.writeFileSync(storeFile(id, dir), text);
}

const statesOf = async (ctx, id) => Object.fromEntries((await ctx.mcp.refresh(ctx.provider(id), { force: true })).map((a) => [a.id, a.state]));

test('each tool\'s own settings read as on, off, turned off in the tool, another command, or unreadable', async (t) => {
  const ctx = setup(t, { accounts: {} });
  const foreign = { command: 'agent-guild', args: ['mcp'] };
  for (const id of Object.keys(TOOLS)) {
    const dir = ctx.homeOf(id);
    assert.deepEqual(await statesOf(ctx, id), { default: 'off' }, `${id}: nothing set`);
    seed(id, dir, ctx.own);
    assert.deepEqual(await statesOf(ctx, id), { default: 'on' }, `${id}: Agent Guild's`);
    seed(id, dir, { ...ctx.own, enabled: false });
    if (id !== 'anthropic') assert.deepEqual(await statesOf(ctx, id), { default: 'disabled' }, `${id}: turned off in the tool is not on`);
    seed(id, dir, foreign);
    const other = (await ctx.mcp.refresh(ctx.provider(id), { force: true }))[0];
    assert.equal(other.state, 'other', `${id}: another command`);
    assert.match(other.detail, /already set to run agent-guild mcp/);
    seed(id, dir, { command: ctx.own.command, args: [ctx.own.args[0]] });
    assert.deepEqual(await statesOf(ctx, id), { default: 'other' }, `${id}: the same command with other arguments`);
    for (const broken of id === 'anthropic' || id === 'google' ? ['{ not json', '{"mcpServers":[]}'] : ['{"garbage":true}', '{"fail":true}']) {
      writeRaw(id, dir, broken);
      const unknown = (await ctx.mcp.refresh(ctx.provider(id), { force: true }))[0];
      assert.equal(unknown.state, 'unknown', `${id}: ${broken} is not off`);
      assert.ok(unknown.detail, `${id}: says why`);
      assert.equal(ctx.mcp.describe(ctx.provider(id)).state, 'unknown');
    }
  }
});

test('turning on and off runs each tool\'s own commands in every account home', async (t) => {
  const ctx = setup(t, { accounts: { anthropic: ['work'], openai: ['work'], xai: ['work'] } });
  const add = {
    claude: ['mcp', 'add', '-s', 'user', SERVER_NAME, '--', ctx.own.command, ...ctx.own.args],
    codex: ['mcp', 'add', SERVER_NAME, '--', ctx.own.command, ...ctx.own.args],
    agy: ['mcp', 'add', SERVER_NAME, '--', ctx.own.command, ...ctx.own.args],
    grok: ['mcp', 'add', '-s', 'user', SERVER_NAME, '--', ctx.own.command, ...ctx.own.args],
  };
  const remove = {
    claude: ['mcp', 'remove', '-s', 'user', SERVER_NAME],
    codex: ['mcp', 'remove', SERVER_NAME],
    agy: ['mcp', 'remove', SERVER_NAME],
    grok: ['mcp', 'remove', '-s', 'user', SERVER_NAME],
  };
  const changes = () => ctx.calls().filter((c) => c.argv[1] !== 'list');
  for (const [id, tool] of Object.entries(TOOLS)) {
    const homes = id === 'google' ? [ctx.homeOf(id)] : [ctx.homeOf(id), ctx.homeOf(id, 'work')];
    ctx.clearCalls();
    const on = await ctx.mcp.setEnabled(ctx.provider(id), true);
    assert.deepEqual(on.map((r) => r.outcome), homes.map(() => 'added'), id);
    assert.deepEqual(changes(), homes.map((home) => ({ tool, home, argv: add[tool] })), `${id}: add, once per account home`);
    assert.deepEqual(ctx.mcp.describe(ctx.provider(id)), { state: 'on', on: homes.length, total: homes.length, accounts: on.map((r) => ({ id: r.id, label: r.label, state: 'on', detail: null })) });

    ctx.clearCalls();
    assert.deepEqual((await ctx.mcp.setEnabled(ctx.provider(id), true)).map((r) => r.outcome), homes.map(() => 'unchanged'), `${id}: already on`);
    assert.deepEqual(changes(), [], `${id}: nothing to run`);

    ctx.clearCalls();
    assert.deepEqual((await ctx.mcp.setEnabled(ctx.provider(id), false)).map((r) => r.outcome), homes.map(() => 'removed'), id);
    assert.deepEqual(changes(), homes.map((home) => ({ tool, home, argv: remove[tool] })), `${id}: remove, once per account home`);
    assert.equal(ctx.mcp.describe(ctx.provider(id)).state, 'off');
  }

  for (const [id, argv] of [['openai', add.codex], ['google', ['mcp', 'enable', SERVER_NAME]], ['xai', ['mcp', 'enable', SERVER_NAME]]]) {
    seed(id, ctx.homeOf(id), { ...ctx.own, enabled: false });
    ctx.clearCalls();
    assert.equal((await ctx.mcp.setEnabled(ctx.provider(id), true))[0].outcome, 'added', id);
    assert.deepEqual(changes()[0].argv, argv, `${id}: turned on again`);
    assert.equal((await statesOf(ctx, id)).default, 'on');
  }
});

test('another agent-guild server is never changed, and accounts that fail do not undo the rest', async (t) => {
  const ctx = setup(t);
  for (const id of Object.keys(TOOLS)) {
    seed(id, ctx.homeOf(id), { command: 'agent-guild', args: ['mcp'] });
  }
  const before = Object.fromEntries(Object.keys(TOOLS).map((id) => [id, fs.readFileSync(storeFile(id, ctx.homeOf(id)), 'utf8')]));
  const unchanged = () => {
    for (const id of Object.keys(TOOLS)) assert.equal(fs.readFileSync(storeFile(id, ctx.homeOf(id)), 'utf8'), before[id], `${id}: the person's registration is untouched`);
  };

  const on = await ctx.mcp.setEnabled(ctx.provider('anthropic'), true);
  assert.deepEqual(on.map(({ id, outcome, state }) => ({ id, outcome, state })), [
    { id: 'default', outcome: 'skipped', state: 'other' },
    { id: 'work', outcome: 'added', state: 'on' },
    { id: 'broken', outcome: 'failed', state: 'off' },
  ]);
  assert.match(on[0].detail, /already set to run agent-guild mcp/);
  assert.match(on[2].detail, /cannot write the settings/);
  const card = ctx.mcp.describe(ctx.provider('anthropic'));
  assert.deepEqual([card.state, card.on, card.total], ['partial', 1, 3], 'on for 1 of 3 accounts');

  for (const id of ['openai', 'google', 'xai']) {
    assert.equal((await ctx.mcp.setEnabled(ctx.provider(id), true))[0].outcome, 'skipped', id);
    assert.equal((await ctx.mcp.setEnabled(ctx.provider(id), false))[0].outcome, 'skipped', id);
  }
  const off = await ctx.mcp.setEnabled(ctx.provider('anthropic'), false);
  assert.deepEqual(off.map((r) => r.outcome), ['skipped', 'removed', 'unchanged']);
  unchanged();
  const providerOf = Object.fromEntries(Object.entries(TOOLS).map(([id, tool]) => [tool, id]));
  const touched = ctx.calls().filter((c) => c.argv[1] !== 'list' && c.home === ctx.homeOf(providerOf[c.tool]));
  assert.deepEqual(touched, [], 'no add or remove ran in a home with the person\'s registration');
});

test('a change reads every account again rather than trusting what the card last showed', async (t) => {
  const ctx = setup(t, { accounts: {} });
  for (const id of ['anthropic', 'openai']) {
    const dir = ctx.homeOf(id);
    assert.equal(ctx.mcp.describe(ctx.provider(id)).state, 'checking');
    await ctx.mcp.refresh(ctx.provider(id));
    assert.equal(ctx.mcp.describe(ctx.provider(id)).state, 'off', `${id}: the card shows off`);
    seed(id, dir, { command: 'agent-guild', args: ['mcp'] });
    const theirs = fs.readFileSync(storeFile(id, dir), 'utf8');
    assert.equal((await ctx.mcp.setEnabled(ctx.provider(id), true))[0].outcome, 'skipped', `${id}: registered since the card looked`);
    assert.equal(fs.readFileSync(storeFile(id, dir), 'utf8'), theirs);

    await ctx.mcp.setEnabled(ctx.provider(id), false);
    seed(id, dir, ctx.own);
    await ctx.mcp.refresh(ctx.provider(id), { force: true });
    assert.equal(ctx.mcp.describe(ctx.provider(id)).state, 'on', `${id}: the card shows on`);
    seed(id, dir, { command: 'agent-guild', args: ['mcp'] });
    const replaced = fs.readFileSync(storeFile(id, dir), 'utf8');
    assert.equal((await ctx.mcp.setEnabled(ctx.provider(id), false))[0].outcome, 'skipped', `${id}: replaced since the card looked`);
    assert.equal(fs.readFileSync(storeFile(id, dir), 'utf8'), replaced);
  }
});

test('the read after a change is the one the card keeps, not one that started before it', async (t) => {
  const ctx = setup(t, { accounts: {} });
  const claude = ctx.provider('anthropic');
  // Claude Code's settings are read as the read starts, so this one sees no server.
  const earlier = ctx.mcp.refresh(claude, { force: true });
  seed('anthropic', ctx.homeOf('anthropic'), ctx.own);
  const after = ctx.mcp.refresh(claude, { force: true });
  assert.equal((await earlier)[0].state, 'off');
  assert.equal((await after)[0].state, 'on');
  assert.equal(ctx.mcp.describe(claude).state, 'on');
});

test('the command each tool is given starts Agent Guild\'s MCP server, with no shell and no PATH', async () => {
  const { command, args } = ownServer();
  assert.ok(path.isAbsolute(command) && path.isAbsolute(args[0]), 'absolute paths');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  const child = spawn(command, args, { env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise((resolve) => child.on('close', resolve));
  const answer = await new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    child.on('error', reject);
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('\n')) resolve(JSON.parse(out.split('\n')[0]));
    });
    child.on('close', (code) => reject(new Error(`exited ${code} before answering: ${err}`)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })}\n`);
  });
  child.stdin.end();
  await exited;
  assert.equal(answer.id, 1);
  assert.equal(answer.result.serverInfo.name, 'agent-guild');
});

test('a manager with its own data folder registers that folder, so a tool started anywhere reaches it', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-mcp-home-'));
  const token = 'b'.repeat(48);
  const api = http.createServer((req, res) => {
    const body = req.url === '/api/v1/health' ? { name: 'agent-guild', version: '9.9.9-home' }
      : req.headers.authorization !== `Bearer ${token}` ? null
        : req.url === '/api/v1/sessions' ? { sessions: [] } : { providers: [] };
    res.writeHead(body ? 200 : 401, { 'Content-Type': 'application/json' }).end(JSON.stringify(body ?? {}));
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  t.after(() => { api.close(); fs.rmSync(home, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(home, 'auth-token'), `${token}\n`);
  fs.writeFileSync(path.join(home, 'manager.json'), JSON.stringify({ url: `http://127.0.0.1:${api.address().port}` }));

  const { command, args } = ownServer(process.execPath, home);
  assert.equal(args.at(-1), `--home=${home}`);
  assert.equal(ownServer().args.at(-1), `--home=${path.resolve(dataDir())}`, 'the default folder is pinned too');
  const legacy = ownServer(process.execPath, home);
  assert.equal(classify({}, legacy, { command: legacy.command, args: legacy.legacyArgs }).state, 'on', 'a registration made before the pin is still ours');
  const elsewhere = path.join(home, 'elsewhere');
  const env = { ...process.env, APPDATA: elsewhere, XDG_CONFIG_HOME: elsewhere };
  delete env.AGENT_GUILD_HOME;
  const child = spawn(command, args, { env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => child.kill());
  const answers = new Map();
  let out = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
    for (let at; (at = out.indexOf('\n')) >= 0; out = out.slice(at + 1)) { const message = JSON.parse(out.slice(0, at)); answers.get(message.id)?.(message); }
  });
  const call = (id, method, params) => new Promise((resolve) => { answers.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const status = await call(2, 'tools/call', { name: 'guild_status', arguments: {} });
  assert.equal(JSON.parse(status.result.content[0].text).version, '9.9.9-home');
});

test('an open page hears an MCP server removed outside the card, from the heartbeat', async (t) => {
  const ctx = setup(t, { accounts: {} });
  for (const name of ['codex', 'agy', 'grok']) fs.rmSync(path.join(ctx.root, 'bin', win ? `${name}.cmd` : name));
  seed('anthropic', ctx.homeOf('anthropic'), ctx.own);
  await ctx.mcp.refresh(ctx.provider('anthropic'), { force: true });
  assert.equal(ctx.mcp.describe(ctx.provider('anthropic')).state, 'on');
  ctx.mcp.ttlMs = 0;

  const token = 'a'.repeat(48);
  ctx.registry.mcpState = (provider) => ctx.mcp.describe(provider);
  const manager = Object.assign(new EventEmitter(), { list: () => [], refreshMultiplexers() {}, sessions: new Map() });
  const api = createManagerServer({ manager, registry: ctx.registry, token, port: 0, webDir: path.join(here, '..', 'web'), mcpConnect: ctx.mcp, heartbeatMs: 20 });
  await api.listen();
  const ws = new WebSocket(`${api.url.replace('http', 'ws')}/api/v1/events`, { headers: { Authorization: `Bearer ${token}` } });
  try {
    const off = new Promise((resolve) => ws.on('message', (raw) => {
      const event = JSON.parse(raw);
      if (event.type === 'providers.updated' && event.providers.find((p) => p.id === 'anthropic').mcp?.state === 'off') resolve();
    }));
    await once(ws, 'open');
    writeRaw('anthropic', ctx.homeOf('anthropic'), JSON.stringify({ theme: 'dark', mcpServers: {} }));
    let timer;
    await Promise.race([off, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the card never heard the change')), 10000); })]);
    clearTimeout(timer);
  } finally {
    ws.terminate();
    await api.close();
  }
});

const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const cardSource = [app.match(/const MCP_STATES = [^\n]*\n/)?.[0], ...['mcpText', 'renderMcpSetup'].map((name) => app.match(new RegExp('function ' + name + '\\([^]*?\\n\\}'))?.[0])];

function cardRow(provider, mcp) {
  const el = () => ({ hidden: false, textContent: '', title: '' });
  const parts = { '.mcp-row': el(), '.mcp-text': el(), '.mcp-on': el(), '.mcp-off': el() };
  parts['.mcp-row'].querySelector = (selector) => parts[selector];
  const context = { card: { querySelector: (selector) => parts[selector] }, provider: { tool: provider.tool, id: provider.id, available: true, mcp } };
  vm.runInNewContext(`${cardSource.join('\n')}\nrenderMcpSetup(card, provider);`, context);
  return { text: parts['.mcp-text'].textContent, on: !parts['.mcp-on'].hidden, off: !parts['.mcp-off'].hidden };
}

test('a new account\'s MCP state reads as off without running the tool, and turning it on makes its home first', async (t) => {
  const ctx = setup(t, { accounts: { openai: ['work'], xai: ['work'] } });
  for (const id of ['openai', 'xai']) {
    const work = ctx.homeOf(id, 'work');
    ctx.clearCalls();
    assert.deepEqual(await statesOf(ctx, id), { default: 'off', work: 'off' }, `${id}: a home not made yet holds no server`);
    assert.deepEqual(ctx.calls().filter((c) => c.home === work), [], `${id}: the tool is not asked about it`);
    assert.equal(fs.existsSync(work), false, `${id}: reading makes no folder`);
  }
  const work = ctx.homeOf('openai', 'work');
  const on = await ctx.mcp.setEnabled(ctx.provider('openai'), true);
  assert.deepEqual(on.map((r) => [r.id, r.outcome]), [['default', 'added'], ['work', 'added']], 'no session was started first');
  assert.ok(fs.existsSync(work));
  assert.deepEqual(ctx.calls().filter((c) => c.home === work && c.argv[1] === 'add').length, 1);
  assert.equal(ctx.mcp.describe(ctx.provider('openai')).state, 'on');
  assert.equal(fs.existsSync(ctx.homeOf('xai', 'work')), false, 'turning on one tool makes no other tool\'s home');
});

test('an account added after MCP is on shows at once, as not on yet', async (t) => {
  const ctx = setup(t, { accounts: {} });
  await ctx.mcp.setEnabled(ctx.provider('openai'), true);
  assert.deepEqual(cardRow(ctx.provider('openai'), ctx.mcp.describe(ctx.provider('openai'))), { text: 'Agent Guild MCP on', on: false, off: true });

  ctx.setAccounts('openai', ['work']);
  const checking = ctx.mcp.describe(ctx.provider('openai'));
  assert.deepEqual([checking.state, checking.total], ['checking', 2], 'the snapshot without the new account is not shown');
  assert.deepEqual(cardRow(ctx.provider('openai'), checking), { text: 'Agent Guild MCP: checking', on: false, off: false });
  // describe started the read; the card hears of its result through the registry's updated event, before any TTL.
  await once(ctx.registry, 'updated');
  const after = ctx.mcp.describe(ctx.provider('openai'));
  assert.deepEqual([after.state, after.on, after.total], ['partial', 1, 2]);
  assert.deepEqual(after.accounts.map((a) => [a.id, a.state]), [['default', 'on'], ['work', 'off']]);
  assert.deepEqual(cardRow(ctx.provider('openai'), after), { text: 'Agent Guild MCP on for 1 of 2 accounts', on: true, off: true });
});

test('accounts changed while a read is running are never replaced by that read\'s result', async (t) => {
  const ctx = setup(t, { accounts: { openai: ['work'] } });
  let updates = 0;
  ctx.registry.on('updated', () => { updates++; });

  // Codex is asked as a separate process, so the read is still running when the accounts change.
  const removed = ctx.mcp.refresh(ctx.provider('openai'), { force: true });
  ctx.setAccounts('openai', []);
  updates = 0;
  assert.deepEqual((await removed).map((a) => a.id), ['default', 'work']);
  assert.equal(ctx.mcp.cache.has('openai'), false, 'the read of the removed account is not kept');
  assert.equal(updates, 0, 'nor announced');
  assert.equal(ctx.mcp.describe(ctx.provider('openai')).state, 'checking');
  await once(ctx.registry, 'updated');
  assert.deepEqual(ctx.mcp.describe(ctx.provider('openai')).accounts.map((a) => a.id), ['default']);

  ctx.setAccounts('openai', [{ id: 'work', label: 'work', dir: path.join(ctx.root, 'old-home') }]);
  await ctx.mcp.refresh(ctx.provider('openai'), { force: true });
  const moved = path.join(ctx.root, 'new-home');
  seed('openai', moved, ctx.own);
  const before = ctx.mcp.refresh(ctx.provider('openai'), { force: true });
  ctx.setAccounts('openai', [{ id: 'work', label: 'work', dir: moved }]);
  assert.equal((await before).find((a) => a.id === 'work').state, 'off', 'the read of the old home');
  assert.equal(ctx.mcp.describe(ctx.provider('openai')).state, 'checking', 'is not shown for the new one');
  await once(ctx.registry, 'updated');
  const now = ctx.mcp.describe(ctx.provider('openai'));
  assert.deepEqual([now.state, now.on, now.total], ['partial', 1, 2]);
  assert.deepEqual(cardRow(ctx.provider('openai'), now), { text: 'Agent Guild MCP on for 1 of 2 accounts', on: true, off: true });
});

test('a card showing checking after an account\'s home moves hears the new read, even with every state the same', async (t) => {
  const ctx = setup(t, { accounts: {} });
  const [first, second] = [path.join(ctx.root, 'home-1'), path.join(ctx.root, 'home-2')];
  for (const dir of [ctx.homeOf('openai'), first, second]) seed('openai', dir, ctx.own);
  ctx.setAccounts('openai', [{ id: 'work', label: 'work', dir: first }]);
  await ctx.mcp.refresh(ctx.provider('openai'), { force: true });
  assert.deepEqual(cardRow(ctx.provider('openai'), ctx.mcp.describe(ctx.provider('openai'))), { text: 'Agent Guild MCP on for all 2 accounts', on: false, off: true });

  const token = 'a'.repeat(48);
  ctx.registry.mcpState = (provider) => ctx.mcp.describe(provider);
  const manager = Object.assign(new EventEmitter(), { list: () => [], refreshMultiplexers() {}, sessions: new Map() });
  const api = createManagerServer({ manager, registry: ctx.registry, token, port: 0, webDir: path.join(here, '..', 'web'), mcpConnect: ctx.mcp });
  await api.listen();
  const ws = new WebSocket(`${api.url.replace('http', 'ws')}/api/v1/events`, { headers: { Authorization: `Bearer ${token}` } });
  try {
    const cards = [];
    let pong = null;
    ws.on('message', (raw) => {
      const event = JSON.parse(raw);
      if (event.type === 'pong') pong?.();
      if (event.type === 'providers.updated') cards.push(event.providers.find((p) => p.id === 'openai').mcp);
    });
    await once(ws, 'open');

    ctx.setAccounts('openai', [{ id: 'work', label: 'work', dir: second }]);
    // The read the checking card started; the server sends in order, so its event, if any, comes before the pong.
    await ctx.mcp.refresh(ctx.provider('openai'));
    await new Promise((resolve) => { pong = resolve; ws.send(JSON.stringify({ type: 'ping' })); });
    const mcp = cards.at(-1);
    assert.equal(cards[0].state, 'checking', 'the moved home is read again');
    assert.deepEqual(cardRow(ctx.provider('openai'), cards[0]), { text: 'Agent Guild MCP: checking', on: false, off: false });
    assert.deepEqual([mcp.state, mcp.on, mcp.total], ['on', 2, 2]);
    assert.deepEqual(cardRow(ctx.provider('openai'), mcp), { text: 'Agent Guild MCP on for all 2 accounts', on: false, off: true });
  } finally {
    ws.terminate();
    // Listing providers started reads of the other tools, whose processes run in the folder the test removes.
    for (const id of Object.keys(TOOLS)) await ctx.mcp.refresh(ctx.provider(id));
    await api.close();
  }
});
