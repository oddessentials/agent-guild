"""Build a Yard world's generated models.

  python build.py WORLD models [name ...]   TRELLIS.2 models from the portraits and concepts
  python build.py WORLD cast [name ...]     rig the cast into web/yard/assets
  python build.py WORLD halls               assemble web/yard/assets/<world>.glb

A world's sources are in concept-art/<world>-yard: `world.json` names its
cast (runtime name: source image, metres tall, and for builders the working
motion), its town buildings, seeds other than 42, the subjects cut out onto
grey, and hall turns. Image paths are relative to that folder; halls and town
buildings come from its concepts/<name>.png.

`models` needs the local image studio's ComfyUI (see trellis.py) and writes
.cache/<world>-yard/models/<name>.glb; existing files are kept unless named.
"""
import json, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
ASSETS = ROOT / 'web/yard/assets'
BLENDER = 'E:/Program Files/Blender Foundation/Blender 5.2/blender.exe'
PROVIDERS = ['anthropic', 'openai', 'google', 'xai', 'shell']

def world(name):
    folder = ROOT / 'concept-art' / f'{name}-yard'
    spec = json.loads((folder / 'world.json').read_text(encoding='utf-8'))
    for entry in spec['cast'].values():
        entry['image'] = (folder / entry['image']).resolve()
    return folder, spec, ROOT / f'.cache/{name}-yard/models'

def models(name, names):
    sys.path.insert(0, str(HERE))
    import trellis
    folder, spec, out_dir = world(name)
    # Builders are seen up close: more faces and texture. 1536 shape voxels overflow
    # 16 GB on cloaks and fur, so everything stays at 1024.
    jobs = {key: (c['image'], 50000, 2048, 1024) if c.get('work') else (c['image'], 30000, 1024, 512)
            for key, c in spec['cast'].items()}
    # A world whose halls are authored elsewhere (Guild) has no hall concepts.
    jobs.update({f'hall_{p}': (folder / f'concepts/hall_{p}.png', 60000, 2048, 1024) for p in PROVIDERS
                 if (folder / f'concepts/hall_{p}.png').exists()})
    jobs.update({t: (folder / f'concepts/{t}.png', 40000, 2048, 1024) for t in spec.get('town', [])})
    for key, (image, faces, texture, resolution) in jobs.items():
        out = out_dir / f'{key}.glb'
        if (names and key not in names) or (not names and out.exists()):
            continue
        # The skins' portraits have hand-checked cut-out masks beside them.
        mask = image.with_name(image.stem + '-mask.png')
        # A finer remesh fills VRAM while the diffusion models are still resident
        # and then crawls; 512 is the template default, and small subjects need less.
        trellis.run(image, out, seed=spec.get('seeds', {}).get(key, 42), faces=faces, texture=texture,
                    mask=mask if mask.exists() else None, resolution=resolution,
                    background='#808080' if key in spec.get('grey', []) else '#000000',
                    remesh=512 if resolution > 512 else 384, tag=f'{name}-yard')

def cast(name, names):
    _, spec, out_dir = world(name)
    for key, c in spec['cast'].items():
        if names and key not in names:
            continue
        args = [BLENDER, '-b', '--factory-startup', '--python', str(HERE / 'rig.py'), '--',
                str(out_dir / f'{key}.glb'), str(ASSETS / f'{key}.glb'), str(c['height'])]
        # Familiars and helpers stand at under half a metre on screen.
        args += ['--kind', 'builder', '--work', c['work']] if c.get('work') else \
                ['--kind', 'familiar', '--faces', '10000', '--texture', '512']
        subprocess.run(args, check=True)

def halls(name):
    subprocess.run([BLENDER, '-b', '--factory-startup', '--python', str(HERE / 'halls.py'), '--', name], check=True)

if __name__ == '__main__':
    name, step, names = sys.argv[1], sys.argv[2], sys.argv[3:]
    {'models': lambda: models(name, names), 'cast': lambda: cast(name, names), 'halls': lambda: halls(name)}[step]()
