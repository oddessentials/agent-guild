# AGENTS.md

Notes for coding agents working in this repository. People start with
[README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

**Setting Agent Guild up for someone, rather than changing it?** Follow
[plugins/agent-guild/skills/setup-agent-guild/SKILL.md](plugins/agent-guild/skills/setup-agent-guild/SKILL.md).

## Layout

* `bin/agent-guild.mjs`: the launcher CLI (`open`, `start`, `stop`, `status`, `url`, `doctor`, `mcp`).
* `src/manager/`: the session manager, which owns every terminal and serves the
  local API in [docs/api.md](docs/api.md). Its design is in
  [docs/architecture.md](docs/architecture.md).
* `src/mcp/server.mjs`: `agent-guild mcp`, an MCP client of that API
  ([docs/mcp.md](docs/mcp.md)).
* `web/`: the page and the Yard. Skins follow [docs/SKINS.md](docs/SKINS.md).
* `tests/`: `node --test` suites. Most start real managers and real
  pseudo-terminals with the fake tools in `tests/fixtures`.

## Work

```sh
npm install
npm test
```

* Node.js 22 or newer, plain ES modules, no build step for the manager or the page.
* The API is a contract: a change to it updates `docs/api.md` in the same change.
* Never print, log or return the API token or the page link (`#token=`).
* Pull request titles follow Conventional Commits; a `feat` or `fix` merged
  to `main` publishes a release.
