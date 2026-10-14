# Goblinville Yard art sources

The Goblinville yard is a steam-powered goblin town on stilts over a misty
bog. Its live models (the builders, familiars, shell helpers and provider
halls) are textured 3D models made from painted images with
[TRELLIS.2](https://github.com/microsoft/TRELLIS.2) (MIT), running in the
local image studio's ComfyUI. The surroundings are pre-rendered plates, built
like the Guild's (see `concept-art/guild-yard/ART.md`).

## Pipeline

The steps are the shared Yard model pipeline in `concept-art/yard-models/`,
run with the world name; this folder holds Goblinville's `world.json` (cast,
town buildings, seeds and hall turns), `concepts.json` and `edits.json`.

| Step | Command | Writes |
| --- | --- | --- |
| Concepts | `python concepts.py goblinville [name ...] [--seeds N]` | `raw/<name>-<seed>.png` with `hidream-o1`, from `concepts.json`; copy picks to `concepts/<name>.png` |
| Edits | `python edits.py goblinville [name ...]` | `raw/edit/<name>-<step>.png` with `qwen-edit`, from `edits.json`; the results replace `concepts/<name>.png` |
| Models | `python build.py goblinville models [name ...]` | `.cache/goblinville-yard/models/<name>.glb` with TRELLIS.2 (`trellis.py`) |
| Cast | `python build.py goblinville cast [name ...]` | `web/yard/assets/goblin_*.glb`: rigged and animated (`rig.py`) |
| Halls | `python build.py goblinville halls` | `web/yard/assets/goblinville.glb` (`halls.py`) |
| Plates | `blender -b --factory-startup --python concept-art/guild-yard/env/plates.py -- goblinville` | `web/yard/assets/goblinville/` |
| Sky | `blender -b --factory-startup --python concept-art/guild-yard/env/surfaces.py -- goblinville` | `web/yard/assets/goblinville/surfaces.json` and skies |

`raw/` and the TRELLIS.2 models are not committed; the concept picks, plates
and runtime models are. Then run `npm run optimize:yard`, which also moves
each model's textures to `web/yard/assets/maps/` (the manager's content
security policy does not allow images embedded in a GLB), and the Yard tests.

## Sources

- **Builders** are the Goblinville skin's portraits,
  `concept-art/goblinville-skin/characters/<provider>/idle.png`, cut out with
  their `idle-mask.png`. TRELLIS.2 reconstructs glossy black armour and fur as
  broken geometry, so the OpenAI and xAI builders use copies restaged with
  `qwen-edit` on a light background in a relaxed stance, and the OpenAI
  builder's armour made matte with a short wool mantle in place of fur:
  `concepts/builder_openai.png` and `concepts/builder_xai.png`.
  The builders who work with their hands (OpenAI, xAI, shell and Docker) are
  restaged again in an A-pose, arms clear of the body
  (`builder_<provider>_apose` in `edits.json`): a hand that hangs against a
  coat or cloak reconstructs fused to it and drags it along. The shell
  builder's cloak becomes a short cape for it, and the Docker builder's
  toolbox is left out; his mechanical claw arm stays as modelled (`busy`).
  The OpenAI builder's hammer stands on its head beside his boot, touching
  it, so `world.json` names its loose head part and boxes in the rest as his
  `prop`: `rig.py` stands it beside his left boot with the handle through his
  fist and gives it to the PropLeft socket. He works with `pound`: the hammer
  swung up over the shoulder, the wrist carrying it past the arm, and down in
  front with the knees taking the blow, twice a loop, and he walks with it on
  his shoulder.
- **Familiars** are the skin's `familiars/flame.png`, `night.png` and
  `aether.png`. The leaf familiar's toad reconstructed as broken geometry in
  every variant tried, so it is a moss-shelled clockwork tortoise generated
  from `concepts.json` (`familiar_leaf`).
- **Halls, town buildings and shell helpers** are generated from
  `concepts.json`: each entry is a prompt, its seed and a shared style. Smoke
  and steam reconstruct as stray fragments, so the picked halls and buildings
  had them removed with `qwen-edit`. The picks are in `concepts/`.

## Models

`trellis.py` runs ComfyUI's TRELLIS.2 graph: structure, shape and a 1024 voxel
upsample (512 with no upsample for familiars and helpers), then texture, with
the reference pipeline's CFG schedule. The mesh is remeshed (512, or 384 for
small subjects; finer remeshes exhaust a 16 GB card), decimated, unwrapped and
baked: base colour, metallic and roughness from the texture voxels, normal and
ambient occlusion from the full-detail remesh. Models are `trellis_2_int8_convrot`
(MIT), its shape and texture VAEs, and DINOv3 ViT-L conditioning (DINOv3
License), from [Comfy-Org/TRELLIS.2](https://huggingface.co/Comfy-Org/TRELLIS.2).
Background removal is BiRefNet (MIT) where no mask is given. The seed is 42
unless `seeds` in `world.json` names another. Each job frees the GPU first and is
cancelled after ten minutes.

`rig.py` stands each model on the ground facing the camera and scales it to
its height in `world.json`, keeping the triangles and textures TRELLIS.2 made
(50,000 and 2048 px for builders, 30,000 and 1024 px for familiars and
helpers). It fits the contract skeleton
([docs/yard/CONTRACT.md](../../docs/yard/CONTRACT.md)) from the silhouette:
the trunk, and for builders arms and legs. Weights are bone heat on a voxel
proxy, transferred to the model, then cleaned up so cloth parts in a stride
and a raised arm does not tear the coat. The contract clips are posed in
Python and baked, legs by IK; builders work by tinkering, conducting or
pounding, or, when their hands hold a staff or sit in pockets, by a steady
lean and nod. The [Yard guide](../../docs/yard/README.md#rigging-and-clips)
covers rebuilding them.

`halls.py` stands each hall on the deck within a 5.2 m footprint and 5.5 m
height, at the anchors `concept-art/guild-yard/build.py` uses for every world, decimated to 35,000
triangles with 2048 px colour and 1024 px other maps. TRELLIS.2 squares each
model to its axes with the concept's front facing the camera, so the Yard sees
the front and right side, as the concepts show them; `turn` in `world.json`
turns a hall whose best side is elsewhere. Warm and glowing texels become an emissive map, which
the renderer brightens at dusk.

## Plates

`concept-art/guild-yard/env/goblinville_env.py` builds a plank deck on stilts
under the live area, with a brass cog inlaid at its centre, over bog water with
mud flats, marsh grass, reeds and dead trees, and forested hills beyond.
Boardwalks lead out to the town's TRELLIS.2 buildings, with lanterns, barrels
and crates along them, and lanterns stand on the deck's back and left edges.
Low mist lies over the water, clearing over the deck, and steam rises from
chimneys. Light renders under
`kloofendal_28d_misty_puresky`; dark under `industrial_sunset_puresky` with the
lanterns and windows lit. Other sources are Poly Haven CC0, pinned in
`env/polyhaven.lock.json`.
