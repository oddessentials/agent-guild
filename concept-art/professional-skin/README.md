# Professional skin art

Sources for `web/skins/professional/`: a glass object for each tool, rendered with Blender, and the page backgrounds, generated with the local image studio (`E:/projects/local-image-studio`, ComfyUI on port 8188). The rest of the skin is SVG written by the build script.

| Tool | Object |
| --- | --- |
| Anthropic | Three slabs fanned like pages |
| OpenAI | A ring |
| Google | Four spheres |
| xAI | A twisted prism |
| Shell | A cube balanced on one corner |
| Docker | Stacked containers |

Idle is clear glass in the tool's colour, working is lit from within with a brighter rim, and locked is frosted grey. Each is rendered for the light and the dark theme, since the glass reflects its surroundings.

| Step | Command | Writes |
| --- | --- | --- |
| Objects | `blender -b -P source/scene.py -- [tool[:theme[:state]] ...]` | `objects/<tool>/<theme>-<state>.png`: every tool, theme and state from one scene, over transparency with the object's shadow |
| Backgrounds | `python source/props.py [name ...]` | `raw/<name>/` from `props.json` (`qwen-image`), then upscaled 2x with SeedVR2 into `raw/<name>-up/` |
| Web art | `python source/build.py` | `web/skins/professional/`: the cut-out objects, backgrounds, icons, lock and empty state |

`raw/` is not committed. Copy the background picks (the `-up` versions) into `backgrounds/` before building.
