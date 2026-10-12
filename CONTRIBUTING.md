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
  arm64. On Alpine it checks that `agent-guild` says how to build node-pty
  and that the package works once it is built; `bash tests/package/musl.sh`
  runs that check with Docker. CI also checks the boot service in a systemd
  container (`bash tests/systemd/acceptance.sh <tgz>`), the release plan
  (`node tests/release/plan.mjs`) and the packed tarball
  (`node tests/package/check-tarball.mjs <tgz>`). The tmux card's test runs
  only where tmux is installed.
* The browser checks in `tests/browser` drive the real UI in Chrome; CI runs
  them on Linux and `dialogs.mjs` in WebKit on macOS. Run them in CI order with
  the sequence in [tests/browser/README.md](tests/browser/README.md). For
  example, `node tests/browser/proxy.mjs` checks the real UI and terminal
  through a local HTTPS proxy with an isolated manager and test certificates.
  On Windows, or if Chrome is not in a standard Linux or macOS location, set
  `CHROME_PATH` to Chrome or Edge.
* `npm run test:yard` adds the Yard's browser check to its asset tests; CI
  does not run it.
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
  `fix`, `perf`, `revert` or breaking change. A `!` after the type, as in
  `feat!:`, marks a breaking change and releases the next major version.
  The title is the whole squash commit, so a `BREAKING CHANGE` footer in the
  description does not count.

## Other front ends

The page is one client of the manager's local API, documented in
[docs/api.md](docs/api.md). Another interface, such as a planned Unreal Engine
guild hall, can drive the same sessions at the same time. See
[docs/architecture.md](docs/architecture.md).

