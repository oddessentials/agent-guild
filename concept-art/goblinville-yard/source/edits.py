"""Edit picked images with qwen-edit in the local image studio.

  python edits.py [name ...]

Each entry in edits.json is a chain of edits: the first starts from its
`input` (relative to concept-art/goblinville-yard), each later one from the
previous result. The last result is written to concepts/<name>.png.
"""
import json, shutil, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
STUDIO = Path('E:/projects/local-image-studio')
RAW = HERE.parent / 'raw' / 'edit'

def main():
    names = sys.argv[1:]
    for name, chain in json.loads((HERE / 'edits.json').read_text(encoding='utf-8')).items():
        if names and name not in names:
            continue
        image = HERE.parent / chain[0]['input']
        for step, edit in enumerate(chain):
            out = RAW / f'{name}-{step}'
            subprocess.run([sys.executable, str(STUDIO / 'scripts/gen.py'), edit['prompt'], '--workflow', 'qwen-edit',
                            '--input', str(image), '--seed', str(edit['seed']), '--out', str(out)], check=True)
            image = RAW / f'{name}-{step}.png'
            shutil.move(next(out.glob('*.png')), image)
            shutil.rmtree(out)
        shutil.copyfile(image, HERE.parent / 'concepts' / f'{name}.png')
        print('EDIT', name, flush=True)

if __name__ == '__main__':
    main()
