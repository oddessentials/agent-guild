# Gnomeland skin art

Sources for `web/skins/gnomeland/`: a village of gnome builders, one per provider, their clockwork helpers and the village itself. Everything is generated with the local image studio (`E:/projects/local-image-studio`, ComfyUI on port 8188).

| Step | Command | Writes |
| --- | --- | --- |
| Gnomes | `python source/edits.py [provider[:state] ...]` | `raw/<provider>-<state>/`: the idle gnome from `characters.json` (`qwen-image`), then its working and locked states edited from it (`qwen-edit`), so all three are the same figure in the same framing |
| Props | `python source/props.py [name ...]` | `raw/<name>/`: helper familiars, the empty-state gnome and the page backgrounds from `props.json`; the backgrounds are then upscaled 2x with SeedVR2 into `raw/<name>-up/` |
| Web art | `python source/build.py [--masks]` | `web/skins/gnomeland/`: cut-outs, icons, familiars, backgrounds and the SVG badges and frame |

`raw/` is not committed. Copy the picks into `characters/<provider>/<state>.png`, `familiars/`, `ui/` and `backgrounds/` (the `-up` versions) before building; `--masks` recomputes the `*-mask.png` cut-out masks with BiRefNet.

The display font is Almendra Bold (SIL Open Font License, `web/skins/gnomeland/fonts/OFL.txt`).
