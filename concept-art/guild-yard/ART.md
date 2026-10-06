# Guild Yard art sources

The Guild and Professional halls are authored Blender geometry. The code and
editable Blender files are the art sources. Runtime files are in
`web/yard/assets`; generated originals remain here for future art passes.

## Geometry and motion

`build.py` builds two worlds with five provider halls each. Guild combines
stone, oak, bronze and provider-colored roofs. Distinct Guild
silhouettes identify the keep, citadel, observatory, tower and timber
workshop at overview scale. Professional's halls are five campus buildings:
a studio with a timber-finned upper storey, a glass rotunda under a disc
canopy, a stack of turned glazed volumes, a dark stone tower with a sloped
crown, and a glass hall under a barrel vault. Their materials (`office`,
`white`, `officeDark`, `woodLight` and the provider colours) take
the Poly Haven sets in `SURFACES` of `env/professional_env.py`; the glass and
lit `window` panes keep their authored materials.

The other worlds' halls and every world's characters are TRELLIS.2 models
from `concept-art/<world>-yard`.

The source units are metres, and Blender exports Y-up glTF. `guild.blend`
can be opened directly in Blender; rebuild Professional with the script.
The application adds the Poly Haven sets in `SURFACES` to the exported
material names; Blender source previews use the authored base materials.

## Guild characters

The five heroes (`hero_0`–`hero_4`) and four familiars (`familiar_0`–`familiar_3`,
also Grove's helpers) are textured models made from the Guild skin's art
(`concept-art/default-art-design-v1`) with TRELLIS.2, by the shared pipeline in
`concept-art/yard-models/` run with the world name `guild`; see
`concept-art/goblinville-yard/ART.md` for how each step works. This folder
holds the cast in `world.json`, the edits in `edits.json` and the picks in
`concepts/`; `raw/` and the TRELLIS.2 models in `.cache/guild-yard` are not
committed.

| Step | Command | Writes |
| --- | --- | --- |
| Edits | `python edits.py guild [name ...]` | `raw/edit/<name>-<step>.png` with `qwen-edit`, from `edits.json`; the results replace `concepts/<name>.png` |
| Models | `python build.py guild models [name ...]` | `.cache/guild-yard/models/<name>.glb` with TRELLIS.2 |
| Cast | `python build.py guild cast [name ...]` | `web/yard/assets/hero_*.glb` and `familiar_*.glb`, rigged and animated |

- **Heroes**: the portraits are framed from the knees up, so each is
  restaged full length with `qwen-edit` on a light grey background. The
  sorcerer's floating runes are left out (the runes on his robe stay); the
  knight's glossy obsidian plate is made matte steel, his tattered fur cloak
  a plain wool one, and his emerald seams bold, with an emerald hem, so the
  figure is not a near-black silhouette; the rogue's black leather coat is
  made matte charcoal felt, keeping its cyan circuit traces; the smoke wraith
  is a solid figure in a violet wool robe with a bright trim and the chevron
  in its dark hood; and the Google portrait stays two figures, holding hands,
  as one model, with the star floating between them left out. All five work
  by the steady lean and nod: their arms are folded, joined or in pockets,
  and the sorcerer's wide sleeves stretched into his robe when he conducted.
- **Familiars**: the flame and leaf dragons are the skin's sprites as they
  are; their wings reconstruct whole. The night dragon's glossy crystals
  and translucent wings shattered, so it is restaged matte and opaque with
  stone crystals. The translucent aether spirit is restaged as unmarked
  opaque porcelain with solid wings and tail; painted stars on it baked as
  brown or black specks.

TRELLIS.2 bakes albedo without lighting, so glows (runes, seams, chevrons)
come out as plain paint or are lost, and flat painted emblems are dropped or
garbled: a chevron on the wraith's chest, glowing or matte, did not survive
three tries, and was left out.

### Reconstruction trials

Unedited inputs from later worlds, reconstructed at the settings above and
rendered from four sides (2026-10-06):

| Input | Result |
| --- | --- |
| Guild flame dragon sprite (512 voxels) | Whole from every side: wing membranes, spines, horns and the curled tail all hold. The glow on its scales bakes darker. |
| Orbital OpenAI robot, glossy black enamel (1024 voxels, with its mask) | Geometry whole, sword and cloak included, but the black enamel bakes as bright chrome and the cloak's back as invented olive. Restage matte for colour, not shape. |
| Grove water spirit, translucent (1024 voxels, with its mask) | Shattered into faceted shards; the lily pad breaks into fragments and the koi is lost. Needs an opaque restage, as Gnomeland's wraith had. |
| Grove moss deer (1024 voxels, with its mask) | Whole: the moss reads as a clumpy surface, and antlers, ferns and mushrooms hold. Usable as it is. |

## Guild environment plates

`env/guild_env.py` assembles the lakeside estate in Blender and
`env/plates.py` renders it, with Cycles, into the tiles under
`web/yard/assets/guild/`. Layout is written in a ground frame aligned with
the screen, so composition maps directly to what the Yard shows. Nothing
tall stands where it would cover live halls or characters on screen
(`tall_clear`); the play area is level so live models stand on y = 0.

Each theme is a separate render of the same scene: late morning under
`kloofendal_48d_partly_cloudy_puresky`, and dusk under
`qwantani_dusk_2_puresky` with a low warm sun from the same side and the
lantern posts along the paths lit. The suns come from `SUN` in `model.mjs`,
which the live halls also use, so their shadows fall the same way.

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
AgX tone mapping, directional shadows, external material maps and the
selected skin palette. An isolated Blender render alone is not the visual
acceptance test. `node docs/yard/capture.mjs --all` produces review captures
for every world plus a mobile capture without accessing live sessions.

Keep status and interaction readable through shape and text as well as
color. Preserve exact material names used by `SURFACES`, hall anchor
names and animation clip names when editing sources. Run the optimizer
after a fresh Blender export, then asset/browser tests before committing.

## Professional environment plates

`env/professional_env.py` builds an office campus for Professional's plates,
rendered with `plates.py -- professional` and its live surfaces with
`surfaces.py -- professional`. A level plaza of large grey slabs, edged in
granite with a still round pool at its centre, carries the live halls and
session markers; planters and benches line its back and left edges. Mown
lawns with stripes, footpaths and two tree-lined avenues lead out to a pond
with café tables, and office blocks stand in a row behind the plaza and
along the avenues' outer sides. The blocks are modelled in the script: a
curtain wall drawn by a shader (mullions and spandrels in Poly Haven
concrete over reflective glass, in three styles) above a glazed lobby, with
a parapet and roof plant. Every block is kept low enough to stay in view
and off the live area (`tall_clear`).

Light renders under `kloofendal_38d_partly_cloudy_puresky`; dark under
`qwantani_dusk_1_puresky`, with a share of the offices lit, glazed lobbies
and the street lamps on. Every other source is Poly Haven CC0 (trees,
shrubs, reeds, planters, benches, café sets, street lamps, paving, asphalt,
granite, concrete and gravel), pinned in `env/polyhaven.lock.json`; the
lawn is the Guild's generated `meadow` texture.

The session markers stay simple: `loadUnit` in `web/yard/renderer.js`
draws a granite-grey plinth and a satin column in the provider's colour,
which glows at dusk.
