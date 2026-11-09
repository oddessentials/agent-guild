# Agent Guild for agents (MCP)

`agent-guild mcp` serves the [Model Context Protocol](https://modelcontextprotocol.io)
on stdin and stdout. A coding agent that speaks MCP, such as Claude Code,
Codex CLI, Antigravity CLI, Gemini CLI, Cursor or VS Code, can then list the
sessions in this computer's Agent Guild, read their replies and
terminals, start or stop sessions with the person's approval, and launch
fireworks over the Yard.

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
| `list_sessions` | Every session: id, tool, folder, status, `working`, model, sub-agents, `hasReply`, `replyId`, `replyCursor` and `inputInstance`. |
| `read_reply` | The whole answer that ended a session's last turn, as Markdown. |
| `read_replies` | Retained answers in order: `{ replies: [{ id, text, cursor }], nextCursor, hasMore, gap, firstCursor }`. Takes `session_id`, optional `after` cursor and `limit` (default 20, maximum 100). |
| `read_screen` | What a session's terminal shows now, as plain text. |
| `start_session` | Starts a session of a tool (`claude`, `codex`, `antigravity`, `grok`, `docker`, `shell` or a provider id) in a folder. |
| `stop_session` | Ends a session's process; it stays listed with its final screen. |
| `fireworks` | Launches fireworks over the Yard on every open page, and says how many pages saw them. |
| `send_input` | Types into a session's terminal. Takes `session_id`, `text`, optional `submit` (default true) and `idempotency_key`. Only with `agent-guild mcp --allow-input`. |

The read tools are marked read-only, and `stop_session` and `send_input`
destructive, so an agent asks before using them unless the person allows
them.

Each reader saves its own cursor after handling an answer and passes it as
`after` on the next `read_replies` call. Reads never consume answers. Check
`gap`: `evicted` means requested history was dropped; `reset` means the session
instance changed; null means no gap. Both gaps return the oldest available
answers. `firstCursor` names the oldest retained answer, or is null.
`nextCursor` is the last returned position and `hasMore` indicates more
answers at read time. The [API](api.md#reply-history) retains 100 answers / 16 MiB
in memory, always keeping the newest answer whole. Empty turns clear
`read_reply` and `hasReply` without clearing history or advancing `replyCursor`.

Even with `--allow-input`, an agent must not send an approval response on a
general instruction to unblock workers or on what a screen read shows.
Sending an approval response requires the person's explicit request for that
response in that session.

### Retrying terminal input

To use retry protection, form `idempotency_key` from `inputInstance` in
`list_sessions`, a colon, and a unique caller-chosen ID of 1–128 ASCII letters,
digits, underscores or hyphens. Save it before sending. Retry with the same
full key, text and Enter behavior; a new key is a new request.

Keyed calls return `{ idempotency_key, outcome, code? }`. `accepted` means
the terminal writer returned without a synchronous error, not that the
program consumed or executed the input. `rejected` means this request made
no write attempt. `uncertain` means no definitive receipt was obtained
(`acknowledgement_lost` or `connection_failed`), or the write itself was
uncertain (`write_uncertain`). A retry with the original key can retrieve a
receipt after a lost acknowledgement. An uncertain write receipt never
causes another attempt. The server does not automatically retry.

The [manager](api.md#keyed-terminal-input) retains compact receipts for the
current and previous 4,096 keys per Session, including after exit. Identical
retries return the original result; changed input is rejected. Filling a
generation or reattaching changes `inputInstance`. Keys in either kept
generation still return their receipts; any other key with an old instance
returns `stale_instance` without a write. On `stale_instance` for a new
request, call `list_sessions` again and form new keys from the current
`inputInstance`; for a retry, treat the outcome as unknown and do not resend.
Restart or replacement loses receipts and rejects old keys. Do not replace a key or its instance prefix,
or resend unkeyed, to resolve an uncertain outcome. Retry protection grants
no authorization to type.

The guarantee is **at most one write attempt per keyed request within its
valid session instance**, not exactly-once command execution. MCP rejects
keyed calls as `unsupported` when the manager lacks `inputInstance`. Unkeyed calls
keep the existing `{ sent: true }` response and have no retry protection.

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
