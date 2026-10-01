# Agent Guild

Agent Guild runs AI coding assistants side by side from one local web page.
Pick a provider, get a real interactive terminal running that provider's
coding tool, and see at a glance which sessions and agents are working.

![Agent Guild session cards](docs/screenshot.png)

* **Start sessions from provider cards.** Anthropic (Claude Code), OpenAI
  (Codex CLI), Google (Gemini CLI), xAI (Grok Build), and a plain shell.
  **New** starts a fresh session; **Existing** lists the tool's own earlier
  sessions, read from where the tool keeps them, with their ids, and
  resumes one in its own folder, or any session by id. Providers whose tool is not
  installed are shown greyed out with an **Install** button that runs
  `npm install -g` in a session you can watch, or with install instructions
  when the tool is not an npm package. Installed tools show their version
  and an **Update** button; updating while that tool's sessions are running
  asks first, because it can break them.
* **See what is left of your limits.** Claude Code, Codex CLI and Gemini
  CLI cards show a meter per rate-limit window (5-hour, 7-day, or per
  model, including Claude's weekly Fable window and the model and feature
  limits Codex meters separately) with the time until it resets, read from
  the tool's own sign-in.
  Claude's extra-usage spend and Codex's prepaid credit balance appear
  when the account has them. Other providers can supply a command that
  prints usage.
* **Work in real terminals.** Each session is a card. Open it for a full
  interactive terminal: type instructions, answer prompts, watch output. Run
  as many sessions at once as you like.
* **See agents and models at work.** When a coding tool reports helper
  agents, they appear as small icons on that session's card. The card also
  names the main model in use, reported by the tool or, failing that,
  spotted on its screen.
* **Close the page any time.** A separate local session manager owns the
  terminals. Reopen the page and it reconnects to the same sessions with
  their screens intact, as long as the manager is still running. Sessions do
  not survive a computer restart. **Stop manager** in the top bar stops the
  manager and ends every session; it asks first while any session is still
  running.
* **Stay current.** When a newer Agent Guild is on npm, an **Upgrade**
  button appears in the top bar and runs `npm install -g` in a session you
  can watch. Sessions keep running; stop the manager and run `agent-guild
  open` to use the new version.
* **Light or dark.** The page follows your system theme and the top-bar
  toggle switches it. The guild artwork is the dark theme.

## Requirements

* Windows 10 1809 or later, or macOS 11 or later. Linux works for development.
* Node.js 22 or newer.
* Each coding tool you want to use, signed in on its own. Agent Guild can
  install the npm-packaged tools for you; it does not authenticate them.

node-pty ships prebuilt binaries for Windows, macOS and Linux on x64 and
arm64, so no compiler is needed. WSL is not required.

## Install and run

```sh
npm install -g @oddessentials/agent-guild
agent-guild
```

`agent-guild open` starts the session manager in the background if needed and
opens the page. The page URL carries an access token in its `#` fragment. The
page stores it and then removes it from the address bar.

| Command | What it does |
| --- | --- |
| `agent-guild` or `agent-guild open` | Start the manager if needed and open the page. `--no-browser` prints the URL instead. |
| `agent-guild status` | Show whether the manager is running and list its sessions. |
| `agent-guild stop` | Stop the manager. This ends every session, without asking. The page's **Stop manager** button does the same and asks first while sessions are running. |
| `agent-guild start` | Run the manager in the foreground, for debugging. |
| `agent-guild url` | Print the page URL with its token. |

**Changelog:** each version's changes are listed on the
[Releases page](https://github.com/oddessentials/agent-guild/releases).

## Configure providers

Create `providers.json` in the data folder to change or add providers:

| Platform | Data folder |
| --- | --- |
| Windows | `%APPDATA%\AgentGuild` |
| macOS | `~/Library/Application Support/AgentGuild` |

Entries are merged with the built-in ones by `id`. A new `id` adds a
provider, and `"enabled": false` hides one. Any field can be overridden for
one platform under a `win32` or `darwin` key. See
[examples/providers.json](examples/providers.json).

| Field | Meaning |
| --- | --- |
| `id` | Lowercase identifier. |
| `vendor`, `tool` | Names shown on the icon. |
| `command`, `args` | What to run. `command` is looked up on PATH. `@shell` means the user's default shell. |
| `package` | The tool's npm package, e.g. `@openai/codex`. Enables the **Install** button and the version check. |
| `channels` | How an installed copy is recognised, so **Update** runs that installation's own updater. A copy installed by npm needs no entry. `brew.names` lists the tool's own Homebrew formula or cask names, e.g. `{ "brew": { "names": ["gemini-cli"] } }`, and `winget.id` is its WinGet package id. A provider you add must set these for its Homebrew or WinGet copy to get an **Update** button or a removal command; without them that copy shows as an unknown install with guidance only. `native.paths` are the launcher and folders the vendor's own installer uses, and `native.update` the arguments that make the tool update itself, e.g. `["update"]`. |
| `versionArgs` | Arguments that make the command print its version, used instead of `args`, e.g. `["--version"]`. |
| `usage` | Where the usage meters come from: `"claude"`, `"codex"`, `"gemini"`, `{ "command", "args" }` for a program that prints `{ "windows": [{ "label", "usedPercent", "resetsAt" }] }`, or `null` for none. |
| `modelPattern` | Regular expression that finds the model name on the tool's screen when the tool does not report it. |
| `resumeArgs` | Arguments that resume the tool's own session, with `{id}` standing for the id, e.g. `["--resume", "{id}"]`. Without it the card has no **Existing** button. |
| `history` | Where the list of earlier sessions comes from: `"claude"`, `"codex"`, `"gemini"`, `"grok"` (the tool's own session files under its home folder), `{ "command", "args" }` for a program that prints `{ "sessions": [{ "id", "title", "cwd", "startedAt", "updatedAt" }] }`, or `null` for none, in which case **Existing** asks for an id. |
| `env` | Extra environment variables for the tool. |
| `accounts` | Further sign-ins of the tool, each in its own home folder, e.g. `[{ "id": "work", "label": "Work", "dir": "~/.claude-work" }]`. Without `dir`, the folder is `accounts/<provider>/<account>` in the data folder. The card shows one chip per account with its own meters, and a session starts under the chip picked; the tool signs in from inside the first session, and its reporting hooks are copied into the folder on first use. An entry with id `default` renames the tool's own sign-in. Needs `homeVar`. |
| `homeVar` | The environment variable that moves the tool's home folder, e.g. `CLAUDE_CONFIG_DIR`. Set for Claude Code, Codex CLI, Gemini CLI and Grok Build by default. |
| `accountEnv` | Further variables set for every account other than the default, with `{dir}` standing for the account's folder. By default Claude Code's secure-storage folder follows the account, and Gemini CLI keeps the account's sign-in in a file rather than the shared OS keychain. |
| `hooks` | `{ "path", "example" }`: the hooks file inside the home folder and the file in `examples/` copied there for a new account. |
| `color`, `monogram`, `icon` | Icon appearance. `icon` is a URL path; you can also drop `<id>.svg` into `web/icons/`. |
| `install`, `docs` | Help shown when the tool is not installed. |
| `usageUrl`, `billingUrl` | `https://` links to the vendor's usage and billing pages, shown on the card. The defaults point at the subscription pages; set your API console instead, or `null` to hide a link. Google's usage link opens AI Studio, which counts API-key usage only, not the Gemini CLI sign-in quota the card's meters show. |

The page's "Working folder" field sets where new sessions start. It defaults
to your home folder.

Version checks, for the tools and for Agent Guild itself, ask the registry
from npm's global configuration (the one `npm install -g` uses) about once
an hour, and installs use the same registry. Set `AGENT_GUILD_NPM_REGISTRY`
to override it for both, or `AGENT_GUILD_NO_UPDATE_CHECK=1` to skip the
checks.

## Show agents and models

Agents are reported by the coding tool, not guessed from its output. Add
the hooks from the matching file in [examples/](examples/) to Claude Code,
Codex CLI, Gemini CLI or Grok Build: each sub-agent appears on the card
while it runs, and the card shows the model in use. The hooks call
`agent-guild-report`, which the manager puts on the PATH of every session it
starts, so no global install is needed. Codex CLI runs no hook until you
trust it (choose "Trust all and continue" when it starts, or run `/hooks`),
and Claude Code runs none until you accept its workspace-trust prompt. Any
tool or script can also report agents and the model with the
`agent-guild-report` command or an escape sequence. See
[docs/agent-reporting.md](docs/agent-reporting.md).

## Security

* The manager listens on `127.0.0.1` only.
* Every API call needs a random per-user token, stored in the data folder
  with owner-only permissions.
* Requests with a foreign `Host` or `Origin` header are refused. This stops
  other websites from reaching the terminals through your browser.
* Tools inside a session get a separate token that can only report agents
  for that session.
* Usage meters are fetched by the manager with the coding tool's own
  sign-in (Claude Code's credentials, Codex CLI's `auth.json`, Gemini CLI's
  sign-in). The page only ever receives percentages. On macOS the first
  lookup may ask for keychain access to the "Claude Code-credentials" and
  "gemini-cli-oauth" items; choose Always Allow.

Anyone who can run programs as your user can already read the token, as with
any local developer tool.

## Other front ends

The page is only one client. The manager's API is documented in
[docs/api.md](docs/api.md) so that another interface, such as a planned
Unreal Engine version where provider characters and their workers stand in
for the icons, can drive the same sessions. See
[docs/architecture.md](docs/architecture.md).

## Development

```sh
npm install
npm test
```

The tests start real managers and real pseudo-terminals, using a small fake
coding tool in `tests/fixtures`. CI runs them on Windows, macOS and Linux.

## Current limits

* Sessions end when the manager stops or the computer restarts.
* Gemini CLI usage meters read its sign-in where Gemini CLI keeps it:
  `oauth_creds.json`, or with `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true`
  the OS keychain (macOS, or Linux with `secret-tool`) or its encrypted
  credentials file. A sign-in kept in the Windows Credential Manager
  cannot be read.
