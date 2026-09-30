// Translate a coding tool's hook event into Agent Guild reports.
//
// Claude Code, Codex CLI, Gemini CLI and Grok Build all run hook commands
// with one JSON event on stdin. They spell the event name and the sub-agent
// and model fields differently, so every spelling is accepted here.
//
// Sub-agents come from SubagentStart / SubagentStop, or from Claude Code's
// PreToolUse / PostToolUse on the sub-agent tool ("Agent", formerly "Task")
// for versions without the sub-agent events. A background launch returns
// immediately, so its PostToolUse says nothing about when the agent
// finishes; those launches are skipped. Configure one style, not both, or
// each sub-agent appears twice.

import path from 'node:path';
import crypto from 'node:crypto';

const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

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
  if (event === 'SubagentStart' || event === 'SubagentStop' || event === 'SubagentEnd') {
    const id = text(input.agent_id, input.agentId, input.subagent_id, input.subagentId);
    if (id) {
      reports.push({
        agentId: `hook-${id}`,
        name: text(input.agent_type, input.agentType, input.subagent_type, input.subagentType) || 'subagent',
        kind: 'subagent',
        status: event === 'SubagentStart' ? 'working' : 'done',
      });
    }
    return reports;
  }
  if ((event === 'PreToolUse' || event === 'PostToolUse') && SUBAGENT_TOOLS.has(text(input.tool_name, input.toolName))) {
    const toolInput = input.tool_input || input.toolInput || {};
    if (toolInput.run_in_background !== true) {
      // tool_use_id links the pre and post events; fall back to hashing the
      // identical tool_input both events carry.
      const key = text(input.tool_use_id, input.toolUseId) ||
        crypto.createHash('sha1').update(JSON.stringify(toolInput)).digest('hex').slice(0, 16);
      reports.push({
        agentId: `hook-task-${key}`,
        name: toolInput.subagent_type || 'subagent',
        kind: 'subagent',
        detail: toolInput.description || '',
        status: event === 'PreToolUse' ? 'working' : 'done',
      });
    }
  }
  const model = event === 'PostModelSwitch'
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
