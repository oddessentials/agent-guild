# Architecture

```
 ┌──────────────┐   HTTP + WebSocket (127.0.0.1, token)   ┌──────────────────────────┐
 │  Web page    │ ◀─────────────────────────────────────▶ │     Session manager      │
 └──────────────┘                                          │                          │
 ┌──────────────┐                                          │  SessionManager          │
 │ Future: UE5  │ ◀─────────────── same API ─────────────▶ │   └ Session × N          │
 │ or desktop UI│                                          │      ├ node-pty process  │──▶ claude / codex / gemini / grok / shell
 └──────────────┘                                          │      ├ headless xterm    │
                                                           │      └ agents            │◀── agent-guild-report, OSC 7777
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
  would break on truncation.
* **Provider registry** (`providers.mjs`). Built-in providers plus the user's
  `providers.json`. Finds each tool on PATH. On macOS and Linux it first reads
  the login shell's PATH, because apps started from Finder or the Dock do not
  get it. On Windows it runs `.cmd` and `.ps1` shims through `cmd.exe` or
  PowerShell, because ConPTY can only start real executables.
* **API server** (`server.mjs`). REST for control, one WebSocket for
  lifecycle events, one WebSocket per attached terminal. See [api.md](api.md).
* **Web page** (`web/`). Plain HTML, CSS and JavaScript with xterm.js, served
  by the manager. No build step.
* **Launcher** (`bin/agent-guild.mjs`). Starts, stops and opens.

## Lifetimes

| Event | Effect on sessions |
| --- | --- |
| Close or reload the page | None. Reopening reconnects and redraws. |
| `agent-guild stop`, or quitting the manager | All sessions end. |
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
