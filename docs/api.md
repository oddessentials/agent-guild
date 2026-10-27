# Session manager API (v1)

The session manager is the only component that owns terminal processes. The
web page is one client of this API. Any other front end, such as a future
Unreal Engine interface, can use the same API to list, start, watch and drive
the same sessions at the same time.

This is the contract a client relies on. How the manager works out each value
is in the code (see [architecture.md](architecture.md)). A running manager
serves this doc at `/api.html`, where its read-only routes and sockets can be
tried.

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

* `manager.json` exists while a manager runs. It holds `pid`, `host`, `port`,
  `url`, `version` and `startedAt`.
* `auth-token` holds the API token. It persists across restarts. Delete it to
  rotate the token.

Every endpoint except `GET /api/v1/health` requires the token:

```
Authorization: Bearer <token>
```

WebSocket clients that cannot set headers, such as browsers, pass
`?token=<token>` in the URL instead.

A device that cannot scan the page's sign-in QR code, such as a TV, obtains
the token by device sign-in: `POST /sign-in` answers a code to show on screen
and a `device` secret, the person approves the code in the page's
**Remote access** dialog, and `POST /sign-in/poll` with that secret then
answers the token once. Requests expire after five minutes; at most five are
live, and a new one is accepted every two seconds.

The manager rejects requests whose `Host` or browser `Origin` is outside
its loopback and saved remote-access allowlists. Native clients that send no
`Origin` still need an accepted Host and the API token. See
[remote access setup](configuration.md#reverse-proxies).

Errors use one shape:

```json
{ "error": { "code": "provider_unavailable", "message": "Codex CLI (\"codex\") was not found on PATH. ..." } }
```

`message` is written for people. The codes below are the ones a client acts
on; any route can answer others.

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
  "memorySource": "claude",
  "accounts": [{ "id": "default", "label": "Default" }, { "id": "work", "label": "Work" }],
  "color": "#D97757",
  "monogram": "A",
  "iconUrl": null,
  "install": "curl -fsSL https://claude.ai/install.sh | bash",
  "docs": "https://code.claude.com/docs/en/setup",
  "usageUrl": "https://claude.ai/settings/usage",
  "billingUrl": "https://claude.ai/settings/billing",
  "cloudUrl": "https://claude.ai/code",
  "available": true,
  "resolvedPath": "/usr/local/bin/claude"
}
```

`available` is false when the command is not installed. A client should show
the provider as disabled and offer `POST /providers/:id/install` when
`installable` is true, or the `install` hint otherwise. `resumable` is true
when one of the tool's own earlier sessions can be resumed by id.

`installedVersion` and `latestVersion` are null until the first version check
finishes; a `providers.updated` event follows. `updateAvailable` is true when
the latest version is newer, and `POST /providers/:id/install` performs the
update when `updateCommand` is not null. `versionStatus` is `ok`,
`unavailable` (the tool printed no version) or `failed`, with `versionError`
saying why, and null while the tool is missing. `installChannel` is the
running copy's `channel`, or null. `lastInstall` is the last install, update
or uninstall session's result,
`{ kind, outcome, exitCode, verification, before, after, latest, at }`, with
`outcome` `installed`, `missing`, `updated`, `unchanged`, `done`, `removed`,
`remaining` or `failed`, and `at` in epoch milliseconds; or null. `warnings`
are lines the card shows about the copies, such as several being installed.
`npmNote` qualifies an npm install, or is null. `modelPattern` is the
provider's, or null. `reporting` is the tool's reporting mode: `claude`,
`codex`, `antigravity`, `grok`, `docker`, or null.

`installs` lists every copy of the tool that was found, each
`{ path, displayPath, channel, version, versionStatus, active, newer, onPath, uninstall, uninstallGuidance }`.
`channel` is `npm`, `native`, `brew`, `winget`, `legacy` or `unknown`, and for
a Docker CLI plugin `download`, `desktop`, `system` or `unknown`. `active`
marks the copy that runs, `newer` a copy newer than that one, and `onPath`
whether its folder is on PATH. `uninstall` is null when Agent Guild cannot
remove that copy, and `uninstallGuidance` then says how to remove it instead.
`POST /providers/:id/uninstall` removes one copy.

For a tool that is a Docker CLI plugin (Docker Agent), `installCommand` is the
command **Install** and **Update** run. `pluginError` says why docker could not
list the plugin's copies, or is null; `pluginPending` is true until docker has
listed them once.

`usageSource`, `historySource`, `memorySource` and `instructionsSource` are
null when `GET /usage`, `GET /providers/:id/history`,
`GET /providers/:id/memory` or `GET /providers/:id/instructions` cannot report
the tool. `historyDetails` is true when `GET /providers/:id/history/detail`
can read saved messages. `accounts` lists the sign-ins the tool can run
under: `default` is the tool's own, and each further one has its own home
folder, so it keeps its own sign-in and usage. `POST /sessions` takes an
account id. `accountsEditable` is true when accounts can be added, renamed
and removed through `/providers/:id/accounts`.

`shells` is null except for the `@shell` provider, where it lists the
installed shells, each `{ id, label, path, multiplexer }`, and `defaultShell`
is the id of the one a session runs unless `POST /sessions` names another in
`shell`. `multiplexer` is true for tmux and herdr, which are never the
default. Stopping or removing a session in one, or stopping the manager,
leaves the multiplexer's own session running, and
`POST /sessions/:id/reattach` attaches it again, also from the next manager.
`multiplexers` is `[]` for every provider but `@shell`; see
[Multiplexer installations](#multiplexer-installations).

For a tool whose agent or model reporting has to be turned on,
`reportingEnabled` says whether it is, and `reportingNote` says why that switch
cannot be used, or is null. `usageUrl`, `billingUrl` and `cloudUrl` are
`https://` links to the vendor's usage and billing pages and web app, or null.

### Manager environment

`GET /environment?scope=` returns the cached snapshot of a scope and starts
its first check if none has finished. `POST /environment/refresh` with
`{ scope, cwd?, id? }` starts a new check and returns `202` at once; an
`environment.updated` event carries the snapshot when it changes. `scope` is:

* `manager` (the default): what the manager process finds on its PATH.
* `project`, with `cwd`: the version pin files in that folder, read without
  running anything.
* `session`, with `id`: the PATH recorded when that session was spawned.
* `launch`: the manager's PATH, as a new process gets it before shell startup
  files.

Every snapshot has `scope`, `host` (the computer running the manager),
`revision`, `refreshing`, `checkedAt` and `error`, which is null or says why
the check itself did not finish. A refresh keeps the previous results while
`refreshing` is true.

A project snapshot adds `cwd`, `stale` and `pins[]`, each
`{ id, label, source, version, status, detail }` with `status` `configured`,
`unreadable` or `invalid`. `configured` means the file asks for that version,
not that it is installed. A session snapshot adds `sessionId`, `spawnCwd` and
`availability`: `ok`, or `unavailable` for tmux and herdr.

The manager snapshot adds `platform`, `managerNode: { version, path }`,
`system`, `runtimes[]`, `designTools[]`, `docker` and `tools[]`. Session and
launch snapshots have `docker` but not `system`; a tmux or herdr session has
`docker: null`.

* `runtimes[]`: Node.js, Python, Go, .NET SDK, R and Rust, each with `id`,
  `label`, `status`, `version` and `path`, and once checked `command` and an
  optional `detail`. `status` is
  `pending`, `ok`, `not_found`, `unavailable` (a launcher exists but no
  runtime can be safely reported) or `failed`. Python may add
  `alternatives[]`, and .NET `runtimes[]`.
* `designTools[]`: Blender, FFmpeg, GIMP, Inkscape and ImageMagick, each with
  `id`, `label`, `status`, `version` and `path`, and once checked `command`
  and `detail`.
  `status` is `pending`, `on_path`, `not_on_path` (installed outside PATH),
  `not_found` or `failed`.
* `tools[]`: `{ id, label, path, status: "detected" }` for nvm, NVM for
  Windows, vfox, uv and pnpm.
* `system`: null until the first check finishes or when it cannot be read,
  else `{ os, osDetail, arch, hostArch, cpu: { model, threads }, memory, wsl, wslDistributions }`.
* `docker`: `{ status, version, platform, os, arch, wsl2, context, endpoint, cli, detail }`,
  with `status` `pending`, `running`, `stopped`, `not_found`, `denied`,
  `remote` or `failed`. Fields other than `status` may be missing.

Probe output and the environment itself are never returned.

### Multiplexer installations

An `@shell` provider also describes `multiplexers[]`. Each entry contains
`id` (`tmux` or `herdr`), `tool`, `docs`, `checked`, `available`,
`installable`, `installCommand`, `guidance`, `busy`, `pendingCards`,
`installs` and `lastInstall`; some are missing while `checked` is false.
Each copy in `installs` has the provider-copy fields except `newer`, and its own
`latestVersion`, `updateAvailable` and `updateCommand`. Never construct
commands from these fields: submit the returned `path` to the API.

These routes return `201 { session }`, with `task: "install"`:

| Route below `/api/v1` | Body |
| --- | --- |
| `POST /providers/:provider/multiplexers/:id/install` | `{ force?: boolean }` |
| `POST /providers/:provider/multiplexers/:id/update` | `{ path: string, force?: boolean }` |
| `POST /providers/:provider/multiplexers/:id/uninstall` | `{ path: string, force?: boolean }` |

409 `multiplexer_in_use`, with `running` and `pending` counts, can be retried
with `force: true` after the user confirms. Herdr Uninstall refuses with 409
`herdr_running` while herdr has a session running; `force` does not bypass
that. Results arrive through `providers.updated`.

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

One snapshot per account. Each window is one rate limit of the account's
subscription. `plan` is the subscription tier. `credits` is a prepaid credit
balance (Codex), or null. When the lookup failed, `windows` is empty and
`error` says why; `signedIn` is false when no sign-in was found for that
account, true when one was read, and null when that is unknown.
`rateLimited` is true when the vendor rate-limited the lookup.

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

The tool's own earlier sessions, newest first. `id` is what the tool resumes
by (`POST /sessions` with `resume`); `title` is the session's name or first
prompt, or null; `cwd` is the folder the session ran in, or null. Claude Code
finds a session only from its own folder, so resume with that `cwd`.
`sessions` holds at most `limit` entries of the `total` found. `error` says
why nothing could be listed; a tool that has never run lists no sessions and
no error. Antigravity CLI entries add `workspaces`, and its history may add a
`note`.

The optional `cwd` and `q` parameters filter by folder and by text (title, id
or folder) **before** applying `limit`; `total` counts matching entries.

#### Saved messages

`GET /providers/:id/history/detail?account=&id=&cursor=` returns:

```json
{
  "detail": {
    "id": "581893e5-a93d-5e49-968b-1c1c277d3255",
    "messages": [{ "role": "user", "text": "Fix the login bug" }],
    "nextCursor": null,
    "incomplete": false,
    "omitted": false
  }
}
```

Only the user's requests and the visible answers are included, as plain text.
Follow `nextCursor` until it is null, even when a page has no visible
messages. `omitted` says records were left out; `incomplete` says the last one
was partial, and a later read may complete it. 409 `history_changed` means the
transcript changed: start again without a cursor.

### Memory

```json
{
  "providerId": "xai",
  "accountId": "default",
  "folder": "/Users/me/src/app",
  "scopes": [
    { "id": "project", "label": "This project", "dir": "/Users/me/.grok/memory-v2/workspaces/app-1c1b5e9a", "note": null, "truncated": false,
      "files": [{ "path": "topics/build.md", "fullPath": "/Users/me/.grok/memory-v2/workspaces/app-1c1b5e9a/topics/build.md", "folder": "/Users/me/.grok/memory-v2/workspaces/app-1c1b5e9a/topics", "title": "Build", "bytes": 2048, "modified": "2026-10-01T13:49:28.000Z" }] },
    { "id": "global", "label": "Global", "dir": "/Users/me/.grok/memory-v2/global", "note": null, "truncated": false, "files": [] }
  ],
  "fetchedAt": "2026-10-01T14:00:00.000Z"
}
```

The markdown files a tool keeps as memory for the working folder `folder`,
in the scopes that tool has. `dir` is null when the tool keeps no memory
there, and `note` says why, or anything else that qualifies the scope. A
file's `path` is relative to `dir`, `fullPath` is its full path and `folder`
the folder that holds it; `title` is its first `# ` heading, or null.
`truncated` says the scope has more files than were listed.

### Instruction files

```json
{
  "providerId": "anthropic",
  "accountId": "default",
  "folder": "/Users/me/src/app",
  "count": 2,
  "note": null,
  "scopes": [
    { "id": "global", "label": "Your instructions", "note": null,
      "files": [{ "index": 0, "path": "/Users/me/.claude/CLAUDE.md", "folder": "/Users/me/.claude", "name": "CLAUDE.md", "location": "~/.claude", "scope": "global", "bytes": 512, "modified": "2026-10-01T13:49:28.000Z", "skipped": null, "note": null }] },
    { "id": "project", "label": "Project", "note": null,
      "files": [
        { "index": 1, "path": "/Users/me/src/app/CLAUDE.md", "folder": "/Users/me/src/app", "name": "CLAUDE.md", "location": "app", "scope": "project", "bytes": 2048, "modified": "2026-10-01T13:49:28.000Z", "skipped": null, "note": null },
        { "index": 2, "path": "/Users/me/src/app/AGENTS.md", "folder": "/Users/me/src/app", "name": "AGENTS.md", "location": "app", "scope": "project", "bytes": 900, "modified": "2026-10-01T13:49:28.000Z", "skipped": "Claude Code reads CLAUDE.md instead.", "note": null }
      ] }
  ],
  "fetchedAt": "2026-10-01T14:00:00.000Z"
}
```

The files a tool loads when a session starts in `folder`: managed and global
files first, then project files from the outermost folder down.
`scope` is `managed`, `global` or `project`, and `location` is the file's
folder in short. `count` is the number of files that load; a file that exists
but does not load has `skipped` set to the reason, and a file's `note`
qualifies one that loads only in part. A scope's `note` says why it lists no
files. When the tool cannot be asked, `count` is null, `scopes` is empty and
`note` says why.

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
  "label": "Working",
  "lastOutputAt": "2026-09-30T03:12:01.120Z",
  "createdAt": "2026-09-30T03:10:44.001Z",
  "startedAt": "2026-09-30T03:10:44.001Z",
  "exitedAt": null,
  "cols": 120,
  "rows": 32,
  "attachedClients": 1,
  "model": { "name": "claude-opus-4-5", "displayName": "Opus 4.5", "source": "report" },
  "toolSessionId": "581893e5-a93d-5e49-968b-1c1c277d3255",
  "context": { "compactions": 2, "resets": 0 },
  "reply": { "id": 3 },
  "reporting": { "state": "active", "reason": null },
  "agents": [ /* Agent */ ],
  "shells": [{ "id": "shell-3", "kind": "shell" }]
}
```

* `status` is `running` or `exited`. Exited sessions stay listed, with their
  final screen, until a client removes them.
* `exitedAt` is null while running, then when the process exited.
* `pid` is null while the process is still starting and after it exits.
* `activity` is `active` while the terminal is producing output and `quiet`
  after a short pause.
* `label` is what the session's card shows, for any client to show the same:
  `Working` while running and `active`, else `Running`. Once exited, it is
  `Closed` for a tmux or herdr session, `Exited (<signal>)` when a signal ended
  it, `Exited (<exit code>)` for an exit code other than 0, and otherwise `Exited`.
* `resume` is the id of the tool's own session that was resumed, or null.
* `task` is `install` for a session that installs, updates or uninstalls a
  tool, `upgrade` for the session that upgrades the manager (its
  `provider` id is `agent-guild`), `clone` for a `git clone` (its `provider`
  id is `github`), and null for a session that runs the tool itself.
* `clone` is `{ repo, path, accountId }` for a clone session, else null.
* `multiplexer` is `{ label, attach, reattachable }` for a Shell session in
  tmux or herdr: the multiplexer's name, the command that reattaches its
  session from a terminal, and whether the exited session can be reattached.
  Null otherwise.
* `startedAt` is when the session's current process started: `createdAt`,
  or later once a tmux or herdr session is reattached.
* `account` is the provider account the tool runs under, or null for an
  install or upgrade session.
* `model` is the main model the tool is using, or null while unknown.
  `source` is `report`, `screen` or `args`.
* `toolSessionId` is the id the tool gave its own session, or null. It names
  the session in `GET /providers/:id/history`.
* `context` counts the times the tool compacted its context and started over
  in a new session (`/clear`, `/new`) since the card started.
* `reply` names the answer that ended the agent's last turn by `id`, or is
  null. Its text is read with `GET /sessions/:id/reply`.
* `reporting` says whether the tool's reporting hooks work, or is null for a
  tool Agent Guild supplies no hooks to. `state` is `pending`, `active`,
  `unavailable`, `setup_required` or `unsupported`; `reason` explains every
  state but `active`.
* `shells` lists the shell commands the tool is running, each `{ id, kind }`
  with `kind` `shell` or `monitor`. Nothing about the command itself is
  included.

### Upgrade

The manager's own version check, in `GET /info`, the `hello` message and
`manager.upgrade` events.

```json
{
  "version": "1.2.0",
  "latestVersion": "1.3.0",
  "available": true,
  "command": "/usr/local/bin/npm install -g --prefix /usr/local @oddessentials/agent-guild@1.3.0",
  "guidance": null,
  "pendingVersion": null,
  "installing": false,
  "lastInstall": null,
  "ptyBuild": null
}
```

`version` is the running manager. `available` is true when a newer release
can be installed; `command` is then what `POST /upgrade` runs, or null with
`guidance`. `pendingVersion` is a newer version already on disk, which runs
after a restart (`POST /shutdown` with `restart`). `lastInstall` is the last
upgrade session's `{ outcome, exitCode, version, installedVersion, at }`, or
null. `installing` is true while an upgrade runs, and `available`, `command`,
`guidance`, `pendingVersion`, `lastInstall` and `ptyBuild` are withheld until
it ends.

After the upgraded manager starts, refresh every open browser page.
Reconnecting does not reload a page's JavaScript, and stale frontend code is
not guaranteed to work with the new manager.

`ptyBuild` is null where node-pty runs from its bundled builds. Elsewhere,
such as Alpine, it is `{ command, built }`: the command that compiles
node-pty, and whether that build is on disk. `POST /shutdown` with `restart`
answers 409 `pty_unavailable` until it is.

### GitHub

The GitHub accounts signed in to Agent Guild, in `GET /github`. Tokens never
leave the manager.

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
once GitHub refuses the account's token. `ssh.status` is `none`, `unverified`
or `ready`. `ssh.error` is `{ code, message, manual }`, with `manual` true
when the user must add `publicKey` on GitHub themselves.

### Repository views

Issues, workflow runs and open pull requests of one repository, read with one
signed-in account. Each list holds one page of GitHub's results;
`truncated` is true when GitHub has more.

```json
{ "issues": [{ "number": 4, "title": "Dock is too narrow", "body": "Steps", "state": "open", "user": "octo-cat", "comments": 2, "updatedAt": "2026-10-01T00:00:00.000Z", "url": "https://github.com/octo-cat/agent-guild/issues/4" }],
  "truncated": false, "url": "https://github.com/octo-cat/agent-guild/issues" }
{ "runs": [{ "id": 11, "name": "CI", "title": "Fix the gate", "branch": "main", "event": "push", "status": "in_progress", "conclusion": null, "runNumber": 12, "updatedAt": "2026-10-02T00:00:00.000Z", "url": "https://github.com/octo-cat/agent-guild/actions/runs/11" }],
  "running": true, "service": null, "truncated": false, "url": "https://github.com/octo-cat/agent-guild/actions" }
{ "pulls": [{ "number": 8, "title": "Add viewer", "draft": true, "user": "ada", "head": "viewer", "base": "main", "updatedAt": "2026-10-02T00:00:00.000Z", "url": "https://github.com/octo-cat/agent-guild/pull/8" }],
  "truncated": false, "url": "https://github.com/octo-cat/agent-guild/pulls" }
```

`running` is true while any listed run has not finished. `service` is null
while GitHub reports Actions operational or its status cannot be read, else `{ status, incident, url }`
from githubstatus.com. 409 `github_sign_in` means the account must sign in
again.

Branches come a page at a time, as
`{ branches, nextPage, defaultBranch, metadataError, fetchedAt, url }`, each
branch `{ name, sha, protected, url }`. Follow `nextPage` until it is null,
even after a short or empty page. Only page one has `defaultBranch`;
`metadataError` says why it could not be read.

Activity is the account's own work in the repository from `since` (an ISO
8601 time) on:

```json
{ "since": "2026-10-01T00:00:00.000Z",
  "merged": [{ "repo": "octo-cat/agent-guild", "number": 8, "title": "Add viewer", "mergedAt": "2026-10-02T00:00:00.000Z", "url": "https://github.com/octo-cat/agent-guild/pull/8" }],
  "closed": [{ "number": 4, "title": "Dock is too narrow", "closedAt": "2026-10-02T00:00:00.000Z", "url": "https://github.com/octo-cat/agent-guild/issues/4" }],
  "passed": [{ "id": 11, "name": "CI", "branch": "main", "event": "push", "createdAt": "2026-10-02T00:00:00.000Z", "url": "https://github.com/octo-cat/agent-guild/actions/runs/11" }],
  "truncated": false }
```

`merged` are pull requests the account opened that were merged at or after
`since`, in the repository or, for a fork, from it into its parent (`repo`
says which). `closed` are issues the account closed as completed at or after
`since`. `passed` are workflow runs created at or after `since` by the
account that succeeded. A run created earlier does not count even if it
ran, or was re-run successfully, later. Accounts are matched by GitHub's
numeric user id; the login used to query runs is refreshed first.

Each listing reads at most three pages of 100, and at most 20 candidate
issue closures are checked. `truncated` is true when a cap leaves more to
examine, so matching work may be missing. Listings are read newest first
by update time for pull requests and issues, and creation time for runs.
An empty list is what GitHub returned; during a GitHub service incident it
has returned empty lists that were not complete, so it is not proof of no
activity.

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
as `done` stays visible for a few seconds and is then removed. `source` is
`api` for a report over HTTP, `terminal` for one written to the terminal, and
`herdr` for an agent in a herdr session's panes. All agents are cleared when
their session exits.

## HTTP endpoints

All paths are under `/api/v1`.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/health` | | `{ ok, name, version, pid }`. No token needed. |
| POST | `/sign-in` | | `201 { signIn: { code, device, expiresAt, interval } }`: a device sign-in to show as `code` and poll with `device` every `interval` seconds. No token needed. 429 `sign_in_busy` while five are live or one was made under two seconds ago. |
| POST | `/sign-in/poll` | `{ device }` | `{ signIn: { status } }`: `pending`, `approved` with `token`, or `denied`. An approved or denied answer is given once; after it, and after `expiresAt`, 404 `sign_in_unknown`. No token needed. |
| GET | `/sign-in` | | `{ signIn: { requests } }`: the pending device sign-ins, each `{ code, requestedAt, expiresAt }`. |
| POST | `/sign-in/approve` | `{ code }` | `{ signIn }` as above, after approving that code. 404 `sign_in_unknown` when no pending sign-in has it. |
| POST | `/sign-in/deny` | `{ code }` | `{ signIn }` as above, after denying it. |
| GET | `/info` | | `name`, `version`, `pid`, platform, start time, provider config warnings, `upgrade` (an Upgrade object), `launcher` (the double-click launcher in a checkout, else null), `folderOpener` (`{ available, label, reason }` for this client) and `remoteAccess` (`{ available: true }` when this manager can configure it, else null). |
| GET | `/remote-access` | | `{ remoteAccess }`: `revision`, `mode`, `busy`, `pending`, `problem` and connection details. `url` is the active address. `candidate` is the address enabling would use with Tailscale's current settings, `{ url, existing, remembered, standardUrl? }`: `remembered` when it is the address used before, and `standardUrl` when `standard: true` would choose another. |
| POST | `/remote-access/check` | | `{ remoteAccess }` after refreshing Tailscale's status. |
| PUT | `/remote-access` | `{ revision, action, adopt?, hosts?, origins? }` | `202`. `action` is `enable` (`adopt: true` manages a matching existing route; `standard: true`, only while remote access is off, skips the remembered address and takes port 443, else the next free port), `disable`, `custom` (with `hosts` and `origins`) or `forget` (leave an inactive route awaiting cleanup in Tailscale). Poll until `busy` is null and read `problem`. 409 `stale_settings` for an old `revision`. Needs the API token. Revoked WebSockets close with code 4403; their terminals keep running. |
| GET | `/folders?path=` | | `{ path, parent, home, segments, roots, entries, truncated, note }`: the subfolders of `path` (blank or `~` for the home folder). `entries` are `{ name, path, hidden }`. A missing `path` lists the nearest folder above it and names the requested path in `note`. |
| POST | `/folders` | `{ path, name }` | 201 with the `GET /folders` listing of the new folder `name`, made inside `path`. |
| GET | `/autostart` | | `{ autostart: { available, enabled, reason, note?, lastRun?, log? } }`: whether the manager starts when the user signs in. `reason` says why it is unavailable. `lastRun` is null or `{ at, outcome }`. On Linux outside WSL it also has `mode` (`off`, `sign-in`, `boot` or `both`) and `boot`, the systemd service's `{ available, enabled, reason, note, user, linger, state, commands }`. |
| PUT | `/autostart` | `{ enabled }` or `{ mode }` | `{ autostart }` as above. `mode` (`off`, `sign-in` or `boot`) makes that the one way the manager starts; `boot` is offered only on Linux with systemd. |
| POST | `/open-folder` | `{ cwd? }` | `{ ok }`: opens the folder in the computer's file manager. 403 `local_only` from clients that reach the manager by any address other than its own loopback ones. |
| GET | `/notes` | | `{ notes: { revision, text } }`. One notepad for every client of this manager. `revision` is null until the first save. |
| PUT | `/notes` | `{ revision, text }` | `{ notes }` with a new `revision`. `revision` is the one this edit started from, or null to create the notepad. 409 `stale_notes` when that revision is no longer current; `error.notes` is the current notepad, so a client can retry or adopt it. |
| POST | `/upgrade` | | `201 { session }`: a session with `task` `upgrade` running the Upgrade `command`. Sessions keep running; the new version is used after the manager restarts. |
| GET | `/providers` | | `{ providers: Provider[], revision }`. `revision` identifies the contents of `providers.json`, or is null when there is no file. |
| POST | `/providers/reload` | | `{ providers, revision, warnings }`: re-reads `providers.json` and checks every tool's versions again. New sessions use the new settings. |
| POST | `/providers/:id/accounts` | `{ label, revision }` | `201 { account, dir, providers, revision }`: adds an account to `providers.json`. Its id is made from `label` and does not change. |
| PATCH | `/providers/:id/accounts/:account` | `{ label, revision }` | `{ account, dir, providers, revision }`: renames an account, including `default`. |
| DELETE | `/providers/:id/accounts/:account?revision=` | | `{ account, dir, providers, revision }`: removes an account from `providers.json`. Its home folder, `dir`, stays on disk. 409 `default_account` for `default`; 409 `account_in_use` while a running session uses it. |
| POST | `/providers/:id/reporting` | `{ enabled }` | `{ provider }`: turns agent or model reporting on or off for a tool that has `reportingEnabled`. |
| POST | `/providers/:id/install` | `{ force? }` | `201 { session }`: a session that installs or updates the tool. 409 `provider_in_use` (with `running`, the session count) while the provider's sessions are running; retry with `force: true` after the user confirms. |
| POST | `/providers/:id/uninstall` | `{ path, force? }` | `201 { session }`: a session that removes the copy at `path`, one of the provider's `installs`. `force` as for `install`. |
| GET | `/environment?scope=&cwd=&id=` | | An environment snapshot; see [Manager environment](#manager-environment). |
| POST | `/environment/refresh` | `{ scope?, cwd?, id? }` | `202` with that scope's snapshot. |
| GET | `/usage` | | `{ usage: Usage[] }`, one per account of every provider with a `usageSource`. |
| GET | `/model-stats` | | `{ retrievedAt, stale, error, stats, pool, providers, models, sessions }`: benchmarks for each provider's models, from OpenRouter's public model list. `stats` describes each benchmark; `providers[id]` is `{ featured, models }`; `models[id]` holds a model's name, context, price and, per benchmark, its `value`, `rank`, `place`, `tied`, `of`, `level` (0-100) and `tier` (S to D); `sessions[id]` is the model id a session's model matched, or null. |
| GET | `/news` | | `{ refreshedAt, refreshing, sources, items }`. `items` are the built-in feeds' recent items, newest first, each `{ id, title, url, discussion, summary, source, sourceId, category, publishedAt }` with `category` `news`, `releases` or `research`. `sources` lists each feed as `{ id, name, category, error, okAt }`. A `news.updated` event follows a refresh. |
| GET | `/yard-art` | | `{ yardArt }`: the Yard's art. `state` is `ready`, `missing`, `downloading` (with `received` bytes), `installing`, `failed` or `unavailable` (each with `error`), or `cancelled`; `size` is the pack's size in bytes. A checkout serves `web/yard/assets` and is always `ready`. `/yard/assets/` answers 404 until the art is `ready`. |
| POST | `/yard-art/download` | | `202 { yardArt }`: starts the one download of the art pack named by the package, unless it is running or installed. Progress and the outcome arrive as `yard-art.updated`. |
| POST | `/yard-art/cancel` | | `{ yardArt }`: stops the download for every client; the state becomes `cancelled`. |
| GET | `/changelog` | | `{ refreshing, okAt, error, releases }`: Agent Guild's own releases, newest first, each `{ version, url, publishedAt, sections: [{ title, changes }] }`, where `title` may be null and a change is a list of text runs. A `changelog.updated` event follows a refresh. |
| GET | `/providers/:id/history?account=&limit=&cwd=&q=` | | `{ history }`: a History object for one account (default `default`). |
| GET | `/providers/:id/history/detail?account=&id=&cursor=` | | `{ detail }`; see [Saved messages](#saved-messages). |
| GET | `/providers/:id/flags` | | `{ flags, error }`: the provider's `launchFlags` that its installed tool's `--help` lists, each `{ flag, value, placeholder, about, risky, example }`, where `value` is `required`, `optional` or `none`, `placeholder` and `about` are the tool's own, `risky` marks a flag that skips approvals, and `example` is a sample value or null. `error` says why the help could not be read. |
| GET | `/providers/:id/memory?account=&cwd=` | | `{ memory }`: a Memory object for one account and the working folder `cwd` (the home folder when empty). |
| GET | `/providers/:id/memory/file?account=&cwd=&scope=&path=` | | `{ file: { scope, path, bytes, modified, truncated, text } }`: the start of one listed file. |
| GET | `/providers/:id/instructions?account=&cwd=` | | `{ instructions }`: an Instruction files object for one account and the working folder `cwd` (the home folder when empty). |
| GET | `/providers/:id/instructions/file?account=&cwd=&index=&path=` | | `{ file: { index, scope, path, bytes, modified, truncated, text } }`: the start of file `index` of a freshly resolved list. 404 `instruction_file_gone` when that entry is no longer `path`. |
| GET | `/github` | | `{ github }`: a GitHub object. |
| POST | `/github/sign-in` | | `202 { github }`: starts a device-flow sign-in; `github.updated` events follow. |
| DELETE | `/github/sign-in` | | `{ github }`: cancels it. |
| DELETE | `/github/accounts/:id` | | `{ github }`: forgets the account's sign-in. |
| POST | `/github/accounts/:id/ssh` | | `{ account }`: sets up the account's SSH key on GitHub. A failure is reported in `account.ssh.error`. |
| GET | `/github/accounts/:id/repos?parent=&refresh=1` | | `{ repos: { accountId, fetchedAt, truncated, owners, parent, repos } }`: the account's repositories, most recently pushed first, each `{ fullName, owner, ownerType, name, private, fork, archived, description, language, pushedAt, url, target, local }`. `owners` are where a new repository can be created. With `parent`, `target` is `<parent>/<name>` and `local` is `absent`, `cloned` or `conflict`. |
| POST | `/github/accounts/:id/repos` | `{ owner, name, description?, private?, readme? }` | `201 { repo }`: creates a repository, private unless `private` is false, with a README unless `readme` is false. |
| GET | `/github/repos?refresh=1` | | `{ repos, truncated, errors, fetchedAt }`: every signed-in account's repositories in one list, each with `accountId` and `login`. An account that fails adds `{ accountId, login, code, message }` to `errors`. |
| GET | `/github/origin?cwd=` | | `{ folder, repo }`: `repo` is the lowercase `owner/name` of the GitHub origin of the Git work tree holding `cwd`, else null. |
| GET | `/github/accounts/:id/repos/:owner/:name/issues?state=` | | Issues (see [Repository views](#repository-views)). `state` is `open` (default), `closed` or `all`. |
| POST | `/github/accounts/:id/repos/:owner/:name/issues` | `{ title, body? }` | `201 { issue }`. |
| PATCH | `/github/accounts/:id/repos/:owner/:name/issues/:number` | `{ title?, body?, state? }` | `{ issue }`. `state` is `open` or `closed`. |
| GET | `/github/accounts/:id/repos/:owner/:name/actions` | | Workflow runs (see [Repository views](#repository-views)). |
| GET | `/github/accounts/:id/repos/:owner/:name/branches?page=` | | Branches (see [Repository views](#repository-views)). |
| GET | `/github/accounts/:id/repos/:owner/:name/pulls` | | Open pull requests (see [Repository views](#repository-views)). |
| GET | `/github/accounts/:id/repos/:owner/:name/activity?since=` | | The account's own recent work (see [Repository views](#repository-views)). 400 `bad_since` unless `since` is a time. |
| POST | `/github/clone` | `{ account, repo, parent }` | `201 { session }`: a session with `task` `clone` running `git clone` for `repo` (owner/name) into `<parent>/<name>`. |
| GET | `/sessions` | | `{ sessions: Session[] }` |
| POST | `/sessions` | `{ providerId, account?, shell?, cwd?, cols?, rows?, name?, args?, resume? }` | `201 { session }`. 429 `too_many_sessions` at the session limit. |
| GET | `/sessions/:id` | | `{ session }` |
| GET | `/sessions/:id/reply` | | `{ reply: { id, text, spoken } }`, or `{ reply: null }`: the whole text of the answer `session.reply` names, and `spoken`, the words the page's Read aloud speaks for it: a line per paragraph line, heading, list item and table row, each fenced code block as `Code omitted.` |
| PATCH | `/sessions/:id` | `{ name }` | `{ session }`. |
| POST | `/sessions/:id/stop` | | `{ session }`: ends the process. The session stays listed as exited. |
| POST | `/sessions/:id/reattach` | | `{ session }`: runs an exited tmux or herdr session's multiplexer client again, keeping the session's id and screen. 409 `multiplexer_session_gone` while `multiplexer.reattachable` is false. |
| DELETE | `/sessions/:id` | | `{ ok: true }`: ends the process if needed and removes the session. |
| POST | `/sessions/:id/agents` | Agent report | `{ agent }`, or `{ agent: null }`. |
| POST | `/sessions/:id/model` | `{ model, displayName? }` | `{ model }`. Sets the session's model with source `report`. |
| POST | `/sessions/:id/tool-session` | `{ toolSessionId, source? }` | `{ toolSessionId }`. Records the id the tool gave its own session. A new id with `source` `clear`, `startup` or `new` counts a reset. |
| POST | `/sessions/:id/context` | `{ compaction, key? }` | `{ context }`. Counts a compaction, `manual` or `auto`. A repeated `key`, or with none a report within 2 s of the last, is the same one. |
| POST | `/sessions/:id/reply` | `{ reply }` | `{ reply: { id } }`, or `{ reply: null }`. `reply` is the text of the answer that ended the turn, as Markdown, or null. |
| POST | `/sessions/:id/reporting` | | `{ reporting }`: the tool's hooks announce themselves. |
| POST | `/sessions/:id/docker` | `{ event, sessionId, agentName?, toolName?, toolUseId?, command?, model?, reply? }` | `{ ok }`. One Docker Agent hook event. |
| POST | `/sessions/:id/shells` | `{ shell, key \| task, match?, agentId?, persist?, endsWithAgent?, kind?, tasks? }` | `{ ok }`. A shell command the tool started, ended or put in the background. |
| POST | `/shutdown` | `{ force?, restart? }` | `202 { ok, running, restart }`: stops the manager and every session, detaching tmux and herdr sessions. 409 `sessions_running` (with `running`) while other sessions run; retry with `force: true` after the user confirms. With `restart`, a new manager takes over on the same port and token, running the version on disk. |

`cwd` defaults to the user's home folder, and a leading `~` is expanded.
`args` are appended to the provider's configured arguments. `resume` is an
id or name of one of the tool's own sessions; one that starts with `-` is
refused with 400 `bad_resume`. `account` defaults to `default`.

The `POST /sessions/:id/…` report routes (`agents`, `model`, `tool-session`,
`context`, `reply`, `reporting`, `docker` and `shells`) also accept the per-session
report token instead of the API token, in an `X-Agent-Guild-Report-Token`
header. The manager gives that token only to the processes inside that
session.

Request bodies are limited to 64 KiB, except `PUT /notes`,
`POST /sessions/:id/reply` and `POST /sessions/:id/docker`, which accept
1 MiB. Messages a client sends on a WebSocket are limited to 1 MiB.

## WebSockets

Messages in both directions are JSON text frames.

### `GET /api/v1/events`

This socket pushes changes to every session. A client sends nothing on it
but `{ type: "ping" }`, which the manager answers with `{ type: "pong" }`.

| Message | Meaning |
| --- | --- |
| `{ type: "hello", version, pid, platform, startedAt, launcher, folderOpener, remoteAccess, upgrade, yardArt, sessions, heartbeat, notesRevision, notesUnreadable }` | Sent first: the manager (as in `/info`), the full session list and the notepad's revision. |
| `{ type: "session.created", session }` | A session was started by any client. |
| `{ type: "session.updated", session }` | Status, activity, agents, name or size changed. |
| `{ type: "session.removed", sessionId }` | A session was removed. |
| `{ type: "providers.updated", providers, revision }` | The provider list changed. |
| `{ type: "environment.updated", environment }` | An environment check started or finished. |
| `{ type: "news.updated" }` | Fetch `/news` again. |
| `{ type: "yard-art.updated", yardArt }` | The Yard's art changed state or made download progress, as in `/yard-art`. |
| `{ type: "changelog.updated" }` | Fetch `/changelog` again. |
| `{ type: "github.updated" }` | Fetch `/github` again. |
| `{ type: "remote-access.updated" }` | Fetch `/remote-access` again. |
| `{ type: "sign-in.updated" }` | Fetch `/sign-in` again. |
| `{ type: "notes.updated", notes }` | The notepad was saved. `notes` is `{ revision, text }`. |
| `{ type: "manager.upgrade", upgrade }` | The manager's own version check changed. |
| `{ type: "manager.stopping", running, restart }` | A client asked the manager to stop; `running` sessions are being ended. `restart` is true when a new manager will take over. |
| `{ type: "manager.stopped", remaining, restart }` | The last event before the socket closes. `remaining` is how many sessions had not confirmed their exit. |

After a reconnect, treat `hello` as the new source of truth.

### `GET /api/v1/sessions/:id/terminal`

This socket is the interactive terminal for one session. Any number of
clients may attach to the same session. A client that may size the terminal
adds `page=<id>` to the URL, an id of 1 to 64 letters, digits, `-` or `_` that
names one page load. The terminal has one size: the page that last sent
`claim` owns it, and only that page's `resize` messages under its latest claim
change it. The size stays when the owner disconnects.

Server to client:

| Message | Meaning |
| --- | --- |
| `{ type: "snapshot", data, cols, rows, generation, owner, session }` | Always first. `owner` says whether this page owns the size, and `generation` counts claims. `data` is a VT escape sequence stream that redraws the current screen and scrollback. Reset the terminal and write it. |
| `{ type: "data", data }` | Terminal output, in order, directly after the snapshot. |
| `{ type: "resize", cols, rows, generation, owner }` | The size changed or was claimed, or this page's own `resize` was refused or changed nothing. |
| `{ type: "exit", exitCode, signal }` | The process ended. Also sent after the snapshot when attaching to an exited session. |
| `{ type: "removed" }` | The session was removed. The socket then closes with code 4410. |
| `{ type: "pong" }` | The answer to a client's `ping`. |
| `{ type: "error", code: "not_found", message }` | The session does not exist. The socket then closes with code 4404. |

Client to server:

| Message | Meaning |
| --- | --- |
| `{ type: "input", data }` | Keystrokes or pasted text, exactly as a terminal would send them. |
| `{ type: "claim", cols, rows }` | Take the size for this page and set it. Needs `page`. |
| `{ type: "resize", generation, cols, rows }` | Resize the terminal. Refused unless this page owns the size and `generation` is the latest. |
| `{ type: "ping" }` | Ask for a `pong`, to check that the link is alive. |

### Terminal queries: clients must not answer

Programs ask the terminal questions by writing escape sequences, for
example "where is the cursor?" (`CSI 6 n`). The manager answers these once
per session from its own copy of the screen, whether zero or many clients
are attached. A client that renders the terminal must therefore not answer
them itself, or the program receives duplicate replies as keyboard input.
A client built on xterm.js can copy `suppressQueryReplies` from `web/app.js`.

Close codes: `4404` means the session does not exist, `4410` means it was
removed, and `4008` means the client fell too far behind. After a `4008` or a
network drop, reconnect and the snapshot brings the client up to date.

## The page in a VS Code tab

The manager's page may be framed only by VS Code webviews: its
`Content-Security-Policy` has `frame-ancestors vscode-webview: vscode-file:`.
The frame's `src` is the page URL with `#token=<token>`, as for a browser.
Adding `&view=yard` or `&view=cards` opens that view and keeps it as the
user's choice, as Settings does. Adding `&layout=compact` instead shows the
Yard's scene alone, to fill a small view, and keeps nothing: `&skin=<id>` and
`&theme=light` or `&theme=dark` show that look, and opening a session asks
the host for the full page. A host with no full page adds `&expand=none`, and
the page then neither shows its controls that ask for one nor sends `expand`.
A host whose device can't run the Yard adds `&yard=none`: the page shows the
Cards, doesn't offer the Yard, ignores `&view=yard`, `&layout=compact` and
the `view` message's `"yard"`, and never loads the scene or downloads the
Yard's art.
A browser ignores all of these.

A framed page cannot open windows, so it posts messages to `window.parent`.
A host must accept a message only from its own frame and the manager's
origin, and open only `http:` and `https:` URLs.

| Message | Meaning |
| --- | --- |
| `{ source: "agent-guild", type: "ready", version }` | The page reached the manager. `version` is the manager's. |
| `{ source: "agent-guild", type: "open", url }` | The user followed a link; open `url` in the browser. |
| `{ source: "agent-guild", type: "look", skin, theme }` | The page's skin and theme, on load and whenever they change. A compact page does not send it. |
| `{ source: "agent-guild", type: "expand", session }` | A compact page asks for the full page, showing the terminal of `session` when it is present. |

A host may post these messages to the page. The page accepts them only from
`window.parent`. Send them once the frame has fired `load`; the page listens
from then on.

| Message | Meaning |
| --- | --- |
| `{ source: "agent-guild-vscode", type: "view", view }` | Show `view`, `"cards"` or `"yard"`, and keep it as the user's choice. An open terminal closes first; its sessions keep running. A page opened with `&yard=none` ignores `"yard"`. |
| `{ source: "agent-guild-vscode", type: "session", id }` | Open the terminal of session `id` once, as soon as the page knows that session. |

## The page in the Agent Guild app

The app for iPhone, iPad and Apple Vision Pro loads the page URL with
`#token=<token>` in a `WKWebView` and registers a script message handler
named `agentGuild`. When the page is not framed and that handler exists, the
page treats the app as its host: `&view=yard`, `&view=cards`,
`&layout=compact` and `&yard=none` work as for VS Code, and the page posts the same `ready` and `open` messages to
`window.webkit.messageHandlers.agentGuild` instead of `window.parent`.
Without the handler, the page behaves as in a browser.

The page's checks do not protect the app. A script message handler is
reachable from every frame, and the page embeds a YouTube frame, so the app
must:

- accept a message only when `WKScriptMessage.frameInfo.isMainFrame` is true
  and the frame's `securityOrigin` is the manager's (CVE-2026-44698 is this
  bug in Home Assistant's iOS app);
- accept only the messages in the table above, with a string `type` and the
  fields it names;
- open only `http:` and `https:` URLs, outside the `WKWebView`, and keep the
  `WKWebView` from navigating away from the manager's origin, redirects
  included.

To show a view while the page is open, the app runs
`window.postMessage({ source: "agent-guild-app", type: "view", view }, location.origin)`
in the page with `evaluateJavaScript` once navigation has finished. The page
accepts it only from its own window at its own origin, with the behavior of
the VS Code message.

### Android

The Android app loads the same URL in a `WebView` and registers a web message
listener named `agentGuild` with AndroidX WebKit's
`WebViewCompat.addWebMessageListener`, whose allowed origin rules name only the
manager's origin. When the page is not framed, has no Apple handler, and
`window.agentGuild.postMessage` is a function, the page treats the app as its
host, as above. That object carries only strings, so the page posts each
message as JSON text: `JSON.stringify({ source: "agent-guild", type, ... })`.

The page's checks do not protect the app, so the app must:

- accept a message only when `isMainFrame` is true and `sourceOrigin` is
  exactly the manager's origin;
- parse it as JSON and accept only the messages in the table above, with a
  string `type` and the fields it names;
- open only `http:` and `https:` URLs, outside the `WebView`, and keep the
  `WebView`'s main frame on the manager's origin: its first load, redirects,
  new windows and loads after a renderer restart included.

The app shows a view the same way, with `evaluateJavascript` once
`onPageFinished` has run.

## The page on Meta Ray-Ban Display

`/glasses.html` is a 600 × 600 page for Meta's display glasses. It reads
`#token=<token>` as the page does, then makes only `GET /api/v1/sessions`
(every 5 seconds) and `GET /api/v1/sessions/:id/reply`, and speaks `spoken`.
It has no terminal and sends nothing, but the token it holds is the full API
token. **Settings → Meta glasses** shows a QR code of Meta's install link
for it, `fb-viewapp://web_app_deep_link?appName=Agent%20Guild&appUrl=<URL>`,
built from one of the manager's allowed HTTPS origins: the one the page is
open on, then the Tailscale address, then the other reverse proxy origins.
