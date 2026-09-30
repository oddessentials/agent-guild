// Translate Claude Code hook and status-line input into Agent Guild reports.
//
// Sub-agents come from two hook styles:
//   * SubagentStart / SubagentStop (recommended). These fire when a
//     sub-agent really starts and stops, including background sub-agents,
//     and carry agent_id and agent_type.
//   * PreToolUse / PostToolUse on the sub-agent tool ("Agent", formerly
//     "Task"), for Claude Code versions without the sub-agent events. A
//     background launch returns immediately, so its PostToolUse says
//     nothing about when the agent finishes; those launches are skipped.
// Configure one style, not both, or each sub-agent appears twice.
//
// The model comes from SessionStart (when Claude Code includes it),
// PostModelSwitch, and the status line, which carries the model id and
// display name on every update.

import path from 'node:path';
import crypto from 'node:crypto';

const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

/**
 * Map one Claude Code hook event to a report, or null to ignore it. An
 * agent report has agentId; a model report has model.
 */
export function claudeHookToReport(input) {
  if (!input || typeof input !== 'object') return null;
  const event = input.hook_event_name;
  if (event === 'SubagentStart' || event === 'SubagentStop') {
    if (!input.agent_id) return null;
    return {
      agentId: `claude-${input.agent_id}`,
      name: input.agent_type || 'subagent',
      kind: 'subagent',
      status: event === 'SubagentStart' ? 'working' : 'done',
    };
  }
  if ((event === 'PreToolUse' || event === 'PostToolUse') && SUBAGENT_TOOLS.has(input.tool_name)) {
    const toolInput = input.tool_input || {};
    if (toolInput.run_in_background === true) return null;
    // tool_use_id links the pre and post events; fall back to hashing the
    // identical tool_input both events carry.
    const key = input.tool_use_id ||
      crypto.createHash('sha1').update(JSON.stringify(toolInput)).digest('hex').slice(0, 16);
    return {
      agentId: `claude-task-${key}`,
      name: toolInput.subagent_type || 'subagent',
      kind: 'subagent',
      detail: toolInput.description || '',
      status: event === 'PreToolUse' ? 'working' : 'done',
    };
  }
  const model = event === 'SessionStart' ? input.model : event === 'PostModelSwitch' ? input.to_model : undefined;
  if (typeof model === 'string' && model.trim()) return { model: model.trim() };
  return null;
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
