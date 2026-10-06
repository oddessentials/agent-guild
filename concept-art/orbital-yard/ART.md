# Orbital Yard art sources

The Orbital yard is a station deck in orbit, with trusses out to solar wings,
a docking hub and habitat modules, over a planet and a starfield. Its live
models (five robots, four drones and five station modules) are textured 3D
models made from painted images with
[TRELLIS.2](https://github.com/microsoft/TRELLIS.2) (MIT), running in the
local image studio's ComfyUI. The drones are also the shell helpers in the
Guild and Grove yards. The surroundings are pre-rendered plates, built like
the Guild's (see `concept-art/guild-yard/ART.md`).

## Pipeline

The steps are the shared Yard model pipeline in `concept-art/yard-models/`,
run with the world name, as for Goblinville (see
`concept-art/goblinville-yard/ART.md` for how each step works). This folder
holds Orbital's `world.json` (cast, station props and the subjects cut out
onto grey), `concepts.json` and `edits.json`.

| Step | Command | Writes |
| --- | --- | --- |
| Concepts | `python concepts.py orbital [name ...] [--seeds N]` | `raw/<name>-<seed>.png` with `hidream-o1`, from `concepts.json`; copy picks to `concepts/<name>.png` |
| Edits | `python edits.py orbital [name ...]` | `raw/edit/<name>-<step>.png` with `qwen-edit`, from `edits.json`; the results replace `concepts/<name>.png` |
| Models | `python build.py orbital models [name ...]` | `.cache/orbital-yard/models/<name>.glb` with TRELLIS.2 (`trellis.py`) |
| Cast | `python build.py orbital cast [name ...]` | `web/yard/assets/robot_*.glb` and `drone_*.glb`: rigged and animated (`rig.py`) |
| Halls | `python build.py orbital halls` | `web/yard/assets/orbital.glb` (`halls.py`) |
| Plates | `blender -b --factory-startup --python concept-art/guild-yard/env/plates.py -- orbital` | `web/yard/assets/orbital/` |
| Sky | `blender -b --factory-startup --python concept-art/guild-yard/env/surfaces.py -- orbital` | `web/yard/assets/orbital/surfaces.json` and skies |

`raw/` and the TRELLIS.2 models are not committed; the concept picks, plates
and runtime models are. Then run `npm run optimize:yard`, which moves each
model's textures to `web/yard/assets/maps/`, and the Yard tests.

## Sources

- **Robots** are the Orbital skin's portraits,
  `concept-art/orbital-skin/characters/<provider>/idle.png`, restaged with
  `qwen-edit` (`edits.json`) full length on a light grey background with every
  surface matte, since glossy enamel bakes as chrome. The Anthropic robot's
  floating runes are left out and its glass face is a matte faceplate; the
  OpenAI knight's black plate is matte gunmetal with bold emerald bands and an
  emerald cloak hem; the Google twins stay two figures holding hands, as one
  model, in matte porcelain, with the star between them left out; the xAI
  robot's coat and helmet are matte slate grey with bold cyan traces, after a
  first restage in charcoal reconstructed as a near-black silhouette; and the
  translucent shell robot with violet wisps is an opaque lavender robot in a
  violet hood with a lilac trim and a bold chevron on its faceplate, standing
  on solid legs. TRELLIS.2 shifts purples: the first restage's deep violet
  hood baked navy, a royal violet one teal-blue and a magenta one crimson, so
  a second edit makes the hood, boots and chest panels an amethyst purple
  halfway between blue and magenta, which holds. One seed of that edit turned
  the chevron into a V, so the prompt keeps it pointing right.
- **Drones** are the skin's `familiars/`, restaged matte: the flame drone's
  thruster flames removed and its rotors stilled; the leaf drone's sparkles
  removed; the translucent night drone made opaque violet enamel without its
  stars and signal arcs; and the glass-domed aether drone made opaque sky-blue
  enamel with a still rotor. The first restage of the leaf, night and aether
  drones lost their painted eyes, so a second edit paints each a bold iris.
- **Rigging**: the Anthropic, OpenAI and Google robots wear robes or cloaks
  and the xAI robot keeps its hands in its pockets, so they work with
  `steady` (a lean and nod with the hands still); the shell robot tinkers.
- **Station modules and props** are generated from `concepts.json`: each
  entry is a prompt, its seed, a shared style and the picked seed as `pick`,
  chosen by contact sheet. Each module carries its provider's colour in bold
  shapes: a hood-roofed observatory, an armoured hangar with a shield door,
  twin towers on a bridge, a charcoal relay with cyan traces and a
  hooded dome with a chevron door. The shuttle, dish and crane stand on pads
  beside the deck in the plates; a cargo stack hung TRELLIS.2 past its
  ten-minute limit twice, so the plates' cargo containers are modelled.

## Plates

`concept-art/guild-yard/env/orbital_env.py` builds a level plated deck under
the live area: a landing zone edged by a lit strip with flush pads under the
halls and an iris hatch at its centre, a darker surround with floor lights,
consoles, vents and light masts on its far edges, and a sloped hull beneath.
Trusses lead from it to three solar wings on the left and a docking hub with
modules, a docking ring and radiators on the right; habitat modules on a
truss lie behind and below the deck, and a few small craft drift beneath it.
The station is modelled in the script, its plating drawn by a shader (panel
grid, seams and shading) over Poly Haven CC0 `blue_metal_plate`, `metal_plate`
and `painted_metal_shutter` detail, pinned in `env/polyhaven.lock.json`.

The planet is a sphere flattened along the view axis, which an orthographic
view cannot see, so it fits the cameras' clip range; it is shaded from its
true normals: the generated surface, procedural clouds and relief, a soft
terminator toward the theme's sun, limb haze, a thin atmosphere rim and, at
dusk, city lights on its night side. The stars are drawn by a shader over
the generated nebula. Light is a world shader (dark space above, the
planet's glow below) and the theme's sun: hard and white for light, low and
warm through the atmosphere for dark, with the station's windows, strips and
floodlights lit. `sky()` renders the world shader to the HDR the live
models light from, since no Poly Haven sky shows space.

### Generated textures

Generated locally with local-image-studio (`hidream-o1`) and picked by
contact sheet; both are in `concept-art/guild-yard/env/textures/`.

| File | Seed | Size | Use |
| --- | --- | --- | --- |
| `nebula.jpg` | 1201 | 2048 × 1024 | Nebula behind the shader stars, its own stars removed with a median filter, as they magnified into blobs |
| `planet.jpg` | 1213 | 1024 × 1024 | Planet surface, made to wrap by `tileable()` |

Nebula brief: Wide panoramic deep space astrophotography backdrop: a soft
colourful nebula of deep teal, indigo and dusky magenta gas clouds drifting
across the left and right thirds of the frame, fine dark dust lanes, a dense
field of tiny pinpoint stars of varied brightness, a few slightly brighter
blue-white stars, the centre calmer and darker, no planets, no moons, no
spacecraft, no lens flare, no text, no border, high resolution, crisp detail.

Planet brief (a first brief asking for an orbital photograph drew whole
globes, so it asks for a flat tile of a fictional world): A flat square
satellite image tile filling the entire frame edge to edge: looking straight
down from orbit at a fictional alien ocean world, deep sapphire ocean with
bright turquoise shallow reefs, a few sandy ochre and sage-green islands and
coastlines with winding rivers, thin streaks of white cloud, nadir view, flat
map projection, the whole image is surface with no planet edge, no globe, no
sphere, no horizon, no black space, no stars, no text, no border,
photographic detail.
