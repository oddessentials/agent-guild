# Builds the Professional skin's art into web/skins/professional/ from this pack.
#   python source/build.py
# The card art comes from the Blender renders in objects/ (source/scene.py) and the page from
# backgrounds/ (source/props.py); the icons, lock and empty state are SVG from the palette below.
from pathlib import Path
import numpy as np
from PIL import Image

PACK = Path(__file__).resolve().parent.parent
WEB = PACK.parent.parent / "web" / "skins" / "professional"
PROVIDERS = {"anthropic": "#d97757", "openai": "#10a37f", "google": "#4285f4", "xai": "#14b8c4", "shell": "#7c6cf0", "docker": "#2496ed"}
MODES = {
    "light": {"surface": "#ffffff", "back": "#f1f3f6", "border": "#d5dae1", "line": "#e4e7ec", "dot": "#cbd2db", "accent": "#2563eb"},
    "dark": {"surface": "#171b23", "back": "#11151b", "border": "#2e3440", "line": "#262c37", "dot": "#3a4250", "accent": "#5b8def"},
}


def encode(im, out, avif, webp=82):
    out.parent.mkdir(parents=True, exist_ok=True)
    im.save(out.with_suffix(".avif"), quality=avif, subsampling="4:4:4", speed=2)
    im.save(out.with_suffix(".webp"), quality=webp, method=6)


def write(rel, svg):
    file = WEB / rel
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text("".join(line.strip() for line in svg.strip().splitlines()) + "\n", encoding="utf-8", newline="\n")


# Vendor marks from @lobehub/icons-static-svg 1.95.1 (MIT), 24x24, drawn white.
MARKS = {
    "anthropic": "M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z",
    "openai": "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z",
    "google": "M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z",
    "xai": "M6.469 8.776L16.512 23h-4.464L2.005 8.776H6.47zm-.004 7.9l2.233 3.164L6.467 23H2l4.465-6.324zM22 2.582V23h-3.659V7.764L22 2.582zM22 1l-9.952 14.095-2.233-3.163L17.533 1H22z",
}
SHELL = '<g fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 24l8 8-8 8M33 41h11"/></g>'
# Docker Agent: a ribbed shipping container, not Docker's logo.
CONTAINER = '<g fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><rect x="14" y="21" width="36" height="22" rx="2.5"/><path d="M22 26.5v11M28 26.5v11M34 26.5v11M40 26.5v11"/></g>'


def icon(pid, color):
    """Provider icon: a rounded tile in the provider's colour with the vendor's mark in white. 64x64."""
    mark = (f'<path transform="translate(17 17) scale(1.25)" fill="#fff" fill-rule="evenodd" d="{MARKS[pid]}"/>' if pid in MARKS
            else CONTAINER if pid == "docker" else SHELL)
    return f"""
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs><linearGradient id="t" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="{color}"/><stop offset="1" stop-color="{color}" stop-opacity="0.82"/>
  </linearGradient></defs>
  <rect width="64" height="64" rx="15" fill="#0b0d12"/>
  <rect width="64" height="64" rx="15" fill="url(#t)"/>
  <rect x="0.75" y="0.75" width="62.5" height="62.5" rx="14.25" fill="none" stroke="#fff" stroke-opacity="0.22" stroke-width="1.5"/>
  {mark}
</svg>"""


LOCK = """
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
  <rect width="40" height="40" rx="10" fill="#0f172a" fill-opacity="0.72"/>
  <rect x="0.5" y="0.5" width="39" height="39" rx="9.5" fill="none" stroke="#fff" stroke-opacity="0.16"/>
  <path d="M15 18v-3.2a5 5 0 0 1 10 0V18" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>
  <rect x="12.5" y="18" width="15" height="11" rx="2.4" fill="#fff"/>
  <circle cx="20" cy="23" r="1.6" fill="#0f172a"/>
</svg>"""


def cutout(im, margin=0.03):
    """The object and its shadow over transparency, cropped to their bounds with a small margin.

    The shadow catcher leaves a faint, even haze over the whole floor; the haze level is read
    from the bottom rows, far from the shadow, and taken out so only the shadow itself stays."""
    px = np.asarray(im, dtype=np.float32)
    a = px[..., 3]
    haze = np.percentile(a[-int(im.height * 0.04):], 60)
    a = np.clip((a - haze) / (255 - haze), 0, 1) * 255
    out = Image.fromarray(np.dstack([px[..., :3], a]).astype(np.uint8), "RGBA")
    x0, y0, x1, y1 = out.getbbox()
    m = round(max(x1 - x0, y1 - y0) * margin)
    return out.crop((max(0, x0 - m), max(0, y0 - m), min(im.width, x1 + m), min(im.height, y1 + m)))


def main():
    for png in sorted((PACK / "objects").glob("*/*.png")):
        if png.parent.name == "empty":
            continue
        encode(cutout(Image.open(png).convert("RGBA")), WEB / "objects" / png.parent.name / png.stem, avif=60, webp=82)
    for pid, color in PROVIDERS.items():
        write(f"icons/{pid}.svg", icon(pid, color))
    write("ui/lock.svg", LOCK)
    for theme, name in (("light", "empty-state-light"), ("dark", "empty-state")):
        encode(cutout(Image.open(PACK / "objects" / "empty" / f"{theme}-idle.png").convert("RGBA")), WEB / "ui" / name, avif=60, webp=82)
    # The page backgrounds are upscaled 2x (3840x2176) so ultrawide screens stay sharp.
    for name in ("page", "page-light"):
        encode(Image.open(PACK / "backgrounds" / f"{name}.png").convert("RGB"), WEB / name, avif=62, webp=80)
    print(f"wrote {WEB}")


if __name__ == "__main__":
    main()
