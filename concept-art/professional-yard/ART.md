# Professional Yard art sources

The Professional yard is an office campus of glass and concrete round a paved
plaza. Its halls and plates are authored in `concept-art/guild-yard/` (see
that folder's `ART.md`). Its live cast (five campus staff and four office
robots) are textured 3D models made from generated images with
[TRELLIS.2](https://github.com/microsoft/TRELLIS.2) (MIT), running in the
local image studio's ComfyUI. The robots stand in for both agents and shell
commands, as Orbital's drones do.

## Pipeline

The steps are the shared Yard model pipeline in `concept-art/yard-models/`,
run with the world name, as for Goblinville (see
`concept-art/goblinville-yard/ART.md` for how each step works). This folder
holds the cast in `world.json`, the prompts in `concepts.json`, the edits in
`edits.json` and the picks in `concepts/`.

| Step | Command | Writes |
| --- | --- | --- |
| Concepts | `python concepts.py professional [name ...] [--seeds N]` | `raw/<name>-<seed>.png` with `hidream-o1`, from `concepts.json`; copy picks to `concepts/<name>.png` |
| Edits | `python edits.py professional [name ...]` | `raw/edit/<name>-<step>.png` with `qwen-edit`, from `edits.json`; the results replace `concepts/<name>.png` |
| Models | `python build.py professional models [name ...]` | `.cache/professional-yard/models/<name>.glb` with TRELLIS.2 |
| Cast | `python build.py professional cast [name ...]` | `web/yard/assets/staff_*.glb` and `bot_*.glb`, rigged and animated |

`raw/` and the TRELLIS.2 models are not committed; the concept picks and
runtime models are. Then run `npm run optimize:yard` and the Yard tests.

## Sources

The Professional card skin is generated SVG with no portraits, so the cast
starts from prompts rather than restaged portraits. Three seeds were made
for each subject and one picked.

- **Staff** (`staff_0`–`staff_4`, one per tool in provider order) are
  stylised figurines in business casual, each carrying one bold identity
  colour from the skin's palette: a lead architect in a burnt-orange blazer
  with a tablet (Anthropic), an engineer in an emerald quilted vest with a
  laptop (OpenAI), an analyst in a cobalt cardigan with a folder (Google), a
  site engineer in a cyan bomber jacket with a headset (xAI) and a
  facilities technician in an amethyst polo with a tool belt (Shell). The
  prompts ask for a relaxed A-pose so `rig.py` finds the arms in the
  silhouette, for matte fabrics, and for mid-tone trousers rather than
  black, which bakes as an unreadable silhouette. Identity is carried by big
  colour blocks: badges and emblems do not survive the bake.
- **Office robots** (`bot_0`–`bot_3`) are a wheeled courier with an orange
  band, a one-piece concierge with green trim, a round floor sweeper with a
  blue top and a two-wheeled butler with a purple chest carrying a tray. Each
  pick had its glossy dark face screen made a matte charcoal panel with
  `qwen-edit`, since gloss bakes as chrome, and the sweeper's bristles were
  removed, since brush fibres reconstruct as shattered geometry.
- **Backgrounds**: `hidream-o1` ignores "flat light grey" and paints a
  mottled, blocky grey. Three subjects whose light tones sat close to it
  (the courier, the technician and the first green robot) shattered, and
  restaging them on a flat medium grey with `qwen-edit` (`edits.json`) fixed
  the first two, with seed 123 (`seeds` in `world.json`) where seed 42 still
  lost the face. The green robot was first a telepresence head on a column;
  it shattered at four seeds and in two candidates, so it was replaced by the
  chunky one-piece concierge (`bot_concierge` in `concepts.json`), which
  reconstructed first time.
