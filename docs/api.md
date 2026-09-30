# Session manager API (v1)

The session manager is the only component that owns terminal processes. The
web page is one client of this API. Any other front end, such as a future
Unreal Engine interface, can use the same API to list, start, watch and drive
the same sessions at the same time.

## Discovery and authentication

The manager listens on `127.0.0.1` only. Its default port is 47821, and
`AGENT_GUILD_PORT` overrides it.

A client finds a running manager through two files in the per-user data
directory:

| Platform | Data directory |
| --- | --- |
| Windows | `%APPDATA%\AgentGuild` |
| macOS | `~/Library/Application Support/AgentGuild` |
| Linux | `$XDG_CONFIG_HOME/agent-guild` (default `~/.config/agent-guild`) |

* `manager.json` exists while a manager runs. It holds `pid`, `port`, `url`,
  `version` and `startedAt`.
* `auth-token` holds the API token. It persists across restarts. Delete it to
  rotate the token.

Every endpoint except `GET /api/v1/health` requires the token:

```
Authorization: Bearer <token>
```

WebSocket clients that cannot set headers, such as browsers, pass
`?token=<token>` in the URL instead.

The manager also rejects requests whose `Host` header is not a loopback name
for its port, and browser requests whose `Origin` is not the manager's own
page. That blocks DNS-rebinding and cross-site attacks. Native clients that
send no `Origin` header are unaffected. `AGENT_GUILD_ALLOWED_ORIGINS` adds
extra comma-separated origins, for example a UI dev server.

Errors use one shape:

```json
{ "error": { "code": "provider_unavailable", "message": "Codex CLI (\"codex\") was not found on PATH. ..." } }
```

## Objects

### Provider

```json
{
  "id": "anthropic",
  "vendor": "Anthropic",
  "tool": "Claude Code",
  "command": "claude",
  "package": "@anthropic-ai/claude-code",
  "args": [],
  "resumable": true,
  "installable": true,
  "installedVersion": "2.1.285",
  "latestVersion": "2.1.290",
  "updateAvailable": true,
  "usageSource": "claude",
  "color": "#D97757",
  "monogram": "A",
  "iconUrl": null,
  "install": "npm install -g @anthropic-ai/claude-code",
  "docs": "https://docs.anthropic.com/en/docs/claude-code",
  "available": true,
  "resolvedPath": "/usr/local/bin/claude"
}
```

`available` is false when the command is not installed. A client should show
the provider as disabled and offer `POST /providers/:id/install` when
`installable` is true (the provider names an npm `package` and npm is on
PATH), or the `install` hint otherwise. `resumable` is true when the provider
has `resumeArgs`, so one of the tool's own earlier sessions can be resumed by
id.

`installedVersion` comes from running the tool with its `versionArgs`, and
`latestVersion` from npm's configured registry, which installs use too
(`AGENT_GUILD_NPM_REGISTRY` overrides it for both, `AGENT_GUILD_NO_UPDATE_CHECK=1`
skips the lookup). Both are null until the first check finishes; a
`providers.updated` event follows.
`updateAvailable` is true when the latest version is newer, and
`POST /providers/:id/install` performs the update.

`usageSource` is `claude`, `codex`, `command` or null, and says whether
`GET /usage` reports the provider.

### Usage

```json
{
  "providerId": "anthropic",
  "plan": "max",
  "windows": [
    { "label": "5-hour", "usedPercent": 42.5, "resetsAt": "2026-09-30T08:00:00.000Z" },
    { "label": "7-day", "usedPercent": 12, "resetsAt": "2026-10-03T05:00:00.000Z" }
  ],
  "fetchedAt": "2026-09-30T03:12:01.120Z",
  "error": null
}
```

Each window is one rate limit of the provider's subscription. When the
provider is not signed in or the lookup failed, `windows` is empty and
`error` says why. The manager reads the tool's own sign-in (Claude Code's
credentials file or macOS keychain item, Codex CLI's `auth.json`) and asks
the vendor's usage endpoint; a `command` source runs a program that prints
`{ plan?, windows: [{ label, usedPercent | remainingPercent, resetsAt? }] }`.
Snapshots are cached for a minute.

### Session

```json
{
  "id": "b45b6822d158",
  "name": "Claude Code",
  "provider": { "id": "anthropic", "vendor": "Anthropic", "tool": "Claude Code", "color": "#D97757", "monogram": "A", "iconUrl": null },
  "cwd": "/Users/me/src/app",
  "resume": null,
  "task": null,
  "pid": 3518,
  "status": "running",
  "exitCode": null,
  "signal": null,
  "activity": "active",
  "lastOutputAt": "2026-09-30T03:12:01.120Z",
  "createdAt": "2026-09-30T03:10:44.001Z",
  "cols": 120,
  "rows": 32,
  "attachedClients": 1,
  "model": { "name": "claude-opus-4-5", "displayName": "Opus 4.5", "source": "report" },
  "agents": [ /* Agent */ ]
}
```

* `status` is `running` or `exited`. Exited sessions stay listed, with their
  final screen, until a client removes them.
* `activity` is `active` while the terminal is producing output and `quiet`
  after a short pause.
* `resume` is the id of the tool's own session that was resumed, or null.
* `task` is `install` for a session that runs npm to install or update the
  provider's tool, and null for a session that runs the tool itself.
* `model` is the main model the tool is using, or null while unknown.
  `source` is `report` when the tool said so (see
  [agent-reporting.md](agent-reporting.md)), `screen` when the name was
  matched on the terminal screen by the provider's `modelPattern`, or `args`
  when it came from a `--model` argument. Reports win over the screen, which
  wins over arguments.

### Agent

An agent is a worker that the coding tool reports inside a session, such as a
Claude Code sub-agent. See [agent-reporting.md](agent-reporting.md).

```json
{
  "id": "claude-task-toolu_01",
  "name": "Explore",
  "kind": "subagent",
  "status": "working",
  "detail": "Search the codebase for auth code",
  "startedAt": "2026-09-30T03:11:02.000Z",
  "updatedAt": "2026-09-30T03:11:02.000Z",
  "source": "api"
}
```

`status` is one of `working`, `waiting`, `idle` or `done`. An agent reported
as `done` stays visible for about 15 seconds and is then removed. All agents
are cleared when their session exits.

## HTTP endpoints

All paths are under `/api/v1`.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/health` | | `{ ok, name, version, pid }`. No token needed. |
| GET | `/info` | | Manager version, platform, start time, provider config warnings. |
| GET | `/providers` | | `{ providers: Provider[] }` |
| POST | `/providers/reload` | | Re-reads `providers.json`. |
| POST | `/providers/:id/install` | `{ force? }` | `201 { session }`: a session running `npm install -g <package>@latest`. 409 `provider_in_use` (with `running`, the session count) while the provider's sessions are running, unless `force` is true. |
| GET | `/usage` | | `{ usage: Usage[] }` for every provider with a `usageSource`. |
| GET | `/sessions` | | `{ sessions: Session[] }` |
| POST | `/sessions` | `{ providerId, cwd?, cols?, rows?, name?, args?, resume? }` | `201 { session }` |
| GET | `/sessions/:id` | | `{ session }` |
| PATCH | `/sessions/:id` | `{ name }` | `{ session }`. `name` must be a non-empty string; it is trimmed to 80 characters. |
| POST | `/sessions/:id/stop` | | Ends the process. The session stays listed as exited. |
| DELETE | `/sessions/:id` | | Ends the process if needed and removes the session. |
| POST | `/sessions/:id/agents` | Agent report | `{ agent }`, or `{ agent: null }` after a removal. |
| POST | `/sessions/:id/model` | `{ model, displayName? }` | `{ model }`. Sets the session's model with source `report`. |
| POST | `/shutdown` | | Stops the manager and every session. |

`cwd` defaults to the user's home folder and must be an existing folder. A
leading `~` is expanded. `args` are appended to the provider's configured
arguments. `resume` is an id or name of one of the tool's own sessions; it is
substituted for `{id}` in the provider's `resumeArgs` (400 `resume_unsupported`
when the provider has none).

`POST /sessions/:id/agents` and `POST /sessions/:id/model` also accept the
per-session report token instead of the API token, in an
`X-Agent-Guild-Report-Token` header. The manager gives that token only to the
processes inside that session. Without the API token, an unknown session id
and a wrong report token both return 401.

Request bodies are limited to 64 KB (413 above that). WebSocket messages are
limited to 1 MB.

## WebSockets

Messages in both directions are JSON text frames.

### `GET /api/v1/events`

This socket pushes changes to every session. It is server-to-client only.

| Message | Meaning |
| --- | --- |
| `{ type: "hello", version, sessions }` | Sent first. The full session list. |
| `{ type: "session.created", session }` | A session was started by any client. |
| `{ type: "session.updated", session }` | Status, activity, agents, name or size changed. |
| `{ type: "session.removed", sessionId }` | A session was removed. |
| `{ type: "providers.updated", providers }` | The provider list changed: a version check finished, `providers.json` was reloaded, or an install session ended. |

After a reconnect, treat `hello` as the new source of truth.

### `GET /api/v1/sessions/:id/terminal`

This socket is the interactive terminal for one session. Any number of
clients may attach to the same session.

Server to client:

| Message | Meaning |
| --- | --- |
| `{ type: "snapshot", data, cols, rows, session }` | Always first. `data` is a VT escape sequence stream that redraws the current screen and scrollback. Reset the terminal and write it. |
| `{ type: "data", data }` | Terminal output, in order, directly after the snapshot. |
| `{ type: "resize", cols, rows }` | Another client changed the terminal size. |
| `{ type: "exit", exitCode, signal }` | The process ended. Also sent after the snapshot when attaching to an exited session. |
| `{ type: "removed" }` | The session was removed. The socket then closes with code 4410. |

Client to server:

| Message | Meaning |
| --- | --- |
| `{ type: "input", data }` | Keystrokes or pasted text, exactly as a terminal would send them. |
| `{ type: "resize", cols, rows }` | Resize the terminal. The last client to resize wins. |

### Terminal queries: clients must not answer

Programs ask the terminal questions by writing escape sequences, for
example "where is the cursor?" (`CSI 6 n`). The manager answers these once
per session from its own copy of the screen, whether zero or many clients
are attached. A client that renders the terminal must therefore not answer
them itself, or the program receives duplicate replies as keyboard input.

The manager answers cursor position and status reports (`CSI n`), device
attributes (`CSI c`, `CSI > c`, `CSI = c`), mode reports (`CSI $ p`,
`CSI ? $ p`), setting reports (`DCS $ q`) and colour queries for OSC 10, 11
and 12. It reports the web page's theme colours: foreground `#e6e9ef`,
background `#0f1115`. A client built on xterm.js can copy
`suppressQueryReplies` from `web/app.js`.

Close codes: `4404` means the session does not exist, `4410` means it was
removed, and `4008` means the client fell too far behind. After a `4008` or a
network drop, reconnect and the snapshot brings the client up to date.
