"""Render a world's environment plates for the Yard.

  blender -b --factory-startup --python concept-art/guild-yard/env/plates.py -- guild

Each layer covers a rectangle of the view plane (model.mjs `viewBasis`) at a
fixed density, split into tiles no larger than MAX_TILE pixels. Base covers
every permitted view; detail covers what the default zoom can reach; close
covers where live halls and characters stand, for zooming in. Each theme
(light, dark) has its own set. plates.json records the camera and suns they
were rendered for, so a stale render fails the tests.
"""
import json, math, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from camera import ROOT, view, ortho_camera

MAX_TILE = 4096
SAMPLES = 128
QUALITY = 72

def layers():
    v = view()
    cam, ext, b = v['camera'], v['extent'], v['basis']
    p, y = cam['pan'], cam['target'][1]
    corners = [(x, y, z) for x in (p['minX'], p['maxX']) for z in (p['minZ'], p['maxZ'])]
    dot = lambda c, axis: sum(i * j for i, j in zip(c, axis))
    def around(half_w, half_h):
        r = [dot(c, b['right']) for c in corners]
        u = [dot(c, b['up']) for c in corners]
        return [min(r) - half_w, max(r) + half_w], [min(u) - half_h, max(u) + half_h]
    half = cam['height'] / 2
    detail = around(half * 16 / 9, half)
    # Live halls and characters stand on the courtyard and the rows in front of it.
    live = [(x, 0, z) for x in (-14, 14) for z in (-14, 22)]
    lr, lu = [dot(c, b['right']) for c in live], [dot(c, b['up']) for c in live]
    close = [min(lr) - 2, max(lr) + 2], [min(lu) - 2, max(lu) + 6]
    return [('base', 20, ext['right'], ext['up']), ('detail', 40, *detail), ('close', 80, *close)]

def tiles(right, up, density):
    """Split a rectangle into tiles on a whole-pixel grid at `density` px/unit."""
    width, height = math.ceil((right[1] - right[0]) * density), math.ceil((up[1] - up[0]) * density)
    cols, rows = math.ceil(width / MAX_TILE), math.ceil(height / MAX_TILE)
    tw, th = math.ceil(width / cols), math.ceil(height / rows)
    for row in range(rows):
        for col in range(cols):
            r0, u1 = right[0] + col * tw / density, up[1] - row * th / density
            yield col, row, tw, th, [r0, r0 + tw / density], [u1 - th / density, u1]

def render(world):
    import bpy, importlib
    env = importlib.import_module(world + '_env')
    out = ROOT / 'web/yard/assets' / world
    out.mkdir(parents=True, exist_ok=True)
    manifest = {'camera': view()['camera'], 'sun': view()['sun'], 'themes': {}}
    for theme in ('light', 'dark'):
        env.build(with_halls=False, theme=theme)
        scene = bpy.context.scene
        # Only this script's tiles; the world's surface textures live alongside.
        for old in out.glob(f'{theme}-*.webp'):
            old.unlink()
        manifest['themes'][theme] = []
        for name, density, right, up in layers():
            layer = {'name': name, 'density': density, 'tiles': []}
            for col, row, w, h, r, u in tiles(right, up, density):
                ortho_camera(scene, f'{name}-{col}-{row}', ((r[0] + r[1]) / 2, (u[0] + u[1]) / 2), r[1] - r[0], u[1] - u[0])
                env.render_settings(scene, w, h, SAMPLES)
                scene.render.image_settings.file_format = 'WEBP'
                scene.render.image_settings.quality = QUALITY
                scene.render.image_settings.color_mode = 'RGB'
                file = f'{theme}-{name}-{col}-{row}.webp'
                scene.render.filepath = str(out / file)
                bpy.ops.render.render(write_still=True)
                layer['tiles'].append({'file': f'{world}/{file}', 'right': r, 'up': u, 'width': w, 'height': h})
                print('YARD_PLATE', file, w, h, flush=True)
            manifest['themes'][theme].append(layer)
    (out / 'plates.json').write_text(json.dumps(manifest, indent=1) + '\n', encoding='utf-8', newline='\n')

if __name__ == '__main__':
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    render(args[0] if args else 'guild')
