# Contributing

```sh
git clone https://github.com/oddessentials/agent-guild.git
cd agent-guild
npm install
npm start      # open the page, starting a manager from this checkout if none runs
npm test
```

* The tests start real managers and real pseudo-terminals, using a small fake
  coding tool in `tests/fixtures`. CI runs them on Windows, macOS and Linux
  with Node.js 22, 24 and 26, and installs the packed package on x64 and
  arm64.
* `node tests/browser/proxy.mjs` checks the real UI and terminal through a
  local HTTPS proxy with an isolated manager and test certificates. On Windows,
  or if Chrome is not in a standard Linux or macOS location, set
  `CHROME_PATH` to Chrome or Edge.
* In a checkout, `launchers/AgentGuild.cmd` (Windows) and
  `launchers/AgentGuild.command` (macOS) start Agent Guild with a
  double-click.
* `node docs/capture/capture.mjs --root <folder>` refreshes the screenshots
  in `docs/images` from the real page, with demo sessions in place of real
  tools. The cards show the folder's path, so pick a neutral one such as
  `D:\code` or `/work`. It needs Chrome or Edge and leaves any running
  manager alone. See the comment at the top of the script for options.
* Pull request titles follow
  [Conventional Commits](https://www.conventionalcommits.org/). Merging to
  `main` publishes a release to npm and GitHub when it includes a `feat`,
  `fix`, `perf`, `revert` or breaking change.

## Other front ends

The page is one client of the manager's local API, documented in
[docs/api.md](docs/api.md). Another interface, such as a planned Unreal Engine
guild hall, can drive the same sessions at the same time. See
[docs/architecture.md](docs/architecture.md).

