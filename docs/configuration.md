# Configuration

Agent Guild works with no configuration. This page covers changing or adding
providers, signing in with more than one account, and the environment
variables the manager reads.

## Data folder

| Platform | Data folder |
| --- | --- |
| Windows | `%APPDATA%\AgentGuild` |
| macOS | `~/Library/Application Support/AgentGuild` |
| Linux | `$XDG_CONFIG_HOME/agent-guild` (default `~/.config/agent-guild`) |

`AGENT_GUILD_HOME` moves it. The folder holds the access token
(`auth-token`), the running manager's address (`manager.json`), its log
(`manager.log`), extra accounts' home folders (`accounts/`), GitHub sign-ins
and SSH keys (`github/`), the tmux and herdr cards the next manager brings
back (`multiplexers.json`) and your `providers.json`.

## providers.json

Create `providers.json` in the data folder to change or add providers. It is
either `{ "providers": [ … ] }` or a bare array. See
[examples/providers.json](../examples/providers.json).

Entries are merged with the built-in ones by `id`:

* A new `id` adds a provider.
* `"enabled": false` hides one.
* Any field can be overridden for one platform under a `win32`, `darwin` or
  `linux` key.

```json
{
  "providers": [
    { "id": "anthropic", "args": ["--model", "opus"] },
    { "id": "aider", "vendor": "Aider", "tool": "Aider", "command": "aider", "color": "#14B8A6", "monogram": "Ai" },
    { "id": "shell", "enabled": false }
  ]
}
```

The manager reads the file when it starts, and again on
`POST /api/v1/providers/reload`. Problems with it, such as a field of the
wrong type or an invalid account, are written to `manager.log` and reported
by `GET /api/v1/info`.

### Fields

| Field | Meaning |
| --- | --- |
| `id` | Lowercase identifier. |
| `vendor`, `tool` | Names shown on the card. |
| `command`, `args` | What to run. `command` is looked up on PATH. `@shell` offers installed shells and uses the default unless another is selected; it also offers tmux 3.2 or later on macOS and Linux, and herdr, when installed. For `@shell`, provider `args` apply only to the default shell. |
| `package` | The tool's npm package, e.g. `@openai/codex`. Enables the **Install** button and the version check. |
| `npmNote` | A sentence added to the **Install** button's tooltip, e.g. what npm installs. |
| `channels` | How an installed copy is recognised, so **Update** runs that installation's own updater. A copy installed by npm needs no entry. `brew.names` lists the tool's own Homebrew formula or cask names, e.g. `{ "brew": { "names": ["claude-code"] } }`, and `winget.id` is its WinGet package id. A provider you add must set these for its Homebrew or WinGet copy to get **Update** and **Uninstall** buttons; without them that copy shows as an unknown install with guidance only. `native.paths` are the launcher and folders the vendor's own installer uses, and `native.update` the arguments that make the tool update itself, e.g. `["update"]`. `native.remove` and `legacy.remove` are the paths **Uninstall** deletes; each must lie inside the home folder and below its top level, so a tool's home folder such as `~/.codex` is never deleted. `native.links` are launchers deleted only when they link into those paths; unlike `remove`, they may lie outside the home folder, e.g. `/usr/local/bin/grok`. `brew.autoUpdates: true` marks a cask that updates itself: its copy can be uninstalled but gets no **Update**. |
| `versionArgs` | Arguments that make the command print its version, used instead of `args`, e.g. `["--version"]`. |
| `usage` | Where the usage meters come from: `"claude"`, `"codex"`, `{ "command", "args" }` for a program that prints `{ "plan", "windows": [{ "label", "usedPercent", "resetsAt" }] }` (`plan` optional; `remainingPercent` may stand in for `usedPercent`), or `null` for none. |
| `modelPattern` | Regular expression that finds the model name on the tool's screen when the tool does not report it. It also picks the tool's models from the benchmark catalog. |
| `resumeArgs` | Arguments that resume the tool's own session, with `{id}` standing for the id, e.g. `["--resume", "{id}"]`. Without it the card has no **Existing…** button. |
| `history` | Where the list of earlier sessions comes from: `"claude"`, `"codex"`, `"antigravity"`, `"grok"` (the tool's own session files under its home folder), `{ "command", "args" }` for a program that prints `{ "sessions": [{ "id", "title", "cwd", "startedAt", "updatedAt" }] }`, or `null` for none, in which case **Existing…** asks for an id. |
| `env` | Extra environment variables for the tool. |
| `accounts` | Further sign-ins of the tool. See [Accounts](#accounts). Needs `homeVar`. |
| `homeVar` | The environment variable that moves the tool's home folder, e.g. `CLAUDE_CONFIG_DIR`. Set for Claude Code, Codex CLI and Grok Build by default. |
| `accountEnv` | Further variables set for every account other than the default, with `{dir}` standing for the account's folder. By default Claude Code's secure-storage folder follows the account. |
| `reporting` | How sessions get the agent reporting hooks: `"claude"`, `"codex"`, `"antigravity"` or `"grok"` (see [agent-reporting.md](agent-reporting.md)), or unset for none. |
| `hooks` | `{ "path", "example" }`: the hooks file inside the home folder that earlier versions copied from `examples/` into a new account. An untouched Codex CLI copy is removed when the session gets the same hooks from Agent Guild; Claude Code's copy stays, since it also sets the status line. |
| `color`, `monogram`, `icon` | Icon appearance. `icon` is a URL path; you can also drop `<id>.svg` into `web/icons/`. |
| `install`, `docs` | Help shown when the tool is not installed. |
| `usageUrl`, `billingUrl` | `https://` links to the vendor's usage and billing pages, shown on the card. The defaults point at the subscription pages; set your API console instead, or `null` to hide a link. |
| `cloudUrl` | `https://` link to the vendor's web app, shown as a cloud icon on the card. `null` hides it. |

## Terminal multiplexers

The built-in Shell provider has a `multiplexers` array naming `tmux` and
`herdr`, with documentation links and Homebrew names in `channels.brew.names`.
Entries can override those fields under `win32`, `darwin` or `linux`.
The final platform entry must name a supported ID; `enabled: false` hides
that entry's management controls.
Replace the array with `[]` to hide management controls; shell discovery
and existing sessions continue to work. These are the two supported IDs;
this field does not define arbitrary installers.

Managed herdr installs on macOS and Linux write `~/.local/bin/herdr`.
If that directory is absent from PATH, the row shows the installed copy.
Add its directory to your shell configuration, then **Refresh**.
Agent Guild does not edit shell profiles.

On Windows, managed installs explicitly set `HERDR_HOME` to
`%USERPROFILE%\.herdr` and `HERDR_INSTALL_DIR` to
`%LOCALAPPDATA%\Programs\Herdr\bin` in the installer process. Inherited values
cannot redirect a managed install. New installs use the stable release
channel. Removal deletes the known standalone package and its owned bin
junction, then removes only its user PATH entries, preserving the registry
value type and unrelated entries.

Existing custom, mise, Nix, and unrecognized copies receive guidance
instead of management buttons. Native updates preserve the installation's
own release channel; unknown and preview channels are not compared against
the stable version feed. Homebrew copies use Homebrew's updater.

Uninstall preserves user configuration, session data, and shared
dependencies. Agent Guild manages the selected installation; it does not
roll back package-manager dependency transactions. Failed or interrupted
operations leave an outcome note and a retry or repair path. An incomplete
herdr install whose executable cannot answer a server-status check must be
repaired before Uninstall can safely proceed.

## Accounts

Each extra account is a separate sign-in of the same tool, kept in its own
home folder, so a personal and a work subscription can run side by side:

```json
{
  "providers": [
    {
      "id": "anthropic",
      "accounts": [
        { "id": "default", "label": "Personal" },
        { "id": "work", "label": "Work", "dir": "~/.claude-work" }
      ]
    }
  ]
}
```

* The card shows one chip per account, each with its own usage meters. A new
  session starts under the chip picked.
* Without `dir`, the folder is `accounts/<provider>/<account>` in the data
  folder.
* The tool signs in from inside the first session of a new account. While
  the usage check finds no sign-in, the card's button reads **Sign in**.
* An entry with id `default` renames the tool's own sign-in.

## Environment variables

| Variable | Effect |
| --- | --- |
| `AGENT_GUILD_PORT` | Port of the local API and page (default 47821). |
| `AGENT_GUILD_HOME` | Data folder (see above). |
| `AGENT_GUILD_NPM_REGISTRY` | npm registry for version checks and installs. Defaults to the registry in npm's global configuration, the one `npm install -g` uses. |
| `AGENT_GUILD_NO_UPDATE_CHECK` | `1` skips version checks, for the tools and for Agent Guild itself. Otherwise they run about once an hour. |
| `AGENT_GUILD_ALLOWED_HOSTS` | Extra comma-separated Host values accepted by HTTP and WebSocket requests, e.g. `guild.example.ts.net` or `guild.example.ts.net:8443`. See [Reverse proxies](#reverse-proxies). |
| `AGENT_GUILD_ALLOWED_ORIGINS` | Extra comma-separated origins allowed to call the API, e.g. a UI dev server. |
| `AGENT_GUILD_SKIP_SHELL_ENV` | `1` skips reading the login shell's PATH on macOS and Linux. |

The variables the manager sets inside every session are listed in
[agent-reporting.md](agent-reporting.md).

## Reverse proxies

To open the UI from another device through a reverse proxy such as
[Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve),
configure both the public **Host** and the browser's **Origin**. The manager
continues listening on `127.0.0.1`; the proxy forwards HTTP and WebSocket
traffic to it.

For example, in PowerShell on the manager machine, replace the placeholder
`guild.example.ts.net` with the HTTPS hostname shown by Tailscale Serve:

```powershell
$env:AGENT_GUILD_ALLOWED_HOSTS = 'guild.example.ts.net'
$env:AGENT_GUILD_ALLOWED_ORIGINS = 'https://guild.example.ts.net'
agent-guild open --no-browser
tailscale serve --bg http://127.0.0.1:47821
```

These settings are read at manager startup. If it is already running, use
`agent-guild stop` before starting it from the configured shell; stopping
ends ordinary terminal sessions. `agent-guild restart` inherits the running
manager's environment, so it does not pick up variables newly set in your
shell. Set the variables in the environment used to launch the manager for
future starts as well. If you changed `AGENT_GUILD_PORT`, use that port in
the proxy target.

Open `https://guild.example.ts.net/` on another device and enter the manager's
existing access token. `agent-guild url` on the manager machine prints a
local URL containing `#token=...`; use that token in the remote page's token
field, or replace just the URL's scheme and authority with the proxy's
HTTPS address, preserving the token fragment. The same token is required
for protected API requests and WebSocket connections through the proxy.

Working paths and tools still belong to the manager machine. Native folder
dialogs and file-manager windows open there; from another device, enter the
working folder's path in the UI instead.

Host entries are exact, case-insensitive hostnames or IP literals, optionally
followed by a port. IPv6 literals use brackets. Whitespace around entries
and duplicate entries are ignored; schemes, paths, credentials, wildcards
and invalid ports cause startup to fail with a configuration error. A bare
hostname does not allow arbitrary ports or subdomains. For an HTTPS proxy
on port 8443, set Host to `guild.example.ts.net:8443` and Origin to
`https://guild.example.ts.net:8443`. For standard HTTPS, omit the default
port, as browsers do. Origin entries include the scheme and have no trailing
slash.

The proxy should preserve the browser's Host and Origin headers and support
WebSocket upgrades. `Forwarded`, `X-Forwarded-Host` and Tailscale identity
headers do not grant access or replace API authentication. The page's CSP
permits WebSocket connections to the explicitly configured hosts. Leaving
both settings unset retains the existing loopback-only Host and Origin
allowlists.
