"""Generate concept images for a Yard world with the local image studio.

  python concepts.py WORLD [name ...] [--seeds N]

Each entry in concept-art/<world>-yard/concepts.json is its prompt plus
`_style` (or the style it names), generated with `hidream-o1` at 1024 x 1024.
Writes raw/<name>-<seed>.png in that folder; copy picks into
concepts/<name>.png and record the seed as the entry's `pick`. --seeds N makes
N candidates from the entry's seed up.
"""
import json, shutil, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
STUDIO = Path('E:/projects/local-image-studio')

def main():
    args = sys.argv[1:]
    seeds = int(args[args.index('--seeds') + 1]) if '--seeds' in args else 1
    world, names = args[0], [a for a in args[1:] if not a.startswith('--') and not a.isdigit()]
    folder = HERE.parent / f'{world}-yard'
    raw = folder / 'raw'
    spec = json.loads((folder / 'concepts.json').read_text(encoding='utf-8'))
    styles = {k: spec.pop(k) for k in [k for k in spec if k.startswith('_')]}
    for name, entry in spec.items():
        style = styles[entry.get('style', '_style')]
        if names and name not in names:
            continue
        for seed in range(entry['seed'], entry['seed'] + seeds):
            out = raw / f'{name}-{seed}'
            subprocess.run([sys.executable, str(STUDIO / 'scripts/gen.py'), entry['prompt'] + ' ' + style,
                            '--workflow', 'hidream-o1', '--seed', str(seed), '--width', '1024', '--height', '1024',
                            '--out', str(out)], check=True)
            image = next(out.glob('*.png'))
            shutil.move(image, raw / f'{name}-{seed}.png')
            shutil.rmtree(out)
            print('CONCEPT', raw / f'{name}-{seed}.png', flush=True)

if __name__ == '__main__':
    main()
