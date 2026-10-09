# Builds the Goblinville skin's art into web/skins/goblinville/ from the chosen sources in this pack.
#   python source/build.py [--masks]
# --masks recomputes the BiRefNet cut-out masks with the local image studio (ComfyUI must be running).
import argparse, shutil, subprocess, sys, tempfile
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

PACK = Path(__file__).resolve().parent.parent
WEB = PACK.parent.parent / "web" / "skins" / "goblinville"
GEN = Path("E:/projects/local-image-studio/scripts/gen.py")
PROVIDERS = {"anthropic": "#dd7a3e", "openai": "#36b86f", "google": "#4d84e6", "xai": "#2cc3d3", "shell": "#9a6cf0", "docker": "#2496ed"}
STATES = ["idle", "working", "locked"]
CHARACTER_WIDTH = 640
# The square around each provider's head in its idle art (1056×1408), for the provider icon.
HEADS = {"anthropic": (270, 60, 480), "openai": (300, 60, 420), "google": (300, 30, 440), "xai": (330, 40, 420), "shell": (250, 40, 520), "docker": (300, 40, 440)}
FAMILIAR_SIZE = 112
# Cut-out options for art the mask alone gets wrong: the girders the ogre rivets stand below the mask,
# and the stones and rings around the levitating troll would count as backdrop.
CUT = {"anthropic/working": {"solid_below": 0.55}, "google/working": {"black": True}}


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


def cutout(src, mask, solid_below=None, black=False):
    """The subject over transparency. Glows outside the mask stay, with the dark backdrop subtracted and un-premultiplied away.
    `solid_below` (a fraction of the height) also keeps whatever stands out of the backdrop below that line opaque, for a dark
    part the mask misses; it is judged on a brightened copy, where shadowed surfaces still clear the backdrop."""
    rgb = np.asarray(Image.open(src).convert("RGB"), dtype=np.float32) / 255
    m = np.asarray(Image.open(mask).convert("L"), dtype=np.float32) / 255
    glow = rgb if black else np.clip(rgb - backdrop(rgb, m), 0, 1)
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


def source(rel, masks, solid_below=None, black=False):
    src, mask = PACK / f"{rel}.png", PACK / f"{rel}-mask.png"
    if masks or not mask.exists():
        remask(src, mask)
    return cutout(src, mask, solid_below, black)


def hex_rgb(color):
    return tuple(int(color[i:i + 2], 16) for i in (1, 3, 5))


def icon(art, box, color, size=128):
    """The provider's head on a dark sooty iron tile lit in its colour, with a few drifting embers."""
    x, y, side = box
    head = art.crop((x, y, x + side, y + side)).resize((size, size), Image.LANCZOS)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) / size
    glow = np.clip(1 - np.hypot(xx - 0.5, yy - 0.42) / 0.75, 0, 1) ** 1.5
    base = np.array([14, 17, 15], dtype=np.float32)
    rgb = base + (np.array(hex_rgb(color), dtype=np.float32) * 0.55 - base) * glow[..., None]
    tile = Image.fromarray(rgb.astype(np.uint8), "RGB").convert("RGBA")
    rng = np.random.default_rng(size)
    embers = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(embers)
    for fx, fy, r in zip(rng.integers(0, size, 9), rng.integers(0, size, 9), rng.uniform(0.6, 1.4, 9)):
        draw.ellipse((fx - r, fy - r, fx + r, fy + r), fill=(255, 176, 96, int(110 + 90 * r / 1.4)))
    tile.alpha_composite(embers.filter(ImageFilter.GaussianBlur(0.6)))
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


def hexagon(cx, cy, r, turn=0.0):
    """An SVG path for a regular hexagon; `turn` rotates it from flat-sided left and right."""
    pts = [f"{cx + r * np.cos(np.pi / 3 * i + turn):.2f} {cy + r * np.sin(np.pi / 3 * i + turn):.2f}" for i in range(6)]
    return "M" + "L".join(pts) + "Z"


def ticks(cx, cy, r1, r2, count, start, sweep):
    """An SVG path of `count` radial tick marks between radii r1 and r2, spread evenly over `sweep` from `start`."""
    out = []
    for i in range(count):
        a = start + sweep * i / (count - 1)
        out.append(f"M{cx + r1 * np.sin(a):.2f} {cy - r1 * np.cos(a):.2f}L{cx + r2 * np.sin(a):.2f} {cy - r2 * np.cos(a):.2f}")
    return "".join(out)


BRASS = '<linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f8dc9a"/><stop offset="0.45" stop-color="#c38f3e"/><stop offset="1" stop-color="#6e4718"/></linearGradient>'
COPPER = '<linearGradient id="c" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f3b483"/><stop offset="0.5" stop-color="#b8693a"/><stop offset="1" stop-color="#6a3317"/></linearGradient>'
NUT_RIVETS = "".join(f'<circle cx="{32 + 26 * np.sin(a):.2f}" cy="{32 - 26 * np.cos(a):.2f}" r="1.4"/>' for a in np.linspace(0, 2 * np.pi, 6, endpoint=False))
GAUGE_RIVETS = "".join(f'<circle cx="{100 + 92 * np.sin(a):.2f}" cy="{100 - 92 * np.cos(a):.2f}" r="4"/>' for a in np.linspace(0, 2 * np.pi, 8, endpoint=False))

# The level badge: a riveted brass hex nut with a dark iron bore; the level number sits in the bore.
LEVEL = f"""
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    {BRASS}
    <radialGradient id="w" cx="42%" cy="36%" r="70%"><stop offset="0" stop-color="#3c4440"/><stop offset="0.75" stop-color="#1c2220"/><stop offset="1" stop-color="#101412"/></radialGradient>
  </defs>
  <path d="{hexagon(32, 32, 31, np.pi / 6)}" fill="url(#b)" stroke="#4f3210" stroke-width="1" stroke-linejoin="round"/>
  <path d="{hexagon(32, 32, 28, np.pi / 6)}" fill="none" stroke="#fff1c8" stroke-opacity="0.45" stroke-width="0.8" stroke-linejoin="round"/>
  <circle cx="32" cy="32" r="19.5" fill="url(#w)" stroke="#f3d08a" stroke-width="1.6"/>
  <circle cx="32" cy="32" r="16.5" fill="none" stroke="#7fc4a8" stroke-opacity="0.35" stroke-width="0.8" stroke-dasharray="2.2 2.2"/>
  <g fill="#fff0c4" stroke="#6b4419" stroke-width="0.5">{NUT_RIVETS}</g>
</svg>"""

# The locked badge: an iron padlock on a riveted copper plate gone green with verdigris.
LOCK = f"""
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
  <defs>
    {COPPER}
    <radialGradient id="v" cx="70%" cy="80%" r="60%"><stop offset="0" stop-color="#5fae8f" stop-opacity="0.75"/><stop offset="1" stop-color="#5fae8f" stop-opacity="0"/></radialGradient>
    <linearGradient id="i" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d9dde3"/><stop offset="1" stop-color="#7d848f"/></linearGradient>
  </defs>
  <rect x="2" y="2" width="36" height="36" rx="7" fill="url(#c)" stroke="#4a220c" stroke-width="1"/>
  <rect x="2" y="2" width="36" height="36" rx="7" fill="url(#v)"/>
  <rect x="4.6" y="4.6" width="30.8" height="30.8" rx="5" fill="none" stroke="#ffd9b8" stroke-opacity="0.35" stroke-width="0.7"/>
  <g fill="#ffe1c4" stroke="#5a2a10" stroke-width="0.5"><circle cx="7.5" cy="7.5" r="1.3"/><circle cx="32.5" cy="7.5" r="1.3"/><circle cx="7.5" cy="32.5" r="1.3"/><circle cx="32.5" cy="32.5" r="1.3"/></g>
  <path d="M15.4 19.5v-3.2a4.6 4.6 0 0 1 9.2 0v3.2" fill="none" stroke="url(#i)" stroke-width="2.3" stroke-linecap="round"/>
  <rect x="12.6" y="19" width="14.8" height="11.2" rx="2.4" fill="url(#i)" stroke="#4a5059" stroke-width="0.7"/>
  <circle cx="20" cy="23.6" r="1.7" fill="#2a2e35"/><rect x="19.25" y="24" width="1.5" height="3.3" rx="0.75" fill="#2a2e35"/>
</svg>"""

# The card and dialog frame, a 9-slice for border-image (it needs its own size, or the slices scale with the box):
# riveted copper gusset plates in the corners, joined by a thin copper pipe.
FRAME_CORNER = ('<path d="M3 7a4 4 0 0 1 4-4h21L3 28z" fill="url(#c)" stroke="#4a220c" stroke-width="0.8" stroke-linejoin="round"/>'
                '<path d="M6 6.5h15M6.5 6v15" stroke="#ffd9b8" stroke-opacity="0.4" stroke-width="0.7"/>'
                '<g fill="#ffe7c8" stroke="#5a2a10" stroke-width="0.6"><circle cx="7.5" cy="7.5" r="1.7"/><circle cx="17.5" cy="7" r="1.25"/><circle cx="7" cy="17.5" r="1.25"/></g>')
FRAME = f"""
<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <defs>{COPPER}</defs>
  <path d="M26 5.5h44M26 90.5h44M5.5 26v44M90.5 26v44" stroke="#6a3317" stroke-opacity="0.7" stroke-width="2.6" stroke-linecap="round"/>
  <path d="M26 5.5h44M26 90.5h44M5.5 26v44M90.5 26v44" stroke="#d98b55" stroke-opacity="0.9" stroke-width="1.2" stroke-linecap="round"/>
  {FRAME_CORNER}
  <g transform="matrix(-1 0 0 1 96 0)">{FRAME_CORNER}</g>
  <g transform="matrix(1 0 0 -1 0 96)">{FRAME_CORNER}</g>
  <g transform="matrix(-1 0 0 -1 96 96)">{FRAME_CORNER}</g>
</svg>"""

# The working effect: the riveted bezel of a big pressure gauge that rattles behind a working builder.
GAUGE = f"""
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <defs>{BRASS}</defs>
  <circle cx="100" cy="100" r="92" fill="none" stroke="url(#b)" stroke-width="9"/>
  <circle cx="100" cy="100" r="82" fill="none" stroke="url(#b)" stroke-width="1.6"/>
  <path d="{ticks(100, 100, 66, 76, 41, -0.75 * np.pi, 1.5 * np.pi)}" stroke="url(#b)" stroke-width="1.6"/>
  <path d="{ticks(100, 100, 56, 76, 9, -0.75 * np.pi, 1.5 * np.pi)}" stroke="url(#b)" stroke-width="4" stroke-linecap="round"/>
  <path d="M100 100L136 64" stroke="url(#b)" stroke-width="5" stroke-linecap="round"/>
  <circle cx="100" cy="100" r="10" fill="url(#b)"/>
  <g fill="url(#b)">{GAUGE_RIVETS}</g>
</svg>"""

# Usage meter markers: a brass hex nut for the first window, a blue-glowing vacuum tube for the second.
NUT = f"""
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <defs>{BRASS}</defs>
  <path d="{hexagon(8, 8, 7.5, np.pi / 6)}" fill="url(#b)" stroke="#4f3210" stroke-width="0.5" stroke-linejoin="round"/>
  <circle cx="8" cy="8" r="2.9" fill="#1c2220" stroke="#f3d08a" stroke-width="0.7"/>
</svg>"""
TUBE = """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <defs>
    <radialGradient id="g" cx="50%" cy="45%" r="60%"><stop offset="0" stop-color="#eaf5ff"/><stop offset="0.45" stop-color="#7ab4ff"/><stop offset="1" stop-color="#2f4fc8" stop-opacity="0.85"/></radialGradient>
    <linearGradient id="b" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7a5320"/><stop offset="0.5" stop-color="#f3d08a"/><stop offset="1" stop-color="#7a5320"/></linearGradient>
  </defs>
  <path d="M4.2 11V5.4a3.8 3.8 0 0 1 7.6 0V11z" fill="url(#g)" stroke="#dbe9ff" stroke-width="0.6"/>
  <path d="M8 4.2v4.6M6.4 8.8h3.2" stroke="#fff" stroke-opacity="0.85" stroke-width="0.7" stroke-linecap="round"/>
  <rect x="3.4" y="10.6" width="9.2" height="3.6" rx="0.8" fill="url(#b)" stroke="#4f3210" stroke-width="0.4"/>
</svg>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--masks", action="store_true", help="recompute the BiRefNet masks with the local image studio")
    args = ap.parse_args()

    for pid, color in PROVIDERS.items():
        for st in STATES:
            art = source(f"characters/{pid}/{st}", args.masks, **CUT.get(f"{pid}/{st}", {}))
            encode(shrink(art, CHARACTER_WIDTH), WEB / "characters" / pid / st, avif=60)
            if st == "idle":
                encode(icon(art, HEADS[pid], color), WEB / "icons" / pid, avif=70)

    for name in ("flame", "leaf", "night", "aether"):
        quantize(familiar(PACK / "familiars" / f"{name}.png"), WEB / "familiars" / f"{name}.png")

    # The mask leaves out the crate and cart the goblin sits by, in the lower half.
    empty = source("ui/empty-state", args.masks, solid_below=0.55)
    encode(shrink(empty.crop(empty.getbbox()), 420), WEB / "ui" / "empty-state", avif=60)
    # The backgrounds are upscaled 2x (3840x2176) so ultrawide screens stay sharp.
    encode(Image.open(PACK / "backgrounds" / "page.png").convert("RGB"), WEB / "page", avif=62, webp=80)
    light = Image.open(PACK / "backgrounds" / "page-light.png").convert("RGB")
    encode(Image.blend(light, Image.new("RGB", light.size, (246, 240, 228)), 0.28), WEB / "page-light", avif=62, webp=80)

    write("ui/level.svg", LEVEL)
    write("ui/lock.svg", LOCK)
    write("ui/frame.svg", FRAME)
    write("ui/gauge.svg", GAUGE)
    write("ui/nut.svg", NUT)
    write("ui/tube.svg", TUBE)

    if shutil.which("oxipng"):
        subprocess.run(["oxipng", "-o", "4", "--strip", "safe", "-q", "-r", str(WEB / "familiars")], check=True)


if __name__ == "__main__":
    main()
