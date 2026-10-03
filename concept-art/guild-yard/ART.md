# Guild Yard art sources

The Yard uses authored Blender geometry and skeletal animation, with three
generated raster assets for atmosphere and material detail. The code and
editable Blender files are the art sources. Runtime files are in
`web/yard/assets`; generated originals remain here for future art passes.

## Geometry and motion

`build.py` builds four worlds with five provider halls each. Guild combines
stone, oak, bronze and provider-colored roofs. Orbital uses station panels
and instrument domes; Grove uses living wood and garden forms; Professional
uses simple campus architecture. Distinct Guild silhouettes identify the
keep, citadel, observatory, tower and timber workshop at overview scale.

The fifteen main character models and eight helper models have actual rigs
and glTF animation channels. Work motion inclines the body and moves the
hands; rest uses breathing and small head/arm movements. Waiting and done
have separate poses. These are presentation states mapped to existing
manager reports, not simulated game behavior.

The source units are metres. Blender exports Y-up glTF and 24 fps clips.
Seed 714 keeps the authored placement and surface variations reproducible.
`guild.blend` and `hero_0.blend` through `hero_4.blend` can be opened directly
in Blender. Rebuild every other variant with the script. The application
adds the external stone/wood textures to the exported material names;
Blender source previews use the authored base materials.

## Generated image provenance

Mode: built-in `image_gen` generation. Each asset was generated anew; no
external reference artwork was supplied. The original PNG files are
preserved. ImageMagick converts them to the shipped WebP formats.

| Source | Runtime asset | Purpose |
| --- | --- | --- |
| `backdrop-source.png` | `backdrop.webp` | Quiet distant forest and mountain atmosphere behind the 3D court |
| `stone-source.png` | `stone.webp` | Repeating limestone albedo and subtle surface relief |
| `wood-source.png` | `wood.webp` | Repeating oak grain for timber and bark |

### Backdrop prompt brief

Wide 16:9 premium fantasy matte painting of distant forested mountains
under a midnight teal sky with moonlit clouds. Keep the horizon low, with
pine silhouettes at the sides, warm haze and a quiet center for a 3D
foreground. No foreground buildings, characters, text, logos or UI. The
image provides depth and atmosphere behind an interactive miniature RTS
base; it must not contain competing focal subjects.

### Limestone prompt brief

Seamless square limestone albedo texture, warm grey-beige, with fine
pitting, hairline cracks, mineral streaks and restrained moss. A continuous
stone surface with no brick boundaries or mortar joints. Orthographic,
flat and evenly lit, without baked directional shadows, objects, text or
borders. Painterly realistic material detail suited to a premium fantasy
miniature, tileable on all edges.

### Oak prompt brief

Seamless square aged oak texture with vertical grain, brown weathering,
fine fibres and small knots. A continuous wood surface without plank
seams, nails, objects, borders or text. Even flat lighting without baked
highlights or cast shadows. Restrained painterly realistic detail for
fantasy timber architecture, tileable on all edges.

## Guild environment plates

`env/guild_env.py` assembles the lakeside estate in Blender and
`env/plates.py` renders it, with Cycles, into the tiles under
`web/yard/assets/guild/`. Layout is written in a ground frame aligned with
the screen, so composition maps directly to what the Yard shows. Nothing
tall stands where it would cover live halls or characters on screen
(`tall_clear`); the play area is level so live models stand on y = 0.

The lake surface carries the depth beneath it, so it is clear over the
lakebed in the shallows and dark and reflective where deep. Reed clumps are
generated blades; the pier is Poly Haven's modular section repeated. Cloud
shadows come from a hidden layer that only casts shadow, cleared within
60 m of the courtyard so the plate never darkens ground the live halls stand
on while they stay in sunlight.

Sources are Poly Haven CC0 assets (models, textures and the
`kloofendal_48d_partly_cloudy_puresky` sky), listed in `env/guild_env.py`
and pinned in `env/polyhaven.lock.json`. Poly Haven has no lush meadow seen
from above, so `env/textures/meadow.jpg` was generated locally with
local-image-studio (`hidream-o1`, seed 502, 2048 px) from this brief:

Seamless tileable texture, straight top-down orthographic photograph of a
lush healthy green summer meadow: dense short grass with clover, small
scattered white and yellow wildflowers, subtle natural variation in green
tones, soft overcast even lighting with no cast shadows, no horizon, no
perspective, uniform detail across the whole image, high resolution
scanned PBR albedo.

The build makes it wrap by cross-fading each axis with a half-rolled copy,
and blends two scales of it by noise so repeats do not show.

`env/surfaces.py` exports the live halls' materials: the Poly Haven sets in
`SURFACES` (by exact material name) at 512 px, and a 512 × 256 copy of the
sky for image-based lighting. Provider roofs keep their palette colour as a
tint over grey slate, so each hall stays recognisable.

## Review and iteration

Review art inside the application in both light and dark mode and at
overview and focused camera distances. The application renderer uses
ACES tone mapping, directional shadows, external material maps and the
selected skin palette. An isolated Blender render alone is not the visual
acceptance test. `node docs/yard/capture.mjs --all` produces review captures
for every world plus a mobile capture without accessing live sessions.

Keep status and interaction readable through shape and text as well as
color. Preserve exact material names used by `textureWorld`, hall anchor
names and animation clip names when editing sources. Run the optimizer
after a fresh Blender export, then asset/browser tests before committing.
