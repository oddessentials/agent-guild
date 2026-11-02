// `<tool> mcp ...` for claude, codex, agy and grok, stored as each real tool stores it. Calls are logged to $FAKE_MCP_LOG.
// fake-mcp.json { "fail": true } fails every call, { "garbage": true } prints a list that is not JSON; a home named *broken* refuses writes.
// As the real tools do, codex fails when $CODEX_HOME does not exist, and grok creates its home on any call.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  const save = () => store(file, tool === 'claude' || tool === 'agy' ? { ...config, mcpServers: servers } : { servers });
  const scoped = tool === 'claude' || tool === 'grok';
  const [verb, ...rest] = argv.slice(1);
  const scope = scoped && rest[0] === '-s' && rest[1] === 'user' ? rest.splice(0, 2) : [];
  const usage = () => fail(`${tool}: unexpected arguments: ${argv.join(' ')}`, 2);
  if (scoped && verb !== 'list' && verb !== 'enable' && !scope.length) usage();
  if (verb === 'list') {
    if (tool !== 'codex' && tool !== 'grok') usage();
    if (rest.join(' ') !== '--json') usage();
    if (config.garbage) { process.stdout.write('MCP servers:\n  (none)\n'); process.exit(0); }
    const list = Object.entries(servers).map(([name, s]) => (tool === 'codex'
      ? { name, enabled: s.enabled !== false, disabled_reason: null, transport: { type: 'stdio', command: s.command, args: s.args, env: null, env_vars: [], cwd: null }, startup_timeout_sec: null, tool_timeout_sec: null, auth_status: 'unsupported' }
      : { command: s.command, args: s.args, enabled: s.enabled !== false, name, scope: 'user' }));
    process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
    process.exit(0);
  }
  const [name, ...command] = rest;
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
  if (verb === 'enable') {
    if (tool !== 'agy' && tool !== 'grok') usage();
    if (path.basename(dir).includes('broken')) fail('cannot write the settings');
    if (!servers[name]) fail(`MCP server "${name}" not found`);
    if (tool === 'agy') servers[name].disabled = false;
    else servers[name].enabled = true;
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
