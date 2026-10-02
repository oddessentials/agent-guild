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
