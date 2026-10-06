"""Build the Goblinville yard's models.

  python build.py models [name ...]   TRELLIS.2 models from the portraits and concepts
  python build.py cast [name ...]     rig the cast into web/yard/assets
  python build.py halls               assemble web/yard/assets/goblinville.glb

`models` needs the local image studio's ComfyUI (see trellis.py) and writes
.cache/goblinville-yard/models/<name>.glb; existing files are kept unless named.
The builders and familiars come from the Goblinville skin's art
(concept-art/goblinville-skin); the OpenAI and xAI builders from restaged
copies of their portraits, and halls, town buildings and shell helpers from
the picked concepts, all in ../concepts.
"""
import subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SKIN = ROOT / 'concept-art/goblinville-skin'
CONCEPTS = HERE.parent / 'concepts'
MODELS = ROOT / '.cache/goblinville-yard/models'
ASSETS = ROOT / 'web/yard/assets'
BLENDER = 'E:/Program Files/Blender Foundation/Blender 5.2/blender.exe'

# Runtime name: (source image, metres tall, working motion).
# Builders follow PROVIDER_ORDER in web/yard/model.mjs.
CAST = {
    'goblin_0': (SKIN / 'characters/anthropic/idle.png', 2.05, 'tinker'),
    'goblin_1': (CONCEPTS / 'builder_openai.png', 2.0, 'tinker'),
    'goblin_2': (SKIN / 'characters/google/idle.png', 2.35, 'conduct'),
    'goblin_3': (CONCEPTS / 'builder_xai.png', 1.6, 'tinker'),
    'goblin_4': (SKIN / 'characters/shell/idle.png', 1.65, 'tinker'),
    'goblin_familiar_0': (SKIN / 'familiars/flame.png', 1.1, None),
    'goblin_familiar_1': (CONCEPTS / 'familiar_leaf.png', 1.2, None),
    'goblin_familiar_2': (SKIN / 'familiars/night.png', 1.3, None),
    'goblin_familiar_3': (SKIN / 'familiars/aether.png', 1.3, None),
    **{f'goblin_helper_{i}': (CONCEPTS / f'shell_helper_{i}.png', 1.1, None) for i in range(4)},
}
# Seeds other than 42, where 42 reconstructed badly.
SEEDS = {'factory': 7}
# Dark subjects read as background against black; these are cut out onto grey.
GREY = {'goblin_1', 'goblin_3'}
# Static models: source image, faces, texture size, shape upsample voxels.
STATIC = {name: (CONCEPTS / f'{name}.png', 60000, 2048, 1024) for name in
          ['hall_anthropic', 'hall_openai', 'hall_google', 'hall_xai', 'hall_shell']}
STATIC.update({name: (CONCEPTS / f'{name}.png', 40000, 2048, 1024) for name in
               ['town_house_a', 'town_house_b', 'town_house_c', 'water_tower', 'crane', 'factory']})

def models(names):
    sys.path.insert(0, str(HERE))
    import trellis
    # Builders are seen up close: more faces and texture. 1536 shape voxels overflow
    # 16 GB on cloaks and fur, so everything stays at 1024.
    jobs = {name: (image, 50000, 2048, 1024) if work else (image, 30000, 1024, 512)
            for name, (image, _, work) in CAST.items()}
    jobs.update(STATIC)
    for name, (image, faces, texture, resolution) in jobs.items():
        out = MODELS / f'{name}.glb'
        if (names and name not in names) or (not names and out.exists()):
            continue
        # The skin's portraits have hand-checked cut-out masks beside them.
        mask = image.with_name(image.stem + '-mask.png')
        # A finer remesh fills VRAM while the diffusion models are still resident
        # and then crawls; 512 is the template default, and small subjects need less.
        trellis.run(image, out, seed=SEEDS.get(name, 42), faces=faces, texture=texture, mask=mask if mask.exists() else None,
                    resolution=resolution, background='#808080' if name in GREY else '#000000',
                    remesh=512 if resolution > 512 else 384)

def cast(names):
    for name, (_, height, work) in CAST.items():
        if names and name not in names:
            continue
        args = [BLENDER, '-b', '--factory-startup', '--python', str(HERE / 'rig.py'), '--',
                str(MODELS / f'{name}.glb'), str(ASSETS / f'{name}.glb'), str(height)]
        # Familiars and helpers stand at under half a metre on screen.
        args += ['--kind', 'builder', '--work', work] if work else ['--kind', 'familiar', '--faces', '10000', '--texture', '512']
        subprocess.run(args, check=True)

def halls():
    subprocess.run([BLENDER, '-b', '--factory-startup', '--python', str(HERE / 'halls.py')], check=True)

if __name__ == '__main__':
    step, names = sys.argv[1], sys.argv[2:]
    {'models': lambda: models(names), 'cast': lambda: cast(names), 'halls': halls}[step]()
