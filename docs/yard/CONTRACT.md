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
  four in front of its hall, `STAGING.station.spacing` (2 m) apart, keeping
  its slots across unrelated changes. Sessions with no hall (clone and upgrade
  tasks) use the `__tasks` group. Characters face their station prop there
  (below).
* **Rest spots** are `restSpots`: rings round the plaza's centrepiece at the
  world origin, nearest ring first. Each ring starts on the far side, where a
  resting character faces the camera, and alternates outwards. Spots inside a
  hall, within 1.1 m of the first two crew rows of any hall, or by any prop
  those rows could have, are left out.
  `stage` keeps a resting session on its spot across unrelated changes; when
  every spot is taken, the others wait at their stations in `pause`.
* **Doors** are `doorFor`: in front of a session's hall (further out for
  Docker Agent's larger hall), or the plaza for a session with no hall. A
  session a client has not shown before steps out of its door when `arrives`
  says it was created in the last `STAGING.arrival` (15 s); otherwise it
  appears at its place, as every session does when a page opens.
* **Routes** are `route`: the shortest path that keeps out of every hall's
  footprint, the centrepiece and every station prop (a square of half width
  `STAGING.station.half` round each), by their corners when the straight line
  is blocked. A prop the walk starts or ends in is no obstacle.

## Station props

Every session has a prop at its station, from the moment it appears until
it is removed, whether its character is there or resting at the plaza.
`stationProp(place, id)` gives it, for the station `place` (the slot,
rounded to the millimetre as `stage` rounds it):

| Field | Meaning |
| --- | --- |
| `arrangement` | `counter`, `left` or `right`, the session's own from `hash(id + ':station')` |
| `x`, `z` | Where the prop stands: `STAGING.station.gap` (0.75 m) from the character, along `characterFace` |
| `face` | Which way the prop's front faces: back towards the character |
| `characterFace` | Which way the character faces at the station |

A `counter` prop stands on the camera side, and the character behind it faces
it and the camera (`STAGING.stationFace`). A `left` or `right` prop stands to
that side as the camera sees it, the character turned `STAGING.station.turn`
(0.7 rad) three-quarters toward it, so no character turns its back to the
camera. Each world's prop is the model `WORLDS[skin].station.asset`, built to
a working surface `station.surface` high for a 2 m character; a client
scales each one to its character's `yard.surface`, so hands meet the surface.
A client loads the prop once per world, as it does a helper model.

## Halls at work

`hallActivity(sessions, providerId)` is how busy a hall looks: `off` with
none of its sessions working (running with `activity` active), `low` with
one, `high` with two or more. A custom provider's hall, a copy of the shell
hall, follows its own sessions. Every hall model carries two named nodes:
`hall_<provider>_smoke`, at its chimney, tower or roof vent, and
`hall_<provider>_glow`, at the front centre at door height. While a hall is
`low` or `high`, its windows, door and glass glow brighter than the theme
leaves them, and it gives off its world's effect from its smoke anchor
(`WORLDS[skin].effect`, one of `EFFECTS`: chimney smoke, vent steam, rooftop
steam, or fireflies that wander round a tree hall), at the preset's low or
high rate. Both fade in and out over a second or so. With reduced motion a
client shows the glow as it stands, with no effect; while rendering pauses,
neither moves.

## Glances

`lookTarget(sessionId, places, selected)` is whom a character looks at, from
`stage`'s places: only a character resting or pausing looks, at the selected
session when it is within `STAGING.look.range` (2.5 m), otherwise at the
nearest other within range (the lower id on a tie), or at no one (`null`).
A client turns the character's `Neck` and `Head` toward it after the clip
has posed them, about the model's own up and right axes, the neck taking
`STAGING.look.neck` (40%) of the turn and the head the rest, at most
`STAGING.look.yaw` (0.7 rad) either way and `STAGING.look.pitch` (0.3 rad)
up or down, easing in and out. A walking character does not look. With
reduced motion a character does not glance.

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
  the character at `stride / cycle` and its planted feet do not slide. A
  character's `surface` is the height in metres its hands work at: its
  world's `station.surface` scaled by its shoulder height (1.5 m for a 2 m
  figure).
  `events` lists moments in a clip, such as `impact` where a hammer lands:
  `clip`, `time` in seconds, and `at`, the point in the model's own
  coordinates (glTF, metres).

A character's `Neck` and `Head` sit where its silhouette pinches in under the
head, so a hat, helmet, hood or beard turns with the head, and it turns to
the glance limits without tearing. Each world's station prop
(`web/yard/assets/<world>_station.glb`) is a plain model with no skin or
clips, standing on the ground with its front, the side its character works
at, toward +Z.

`concept-art/yard-models/rig.py` makes these; [the Yard guide](README.md)
says how to rebuild them. The web copies are quantized with
`KHR_mesh_quantization`, which Godot 4 does not import: a Godot client takes
them through `scripts/dequantize-yard.mjs` (the cast build's `godot` step
does, and checks every model imports with the humanoid profile's bones and
the contract clips, and the station prop as a plain model).

## Changing the contract

Change `model.mjs`, run `node scripts/yard-golden.mjs --write`, and update
this page in the same change. Every client then follows.
