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

The manager rejects requests whose `Host` or browser `Origin` is outside
its loopback and saved remote-access allowlists. The legacy
`AGENT_GUILD_ALLOWED_HOSTS` and `AGENT_GUILD_ALLOWED_ORIGINS` variables are
startup fallbacks until settings are saved. Host values have no scheme;
Origin values include it. Both are checked independently for HTTP and
WebSocket requests, without trusting forwarded headers. Native clients
that send no `Origin` still need an accepted Host and the API token.
See [remote access setup](configuration.md#reverse-proxies).

`GET /api/v1/remote-access` returns `{ remoteAccess }` with the current
`revision`, `mode`, `busy`, `pending`, `problem` and connection details.
`POST /api/v1/remote-access/check` refreshes Tailscale status.
`PUT /api/v1/remote-access` takes the current `revision` and an `action`:
`enable` (with `adopt: true` to manage a matching existing route), `disable`,
`custom` (with `hosts` and `origins` arrays), or `forget` (leave an inactive
route awaiting cleanup in Tailscale). A successful submission returns 202;
poll until `busy` is null and inspect `problem` for the outcome. Stale
revisions and concurrent changes return 409. The `remote-access.updated`
event signals a fresh snapshot is available. These endpoints require the
manager token; report tokens cannot configure access. Revoked WebSockets
close with code 4403 while their terminal processes keep running.

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
  "historySource": "claude",
  "accounts": [{ "id": "default", "label": "Default" }, { "id": "work", "label": "Work" }],
  "color": "#D97757",
  "monogram": "A",
  "iconUrl": null,
  "install": "npm install -g @anthropic-ai/claude-code",
  "docs": "https://docs.anthropic.com/en/docs/claude-code",
  "usageUrl": "https://claude.ai/settings/usage",
  "billingUrl": "https://claude.ai/settings/billing",
  "cloudUrl": "https://claude.ai/code",
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

`installs` lists every copy of the tool that was found, each
`{ path, displayPath, channel, version, versionStatus, active, newer, onPath, uninstall, uninstallGuidance }`.
`path` is the copy's launcher and `displayPath` the same path with the home
folder shown as `~`. `channel` is `npm`, `native`, `brew`, `winget`, `legacy`
or `unknown`. `active` marks the copy that runs, `newer` a copy newer than
that one, and `onPath` whether its folder is on PATH. `uninstall` is null
when Agent Guild cannot remove that copy, otherwise the `command` it runs (or null) and the paths it deletes
(`remove`); `uninstallGuidance` then says why and how to remove it instead.
`POST /providers/:id/uninstall` removes one copy.

A provider that runs a Docker CLI plugin (`dockerPlugin`, Docker Agent's
`agent`) describes the plugin, not the `docker` command: `available` says
whether Docker runs a copy, `installs` lists the copy it runs and the ones it
shadows, as `docker info` reports them, with `channel` `agent-guild`,
`docker-desktop` or `other`, and only Agent Guild's own copy can be updated
or removed. `installable` is true when Agent Guild has no copy, Docker is
installed, and a copy in `<config dir>/cli-plugins` would be the one Docker
runs. `latestVersion` is the latest GitHub release. `plugin` is
`{ target, phase, outcome, message }`: `target` is where Agent Guild installs
it, `phase` is `installing`, `verifying`, `ready` or `missing`, `outcome`
is the last change's (`ready`, `removed`, `shadowed`, `failed`, `conflict` or
null), and `message` says what that change did, what Install would change,
or why it cannot run. Install, Update and Remove run while the plugin's
sessions run, since the copy they replace is renamed aside.

`usageSource` is `claude`, `codex`, `command` or null, and says
whether `GET /usage` reports the provider. `historySource` is `claude`,
`codex`, `antigravity`, `grok`, `docker`, `command` or null, and says whether
`GET /providers/:id/history` can list the tool's earlier sessions.
`accounts` lists the sign-ins the tool can run under: `default` is the
tool's own, and each further one has its own home folder, so it keeps its
own sign-in and usage. `POST /sessions` takes an account id.
`shells` is null except for the `@shell` provider, where it lists the
installed shells, each `{ id, label, path, multiplexer }`, and `defaultShell` is the id of
the one a session runs unless `POST /sessions` names another in `shell`.
Omit `shell` or send `null` to use the default. Provider `args` apply only to
the default shell; request `args` apply to whichever shell is selected.
`multiplexer` is true for tmux 3.2 or later on macOS and Linux and for
herdr, listed after the shells when installed and never the default. A
session in one runs the multiplexer's client: stopping or removing it, or
stopping the manager, leaves the multiplexer running its session, and
`POST /sessions/:id/reattach` attaches it again. Until such a session is
removed, the manager keeps it in `multiplexers.json` in its data folder,
report token included; when it starts again it lists each one the
multiplexer still has as exited, with its own `id`, `name`, `createdAt` and
report token, ready to reattach. A tmux session gets a tmux session of its
own, made with the session's `AGENT_GUILD_` variables and PATH, so what
runs there reports to it as from a shell; its request `args` are that tmux
session's command. A herdr session's agents are the ones herdr reports in
its panes; its request `args` are added to `herdr` and kept for reattachment,
including across manager restarts. Older saved cards without arguments
continue to use the default herdr invocation.
For a tool whose agent reporting has to be turned on (`reporting` is `antigravity`),
or whose model reporting does (`docker`, 1.100.0 and later), `reportingEnabled`
says whether it is. `reportingNote` says why that switch cannot be used, or is null.
`usageUrl`, `billingUrl` and `cloudUrl` are `https://` links to the vendor's
usage and billing pages and web app, or null when none is configured. A usage snapshot's `plan` is
the subscription tier.

### Manager environment

`GET /environment` returns the cached manager snapshot and starts discovery if no
check has finished. `POST /environment/refresh` with `{}` or `{ "scope": "manager" }`
starts a new check and returns `202` immediately. Concurrent refreshes of one
scope share the same helper. Both routes use the usual authentication and
source checks.

Every snapshot names `host`, the hostname of the computer running the manager.
A page does not compare that name with its own browser. `scope` is `manager`,
`project`, `session`, or `launch`. Each scope has its own `revision`,
`refreshing`, `checkedAt`, and `error`, and never fills a missing row from
another scope. `error` is null, or why the helper itself did not finish.
Refresh retains the previous results for that scope while `refreshing` is true.

`GET /environment?scope=project&cwd=<folder>` and
`POST /environment/refresh` with `{ "scope": "project", "cwd": "<folder>" }`
read known pin files in that folder. `cwd` is required. An empty value is
`400` `cwd_required` and is not replaced with the home directory. A missing
path or a path that is not a folder is `400` `bad_cwd`. The result adds `cwd`,
`stale`, and `pins[]`. A pin is `{ id, label, source, version, status, detail }`
with `status` `configured`, `unreadable`, or `invalid`. `configured` means the
file asked for that text. It does not mean the runtime is installed. Aliases
such as `lts/*` are returned as written. A later GET compares file identity
and may set `stale` without replacing the pins. POST reads them again.

`GET /environment?scope=session&id=<hex>` and `{ "scope": "session", "id": "<hex>" }`
probe the PATH recorded when that session was spawned, in a neutral temporary
directory. Only PATH, the home folder, the toolchain-manager locations and
version selectors (for example `RUSTUP_HOME`, `PYENV_ROOT`, `ASDF_DATA_DIR`)
the Windows install folders (`LOCALAPPDATA`, `ProgramFiles`, `ProgramW6432`)
and the Docker selectors (`DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`)
are passed to the probe. The response adds `sessionId`, `spawnCwd`, and `availability`.
`availability` is `ok`, or `unavailable` for tmux and herdr, whose environment
is not that spawn record. No command is written to the terminal. An unknown id
is `404` `not_found`. An id that is not hexadecimal is `400` `bad_request`.
The spawn environment is not stored, and the response never includes it.

`GET /environment?scope=launch` and `{ "scope": "launch" }` report the manager
PATH with `detail` explaining that profiles were not applied and the selected
shell was not consulted. This does not start a second probe. A manager-only
refresh does not replace a launch snapshot already stored.

A body or query that includes `shell`, `command`, `args`, or `env` is `400`
`bad_request`. Any other `scope` is `400` `bad_request`.

The manager snapshot contains `scope: "manager"`, `host`, `platform`,
`managerNode: { version, path }`, `system`, `runtimes[]`, `designTools[]`,
`docker` and `tools[]`. Session and launch snapshots have `docker` but not
`system`; a tmux or herdr session has `docker: null`. On completion,
each runtime has a fresh result; unfinished checks become `failed`, never a
stale success. A missing or unverified runtime is that runtime's own status
and does not set `error`.

Runtimes are ordered Node.js, Python, Go, .NET SDK, R, Rust. Each has `id`,
`label`, `status`, `version` and `path`. Resolved results also name `command`
and an optional explanatory `detail`. Status is `pending` before the first
check, `ok` for a parsed successful response, `not_found` when no executable
resolves, `unavailable` when a launcher exists but no local runtime can be
safely reported, or `failed` when inspection/probing fails (including timeout,
excess output and unrecognized responses). `not_found` does not prove the
runtime is absent from the computer.

Python uses `python` if it resolves, otherwise `python3`, on every platform.
A failed `python` never falls back to a successful `python3`; a different
resolved `python3` appears in `alternatives[]` with its own result. .NET's
primary value is the SDK, with `runtimes[]` containing `{ name, version }`
when the host can enumerate installed runtimes. Go reports the local bundled
toolchain with `GOTOOLCHAIN=local`, `GOENV=off` and `GOWORK=off`.

Tools are separate `{ id, label, path, status: "detected" }` entries for
nvm/NVM for Windows, vfox, uv and pnpm. Presence implies neither activation
nor ownership of a reported runtime. POSIX nvm discovery checks `NVM_DIR` or
`~/.nvm/nvm.sh` without sourcing it. Other tools are resolved on PATH without
execution. There is no whole-disk installation inventory.

Design tools are ordered Blender, FFmpeg, GIMP, Inkscape, ImageMagick. Each
has `id`, `label`, `status`, `version`, `path`, `command` and `detail`. Status
is `pending` before the first check, `on_path` when a command resolves on
PATH, `not_on_path` when the tool is installed only outside PATH, `not_found`,
or `failed` when the check did not finish. `command` is the PATH command, or
null. The commands are `blender`, `ffmpeg`, `gimp-console` (and `gimp` outside
Windows), `inkscape`, and `magick` (and `convert` outside Windows; Windows
`convert` is a disk utility). Outside PATH, Windows reads the `InstallLocation`
of uninstall entries named for the tool, then the usual Program Files and
per-user folders; macOS checks `/Applications` and `~/Applications` bundles and
Homebrew and MacPorts folders; Linux checks `/usr/local/bin`, `/usr/bin`,
`/snap/bin`, Linuxbrew and Flatpak exports. `version` is read only from a
native program whose real file name is the tool's own, so a snap, a Flatpak
launcher or a script reports presence with `detail` saying why. The version
check runs with a 3 second deadline, D-Bus disabled, and HOME, the XDG
folders and the tools' profile folders pointed at the scan's temporary folder.
A timeout or unrecognized answer keeps the row's status and sets `detail`.
In WSL with Windows interop on, a tool found only as a Windows program on PATH
is `on_path` with its `.exe` command (for example `ffmpeg.exe`) and no version;
it is not run.

`system` is null until the first manager check finishes, or when it could not
be read. Otherwise it is `{ os, osDetail, arch, hostArch, cpu: { model,
threads }, memory, wsl, wslDistributions }`. `os` is the Windows edition, the
Linux `PRETTY_NAME` from `os-release`, or `macOS <version>` from
`SystemVersion.plist`; `osDetail` is the Windows build, Linux kernel or Darwin
release. `hostArch` names the machine's architecture only when Node runs
emulated on a different one, on Windows or macOS; it is null on Linux.
`cpu.model` is null when the CPU has no known name. `memory` is total bytes.
`wsl` is null outside WSL, or `{ version, distro, interop }` inside it, where
`memory` is the WSL virtual machine's. On Windows, `wslDistributions` lists `{ name, version, default }`
from the user's `Lxss` registry key without starting WSL; it is `[]` when none
are registered and null elsewhere or when the key cannot be read.

`docker` is `{ status, version, platform, os, arch, wsl2, context, endpoint,
cli, detail }`. The engine is chosen as the docker command would choose it:
`DOCKER_HOST`, then `DOCKER_CONTEXT`, then `currentContext` in the Docker
config, then the platform default. The check sends one `GET /version` to a
local Unix socket or named pipe, with a 1.5 second deadline and a 256 KiB
limit; no docker process runs. Where systemd starts the engine on demand
(`docker.socket`, `podman.socket`), this request starts it. Status is
`pending`, `running` (with `version`, `platform`, `os`, `arch`, and `wsl2`
when a Linux engine runs in WSL 2),
`stopped` (the docker command is on PATH but no engine answered), `not_found`,
`denied` (the socket or pipe exists but this user cannot open it), `remote`
(a `tcp://` or `ssh://` engine, never contacted), or `failed` with `detail`.
`cli` is the docker command on PATH, or null.

Runtime probes execute recognized native binaries (and R's Unix launcher)
from a neutral temporary directory; unknown script/shim launchers and Windows
execution aliases remain `unavailable`. rustup/Python auto-install and Go
toolchain downloads are disabled for probes. Probe output and the full
environment are never included in API responses. The manager and session
probes do not load shell profiles. A project check reads only `.nvmrc`,
`.node-version`, `.python-version`, `package.json` (`engines.node`,
`engines.npm`, `packageManager`), `pyproject.toml` (`requires-python` as one
quoted line), `rust-toolchain.toml`, `rust-toolchain`, `go.mod` (the `go` line
and the `toolchain` directive), `global.json` (`sdk.version`), and known rows
in `.tool-versions` (`node`, `nodejs`, `python`, `go`, `golang`, `rust`,
`dotnet`, `dotnet-sdk`). It does not enter that directory.

Tool behavior stays bounded. POSIX nvm is `nvm.sh` at `NVM_DIR` or `~/.nvm`,
and it is never sourced. NVM for Windows, vfox, and uv are presence on PATH.
pnpm is presence on PATH plus a `packageManager` pin; Corepack is not enabled.
Rust pins come from `rust-toolchain` files, Go pins from `go.mod`, and .NET
pins from `global.json`. None of those tools is asked to install, select, or
download a runtime. Refresh of the manager reads its current environment
without invoking PATH or profile discovery.

### Multiplexer installations

An `@shell` provider also describes `multiplexers[]`. Each entry contains
`id` (`tmux` or `herdr`), `tool`, `docs`, `checked`, `available`,
`installable`, `installCommand`, `guidance`, `busy`, `pendingCards`,
`installs` and `lastInstall`. Before discovery finishes, `checked` is false.
`available` means a usable copy is on PATH; an old, off-PATH, or partial copy
may still appear in `installs`.

Each copy has the provider-copy fields plus `key` (stable installation
identity), `supported`, `partial`, `latestVersion`, `updateAvailable`,
`updateCommand` and `updateGuidance`. An uninstall plan's `pathEntries` flag
indicates that owned user PATH entries are also removed. Never construct
commands from these display fields: submit the returned `path` to the API,
which rediscovers and validates the installation.

These authenticated routes return `201 { session }`, with `task: "install"`:

| Route below `/api/v1` | Body |
| --- | --- |
| `POST /providers/:provider/multiplexers/:id/install` | `{ force?: boolean }` |
| `POST /providers/:provider/multiplexers/:id/update` | `{ path: string, force?: boolean }` |
| `POST /providers/:provider/multiplexers/:id/uninstall` | `{ path: string, force?: boolean }` |

`install_in_progress` (409) blocks overlapping operations and new
starts/reattachments for that multiplexer until the process exits and the
inventory refreshes. Ordinary shells remain available.
`multiplexer_in_use` (409) applies to tmux, carries `running` and `pending`
counts, and can be retried with `force: true` after confirmation. Its
`running` count includes detached cards that can reattach; pending cards
are informational and never block installation.

Herdr Update does not require existing servers or panes to stop.
Herdr Uninstall refuses with `herdr_running` or `herdr_status_unknown`
(409) when any server is running or the server listing cannot be safely
read. `force` never bypasses that check. Unknown copies return `unknown_copy`
(404); unsupported actions return `not_installable`, `not_updatable` or
`not_removable` (400).

Operation results and pending-card counts arrive through `providers.updated`.
Saved cards also remain pending when the session limit is reached. Remove
finished cards and use **Refresh** to retry restoration.
Saved cards whose tool is missing remain persisted, without exposing their
report tokens, and retry restoration after installation or discovery.

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
credentials file or macOS keychain item, Codex CLI's `auth.json`) and
asks the vendor's usage
endpoint; a `command` source runs a program that prints
`{ plan?, windows: [{ label, usedPercent | remainingPercent, resetsAt? }] }`.
A window whose share is not a number (missing, null or blank) is left out
rather than shown as unused. Snapshots are cached for a minute.
A refused request says which kind of refusal it was: HTTP 401 is a refused
sign-in, while an HTTP 403 that Cloudflare answers is a block of the request,
usually because of the network it came from (a VPN, proxy or exit node), and
advises no sign-in. The manager writes the status, the `server` and `cf-ray`
headers and a short excerpt of the reply, without credentials, to
`manager.log` when a failure starts or changes, and notes when lookups work
again.

### History

```json
{
  "providerId": "anthropic",
  "accountId": "default",
  "sessions": [
    { "id": "581893e5-a93d-5e49-968b-1c1c277d3255", "title": "Fix the login bug", "cwd": "/Users/me/src/app", "startedAt": "2026-10-01T13:26:53.713Z", "updatedAt": "2026-10-01T13:49:28.000Z" }
  ],
  "total": 42,
  "fetchedAt": "2026-10-01T14:00:00.000Z",
  "error": null
}
```

The tool's own earlier sessions, newest first, read from where the tool
keeps them under the account's home folder: Claude Code's
`projects/<folder>/<id>.jsonl` transcripts, Codex CLI's
`sessions/<date>/rollout-*.jsonl` files, Antigravity CLI's
`brain/<id>/.system_generated/logs/transcript.jsonl` files, Grok Build's
`sessions/<folder>/<id>/summary.json` and Docker Agent's `session.db`, a
SQLite database. Sub-agent sessions are left out.
`id` is what the tool resumes by (`POST /sessions` with `resume`); `title` is
the session's name or first prompt, or null; `cwd` is the folder the session
ran in, or null when the tool did not record it. Claude Code
finds a session only from its own folder, so a client should resume with that
`cwd`. `updatedAt` is when the transcript last changed. `sessions` holds at
most `limit` entries of the `total` found. Only the head of each transcript
is read, and a transcript is read again only when it changed; the list is
cached for a few seconds. `error` says why nothing could be listed; a tool
that has never run lists no sessions and no error.

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
  "clone": null,
  "multiplexer": null,
  "pid": 3518,
  "status": "running",
  "exitCode": null,
  "signal": null,
  "activity": "active",
  "lastOutputAt": "2026-09-30T03:12:01.120Z",
  "createdAt": "2026-09-30T03:10:44.001Z",
  "startedAt": "2026-09-30T03:10:44.001Z",
  "exitedAt": null,
  "cols": 120,
  "rows": 32,
  "attachedClients": 1,
  "model": { "name": "claude-opus-4-5", "displayName": "Opus 4.5", "source": "report" },
  "toolSessionId": "581893e5-a93d-5e49-968b-1c1c277d3255",
  "reporting": { "state": "active", "reason": null },
  "agents": [ /* Agent */ ],
  "shells": [{ "id": "shell-3" }]
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
* `task` is `install` for a session that installs, updates or uninstalls the
  provider's tool, `upgrade` for the session that runs npm to upgrade the
  manager itself (its `provider` is a stand-in with id `agent-guild`),
  `clone` for a session that runs `git clone` for a GitHub repository (its
  `provider` is a stand-in with id `github`), and null for a session that
  runs the tool itself.
* `clone` is `{ repo, path, accountId }` for a clone session: the
  repository as owner/name, the folder it is cloned into and the GitHub
  account id. Null otherwise.
* `multiplexer` is `{ label, attach, reattachable }` for a Shell session in
  tmux or herdr: the multiplexer's name, the command that reattaches its
  session from a terminal, such as `tmux attach -t guild-3f9a2c`, and
  whether the exited session can be reattached because the multiplexer
  still has its session. Null otherwise. Stopping or removing the session
  ends only the multiplexer's client, so its `exitCode` says nothing about
  the session inside. The client gets none of the `AGENT_GUILD_` variables:
  the multiplexer's server outlives it and passes its environment on to
  every session it starts later.
* `startedAt` is when the session's current process started: `createdAt`,
  or later once a tmux or herdr session is reattached. A session update with
  a `startedAt` no later than an `exitedAt` already seen comes from before
  that exit.
* `account` is the provider account the tool runs under, or null for an
  install or upgrade session.
* `model` is the main model the tool is using, or null while unknown.
  `source` is `report` when the tool said so (see
  [agent-reporting.md](agent-reporting.md)), `screen` when the name was
  matched on the terminal screen by the provider's `modelPattern`, or `args`
  when it came from a `--model` argument. Reports win over the screen, which
  wins over arguments.
* `toolSessionId` is the id the tool gave its own session, reported by its
  hooks (see [agent-reporting.md](agent-reporting.md)), or null. It names
  the session in `GET /providers/:id/history` and resumes it later; it stays
  after the session exits.
* `reporting` says whether the tool's agent reporting hooks work, or is null
  for a tool Agent Guild supplies no hooks to. `state` is `pending` until the
  hooks announce themselves, `active` once any hook report arrives,
  `unavailable` when none has arrived some time after the first prompt (a
  line typed and sent; an Enter on an empty line or after only arrow keys is
  none) or the tool refused the hooks, `setup_required` when the user has to turn
  reporting on first (Antigravity CLI), and `unsupported` when the installed tool
  cannot take hooks for one session. `reason` explains every state but `active`.
* `shells` lists the shell commands the tool is running for the model, as
  its hooks report them, once each has run for about 600 ms; each leaves
  the list when it ends. Every running command is listed; the page draws 16
  and counts the rest. Nothing about the command itself is included.

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
  "lastInstall": null,
  "ptyBuild": null
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
(`POST /shutdown` with `restart`, or `agent-guild restart`). `lastInstall` describes the
last upgrade session: `{ outcome, exitCode, version, installedVersion, at }`
with `outcome` `installed`, `failed`, or `unchanged` when npm exited cleanly
but did not replace the files the manager runs from. It is dropped once a
newer release appears or the files on disk change. After a `failed`
upgrade the files on disk are not trusted, since npm may have replaced
`package.json` before it was stopped: `pendingVersion` is null and
`available` stays true for the same release, so it can be run again. That
holds even once a newer release has replaced the `failed` record, until an
upgrade completes or the files on disk change. A check that fails keeps
the release already known. `installing` is true from the start of an upgrade
session until its npm process has exited, even if the session was removed
meanwhile; `available` and `pendingVersion` are withheld during that time,
because the files on disk are mid-replacement, and `POST /upgrade` answers
409 `upgrade_in_progress`.

`ptyBuild` is null where node-pty, the terminal library, runs from the builds
it comes with: Windows, macOS, and Linux with glibc 2.28 or later. Elsewhere,
such as Alpine with musl, node-pty is compiled on the computer, and
`ptyBuild` is `{ command, built }`: the shell command that compiles it, and
whether the files on disk hold such a build. An upgrade replaces that build,
so `built` turns false once the new version is installed, and
`POST /shutdown` refuses a restart until the command has run. It is null
while `installing`.

### GitHub

The GitHub accounts signed in to Agent Guild, in `GET /github` and
`github.updated` events. Tokens never leave the manager.

```json
{
  "scopes": ["repo", "write:public_key"],
  "appUrl": "https://github.com/settings/connections/applications/Ov23lif6qqYKtXZTb130",
  "keysUrl": "https://github.com/settings/keys",
  "newKeyUrl": "https://github.com/settings/ssh/new",
  "tools": { "git": true, "ssh": true, "sshKeygen": true },
  "signIn": { "status": "pending", "userCode": "WDJB-MJHT", "verificationUri": "https://github.com/login/device", "expiresAt": "2026-10-01T14:15:00.000Z", "accountId": null, "again": false, "error": null },
  "accounts": [
    {
      "id": 4242, "login": "octo-cat", "name": "Octo Cat", "avatar": "data:image/png;base64,...", "scopes": ["repo", "write:public_key"],
      "needsSignIn": false, "addedAt": "2026-10-01T14:00:00.000Z",
      "ssh": { "status": "ready", "key": "/home/me/.config/agent-guild/github/keys/agent-guild-github-4242", "publicKey": "ssh-ed25519 AAAA... agent-guild github octo-cat (4242)", "verifiedAt": "2026-10-01T14:01:00.000Z", "settingUp": false, "error": null }
    }
  ]
}
```

Sign-in uses GitHub's device flow: `signIn` is `pending` while the user
enters `userCode` at `verificationUri`, then `done` (with `accountId`, and
`again` when that GitHub user was already signed in), `expired`, `denied` or
`failed`; null when none was started or it was cancelled. Accounts are keyed
by GitHub's numeric user id; `login` is display only. `needsSignIn` is true
once GitHub refuses the account's token and its refresh. `ssh.status` is
`none` (no key yet), `unverified` or `ready` (GitHub signed the key in as this
account). `ssh.error` is `{ code, message, manual }`, with `manual` true when
the user must add `publicKey` on GitHub themselves.

### Repository views

Issues, workflow runs and open pull requests of one repository, read with one
signed-in account. Each list holds the 30 most recently updated items;
`truncated` is true when GitHub has more. Every `url` is a github.com page.

```json
{ "issues": [{ "number": 4, "title": "Dock is too narrow", "body": "Steps", "state": "open", "user": "octo-cat", "comments": 2, "updatedAt": "2026-10-01T00:00:00.000Z", "url": "https://github.com/octo-cat/agent-guild/issues/4" }],
  "truncated": false, "url": "https://github.com/octo-cat/agent-guild/issues" }
{ "runs": [{ "id": 11, "name": "CI", "title": "Fix the gate", "branch": "main", "event": "push", "status": "in_progress", "conclusion": null, "runNumber": 12, "updatedAt": "2026-10-02T00:00:00.000Z", "url": "https://github.com/octo-cat/agent-guild/actions/runs/11" }],
  "running": true, "service": null, "truncated": false, "url": "https://github.com/octo-cat/agent-guild/actions" }
{ "pulls": [{ "number": 8, "title": "Add viewer", "draft": true, "user": "ada", "head": "viewer", "base": "main", "updatedAt": "2026-10-02T00:00:00.000Z", "url": "https://github.com/octo-cat/agent-guild/pull/8" }],
  "truncated": false, "url": "https://github.com/octo-cat/agent-guild/pulls" }
```

Issues leave out pull requests. `running` is true while any listed run is
`queued`, `in_progress`, `waiting`, `requested` or `pending`. `service` is
null while githubstatus.com reports Actions operational or cannot be read, else
`{ status, incident, url }`: `status` is `degraded_performance`,
`partial_outage`, `major_outage` or `under_maintenance`, `incident` is
`{ name, url }` for the open incident affecting Actions or null, and every `url`
is a githubstatus.com page. The manager reads the status page at most once a
minute, only when runs are fetched. Errors: 400
`bad_repo`, 404 `unknown_account`, 404 `not_found` (GitHub has no such
repository or issue for the account), 404 `issues_disabled`, 403 `forbidden`,
400 `github_rejected`, 429 `rate_limited`, 409 `github_sign_in`.

Branches use `GET /github/accounts/:id/repos/:owner/:name/branches?page=1`.
Each response holds up to 100 branches and `{ branches, nextPage, defaultBranch,
metadataError, fetchedAt, url }`. Each branch is `{ name, sha, protected, url }`;
`sha` is null when GitHub omits a valid commit SHA. `protected` comes directly
from GitHub's branch-list endpoint and includes protection by rulesets.
Branch names are preserved exactly; their GitHub links encode the name.

`nextPage` comes from GitHub's next-page Link and is null only when there is no
next link. Continue until it is null, even after a short or empty page. A bad
page number returns 400 `bad_page`; an invalid upstream next link or list
returns 502 `github_error`. There is no total branch limit.

Page one also reads repository metadata for `defaultBranch`; subsequent pages
return null for that field. A metadata failure leaves the branch list usable,
with `metadataError` explaining the failure and no default badge. Each refresh
starts at page one. The page loads successive pages while visible, preserves
the visible row when sorting new results, and labels partial results and
failed refreshes. Retry resumes the failed page; Refresh starts a new listing.

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
  "startedAt": "2026-09-30T03:11:02.000Z",
  "updatedAt": "2026-09-30T03:11:02.000Z",
  "source": "api"
}
```

`status` is one of `working`, `waiting`, `idle` or `done`. An agent reported
as `done` stays visible for about 15 seconds and is then removed. `source`
is `api` for a report over HTTP, `terminal` for one written to the terminal,
and `herdr` for an agent in a herdr session's panes, whose status follows
herdr: working, blocked as `waiting`, anything else `idle`. A session
holds at most 64 agents; a new one displaces the done agent that has
lingered longest. All agents are cleared when their session exits.

## HTTP endpoints

All paths are under `/api/v1`.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/health` | | `{ ok, name, version, pid }`. No token needed. |
| GET | `/info` | | Manager version, platform, start time, provider config warnings, `upgrade` (an Upgrade object), and `launcher`: the path of the double-click launcher for this platform when the install carries one (a checkout of the repository), else null. `folderOpener` is `{ available, label, reason }` for this client; it is unavailable to clients that reach the manager by any address other than its own loopback ones. |
| GET | `/folders?path=` | | `{ path, parent, home, segments, roots, entries, truncated, note }`: the subfolders of `path` (blank or `~` for the home folder) on the manager's computer. A missing `path` lists the nearest existing folder above it and names the requested path in `note`. `entries` are `{ name, path, hidden }`, sorted by name, at most 2,000 (`truncated` says when there were more); `segments` and `roots` are `{ name, path }` for the path's parts and the drives or `/`. 409 `folder_unreadable` when the folder cannot be read. |
| POST | `/folders` | `{ path, name }` | 201 with the `GET /folders` listing of the new folder `name`, made inside the existing folder `path`. 400 `bad_name` when `name` is blank, `.` or `..`, holds a path separator or control character, or (on Windows) holds `<>:"|?*`, ends with a dot or space, or is a reserved device name; 409 `folder_exists` when something already has that name, `folder_missing` when `path` is not an existing folder, `folder_unreadable` or `folder_unwritable` when the host refuses. |
| GET | `/autostart` | | `{ autostart: { available, enabled, reason, note?, lastRun?, log? } }`: whether the manager starts when the user signs in to its computer. `reason` says why it is unavailable (WSL, an unsupported system, a data folder set by `AGENT_GUILD_HOME`, or on Linux a path a desktop's startup entry cannot carry), else null. The entry turned off outside Agent Guild (Task Manager's Startup apps, a desktop's startup settings, `launchctl disable`) reads as off. On macOS, `note` explains that System Settings' Login Items switch for the item, which the manager cannot read, also keeps it from starting; on Linux it explains that a desktop session is needed, and warns when this manager was not started from one. While available, `lastRun` is null when off or when the entry has not run at a sign-in since it was turned on, else `{ at, outcome }`: `started` (it started the manager), `running` (a manager already answered), `starting` (it ran under 30 seconds ago and no manager has answered yet) or `failed` (none answered); `log` is the manager log, which records what a macOS or Linux entry ran. On Linux outside WSL the description also has `mode` (`off`, `sign-in`, `boot`, or `both` when a sign-in entry and the systemd unit are both on) and `boot`: `{ available, enabled, reason, note, user, linger, state, commands }`. `available` is false, with `reason`, when the computer has no systemd or the user manager does not answer. `linger` says whether systemd lets the service start before anyone signs in. While the unit is enabled, `state` is what systemd reports: `{ kind: 'running', since, pid }` (the manager answering is the one systemd runs), `{ kind: 'other', since, pid, port }`, `{ kind: 'starting' }`, `{ kind: 'pending' }` (the manager answering was started without systemd and hands over at its next restart), `{ kind: 'stopped', at }`, `{ kind: 'port-in-use', at, port }` or `{ kind: 'failed', at, result, status }`; times are ISO strings or null. `commands` lists the next commands to run: the journal for a failure, and `sudo loginctl enable-linger <user>` without lingering. |
| PUT | `/autostart` | `{ enabled }` or `{ mode }` | `{ autostart }` as above, after adding or removing the per-user sign-in entry, which runs `agent-guild open --no-browser --sign-in`. Turning it off, or on while it was off, forgets the last sign-in. `mode` (`off`, `sign-in` or `boot`) makes that the one way the manager starts: the new starter is added and confirmed before the other is removed, and no manager is started or stopped; `boot` writes and enables the systemd user unit, which runs `agent-guild start --service`. On Linux `{ enabled: true }` is `sign-in` and `{ enabled: false }` keeps a unit that is on. Other systems refuse `boot`. 400 `bad_request` when `enabled` is not a boolean or `mode` is not one of those, 409 `autostart_unavailable`, 500 `autostart_failed` when the system refuses the change. |
| POST | `/open-folder` | `{ cwd? }` | `{ ok }`: opens the folder in the computer's file manager. 403 `local_only` from clients that reach the manager by any address other than its own loopback ones. |
| GET | `/notes` | | `{ notes: { revision, text } }`. One notepad for every client of this manager. `revision` is null until the first save. `text` is at most 100,000 characters. |
| PUT | `/notes` | `{ revision, text }` | `{ notes }` with a new `revision`. `revision` is the one this edit started from, or null to create the notepad. 500 `notes_unreadable` (on GET too) while the notes file cannot be read; it is left as it is. 409 `stale_notes` when that revision is no longer current; `error.notes` is the current notepad, so a client can retry or adopt it. 400 `notes_too_long` over 100,000 characters, 400 `bad_notes` when `text` is not a string. The body may be up to 1 MiB. A cleared notepad is stored as an empty string; it is not deleted. |
| POST | `/upgrade` | | `201 { session }`: a session with `task` `upgrade` running the Upgrade `command`. 400 `not_updatable` when no newer release is known, it is already installed on disk, the manager is a development build, or version checks are off. 409 `npm_unavailable` without npm on PATH. 409 `upgrade_in_progress` while one is running. Sessions keep running; the new version is used after the manager restarts. |
| GET | `/providers` | | `{ providers: Provider[] }` |
| GET | `/environment?scope=&cwd=&id=` | | Environment snapshot for `scope` (`manager` when omitted, or `project`, `session`, `launch`). `cwd` is required for `project`. `id` is required for `session`. Starts the initial check for that scope without waiting. |
| POST | `/environment/refresh` | `{ scope?, cwd?, id? }` | `202` with that scope's snapshot; starts or joins its read-only check. `{}` refreshes the manager. |
| POST | `/providers/reload` | | Re-reads `providers.json`. |
| POST | `/providers/:id/reporting` | `{ enabled }` | `{ provider }`: turns agent reporting on or off for a tool that needs it, by running the tool's own `plugin install`, `plugin enable` or `plugin uninstall`. An older copy of the Agent Guild plugin is replaced, and one turned off in the tool is turned back on. For Docker Agent it writes or removes `agent-guild.yaml` in its `hooks.d` folder, which reports the model. 400 `not_applicable` for any other tool, 409 `plugin_conflict` when another plugin or file has the same name, 409 `provider_unsupported` when the Docker Agent version loads no `hooks.d` files, 500 or 502 `reporting_setup_failed` when the file or the tool's command fails. |
| POST | `/providers/:id/install` | `{ force? }` | `201 { session }`: a session running `npm install -g <package>@<version>`, or `updateCommand` when the tool is installed. 400 `not_updatable` when an installed tool has no `updateCommand`. 503 `release_unresolved` or 409 `release_incomplete` when the release cannot be read or its platform build is not published; nothing is run. 409 `install_in_progress` while one is already running. 409 `provider_in_use` (with `running`, the session count) while the provider's sessions are running, unless `force` is true. |
| POST | `/providers/:id/uninstall` | `{ path, force? }` | `201 { session }`: a session that removes the copy at `path`, one of the provider's `installs`. It runs that copy's package manager, or deletes the paths its installer created, the launcher last, so a copy that fails partway with files left is still listed and can be uninstalled again. 400 `bad_request` without `path`, 404 `unknown_copy` when no copy is at `path`, 400 `not_removable` when its `uninstall` is null. 409 `install_in_progress` and `provider_in_use` as for `install`. |
| GET | `/usage` | | `{ usage: Usage[] }`, one per account of every provider with a `usageSource`. |
| GET | `/model-stats` | | Benchmarks for the models of every provider with a `modelPattern`, from OpenRouter's public model list (Artificial Analysis and Design Arena results), cached for 6 hours. `{ retrievedAt, stale, error, stats, pool, providers, models, sessions }`: `stats` describes each benchmark; `providers[id]` is `{ featured, models }`, a provider's model ids newest first; `models[id]` holds a model's name, context and price, and in `stats`, per benchmark, its `value`, `rank`, `level` (0-100, its standing among the models of all configured tools) and `tier` (S 90+, A 75+, B 50+, C 25+, D below); `sessions[id]` is the model id a session's reported model matched, or null. |
| GET | `/news` | | `{ refreshedAt, refreshing, sources, items }`. `items` are the last 30 days of the built-in feeds, newest first, each `{ id, title, url, discussion, summary, source, sourceId, category, publishedAt }` with `category` `news`, `releases` or `research`. A coding tool's own release feed is included only while that tool is installed. `sources` lists each feed with its `error` and the time it last answered. Feeds that are due are re-read in the background; a `news.updated` event follows. |
| GET | `/changelog` | | `{ refreshing, okAt, error, releases }`: Agent Guild's own releases from GitHub, newest first, each `{ version, url, publishedAt, sections: [{ title, changes }] }`, where a change is a list of text runs. Re-read hourly in the background; a `changelog.updated` event follows. |
| GET | `/providers/:id/history?account=&limit=` | | `{ history }`: a History object for one account (default `default`; 404 `unknown_account`), with at most `limit` sessions (default 100, at most 500). 400 `history_unsupported` when the provider has no `historySource`. |
| GET | `/github` | | `{ github }`: a GitHub object. |
| POST | `/github/sign-in` | | `202 { github }`: starts a device-flow sign-in; the manager polls GitHub and announces the result in `github.updated`. |
| DELETE | `/github/sign-in` | | `{ github }`: cancels it. |
| DELETE | `/github/accounts/:id` | | `{ github }`: forgets the account's sign-in. Its key stays in the data folder and on GitHub. |
| GET | `/github/accounts/:id/repos?parent=&refresh=1` | | `{ repos: { accountId, fetchedAt, truncated, owners, parent, repos } }`: the account's repositories, most recently pushed first, each `{ fullName, owner, ownerType, name, private, fork, archived, description, language, pushedAt, url, target, local }`. `owners` is the account's login, then the organizations among the repositories' owners: where a new repository can be created. With `parent` (a folder; 400 `bad_cwd` when it does not exist), `target` is `<parent>/<name>` and `local` is `absent`, `cloned` (a Git repository whose origin is this repository) or `conflict`. Cached for 5 minutes unless `refresh=1`. |
| POST | `/github/accounts/:id/repos` | `{ owner, name, description?, private?, readme? }` | `201 { repo }`: creates a repository under the account or the organization `owner`, private unless `private` is false, with a README unless `readme` is false. 409 `repo_exists`, 403 `repo_forbidden` when GitHub refuses the owner. |
| GET | `/github/repos?refresh=1` | | `{ repos, truncated, errors, fetchedAt }`: every signed-in account's repositories in one list, most recently pushed first, each a repository as above without `target` and `local`, plus `accountId` and `login`. A repository two accounts can see is listed for each. An account that fails adds `{ accountId, login, code, message }` to `errors` and leaves the others' repositories in place. `fetchedAt` is the oldest account list's time, null without accounts. |
| GET | `/github/origin?cwd=` | | `{ folder, repo }`: `repo` is the lowercase `owner/name` of the GitHub origin of the Git work tree holding `cwd`, worktrees included, else null. 400 `bad_cwd` when the folder does not exist. |
| GET | `/github/accounts/:id/repos/:owner/:name/issues?state=` | | Repository issues (see Repository views). `state` is `open` (default), `closed` or `all`; 400 `bad_state` otherwise. |
| POST | `/github/accounts/:id/repos/:owner/:name/issues` | `{ title, body? }` | `201 { issue }`. 400 `bad_title` for an empty title, `bad_body` when `body` is not a string. The title is cut to 256 characters, the body to 48,000. |
| PATCH | `/github/accounts/:id/repos/:owner/:name/issues/:number` | `{ title?, body?, state? }` | `{ issue }`. `state` is `open` or `closed`. 400 `bad_issue`, `bad_state`, or `bad_request` when nothing is given. |
| GET | `/github/accounts/:id/repos/:owner/:name/actions` | | Workflow runs (see Repository views). |
| GET | `/github/accounts/:id/repos/:owner/:name/branches?page=` | | Remote branches, up to 100 per page. Follow `nextPage` until null; see Repository views. |
| GET | `/github/accounts/:id/repos/:owner/:name/pulls` | | Open pull requests (see Repository views). |
| POST | `/github/accounts/:id/ssh` | | `{ account }`: makes the account's SSH key if it has none, adds it to the account, and checks that GitHub signs it in as this account. A failure is reported in `account.ssh.error`. |
| POST | `/github/clone` | `{ account, repo, parent }` | `201 { session }`: a session with `task` `clone` running `git clone` for `repo` (owner/name) into `<parent>/<name>` over SSH with the account's key. 409 `ssh_not_ready`, `git_unavailable`, `clone_exists` or `folder_conflict` (both with `target`), or `clone_in_progress`. |
| GET | `/sessions` | | `{ sessions: Session[] }` |
| POST | `/sessions` | `{ providerId, account?, shell?, cwd?, cols?, rows?, name?, args?, resume? }` | `201 { session }`. 409 `install_in_progress` while the provider's tool is being installed, updated or uninstalled. 409 `shell_unavailable` when `shell` is not one of the provider's `shells`; 400 `bad_shell` when the provider has none or `shell` is not a string. |
| GET | `/sessions/:id` | | `{ session }` |
| PATCH | `/sessions/:id` | `{ name }` | `{ session }`. `name` must be a non-empty string; it is trimmed to 80 characters. |
| POST | `/sessions/:id/stop` | | Ends the process. The session stays listed as exited. |
| POST | `/sessions/:id/reattach` | | `{ session }`: runs an exited tmux or herdr session's multiplexer client again, keeping the session's id, report token and screen. 400 `not_reattachable` for any other session, 409 `session_running` while it runs, 409 `multiplexer_session_gone` while `multiplexer.reattachable` is false or once the multiplexer no longer has its session. The client starts in the session's `cwd`, or in the home folder once that folder is gone. |
| DELETE | `/sessions/:id` | | Ends the process if needed and removes the session. |
| POST | `/sessions/:id/agents` | Agent report | `{ agent }`, or `{ agent: null }` after a removal, for a `done` report about an agent that was never reported, or for `{ finishForeground: true }`, which ends the commands of the turn that just ended. |
| POST | `/sessions/:id/model` | `{ model, displayName? }` | `{ model }`. Sets the session's model with source `report`. |
| POST | `/sessions/:id/tool-session` | `{ toolSessionId }` | `{ toolSessionId }`. Records the id the tool gave its own session: one printable line of at most 200 characters. 409 once the session has exited. |
| POST | `/sessions/:id/reporting` | | `{ reporting }`: the tool's hooks announce themselves, which makes `reporting.state` `active`. |
| POST | `/sessions/:id/shells` | `{ shell, key \| task, match?, agentId?, scope?, persist?, endsWithAgent?, kind?, tasks? }` | `{ ok }`. `shell` is `start`, `end`, `background` (with the tool's `task` id), `waiting` (a permission request, which hides the command), `asked` (one that ends the command with its turn), `running` (`tasks` lists the background tasks still running as `{ id, kind? }`; any other ends, and a listed `monitor` promotes a command while a listed `shell` never demotes a monitor) or `reset` (every command ends, or with `scope` only the commands started with that `scope`). `key` is the tool's call id. `match` is a hash of the command, which pairs a permission request with it; `persist` keeps a command past the end of its turn, and `endsWithAgent` ends a background one with its sub-agent. `kind` is `shell` (default) or `monitor`, a background watch; the session lists each as `{ id, kind }`. |
| POST | `/sessions/:id/docker` | `{ launch, event, sessionId, agentName?, toolName?, toolUseId?, match?, model? }` | `{ ok }`. One Docker Agent hook event, as `agent-guild-report --hook --docker` sends it. `launch` is the nonce in the hook arguments Agent Guild passed when it started the session; only events that carry it can say which of Docker Agent's sessions are the card's, and the manager tells its tabs and sub-agents apart from Docker Agent's session store. 400 for a session started without those hooks. |
| POST | `/shutdown` | `{ force?, restart? }` | `202 { ok, running, restart }`: stops the manager and every session, detaching tmux and herdr sessions rather than ending them. 409 `sessions_running` (with `running`, the count of sessions it would end) while any session other than a tmux or herdr one is running, unless `force` is true. With `restart`, 409 `pty_unavailable` first when the new manager could not run a terminal, which happens when an upgrade replaced a node-pty compiled on this computer (see `ptyBuild` under [Upgrade](#upgrade)); the message says what to run, and nothing is stopped. From the 202 on, `POST /sessions` and `POST /providers/:id/install` answer 503 `manager_stopping`. Events clients get `manager.stopping` first and `manager.stopped` last, after the sessions have ended and before the API closes. With `restart` true, the manager then starts a new manager from the package on disk, on the same port and with the same token, before it exits; the new one runs whatever version is installed, so this is how an upgrade's `pendingVersion` is put to use. Clients reconnect to it as to any manager; its `hello` is the new source of truth. |

`cwd` defaults to the user's home folder and must be an existing folder. A
leading `~` is expanded. `args` are appended to the provider's configured
arguments. `resume` is an id or name of one of the tool's own sessions; it is
substituted for `{id}` in the provider's `resumeArgs` (400 `resume_unsupported`
when the provider has none). `account` is one of the provider's account ids
(404 `unknown_account` otherwise) and defaults to `default`; the account's
home folder is created before its first session.

`POST /sessions/:id/agents`, `POST /sessions/:id/model`,
`POST /sessions/:id/tool-session`, `POST /sessions/:id/reporting`, `POST /sessions/:id/shells` and `POST /sessions/:id/docker` also accept the
per-session report token instead of the API token, in an
`X-Agent-Guild-Report-Token` header. The manager gives that token only to the
processes inside that session. Without the API token, an unknown session id
and a wrong report token both return 401.

Request bodies are limited to 64 KB (413 above that), except `PUT /notes`,
which accepts 1 MiB. WebSocket messages are limited to 1 MB.

## WebSockets

Messages in both directions are JSON text frames.

### `GET /api/v1/events`

This socket pushes changes to every session. It is server-to-client only.

| Message | Meaning |
| --- | --- |
| `{ type: "hello", version, pid, platform, startedAt, launcher, folderOpener, upgrade, sessions, notesRevision, notesUnreadable }` | Sent first. The manager's version, pid, platform and start timestamp (together identifying this manager lifetime), its `launcher` path and `folderOpener` (as in `/info`), the full session list and the manager's Upgrade object. `notesRevision` is the notepad's current revision, or null when notes have never been stored. It is omitted when the notes file cannot be read; `notesUnreadable` is then true. The manager reads the file again for each new connection, so fixing or removing it needs no restart. |
| `{ type: "session.created", session }` | A session was started by any client. |
| `{ type: "session.updated", session }` | Status, activity, agents, name or size changed. |
| `{ type: "session.removed", sessionId }` | A session was removed. |
| `{ type: "providers.updated", providers }` | The provider list changed: a version check finished, `providers.json` was reloaded, or an install session ended. |
| `{ type: "environment.updated", environment }` | Environment refresh started or finished. The full snapshot and revision allow clients to ignore stale HTTP responses. |
| `{ type: "news.updated" }` | A news refresh finished; fetch `/news` again. |
| `{ type: "changelog.updated" }` | A refresh of the release list finished; fetch `/changelog` again. |
| `{ type: "github.updated" }` | A GitHub sign-in, account or SSH setup changed; fetch `/github` again. |
| `{ type: "notes.updated", notes }` | The notepad was saved. `notes` is `{ revision, text }`. The page that saved it already has this text. |
| `{ type: "manager.upgrade", upgrade }` | The manager's own version check changed: a newer release was found, or an upgrade session ended. |
| `{ type: "manager.stopping", running, restart }` | A client asked the manager to stop. `running` sessions are being ended. A client should show that the manager was stopped on purpose, not that it is unreachable. `restart` is true when a new manager will take over; a client should then say it is waiting for that one rather than tell the user how to start one. |
| `{ type: "manager.stopped", remaining, restart }` | The last event before the socket closes. `remaining` is how many session processes had not confirmed their exit when the manager gave up waiting (about five seconds); 0 means every session has ended. `restart` is as in `manager.stopping`. A socket that closes after `manager.stopping` without this event means the manager went away before it could confirm. |

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
