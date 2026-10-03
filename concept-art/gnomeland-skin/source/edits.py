# Generates the Gnomeland gnomes with the local image studio: each idle gnome from
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
LOCKED = ("Turn this exact same gnome into an old weathered ceramic garden gnome statue of itself: glazed painted clay with faded, "
          "desaturated chipped paint, hairline cracks, dusty and covered in thin cobwebs, every glow switched off, its eyes closed and asleep, "
          "a heavy iron chain wrapped around it fastened with one large rusty iron padlock on its chest. Same pose and silhouette, dormant." + KEEP)
WORKING = {
    "anthropic": "Keep the exact same old master builder gnome, beard, hat, coat and apron. Change his pose: he is now actively at work, swinging his rune-etched mason's hammer down onto a chisel set against a small cut stone block before him, a burst of bright golden sparks, glowing amber runes flaring up from the stone and swirling around him, his eyes glowing bright amber, beard and coat stirring.",
    "openai": "Keep the exact same gnome forge-engineer, beard, armor, helm and hammer. Change his pose: he now swings the huge forge hammer down onto a small glowing anvil in a dynamic stance while staying the same size, standing tall and filling the frame from the helm tip to the boots, the hammerhead blazing with emerald-green energy, a fountain of bright green sparks, every armor seam and his eyes blazing bright green, cape flaring.",
    "google": "Keep the exact same gnome levitation engineer, beard, spectacles, hat, coat and gauge-staff, at the exact same large size, standing on the ground and filling the frame from the hat tip to the boots. Change his pose: he raises the gauge-staff high, its star crystal blazing brilliant blue-white, lifting several cut stone blocks and brass cogs into the air around him in swirling streams of blue antigravity light, glowing blue measuring lines and orbiting star sparks around them, coat stirring.",
    "xai": "Keep the exact same gnome tinkerer, face, hat, goggles and coat. Change his pose: he thrusts one hand forward, crackling electric-cyan lightning arcing from his fingers into a coil of copper wire and a small floating brass junction box, coat flaring, the cyan circuit patterns and his eyes blazing bright.",
    "shell": "Keep the exact same faceless hooded violet gnome ghost with the tall pointed hood and the glowing '>' chevron in its hood. Change it: it now swirls into a powerful vortex of violet energy, streams of glowing violet terminal glyphs and small ghostly tools spiraling around it, the chevron blazing bright.",
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
