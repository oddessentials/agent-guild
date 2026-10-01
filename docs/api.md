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
  "accounts": [{ "id": "default", "label": "Default" }, { "id": "work", "label": "Work" }],
  "color": "#D97757",
  "monogram": "A",
  "iconUrl": null,
  "install": "npm install -g @anthropic-ai/claude-code",
  "docs": "https://docs.anthropic.com/en/docs/claude-code",
  "usageUrl": "https://claude.ai/settings/usage",
  "billingUrl": "https://claude.ai/settings/billing",
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
`POST /providers/:id/install` performs the update when `updateCommand` is not null.

`usageSource` is `claude`, `codex`, `gemini`, `command` or null, and says
whether `GET /usage` reports the provider.
`accounts` lists the sign-ins the tool can run under: `default` is the
tool's own, and each further one has its own home folder, so it keeps its
own sign-in and usage. `POST /sessions` takes an account id.
`usageUrl` and `billingUrl` are `https://` links to the vendor's usage and
billing pages, or null when none is configured. A usage snapshot's `plan` is
the subscription tier.

### Usage

```json
{
  "providerId": "anthropic",
  "accountId": "default",
  "plan": "max",
  "signedIn": true,
  "windows": [
    { "label": "5-hour", "usedPercent": 42.5, "resetsAt": "2026-09-30T08:00:00.000Z" },
    { "label": "7-day", "usedPercent": 12, "resetsAt": "2026-10-03T05:00:00.000Z" },
    { "label": "7-day Fable 5.1", "usedPercent": 48, "resetsAt": "2026-10-03T05:00:00.000Z" }
  ],
  "credits": null,
  "fetchedAt": "2026-09-30T03:12:01.120Z",
  "error": null
}
```

Each window is one rate limit of the provider's subscription: the plan's
own windows first, then the further limits the vendor lists (every
per-model weekly window Claude reports, such as Fable; each window of
Codex's additional limits, labelled with the model or feature they meter),
then Claude's "Extra usage" share of the monthly spend limit when extra
usage is enabled, whose `resetsAt` is the end of the spend period when the
vendor reports it. `credits` is a prepaid credit balance
(Codex), or null when the account has none, it is unlimited, or it is
unknown. When the provider is not signed in or the lookup failed,
`windows` is empty and `error` says why; `signedIn` is false when no
sign-in was found for that account, true when one was read, and null when
that is unknown. One snapshot is reported per account. The manager reads the tool's own sign-in (Claude Code's
credentials file or macOS keychain item, Codex CLI's `auth.json`, Gemini
CLI's keychain item, encrypted credentials file or `oauth_creds.json`) and
asks the vendor's usage
endpoint; a `command` source runs a program that prints
`{ plan?, windows: [{ label, usedPercent | remainingPercent, resetsAt? }] }`.
A window whose share is not a number (missing, null or blank) is left out
rather than shown as unused. Snapshots are cached for a minute.

### Session

```json
{
  "id": "b45b6822d158",
  "name": "Claude Code",
  "provider": { "id": "anthropic", "vendor": "Anthropic", "tool": "Claude Code", "color": "#D97757", "monogram": "A", "iconUrl": null },
  "cwd": "/Users/me/src/app",
  "resume": null,
  "task": null,
  "account": { "id": "default", "label": "Default" },
  "pid": 3518,
  "status": "running",
  "exitCode": null,
  "signal": null,
  "activity": "active",
  "lastOutputAt": "2026-09-30T03:12:01.120Z",
  "createdAt": "2026-09-30T03:10:44.001Z",
  "exitedAt": null,
  "cols": 120,
  "rows": 32,
  "attachedClients": 1,
  "model": { "name": "claude-opus-4-5", "displayName": "Opus 4.5", "source": "report" },
  "agents": [ /* Agent */ ]
}
```

* `status` is `running` or `exited`. Exited sessions stay listed, with their
  final screen, until a client removes them.
* `exitedAt` is null while running, then an ISO 8601 timestamp recorded when
  the manager observes the process exit. It stays fixed and is included in
  session responses, updates, and reconnect snapshots. Use it with `createdAt`
  for completed session duration; `lastOutputAt` only records terminal output.
* `pid` is null while the process is still starting (Windows connects the
  console asynchronously) and after it exits. A `session.updated` event
  carries it with the first output.
* `activity` is `active` while the terminal is producing output and `quiet`
  after a short pause.
* `resume` is the id of the tool's own session that was resumed, or null.
* `task` is `install` for a session that runs npm to install or update the
  provider's tool, `upgrade` for the session that runs npm to upgrade the
  manager itself (its `provider` is a stand-in with id `agent-guild`), and
  null for a session that runs the tool itself.
* `account` is the provider account the tool runs under, or null for an
  install or upgrade session.
* `model` is the main model the tool is using, or null while unknown.
  `source` is `report` when the tool said so (see
  [agent-reporting.md](agent-reporting.md)), `screen` when the name was
  matched on the terminal screen by the provider's `modelPattern`, or `args`
  when it came from a `--model` argument. Reports win over the screen, which
  wins over arguments.

### Upgrade

The manager's own version check, in `GET /info`, the `hello` message and
`manager.upgrade` events.

```json
{
  "version": "1.2.0",
  "latestVersion": "1.3.0",
  "available": true,
  "command": "/usr/local/bin/npm install -g @oddessentials/agent-guild@1.3.0",
  "guidance": null,
  "pendingVersion": null,
  "installing": false,
  "lastInstall": null
}
```

`version` is the running manager. `latestVersion` comes from the same npm
registry as the provider checks, about once an hour, and is null until the
first check finishes or while the manager is a development build
(`0.0.0-development`), which is never offered an upgrade. `available` is true
when a newer release exists that is not yet installed; `command` is then
what `POST /upgrade` runs, or null with `guidance` when npm is not on PATH.
`pendingVersion` is a newer version whose files are already on disk: the
manager runs from the package npm replaces in place, so after an upgrade the
running process is still the old version until it is restarted
(`agent-guild stop`, then `agent-guild open`). `lastInstall` describes the
last upgrade session: `{ outcome, exitCode, version, installedVersion, at }`
with `outcome` `installed`, `failed`, or `unchanged` when npm exited cleanly
but did not replace the files the manager runs from. It is dropped once a
newer release appears or the files on disk change. A check that fails keeps
the release already known. `installing` is true from the start of an upgrade
session until its npm process has exited, even if the session was removed
meanwhile; `available` and `pendingVersion` are withheld during that time,
because the files on disk are mid-replacement, and `POST /upgrade` answers
409 `upgrade_in_progress`.

### Agent

An agent is a worker that the coding tool reports inside a session, such as a
Claude Code sub-agent. See [agent-reporting.md](agent-reporting.md).

```json
{
  "id": "hook-task-c9df2e9f7dd4e090",
  "name": "codebase_investigator",
  "kind": "subagent",
  "status": "working",
  "detail": "Map the auth flow",
  "foreground": true,
  "startedAt": "2026-09-30T03:11:02.000Z",
  "updatedAt": "2026-09-30T03:11:02.000Z",
  "source": "api"
}
```

`status` is one of `working`, `waiting`, `idle` or `done`. An agent reported
as `done` stays visible for about 15 seconds and is then removed. A session
holds at most 64 agents; a new one displaces the done agent that has
lingered longest. All agents are cleared when their session exits.
`foreground` is true when the tool
waits for the agent; while such an agent is `working`, model reports are
taken to be the agent's and leave the session's `model` unchanged.

## HTTP endpoints

All paths are under `/api/v1`.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/health` | | `{ ok, name, version, pid }`. No token needed. |
| GET | `/info` | | Manager version, platform, start time, provider config warnings, and `upgrade` (an Upgrade object). |
| POST | `/upgrade` | | `201 { session }`: a session with `task` `upgrade` running the Upgrade `command`. 400 `not_updatable` when no newer release is known, it is already installed on disk, the manager is a development build, or version checks are off. 409 `npm_unavailable` without npm on PATH. 409 `upgrade_in_progress` while one is running. Sessions keep running; the new version is used after the manager restarts. |
| GET | `/providers` | | `{ providers: Provider[] }` |
| POST | `/providers/reload` | | Re-reads `providers.json`. |
| POST | `/providers/:id/install` | `{ force? }` | `201 { session }`: a session running `npm install -g <package>@<version>`, or `updateCommand` when the tool is installed. 400 `not_updatable` when an installed tool has no `updateCommand`. 503 `release_unresolved` or 409 `release_incomplete` when the release cannot be read or its platform build is not published; nothing is run. 409 `install_in_progress` while one is already running. 409 `provider_in_use` (with `running`, the session count) while the provider's sessions are running, unless `force` is true. |
| GET | `/usage` | | `{ usage: Usage[] }`, one per account of every provider with a `usageSource`. |
| GET | `/sessions` | | `{ sessions: Session[] }` |
| POST | `/sessions` | `{ providerId, account?, cwd?, cols?, rows?, name?, args?, resume? }` | `201 { session }` |
| GET | `/sessions/:id` | | `{ session }` |
| PATCH | `/sessions/:id` | `{ name }` | `{ session }`. `name` must be a non-empty string; it is trimmed to 80 characters. |
| POST | `/sessions/:id/stop` | | Ends the process. The session stays listed as exited. |
| DELETE | `/sessions/:id` | | Ends the process if needed and removes the session. |
| POST | `/sessions/:id/agents` | Agent report | `{ agent }`, or `{ agent: null }` after a removal, for a `done` report about an agent that was never reported, or for `{ finishForeground: true }`, which marks every foreground agent still working as done. |
| POST | `/sessions/:id/model` | `{ model, displayName? }` | `{ model }`. Sets the session's model with source `report`, unless a foreground agent is working; then the current model is returned unchanged. |
| POST | `/shutdown` | `{ force? }` | `202 { ok, running }`: stops the manager and every session. 409 `sessions_running` (with `running`, the session count) while any session is running, unless `force` is true. From the 202 on, `POST /sessions` and `POST /providers/:id/install` answer 503 `manager_stopping`. Events clients get `manager.stopping` first and `manager.stopped` last, after the sessions have ended and before the API closes. |

`cwd` defaults to the user's home folder and must be an existing folder. A
leading `~` is expanded. `args` are appended to the provider's configured
arguments. `resume` is an id or name of one of the tool's own sessions; it is
substituted for `{id}` in the provider's `resumeArgs` (400 `resume_unsupported`
when the provider has none). `account` is one of the provider's account ids
(404 `unknown_account` otherwise) and defaults to `default`; the account's
home folder is created before its first session.

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
| `{ type: "hello", version, upgrade, sessions }` | Sent first. The full session list and the manager's Upgrade object. |
| `{ type: "session.created", session }` | A session was started by any client. |
| `{ type: "session.updated", session }` | Status, activity, agents, name or size changed. |
| `{ type: "session.removed", sessionId }` | A session was removed. |
| `{ type: "providers.updated", providers }` | The provider list changed: a version check finished, `providers.json` was reloaded, or an install session ended. |
| `{ type: "manager.upgrade", upgrade }` | The manager's own version check changed: a newer release was found, or an upgrade session ended. |
| `{ type: "manager.stopping", running }` | A client asked the manager to stop. `running` sessions are being ended. A client should show that the manager was stopped on purpose, not that it is unreachable. |
| `{ type: "manager.stopped", remaining }` | The last event before the socket closes. `remaining` is how many session processes had not confirmed their exit when the manager gave up waiting (about five seconds); 0 means every session has ended. A socket that closes after `manager.stopping` without this event means the manager went away before it could confirm. |

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
