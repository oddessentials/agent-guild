# Configuration

Nothing needs configuring. Use this page to add or change tools, add accounts,
or put Agent Guild behind a proxy.

## Data folder

| Platform | Folder |
| --- | --- |
| Windows | `%APPDATA%\AgentGuild` |
| macOS | `~/Library/Application Support/AgentGuild` |
| Linux | `$XDG_CONFIG_HOME/agent-guild`, by default `~/.config/agent-guild` |

| File | Holds |
| --- | --- |
| `auth-token` | The access token |
| `providers.json` | Your tool settings, if you create it |
| `remote-access.json` | Remote access settings |
| `manager.log` | The log of a manager started in the background |
| `accounts/` | Home folders of extra accounts |
| `github/` | GitHub sign-ins and SSH keys |

## providers.json

Create `providers.json` in the data folder. Entries merge with the built-in
tools by `id`; a field you set replaces the built-in value. See
[examples/providers.json](../examples/providers.json) and the built-in tools in
[config/providers.default.json](../config/providers.default.json).

```json
{
  "providers": [
    { "id": "anthropic", "args": ["--model", "opus"] },
    { "id": "aider", "vendor": "Aider", "tool": "Aider", "command": "aider", "color": "#14B8A6", "monogram": "Ai" },
    { "id": "shell", "enabled": false }
  ]
}
```

Edits apply after `agent-guild restart` (this ends running sessions). Invalid
values are ignored; a file that cannot be read is reported in `manager.log`.

| Field | Meaning |
| --- | --- |
| `id` | Up to 32 lowercase letters, digits, `-` or `_`, starting with a letter or digit |
| `enabled` | `false` hides the tool |
| `vendor`, `tool` | Names shown on the card |
| `command`, `args` | What to run; `command` is looked up on PATH |
| `env` | Extra environment variables for the tool |
| `package` | npm package name; enables **Install** and update checks |
| `versionArgs` | Arguments that print the version, e.g. `["--version"]` |
| `resumeArgs` | Arguments that resume a session, `{id}` for its id; enables **Existing…** |
| `usage` | `"claude"`, `"codex"`, `{ "command", "args" }` of a program printing `{ "plan", "windows": [{ "label", "usedPercent", "resetsAt" }] }`, or `null` |
| `history` | `"claude"`, `"codex"`, `"antigravity"`, `"grok"`, `"docker"`, `{ "command", "args" }` of a program printing `{ "sessions": [{ "id", "title", "cwd", "startedAt", "updatedAt" }] }`, or `null` |
| `memory` | `"claude"`, `"codex"`, `"grok"` or `null`; enables **Memory** |
| `modelPattern` | Regular expression that finds the model name on screen |
| `homeVar` | Variable that moves the tool's home folder; required for `accounts` |
| `accounts` | Extra sign-ins; see [Accounts](#accounts) |
| `color`, `monogram`, `icon` | Card appearance; `icon` is a URL path |
| `install`, `docs` | Shown when the tool is not installed; for a `plugin`, `install` is the command **Install** and **Update** run |
| `plugin` | The Docker CLI plugin the tool is (`"agent"` for `docker agent`): the card lists the plugin's copies as `docker info` finds them, offers to remove a downloaded one, and runs `install` to add or update it |
| `releases` | `https://` URL of a "latest release" page that redirects to the release's tag (GitHub's `releases/latest`); its version is the update check for a `plugin` |
| `usageUrl`, `billingUrl`, `cloudUrl` | `https://` links on the card; `null` hides one |
| `win32`, `darwin`, `linux` | Fields that apply on one platform only |

Other fields in the built-in file (`channels`, `hooks`, `reporting`,
`accountEnv`, `multiplexers`, `npmNote`) are for the built-in tools; copy them
from there if you need them.

Google's built-in `"history": "antigravity"` enables **History** on its card.
It opens saved conversations for the working folder, with plain-text previews
and Resume; **Existing…** opens the same browser across folders. Unknown or
multiple saved folders require an explicit folder choice before resuming.
This reads Antigravity CLI's local transcripts and does not configure learned
memory. The other default providers retain their **Memory** entry.

## Accounts

Run a personal and a work sign-in of the same tool side by side. Claude Code,
Codex CLI and Grok Build support this.

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

* Each account appears as a chip on the card, with its own sign-in, meters
  and sessions.
* Without `dir`, the account lives in `accounts/<tool id>/<account id>` in the
  data folder.
* Sign in from the first session of a new account.
* `default` is the tool's own sign-in; only its `label` can change.

## Environment variables

| Variable | Effect |
| --- | --- |
| `AGENT_GUILD_PORT` | Port of the page, default `47821` |
| `AGENT_GUILD_HOME` | Moves the data folder. Turns off **Settings → Startup**. |
| `AGENT_GUILD_NPM_REGISTRY` | npm registry for version checks and installs |
| `AGENT_GUILD_NO_UPDATE_CHECK` | `1` turns off online version checks and self-upgrade |
| `AGENT_GUILD_SKIP_SHELL_ENV` | `1` stops reading PATH from your login shell, or from the registry on Windows |
| `AGENT_GUILD_ALLOWED_HOSTS`, `AGENT_GUILD_ALLOWED_ORIGINS` | Legacy proxy allowlists, used until remote access settings are saved. An invalid value stops the manager from starting. |

Variables set inside each session are listed in
[agent-reporting.md](agent-reporting.md).

## Reverse proxies

For Tailscale, use **Settings → Remote access**; see the
[README](../README.md#remote-access-with-tailscale).

For another proxy, open **Settings → Remote access → Use another reverse
proxy** and save the hosts and origins your browser uses, separated by
commas:

| Field | Example |
| --- | --- |
| Allowed hosts | `guild.example.ts.net:8443` |
| Allowed origins | `https://guild.example.ts.net:8443` |

* Forward HTTP and WebSocket traffic to `127.0.0.1` on the manager's port.
* The proxy must keep the browser's `Host` and `Origin` headers.
* Leave out the port for standard HTTPS (443). No paths, wildcards or
  trailing slashes.
* The page still asks for the access token.
