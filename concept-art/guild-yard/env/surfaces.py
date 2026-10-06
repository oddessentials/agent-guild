"""Export a world's live surface textures and sky for the Yard runtime.

  blender -b --factory-startup --python concept-art/guild-yard/env/surfaces.py -- guild

Halls are live models, so they take Poly Haven material sets (colour, normal,
roughness) at a size suited to their screen size, plus a small copy of the
plates' sky for image-based lighting. Writes web/yard/assets/<world>/surfaces.json.
"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import polyhaven
from camera import ROOT

SIZE = 512
QUALITY = 80
MAPS = {'color': ('Diffuse', 'sRGB'), 'normal': ('nor_gl', 'Non-Color'), 'rough': ('Rough', 'Non-Color')}

def export(world):
    import bpy, importlib
    import numpy as np
    env = importlib.import_module(world + '_env')
    out = ROOT / 'web/yard/assets' / world
    out.mkdir(parents=True, exist_ok=True)
    manifest = {'sky': {theme: f'{world}/sky-{theme}.hdr' for theme in env.SKIES}, 'surfaces': {}}
    for name, (asset, metres, materials, tint) in env.SURFACES.items():
        files = polyhaven.texture(asset, '1k')
        entry = {'metres': metres, 'materials': materials, 'tint': tint}
        for key, (map_name, space) in MAPS.items():
            src = bpy.data.images.load(str(files[map_name]))
            src.colorspace_settings.name = space
            src.scale(SIZE, SIZE)
            # Copied raw into an RGB image: greyscale maps cannot be written as
            # WebP, and a plain save applies no display transform to the values.
            img = bpy.data.images.new(f'{name}-{key}', SIZE, SIZE, alpha=False)
            img.colorspace_settings.name = space
            img.pixels.foreach_set(np.array(src.pixels[:], dtype=np.float32))
            file = f'{world}/{name}-{key}.webp'
            img.filepath_raw, img.file_format = str(ROOT / 'web/yard/assets' / file), 'WEBP'
            img.save(quality=QUALITY)
            entry[key] = file
        manifest['surfaces'][name] = entry
    for theme, asset in env.SKIES.items():
        sky = bpy.data.images.load(str(polyhaven.hdri(asset, '1k')))
        sky.scale(512, 256)
        sky.filepath_raw, sky.file_format = str(ROOT / 'web/yard/assets' / manifest['sky'][theme]), 'HDR'
        sky.save()
    (out / 'surfaces.json').write_text(json.dumps(manifest, indent=1) + '\n', encoding='utf-8', newline='\n')
    print('YARD_SURFACES', world, flush=True)

if __name__ == '__main__':
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    export(args[0] if args else 'guild')
