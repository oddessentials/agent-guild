// Stand-ins for Claude Code, Codex CLI, Gemini CLI and Grok Build that find
// and run hooks the way each real tool does, so tests can follow a sub-agent
// from the tool's hook to the session card. The first argument names the
// tool: claude, codex, gemini or grok.
//
// Hooks come from:
//   claude  --plugin-dir <dir> (hooks/hooks.json), and $CLAUDE_CONFIG_DIR/settings.json
//   codex   -c hooks.<Event>=[...] (run only when hooks.state trusts them by key and hash),
//           and $CODEX_HOME/hooks.json; `app-server` answers initialize and hooks/list
//   gemini  extensions linked under $GEMINI_CLI_HOME/.gemini/extensions; hooks run with
//           Gemini's variable redaction (names containing TOKEN, KEY, AUTH ... removed)
//   grok    --plugin-dir <dir>, accepted only when FAKE_GROK_PLUGIN_DIR=1, and $GROK_HOME/hooks/*.json
//
// Lines typed into the session:
//   prompt                 a user prompt (Codex runs its SessionStart hooks here)
//   subagent <id> <type>   a sub-agent starts; Gemini: an invoke_agent call starts
//   subagent-done <id> <type>
//   exit

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [tool, ...argv] = process.argv.slice(2);
const win = process.platform === 'win32';
const out = (text) => process.stdout.write(`${text}\r\n`);
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

if (argv.includes('--version')) {
  out(`${tool} 9.0.0`);
  process.exit(0);
}

if (argv.includes('--help')) {
  out(`Usage: ${tool} [options]`);
  if (tool === 'claude' || (tool === 'grok' && process.env.FAKE_GROK_PLUGIN_DIR === '1')) out('  --plugin-dir <path>   Load a plugin for this session only');
  out('  -h, --help            Show help');
  process.exit(0);
}

const flag = (name) => {
  const values = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name) values.push(argv[++i]);
  return values;
};

if (tool === 'grok' && argv.includes('--plugin-dir') && process.env.FAKE_GROK_PLUGIN_DIR !== '1') {
  process.stderr.write("error: unexpected argument '--plugin-dir' found\n");
  process.exit(2);
}

const geminiHome = () => path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini');

if (tool === 'gemini' && argv[0] === 'extensions') {
  const dir = path.join(geminiHome(), 'extensions', 'agent-guild');
  if (argv[1] === 'link') {
    if (!argv.includes('--consent')) process.exit(1);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.gemini-extension-install.json'), JSON.stringify({ source: path.resolve(argv[2]), type: 'link' }));
    out('Extension "agent-guild" linked successfully and enabled.');
  } else if (argv[1] === 'uninstall') {
    fs.rmSync(dir, { recursive: true, force: true });
    out('Extension "agent-guild" successfully uninstalled.');
  }
  process.exit(0);
}

/** Codex: our parse of the -c TOML is only as deep as the manager's own values. */
function codexOverrides() {
  const hooks = {};
  let state = {};
  for (const value of flag('-c')) {
    const eq = value.indexOf('=');
    const key = value.slice(0, eq);
    const body = value.slice(eq + 1);
    if (process.env.FAKE_CODEX_REJECT === '1') {
      process.stderr.write(`Error: failed to load bootstrap configuration\nCaused by: unknown field in \`${key}\`\n`);
      process.exit(1);
    }
    const hook = key.match(/^hooks\.([A-Za-z]+)$/);
    if (hook && hook[1] !== 'state') hooks[hook[1]] = [...body.matchAll(/command='([^']*)'/g)].map((m) => m[1]);
    if (key === 'hooks.state') state = Object.fromEntries([...body.matchAll(/'([^']+)'=\{trusted_hash='([^']+)'\}/g)].map((m) => [m[1], m[2]]));
  }
  const snake = (event) => event.replace(/[A-Z]/g, (c, i) => `${i ? '_' : ''}${c.toLowerCase()}`);
  return Object.entries(hooks).flatMap(([event, commands]) => commands.map((command, i) => {
    const key = `/<session-flags>/config.toml:${snake(event)}:0:${i}`;
    const hash = `sha256:${crypto.createHash('sha256').update(`${event}\0${command}`).digest('hex')}`;
    return { event, command, key, hash, trusted: state[key] === hash };
  }));
}

if (tool === 'codex' && argv.includes('app-server')) {
  const listed = codexOverrides();
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const msg = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      if (msg.id === 1) process.stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: 'fake' } })}\n`);
      if (msg.id === 2) {
        const hooks = listed.map((h) => ({
          key: h.key, eventName: h.event.charAt(0).toLowerCase() + h.event.slice(1), command: h.command, source: 'sessionFlags',
          enabled: true, currentHash: h.hash, trustStatus: h.trusted ? 'trusted' : 'untrusted',
        }));
        process.stdout.write(`${JSON.stringify({ id: 2, result: { data: [{ cwd: process.cwd(), hooks }] } })}\n`);
      }
    }
  });
  setTimeout(() => process.exit(0), 10000).unref();
} else {
  runTool();
}

function settingsHooks(file) {
  const hooks = readJson(file)?.hooks || {};
  return Object.entries(hooks).flatMap(([event, groups]) => groups.flatMap((group) => (group.hooks || [])
    .map((h) => ({ event, matcher: group.matcher, command: h.command }))));
}

function pluginHooks(dirs) {
  return dirs.flatMap((dir) => settingsHooks(path.join(dir, 'hooks', 'hooks.json')));
}

/** Every hook the tool would run, as { event, matcher, command }. */
function discover() {
  if (tool === 'claude') {
    const settings = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
    if (readJson(settings)?.disableAllHooks === true) return [];
    return [...pluginHooks(flag('--plugin-dir')), ...settingsHooks(settings)];
  }
  if (tool === 'codex') {
    const own = codexOverrides().filter((h) => {
      if (!h.trusted) out(`CODEX-UNTRUSTED ${h.key}`);
      return h.trusted;
    });
    return [...own, ...settingsHooks(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json'))];
  }
  if (tool === 'gemini') {
    const extensions = path.join(geminiHome(), 'extensions');
    const dirs = [];
    for (const name of fs.existsSync(extensions) ? fs.readdirSync(extensions) : []) {
      const record = readJson(path.join(extensions, name, '.gemini-extension-install.json'));
      if (record?.source) dirs.push(record.source);
    }
    return [...pluginHooks(dirs), ...settingsHooks(path.join(geminiHome(), 'settings.json'))];
  }
  const home = process.env.GROK_HOME || path.join(os.homedir(), '.grok');
  const files = fs.existsSync(path.join(home, 'hooks')) ? fs.readdirSync(path.join(home, 'hooks')).filter((f) => f.endsWith('.json')) : [];
  return [...pluginHooks(flag('--plugin-dir')), ...files.flatMap((f) => settingsHooks(path.join(home, 'hooks', f)))];
}

/** Gemini CLI's redaction, on by default in these tests: what a real user can turn on. */
const REDACTED = [/TOKEN/i, /SECRET/i, /PASSWORD/i, /PASSWD/i, /KEY/i, /AUTH/i, /CREDENTIAL/i, /CREDS/i, /PRIVATE/i, /CERT/i];
function hookEnv() {
  if (tool !== 'gemini') return process.env;
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() === 'PATH' || !REDACTED.some((re) => re.test(key))));
}

function shellFor(command) {
  if (tool === 'gemini') return win ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]] : ['bash', ['-c', command]];
  return win ? ['cmd.exe', ['/d', '/s', '/c', `"${command}"`]] : ['/bin/sh', ['-c', command]];
}

function runHooks(hooks, event, payload, toolName = null) {
  const matching = hooks.filter((h) => h.event === event && (!h.matcher || h.matcher === toolName));
  return matching.reduce((prev, hook) => prev.then(() => new Promise((resolve) => {
    const [file, args] = shellFor(hook.command);
    const child = spawn(file, args, { env: hookEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: file === 'cmd.exe' });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { out(`HOOK ${event} ERROR ${err.message}`); resolve(); });
    child.on('close', (code) => { out(`HOOK ${event} EXIT:${code}${stderr.trim() ? ` STDERR:${JSON.stringify(stderr.trim())}` : ''}`); resolve(); });
    child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: `${tool}-session`, cwd: process.cwd(), ...payload }));
  })), Promise.resolve());
}

function runTool() {
  const hooks = discover();
  out(`FAKE-${tool.toUpperCase()} READY hooks=${hooks.length}`);
  let started = false;
  const sessionStart = () => {
    if (started) return Promise.resolve();
    started = true;
    return runHooks(hooks, 'SessionStart', { source: 'startup' });
  };
  // Codex runs SessionStart with the first turn; the others when they start.
  if (tool !== 'codex') sessionStart();

  const handle = async (line) => {
    const [cmd, id, type] = line.trim().split(/\s+/);
    if (cmd === 'prompt') {
      await sessionStart();
      await runHooks(hooks, tool === 'gemini' ? 'BeforeAgent' : 'UserPromptSubmit', { prompt: 'hi' });
      out('PROMPT-DONE');
    } else if (cmd === 'subagent' || cmd === 'subagent-done') {
      const start = cmd === 'subagent';
      if (tool === 'gemini') {
        await runHooks(hooks, start ? 'BeforeTool' : 'AfterTool', { tool_name: 'invoke_agent', tool_input: { agent_name: type, prompt: `task ${id}` } }, 'invoke_agent');
      } else if (tool === 'grok') {
        await runHooks(hooks, start ? 'SubagentStart' : 'SubagentStop', { hookEventName: start ? 'subagent_start' : 'subagent_stop', subagentId: id, subagentType: type });
      } else {
        await runHooks(hooks, start ? 'SubagentStart' : 'SubagentStop', { agent_id: id, agent_type: type });
      }
      out(`${start ? 'SUBAGENT' : 'SUBAGENT-DONE'} ${id}`);
    } else if (cmd === 'exit') process.exit(0);
  };

  let buffer = '';
  let chain = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.search(/[\r\n]/)) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) chain = chain.then(() => handle(line));
    }
  });
  process.on('SIGHUP', () => process.exit(129));
}
