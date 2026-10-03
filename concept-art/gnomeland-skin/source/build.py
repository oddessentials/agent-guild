# Builds the Gnomeland skin's art into web/skins/orbital/ from the chosen sources in this pack.
#   python source/build.py [--masks]
# --masks recomputes the BiRefNet cut-out masks with the local image studio (ComfyUI must be running).
import argparse, shutil, subprocess, sys, tempfile
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

PACK = Path(__file__).resolve().parent.parent
WEB = PACK.parent.parent / "web" / "skins" / "gnomeland"
GEN = Path("E:/projects/local-image-studio/scripts/gen.py")
PROVIDERS = {"anthropic": "#dd7a3e", "openai": "#36b86f", "google": "#4d84e6", "xai": "#2cc3d3", "shell": "#9a6cf0"}
STATES = ["idle", "working", "locked"]
CHARACTER_WIDTH = 640
# The square around each provider's head in its idle art (1056×1408), for the provider icon.
HEADS = {"anthropic": (265, 260, 500), "openai": (250, 270, 500), "google": (250, 300, 500), "xai": (250, 240, 500), "shell": (225, 250, 500)}
FAMILIAR_SIZE = 112


def encode(im, out, avif, webp=82):
    out.parent.mkdir(parents=True, exist_ok=True)
    im.save(out.with_suffix(".avif"), quality=avif, subsampling="4:4:4", speed=2)
    im.save(out.with_suffix(".webp"), quality=webp, method=6)


def quantize(im, out):
    out.parent.mkdir(parents=True, exist_ok=True)
    im.quantize(256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.FLOYDSTEINBERG).save(out, optimize=True)


def shrink(im, width):
    return im.convert("RGBa").resize((width, round(im.height * width / im.width)), Image.LANCZOS).convert("RGBA")


def remask(src, mask):
    with tempfile.TemporaryDirectory() as tmp:
        r = subprocess.run([sys.executable, str(GEN), "--workflow", "remove-bg", "--input", str(src), "--out", tmp],
                           capture_output=True, text=True, check=True)
        cut = next(line for line in r.stdout.splitlines() if line.endswith(".png"))
        Image.open(cut).getchannel("A").save(mask, optimize=True)


def backdrop(rgb, m, cell=40):
    """The dark studio backdrop behind the subject, smoothed and filled in where the subject hides it."""
    small = (rgb.shape[1] // cell, rgb.shape[0] // cell)
    keep = (m < 0.02).astype(np.float32)
    blur = lambda a: np.asarray(Image.fromarray(a).resize(small, Image.BOX).resize((rgb.shape[1], rgb.shape[0]), Image.BILINEAR), dtype=np.float32)
    weight = blur(keep)
    plate = np.dstack([blur(rgb[..., c] * keep) for c in range(3)]) / np.maximum(weight[..., None], 1e-4)
    # The backdrop is the dim part of the plate; glows near the subject must not count as backdrop.
    return np.minimum(plate, np.percentile(rgb.max(axis=2)[keep > 0], 90))


def filled(shape, gap=15):
    """The shape with its gaps closed and every hole inside it filled."""
    im = Image.fromarray((shape * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(gap))
    pad = Image.new("L", (im.width + 2, im.height + 2))
    pad.paste(im, (1, 1))
    ImageDraw.floodfill(pad, (0, 0), 128)
    inside = np.asarray(pad, dtype=np.uint8)[1:-1, 1:-1] != 128
    out = Image.fromarray((inside * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(gap))
    return np.asarray(out.filter(ImageFilter.GaussianBlur(1)), dtype=np.float32) / 255


def cutout(src, mask, solid_below=None):
    """The subject over transparency. Glows outside the mask stay, with the dark backdrop subtracted and un-premultiplied away.
    `solid_below` (a fraction of the height) also keeps whatever stands out of the backdrop below that line opaque, for a dark
    part the mask misses; it is judged on a brightened copy, where shadowed surfaces still clear the backdrop."""
    rgb = np.asarray(Image.open(src).convert("RGB"), dtype=np.float32) / 255
    m = np.asarray(Image.open(mask).convert("L"), dtype=np.float32) / 255
    glow = np.clip(rgb - backdrop(rgb, m), 0, 1)
    if solid_below is not None:
        lifted = rgb ** (1 / 2.4)
        part = np.clip((np.clip(lifted - backdrop(lifted, m), 0, 1).max(axis=2) - 0.06) * 10, 0, 1)
        part[: int(rgb.shape[0] * solid_below)] = 0
        body = filled(np.maximum(m, part) > 0.5) * (np.arange(rgb.shape[0])[:, None] >= rgb.shape[0] * solid_below)
        # Drop specks such as fireflies, keep the solid body and feather its ragged edge.
        body = Image.fromarray((body * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(21)).filter(ImageFilter.MaxFilter(21)).filter(ImageFilter.GaussianBlur(5))
        m = np.maximum(m, np.asarray(body, dtype=np.float32) / 255)
    g = np.clip((glow.max(axis=2) - 0.03) * 1.7, 0, 1)
    a = np.maximum(m, g)
    color = m[..., None] * rgb + (1 - m[..., None]) * glow
    color = np.clip(color / np.maximum(a[..., None], 1e-3), 0, 1)
    return Image.fromarray((np.dstack([color, a]) * 255 + 0.5).astype(np.uint8), "RGBA")


def source(rel, masks, solid_below=None):
    src, mask = PACK / f"{rel}.png", PACK / f"{rel}-mask.png"
    if masks or not mask.exists():
        remask(src, mask)
    return cutout(src, mask, solid_below)


def hex_rgb(color):
    return tuple(int(color[i:i + 2], 16) for i in (1, 3, 5))


def icon(art, box, color, size=128):
    """The provider's head on a dark timber tile lit in its colour, with a few drifting fireflies."""
    x, y, side = box
    head = art.crop((x, y, x + side, y + side)).resize((size, size), Image.LANCZOS)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) / size
    glow = np.clip(1 - np.hypot(xx - 0.5, yy - 0.42) / 0.75, 0, 1) ** 1.5
    base = np.array([22, 15, 10], dtype=np.float32)
    rgb = base + (np.array(hex_rgb(color), dtype=np.float32) * 0.55 - base) * glow[..., None]
    tile = Image.fromarray(rgb.astype(np.uint8), "RGB").convert("RGBA")
    rng = np.random.default_rng(size)
    flies = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(flies)
    for fx, fy, r in zip(rng.integers(0, size, 9), rng.integers(0, size, 9), rng.uniform(0.6, 1.4, 9)):
        draw.ellipse((fx - r, fy - r, fx + r, fy + r), fill=(255, 214, 120, int(110 + 90 * r / 1.4)))
    tile.alpha_composite(flies.filter(ImageFilter.GaussianBlur(0.6)))
    tile.alpha_composite(head)
    return tile.convert("RGB")


def familiar(src):
    im = Image.open(src).convert("RGB")
    side = round(min(im.size) * 0.86)
    cx, cy = im.width // 2, im.height // 2
    im = im.crop((cx - side // 2, cy - side // 2, cx + side // 2, cy + side // 2))
    return im.resize((FAMILIAR_SIZE, FAMILIAR_SIZE), Image.LANCZOS)


def write(rel, svg):
    file = WEB / rel
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text("".join(line.strip() for line in svg.strip().splitlines()) + "\n", encoding="utf-8", newline="\n")


def gear(cx, cy, outer, inner, teeth):
    """An SVG path for a cog wheel with flat-topped teeth."""
    pts = []
    for i in range(teeth):
        a = 2 * np.pi * i / teeth
        for da, r in ((-0.36, inner), (-0.2, outer), (0.2, outer), (0.36, inner)):
            t = a + da * 2 * np.pi / teeth
            pts.append(f"{cx + r * np.sin(t):.2f} {cy - r * np.cos(t):.2f}")
    return "M" + "L".join(pts) + "Z"


# The level badge: a brass cog with a dark walnut hub; the level number sits on the hub.
LEVEL = f"""
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fbe3a2"/><stop offset="0.45" stop-color="#c9933e"/><stop offset="1" stop-color="#7a4f1c"/></linearGradient>
    <radialGradient id="w" cx="42%" cy="36%" r="70%"><stop offset="0" stop-color="#5a3a22"/><stop offset="0.75" stop-color="#2e1d11"/><stop offset="1" stop-color="#1c120a"/></radialGradient>
  </defs>
  <path d="{gear(32, 32, 30.5, 25, 12)}" fill="url(#b)" stroke="#5a3814" stroke-width="1" stroke-linejoin="round"/>
  <circle cx="32" cy="32" r="20" fill="url(#w)" stroke="#f6d48a" stroke-width="1.6"/>
  <circle cx="32" cy="32" r="17" fill="none" stroke="#e7b865" stroke-opacity="0.35" stroke-width="0.8" stroke-dasharray="1.4 2.6"/>
  <g fill="#f6d48a"><circle cx="32" cy="9.5" r="1.3"/><circle cx="54.5" cy="32" r="1.3"/><circle cx="32" cy="54.5" r="1.3"/><circle cx="9.5" cy="32" r="1.3"/></g>
</svg>"""

# The locked badge: an iron padlock hanging from a short chain on a round oak plaque bound in iron.
LOCK = """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
  <defs>
    <radialGradient id="o" cx="40%" cy="32%" r="75%"><stop offset="0" stop-color="#7a5232"/><stop offset="0.7" stop-color="#4a301b"/><stop offset="1" stop-color="#2c1b0e"/></radialGradient>
    <linearGradient id="i" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d9dde3"/><stop offset="1" stop-color="#7d848f"/></linearGradient>
  </defs>
  <circle cx="20" cy="20" r="18.5" fill="url(#o)"/>
  <path d="M5 15.5h30M4 23h32" stroke="#2c1b0e" stroke-opacity="0.45" stroke-width="0.8"/>
  <circle cx="20" cy="20" r="18" fill="none" stroke="#3a3f47" stroke-width="2.2"/>
  <circle cx="20" cy="20" r="18" fill="none" stroke="#9aa1ab" stroke-width="0.7"/>
  <g fill="#b9bfc8"><circle cx="20" cy="4.2" r="1"/><circle cx="35.8" cy="20" r="1"/><circle cx="20" cy="35.8" r="1"/><circle cx="4.2" cy="20" r="1"/></g>
  <path d="M15.4 19.5v-3.2a4.6 4.6 0 0 1 9.2 0v3.2" fill="none" stroke="url(#i)" stroke-width="2.3" stroke-linecap="round"/>
  <rect x="12.6" y="19" width="14.8" height="11.2" rx="2.4" fill="url(#i)" stroke="#4a5059" stroke-width="0.7"/>
  <circle cx="20" cy="23.6" r="1.7" fill="#2a2e35"/><rect x="19.25" y="24" width="1.5" height="3.3" rx="0.75" fill="#2a2e35"/>
</svg>"""

# The card and dialog frame, a 9-slice for border-image (it needs its own size, or the slices scale with the box): riveted brass corner brackets joined by a thin brass rule.
FRAME_CORNER = '<path d="M3 3h25v7H10v18H3z" fill="url(#b)" stroke="#5a3814" stroke-width="0.8" stroke-linejoin="round"/><g fill="#fff4cf" stroke="#6b4419" stroke-width="0.6"><circle cx="6.5" cy="6.5" r="1.6"/><circle cx="23" cy="6.5" r="1.3"/><circle cx="6.5" cy="23" r="1.3"/></g>'
FRAME = f"""
<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f7dc98"/><stop offset="0.5" stop-color="#c38c3a"/><stop offset="1" stop-color="#86561e"/></linearGradient></defs>
  <path d="M28 6.5h40M28 89.5h40M6.5 28v40M89.5 28v40" stroke="#c99a4a" stroke-opacity="0.85" stroke-width="1.2"/>
  {FRAME_CORNER}
  <g transform="matrix(-1 0 0 1 96 0)">{FRAME_CORNER}</g>
  <g transform="matrix(1 0 0 -1 0 96)">{FRAME_CORNER}</g>
  <g transform="matrix(-1 0 0 -1 96 96)">{FRAME_CORNER}</g>
</svg>"""

# The working effect: a large open brass cog that turns slowly behind a working gnome.
WHEEL = f"""
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe7a8"/><stop offset="0.5" stop-color="#d79e45"/><stop offset="1" stop-color="#8a5a1e"/></linearGradient></defs>
  <path d="{gear(100, 100, 97, 86, 24)}M100 22a78 78 0 1 0 0.01 0z" fill="url(#b)" fill-rule="evenodd"/>
  <circle cx="100" cy="100" r="60" fill="none" stroke="url(#b)" stroke-width="3" stroke-dasharray="4 7"/>
  <g stroke="url(#b)" stroke-width="5" stroke-linecap="round"><path d="M100 24v52M100 124v52M24 100h52M124 100h52"/></g>
  <circle cx="100" cy="100" r="22" fill="none" stroke="url(#b)" stroke-width="6"/>
</svg>"""

# Usage meter markers: a brass cog for the first window, a blue star crystal for the second.
COG = f"""
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fbe3a2"/><stop offset="0.5" stop-color="#c9933e"/><stop offset="1" stop-color="#7a4f1c"/></linearGradient></defs>
  <path d="{gear(8, 8, 7.6, 5.9, 8)}" fill="url(#b)" stroke="#5a3814" stroke-width="0.5" stroke-linejoin="round"/>
  <circle cx="8" cy="8" r="2.3" fill="#3a2414" stroke="#f6d48a" stroke-width="0.6"/>
</svg>"""
CRYSTAL = """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <defs><linearGradient id="f" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e2f1ff"/><stop offset="0.5" stop-color="#6aa8ff"/><stop offset="1" stop-color="#2f4fc8"/></linearGradient></defs>
  <path d="M8 0.6L9.7 6.3 15.4 8 9.7 9.7 8 15.4 6.3 9.7 0.6 8 6.3 6.3z" fill="url(#f)" stroke="#dbe9ff" stroke-width="0.6" stroke-linejoin="round"/>
  <path d="M8 3.2L8.7 7.3 8 8 7.3 7.3z" fill="#fff" fill-opacity="0.75"/>
</svg>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--masks", action="store_true", help="recompute the BiRefNet masks with the local image studio")
    args = ap.parse_args()

    for pid, color in PROVIDERS.items():
        for st in STATES:
            art = source(f"characters/{pid}/{st}", args.masks)
            encode(shrink(art, CHARACTER_WIDTH), WEB / "characters" / pid / st, avif=60)
            if st == "idle":
                encode(icon(art, HEADS[pid], color), WEB / "icons" / pid, avif=70)

    for name in ("flame", "leaf", "night", "aether"):
        quantize(familiar(PACK / "familiars" / f"{name}.png"), WEB / "familiars" / f"{name}.png")

    # The mask leaves out the stones and ground the gnome sits on, in the lower half.
    empty = source("ui/empty-state", args.masks, solid_below=0.55)
    encode(shrink(empty.crop(empty.getbbox()), 420), WEB / "ui" / "empty-state", avif=60)
    # The backgrounds are upscaled 2x (3840x2176) so ultrawide screens stay sharp.
    encode(Image.open(PACK / "backgrounds" / "page.png").convert("RGB"), WEB / "page", avif=62, webp=80)
    light = Image.open(PACK / "backgrounds" / "page-light.png").convert("RGB")
    encode(Image.blend(light, Image.new("RGB", light.size, (246, 240, 228)), 0.28), WEB / "page-light", avif=62, webp=80)

    write("ui/level.svg", LEVEL)
    write("ui/lock.svg", LOCK)
    write("ui/frame.svg", FRAME)
    write("ui/wheel.svg", WHEEL)
    write("ui/cog.svg", COG)
    write("ui/crystal.svg", CRYSTAL)

    if shutil.which("oxipng"):
        subprocess.run(["oxipng", "-o", "4", "--strip", "safe", "-q", "-r", str(WEB / "familiars")], check=True)


if __name__ == "__main__":
    main()
