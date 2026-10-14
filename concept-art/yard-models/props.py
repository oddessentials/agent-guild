"""Stand a world's station prop up for web/yard/assets/<world>_station.glb.

  blender -b --factory-startup --python props.py -- WORLD

The TRELLIS.2 model in .cache/<world>-yard/models/station.glb is stood on the
ground (y = 0), centred on its footprint and scaled so its working surface
stands at the height `station.surface` in concept-art/<world>-yard/world.json
gives (the working height for a 2 m figure); its front, which TRELLIS.2 turns
to -Y as the concept showed it, is the side the character works at. The
working surface is surface() below. A prop that would then be wider or deeper than
`station.footprint` is scaled down to fit, and the surface it ends at is
printed. The prop keeps the triangles and textures TRELLIS.2 made; textures
are written as WebP. It carries no skin or clips.
"""
import bpy, json, sys
import numpy as np
from pathlib import Path
from mathutils import Matrix, Vector

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
WORLD = sys.argv[sys.argv.index('--') + 1]
SPEC = json.loads((ROOT / f'concept-art/{WORLD}-yard/world.json').read_text(encoding='utf-8'))['station']
FOOTPRINT = SPEC.get('footprint', [1, .85])


def surface(obj):
    """Height of the highest upward-facing area at least a twentieth as large as
    the largest, above a fifth of the prop's height: an anvil's face over its
    stump, a lectern's top over its shelf."""
    co = np.array([v.co[:] for v in obj.data.vertices])
    lo, hi = co[:, 2].min(), co[:, 2].max()
    bins = np.zeros(100)
    for p in obj.data.polygons:
        if p.normal.z > .85 and p.center.z > lo + .2 * (hi - lo):
            bins[min(99, int((p.center.z - lo) / (hi - lo) * 100))] += p.area
    # Neighbouring bins together, so a flat top split by a seam still counts.
    area = np.convolve(bins, np.ones(3), mode='same')
    best = int(np.flatnonzero(area >= .05 * area.max()).max())
    return lo + (best + .5) / 100 * (hi - lo)


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(ROOT / f'.cache/{WORLD}-yard/models/station.glb'))
    parts = [o for o in bpy.data.objects if o.type == 'MESH']
    for o in bpy.data.objects:
        o.select_set(o in parts)
    bpy.context.view_layer.objects.active = parts[0]
    if len(parts) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.parent = None
    for o in [o for o in bpy.data.objects if o is not obj]:
        bpy.data.objects.remove(o)
    obj.data.transform(obj.matrix_world)
    obj.matrix_world = Matrix()
    co = np.array([v.co[:] for v in obj.data.vertices])
    lo, hi = co.min(0), co.max(0)
    obj.data.transform(Matrix.Translation(-Vector(((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]))))
    scale = SPEC['surface'] / surface(obj)
    size = (hi - lo)[:2] * scale
    fit = min(1, FOOTPRINT[0] / size[0], FOOTPRINT[1] / size[1])
    obj.data.transform(Matrix.Scale(scale * fit, 4))
    obj.data.update()
    obj.name = obj.data.name = WORLD + '_station'
    # The surface it ends at, for the renderer's WORLDS and the tests to match.
    obj['yard'] = {'surface': round(surface(obj), 3)}
    for i, m in enumerate(obj.data.materials):
        m.name = f'{WORLD}_station_{i}'
    bpy.ops.export_scene.gltf(filepath=str(ROOT / f'web/yard/assets/{WORLD}_station.glb'), export_format='GLB',
                              export_yup=True, export_lights=False, export_cameras=False, export_animations=False,
                              export_skins=False, export_extras=True, export_image_format='WEBP', export_image_quality=85)
    dims = obj.dimensions
    print('YARD_PROP %s surface %.3f m, %.2f x %.2f x %.2f m, %d triangles%s' % (
        WORLD, surface(obj), dims.x, dims.y, dims.z, sum(len(p.vertices) - 2 for p in obj.data.polygons),
        '' if fit == 1 else ', scaled %.2f to fit its footprint' % fit), flush=True)


main()
