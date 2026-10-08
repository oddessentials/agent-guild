# Reporting agents and the model

Session cards show the helper agents a tool runs and the model it uses. Tools
report these through hooks or the `agent-guild-report` command.

## Built-in tools

| Tool | Setup |
| --- | --- |
| Claude Code, Codex CLI, Grok Build | Automatic when the installed version can load hooks for one session. Otherwise the card says so; add the hooks yourself below. |
| Antigravity CLI | Turn on **Agent reporting** on its card. Reports the model, not helper agents. |
| Docker Agent | Automatic from 1.80.0. Reports from the first prompt: its agents (`transfer_task`, background agents, skills), shell commands in its approval modes, and turns. For the model, turn on **Model reporting** on its card (1.100.0 and later). Shell commands in autonomous mode (`--yolo`, `--safety autonomous`) show once they end, or as they start with the hook below. |

To add hooks yourself, merge the example into the tool's own hook settings.
Where those live is in each tool's hooks docs.

| Tool | Example | Hooks docs |
| --- | --- | --- |
| Claude Code | [claude-code-settings.json](../examples/claude-code-settings.json) | [docs](https://code.claude.com/docs/en/hooks) |
| Codex CLI | [codex-hooks.json](../examples/codex-hooks.json) | [docs](https://developers.openai.com/codex/hooks) |
| Grok Build | [grok-hooks.json](../examples/grok-hooks.json) | [docs](https://docs.x.ai/build/features/hooks) |
| Docker Agent | [docker-agent-hooks.yaml](../examples/docker-agent-hooks.yaml), as `~/.config/cagent/hooks.d/agent-guild-autonomous.yaml` | [docs](https://docker.github.io/docker-agent/configuration/hooks/) |

## Your own tool

Inside an Agent Guild terminal, `agent-guild-report` is on PATH. Outside one
it sends nothing.

```sh
agent-guild-report explore-1 --name Explorer --status working --detail "Reading src/"
agent-guild-report explore-1 --status done
agent-guild-report explore-1 --remove
agent-guild-report --model gpt-5-codex --display-name "GPT-5 Codex"
agent-guild-report --session <the tool's own session id>
```

| Option | Meaning |
| --- | --- |
| `<agent-id>` | Stable id; reports with the same id update one agent |
| `--name` | Label; its first letter shows on the icon |
| `--status` | `working` (default), `waiting`, `idle` or `done` |
| `--detail` | What the agent is doing |
| `--kind` | Free-form category |
| `--remove` | Remove the agent now |
| `--model`, `--display-name` | The model in use |
| `--session` | The tool's own session id. The card shows it, and uses it to resume the session after it ends. |
| `--hook` | Read a Claude Code, Codex CLI, Antigravity CLI, Grok Build or Docker Agent hook event from stdin |
| `--claude-statusline` | Use as Claude Code's status line command |

Report `working` before `done`; a `done` for an unknown agent is ignored.

### Without the command

Print an escape sequence; the terminal hides it:

```sh
printf '\033]7777;agent-guild;{"agentId":"w1","name":"Worker","status":"working"}\007'
printf '\033]7777;agent-guild;{"model":"grok-4","displayName":"Grok 4"}\007'
```

The JSON takes the same fields: `agentId`, `name`, `status`, `detail`, `kind`,
`remove`, `model`, `displayName`, `toolSessionId`.

### Session variables

| Variable | Value |
| --- | --- |
| `AGENT_GUILD_SESSION_ID` | The session id |
| `AGENT_GUILD_PROVIDER` | The tool's id, e.g. `anthropic` |
| `AGENT_GUILD_URL` | The manager's address |
| `AGENT_GUILD_REPORT_TOKEN` | A token that can only report for this session |

## Model without a report

If nothing reports the model, the card uses the tool's `--model` argument or a
name found on screen with the tool's `modelPattern`. A report always wins.
