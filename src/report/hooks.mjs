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
const TOOL_START_EVENTS = new Set(['PreToolUse', 'BeforeTool']);
const TOOL_END_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure', 'AfterTool']);
const TURN_BOUNDARY_EVENTS = new Set(['BeforeAgent', 'AfterAgent', 'UserPromptSubmit', 'Stop']);
const MAX_DETAIL = 200;

const text = (...values) => values.find((v) => typeof v === 'string' && v.trim())?.trim() ?? null;

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
  if ((TOOL_START_EVENTS.has(event) || TOOL_END_EVENTS.has(event)) && SUBAGENT_TOOLS.has(toolName)) {
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

  const model = insideSubagent ? null : event === 'PostModelSwitch'
    ? text(input.to_model)
    : text(input.model, input.modelId, input.llm_request?.model);
  if (model) reports.push({ model });
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
