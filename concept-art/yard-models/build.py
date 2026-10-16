"""Build a Yard world's generated models.

  python build.py WORLD models [name ...]   TRELLIS.2 models from the portraits and concepts
  python build.py WORLD cast [name ...]     rig the cast into web/yard/assets
  python build.py WORLD recast [name ...]   rig the cast again from its shipped models,
                                            without the generated sources
  python build.py WORLD sheets [name ...]   contact sheets of the cast's clips, for spot checks
  python build.py WORLD godot [name ...]    check the cast and the station prop import in Godot 4
  python build.py WORLD halls               assemble web/yard/assets/<world>.glb
  python build.py WORLD props               stand the station prop up as web/yard/assets/<world>_station.glb

A world's sources are in concept-art/<world>-yard: `world.json` names its
cast (runtime name: source image, metres tall, and for builders the working
motion, any held tool, `prop`, as rig.py's cut_prop and plant read it, the
`gait` when it is not a walk, `robe`, the `busy` hand that holds something
modelled in, and the `neck` and `hips` shares of the height where its silhouette
misleads the rig),
its town buildings, seeds other than 42, the subjects cut out onto grey, hall
turns, and its `station` prop: the working surface height for a 2 m figure
(`surface`, which rig.py scales by each builder's shoulder height) and the
prop's largest `footprint`. Image paths are relative to that folder; halls,
town buildings and the station prop come from its concepts/<name>.png.

`models` needs the local image studio's ComfyUI (see trellis.py) and writes
.cache/<world>-yard/models/<name>.glb; existing files are kept unless named.
`cast` and `recast` write rig.py's checks to .cache/<world>-yard/rig/<name>.json
and print the clips that fail them. BLENDER overrides the Blender executable,
and GODOT the Godot 4 one (default `godot`).
"""
import json, os, shutil, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
ASSETS = ROOT / 'web/yard/assets'
BLENDER = os.environ.get('BLENDER', 'E:/Program Files/Blender Foundation/Blender 5.2/blender.exe')
PROVIDERS = ['anthropic', 'openai', 'google', 'xai', 'shell', 'docker']
# How far a station's prop stands from its character: STAGING.station.gap in web/yard/model.mjs.
GAP = .75

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
    # The station prop is seen as close as the builders who work at it.
    if (folder / 'concepts/station.png').exists():
        jobs['station'] = (folder / 'concepts/station.png', 60000, 2048, 1024)
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

ROLES = (('pbrMetallicRoughness', 'baseColorTexture'), ('pbrMetallicRoughness', 'metallicRoughnessTexture'),
         (None, 'normalTexture'), (None, 'occlusionTexture'), (None, 'emissiveTexture'))

def read_glb(path):
    data = Path(path).read_bytes()
    length = int.from_bytes(data[12:16], 'little')
    gltf = json.loads(data[20:20 + length])
    rest = data[20 + length:]
    binary = rest[8:8 + int.from_bytes(rest[:4], 'little')] if rest else b''
    return gltf, binary

def write_glb(path, gltf, binary):
    text = json.dumps(gltf, separators=(',', ':')).encode()
    text += b' ' * (-len(text) % 4)
    binary += b'\0' * (-len(binary) % 4)
    body = len(text).to_bytes(4, 'little') + b'JSON' + text + len(binary).to_bytes(4, 'little') + b'BIN\0' + binary
    Path(path).write_bytes(b'glTF' + (2).to_bytes(4, 'little') + (12 + len(body)).to_bytes(4, 'little') + body)

def role_images(gltf):
    """(material, role) -> image index. Materials go by their order: Blender
    may rename a material on import (Material_0 to Material_0.001)."""
    out = {}
    for n, m in enumerate(gltf.get('materials', [])):
        for group, role in ROLES:
            ref = (m.get(group) or {}).get(role) if group else m.get(role)
            if ref is None:
                continue
            tex = gltf['textures'][ref['index']]
            source = tex.get('source', tex.get('extensions', {}).get('EXT_texture_webp', {}).get('source'))
            out[(n, role)] = source
    return out

def keep_textures(new, old, maps):
    """Re-rigging leaves the textures alone, but Blender re-encodes them.
    Put the shipped bytes back, matched by material and role, so recasting
    never loses quality."""
    gltf, binary = read_glb(new)
    before, shipped_binary = read_glb(old)
    def shipped_bytes(i):
        # An optimized model points at its maps; one fresh from rig.py embeds them.
        image = before['images'][i]
        if 'uri' in image:
            return (maps.parent / image['uri']).read_bytes()
        view = before['bufferViews'][image['bufferView']]
        start = view.get('byteOffset', 0)
        return shipped_binary[start:start + view['byteLength']]
    pairs, old = {}, role_images(before)
    for key, image in role_images(gltf).items():
        shipped = old.get(key)
        if shipped is None:
            # Blender can split a material in two; the copy shares the role's image.
            same = {i for (_, role), i in old.items() if role == key[1]}
            if len(same) != 1:
                return False
            shipped = same.pop()
        pairs.setdefault(image, set()).add(shipped)
    if any(len(sources) != 1 for sources in pairs.values()):
        return False
    views = gltf['bufferViews']
    chunks, offset = [], 0
    replace = {gltf['images'][i]['bufferView']: shipped_bytes(next(iter(u))) for i, u in pairs.items()}
    for i, view in enumerate(views):
        start = view.get('byteOffset', 0)
        part = replace.get(i, binary[start:start + view['byteLength']])
        pad = -offset % 4
        chunks.append(b'\0' * pad); offset += pad
        view['byteOffset'], view['byteLength'] = offset, len(part)
        chunks.append(part); offset += len(part)
    gltf['buffers'][0]['byteLength'] = offset
    write_glb(new, gltf, b''.join(chunks))
    return True

def cast(name, names, shipped=False):
    _, spec, out_dir = world(name)
    reports = ROOT / f'.cache/{name}-yard/rig'
    reports.mkdir(parents=True, exist_ok=True)
    failed = []
    for key, c in spec['cast'].items():
        if names and key not in names:
            continue
        source = out_dir / f'{key}.glb'
        if shipped:
            # rig.py reads the shipped model's mesh and textures beside it.
            source = reports / f'{key}.source.glb'
            shutil.copyfile(ASSETS / f'{key}.glb', source)
            maps = reports / 'maps'
            maps.mkdir(exist_ok=True)
            for texture in (ASSETS / 'maps').glob(f'{key}-*'):
                shutil.copyfile(texture, maps / texture.name)
        report = reports / f'{key}.json'
        args = [BLENDER, '-b', '--factory-startup', '--python', str(HERE / 'rig.py'), '--',
                str(source), str(ASSETS / f'{key}.glb'), str(c['height']), '--report', str(report)]
        args += ['--kind', 'builder', '--work', c['work']] if c.get('work') else ['--kind', 'familiar']
        if 'prop' in c:
            args += ['--prop', json.dumps(c['prop'])]
        if c.get('gait'):
            args += ['--gait', c['gait']]
        if c.get('robe'):
            args += ['--robe']
        if c.get('busy'):
            args += ['--busy', c['busy']]
        for joint in ('neck', 'hips'):
            if c.get(joint):
                args += ['--' + joint, str(c[joint])]
        if c.get('work') and 'station' in spec:
            args += ['--surface', str(spec['station']['surface'])]
        subprocess.run(args, check=True, stdout=subprocess.DEVNULL)
        if shipped and not keep_textures(ASSETS / f'{key}.glb', source, reports / 'maps'):
            print(key, 'textures re-encoded: the shipped ones could not be matched', flush=True)
        result = json.loads(report.read_text())
        bad = [clip for clip, e in result['clips'].items() if not e['ok']]
        if not result.get('look', {}).get('ok', True):
            bad.append('look')
        print(key, 'ok' if not bad else 'check ' + ', '.join(bad), flush=True)
        if bad:
            failed.append(key)
    if failed:
        print('For a spot check: python build.py', name, 'sheets', *failed)

def sheets(name, names):
    """Contact sheets, with the world's station prop at the builders' station clips."""
    _, spec, _ = world(name)
    out = ROOT / f'.cache/{name}-yard/sheets'
    out.mkdir(parents=True, exist_ok=True)
    prop = ASSETS / f'{name}_station.glb'
    for key, c in spec['cast'].items():
        if names and key not in names:
            continue
        extra = ['--prop', str(prop), str(spec['station']['surface']), str(GAP)] if c.get('work') and prop.exists() else []
        subprocess.run([BLENDER, '-b', '--factory-startup', '--python', str(HERE / 'sheet.py'), '--',
                        str(ASSETS / f'{key}.glb'), str(out / f'{key}.png'), *extra], check=True, stdout=subprocess.DEVNULL)
        print(out / f'{key}.png', flush=True)

def godot(name, names):
    """Import the shipped cast and station prop, un-quantized, into a scratch copy of godot/ and run check.gd."""
    _, spec, _ = world(name)
    keys = [k for k in [*spec['cast'], f'{name}_station'] if not names or k in names]
    project = ROOT / f'.cache/{name}-yard/godot'
    shutil.rmtree(project, ignore_errors=True)
    shutil.copytree(HERE / 'godot', project)
    (project / 'maps').mkdir()
    # Godot 4 does not import KHR_mesh_quantization, which the web copies use.
    subprocess.run(['node', str(ROOT / 'scripts/dequantize-yard.mjs'), str(project), *[str(ASSETS / f'{k}.glb') for k in keys]], check=True)
    for key in keys:
        for texture in (ASSETS / 'maps').glob(f'{key}-*'):
            shutil.copyfile(texture, project / 'maps' / texture.name)
    exe = os.environ.get('GODOT', 'godot')
    subprocess.run([exe, '--headless', '--import', '--path', str(project)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    result = subprocess.run([exe, '--headless', '--path', str(project), '--script', 'res://check.gd', '--', *[f'{k}.glb' for k in keys]],
                            capture_output=True, text=True)
    for line in result.stdout.splitlines():
        if line.startswith('YARD_GODOT'):
            print(line[11:], flush=True)
    if result.returncode:
        raise SystemExit('Godot found models that do not follow the contract.')

def halls(name):
    subprocess.run([BLENDER, '-b', '--factory-startup', '--python', str(HERE / 'halls.py'), '--', name], check=True)

def props(name):
    subprocess.run([BLENDER, '-b', '--factory-startup', '--python', str(HERE / 'props.py'), '--', name], check=True)

if __name__ == '__main__':
    name, step, names = sys.argv[1], sys.argv[2], sys.argv[3:]
    {'models': lambda: models(name, names), 'cast': lambda: cast(name, names), 'recast': lambda: cast(name, names, True),
     'sheets': lambda: sheets(name, names), 'godot': lambda: godot(name, names), 'halls': lambda: halls(name),
     'props': lambda: props(name)}[step]()
