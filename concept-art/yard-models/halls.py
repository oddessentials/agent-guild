"""Assemble web/yard/assets/<world>.glb from its TRELLIS.2 halls.

  blender -b --factory-startup --python halls.py -- WORLD

Each hall in .cache/<world>-yard/models/hall_<provider>.glb is stood on
the ground (y = 0), scaled to at most a FOOTPRINT metre footprint and HEIGHT
metres tall (times SIZE for an oversized hall), and turned by `turn` in concept-art/<world>-yard/world.json.
TRELLIS.2 squares a model to its axes with the concept's front facing -Y, so
unturned, the Yard camera sees the front and right side, as the concepts show
them. It is placed at its provider's anchor as `hall_<provider>`, as
concept-art/guild-yard/build.py places every world's halls. Warm window
texels become an emissive map, which the renderer brightens at dusk. Textures
are written as WebP.
"""
import bpy, json, math, sys
import numpy as np
from pathlib import Path
from mathutils import Vector, Matrix

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
WORLD = sys.argv[sys.argv.index('--') + 1]
MODELS = ROOT / f'.cache/{WORLD}-yard/models'
OUT = ROOT / f'web/yard/assets/{WORLD}.glb'
FOOTPRINT = 5.2
HEIGHT = 5.5
FACES = 35000  # triangles per hall; baked normals keep the fine detail
TEXTURE = 2048  # base colour; other maps are half this
# Blender positions, as concept-art/guild-yard/build.py's environment() places halls.
ANCHORS = [('anthropic', -7, 5), ('openai', 0, 7), ('google', 7, 5), ('xai', -8, -3), ('shell', 8, -3), ('docker', -10, -11)]
# Docker Agent arrived as an expansion, and its hall stands larger than the rest.
SIZE = {'docker': 1.3}
# Extra turn about the vertical, in degrees, for a hall whose best side is not its front.
TURN = json.loads((ROOT / f'concept-art/{WORLD}-yard/world.json').read_text(encoding='utf-8')).get('turn', {})

def emissive(image):
    """Bright, saturated texels: lit windows, lanterns and glowing trim."""
    w, h = image.size
    px = np.array(image.pixels[:], dtype=np.float32).reshape(h, w, 4)[..., :3]
    mx, mn = px.max(-1), px.min(-1)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    r, g, b = px[..., 0], px[..., 1], px[..., 2]
    warm = (r >= g) & (g >= b) & (g > r * .35)
    glow = warm * np.clip((mx - .62) / .2, 0, 1) * np.clip((sat - .4) / .25, 0, 1)
    # Cyan, violet and emerald provider glows count too.
    cool = ((b > r) & (mx > .6) & (sat > .45)) * np.clip((mx - .6) / .2, 0, 1)
    green = ((g > r * 1.3) & (g > b * 1.1) & (mx > .5) & (sat > .5)) * np.clip((mx - .5) / .2, 0, 1)
    mask = np.maximum(np.maximum(glow, cool), green)[..., None] * px
    out = bpy.data.images.new(image.name + '_glow', w, h)
    out.pixels[:] = np.concatenate([mask, np.ones((h, w, 1), np.float32)], -1).ravel()
    return out

def hall(provider):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(MODELS / f'hall_{provider}.glb'))
    parts = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
    for o in bpy.data.objects:
        o.select_set(o in parts)
    bpy.context.view_layer.objects.active = parts[0]
    if len(parts) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.parent = None
    for o in [o for o in bpy.data.objects if o not in before and o is not obj]:
        bpy.data.objects.remove(o)
    obj.data.transform(obj.matrix_world)
    obj.matrix_world = Matrix()
    co = np.array([v.co[:] for v in obj.data.vertices])
    lo, hi = co.min(0), co.max(0)
    # Tall halls hide the sessions standing behind them, so height is capped too.
    scale = SIZE.get(provider, 1) * min(FOOTPRINT / max(hi[0] - lo[0], hi[1] - lo[1]), HEIGHT / (hi[2] - lo[2]))
    centre = Vector(((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]))
    obj.data.transform(Matrix.Rotation(math.radians(TURN.get(provider, 0)), 4, 'Z') @ Matrix.Scale(scale, 4) @ Matrix.Translation(-centre))
    obj.name = obj.data.name = 'hall_' + provider
    mod = obj.modifiers.new('decimate', 'DECIMATE')
    mod.ratio = min(1, FACES / len(obj.data.polygons))
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier='decimate')
    for i, m in enumerate(obj.data.materials):
        m.name = f'hall_{provider}_{i}'
        bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
        link = bsdf.inputs['Base Color'].links
        if not link:
            continue
        base = link[0].from_node.image
        # Colour carries the detail; normal, roughness and occlusion read at half size.
        for node in m.node_tree.nodes:
            if node.type != 'TEX_IMAGE' or not node.image:
                continue
            size = TEXTURE if node.image is base else TEXTURE // 2
            if node.image.size[0] > size:
                node.image.scale(size, size)
        glow = m.node_tree.nodes.new('ShaderNodeTexImage')
        glow.image = emissive(base)
        uv = link[0].from_node.inputs['Vector'].links
        if uv:
            m.node_tree.links.new(uv[0].from_socket, glow.inputs['Vector'])
        m.node_tree.links.new(glow.outputs['Color'], bsdf.inputs['Emission Color'])
        bsdf.inputs['Emission Strength'].default_value = 1
    return obj

def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for provider, x, y in ANCHORS:
        hall(provider).location = (x, y, 0)
    bpy.ops.export_scene.gltf(filepath=str(OUT), export_format='GLB', export_yup=True, export_lights=False,
                              export_cameras=False, export_animations=False, export_image_format='WEBP',
                              export_image_quality=85)
    print('YARD_ASSET', WORLD, flush=True)

main()
