// Translate Claude Code hook input into Agent Guild agent reports.
//
// Two hook styles are supported, so it works across Claude Code versions:
//   * SubagentStart / SubagentStop events (carry agent_id and agent_type)
//   * PreToolUse / PostToolUse for the sub-agent tool ("Task", or "Agent")
// Configure one style, not both, or each sub-agent appears twice.

import crypto from 'node:crypto';

const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

/** Map one Claude Code hook event to an agent report, or null to ignore it. */
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
  return null;
}

