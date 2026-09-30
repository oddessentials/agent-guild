# Reporting agents and the model

A coding tool often starts helper agents inside one session. Agent Guild shows
each reported agent as a small icon on the session's card. Terminal output
alone cannot tell us reliably when an agent starts or stops, so the tool (or a
hook it runs) reports agents explicitly. The same channels report the main
model the tool is using, which the card shows next to the session's status.

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
agent-guild-report --model gpt-5-codex
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

The same command on the `SessionStart` and `PostModelSwitch` events reports
the model, and as the status line command it reports the model id and
display name on every update:

```json
{ "statusLine": { "type": "command", "command": "agent-guild-report --claude-statusline" } }
```

It prints a short status line (model, folder, context use). To keep your own
status line script, pipe through it: `agent-guild-report --claude-statusline
--passthrough | ~/.claude/statusline.sh`.

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
printf '\033]7777;agent-guild;{"model":"grok-4","displayName":"Grok 4"}\007'
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

## Model without a report

When nothing reports the model, the manager looks for a model name on the
terminal screen using the provider's `modelPattern` (a regular expression;
the built-in providers match names like `claude-opus-4-5`, `gpt-5-codex`,
`gemini-2.5-pro` and `grok-4`), and before that uses a `--model` argument.
A screen match is a guess: the card marks where the name came from, and a
report always wins.

## Other providers

Codex CLI, Gemini CLI and Grok tools have no built-in integration yet. Any of
them can report through the command or the escape sequence from their own hook
or extension mechanism, where one exists.
