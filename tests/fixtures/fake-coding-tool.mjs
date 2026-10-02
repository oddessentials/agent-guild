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
// FAKE_CODEX_LOADS_NONE=1 makes Codex's hooks/list answer without our hooks.
//
// Lines typed into the session:
//   prompt                 a user prompt (Codex runs its SessionStart hooks here)
//   subagent <id> <type>   a sub-agent starts; Gemini: an invoke_agent call starts
//   subagent-done <id> <type>
//   shell <id> <ms> [fg|bg|exec|ps|ask-yes|ask-no] [command...]
//                          runs a shell command for <ms> as the tool would: its hooks, and a
//                          process whose command line has the tool's own form (Claude Code's
//                          eval script, Codex CLI's sandbox wrapper and -lc). Claude Code and
//                          Gemini CLI return a bg command's call at once; Codex CLI never
//                          reports the end of one that outlives its 1 s yield; exec runs the
//                          command itself with bash -lc, which replaces itself with it; ps runs
//                          it as Claude Code's PowerShell tool; ask-yes and ask-no show a
//                          permission dialog for a while, then run the command or not
//   shell-denied <id> [command...]
//                          a start event with no process and no end event
//   tool <agent-id> <tool>  a sub-agent calls a tool that is not a shell
//   turn-end               the main thread's turn ends
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
    if (process.env.FAKE_GEMINI_CWD_LOG) fs.appendFileSync(process.env.FAKE_GEMINI_CWD_LOG, `${process.cwd()}\n`);
    if (process.env.GEMINI_CLI_TRUST_WORKSPACE !== 'true') {
      const trusted = path.join(geminiHome(), 'trustedFolders.json');
      fs.writeFileSync(trusted, JSON.stringify({ ...readJson(trusted), [process.cwd()]: 'TRUST_FOLDER' }));
    }
    if (fs.existsSync(dir)) {
      out('Extension "agent-guild" is already installed. Please uninstall it first.');
      process.exit(1);
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.gemini-extension-install.json'), JSON.stringify({ source: path.resolve(argv[2]), type: 'link' }));
    out('Extension "agent-guild" linked successfully and enabled.');
  } else if (argv[1] === 'uninstall') {
    const source = readJson(path.join(dir, '.gemini-extension-install.json'))?.source;
    if (!source || !readJson(path.join(source, 'gemini-extension.json'))) {
      process.stderr.write('Extension not found.\n');
      process.exit(1);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    out('Extension "agent-guild" successfully uninstalled.');
  }
  process.exit(0);
}

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
    if (hook && hook[1] !== 'state') hooks[hook[1]] = { matcher: body.match(/matcher='([^']*)'/)?.[1], commands: [...body.matchAll(/command='([^']*)'/g)].map((m) => m[1]) };
    if (key === 'hooks.state') state = Object.fromEntries([...body.matchAll(/'([^']+)'=\{trusted_hash='([^']+)'\}/g)].map((m) => [m[1], m[2]]));
  }
  const snake = (event) => event.replace(/[A-Z]/g, (c, i) => `${i ? '_' : ''}${c.toLowerCase()}`);
  return Object.entries(hooks).flatMap(([event, { matcher, commands }]) => commands.map((command, i) => {
    const key = `/<session-flags>/config.toml:${snake(event)}:0:${i}`;
    const hash = `sha256:${crypto.createHash('sha256').update(`${event}\0${command}`).digest('hex')}`;
    return { event, matcher, command, key, hash, trusted: state[key] === hash };
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
        const hooks = (process.env.FAKE_CODEX_LOADS_NONE === '1' ? [] : listed).map((h) => ({
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
  const matching = hooks.filter((h) => h.event === event && (!h.matcher || (toolName !== null && new RegExp(`^(?:${h.matcher})$`).test(toolName))));
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
  if (tool !== 'codex') sessionStart();

  const shellSleep = 'setTimeout(() => {}, Number(process.env.FAKE_SHELL_MS))';
  const quote = (text) => `'${text.replace(/'/g, `'"'"'`)}'`;
  const shellArgv = (command) => {
    if (tool === 'claude') return ['--', '/bin/bash', '-c', `source /tmp/snapshot.sh && eval ${quote(command)} < /dev/null && pwd -P >| /tmp/cwd`];
    if (tool === 'codex') return ['--', 'codex-linux-sandbox', '--sandbox-policy-cwd', process.cwd(), '--', '/bin/zsh', '-lc', command];
    return ['--', 'bash', '-c', command];
  };
  const toolName = { claude: 'Bash', codex: 'Bash', gemini: 'run_shell_command', grok: 'run_terminal_command' }[tool];
  const shellEvent = (start, id, input, response, name = toolName) => {
    if (tool === 'gemini') return [start ? 'BeforeTool' : 'AfterTool', { tool_name: name, tool_input: input, ...(response ? { tool_response: response } : {}) }, name];
    if (tool === 'grok') return [start ? 'PreToolUse' : 'PostToolUse', { hookEventName: start ? 'pre_tool_use' : 'post_tool_use', toolName: name, toolUseId: id, toolInput: input, ...(response ? { toolResult: response } : {}) }, name];
    return [start ? 'PreToolUse' : 'PostToolUse', { tool_name: name, tool_use_id: id, tool_input: input, ...(tool === 'codex' ? { turn_id: 'turn-1' } : {}), ...(response ? { tool_response: response } : {}) }, name];
  };
  const runShell = async (id, ms, mode, command) => {
    const background = mode === 'bg';
    const input = tool === 'gemini' ? { command, description: 'test', is_background: background }
      : { command, ...(background && tool === 'claude' ? { run_in_background: true } : {}) };
    const name = mode === 'ps' ? 'PowerShell' : toolName;
    const [startEvent, startPayload, matcher] = shellEvent(true, id, input, null, name);
    await runHooks(hooks, startEvent, startPayload, matcher);
    if (mode === 'ask-yes' || mode === 'ask-no') {
      await runHooks(hooks, 'PermissionRequest', { tool_name: name, tool_input: input, permission_suggestions: [] }, name);
      out(`SHELL-ASKED ${id}`);
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_PERMISSION_MS || 1500)));
      if (mode === 'ask-no') {
        out(`SHELL-REJECTED ${id}`);
        return;
      }
    }
    const child = mode === 'exec'
      ? spawn('bash', ['-lc', command], { stdio: 'ignore' })
      : spawn(process.execPath, ['-e', shellSleep, ...shellArgv(command)], { env: { ...process.env, FAKE_SHELL_MS: String(ms) }, stdio: 'ignore', windowsHide: true });
    out(`SHELL-STARTED ${id} ${child.pid}`);
    const end = (response) => {
      const [event, payload] = shellEvent(false, id, input, response, name);
      return runHooks(hooks, event, payload, matcher);
    };
    child.on('exit', async () => {
      out(`SHELL-EXITED ${id}`);
      if (background && (tool === 'claude' || tool === 'gemini')) return;
      if (tool === 'codex' && ms > 1000) return;
      await end(tool === 'gemini' ? { llmContent: 'Output: (empty)' } : { stdout: '' });
      out(`SHELL-DONE ${id}`);
    });
    if (background && tool === 'claude') await end({ stdout: '', backgroundTaskId: `bg-${id}` });
    if (background && tool === 'gemini') await end({ llmContent: `Command is running in background. PID: ${child.pid}. Initial output:\n(empty)` });
  };

  const handle = async (line) => {
    const [cmd, id, type, ...rest] = line.trim().split(/\s+/);
    if (cmd === 'shell') {
      const [mode = 'fg', ...words] = rest;
      return runShell(id, Number(type), mode, words.length ? words.join(' ') : `sleep-for ${id}`);
    }
    if (cmd === 'shell-denied') {
      const [event, payload, matcher] = shellEvent(true, id, { command: [type, ...rest].join(' ') || `denied ${id}` });
      await runHooks(hooks, event, payload, matcher);
      out(`SHELL-DENIED ${id}`);
      return;
    }
    if (cmd === 'turn-end') {
      await runHooks(hooks, { claude: 'Stop', codex: 'UserPromptSubmit', gemini: 'AfterAgent', grok: 'Stop' }[tool], { stop_hook_active: false, prompt: 'next' });
      out('TURN-ENDED');
      return;
    }
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
    } else if (cmd === 'tool') {
      await runHooks(hooks, 'PreToolUse', { tool_name: type, tool_use_id: `call-${id}-${type}`, tool_input: {}, agent_id: id, ...(tool === 'codex' ? { turn_id: `turn-${id}` } : {}) }, type);
      out(`TOOL ${id} ${type}`);
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
