# Goblinville skin art

Sources for `web/skins/goblinville/`: a steam-powered town of goblin builders on stilts over a bog, one goblin-kin engineer per provider, their familiars and the town itself. Everything is generated with the local image studio (`E:/projects/local-image-studio`, ComfyUI on port 8188).

| Step | Command | Writes |
| --- | --- | --- |
| Builders | `python source/edits.py [provider[:state] ...]` | `raw/<provider>-<state>/`: the idle builder from `characters.json` (`qwen-image`), then its working and locked states edited from it (`qwen-edit`), so all three are the same figure in the same framing |
| Props | `python source/props.py [name ...]` | `raw/<name>/`: familiars, the empty-state goblin and the page backgrounds from `props.json`; the backgrounds are then upscaled 2x with SeedVR2 into `raw/<name>-up/` |
| Web art | `python source/build.py [--masks]` | `web/skins/goblinville/`: cut-outs, icons, familiars, backgrounds and the SVG badges, frame and gauge |

`raw/` is not committed. Copy the picks into `characters/<provider>/<state>.png`, `familiars/`, `ui/` and `backgrounds/` (the `-up` versions) before building; `--masks` recomputes the `*-mask.png` cut-out masks with BiRefNet.

The display font is Germania One (SIL Open Font License, `web/skins/goblinville/fonts/OFL.txt`). It has a Reserved Font Name, so it ships unmodified, only rewrapped as WOFF2.
