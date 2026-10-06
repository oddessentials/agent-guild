# Grove Yard art sources

The Grove yard is a sunlit glade in an old forest, where woodland spirits
live in tree dwellings, with a spring at its centre, a stream behind it
running into a lily pond, and wooded hills beyond. Its live models (five
spirits and five provider tree halls) are textured 3D models made from
painted images with [TRELLIS.2](https://github.com/microsoft/TRELLIS.2)
(MIT), running in the local image studio's ComfyUI. Its familiars are the
Guild's (`familiar_*`, see `concept-art/guild-yard/ART.md`) and its shell
helpers Orbital's drones (`drone_*`, see `concept-art/orbital-yard/ART.md`).
The surroundings are pre-rendered plates, built like the Guild's.

## Pipeline

The steps are the shared Yard model pipeline in `concept-art/yard-models/`,
run with the world name, as for Goblinville (see
`concept-art/goblinville-yard/ART.md` for how each step works). This folder
holds Grove's `world.json` (cast, village dwellings and seeds other than 42),
`concepts.json` and `edits.json`.

| Step | Command | Writes |
| --- | --- | --- |
| Concepts | `python concepts.py grove [name ...] [--seeds N]` | `raw/<name>-<seed>.png` with `hidream-o1`, from `concepts.json`; copy picks to `concepts/<name>.png` |
| Edits | `python edits.py grove [name ...]` | `raw/edit/<name>-<step>.png` with `qwen-edit`, from `edits.json`; the results replace `concepts/<name>.png` |
| Models | `python build.py grove models [name ...]` | `.cache/grove-yard/models/<name>.glb` with TRELLIS.2 (`trellis.py`) |
| Cast | `python build.py grove cast [name ...]` | `web/yard/assets/spirit_*.glb`: rigged and animated (`rig.py`) |
| Halls | `python build.py grove halls` | `web/yard/assets/grove.glb` (`halls.py`) |
| Plates | `blender -b --factory-startup --python concept-art/guild-yard/env/plates.py -- grove` | `web/yard/assets/grove/` |
| Sky | `blender -b --factory-startup --python concept-art/guild-yard/env/surfaces.py -- grove` | `web/yard/assets/grove/surfaces.json` and skies |

`raw/` and the TRELLIS.2 models are not committed; the concept picks, plates
and runtime models are. Then run `npm run optimize:yard`, which moves each
model's textures to `web/yard/assets/maps/`, and the Yard tests.

## Sources

- **Spirits** are the Grove skin's portraits,
  `concept-art/grove-skin/characters/<provider>/idle.png`, restaged with
  `qwen-edit` (`edits.json`) full length on a light grey background with
  every surface matte. Fur, feathers, smoke and translucency shatter in
  TRELLIS.2, so: the moss deer's coat is a smooth dense moss with carved
  antlers (moss holds, as the Guild trial found); the translucent water
  spirit is opaque glazed ceramic in water blue, its koi a bold painted
  shape; the smoky bird is a carved and painted wooden figure, white with
  charcoal markings and bold cyan crest, wing tips and tail; and the
  floating lantern spirit stands on two stone legs with no smoke or
  fireflies, its glowing window a flat lilac face panel. The lantern spirit
  first shattered as rough mossy stone; restaged as smooth carved stone with
  painted moss and chunky amethyst wisteria, it held at seed 123 (42 still
  broke). The fox shattered six times: as a felted figure, as a smooth
  carved one facing straight on (seeds 42 and 123, 1024 and 512 voxels),
  and on a mid-grey background. A carved and painted fox shown in
  three-quarter view, its lantern hung round its neck, reconstructed whole
  at seed 123.
- **Rigging**: all five work with `steady` (a lean and nod with the hands
  still). The fox wears a cloak, the deer stands on four legs, the water
  spirit's hands are clasped, and `tinker` folded the bird's wings across
  its face and twisted the lantern's body.
- **Halls and village dwellings** are generated from `concepts.json`: each
  entry is a prompt, its seed, a shared style and the picked seed as `pick`,
  chosen by contact sheet. Each hall carries its provider's colour in bold
  shapes and has its own silhouette: a broad oak under an autumn crown with
  paper lanterns, a mossy hollow trunk crowned with pale antlers, a
  blue-shingled cottage with a waterwheel under a round leaf dome, a tall
  pine with cyan-roofed rooms up a spiral stair, and a pagoda in a wisteria
  tree with amethyst roofs and blossoms. The painterly picks carried mottled
  backgrounds and wispy foliage, which TRELLIS.2 dropped, flattened into a
  card or shattered, so `edits.json` restages the oak, willow and wisteria
  halls and the treehouse, stump house and toadstool houses as chunky
  stylized 3D models on plain grey; the antler hall's forest background was
  removed. The stone lantern and the pine hall reconstructed from their picks
  as they are. Every model was checked from four sides.

## Plates

`concept-art/guild-yard/env/grove_env.py` builds a level glade under the
live area: grass broken by patches of moss and leaf litter, with a spring
under a mossy stone rim at its centre and a ring of stepping stones round
it. Forest paths lead out between the village's TRELLIS.2 treehouses, stump
houses and toadstool houses, with stone lanterns where they leave the glade
and lantern posts along them. Behind the glade a stream runs in a shallow
valley, crossed by stepping stones, into a lily pond; old broadleaf and
conifer woods with ferns, moss, fallen trunks and mossy rocks close in
around it, a few flowering jacarandas stand over the forest, and wooded
hills rise beyond under thin haze. Light renders under
`qwantani_mid_morning_puresky`; dark under `kloppenheim_06_puresky` with the
lanterns, windows and fireflies lit. Every source is Poly Haven CC0, pinned
in `env/polyhaven.lock.json`; the glade's grass is the Guild's generated
`meadow` texture.
