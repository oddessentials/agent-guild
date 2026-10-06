"""Edit picked images with qwen-edit in the local image studio.

  python edits.py WORLD [name ...]

Each entry in concept-art/<world>-yard/edits.json is a chain of edits: the
first starts from its `input` (relative to that folder), each later one from
the previous result. The last result is written to concepts/<name>.png.
"""
import json, shutil, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
STUDIO = Path('E:/projects/local-image-studio')

def main():
    world, names = sys.argv[1], sys.argv[2:]
    folder = HERE.parent / f'{world}-yard'
    raw = folder / 'raw' / 'edit'
    for name, chain in json.loads((folder / 'edits.json').read_text(encoding='utf-8')).items():
        if names and name not in names:
            continue
        image = folder / chain[0]['input']
        for step, edit in enumerate(chain):
            out = raw / f'{name}-{step}'
            subprocess.run([sys.executable, str(STUDIO / 'scripts/gen.py'), edit['prompt'], '--workflow', 'qwen-edit',
                            '--input', str(image), '--seed', str(edit['seed']), '--out', str(out)], check=True)
            image = raw / f'{name}-{step}.png'
            shutil.move(next(out.glob('*.png')), image)
            shutil.rmtree(out)
        shutil.copyfile(image, folder / 'concepts' / f'{name}.png')
        print('EDIT', name, flush=True)

if __name__ == '__main__':
    main()
