// Translate a coding tool's hook event into Agent Guild reports.
//
// Claude Code, Codex CLI, Gemini CLI and Grok Build all run hook commands
// with one JSON event on stdin. They spell the event name and the sub-agent
// and model fields differently, so every spelling is accepted here.
//
// Sub-agents come from:
// - SubagentStart / SubagentStop (Claude Code, Codex CLI, Grok Build).
// - A tool call that runs a sub-agent: Gemini CLI's `invoke_agent`
//   (BeforeTool / AfterTool), which returns when the agent is finished, and
//   Claude Code's "Agent" tool (formerly "Task") on PreToolUse / PostToolUse
//   for versions without the sub-agent events. A launch marked as background
//   returns immediately, so its PostToolUse says nothing about when the
//   agent finishes; those launches are skipped. Configure one style, not
//   both, or each sub-agent appears twice. Gemini's call is a foreground
//   agent: the parent waits for it, and when its end event never comes (a
//   cancelled or denied call) it is closed at the next turn boundary of the
//   main session.
// - Codex CLI ends every turn of a sub-agent with SubagentStop; a follow-up
//   turn of the same agent starts with a UserPromptSubmit inside it, or,
//   with Codex's multi_agent_v2 tools, straight with tool calls, which
//   report the agent as working again.
// - Grok Build skips SubagentStop for a cancelled sub-agent; the SessionEnd
//   of the sub-agent's own session then closes it, as does a StopCancelled
//   inside it (its turn limit, no progress or a declined permission).

import path from 'node:path';
import crypto from 'node:crypto';

const SUBAGENT_TOOLS = new Set(['Task', 'Agent', 'invoke_agent']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'run_shell_command', 'run_terminal_command']);
const TOOL_START_EVENTS = new Set(['PreToolUse', 'BeforeTool']);
const TOOL_END_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure', 'AfterTool']);
const TURN_BOUNDARY_EVENTS = new Set(['BeforeAgent', 'AfterAgent', 'UserPromptSubmit', 'Stop', 'Interrupt']);
const MAX_DETAIL = 200;

const text = (...values) => values.find((v) => typeof v === 'string' && v.trim())?.trim() ?? null;

export function normalCommand(command) {
  return String(command).replace(/[\u0000-\u001f\u007f?\s]+/g, ' ').trim();
}

export function commandHash(command) {
  return crypto.createHash('sha256').update(normalCommand(command)).digest('hex').slice(0, 32);
}

// Every Claude Code Bash command runs in a shell of the same form, and every PowerShell command on Windows in a
// launcher that carries no command text: one of these finds the command when nothing else does and only one could be it.
export const CLAUDE_BASH_MARK = commandHash('agent-guild:claude-code-bash');
export const CLAUDE_POWERSHELL_MARK = commandHash('agent-guild:claude-code-powershell');

const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'case', 'esac', 'while', 'until', 'for', 'select', '!', '{', '}', '[[', 'function', 'time', 'coproc']);
const ASSIGNMENT = /^[A-Za-z_]\w*=/;

// bash and zsh replace themselves with the last simple command of a -c script, leaving its words as the process's argv.
export function execHash(command) {
  const words = lastSimpleCommand(command);
  const argv = words && execArgv(words);
  return argv ? commandHash(argv.join(' ')) : null;
}

// The index just past the double-quoted string opening at i, or -1 when it never closes.
function skipDoubleQuoted(command, i) {
  for (let j = i + 1; j < command.length; j++) {
    const c = command[j];
    if (c === '\\') j++;
    else if (c === '"') return j + 1;
    else if (c === '`' || (c === '$' && '({'.includes(command[j + 1]))) {
      const end = skipExpansion(command, j);
      if (end === -1) return -1;
      j = end - 1;
    }
  }
  return -1;
}

// The index just past the $(...), ${...}, (...) or `...` opening at i, or -1 when it never closes.
function skipExpansion(command, i) {
  if (command[i] === '`') {
    for (let j = i + 1; j < command.length; j++) {
      if (command[j] === '\\') j++;
      else if (command[j] === '`') return j + 1;
    }
    return -1;
  }
  const from = command[i] === '$' ? i + 1 : i;
  const open = command[from];
  const close = open === '(' ? ')' : '}';
  let depth = 0;
  for (let j = from; j < command.length; j++) {
    const c = command[j];
    if (c === '\\') {
      j++;
    } else if (c === "'") {
      j = command.indexOf("'", j + 1);
      if (j === -1) return -1;
    } else if (c === '"' || c === '`' || (c === '$' && '({'.includes(command[j + 1]))) {
      const end = c === '"' ? skipDoubleQuoted(command, j) : skipExpansion(command, j);
      if (end === -1) return -1;
      j = end - 1;
    } else if (c === open) {
      depth++;
    } else if (c === close && --depth === 0) {
      return j + 1;
    }
  }
  return -1;
}

// The here-document delimiter after << at i: { delimiter, stripTabs, end }, or null when there is none.
function hereDocument(command, i) {
  let j = i + 2;
  const stripTabs = command[j] === '-';
  if (stripTabs) j++;
  while (command[j] === ' ' || command[j] === '\t') j++;
  let delimiter = '';
  while (j < command.length && !/[\s;&|<>()]/.test(command[j])) {
    const c = command[j];
    if (c === "'" || c === '"') {
      const end = command.indexOf(c, j + 1);
      if (end === -1) return null;
      delimiter += command.slice(j + 1, end);
      j = end + 1;
    } else if (c === '\\') {
      delimiter += command[j + 1] ?? '';
      j += 2;
    } else {
      delimiter += c;
      j++;
    }
  }
  return delimiter ? { delimiter, stripTabs, end: j } : null;
}

// Each part of the command is read on its own, so an expansion, subshell or here-document only hides the part it is in.
function lastSimpleCommand(command) {
  const segments = [{ words: [], after: null, opaque: false }];
  const hereDocuments = [];
  let word = null;
  let quoted = false;
  let target = false;
  const opaque = () => { segments.at(-1).opaque = true; };
  const push = () => {
    if (word !== null && !target) segments.at(-1).words.push(word);
    if (word !== null) target = false;
    word = null;
    quoted = false;
  };
  for (let i = 0; i < command.length;) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return null;
      word = (word ?? '') + command.slice(i + 1, end);
      quoted = true;
      i = end + 1;
    } else if (c === '"') {
      let part = '';
      for (i++; i < command.length && command[i] !== '"'; i++) {
        if (command[i] === '\\' && command[i + 1] === '\n') {
          i++;
          continue;
        }
        if (command[i] === '\\' && '"\\$`'.includes(command[i + 1])) {
          part += command[++i];
          continue;
        }
        if (command[i] === '`' || (command[i] === '$' && '({'.includes(command[i + 1]))) {
          const end = skipExpansion(command, i);
          if (end === -1) return null;
          opaque();
          part += command.slice(i, end);
          i = end - 1;
          continue;
        }
        if (command[i] === '$') opaque();
        part += command[i];
      }
      if (i >= command.length) return null;
      word = (word ?? '') + part;
      quoted = true;
      i++;
    } else if (c === '\\') {
      if (command[i + 1] !== '\n') {
        word = (word ?? '') + (command[i + 1] ?? '');
        quoted = true;
      }
      i += 2;
    } else if (c === '#' && word === null) {
      while (i < command.length && command[i] !== '\n') i++;
    } else if ('<>'.includes(c) || (c === '&' && command[i + 1] === '>')) {
      if (command.startsWith('<<', i) && command[i + 2] !== '<') {
        const here = hereDocument(command, i);
        if (!here) return null;
        if (word !== null && (quoted || !/^\d+$/.test(word))) push();
        word = null;
        quoted = false;
        hereDocuments.push(here);
        opaque();
        i = here.end;
        continue;
      }
      if (word !== null && (quoted || !/^\d+$/.test(word))) push();
      word = null;
      quoted = false;
      while ('<>&|'.includes(command[i])) i++;
      target = true;
    } else if (';&|\n'.includes(c)) {
      push();
      const op = command[i + 1] === c && c !== '\n' && c !== ';' ? c + c : c;
      segments.at(-1).after = op;
      segments.push({ words: [], after: null, opaque: false });
      i += op.length;
      if (c === '\n' && hereDocuments.length) {
        // The lines after the one that opened them are the documents' bodies, not commands.
        for (const { delimiter, stripTabs } of hereDocuments.splice(0)) {
          for (;;) {
            if (i >= command.length) return null;
            const eol = command.indexOf('\n', i);
            const line = command.slice(i, eol === -1 ? command.length : eol);
            i = eol === -1 ? command.length : eol + 1;
            if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) break;
          }
        }
      }
    } else if (/\s/.test(c)) {
      push();
      i++;
    } else if (c === '`' || c === '(' || (c === '$' && '({'.includes(command[i + 1]))) {
      const end = skipExpansion(command, i);
      if (end === -1) return null;
      opaque();
      word = (word ?? '') + command.slice(i, end);
      i = end;
    } else if (c === '$' && command[i + 1] === "'") {
      let j = i + 2;
      while (j < command.length && command[j] !== "'") j += command[j] === '\\' ? 2 : 1;
      if (j >= command.length) return null;
      opaque();
      word = (word ?? '') + command.slice(i, j + 1);
      i = j + 1;
    } else if (c === ')') {
      return null;
    } else if ('${}'.includes(c)) {
      opaque();
      word = (word ?? '') + c;
      i++;
    } else if ('*?[~'.includes(c)) {
      segments.at(-1).opaque = true;
      word = (word ?? '') + c;
      i++;
    } else {
      word = (word ?? '') + c;
      i++;
    }
  }
  push();
  if (hereDocuments.length) return null;
  const index = segments.findLastIndex((s) => s.words.length > 0);
  if (index === -1) return null;
  const last = segments[index];
  if (last.opaque || last.after === '&' || last.after === '|' || segments[index - 1]?.after === '|') return null;
  return last.words;
}

function execArgv(words) {
  let start = 0;
  while (start < words.length - 1 && ASSIGNMENT.test(words[start])) start++;
  const [first, ...rest] = words.slice(start);
  if (first === undefined || SHELL_KEYWORDS.has(first)) return null;
  if (rest.length === 0) return [first];
  switch (first) {
    case 'builtin':
    case 'noglob':
    case 'nohup':
      return execArgv(rest);
    case 'command':
      if (/^-[vV]$/.test(rest[0])) return [first, ...rest];
      return execArgv(rest[0] === '-p' ? rest.slice(1) : rest);
    case 'nice':
      if (rest[0] === '-n' && rest.length > 2) return execArgv(rest.slice(2));
      return execArgv(/^(?:-n?-?\d+|--adjustment=-?\d+)$/.test(rest[0]) ? rest.slice(1) : rest);
    case 'env':
      return envArgv(rest);
    case 'exec':
      return execBuiltinArgv(rest);
    default:
      return [first, ...rest];
  }
}

function envArgv(words) {
  let i = 0;
  while (i < words.length - 1 && words[i].startsWith('-')) {
    const option = words[i++];
    if (option === '--') break;
    if (option === '-S') return null;
    if (option === '-u' || option === '-C') i++;
    else if (!/^(?:-i|-0|--ignore-environment|--unset=.*|-u.+)$/.test(option)) return null;
  }
  return execArgv(words.slice(i));
}

function execBuiltinArgv(words) {
  let name = null;
  let login = false;
  let i = 0;
  while (i < words.length - 1 && words[i].startsWith('-')) {
    const option = words[i++];
    if (option === '--') break;
    if (option === '-a') name = words[i++];
    else if (/^-[cl]+$/.test(option)) login ||= option.includes('l');
    else return null;
  }
  const program = words.slice(i);
  if (program.length === 0 || (login && name !== null)) return null;
  if (name === null && !login) return execArgv(program);
  if (['env', 'nohup', 'nice'].includes(program[0])) return execArgv(program);
  if (['builtin', 'noglob', 'command', 'exec'].includes(program[0])) return null;
  const argv = execArgv(program);
  return argv && [name ?? `-${argv[0]}`, ...argv.slice(1)];
}

function geminiBackgroundPid(response) {
  const content = response?.llmContent;
  const body = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('\n') : '';
  const match = body.match(/Command is running in background\. PID: (\d+)/) || body.match(/moved to background \(PID: (\d+)\)/);
  return match ? Number(match[1]) : null;
}

function shellReport(event, input, subagentId, toolName) {
  const toolInput = input.tool_input || input.toolInput || {};
  const id = text(input.tool_use_id, input.toolUseId);
  const ref = id ? { key: id.slice(0, 128) } : { bucket: crypto.createHash('sha256').update(JSON.stringify(toolInput)).digest('hex').slice(0, 32) };
  const command = typeof toolInput.command === 'string' ? toolInput.command : null;
  // Claude Code's Bash and PowerShell tools; Codex CLI's Bash carries a turn_id.
  const claude = !text(input.turn_id) && (toolName === 'Bash' || toolName === 'PowerShell');
  const hashes = {};
  if (command) {
    hashes.match = commandHash(command);
    const exec = toolName === 'PowerShell' ? null : execHash(command);
    if (exec && exec !== hashes.match) hashes.exec = exec;
    if (claude) hashes.mark = toolName === 'PowerShell' ? CLAUDE_POWERSHELL_MARK : CLAUDE_BASH_MARK;
  }
  if (TOOL_START_EVENTS.has(event) || event === 'PermissionRequest') {
    const report = { shell: event === 'PermissionRequest' ? 'waiting' : 'start', ...ref };
    if (subagentId) report.agentId = `hook-${subagentId}`;
    if (text(input.turn_id)) report.track = true;
    // Claude Code reports nothing when Esc ends a command, so its process is followed once it is shown.
    if (claude && id && event !== 'PermissionRequest') report.follow = true;
    return { ...report, ...hashes };
  }
  if (event === 'PostToolUse' || event === 'AfterTool') {
    const response = input.tool_response ?? input.toolResponse;
    if (response && typeof response === 'object' && text(response.backgroundTaskId)) return { shell: 'background', ...ref, ...hashes };
    const pid = geminiBackgroundPid(response);
    if (pid) return { shell: 'background', ...ref, pid };
  }
  return { shell: 'end', ...ref };
}

// Claude Code reports a background task ending as a prompt of <task-notification> blocks.
function taskNotifications(prompt) {
  if (typeof prompt !== 'string' || !/^\s*<task-notification>/.test(prompt)) return null;
  return [...prompt.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)].map(([, body]) => {
    const tag = (name) => body.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1].trim() || null;
    return { taskId: tag('task-id'), status: tag('status') };
  });
}

/** "subagent_start", "subagentStart" and "SubagentStart" all become "SubagentStart". */
function eventName(input) {
  const raw = text(input.hook_event_name, input.hookEventName) || '';
  return raw.replace(/(?:^|[_-])([a-z])/g, (_m, c) => c.toUpperCase());
}

/**
 * Reports for one hook event: an agent report (has agentId) when a
 * sub-agent starts or stops, and a model report (has model) when the event
 * names the main model. Empty for events that carry neither.
 */
export function hookToReports(input) {
  if (!input || typeof input !== 'object') return [];
  const event = eventName(input);
  const reports = [];
  // Claude Code and Codex CLI name the sub-agent an event belongs to by
  // agent_id; Grok Build by subagentId on its own events and by subagentType
  // on events fired inside the sub-agent.
  const subagentId = text(input.agent_id, input.agentId, input.subagent_id, input.subagentId);
  const subagentType = text(input.agent_type, input.agentType, input.subagent_type, input.subagentType);

  if (event === 'SubagentStart' || event === 'SubagentStop' || event === 'SubagentEnd') {
    if (subagentId) {
      const report = {
        agentId: `hook-${subagentId}`,
        name: subagentType || 'subagent',
        kind: 'subagent',
        status: event === 'SubagentStart' ? 'working' : 'done',
      };
      // Grok Build sends the task description with SubagentStart.
      const detail = text(input.description);
      if (detail) report.detail = detail.slice(0, MAX_DETAIL);
      reports.push(report);
    }
    return reports;
  }

  if (event === 'UserPromptSubmit' && !text(input.turn_id)) {
    // Claude Code (turn_id is Codex's) fires this for a prompt typed while a turn runs, too, so it is no turn boundary.
    // It also brings each background task's end; a sub-agent stopped with TaskStop gets no SubagentStop, only this,
    // and its task id is its agent id.
    for (const { taskId, status } of taskNotifications(input.prompt) ?? []) {
      if (taskId && ['completed', 'failed', 'killed'].includes(status)) reports.push({ agentId: `hook-${taskId}`, status: 'done' });
    }
    return reports;
  }

  if (event === 'SessionEnd' || event === 'StopCancelled') {
    // Grok Build: the end (or cancelled turn) of a sub-agent's own session
    // carries its type, and its session id is the sub-agent id. The main
    // session's events carry no type.
    const childType = text(input.subagent_type, input.subagentType);
    const childId = text(input.session_id, input.sessionId);
    if (childType && childId) reports.push({ agentId: `hook-${childId}`, name: childType, kind: 'subagent', status: 'done' });
    return reports;
  }

  const toolName = text(input.tool_name, input.toolName);
  const toolEvent = TOOL_START_EVENTS.has(event) || TOOL_END_EVENTS.has(event);
  const permissionWait = event === 'PermissionRequest' && toolName !== 'PowerShell';
  if ((toolEvent || permissionWait) && SHELL_TOOLS.has(toolName)) reports.push(shellReport(event, input, subagentId, toolName));
  if (toolEvent && SUBAGENT_TOOLS.has(toolName)) {
    const toolInput = input.tool_input || input.toolInput || {};
    if (toolInput.run_in_background !== true) {
      // tool_use_id links the start and end events; fall back to hashing the
      // identical tool_input both events carry (Gemini CLI sends no id).
      const key = text(input.tool_use_id, input.toolUseId) ||
        crypto.createHash('sha1').update(JSON.stringify(toolInput)).digest('hex').slice(0, 16);
      reports.push({
        agentId: `hook-task-${key}`,
        name: text(toolInput.subagent_type, toolInput.agent_name) || 'subagent',
        kind: 'subagent',
        detail: (text(toolInput.description, toolInput.prompt) || '').slice(0, MAX_DETAIL),
        status: TOOL_START_EVENTS.has(event) ? 'working' : 'done',
        // Gemini CLI's call returns when the agent is finished, so the
        // parent waits: a model reported meanwhile is the sub-agent's.
        foreground: toolName === 'invoke_agent',
      });
    }
  }

  // Codex CLI: SubagentStop ended the previous turn of this agent; a new
  // prompt inside it, or a tool call of a turn inside it (turn_id is Codex's
  // own field, so Claude Code's internal helpers stay out), means the agent
  // works again.
  if (subagentId && (event === 'UserPromptSubmit' || (text(input.turn_id) && (event === 'PreToolUse' || event === 'PostToolUse')))) {
    reports.push({ agentId: `hook-${subagentId}`, name: subagentType || 'subagent', kind: 'subagent', status: 'working' });
  }

  // A hook that runs inside a sub-agent names it (Claude Code and Codex by
  // agent_id, Grok Build by subagentType); its model is not the session's.
  const insideSubagent = Boolean(subagentId || text(input.subagent_type, input.subagentType));

  // Gemini CLI skips AfterTool for an invoke_agent call that was cancelled
  // or denied. A turn boundary of the main session (BeforeAgent and
  // AfterAgent in Gemini CLI; a main-thread prompt or Stop elsewhere) cannot
  // happen while the parent waits for a foreground agent, so one still
  // working then has been orphaned.
  if (!insideSubagent && TURN_BOUNDARY_EVENTS.has(event)) reports.push({ finishForeground: true });

  const model = insideSubagent || toolEvent ? null : event === 'PostModelSwitch'
    ? text(input.to_model)
    : text(input.model, input.modelId, input.llm_request?.model);
  if (model) reports.push({ model });

  if (!insideSubagent && event === 'SessionStart') reports.push({ hello: true });

  const toolSessionId = insideSubagent ? null : text(input.session_id, input.sessionId);
  if (toolSessionId && (event === 'SessionStart' || event === 'BeforeAgent')) reports.push({ toolSessionId });
  return reports;
}

/** Model report from the JSON Claude Code feeds to a status line command. */
export function claudeStatuslineToReport(input) {
  const id = input?.model?.id;
  if (typeof id !== 'string' || !id.trim()) return null;
  const displayName = typeof input.model.display_name === 'string' ? input.model.display_name.trim() : '';
  return { model: id.trim(), displayName: displayName || null };
}

/** A short status line: model, folder and context use, like Claude Code's own examples. */
export function formatStatusLine(input) {
  const parts = [];
  const model = input?.model?.display_name || input?.model?.id;
  if (model) parts.push(`[${model}]`);
  const dir = input?.workspace?.current_dir || input?.cwd;
  if (dir) parts.push(path.basename(dir) || dir);
  const used = input?.context_window?.used_percentage;
  if (typeof used === 'number') parts.push(`${Math.round(used)}% context`);
  return parts.join(' | ');
}
