// Stand-ins for Claude Code, Codex CLI, Antigravity CLI, Grok Build and
// Docker Agent that find and run hooks the way each real tool does, so tests
// can follow a sub-agent from the tool's hook to the session card. The first
// argument names the tool: claude, codex, agy, grok or docker.
//
// Hooks come from:
//   docker  `agent run --hook-<event> <command>` flags (session-start, pre-tool-use, post-tool-use,
//           stop, session-end); `agent version` prints the version. Events are snake_case and
//           name the agent; the shell tool is `shell` with `cmd`
//   claude  --plugin-dir <dir> (hooks/hooks.json), and $CLAUDE_CONFIG_DIR/settings.json
//   codex   -c hooks.<Event>=[...] (run only when hooks.state trusts them by key and hash),
//           and $CODEX_HOME/hooks.json; `app-server` answers initialize and hooks/list
//   agy     plugins installed with `plugin install` under ~/.gemini/config/plugins, unless
//           `plugin disable` turned them off in ~/.gemini/config/config.json; hooks run in
//           the plugin's folder (on Windows through cmd /C, which gets a quoted path wrong), take
//           no event name, and must print a JSON object
//   grok    --plugin-dir <dir>, accepted only when FAKE_GROK_PLUGIN_DIR=1, and $GROK_HOME/hooks/*.json
// FAKE_CODEX_LOADS_NONE=1 makes Codex's hooks/list answer without our hooks.
// FAKE_DOCKER_NO_PLUGIN=1 makes docker's --help answer as the Docker CLI does without the agent plugin: its own
// help, no hook flags, exit 0.
//
// Lines typed into the session:
//   prompt                 a user prompt (Codex runs its SessionStart hooks here)
//   subagent <id> <type>   a sub-agent starts
//   subagent-done <id> <type>
//   subagent-killed <id> <type>           Claude Code's TaskStop: a task notification, no SubagentStop
//   shell <id> hold [fg|bg|bg-silent|ps|interrupt|esc-bg|unpolled|ask-yes|ask-no|ask-rewrite] [command...]
//                          holds a real child until shell-end, with the tool's hooks. Claude Code
//                          returns a bg command's call at once and notifies its
//                          end as a prompt, except for bg-silent; Codex CLI reports a command's
//                          end when it ends, except for unpolled, which the model never checks on
//                          again; ps runs it as Claude Code's PowerShell tool; ask-yes and ask-no
//                          ask permission, then run the command or not; ask-rewrite
//                          runs a command a hook rewrote; interrupt makes shell-end act as Esc,
//                          which kills the command and fires no hook; esc-bg is Esc, which
//                          moves the command to the background, also with no hook
//   shell-end <id>         releases the child and waits for its exit hooks to finish
//   shell-denied <id> [command...]
//                          a start event with no process and no end event
//   permit <command...>    a permission request for a command, with no tool_use_id
//   taskstop <id>          Claude Code's TaskStop on the background command <id>
//   tool <agent-id> <tool>  a sub-agent calls a tool that is not a shell
//   turn-end               the main thread's turn ends; Claude Code's Stop lists its running background commands
//   interrupt              Codex CLI's Esc: its Interrupt hook; the running commands go on
//   session-end            Codex CLI's thread ends: its commands are stopped, then its SessionEnd hook runs
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

if (argv.includes('--version') || (tool === 'docker' && argv[0] === 'agent' && argv[1] === 'version')) {
  out(tool === 'docker' ? 'docker agent version v9.0.0' : `${tool} 9.0.0`);
  process.exit(0);
}

const DOCKER_HOOK_FLAGS = ['--hook-session-start', '--hook-pre-tool-use', '--hook-post-tool-use', '--hook-stop', '--hook-session-end'];

if (argv.includes('--help')) {
  out(`Usage: ${tool} [options]`);
  if (tool === 'claude' || (tool === 'grok' && process.env.FAKE_GROK_PLUGIN_DIR === '1')) out('  --plugin-dir <path>   Load a plugin for this session only');
  if (tool === 'docker' && process.env.FAKE_DOCKER_NO_PLUGIN !== '1') for (const name of DOCKER_HOOK_FLAGS) out(`      ${name} stringArray   Add a hook command (repeatable)`);
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

const agyPlugins = () => path.join(os.homedir(), '.gemini', 'config', 'plugins');
const agyConfig = () => path.join(os.homedir(), '.gemini', 'config', 'config.json');
const agyEnablement = (name, enabled) => {
  const config = readJson(agyConfig()) || {};
  config.plugins = { ...config.plugins };
  if (enabled === null) delete config.plugins[name];
  else config.plugins[name] = { enabled };
  fs.mkdirSync(path.dirname(agyConfig()), { recursive: true });
  fs.writeFileSync(agyConfig(), JSON.stringify(config, null, 2));
};

if (tool === 'agy' && argv[0] === 'plugin') {
  if (argv[1] === 'enable' || argv[1] === 'disable') {
    agyEnablement(argv[2], argv[1] === 'enable');
  } else if (argv[1] === 'install') {
    const name = readJson(path.join(argv[2], 'plugin.json'))?.name;
    if (!name) {
      process.stderr.write(`Error: missing plugin.json in ${argv[2]}\n`);
      process.exit(1);
    }
    fs.cpSync(argv[2], path.join(agyPlugins(), name), { recursive: true });
    out(`  [ok]    ${name}`);
  } else if (argv[1] === 'uninstall') {
    fs.rmSync(path.join(agyPlugins(), argv[2]), { recursive: true, force: true });
    if (readJson(agyConfig())) agyEnablement(argv[2], null);
    out(`Uninstalled plugin "${argv[2]}"`);
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
  if (tool === 'agy') {
    const root = agyPlugins();
    const disabled = (name) => readJson(agyConfig())?.plugins?.[name]?.enabled === false;
    return (fs.existsSync(root) ? fs.readdirSync(root) : []).filter((name) => !disabled(name)).flatMap((name) => {
      const cwd = path.join(root, name);
      return Object.values(readJson(path.join(cwd, 'hooks.json')) || {}).flatMap((named) => Object.entries(named)
        .flatMap(([event, entries]) => entries.flatMap((entry) => (entry.hooks || [entry]).map((h) => ({ event, matcher: entry.hooks ? entry.matcher : undefined, command: h.command, cwd })))));
    });
  }
  if (tool === 'docker') {
    const event = (name) => name.slice('--hook-'.length).replace(/(?:^|-)([a-z])/g, (_m, c) => c.toUpperCase());
    return DOCKER_HOOK_FLAGS.flatMap((name) => flag(name).map((command) => ({ event: event(name), command })));
  }
  const home = process.env.GROK_HOME || path.join(os.homedir(), '.grok');
  const files = fs.existsSync(path.join(home, 'hooks')) ? fs.readdirSync(path.join(home, 'hooks')).filter((f) => f.endsWith('.json')) : [];
  return [...pluginHooks(flag('--plugin-dir')), ...files.flatMap((f) => settingsHooks(path.join(home, 'hooks', f)))];
}

function shellFor(command) {
  if (tool === 'agy' && win) return ['cmd.exe', ['/d', '/s', '/c', `"${command.replace(/"/g, '\\"')}"`]];
  return win ? ['cmd.exe', ['/d', '/s', '/c', `"${command}"`]] : ['/bin/sh', ['-c', command]];
}

const conversationId = '0f1e2d3c-4b5a-4697-8877-665544332211';
const agyBrain = path.join(os.tmpdir(), `fake-agy-${process.pid}`);
const agyTranscript = (id) => path.join(agyBrain, id, '.system_generated', 'logs', 'transcript_full.jsonl');
const writeAgyTranscript = (id, first) => {
  fs.mkdirSync(path.dirname(agyTranscript(id)), { recursive: true });
  fs.writeFileSync(agyTranscript(id), `${JSON.stringify(first)}\n`);
};
const agyPayload = ({ conversationId: id = conversationId, ...payload }) => ({
  conversationId: id, workspacePaths: [process.cwd()], modelName: 'gemini-3.8-flash-high', transcriptPath: agyTranscript(id), ...payload,
});
if (tool === 'agy') process.on('exit', () => fs.rmSync(agyBrain, { recursive: true, force: true }));

function runHooks(hooks, event, payload, toolName = null) {
  const matching = hooks.filter((h) => h.event === event && (!h.matcher || (toolName !== null && new RegExp(`^(?:${h.matcher})$`).test(toolName))));
  return matching.reduce((prev, hook) => prev.then(() => new Promise((resolve) => {
    const [file, args] = shellFor(hook.command);
    const child = spawn(file, args, { cwd: hook.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: file === 'cmd.exe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { out(`HOOK ${event} ERROR ${err.message}`); resolve(); });
    child.on('close', (code) => {
      let answer = '';
      if (tool === 'agy') {
        try { answer = ` ANSWER:${JSON.stringify(JSON.parse(stdout))}`; } catch { answer = ` NOT-JSON:${JSON.stringify(stdout)}`; }
      }
      out(`HOOK ${event} EXIT:${code}${answer}${stderr.trim() ? ` STDERR:${JSON.stringify(stderr.trim())}` : ''}`);
      resolve();
    });
    const snake = (name) => name.replace(/[A-Z]/g, (c, i) => `${i ? '_' : ''}${c.toLowerCase()}`);
    const named = tool === 'docker' ? { hook_event_name: snake(event), agent_name: 'root' } : { hook_event_name: event };
    child.stdin.end(JSON.stringify(tool === 'agy' ? agyPayload(payload) : { ...named, session_id: `${tool}-session`, cwd: process.cwd(), ...payload }));
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
  if (tool !== 'codex' && tool !== 'agy') sessionStart();

  // EOF also releases the child if the fixture is killed during test cleanup.
  const shellHold = 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));';
  const running = new Map();
  // Claude Code's background tasks still running, by task id, as its Stop lists them.
  const tasks = new Map();
  const codexTurn = tool === 'codex' ? { turn_id: 'turn-1' } : {};
  const toolName = { claude: 'Bash', codex: 'Bash', grok: 'run_terminal_command', docker: 'shell' }[tool];
  const shellEvent = (start, id, input, response, name = toolName) => {
    if (tool === 'grok') return [start ? 'PreToolUse' : 'PostToolUse', { hookEventName: start ? 'pre_tool_use' : 'post_tool_use', toolName: name, toolUseId: id, toolInput: input, ...(response ? { toolResult: response } : {}) }, name];
    return [start ? 'PreToolUse' : 'PostToolUse', { tool_name: name, tool_use_id: id, tool_input: input, ...codexTurn, ...(response ? { tool_response: response } : {}) }, name];
  };
  const notification = (task, id, status) => `<task-notification>\n<task-id>${task}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<output-file>/tmp/tasks/${task}.output</output-file>\n<status>${status}</status>\n<summary>Background command "test" ${status} (exit code 0)</summary>\n</task-notification>`;
  const runShell = async (id, mode, command) => {
    const background = mode === 'bg' || mode === 'bg-silent';
    const name = mode === 'ps' ? 'PowerShell' : toolName;
    const announced = tool === 'docker' ? { cmd: command } : { command, ...(background && tool === 'claude' ? { run_in_background: true } : {}) };
    const [startEvent, startPayload, matcher] = shellEvent(true, id, announced, null, name);
    await runHooks(hooks, startEvent, startPayload, matcher);
    const input = mode.endsWith('-rewrite') ? { ...announced, command: `${command} -- --runInBand` } : announced;
    if (mode.startsWith('ask-')) {
      await runHooks(hooks, 'PermissionRequest', { tool_name: name, tool_input: input, permission_suggestions: [], ...codexTurn }, name);
      out(`SHELL-ASKED ${id}`);
      if (mode === 'ask-no') {
        out(`SHELL-REJECTED ${id}`);
        return;
      }
    }
    const child = spawn(process.execPath, ['-e', shellHold], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    out(`SHELL-STARTED ${id} ${child.pid}`);
    running.set(id, child);
    const task = `bg-${id}`;
    child.silent = mode === 'interrupt';
    if (mode === 'esc-bg') { tasks.set(task, child); out(`SHELL-ESCAPED ${id}`); }
    const end = (response) => {
      const [event, payload] = shellEvent(false, id, input, response, name);
      return runHooks(hooks, event, payload, matcher);
    };
    const exited = new Promise((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    child.finished = exited.then(async () => {
      running.delete(id);
      tasks.delete(task);
      out(`SHELL-EXITED ${id}`);
      if (child.silent || mode === 'bg-silent' || mode === 'unpolled') return;
      if (tool === 'claude' && (background || mode === 'esc-bg')) {
        await runHooks(hooks, 'UserPromptSubmit', { prompt: notification(task, id, 'completed') });
        out(`SHELL-NOTIFIED ${id}`);
        return;
      }
      await end(tool === 'codex' ? 'Exit code: 0' : { stdout: '' });
      out(`SHELL-DONE ${id}`);
    });
    if (background && tool === 'claude') {
      tasks.set(task, child);
      await end({ stdout: '', stderr: '', interrupted: false, backgroundTaskId: task });
    }
  };

  const handle = async (line) => {
    const [cmd, id, type, ...rest] = line.trim().split(/\s+/);
    if (cmd === 'shell') {
      const [mode = 'fg', ...words] = rest;
      if (type !== 'hold') throw new Error('fixture shells must be explicitly released with shell-end');
      return runShell(id, mode, words.length ? words.join(' ') : `held-command ${id}`);
    }
    if (cmd === 'shell-end') {
      const child = running.get(id);
      if (!child) throw new Error(`no running shell ${id}`);
      child.stdin.end();
      await child.finished;
      out(`SHELL-RELEASED ${id}`);
      return;
    }
    if (cmd === 'shell-denied') {
      const [event, payload, matcher] = shellEvent(true, id, { command: [type, ...rest].join(' ') || `denied ${id}` });
      await runHooks(hooks, event, payload, matcher);
      out(`SHELL-DENIED ${id}`);
      return;
    }
    if (cmd === 'permit') {
      const command = [id, type, ...rest].join(' ');
      await runHooks(hooks, 'PermissionRequest', { tool_name: toolName, tool_input: { command }, permission_suggestions: [], ...codexTurn }, toolName);
      out(`PERMIT ${command}`);
      return;
    }
    if (cmd === 'taskstop') {
      const child = tasks.get(`bg-${id}`);
      if (child) {
        child.silent = true;
        child.kill();
      }
      await runHooks(hooks, 'PostToolUse', { tool_name: 'TaskStop', tool_use_id: `stop-${id}`, tool_input: { task_id: `bg-${id}` }, tool_response: { message: `Successfully stopped task: bg-${id}` } }, 'TaskStop');
      out(`TASK-STOPPED ${id}`);
      return;
    }
    if (cmd === 'turn-end') {
      const listed = tool === 'claude' ? { background_tasks: [...tasks.keys()].map((task) => ({ id: task, type: 'shell', status: 'running', description: 'test', command: 'test' })), session_crons: [] } : {};
      await runHooks(hooks, 'Stop', { stop_hook_active: false, ...codexTurn, ...listed });
      out('TURN-ENDED');
      return;
    }
    if (cmd === 'interrupt') {
      await runHooks(hooks, 'Interrupt', codexTurn);
      out('INTERRUPTED');
      return;
    }
    if (cmd === 'session-end') {
      for (const child of running.values()) {
        child.silent = true;
        child.kill();
      }
      await runHooks(hooks, 'SessionEnd', { turn_id: '' });
      out('SESSION-ENDED');
      return;
    }
    if (cmd === 'prompt') {
      await sessionStart();
      if (tool === 'agy') {
        writeAgyTranscript(conversationId, { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>\nhi\n</USER_REQUEST>' });
        await runHooks(hooks, 'PreInvocation', { invocationNum: 0, initialNumSteps: 1 });
      }
      else await runHooks(hooks, 'UserPromptSubmit', { prompt: 'hi', ...(tool === 'codex' ? { turn_id: 'turn-1' } : {}) });
      out('PROMPT-DONE');
    } else if (cmd === 'subagent' || cmd === 'subagent-done') {
      const start = cmd === 'subagent';
      if (tool === 'agy') {
        // Antigravity CLI: a sub-agent is a conversation of its own, whose first step is its parent's message.
        const sub = { conversationId: id, modelName: 'gemini-3.6-flash-low' };
        await runHooks(hooks, 'PreInvocation', { ...sub, invocationNum: 0, initialNumSteps: 0 });
        writeAgyTranscript(id, { step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: `sender=${conversationId} content=${type}` });
        await runHooks(hooks, 'PreInvocation', { ...sub, invocationNum: 1, initialNumSteps: 3 });
      } else if (tool === 'grok') {
        await runHooks(hooks, start ? 'SubagentStart' : 'SubagentStop', { hookEventName: start ? 'subagent_start' : 'subagent_stop', subagentId: id, subagentType: type });
      } else {
        await runHooks(hooks, start ? 'SubagentStart' : 'SubagentStop', { agent_id: id, agent_type: type });
      }
      out(`${start ? 'SUBAGENT' : 'SUBAGENT-DONE'} ${id}`);
    } else if (cmd === 'subagent-killed') {
      // Claude Code's TaskStop on a sub-agent: a task notification as a prompt, and no SubagentStop.
      const prompt = `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_${id}</tool-use-id>\n<status>killed</status>\n<summary>Agent "${type}" was stopped by Claude</summary>\n</task-notification>`;
      await runHooks(hooks, 'UserPromptSubmit', { prompt });
      out(`SUBAGENT-KILLED ${id}`);
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
