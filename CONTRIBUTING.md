# Contributing

```sh
git clone https://github.com/oddessentials/agent-guild.git
cd agent-guild
npm install
npm start      # open the page, starting a manager from this checkout if none runs
npm test
```

* The tests start real managers and real pseudo-terminals, using a small fake
  coding tool in `tests/fixtures`. The tmux card's tests run only where tmux
  3.2 or later is installed.
* CI also checks the browser UI, the packed package, the Alpine build, the
  boot service and the release plan. Each step and the command it runs is in
  [.github/workflows/ci.yml](.github/workflows/ci.yml).
* The browser checks in `tests/browser` drive the real UI in Chrome. Run
  them in CI order with the sequence in
  [tests/browser/README.md](tests/browser/README.md). On Windows, or if
  Chrome is not in a standard Linux or macOS location, set `CHROME_PATH` to
  Chrome or Edge.
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
  [Conventional Commits](https://www.conventionalcommits.org/), and a CI
  check refuses one that does not. Merging to
  `main` publishes a release to npm and GitHub when it includes a `feat`,
  `fix`, `perf`, `revert` or breaking change. A `!` after the type, as in
  `feat!:`, marks a breaking change and releases the next major version.
  The title is the whole squash commit, so a `BREAKING CHANGE` footer in the
  description does not count.

## Contributor agreement

Agent Guild's license is in [LICENSE](LICENSE). By opening a pull request,
you agree that:

* The contribution is your own work, or you have the right to submit it.
  Any third-party material in it is named in the pull request with its
  license.
* You give Odd Essentials a perpetual, worldwide, royalty-free and
  irrevocable license to use, copy, change, distribute, sublicense and sell
  your contribution, including in paid products, and to release it under
  any license.
* You give Odd Essentials the same license to any of your patents that the
  contribution uses.
* This covers code, documentation and art alike, including skins,
  characters, buildings and companions.
* You keep the copyright in your contribution.
## Yard models (rig.py)

Changes to `concept-art/yard-models/rig.py` or `build.py` need the rig's own
regression tests, which run inside Blender 5.2 (the version `build.py` is
pinned to) and are not part of CI:

```sh
"E:/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --factory-startup --python concept-art/yard-models/test_rig.py
```

It prints `test_rig ok`. Then recast every world (`python build.py <world> cast`
for the six worlds), optimize (`npm run optimize:yard`), and run `npm run
test:yard` and `tests/yard-art.test.mjs` against the optimized assets. Casting
rigs with Blender's bone heat on one OpenMP thread (`build.py` sets
`OMP_NUM_THREADS=1`); on more threads the same model exports different bytes.

## Other front ends

The page is one client of the manager's local API, documented in
[docs/api.md](docs/api.md). Another interface, such as a planned Unreal Engine
guild hall, can drive the same sessions at the same time. See
[docs/architecture.md](docs/architecture.md).

