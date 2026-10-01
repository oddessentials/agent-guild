# Architecture

```
 ┌──────────────┐   HTTP + WebSocket (127.0.0.1, token)   ┌──────────────────────────┐
 │  Web page    │ ◀─────────────────────────────────────▶ │     Session manager      │
 └──────────────┘                                          │                          │
 ┌──────────────┐                                          │  SessionManager          │
 │ Future: UE5  │ ◀─────────────── same API ─────────────▶ │   └ Session × N          │
 │ or desktop UI│                                          │      ├ node-pty process  │──▶ claude / codex / gemini / grok / shell / npm install
 └──────────────┘                                          │      ├ headless xterm    │
                                                           │      └ agents, model     │◀── agent-guild-report, OSC 7777
                                                           │  ProviderRegistry        │──▶ tool --version, npm registry
                                                           │  UsageMonitor            │──▶ vendor usage endpoints
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
  with several pages open.
* **Stopping a session.** On macOS and Linux the process gets a hang-up
  signal, then a forced kill after a grace period. On Windows the process
  tree is ended at once, as node-pty's own Windows kill does; there is no
  gentler signal for console programs there.
* **Provider registry** (`providers.mjs`). Built-in providers plus the user's
  `providers.json`. Finds each tool on PATH. On macOS and Linux it first reads
  the login shell's PATH, because apps started from Finder or the Dock do not
  get it. On Windows it runs `.cmd` and `.ps1` shims through `cmd.exe` or
  PowerShell, because ConPTY can only start real executables. It also checks
  each tool's installed and latest versions, and builds the `npm install -g`
  session that installs a tool.
* **Usage monitor** (`usage.mjs`). Reads each tool's own sign-in and asks the
  vendor's usage endpoint for the remaining rate-limit windows. Tokens stay
  in the manager.
* **API server** (`server.mjs`). REST for control, one WebSocket for
  lifecycle events, one WebSocket per attached terminal. See [api.md](api.md).
* **Web page** (`web/`). Plain HTML, CSS and JavaScript with xterm.js, served
  by the manager. No build step.
* **Launcher** (`bin/agent-guild.mjs`). Starts, stops and opens.

## Lifetimes

| Event | Effect on sessions |
| --- | --- |
| Close or reload the page | None. Reopening reconnects and redraws. |
| An unexpected error inside the manager | Logged to `manager.log`; sessions keep running. |
| `agent-guild stop`, the page's **Stop manager** button, or quitting the manager | All sessions end. The button asks first while any session is running; the manager enforces that for every client. |
| Computer restart or logout | All sessions end. Nothing is restored. |

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
