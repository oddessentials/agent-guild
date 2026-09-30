import argparse, shutil, subprocess, sys, tempfile
from pathlib import Path
import numpy as np
from PIL import Image

PACK = Path(__file__).resolve().parent.parent
WEB = PACK.parent.parent / "web" / "art"
GEN = Path("E:/projects/local-image-studio/scripts/gen.py")
PROVIDERS = ["anthropic", "google", "openai", "shell", "xai"]
STATES = ["idle", "working", "locked"]
PROPS = {
    "ui/guild-crest.png": 96,
    "ui/level-medallion.png": 128,
    "ui/gem-mana.png": 48,
    "ui/gem-vitality.png": 48,
    "ui/padlock.png": 120,
    "familiars/aether.png": 112,
    "familiars/flame.png": 112,
    "familiars/leaf.png": 112,
    "familiars/night.png": 112,
}


def quantize(im, out):
    out.parent.mkdir(parents=True, exist_ok=True)
    im.quantize(256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.FLOYDSTEINBERG).save(out, optimize=True)


def remask(src, mask):
    with tempfile.TemporaryDirectory() as tmp:
        r = subprocess.run([sys.executable, str(GEN), "--workflow", "remove-bg", "--input", str(src), "--out", tmp],
                           capture_output=True, text=True, check=True)
        cut = next(line for line in r.stdout.splitlines() if line.endswith(".png"))
        Image.open(cut).getchannel("A").save(mask, optimize=True)


def cutout(src, mask):
    rgb = np.asarray(Image.open(src).convert("RGB"), dtype=np.float32) / 255
    m = np.asarray(Image.open(mask).convert("L"), dtype=np.float32) / 255
    a = np.maximum(m, np.clip(rgb.max(axis=2) * 1.6, 0, 1))
    rgb = np.clip(rgb / np.maximum(a[..., None], 1e-3), 0, 1)
    return Image.fromarray((np.dstack([rgb, a]) * 255 + 0.5).astype(np.uint8), "RGBA")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--masks", action="store_true", help="recompute the BiRefNet masks with the local image studio")
    args = ap.parse_args()

    for pid in PROVIDERS:
        for st in STATES:
            src = PACK / "characters" / pid / f"{st}.png"
            mask = PACK / "characters" / pid / f"{st}-mask.png"
            if args.masks:
                remask(src, mask)
            quantize(cutout(src, mask), WEB / "characters" / pid / f"{st}.png")
        (WEB / "icons").mkdir(parents=True, exist_ok=True)
        Image.open(PACK / "icons" / f"{pid}.png").convert("RGB").save(WEB / "icons" / f"{pid}.png", optimize=True)

    for rel, height in PROPS.items():
        im = Image.open(PACK / rel).convert("RGBA")
        quantize(im.resize((round(im.width * height / im.height), height), Image.LANCZOS), WEB / rel)

    Image.open(PACK / "backgrounds" / "page.png").convert("RGB").save(WEB / "page.png", optimize=True)

    if shutil.which("oxipng"):
        subprocess.run(["oxipng", "-o", "4", "--strip", "safe", "-q", "-r", str(WEB)], check=True)


if __name__ == "__main__":
    main()
