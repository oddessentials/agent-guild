// Translate a coding tool's hook event into Agent Guild reports.
//
// Claude Code, Codex CLI, Antigravity CLI, Grok Build and Docker Agent all
// run hook commands with one JSON event on stdin. They spell the event name
// and the sub-agent and model fields differently, so every spelling is
// accepted here.
//
// Sub-agents come from:
// - SubagentStart / SubagentStop (Claude Code, Codex CLI, Grok Build).
// - Claude Code's "Agent" tool (formerly "Task") on PreToolUse / PostToolUse
//   for versions without the sub-agent events. A launch marked as background
//   returns immediately, so its PostToolUse says nothing about when the
//   agent finishes; those launches are skipped. Configure one style, not
//   both, or each sub-agent appears twice.
// - Codex CLI ends every turn of a sub-agent with SubagentStop; a follow-up
//   turn of the same agent starts with a UserPromptSubmit inside it, or,
//   with Codex's multi_agent_v2 tools, straight with tool calls, which
//   report the agent as working again.
// - Grok Build skips SubagentStop for a cancelled sub-agent; the SessionEnd
//   of the sub-agent's own session then closes it, as does a StopCancelled
//   inside it (its turn limit, no progress or a declined permission).
// - Docker Agent's events are not translated here: each is sent whole to the
//   manager, which tells its sessions apart (src/manager/docker-sessions.mjs).
//
// Shell commands come from the Bash, PowerShell (Claude Code, Codex CLI) and
// run_terminal_command (Grok Build) tools; Claude Code's Monitor tool is a
// background watch reported as a monitor. A turn ends with Stop, with
// StopFailure (an API error, Claude Code and Grok Build), with StopCancelled
// (an interrupt or a declined permission, Grok Build) or with Interrupt and
// UserPromptSubmit (Codex CLI); the turn's foreground commands end with it.

import path from 'node:path';
import crypto from 'node:crypto';

const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'run_terminal_command', 'Monitor']);
const MONITOR_TOOLS = new Set(['Monitor']);
const TOOL_START_EVENTS = new Set(['PreToolUse']);
const TOOL_END_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure']);
const TURN_BOUNDARY_EVENTS = new Set(['UserPromptSubmit', 'Stop', 'StopFailure', 'Interrupt']);
const PERMISSION_EVENTS = new Set(['PermissionRequest', 'PermissionDenied']);
const MAX_DETAIL = 200;

const FINISHED_TASKS = new Set(['completed', 'failed', 'killed']);
const LIVE_TASKS = new Set(['pending', 'running', 'paused']);
// Claude Code and Grok Build list a turn's live background tasks by type; shell commands and monitors are drawn.
const TASK_KINDS = { shell: 'shell', monitor: 'monitor' };
const MAX_RUNNING_TASKS = 256;

const text = (...values) => values.find((v) => typeof v === 'string' && v.trim())?.trim() ?? null;

export function commandHash(command) {
  return crypto.createHash('sha256').update(command.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 32);
}

function shellReport(event, input, toolName, subagentId) {
  const toolInput = input.tool_input || input.toolInput || {};
  const id = text(input.tool_use_id, input.toolUseId);
  const agent = subagentId ? { agentId: `hook-${subagentId}` } : {};
  const match = typeof toolInput.command === 'string' ? { match: commandHash(toolInput.command) } : {};
  // Codex CLI (its events carry turn_id) keeps a command running past its turn, and reports no end for one it refused.
  const codex = Boolean(text(input.turn_id));
  if (event === 'PermissionRequest') return { shell: codex ? 'asked' : 'waiting', ...agent, ...match };
  if (!id) return null;
  const key = id.slice(0, 128);
  // Claude Code's auto mode denies a call after PreToolUse, and no PostToolUse or PostToolUseFailure follows.
  if (event === 'PermissionDenied') return { shell: 'end', key };
  if (TOOL_START_EVENTS.has(event)) return { shell: 'start', key, ...agent, ...match, ...(codex ? { persist: true } : {}) };
  const response = input.tool_response ?? input.toolResponse;
  // A Monitor call returns at once with the id of the watch it started.
  if (MONITOR_TOOLS.has(toolName)) {
    const watch = text(response?.taskId);
    return watch ? { shell: 'background', key, task: watch.slice(0, 128), kind: 'monitor' } : { shell: 'end', key };
  }
  const task = text(response?.backgroundTaskId);
  if (task) return { shell: 'background', key, task: task.slice(0, 128), ...(response.backgroundEndsWithFinalResponse === true ? { endsWithAgent: true } : {}) };
  return { shell: 'end', key };
}

// Claude Code reports a background task ending as a prompt of <task-notification> blocks.
function taskNotifications(prompt) {
  if (typeof prompt !== 'string' || !/^\s*<task-notification>/.test(prompt)) return null;
  return [...prompt.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)].map(([, body]) => {
    const tag = (name) => body.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1].trim() || null;
    return { taskId: tag('task-id'), toolUseId: tag('tool-use-id'), status: tag('status') };
  });
}

function runningShells(tasks) {
  const live = tasks.filter((task) => TASK_KINDS[task?.type] && !FINISHED_TASKS.has(task.status) && text(task.id));
  return { shell: 'running', tasks: live.slice(0, MAX_RUNNING_TASKS).map((task) => ({ id: task.id.trim().slice(0, 128), kind: TASK_KINDS[task.type] })) };
}

/** Claude Code's background_tasks, or Grok Build's backgroundTasks, when the event lists them. */
function backgroundTasks(input) {
  const tasks = input.background_tasks ?? input.backgroundTasks;
  return Array.isArray(tasks) ? tasks : null;
}

/** "subagent_start", "subagentStart" and "SubagentStart" all become "SubagentStart". */
export function normalizeEventName(raw) {
  return String(raw || '').replace(/(?:^|[_-])([a-z])/g, (_m, c) => c.toUpperCase());
}

function eventName(input) {
  return normalizeEventName(text(input.hook_event_name, input.hookEventName));
}

/**
 * The part of a Docker Agent hook event the manager needs, or null when the event names no session. The
 * shell tool's command (`tool_input.cmd`) comes along; tool output and messages stay behind.
 */
export function dockerHookEvent(input) {
  if (!input || typeof input !== 'object') return null;
  const sessionId = text(input.session_id);
  const event = eventName(input);
  if (!sessionId || !event) return null;
  const out = { event, sessionId };
  const agentName = text(input.agent_name);
  if (agentName) out.agentName = agentName;
  const toolName = text(input.tool_name);
  if (toolName) out.toolName = toolName;
  const toolUseId = text(input.tool_use_id);
  if (toolUseId) out.toolUseId = toolUseId;
  // The shell tool takes cmd; Docker Agent accepts command as well.
  const command = [input.tool_input?.cmd, input.tool_input?.command].find((value) => typeof value === 'string');
  if (command !== undefined) out.command = command;
  const model = text(input.model_id);
  if (model) out.model = model;
  return out;
}

/** Reports for one hook event: its sub-agents, shell commands, model and the tool's own session id. */
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
    const tasks = backgroundTasks(input);
    if (tasks) reports.push(runningShells(tasks));
    return reports;
  }

  if (event === 'UserPromptSubmit' && !text(input.turn_id)) {
    // Claude Code (turn_id is Codex's) fires this for a prompt typed while a turn runs, too, so it is no turn boundary.
    // It also brings each background task's end; a sub-agent's task id is its agent id, and one stopped with TaskStop
    // gets no SubagentStop.
    for (const { taskId, toolUseId, status } of taskNotifications(input.prompt) ?? []) {
      if (!taskId || LIVE_TASKS.has(status)) continue;
      reports.push({ shell: 'end', task: taskId.slice(0, 128), ...(toolUseId ? { key: toolUseId.slice(0, 128) } : {}) });
      if (FINISHED_TASKS.has(status)) reports.push({ agentId: `hook-${taskId}`, status: 'done' });
    }
    return reports;
  }

  if (event === 'SessionEnd' || event === 'StopCancelled') {
    // Grok Build: the end (or cancelled turn) of a sub-agent's own session
    // carries its type, and its session id is the sub-agent id. The main
    // session's events carry no type: its end ends every command, and its
    // cancelled turn (an interrupt, a declined permission, the turn limit)
    // ends the turn's foreground commands like Stop would.
    const childType = text(input.subagent_type, input.subagentType);
    const childId = text(input.session_id, input.sessionId);
    if (childType && childId) reports.push({ agentId: `hook-${childId}`, name: childType, kind: 'subagent', status: 'done' });
    else if (!childType) reports.push(event === 'SessionEnd' ? { shell: 'reset' } : { finishForeground: true });
    return reports;
  }

  const toolName = text(input.tool_name, input.toolName);
  const toolEvent = TOOL_START_EVENTS.has(event) || TOOL_END_EVENTS.has(event);
  const shell = (toolEvent || PERMISSION_EVENTS.has(event)) && SHELL_TOOLS.has(toolName) ? shellReport(event, input, toolName, subagentId) : null;
  if (shell) reports.push(shell);
  if (event === 'PostToolUse' && toolName === 'TaskStop') {
    const toolInput = input.tool_input || input.toolInput || {};
    const task = text(toolInput.task_id, toolInput.shell_id);
    if (task) reports.push({ shell: 'end', task: task.slice(0, 128) }, { agentId: `hook-${task}`, status: 'done' });
  }
  if (toolEvent && SUBAGENT_TOOLS.has(toolName)) {
    const toolInput = input.tool_input || input.toolInput || {};
    const key = text(input.tool_use_id, input.toolUseId);
    if (key && toolInput.run_in_background !== true) {
      reports.push({
        agentId: `hook-task-${key}`,
        name: text(toolInput.subagent_type, toolInput.agent_name) || 'subagent',
        kind: 'subagent',
        detail: (text(toolInput.description, toolInput.prompt) || '').slice(0, MAX_DETAIL),
        status: TOOL_START_EVENTS.has(event) ? 'working' : 'done',
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

  const tasks = event === 'Stop' ? backgroundTasks(input) : null;
  if (tasks) reports.push(runningShells(tasks));
  if (!insideSubagent && TURN_BOUNDARY_EVENTS.has(event)) reports.push({ finishForeground: true });

  const model = insideSubagent || toolEvent || PERMISSION_EVENTS.has(event) ? null : event === 'PostModelSwitch'
    ? text(input.to_model)
    : text(input.model, input.modelId, input.modelName, input.model_id);
  if (model) reports.push({ model });

  if (!insideSubagent && event === 'SessionStart') reports.push({ hello: true });

  const toolSessionId = insideSubagent ? null : text(input.session_id, input.sessionId, input.conversationId);
  if (toolSessionId && (event === 'SessionStart' || event === 'PreInvocation')) reports.push({ toolSessionId });
  return reports;
}

/** Whether an Antigravity CLI conversation starts with the user's own request; a sub-agent's starts with its parent's message. */
export function antigravityUserConversation(firstRecord) {
  return firstRecord?.type === 'USER_INPUT' && firstRecord.source === 'USER_EXPLICIT';
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
