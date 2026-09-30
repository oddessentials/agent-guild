# Reporting agents

A coding tool often starts helper agents inside one session. Agent Guild shows
each reported agent as a small icon on the session's card. Terminal output
alone cannot tell us reliably when an agent starts or stops, so the tool (or a
hook it runs) reports agents explicitly.

Every terminal the manager starts has these environment variables:

| Variable | Value |
| --- | --- |
| `AGENT_GUILD_SESSION_ID` | The session's id |
| `AGENT_GUILD_PROVIDER` | The provider id, for example `anthropic` |
| `AGENT_GUILD_URL` | The manager's base URL |
| `AGENT_GUILD_REPORT_TOKEN` | A token that can only report agents for this session |

There are three ways to report.

## 1. The `agent-guild-report` command

```sh
agent-guild-report explore-1 --name Explorer --status working --detail "Reading src/"
agent-guild-report explore-1 --status done
agent-guild-report explore-1 --remove
```

Outside an Agent Guild terminal the command does nothing and exits 0, so it is
safe to leave in hooks that also run elsewhere.

It is on PATH after `npm install -g .` or `npm link` in the Agent Guild
folder. Otherwise call it as `node <agent-guild>/bin/agent-guild-report.mjs`.

## 2. Claude Code hooks

`agent-guild-report --claude-hook` reads Claude Code's hook input from stdin.
Claude Code's `SubagentStart` and `SubagentStop` hook events fire when a
sub-agent starts and finishes, including sub-agents running in the
background. Each one then appears on the card for as long as it runs,
labelled with its agent type, for example `Explore` or `Plan`.

Add the hooks from [examples/claude-code-settings.json](../examples/claude-code-settings.json)
to `~/.claude/settings.json`, or to `.claude/settings.json` in one project:

```json
{
  "hooks": {
    "SubagentStart": [{ "hooks": [{ "type": "command", "command": "agent-guild-report --claude-hook" }] }],
    "SubagentStop":  [{ "hooks": [{ "type": "command", "command": "agent-guild-report --claude-hook" }] }]
  }
}
```

A `matcher` on these events filters by agent type. Leave it out to show
every sub-agent.

Older Claude Code versions without these events can use `PreToolUse` and
`PostToolUse` with `"matcher": "Agent|Task"` and the same command. That style
shows the task description, but skips sub-agents launched in the background,
because their tool call returns before they finish. Configure one style, not
both, or each sub-agent appears twice.

Hook names and payloads belong to Claude Code and can change. See the
[hooks reference](https://code.claude.com/docs/en/hooks) if agents stop
appearing.

## 3. In-band escape sequence

A process in the terminal can print an OSC escape sequence. The manager reads
it and the terminal does not display it.

```
ESC ] 7777 ; agent-guild ; <json> BEL
```

For example, from a shell:

```sh
printf '\033]7777;agent-guild;{"agentId":"w1","name":"Worker","status":"working"}\007'
```

This works without network access or extra tools, which suits wrapper scripts.

## Report fields

| Field | Required | Meaning |
| --- | --- | --- |
| `agentId` | yes | Stable id within the session. Reports with the same id update one agent. |
| `name` | no | Label shown on hover. Its first letter is shown in the icon. |
| `status` | no | `working` (default), `waiting`, `idle` or `done`. |
| `detail` | no | What the agent is doing. |
| `kind` | no | Free-form category, for example `subagent`. |
| `remove` | no | `true` removes the agent immediately. |

## Other providers

Codex CLI, Gemini CLI and Grok tools have no built-in integration yet. Any of
them can report through the command or the escape sequence from their own hook
or extension mechanism, where one exists.
