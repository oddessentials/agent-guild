// `<tool> mcp ...` for claude, codex, agy and grok, stored as each real tool stores it. Calls are logged to $FAKE_MCP_LOG.
// fake-mcp.json { "fail": true } fails every call, { "garbage": true } prints a list that is not JSON; a home named *broken* refuses writes.
// As the real tools do, codex fails when $CODEX_HOME does not exist, and grok creates its home on any call. Grok also
// loads ~/.claude.json's servers, as `inspect` and `mcp doctor` show and `mcp list` does not, and only says on stderr that its
// config does not parse ({ "configError": true }); { "stderrNoise": true } writes an unrelated stderr line.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

const home = () => (process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME) || os.homedir();
const homes = {
  claude: () => process.env.CLAUDE_CONFIG_DIR || home(),
  codex: () => process.env.CODEX_HOME || path.join(home(), '.codex'),
  agy: () => home(),
  grok: () => process.env.GROK_HOME || path.join(home(), '.grok'),
};
const files = {
  claude: (dir) => path.join(dir, '.claude.json'),
  codex: (dir) => path.join(dir, 'fake-mcp.json'),
  agy: (dir) => path.join(dir, '.gemini', 'config', 'mcp_config.json'),
  grok: (dir) => path.join(dir, 'fake-mcp.json'),
};

function load(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function store(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

export function runMcp(tool, argv) {
  const dir = homes[tool]();
  const file = files[tool](dir);
  if (process.env.FAKE_MCP_LOG) fs.appendFileSync(process.env.FAKE_MCP_LOG, `${JSON.stringify({ tool, home: dir, argv })}\n`);
  if (tool === 'codex' && process.env.CODEX_HOME && !fs.existsSync(dir)) fail('Error: failed to resolve CODEX_HOME');
  if (tool === 'grok') fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  const config = load(file);
  if (config.fail) fail('settings are locked');
  const servers = config.mcpServers ?? config.servers ?? {};
  // Grok Build keeps the names `mcp disable` turned off, and whether it loads Claude Code's servers, in config.toml.
  const offFile = path.join(dir, 'config.toml');
  const grokConfig = tool !== 'grok' ? {} : (() => {
    try { return parseToml(fs.readFileSync(offFile, 'utf8')); } catch { return {}; }
  })();
  const disabled = grokConfig.disabled_mcp_servers ?? [];
  const save = () => {
    store(file, tool === 'claude' || tool === 'agy' ? { ...config, mcpServers: servers } : { servers });
    if (tool === 'grok') fs.writeFileSync(offFile, stringifyToml({ ...grokConfig, disabled_mcp_servers: disabled }));
  };
  const claudeFile = path.join(home(), '.claude.json');
  const claudeServers = () => load(claudeFile).mcpServers ?? {};
  if (tool === 'grok' && argv[0] === 'inspect') {
    if (argv.slice(1).join(' ') !== '--json') fail(`grok: unexpected arguments: ${argv.join(' ')}`, 2);
    const own = Object.entries(servers).filter(([name, s]) => s.enabled !== false && !disabled.includes(name))
      .map(([name, s]) => ({ name, transport: 'stdio', target: s.command, source: { type: 'configToml', path: offFile } }));
    const theirs = Object.entries(claudeServers()).filter(([name]) => !servers[name])
      .map(([name, s]) => ({ name, transport: 'stdio', target: s.command, source: { type: 'claudeJson', path: claudeFile },
        ...(grokConfig.compat?.claude?.mcps === false ? { disabled: true, compatibilityStatus: 'disabled' } : { compatibilityStatus: 'enabled' }), vendor: 'claude' }));
    process.stdout.write(`${JSON.stringify({ cwd: process.cwd(), mcpServers: [...own, ...theirs] }, null, 2)}\n`);
    process.exit(0);
  }
  if (tool === 'grok' && config.configError) process.stderr.write('2026-11-02T00:00:00Z ERROR config toml has syntax errors: TOML parse error at line 1\n');
  if (tool === 'grok' && config.stderrNoise) process.stderr.write('2026-11-02T00:00:00Z WARN leader socket is stale, starting a new one\n');
  const scoped = tool === 'claude' || tool === 'grok';
  const [verb, ...rest] = argv.slice(1);
  const scope = scoped && rest[0] === '-s' && rest[1] === 'user' ? rest.splice(0, 2) : [];
  const usage = () => fail(`${tool}: unexpected arguments: ${argv.join(' ')}`, 2);
  if (scoped && !['list', 'enable', 'disable', 'doctor'].includes(verb) && !scope.length) usage();
  if (verb === 'list') {
    if (tool !== 'codex' && tool !== 'grok') usage();
    if (rest.join(' ') !== '--json') usage();
    if (config.garbage) { process.stdout.write('MCP servers:\n  (none)\n'); process.exit(0); }
    const list = Object.entries(servers).map(([name, s]) => (tool === 'codex'
      ? { name, enabled: s.enabled !== false, disabled_reason: null, transport: s.url ? { type: 'streamable_http', url: s.url } : { type: 'stdio', command: s.command, args: s.args, env: s.env ?? null, env_vars: s.env_vars ?? [], cwd: s.cwd ?? null }, startup_timeout_sec: null, tool_timeout_sec: null, auth_status: 'unsupported' }
      : { ...(s.url ? { url: s.url } : { command: s.command, args: s.args }), ...(s.env && { env: s.env }), enabled: s.enabled !== false && !disabled.includes(name), name, scope: 'user' }));
    process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
    process.exit(0);
  }
  const [name, ...command] = rest;
  if (verb === 'doctor') {
    if (tool !== 'grok' || command.join(' ') !== '--json') usage();
    const own = servers[name];
    const theirs = own ? null : claudeServers()[name];
    const entry = own ?? theirs;
    if (!entry) fail(`MCP server '${name}' not found.`);
    const off = disabled.includes(name) || own?.enabled === false;
    // As Grok Build's doctor does, an enabled server is started to check it.
    if (!off) spawnSync(entry.command, entry.args ?? [], { stdio: 'ignore', timeout: 10000, windowsHide: true });
    const report = entry ? [{ name, transport: 'stdio', target: [entry.command, ...(entry.args ?? [])].join(' '), source: own ? '~/.grok/config.toml' : '~/.claude.json',
      checks: off ? [{ label: 'disabled in config', passed: false, detail: 'server is disabled in config.toml' }] : [{ label: 'command found', passed: true }], healthy: !off }] : [];
    process.stdout.write(`${JSON.stringify({ sources: [], servers: report, healthy_count: 0, failing_count: 0 }, null, 2)}\n`);
    process.exit(off ? 1 : 0);
  }
  if (verb === 'add') {
    if (command[0] !== '--' || command.length < 2) usage();
    if (path.basename(dir).includes('broken')) fail('cannot write the settings');
    if (tool === 'claude' && servers[name]) fail(`MCP server ${name} already exists in user config`);
    servers[name] = tool === 'claude' ? { type: 'stdio', command: command[1], args: command.slice(2), env: {} }
      : tool === 'agy' ? { args: command.slice(2), command: command[1], disabled: false }
        : { command: command[1], args: command.slice(2), enabled: true };
    save();
    process.exit(0);
  }
  if (command.length) usage();
  if (verb === 'enable' || verb === 'disable') {
    if (tool !== 'agy' && tool !== 'grok') usage();
    if (path.basename(dir).includes('broken')) fail('cannot write the settings');
    const on = verb === 'enable';
    if (tool === 'grok' && !servers[name] && !claudeServers()[name] && !disabled.includes(name)) fail(`MCP server "${name}" not found`);
    if (tool === 'agy' && !servers[name]) fail(`MCP server "${name}" not found`);
    if (tool === 'agy') servers[name].disabled = !on;
    else {
      if (servers[name]) servers[name].enabled = on;
      const listed = disabled.filter((n) => n !== name);
      disabled.splice(0, disabled.length, ...(on ? listed : [...listed, name]));
    }
    save();
    process.exit(0);
  }
  if (verb === 'remove') {
    if (!servers[name]) fail(`No MCP server named "${name}"`);
    delete servers[name];
    save();
    process.exit(0);
  }
  usage();
}
