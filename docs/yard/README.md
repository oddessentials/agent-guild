# Yard implementation and art guide

Yard is an alternate presentation of Agent Guild's existing providers and
sessions. Cards remains the default. Both layouts share application state,
command handlers, dialogs, authentication and terminal instances. Switching
views does not create sessions or reconnect terminals.

## Migration decisions

The manual fork at `E:/projects/temp/agent-guild-3d`, branch `feat/guild-yard`,
provided the courtyard, provider halls, selection and view-toggle concept.
Its implementation reads card DOM, forwards clicks, places characters over
a raster plate and limits the scene to eight sessions per group. Those
implementation choices were not carried over. No fork backend or provider
configuration was imported.

The original project remains authoritative for every feature and API. The only manager change adds glTF MIME types to static
serving; authentication, routes and the content security policy are unchanged.

## Shared behavior

`web/app.js` owns state and all commands. Its `initYard` adapter supplies a
public presentation snapshot, the existing terminal/news openers, and an
inspector built with the same `buildProvider`, `buildCard` and `updateCard`
functions as Cards. Account selection and pending actions stay in
shared state. There is no Yard API client, event socket or polling loop.

New is pending for one provider, account and working folder. Resume is
pending for one provider, account and conversation, including its controls
in history and both layouts. The matching buttons show Starting/Resuming
and block duplicates until that request finishes; unrelated actions remain
available. Install/update has a separate request guard and retains the
manager's existing safety checks and confirmation.

| Feature | Shared entry point |
| --- | --- |
| New sessions, accounts, install and update | Canonical provider controls in the inspector |
| Usage, billing and benchmarks | Canonical usage meters, links and model dialog |
| History and resume | Existing history dialog, account matching and missing-folder fallback |
| Open, rename, stop, remove and resume sessions | Canonical session controls and terminal cache |
| GitHub accounts, clone and create | Existing toolbar button and GitHub dialog |
| Upgrade, restart and stop manager | Existing topbar controls and confirmation/error handling |
| Authentication and stopped manager | Existing screens hide the app and suspend scene rendering |
| News, release notes, appearance and working folder | Existing dialogs and global controls |

`web/yard/view.js` handles selection, the searchable roster and the view
preference. `renderer.js` handles geometry, camera and animations;
`model.mjs` contains presentation-only placements and state mappings.

Failed character/helper downloads are evicted from the asset cache.
Existing objects can retry when their working/resting/exited state or
helper appearance changes; rebuilding a world also provides a fresh load
opportunity. Unchanged snapshots, telemetry and animation frames never
trigger another attempt. Successful assets and in-flight loads stay shared.

## Worlds and animation

One renderer and interaction system serves four separately authored worlds.
Gnomeland and Goblinville stay on Cards until they have worlds. The Yard
button remains in the bar for those skins and is disabled. A saved Yard
preference is left as it is, so choosing Guild, Orbital, Grove, or
Professional again shows the yard.

| Skin | World | Session representation |
| --- | --- | --- |
| Guild | Stone courtyard, five distinct halls, bronze trim and warm windows | Five rigged fantasy characters with familiar companions |
| Orbital | Station deck, observatories, panels and illuminated rings | Five robot variants and helper drones |
| Grove | Tree dwellings, stepping stones, mushrooms and planted borders | Five woodland spirits and small companions |
| Professional | Restrained architectural campus | Simple session markers without character art |
| Gnomeland | Cards only, until it has a world | |
| Goblinville | Cards only, until it has a world | |

Running sessions with active output use the `working` clip. Quiet running
sessions use `resting`; they still say **Running**. Exited sessions use a
subdued `done` pose and say **Exited**. Familiar poses come from reported
working, waiting, idle and done states. Shell helpers represent actual
reported shell commands. The scene never invents tasks, progress or helpers.

Every session has a roster entry and a stable scene slot, including custom
providers, clone and upgrade tasks. Large groups extend beyond the central
courtyard and can be reached using **Focus selected** or camera panning.
Up to six companions are drawn around each character to keep its silhouette
readable. The full helper count and every helper detail remain available in
the inspector. This is a visual density limit, not a session or API limit.

## Controls and rendering

Select a scene object or roster row to inspect it. Double-click a session,
or use **Open**, to return to its terminal. Drag to pan, scroll/pinch to zoom,
and use **Overview** or **Focus selected** to reposition the camera. When the
stage has keyboard focus, arrow keys pan, plus/minus zoom, Home resets the
camera, Enter opens the selected session and Escape clears selection.
Ordinary buttons and the roster support keyboard navigation.

The engine and GLBs load only after an authenticated app displays Yard.
The engine is bundled locally, and all assets use same-origin URLs. There
is no CDN, runtime compiler, WASM decoder or Unreal runtime. WebGL2 failure
leaves the roster and inspector available, with Retry and Cards controls.
World loads time out after 30 seconds. Failed or disposed scenes cancel
pending model requests and release their graphics context, so Retry can
start a fresh scene even when initialization was interrupted.

Rendering pauses while Cards, a terminal, an authentication screen or a
stopped-manager screen is shown, and while the document is hidden. Reduced
motion draws only when state or camera changes. Label layout also updates
only on changes. Pixel ratio is capped at 1.5; shadow maps are 2048 pixels.
World switches release old geometry, materials, textures and skeletons.
Actual frame rate depends on the browser, GPU and visible session count;
the regression tests do not establish a universal frame-rate guarantee.

## Art sources and rebuilding

All world geometry, rigs and animation clips were authored in
[`concept-art/guild-yard/build.py`](../../concept-art/guild-yard/build.py)
using Blender 5.2. Editable `guild.blend` and five Guild character `.blend`
files are alongside it. The script reproduces all four worlds, fifteen
character variants, four familiars and four drones. Models use metres,
glTF Y-up, named provider anchors and five animation clips: `resting`,
`working`, `waiting`, `done` and `arrival`. Arrival is available in the art
set; live sessions currently enter in their reported working/resting pose.

The raster backdrop, limestone and oak textures were generated with the
built-in image generation tool. Originals and the full prompt briefs are
recorded in the [art source notes](../../concept-art/guild-yard/ART.md).
Guild's surroundings are pre-rendered environment plates: a lakeside
meadow, orchard and forested hills built in Blender from
[Poly Haven](https://polyhaven.com/license) CC0 models, textures and sky,
then path-traced from the Yard's own camera direction. Because the camera
is orthographic and never rotates, the plates line up with the live halls
and characters at every pan and zoom. The camera and pan bounds live in
`web/yard/model.mjs`; the Blender scripts read them from there, and the
tests fail if the plates were rendered for a different camera. Three tile
layers (whole extent, default zoom, close to the courtyard), rendered once
for each theme (late morning for light, dusk with lit lanterns for dark),
cover any stage
up to a 4:1 aspect; wider stages zoom in rather than see past them. The
live halls take Poly Haven stone, slate and timber sets by material name,
and light from small copies of the plates' skies, with the same sun and AgX
tone curve each theme was rendered with. The suns live in `model.mjs`
beside the camera. No
other downloaded model packs or third-party game art are included. The
project license applies to the authored sources; Three.js retains its
accompanying MIT notice at `web/yard/vendor/LICENSE.three`.

From the repository root:

```sh
npm ci
blender --background --factory-startup --python concept-art/guild-yard/build.py
blender --background --factory-startup --python concept-art/guild-yard/env/plates.py -- guild
blender --background --factory-startup --python concept-art/guild-yard/env/surfaces.py -- guild
npm run optimize:yard
npm run build:yard
npm run test:yard
```

`build.py -- --only guild` rebuilds one world, and `optimize:yard guild`
optimizes only its model. Plate rendering needs a Cycles-capable GPU and
downloads its Poly Haven sources into `.cache/polyhaven`, pinned by the
checksums in `env/polyhaven.lock.json`. Change the camera in `model.mjs`
only together with a plate re-render.

The optimization step welds duplicate vertices, deduplicates data and uses
[glTF Transform quantization](https://gltf-transform.dev/functions/quantize)
to reduce precision below the visible detail of these miniatures. Hall
anchors are kept on parent nodes so mesh transforms cannot move their
placement. Checked-in GLBs and the engine bundle are ready to serve;
installed package users do not build assets or need Blender.

## Safe preview and verification

```sh
npm run preview:yard
node docs/yard/capture.mjs --all   # --wide: 21:9 and 32:9 at each zoom
npm test
```

The preview prints a local URL and uses the real static/API/WebSocket server
with in-memory provider, account, history, GitHub and session fixtures.
It never starts coding tools, accesses personal accounts, clones a repository
or stops a real manager. Browser captures and test profiles live in ignored
`.cache/` directories. Set `CHROME_PATH` if Chrome/Edge is not in a standard
location. Browser tests explicitly skip when no browser binary is available.
CI permits [Chromium's software WebGL fallback](https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md)
only in these disposable fixture profiles. Set `YARD_SOFTWARE_GL=1` to force
that path locally; this never changes the user's normal browser settings.

The Yard tests cover request parity between Cards and Yard, terminal/socket
preservation, accounts/usage, benchmarks, history including missing folders
and already-running conversations, session actions, GitHub clone/create,
upgrade, stop/restart, authentication, graphics failure/retry, all skins,
40 sessions, reduced motion, mobile overflow, reconnect and skin-load races.
They also cover overlapping New/Resume requests, duplicate submission across
views, independent install requests and model recovery without retry loops.
Asset tests verify the shipped GLBs contain anchors, skinning and clips.

The release gate is 32 MiB packed. Run `npm pack` and
`node tests/package/check-tarball.mjs <archive>` after asset changes. Pack on
Linux/macOS for release: Windows npm archives do not preserve executable
mode bits on node-pty's macOS spawn helpers, which the gate correctly rejects.
The repository's release workflow already packs on Linux.
