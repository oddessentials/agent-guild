# Architecture

```
 ┌──────────────┐   HTTP + WebSocket (127.0.0.1, token)   ┌──────────────────────────┐
 │  Web page    │ ◀─────────────────────────────────────▶ │     Session manager      │
 └──────────────┘                                          │                          │
 ┌──────────────┐                                          │  SessionManager          │
 │ Future: UE5  │ ◀─────────────── same API ─────────────▶ │   └ Session × N          │
 │ or desktop UI│                                          │      ├ node-pty process  │──▶ claude / codex / agy / grok / docker agent / shell / npm install
 └──────────────┘                                          │      ├ headless xterm    │
                                                           │      └ agents, model     │◀── agent-guild-report, OSC 7777, herdr
                                                           │  ProviderRegistry        │──▶ tool --version, npm registry, Homebrew, GitHub releases
                                                           │  UsageMonitor            │──▶ vendor usage endpoints
                                                           │  SessionHistory          │──▶ the tools' own session files
                                                           │  ModelStats              │──▶ OpenRouter model list (benchmarks)
                                                           │  NewsFeed                │──▶ news, release and research feeds
                                                           │  Changelog, SelfUpdate   │──▶ GitHub releases, npm registry
                                                           └──────────────────────────┘
```

## Components

* **Session manager** (`src/manager`). A Node.js process that owns every
  terminal. It keeps running when the page closes. `agent-guild open` starts
  it in the background if it is not already running.
* **Session** (`session.mjs`). One node-pty process plus a headless xterm.js
  terminal that mirrors its screen. When a client attaches, the manager
  serializes that mirror into a snapshot, so the client sees the current
  screen even for full-screen TUIs. It does not replay a raw byte log, which
  would break on truncation. The mirror is also the terminal of record: it
  answers the program's terminal queries exactly once, so tools that ask for
  the cursor position work with no page open and get no duplicate replies
  with several pages open. `pty.mjs` loads node-pty, and says how to build it
  where its bundled builds do not load.
* **SessionManager** (`session-manager.mjs`). Owns every session: starts each
  with its tool's command, account and environment, and stops, renames and
  reattaches them. The API server and any other front end talk to it.
* **Stopping a session.** On macOS and Linux the process gets a hang-up
  signal, then a forced kill after a grace period. On Windows the process
  tree is ended at once, as node-pty's own Windows kill does; there is no
  gentler signal for console programs there.
* **Provider registry** (`providers.mjs`). Built-in providers plus the user's
  `providers.json`. Finds each tool on PATH. On macOS and Linux it first reads
  the login shell's PATH, because apps started from Finder or the Dock do not
  get it. The shell runs in its own session and is stopped after 8 seconds,
  with anything its profile started, so a slow or prompting profile cannot
  hold up the manager; stopping the manager or doctor stops it too
  (`shell-env.mjs`). On Windows it reads PATH from the registry instead, and
  it runs `.cmd` and `.ps1` shims through `cmd.exe` or PowerShell, because
  ConPTY can only start real executables. It also checks each tool's installed
  and latest versions; a version check that passes its time limit is ended with
  everything it started. It builds the sessions that install, update and
  uninstall a tool. `command-resolver.mjs` finds and wraps each command,
  `versions.mjs` reads installed versions and the latest from npm, Homebrew or
  a releases page, `install-channels.mjs` tells how each copy was installed so
  an update uses the same channel, `docker-plugin.mjs` lists the Docker CLI
  plugin's copies, and `uninstall.mjs` removes one.
* **Reporting** (`session-hooks.mjs`, `report-shims.mjs`, `docker-sessions.mjs`,
  `src/report/hooks.mjs`). Gives each session the hooks its tool loads:
  command-line flags, the Claude Code, Antigravity CLI and Grok Build plugins
  in the data folder's `reporting/`, or Docker Agent's model drop-in. Puts
  `agent-guild-report` launchers first on the session's PATH. The reporter
  turns hook events into agent, model, command and turn reports; Docker
  Agent's events go whole to `docker-sessions.mjs`, which tells its tabs and
  sub-agents apart. See [agent-reporting.md](agent-reporting.md).
* **Shells and multiplexers** (`shells.mjs`, `multiplexers.mjs`, `herdr.mjs`,
  `multiplexer-paths.mjs`). The shells, tmux and herdr the Shell card can
  start, their installations, and the agents herdr sees in its panes.
* **Manager environment** (`environment.mjs`, `environment-probe.mjs`,
  `environment-pins.mjs`, `environment-system.mjs`). Read-only snapshots,
  separate from providers and from install or repair. The manager scope is the PATH of the manager
  process. A project scope reads known pin files and does not run them. A
  session scope probes the PATH recorded for a Guild-started process and
  reports tmux and herdr as unavailable. A launch scope is that manager PATH
  labeled as the PATH a new process receives before shell startup files.
  First viewing and manual refresh start an isolated helper; HTTP requests
  return immediately. Runtime probes use a fresh neutral temporary directory,
  limit each probe to 1.8 seconds and 32 KiB, and run at most three runtime
  checks concurrently. Design tools run beside them, at most three at once,
  with a 3-second limit and their home and profile folders in the temporary
  directory. Docker is one request to a local socket or pipe; system facts
  come from `os`, small files and, on Windows, one registry read. The manager
  enforces a separate 15-second deadline and stops the helper process tree on
  completion, timeout or shutdown. Pin reads do not enter the project
  directory. Version-manager presence is discovered without executing the
  tools. No shell profiles or installation operations are added.
* **Usage monitor** (`usage.mjs`). Reads each tool's own sign-in and asks the
  vendor's usage endpoint for the remaining rate-limit windows. Tokens stay
  in the manager.
* **Session history** (`session-history.mjs`, `antigravity-transcript.mjs`).
  Lists each tool's earlier sessions from the transcripts the tool keeps in
  its home folder, reading only their heads, so one can be resumed from the
  page. **History** reads an Antigravity CLI conversation's readable
  transcript.
* **Memory and instructions** (`agent-memory.mjs`, `instruction-files.mjs`).
  Read what each tool remembers about the working folder and which
  instruction files it loads there, following each tool's own rules.
* **Model stats** (`model-stats.mjs`). Reads OpenRouter's public model list
  for Artificial Analysis and Design Arena results, picks each provider's
  models with its `modelPattern`, and grades every model against the models
  of all configured tools. Cached for 6 hours.
* **News feed** (`news.mjs`). Reads a fixed list of RSS, Atom, Hacker News
  and GitHub release feeds when a client asks and a feed is due, and keeps
  the last 30 days. Hacker News, Slashdot and arXiv are filtered to agentic
  and local-model topics.
* **Changelog and self-update** (`changelog.mjs`, `self-update.mjs`). Read
  Agent Guild's own releases from GitHub for the What's new panel, check npm
  for a newer version, and run the upgrade as a session.
* **GitHub** (`github.mjs`, `github-views.mjs`). Sign-ins, SSH keys and the
  Git configuration a clone runs with, all kept in the data folder's
  `github/`; the user's own `~/.ssh` and Git configuration are never read.
  The panel's branches, issues, runs and pull requests.
* **Remote access** (`remote-access.mjs`, `tailscale.mjs`,
  `access-policy.mjs`). Sets up Tailscale Serve, and keeps the host and origin
  allowlists for other proxies.
* **Folders** (`folder-browser.mjs`, `folder-opener.mjs`). The working-folder
  picker's browser, and opening a folder in the file manager.
* **Doctor** (`doctor.mjs`). The checks `agent-guild doctor` runs.
* **API server** (`server.mjs`). REST for control, one WebSocket for
  lifecycle events, one WebSocket per attached terminal. See [api.md](api.md).
* **Notes** (`notes.mjs`). One notepad for every browser signed in to the
  manager, kept in the data directory. The page paints from its own copy
  first, then catches up to the manager's revision.
* **Web page** (`web/`). Plain HTML, CSS and JavaScript with xterm.js, served
  by the manager. No build step.
* **Launcher** (`bin/agent-guild.mjs`). Starts, stops, restarts and opens.
  Starting a detached manager lives in `launch.mjs`, which the manager also
  uses to start its successor on a restart. While the Linux boot service
  (`systemd-service.mjs`) is on, systemd starts every manager instead: the
  launcher asks systemctl, and a supervised manager exits with code 75 for
  systemd to start the next one, or 78 when its port is taken, which systemd
  does not retry. **When I sign in** (`autostart.mjs`) adds a per-user entry
  on Windows, macOS and Linux that runs `agent-guild open --no-browser`.

## Lifetimes

| Event | Effect on sessions |
| --- | --- |
| Close or reload the page | None. Reopening reconnects and redraws. |
| An unexpected error inside the manager | Logged to `manager.log`; sessions keep running. |
| `agent-guild stop`, **Stop manager** in the page's **Manager** menu, or quitting the manager | All sessions end, except tmux and herdr ones, which are detached; the next manager brings their cards back closed, ready to reattach. The page asks first while any session it would end is running; the manager enforces that for every client. |
| `agent-guild restart` or **Restart manager** in the page's **Manager** menu | As for a stop, with the same guard. The manager then starts a new manager from the package on disk and exits; clients reconnect to the new one. An upgrade's files are picked up this way. |
| Computer restart or logout | All sessions end. Nothing is restored. With **When I sign in**, a new manager starts at sign-in; with **When the computer starts** on Linux, systemd starts one at boot. |

## Toward a game interface

The manager exposes sessions and agents as data, not as UI. An Unreal Engine
client would:

1. Read `manager.json` and `auth-token` to find the manager.
2. Subscribe to `/api/v1/events` and spawn one provider character per session,
   plus one worker per entry in `session.agents`.
3. Use `activity` and agent `status` to drive animation states.
4. Open `/api/v1/sessions/:id/terminal` when the player opens a character's
   terminal, and render it with any VT-compatible terminal widget.

Both front ends can run at the same time against the same sessions.
