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

The session manager is a Node.js process that owns every terminal and keeps
running when the page closes. The code is the reference for how each part
works; this is where to find it.

## Where things live

All under `src/manager` unless noted.

| Part | Files |
| --- | --- |
| Manager process, data folder and API | `main.mjs`, `config.mjs`, `server.mjs` ([api.md](api.md)) |
| Sessions and terminals | `session-manager.mjs`, `session.mjs`, `pty.mjs` |
| Tools, versions, install and uninstall | `providers.mjs`, `command-resolver.mjs`, `shell-env.mjs`, `versions.mjs`, `install-channels.mjs`, `docker-plugin.mjs`, `uninstall.mjs` |
| Agent reporting | `session-hooks.mjs`, `report-shims.mjs`, `docker-sessions.mjs`, `src/report/hooks.mjs`, `bin/agent-guild-report.mjs` ([agent-reporting.md](agent-reporting.md)) |
| Shells, tmux and herdr | `shells.mjs`, `multiplexers.mjs`, `multiplexer-paths.mjs`, `herdr.mjs` |
| Shell card's environment | `environment.mjs`, `environment-probe.mjs`, `environment-pins.mjs`, `environment-system.mjs` |
| Usage meters | `usage.mjs` |
| History, memory and instructions | `session-history.mjs`, `antigravity-transcript.mjs`, `agent-memory.mjs`, `instruction-files.mjs` |
| Model benchmarks | `model-stats.mjs` |
| News, What's new and self-upgrade | `news.mjs`, `changelog.mjs`, `self-update.mjs` |
| GitHub | `github.mjs`, `github-views.mjs` |
| Remote access | `remote-access.mjs`, `tailscale.mjs`, `access-policy.mjs` |
| Folders and notes | `folder-browser.mjs`, `folder-opener.mjs`, `notes.mjs` |
| Starting, stopping and autostart | `bin/agent-guild.mjs`, `launch.mjs`, `autostart.mjs`, `systemd-service.mjs` |
| `agent-guild doctor` | `doctor.mjs` |
| Web page | `web/`: plain HTML, CSS and JavaScript with xterm.js, no build step |

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
