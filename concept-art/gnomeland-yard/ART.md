# Gnomeland Yard art sources

The Gnomeland yard is a timber-and-stone mountain village of gnome builders,
with a lake, a waterfall off a cliff and mountains beyond. Its live models
(five builders, four familiars, four shell helpers and five provider halls)
are textured 3D models made from painted images with
[TRELLIS.2](https://github.com/microsoft/TRELLIS.2) (MIT), running in the
local image studio's ComfyUI. The surroundings are pre-rendered plates, built
like the Guild's (see `concept-art/guild-yard/ART.md`).

## Pipeline

The steps are the shared Yard model pipeline in `concept-art/yard-models/`,
run with the world name, as for Goblinville (see
`concept-art/goblinville-yard/ART.md` for how each step works). This folder
holds Gnomeland's `world.json` (cast, village buildings and the subjects cut
out onto grey), `concepts.json` and `edits.json`.

| Step | Command | Writes |
| --- | --- | --- |
| Concepts | `python concepts.py gnomeland [name ...] [--seeds N]` | `raw/<name>-<seed>.png` with `hidream-o1`, from `concepts.json`; copy picks to `concepts/<name>.png` |
| Edits | `python edits.py gnomeland [name ...]` | `raw/edit/<name>-<step>.png` with `qwen-edit`, from `edits.json`; the results replace `concepts/<name>.png` |
| Models | `python build.py gnomeland models [name ...]` | `.cache/gnomeland-yard/models/<name>.glb` with TRELLIS.2 (`trellis.py`) |
| Cast | `python build.py gnomeland cast [name ...]` | `web/yard/assets/gnome_*.glb`: rigged and animated (`rig.py`) |
| Halls | `python build.py gnomeland halls` | `web/yard/assets/gnomeland.glb` (`halls.py`) |
| Plates | `blender -b --factory-startup --python concept-art/guild-yard/env/plates.py -- gnomeland` | `web/yard/assets/gnomeland/` |
| Sky | `blender -b --factory-startup --python concept-art/guild-yard/env/surfaces.py -- gnomeland` | `web/yard/assets/gnomeland/surfaces.json` and skies |

`raw/` and the TRELLIS.2 models are not committed; the concept picks, plates
and runtime models are. Then run `npm run optimize:yard`, which moves each
model's textures to `web/yard/assets/maps/`, and the Yard tests.

## Sources

- **Builders** are the Gnomeland skin's portraits,
  `concept-art/gnomeland-skin/characters/<provider>/idle.png`, restaged with
  `qwen-edit` (`edits.json`) full length on a light background in a relaxed
  stance: `concepts/builder_<provider>.png`. TRELLIS.2 reconstructs floating
  pieces, glossy black, fur and translucency as broken geometry, so the
  Anthropic builder's floating runes and the Google builder's floating stones
  and cogs are left out, the OpenAI builder's blackened armour is made matte
  gunmetal with a wool cloak in place of the fur-trimmed cape, the xAI
  builder's glossy leather coat is made matte felt, and the spectral shell
  builder is made a solid figure in a violet wool robe with the chevron in
  its dark hood.
- **Familiars** are the skin's `familiars/`, edited (`edits.json`): the
  salamander's flames removed; the hedgehog made a carved and painted wooden
  figure with a smooth leaf-carved shell, after its spines and then a shell
  of leaf shingles both reconstructed as shards (seed 123, as `world.json`
  records; 42 still shattered); the owl made of smooth enamelled plates in
  place of feathers; and the lantern drone's energy ring removed, its
  propellers stilled and its glass globe made an opaque crystal.
- **Rigging**: the Google, xAI and shell builders hold a staff, keep their
  hands in their pockets, or wear a ragged robe, so they work with `steady`
  (a lean and nod with the hands still), which keeps their cloth from
  stretching.
- **Halls, village buildings and shell helpers** are generated from
  `concepts.json`: each entry is a prompt, its seed, a shared style and the
  picked seed as `pick`. Gnome figures and background scenery in the picked
  halls and buildings were removed with `qwen-edit`, and the snail helper was
  put on a flat background with matte surfaces after its first
  reconstruction shattered. The picks are in `concepts/`. The Anthropic and
  xAI halls are turned so their rune front and round-window gable face the
  camera (`turn` in `world.json`).

## Plates

`concept-art/guild-yard/env/gnomeland_env.py` builds a level cobbled square
under the live area, edged with a kerb and a low dry-stone wall on its far
sides, with a millstone set flush at its centre. Cobbled roads with split-rail
fences and lantern posts lead from it between the village's TRELLIS.2
cottages, towers, mill and workshops, with barrels, crates, tables and garden
gnomes about them, through a flowering meadow to a lake. Behind the lake a
river falls off a cliff into spray, forested valley walls rise on either
side, and mountains beyond pale in thin haze. Light renders under
`kloofendal_misty_morning_puresky`; dark under `qwantani_moonrise_puresky`,
dimmer than other worlds' dusk, so the lanterns and lit windows carry the
village.
Other sources are Poly Haven CC0, pinned in `env/polyhaven.lock.json`.
