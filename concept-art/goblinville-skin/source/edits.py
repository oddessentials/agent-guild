# Generates the Goblinville cast with the local image studio: each idle figure from
# characters.json (qwen-image), then its working and locked states edited from it
# (qwen-edit) so all three are the same figure in the same framing.
#   python source/edits.py [provider[:state] ...]
import glob, json, shutil, subprocess, sys
from pathlib import Path

G = "E:/projects/local-image-studio/scripts/gen.py"
HERE = Path(__file__).resolve().parent
RAW = HERE.parent / "raw"
C = json.loads((HERE / "characters.json").read_text())
KEEP = " Keep the exact same art style, painterly rendering, camera framing, scale and the pure flat black background."
LOCKED = ("Turn this exact same character into an old weathered cast-bronze statue of itself, a cold monument standing in a disused works: "
          "dull bronze with streaks of green verdigris patina, soot, dust and thin cobwebs, every glow and every light switched off, its eyes closed and asleep, "
          "a heavy iron chain wrapped around it fastened with one large rusty iron padlock on its chest. Keep every feature, tool and piece of gear it carries, "
          "cast in the same bronze. Same pose and silhouette, dormant." + KEEP)
WORKING = {
    "anthropic": "Keep the exact same massive old ogre master builder, face, tusks, beard, spectacles, hard hat, coat, apron and brass gauntlet. Change his pose: he is now actively at work, driving a glowing hot rivet into a riveted iron girder before him with a heavy rivet hammer, a burst of bright golden sparks, the amber runes on his gauntlet blazing and glowing amber rune glyphs swirling around him in the steam, beard and coat stirring.",
    "openai": "Keep the exact same orc boilermaker, face, tusks, beard, armor, gauges, goggles and steam hammer. Change his pose: he now swings the huge steam-powered forge hammer down onto a small glowing anvil in a dynamic stance while staying the same size, standing tall and filling the frame from the topknot to the boots, jets of white steam bursting from its copper pipes, the hammerhead blazing with emerald-green energy, a fountain of bright green sparks, every armor seam, gauge and his eyes blazing bright green, cape flaring.",
    "google": "Keep the exact same towering troll lift-engineer, face, beard, coat, levitation engine and control rod, at the exact same large size, standing upright on the ground and filling the frame from the head to the feet, not crouching. Change his pose: he raises the control rod high, its star crystal blazing brilliant blue-white and the engine on his back glowing and humming, lifting several cut stone blocks, iron girders and brass gears into the air around him in swirling streams of blue antigravity light, glowing blue rings around them, coat stirring.",
    "xai": "Keep the exact same goblin electrician, face, ears, goggles, coat and coil gauntlet. Change his pose: he thrusts the gauntlet forward, crackling electric-cyan lightning arcing from it into a tall copper tesla coil and a small floating brass junction box, its vacuum tubes glowing, coat flaring, the cyan circuit patterns and his eyes blazing bright.",
    "shell": "Keep the exact same faceless hooded violet goblin automaton with the two long pointed ears on its hood and the glowing '>' chevron in its hood. Keep it at the exact same large size, standing upright and filling the frame from the hood tips to the boots. Change it: it now raises its lantern high as a powerful vortex of violet steam swirls around it, streams of glowing violet terminal glyphs and small spinning brass gears spiraling through the steam, the chevron and the lantern blazing bright.",
}

only = [a.split(":") for a in sys.argv[1:]]
for pid, spec in C.items():
    if pid.startswith("_") or (only and pid not in [o[0] for o in only]):
        continue
    states = {o[1] for o in only if o[0] == pid and len(o) > 1} or {"idle", "working", "locked"}
    idle_dir = RAW / f"{pid}-idle"
    if "idle" in states or not glob.glob(str(idle_dir / "*.png")):
        shutil.rmtree(idle_dir, ignore_errors=True)
        subprocess.run([sys.executable, G, spec["prompt"] + " " + C["_style"], "--workflow", "qwen-image", "--seed", str(spec["seed"]),
                        "--width", str(spec["w"]), "--height", str(spec["h"]), "--out", str(idle_dir)], check=True, capture_output=True)
    idle = glob.glob(str(idle_dir / "*.png"))[0]
    for state, prompt in (("working", WORKING[pid] + KEEP), ("locked", spec.get("locked", LOCKED))):
        if state not in states:
            continue
        out = RAW / f"{pid}-{state}"
        shutil.rmtree(out, ignore_errors=True)
        r = subprocess.run([sys.executable, G, prompt, "--workflow", "qwen-edit", "--input", idle, "--seed", str(spec.get("edit_seeds", {}).get(state, 7)), "--out", str(out)],
                           capture_output=True, text=True)
        print(pid, state, (r.stdout.strip().splitlines() or [r.stderr[-300:]])[-1], flush=True)
