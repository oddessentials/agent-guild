# Agent Guild for agents (MCP)

`agent-guild mcp` serves the [Model Context Protocol](https://modelcontextprotocol.io)
on stdin and stdout. A coding agent that speaks MCP, such as Claude Code,
Codex CLI, Antigravity CLI, Gemini CLI, Cursor or VS Code, can then list the
sessions in this computer's Agent Guild, read their last replies and
terminals, and start or stop sessions with the person's approval.

It talks to the manager through its [local API](api.md), as the launcher
does, and finds it the same way. Start Agent Guild first; the tools say so
when it is not running.

## Add it

With Agent Guild installed (`npm install -g @oddessentials/agent-guild`):

| Agent | Command |
| --- | --- |
| Claude Code | `claude mcp add -s user agent-guild -- agent-guild mcp` |
| Codex CLI | `codex mcp add agent-guild -- agent-guild mcp` |
| Antigravity CLI | `agy mcp add agent-guild agent-guild mcp` |
| Gemini CLI | `gemini mcp add -s user agent-guild agent-guild mcp` |
| VS Code | `code --add-mcp '{"name":"agent-guild","type":"stdio","command":"agent-guild","args":["mcp"]}'` |

For one VS Code workspace, `.vscode/mcp.json`:

```json
{ "servers": { "agent-guild": { "type": "stdio", "command": "agent-guild", "args": ["mcp"] } } }
```

Cursor, Windsurf and other editors that take an `mcpServers` config:

```json
{ "mcpServers": { "agent-guild": { "command": "agent-guild", "args": ["mcp"] } } }
```

Without a global install, use `npx -y @oddessentials/agent-guild@latest mcp`
as the command.

### As a plugin

This repository is also a plugin with the MCP server and the
[`setup-agent-guild`](../plugins/agent-guild/skills/setup-agent-guild/SKILL.md)
skill, which installs, starts and checks Agent Guild for the person:

* Claude Code: `claude plugin marketplace add oddessentials/agent-guild --sparse .claude-plugin plugins`,
  then `claude plugin install agent-guild@agent-guild`.

## Tools

| Tool | What it does |
| --- | --- |
| `guild_status` | Whether Agent Guild is running, its version, its session counts and which tools are installed. |
| `list_sessions` | Every session: id, tool, folder, status, whether it is working, whether it waits for permission, its turn, model, sub-agents, and whether and when it has a reply. |
| `read_reply` | The whole answer that ended a session's last turn, as Markdown. |
| `read_screen` | What a session's terminal shows now, as plain text. |
| `start_session` | Starts a session of a tool (`claude`, `codex`, `antigravity`, `grok`, `docker`, `shell` or a provider id) in a folder. |
| `stop_session` | Ends a session's process; it stays listed with its final screen. |
| `send_input` | Types into a session's terminal. Only with `agent-guild mcp --allow-input`. |

The read tools are marked read-only, and `stop_session` and `send_input`
destructive, so an agent asks before using them unless the person allows
them.

## Safety

* Nothing the server returns contains the API token or the page link, which
  give full control of every session.
* `start_session` takes no launch flags, so an agent cannot add one such as
  `--dangerously-skip-permissions`. The person chooses those on the card.
* Typing into a terminal is off unless the person adds `--allow-input`.
* Like any client of the API, the server can reach only a manager on this
  computer, through the token in the per-user data folder.

## Publishing to the MCP Registry

Each release publishes `server.json` to the Registry once it can sign in by
[DNS](https://github.com/modelcontextprotocol/registry/blob/v1.8.1/docs/modelcontextprotocol-io/authentication.mdx#dns-authentication):
a `v=MCPv1` TXT record on `oddessentials.ai`, and its Ed25519 private key
(hex) in the `MCP_PRIVATE_KEY` Actions secret.
