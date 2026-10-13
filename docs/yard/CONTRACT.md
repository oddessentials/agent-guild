# Yard staging contract

Every Yard client (the web page today, and any later native one) moves
characters the same way, from the same data. This page is the contract. The
reference implementation is `web/yard/model.mjs`, and the golden vectors in
`tests/fixtures/yard-choreography.json` pin it. A client in another language
ports those functions and must reproduce every vector exactly.

## Inputs

Only what the manager API already reports ([api.md](../api.md)). Staging adds
no events, endpoints or hooks.

| Field | Used for |
| --- | --- |
| Session `status`, `activity`, `lastOutputAt` (else `startedAt`, else `createdAt`) | The session's mode |
| Session `id`, `createdAt`, `provider.id` | Stations, rest spots, doors and clip choices |
| Agent `status`, shell `kind` | Helper clips, as before |
| The session list itself (created, updated, removed) | Who arrives, who leaves |

## Modes

| Mode | When | Where the character is | Clips |
| --- | --- | --- | --- |
| `work` | `status` running and `activity` active | Its station | `work_0`, `work_1` |
| `pause` | Running and quiet for less than `STAGING.restAfter` (20 s) | Its station | `pause` |
| `rest` | Running and quiet for `restAfter` or longer | A rest spot round the plaza's centrepiece | `idle_0`, `idle_1`, `idle_2` |
| `done` | `status` exited | Its station | `done` |

Between places a character plays `walk`. With reduced motion it appears at
its place without walking.

A quiet session's change to `rest` happens at `lastOutputAt + restAfter`,
which `nextStagingChange` returns, so a client schedules one update for that
moment instead of polling.

## Places

* **Stations** are `layoutSessions`: each provider's crew stands in rows of
  four in front of its hall, keeping its slots across unrelated changes.
  Sessions with no hall (clone and upgrade tasks) use the `__tasks` group.
  Characters face `STAGING.stationFace` there.
* **Rest spots** are `restSpots`: rings round the plaza's centrepiece at the
  world origin, nearest ring first. Each ring starts on the far side, where a
  resting character faces the camera, and alternates outwards. Spots inside a
  hall, or within 1.1 m of the first two crew rows of any hall, are left out.
  `stage` keeps a resting session on its spot across unrelated changes; when
  every spot is taken, the others wait at their stations in `pause`.
* **Doors** are `doorFor`: in front of a session's hall (further out for
  Docker Agent's larger hall), or the plaza for a session with no hall. A
  session a client has not shown before steps out of its door when `arrives`
  says it was created in the last `STAGING.arrival` (15 s); otherwise it
  appears at its place, as every session does when a page opens.
* **Routes** are `route`: the shortest path that keeps out of every hall's
  footprint and the centrepiece, by their corners when the straight line is
  blocked.

## Clip choices

`clipFor(id, mode, n)` is the nth clip a session plays in a mode. A client
plays each clip once and then asks for the next, so a crew never moves in
step, and the same session plays the same sequence everywhere. Clip choices
use `hash`, a 32-bit string hash whose wraparound a port must match.

Positions and clips are deterministic. Only a walk in progress depends on
when its state change arrived, so two clients agree as soon as each walk ends.

## Models

Every character and helper model (`web/yard/assets/<prefix><n>.glb`) carries:

* **The skeleton** in `SKELETON`: Godot's humanoid profile names (`Hips`,
  `Spine`, `Chest`, `UpperChest`, `Neck`, `Head`, and `Left`/`Right`
  `Shoulder`, `UpperArm`, `LowerArm`, `Hand`, `UpperLeg`, `LowerLeg`, `Foot`,
  `Toes`) under a `Root`, plus a `PropLeft` and `PropRight` socket in each
  hand that carries any held tool. Helpers carry the trunk only.
* **The clips** in `CLIPS`: for characters `walk`, `work_0`, `work_1`,
  `pause`, `idle_0`, `idle_1`, `idle_2` and `done`; for helpers `idle`,
  `working`, `waiting`, `done` and `move`. Every clip loops seamlessly. The
  walk is in place.
* **`yard` extras** on the skeleton's node: `height` in metres, and `stride`
  (metres a walk cycle covers) and `cycle` (its seconds), so a client moves
  the character at `stride / cycle` and its planted feet do not slide.
  `events` lists moments in a clip, such as `impact` where a hammer lands:
  `clip`, `time` in seconds, and `at`, the point in the model's own
  coordinates (glTF, metres).

`concept-art/yard-models/rig.py` makes these; [the Yard guide](README.md)
says how to rebuild them. The web copies are quantized with
`KHR_mesh_quantization`, which Godot 4 does not import: a Godot client takes
them through `scripts/dequantize-yard.mjs` (the cast build's `godot` step
does, and checks every model imports with the humanoid profile's bones and
the contract clips).

## Changing the contract

Change `model.mjs`, run `node scripts/yard-golden.mjs --write`, and update
this page in the same change. Every client then follows.
