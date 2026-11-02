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
import { McpConnect, SERVER_NAME, classify, ownServer, serverEnv } from '../src/manager/mcp-connect.mjs';
import { dataDir, dataDirFor } from '../src/manager/config.mjs';
import { PACKAGE_SCRIPT } from '../src/manager/launch.mjs';
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

function setup(t, { accounts = {}, extraEnv = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-mcp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const name of [...Object.values(TOOLS), 'agent-guild', 'npx']) writeScript(path.join(bin, name), name);
  const home = path.join(root, 'home');
  const log = path.join(root, 'mcp.log');
  const env = {
    PATH: [bin, ...systemDirs].join(path.delimiter), HOME: home, USERPROFILE: home, FAKE_MCP_LOG: log,
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), GROK_HOME: path.join(root, 'grok'),
    ...(win && { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: '.COM;.EXE;.BAT;.CMD' }),
    ...extraEnv,
  };
  const userFile = path.join(root, 'providers.json');
  fs.writeFileSync(userFile, JSON.stringify({
    providers: Object.keys(TOOLS).map((id) => ({ id, usage: null, history: null, accounts: (accounts[id] ?? []).map((a) => ({ id: a, label: a })) })),
  }));
  for (const dir of [home, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, env.GROK_HOME]) fs.mkdirSync(dir, { recursive: true });
  const registry = new ProviderRegistry({ userFile, env, platform: process.platform, checkUpdates: false, accountsDir: path.join(root, 'accounts') });
  const manager = new SessionManager({ registry, baseEnv: {}, getApiUrl: () => '' });
  // The folder an unpinned `agent-guild mcp` reaches from these tools' environment.
  const guildHome = dataDirFor(env, process.platform);
  const own = ownServer(process.execPath, guildHome);
  const mcp = new McpConnect({ registry, own, home: guildHome, prepareAccount: (p, account) => manager.prepareAccount(p, account), dir: root });
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
  const read = async (id, account = 'default') => (await mcp.refresh(provider(id), { force: true })).find((a) => a.id === account);
  const change = async (id, action, account = 'default') => mcp.change(provider(id), account, action, (await read(id, account)).fingerprint);
  return { root, home, env, guildHome, registry, own, mcp, provider, homeOf, calls, clearCalls, setAccounts, read, change };
}

function storeFile(id, dir) {
  if (id === 'anthropic') return path.join(dir, '.claude.json');
  if (id === 'google') return path.join(dir, '.gemini', 'config', 'mcp_config.json');
  return path.join(dir, 'fake-mcp.json');
}

function seed(id, dir, { command, args, enabled = true, env, url }) {
  const entry = url ? { type: 'http', url }
    : id === 'anthropic' ? { type: 'stdio', command, args, env: env ?? {} }
      : id === 'google' ? { args, command, disabled: !enabled, ...(env && { env }) }
        : { command, args, enabled, ...(env && { env }) };
  const value = id === 'anthropic' || id === 'google' ? { theme: 'dark', mcpServers: { [SERVER_NAME]: entry } } : { servers: { [SERVER_NAME]: entry } };
  fs.mkdirSync(path.dirname(storeFile(id, dir)), { recursive: true });
  fs.writeFileSync(storeFile(id, dir), JSON.stringify(value));
}

function writeRaw(id, dir, text) {
  fs.mkdirSync(path.dirname(storeFile(id, dir)), { recursive: true });
  fs.writeFileSync(storeFile(id, dir), text);
}

const changes = (ctx) => ctx.calls().filter((c) => c.argv[1] !== 'list' && c.argv[0] !== 'inspect');

test('every tool reads Agent Guild\'s server, one the person added, another server, and broken settings alike', async (t) => {
  const ctx = setup(t);
  const elsewhere = path.join(ctx.root, 'other-guild');
  const cases = [
    ['Agent Guild\'s own', ctx.own, { state: 'on', managed: true }],
    ['agent-guild on PATH', { command: 'agent-guild', args: ['mcp'] }, { state: 'on', managed: false, command: 'agent-guild mcp' }],
    ['npx', { command: 'npx', args: ['-y', '@oddessentials/agent-guild@latest', 'mcp'] }, { state: 'on', managed: false }],
    ['Node and the script, typing on', { command: process.execPath, args: [PACKAGE_SCRIPT, 'mcp', '--allow-input'] }, { state: 'on', managed: false, allowInput: true }],
    ['pinned to this folder', { command: 'agent-guild', args: ['mcp', `--home=${ctx.guildHome}`] }, { state: 'on', managed: false }],
    ['its own AGENT_GUILD_HOME', { command: 'agent-guild', args: ['mcp'], env: { AGENT_GUILD_HOME: ctx.guildHome } }, { state: 'on', managed: false }],
    ['another data folder', { command: 'agent-guild', args: ['mcp', `--home=${elsewhere}`] }, { state: 'conflict', detail: /reaches the Agent Guild data folder/ }],
    ['another folder by env', { command: 'agent-guild', args: ['mcp'], env: { AGENT_GUILD_HOME: elsewhere } }, { state: 'conflict', detail: /reaches the Agent Guild data folder/ }],
    ['a relative folder', { command: 'agent-guild', args: ['mcp', '--home=guild'] }, { state: 'conflict', detail: /relative data folder/ }],
    ['another program', { command: 'node', args: ['server.js'] }, { state: 'conflict', detail: /something other than/ }],
    ['an unknown flag', { command: 'agent-guild', args: ['mcp', '--port=1'] }, { state: 'conflict', detail: /something other than/ }],
    ['a program that is gone', { command: path.join(ctx.root, 'gone', 'agent-guild'), args: ['mcp'] }, { state: 'conflict', detail: /not installed/ }],
    ['a script that is gone', { command: process.execPath, args: [path.join(ctx.root, 'gone', 'bin', 'agent-guild.mjs'), 'mcp'] }, { state: 'conflict', detail: /does not exist/ }],
    ['a variable', { command: 'agent-guild', args: ['mcp', '--home=${HOME}/guild'] }, { state: 'conflict', detail: /variables/ }],
    // As bin/agent-guild.mjs reads them: the first --home= decides, and an empty one leaves the folder to the environment.
    ['another folder first', { command: 'agent-guild', args: ['mcp', `--home=${elsewhere}`, `--home=${ctx.guildHome}`] }, { state: 'conflict', detail: /reaches the Agent Guild data folder/ }],
    ['this folder first', { command: 'agent-guild', args: ['mcp', `--home=${ctx.guildHome}`, `--home=${elsewhere}`] }, { state: 'on' }],
    ['an empty first --home', { command: 'agent-guild', args: ['mcp', '--home=', `--home=${elsewhere}`] }, { state: 'on' }],
    ...(win ? [['another folder in lower case', { command: 'agent-guild', args: ['mcp'], env: { agent_guild_home: elsewhere } }, { state: 'conflict', detail: /reaches the Agent Guild data folder/ }]] : []),
  ];
  for (const [id, tool] of Object.entries(TOOLS)) {
    const dir = ctx.homeOf(id);
    assert.equal((await ctx.read(id)).state, 'off', `${tool}: nothing set`);
    for (const [label, registration, want] of cases) {
      seed(id, dir, registration);
      const got = await ctx.read(id);
      for (const [key, value] of Object.entries(want)) {
        if (value instanceof RegExp) assert.match(got[key] ?? '', value, `${tool}, ${label}: ${key}`);
        else assert.equal(got[key], value, `${tool}, ${label}: ${key}`);
      }
      if (want.state === 'on' && id !== 'anthropic') {
        seed(id, dir, { ...registration, enabled: false });
        assert.equal((await ctx.read(id)).state, 'disabled', `${tool}, ${label}: turned off in the tool`);
      }
    }
    seed(id, dir, { url: 'https://mcp.example/agent-guild' });
    assert.deepEqual([(await ctx.read(id)).state, (await ctx.read(id)).detail], ['conflict', 'connects to https://mcp.example/agent-guild'], `${tool}: remote`);
  }
});

test('missing, empty and broken settings read as each tool reads them', async (t) => {
  const ctx = setup(t);
  const expect = async (id, text, state, label) => {
    if (text === null) fs.rmSync(storeFile(id, ctx.homeOf(id)), { force: true });
    else writeRaw(id, ctx.homeOf(id), text);
    const got = await ctx.read(id);
    assert.equal(got.state, state, label);
    if (state === 'error') assert.ok(got.detail, `${label}: says why`);
  };
  // Claude Code treats an empty .claude.json as corrupted; Antigravity CLI lists no servers.
  await expect('anthropic', null, 'off', 'Claude, missing');
  await expect('anthropic', '', 'error', 'Claude, empty');
  await expect('anthropic', '{ not json', 'error', 'Claude, broken');
  await expect('anthropic', '{"mcpServers":[]}', 'error', 'Claude, a list');
  await expect('google', null, 'off', 'Antigravity, missing');
  await expect('google', '', 'off', 'Antigravity, empty');
  await expect('google', ' \n', 'off', 'Antigravity, blank');
  await expect('google', '{ not json', 'error', 'Antigravity, broken');
  for (const id of ['openai', 'xai']) {
    await expect(id, '{"garbage":true}', 'error', `${id}, a list that is not JSON`);
    await expect(id, '{"fail":true}', 'error', `${id}, failing`);
  }
  await expect('xai', '{"configError":true,"servers":{}}', 'error', 'Grok, a config.toml that does not parse');
  assert.match((await ctx.read('xai')).detail, /ERROR config toml has syntax errors/);
  await expect('xai', '{"stderrNoise":true,"servers":{}}', 'off', 'Grok, an unrelated stderr line');
});

test('where the tool starts decides which data folder an unpinned registration reaches', () => {
  const platform = process.platform;
  const home = path.join(os.tmpdir(), 'guild-home');
  const folderKey = platform === 'win32' ? 'APPDATA' : platform === 'darwin' ? 'HOME' : 'XDG_CONFIG_HOME';
  const base = { PATH: path.dirname(process.execPath), HOME: home, USERPROFILE: home };
  const unpinned = { command: process.execPath, args: [PACKAGE_SCRIPT, 'mcp'], env: {}, enabled: true };
  const own = ownServer(process.execPath, home);
  const read = (env, guild, extra = {}, tool = 'claude') => classify({ ...unpinned, ...extra }, { own, home: guild, env, platform, drops: tool === 'codex' ? ['AGENT_GUILD_HOME', 'XDG_CONFIG_HOME'] : [], tool });

  const moved = { ...base, [folderKey]: path.join(home, 'moved') };
  assert.equal(read(moved, dataDirFor(moved, platform)).state, 'on', `${folderKey} from the tool's environment`);
  assert.equal(read(moved, dataDirFor(base, platform)).state, 'conflict', `${folderKey} moves it elsewhere`);

  const pinned = { ...base, AGENT_GUILD_HOME: path.join(home, 'custom') };
  assert.match(read(pinned, path.join(home, 'custom')).detail, /AGENT_GUILD_HOME decides/, 'set where the tool starts, it is not reliable');
  assert.equal(read(pinned, dataDirFor(base, platform), {}, 'codex').state, 'on', 'Codex does not pass AGENT_GUILD_HOME on');
  assert.equal(read(pinned, path.join(home, 'custom'), { envVars: ['AGENT_GUILD_HOME'] }, 'codex').detail?.includes('AGENT_GUILD_HOME decides'), true, 'unless the entry names it');
  assert.equal(read(base, path.join(home, 'custom'), { env: { AGENT_GUILD_HOME: path.join(home, 'custom') } }).state, 'on', 'the entry\'s own AGENT_GUILD_HOME');
  if (folderKey === 'XDG_CONFIG_HOME') assert.equal(read(moved, dataDirFor(moved, platform), {}, 'codex').state, 'conflict', 'Codex does not pass XDG_CONFIG_HOME on');
});

test('on Windows the entry\'s variable wins in any case, except under Claude Code, where Node keeps the first key', () => {
  const tool = { AGENT_GUILD_HOME: 'C:\\tool', APPDATA: 'C:\\tool-appdata', Path: 'C:\\tool-bin' };
  const entry = { agent_guild_home: 'C:\\entry', appdata: 'C:\\entry-appdata', PATH: 'C:\\entry-bin' };
  const values = (env) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, [v.value, v.fromEntry]]));
  assert.deepEqual(values(serverEnv(tool, entry, { platform: 'win32' })), {
    AGENT_GUILD_HOME: ['C:\\entry', true], APPDATA: ['C:\\entry-appdata', true], PATH: ['C:\\entry-bin', true],
  }, 'Codex CLI, Grok Build and Antigravity CLI');
  assert.deepEqual(values(serverEnv(tool, entry, { platform: 'win32', firstKeyWins: true })), {
    AGENT_GUILD_HOME: ['C:\\tool', false], APPDATA: ['C:\\tool-appdata', false], PATH: ['C:\\entry-bin', true],
  }, 'Claude Code: AGENT_GUILD_HOME sorts before agent_guild_home, PATH before Path');
  assert.deepEqual(values(serverEnv({ agent_guild_home: 'C:\\tool' }, { AGENT_GUILD_HOME: 'C:\\entry' }, { platform: 'win32', firstKeyWins: true })), { AGENT_GUILD_HOME: ['C:\\entry', true] });
  assert.deepEqual(values(serverEnv({ AGENT_GUILD_HOME: 'C:\\tool' }, {}, { platform: 'win32', drops: ['AGENT_GUILD_HOME'] })), {}, 'Codex drops it in any case');
  assert.deepEqual(values(serverEnv(tool, entry, { platform: 'linux' })).agent_guild_home, ['C:\\entry', true], 'elsewhere names keep their case');
  assert.deepEqual(values(serverEnv(tool, entry, { platform: 'linux' })).AGENT_GUILD_HOME, ['C:\\tool', false]);
});

test('turning on and off runs each tool\'s own commands in the chosen account only', async (t) => {
  const ctx = setup(t, { accounts: { anthropic: ['work'], openai: ['work'], xai: ['work'] } });
  const add = (tool) => (tool === 'claude' || tool === 'grok' ? ['mcp', 'add', '-s', 'user', SERVER_NAME, '--'] : ['mcp', 'add', SERVER_NAME, '--']).concat(ctx.own.command, ctx.own.args);
  const remove = (tool) => (tool === 'claude' || tool === 'grok' ? ['mcp', 'remove', '-s', 'user', SERVER_NAME] : ['mcp', 'remove', SERVER_NAME]);
  for (const [id, tool] of Object.entries(TOOLS)) {
    const account = id === 'google' ? 'default' : 'work';
    const other = id === 'google' ? null : storeFile(id, ctx.homeOf(id));
    if (other) seed(id, ctx.homeOf(id), { command: 'node', args: ['theirs.js'] });
    const before = other && fs.readFileSync(other, 'utf8');
    ctx.clearCalls();
    assert.deepEqual(await ctx.change(id, 'on', account), { outcome: 'changed', state: 'on' }, tool);
    assert.deepEqual(changes(ctx), [{ tool, home: ctx.homeOf(id, account), argv: add(tool) }], `${tool}: added in that account's home only`);
    assert.equal((await ctx.read(id, account)).managed, true);
    ctx.clearCalls();
    assert.deepEqual(await ctx.change(id, 'on', account), { outcome: 'unchanged', state: 'on' }, `${tool}: already on`);
    assert.deepEqual(changes(ctx), []);
    assert.deepEqual(await ctx.change(id, 'off', account), { outcome: 'changed', state: 'off' }, tool);
    assert.deepEqual(changes(ctx), [{ tool, home: ctx.homeOf(id, account), argv: remove(tool) }]);
    if (other) assert.equal(fs.readFileSync(other, 'utf8'), before, `${tool}: the other account is untouched`);
  }
  for (const [id, argv] of [['openai', add('codex')], ['google', ['mcp', 'enable', SERVER_NAME]], ['xai', ['mcp', 'enable', SERVER_NAME]]]) {
    seed(id, ctx.homeOf(id), { ...ctx.own, enabled: false });
    ctx.clearCalls();
    assert.deepEqual(await ctx.change(id, 'on'), { outcome: 'changed', state: 'on' }, id);
    assert.deepEqual(changes(ctx).map((c) => c.argv), [argv], `${id}: turned on again`);
  }
});

test('a registration Agent Guild did not add changes only as asked, and only while it is the one the card showed', async (t) => {
  const ctx = setup(t);
  for (const [id, tool] of Object.entries(TOOLS)) {
    const dir = ctx.homeOf(id);
    const file = storeFile(id, dir);
    seed(id, dir, { command: 'agent-guild', args: ['mcp'] });
    const shown = await ctx.read(id);
    // The same command, but not the same registration.
    seed(id, dir, { command: 'agent-guild', args: ['mcp'], env: { NODE_OPTIONS: '--max-old-space-size=512' } });
    const theirs = fs.readFileSync(file, 'utf8');
    ctx.clearCalls();
    for (const action of ['off', 'replace']) {
      await assert.rejects(ctx.mcp.change(ctx.provider(id), 'default', action, shown.fingerprint), { code: 'changed' }, `${tool}: ${action} after the env changed`);
    }
    seed(id, dir, { command: 'agent-guild', args: ['mcp', '--allow-input'], env: { NODE_OPTIONS: '--max-old-space-size=512' } });
    await assert.rejects(ctx.mcp.change(ctx.provider(id), 'default', 'off', (await ctx.read(id)).fingerprint.replace(/^./, (c) => (c === '0' ? '1' : '0'))), { code: 'changed' });
    fs.writeFileSync(file, theirs);
    assert.deepEqual(changes(ctx), [], `${tool}: nothing ran`);
    assert.equal(fs.readFileSync(file, 'utf8'), theirs, `${tool}: left as it was`);

    seed(id, dir, { command: 'node', args: ['theirs.js'] });
    const conflict = fs.readFileSync(file, 'utf8');
    await assert.rejects(ctx.change(id, 'on'), { code: 'conflict' }, `${tool}: on does not take another server's place`);
    await assert.rejects(ctx.change(id, 'off'), { code: 'conflict' }, `${tool}: off does not remove another server`);
    assert.equal(fs.readFileSync(file, 'utf8'), conflict);
    assert.deepEqual(await ctx.change(id, 'replace'), { outcome: 'changed', state: 'on' }, `${tool}: replaced when asked`);
    assert.equal((await ctx.read(id)).managed, true);

    seed(id, dir, { command: 'agent-guild', args: ['mcp'] });
    assert.deepEqual(await ctx.change(id, 'off'), { outcome: 'changed', state: 'off' }, `${tool}: the person's own entry removed when asked`);
  }
  seed('openai', ctx.homeOf('openai'), { command: 'agent-guild', args: ['mcp'], enabled: false });
  await assert.rejects(ctx.change('openai', 'on'), { code: 'needs_replace' }, 'Codex turns another entry on only by replacing it');
  writeRaw('anthropic', ctx.homeOf('anthropic'), '{ not json');
  await assert.rejects(ctx.mcp.change(ctx.provider('anthropic'), 'default', 'on', 'x'), { code: 'unreadable' });
});

test('reading Grok Build starts no server it takes from Claude Code, and shows what Grok Build turns on', async (t) => {
  const ctx = setup(t);
  const marker = path.join(ctx.root, 'started');
  const server = path.join(ctx.root, 'server.mjs');
  fs.writeFileSync(server, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'started');\n`);
  const claudeFile = path.join(ctx.home, '.claude.json');
  const writeClaude = (entry) => fs.writeFileSync(claudeFile, JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: 'stdio', env: {}, ...entry } } }));
  writeClaude({ command: process.execPath, args: [server] });
  ctx.clearCalls();
  for (let i = 0; i < 3; i++) assert.deepEqual([(await ctx.read('xai')).state, (await ctx.read('xai')).from], ['conflict', 'Claude Code']);
  ctx.mcp.describe(ctx.provider('xai'));
  await ctx.mcp.refresh(ctx.provider('xai'));
  assert.equal(fs.existsSync(marker), false, 'the inherited server was never started');
  assert.deepEqual([...new Set(ctx.calls().map((c) => c.argv.slice(0, 2).join(' ')))].sort(), ['inspect --json', 'mcp list'], 'only reads ran');

  // Grok Build's own off list, which it writes one name per line once it holds two.
  writeClaude({ command: 'agent-guild', args: ['mcp'] });
  fs.writeFileSync(path.join(ctx.homeOf('xai'), 'config.toml'), 'disabled_mcp_servers = [\n    "other",\n    "agent-guild",\n]\n');
  assert.deepEqual([(await ctx.read('xai')).state, (await ctx.read('xai')).from], ['disabled', 'Claude Code']);
  fs.writeFileSync(path.join(ctx.homeOf('xai'), 'config.toml'), 'disabled_mcp_servers = ["other"]\n');
  assert.equal((await ctx.read('xai')).state, 'on');
  fs.writeFileSync(path.join(ctx.homeOf('xai'), 'config.toml'), 'disabled_mcp_servers = "agent-guild"\n');
  assert.equal((await ctx.read('xai')).state, 'error', 'an off list Agent Guild cannot read is not taken as on');
  fs.rmSync(path.join(ctx.homeOf('xai'), 'config.toml'));

  // Grok Build's own entry comes before Claude Code's, turned off or not.
  seed('xai', ctx.homeOf('xai'), { ...ctx.own, enabled: false });
  const off = await ctx.read('xai');
  assert.deepEqual([off.state, off.managed, off.from], ['disabled', true, null], 'its own entry, off, leaves Claude Code\'s unused');
  seed('xai', ctx.homeOf('xai'), ctx.own);
  const on = await ctx.read('xai');
  assert.deepEqual([on.state, on.managed, on.from], ['on', true, null]);
  assert.equal(fs.readFileSync(claudeFile, 'utf8'), JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: 'stdio', env: {}, command: 'agent-guild', args: ['mcp'] } } }), 'Claude Code\'s settings untouched');
  assert.equal(fs.existsSync(marker), false);
});

test('Grok Build\'s config.toml is read as TOML, and a server its compatibility settings leave out reads as off', async (t) => {
  const ctx = setup(t);
  const claudeFile = path.join(ctx.home, '.claude.json');
  fs.writeFileSync(claudeFile, JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: 'stdio', command: 'agent-guild', args: ['mcp'], env: {} } } }));
  const claude = fs.readFileSync(claudeFile, 'utf8');
  const config = path.join(ctx.homeOf('xai'), 'config.toml');
  const state = async (text) => { fs.writeFileSync(config, text); const r = await ctx.read('xai'); return [r.state, r.from]; };
  assert.deepEqual(await state('disabled_mcp_servers = [\n  "other", # "agent-guild"\n]\n'), ['on', 'Claude Code'], 'a name in a comment is not on the list');
  assert.deepEqual(await state('# disabled_mcp_servers = ["agent-guild"]\n'), ['on', 'Claude Code'], 'nor is a commented-out list');
  assert.deepEqual(await state('"disabled_mcp_servers" = ["agent-guild"]\n'), ['disabled', 'Claude Code'], 'a quoted key is the same key');
  assert.equal((await state('disabled_mcp_servers = [\n'))[0], 'error', 'a config.toml that does not parse is not read as on');

  fs.writeFileSync(config, '[compat.claude]\nmcps = false\n');
  ctx.clearCalls();
  const ignored = await ctx.read('xai');
  assert.deepEqual([ignored.state, ignored.from, Boolean(ignored.managed)], ['off', null, false], 'Grok Build lists it but does not load it');
  assert.match(ignored.detail, /does not load the agent-guild server in Claude Code's settings/);
  const view = card({ id: 'xai', tool: 'Grok Build', mcp: { mode: 'grok', accounts: [ignored] } });
  assert.deepEqual([view.label, view.button, view.action, view.ask], ['Off', 'Turn on', 'on', null]);
  assert.match(view.status, /Turn on adds Agent Guild's own server to Grok Build's settings\.$/);
  assert.deepEqual(await ctx.mcp.change(ctx.provider('xai'), 'default', 'on', ignored.fingerprint), { outcome: 'changed', state: 'on' });
  assert.deepEqual(changes(ctx).map((c) => c.argv.slice(0, 2)), [['mcp', 'add']], 'Turn on adds Grok Build\'s own entry and starts nothing');
  const own = await ctx.read('xai');
  assert.deepEqual([own.state, own.managed, own.from], ['on', true, null]);
  assert.equal(fs.readFileSync(claudeFile, 'utf8'), claude, 'Claude Code\'s settings untouched');
  assert.match(fs.readFileSync(config, 'utf8'), /mcps = false/, 'Grok Build\'s compatibility setting untouched');
});

test('Grok Build\'s card follows the server it takes from Claude Code\'s settings, and changes only Grok Build', async (t) => {
  const ctx = setup(t);
  const claudeFile = path.join(ctx.home, '.claude.json');
  const writeClaude = (entry) => fs.writeFileSync(claudeFile, JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: 'stdio', env: {}, ...entry } } }));
  writeClaude({ command: 'agent-guild', args: ['mcp'] });
  const theirs = fs.readFileSync(claudeFile, 'utf8');
  const on = await ctx.read('xai');
  assert.deepEqual([on.state, on.from, on.managed, on.command], ['on', 'Claude Code', false, 'agent-guild mcp']);

  ctx.clearCalls();
  assert.deepEqual(await ctx.change('xai', 'off'), { outcome: 'changed', state: 'disabled' });
  assert.deepEqual(changes(ctx).map((c) => c.argv), [['mcp', 'disable', SERVER_NAME]]);
  assert.equal((await ctx.read('xai')).state, 'disabled');
  assert.deepEqual(await ctx.change('xai', 'on'), { outcome: 'changed', state: 'on' });
  assert.equal(fs.readFileSync(claudeFile, 'utf8'), theirs, 'Claude Code\'s settings are untouched');

  writeClaude({ command: 'node', args: ['theirs.js'] });
  const other = await ctx.read('xai');
  assert.deepEqual([other.state, other.from], ['conflict', 'Claude Code']);
  ctx.clearCalls();
  await ctx.change('xai', 'off').catch(() => {});
  assert.deepEqual(await ctx.change('xai', 'replace'), { outcome: 'changed', state: 'on' });
  assert.deepEqual(changes(ctx).map((c) => c.argv.slice(0, 2)), [['mcp', 'add'], ['mcp', 'enable']]);
  const replaced = await ctx.read('xai');
  assert.deepEqual([replaced.managed, replaced.from], [true, null], 'Grok Build\'s own entry comes first');
  assert.match(fs.readFileSync(claudeFile, 'utf8'), /theirs\.js/);

  writeClaude({ command: 'agent-guild', args: ['mcp'] });
  assert.deepEqual(await ctx.change('xai', 'off'), { outcome: 'changed', state: 'disabled' }, 'off stays off with Claude Code\'s entry left behind');
  assert.equal((await ctx.read('xai')).from, 'Claude Code');
});

test('a settings file changed outside the card is read again at once; a CLI is asked again after the wait', async (t) => {
  const ctx = setup(t);
  await ctx.read('anthropic');
  await ctx.read('openai');
  ctx.mcp.ttlMs = 60 * 60 * 1000;
  seed('anthropic', ctx.homeOf('anthropic'), ctx.own);
  seed('openai', ctx.homeOf('openai'), ctx.own);
  assert.equal((await ctx.mcp.refresh(ctx.provider('anthropic')))[0].state, 'on', 'Claude Code\'s file is read again');
  assert.equal((await ctx.mcp.refresh(ctx.provider('openai')))[0].state, 'off', 'Codex is not asked again yet');
  ctx.mcp.ttlMs = 0;
  assert.equal((await ctx.mcp.refresh(ctx.provider('openai')))[0].state, 'on');
});

test('the read after a change is the one the card keeps, not one that started before it', async (t) => {
  const ctx = setup(t);
  const claude = ctx.provider('anthropic');
  // Claude Code's settings are read as the read starts, so this one sees no server.
  const earlier = ctx.mcp.refresh(claude, { force: true });
  seed('anthropic', ctx.homeOf('anthropic'), ctx.own);
  const after = ctx.mcp.refresh(claude, { force: true });
  assert.equal((await earlier)[0].state, 'off');
  assert.equal((await after)[0].state, 'on');
  assert.equal(ctx.mcp.describe(claude).accounts[0].state, 'on');
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
  const ctx = setup(t);
  for (const name of ['codex', 'agy', 'grok']) fs.rmSync(path.join(ctx.root, 'bin', win ? `${name}.cmd` : name));
  seed('anthropic', ctx.homeOf('anthropic'), ctx.own);
  assert.equal((await ctx.read('anthropic')).state, 'on');

  const token = 'a'.repeat(48);
  ctx.registry.mcpState = (provider) => ctx.mcp.describe(provider);
  const manager = Object.assign(new EventEmitter(), { list: () => [], refreshMultiplexers() {}, sessions: new Map() });
  const api = createManagerServer({ manager, registry: ctx.registry, token, port: 0, webDir: path.join(here, '..', 'web'), mcpConnect: ctx.mcp, heartbeatMs: 20 });
  await api.listen();
  const ws = new WebSocket(`${api.url.replace('http', 'ws')}/api/v1/events`, { headers: { Authorization: `Bearer ${token}` } });
  try {
    const off = new Promise((resolve) => ws.on('message', (raw) => {
      const event = JSON.parse(raw);
      if (event.type === 'providers.updated' && event.providers.find((p) => p.id === 'anthropic').mcp?.accounts[0].state === 'off') resolve();
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

test('a new account reads as off without running the tool, and turning it on makes its home first', async (t) => {
  const ctx = setup(t, { accounts: { openai: ['work'], xai: ['work'] } });
  for (const id of ['openai', 'xai']) {
    const work = ctx.homeOf(id, 'work');
    ctx.clearCalls();
    assert.equal((await ctx.read(id, 'work')).state, 'off', `${id}: a home not made yet holds no server`);
    assert.deepEqual(ctx.calls().filter((c) => c.home === work), [], `${id}: the tool is not asked about it`);
    assert.equal(fs.existsSync(work), false, `${id}: reading makes no folder`);
  }
  assert.deepEqual(await ctx.change('openai', 'on', 'work'), { outcome: 'changed', state: 'on' }, 'no session was started first');
  assert.ok(fs.existsSync(ctx.homeOf('openai', 'work')));
  assert.equal(fs.existsSync(ctx.homeOf('xai', 'work')), false, 'turning on one tool makes no other tool\'s home');
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
  assert.deepEqual(ctx.mcp.describe(ctx.provider('openai')).accounts.map((a) => [a.id, a.state]), [['default', 'checking']]);
  await once(ctx.registry, 'updated');
  assert.deepEqual(ctx.mcp.describe(ctx.provider('openai')).accounts.map((a) => [a.id, a.state]), [['default', 'off']]);

  ctx.setAccounts('openai', [{ id: 'work', label: 'work', dir: path.join(ctx.root, 'old-home') }]);
  await ctx.mcp.refresh(ctx.provider('openai'), { force: true });
  const moved = path.join(ctx.root, 'new-home');
  seed('openai', moved, ctx.own);
  const before = ctx.mcp.refresh(ctx.provider('openai'), { force: true });
  ctx.setAccounts('openai', [{ id: 'work', label: 'work', dir: moved }]);
  assert.equal((await before).find((a) => a.id === 'work').state, 'off', 'the read of the old home');
  assert.equal(ctx.mcp.describe(ctx.provider('openai')).accounts[1].state, 'checking', 'is not shown for the new one');
  await once(ctx.registry, 'updated');
  assert.deepEqual(ctx.mcp.describe(ctx.provider('openai')).accounts.map((a) => [a.id, a.state]), [['default', 'off'], ['work', 'on']]);
});

const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const cardSource = ['mcpView', 'renderMcpSetup'].map((name) => app.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0]);

function card(provider, selected = 'default') {
  const el = () => ({ hidden: false, textContent: '', disabled: false, open: false, classList: { toggle(name, on) { this[name] = on; } } });
  const parts = Object.fromEntries(['.mcp', '.mcp-state', '.mcp-about', '.mcp-status', '.mcp-command', '.mcp-action'].map((s) => [s, el()]));
  parts['.mcp'].querySelector = (selector) => parts[selector];
  const context = {
    card: { querySelector: (selector) => parts[selector] }, provider: { available: true, accounts: provider.mcp.accounts, ...provider },
    selectedAccount: (p) => p.accounts.find((a) => a.id === selected), openMcp: new Set(), mcpBusy: new Set(),
  };
  vm.runInNewContext(`${cardSource.join('\n')}\nrenderMcpSetup(card, provider); view = mcpView(provider, provider.mcp.accounts.find((a) => a.id === '${selected}'));`, context);
  const text = (s) => (parts[s].hidden ? null : parts[s].textContent);
  return { label: text('.mcp-state'), status: text('.mcp-status'), command: text('.mcp-command'), button: text('.mcp-action'), warned: Boolean(parts['.mcp'].classList.warned), ask: context.view.ask || null, action: context.view.action ?? null };
}

test('the card says what MCP does, what state it is in, and offers the one change that fits', () => {
  assert.ok(cardSource.every(Boolean), 'the card functions are present');
  assert.match(html, /<details class="mcp" hidden>/, 'a section of its own');
  assert.doesNotMatch(html, /mcp-row/, 'not squeezed into the reporting row');
  const tool = (id, mcp) => ({ id, tool: { anthropic: 'Claude Code', openai: 'Codex CLI', google: 'Antigravity CLI', xai: 'Grok Build' }[id], mcp: { mode: { anthropic: 'claude', openai: 'codex', google: 'antigravity', xai: 'grok' }[id], accounts: mcp } });
  const account = (fields) => ({ id: 'default', label: 'Default', managed: false, from: null, command: null, allowInput: false, detail: null, fingerprint: 'f', ...fields });

  assert.deepEqual(card(tool('openai', [account({ state: 'off' })])), { label: 'Off', status: 'Not added to Codex CLI.', command: null, button: 'Turn on', warned: false, ask: null, action: 'on' });
  assert.deepEqual(card(tool('anthropic', [account({ state: 'on', managed: true, command: 'node agent-guild.mjs mcp' })])),
    { label: 'On', status: 'New Claude Code sessions can use it.', command: null, button: 'Turn off', warned: false, ask: null, action: 'off' });
  const yours = card(tool('anthropic', [account({ state: 'on', command: 'agent-guild mcp' })]));
  assert.deepEqual([yours.label, yours.status, yours.command, yours.button, yours.ask.ok], ['On', 'You added it yourself. New Claude Code sessions can use it.', 'agent-guild mcp', 'Turn off', 'Remove']);
  assert.match(yours.ask.message, /agent-guild mcp$/);
  const borrowed = card(tool('xai', [account({ state: 'on', from: 'Claude Code', command: 'agent-guild mcp' })]));
  assert.deepEqual([borrowed.status, borrowed.ask], ['Grok Build takes it from Claude Code\'s settings. New Grok Build sessions can use it.', null]);
  const codexOff = card(tool('openai', [account({ state: 'disabled', command: 'agent-guild mcp' })]));
  assert.deepEqual([codexOff.label, codexOff.button, codexOff.action, codexOff.ask?.ok], ['Turned off', 'Replace…', 'replace', 'Replace'], 'Codex turns it on only by replacing it');
  const agyOff = card(tool('google', [account({ state: 'disabled', command: 'agent-guild mcp' })]));
  assert.deepEqual([agyOff.label, agyOff.button, agyOff.action, agyOff.ask], ['Turned off', 'Turn on', 'on', null]);
  const conflict = card(tool('anthropic', [account({ state: 'conflict', detail: 'runs something other than Agent Guild\'s MCP server', command: 'node theirs.js' })]));
  assert.deepEqual([conflict.label, conflict.warned, conflict.button, conflict.action, conflict.ask.ok], ['Conflict', true, 'Replace…', 'replace', 'Replace']);
  assert.equal(conflict.status, 'Claude Code already has a server named agent-guild that runs something other than Agent Guild\'s MCP server.');
  const error = card(tool('anthropic', [account({ state: 'error', detail: 'C:\\x\\.claude.json is not valid JSON', fingerprint: null })]));
  assert.deepEqual([error.label, error.warned, error.button, error.action], ['Unreadable', true, null, null]);
  const two = tool('anthropic', [account({ state: 'on', managed: true }), account({ id: 'work', label: 'Work', state: 'off' })]);
  assert.deepEqual([card(two, 'work').status, card(two, 'work').button], ['Work account: Not added to Claude Code.', 'Turn on'], 'the section follows the chosen account');
});
