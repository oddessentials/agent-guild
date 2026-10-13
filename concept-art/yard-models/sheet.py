"""Contact sheet of a rigged Yard model's clips, for spot checks.

  blender -b --factory-startup --python sheet.py -- IN.glb OUT.png [--frames N] [--size PX] [--clips a,b]

Each row is a clip, each column an evenly spaced moment in it, seen from the
Yard camera's direction. Walks are drawn in place.
"""
import bpy, sys, math, os, tempfile
from mathutils import Vector

a = sys.argv[sys.argv.index('--') + 1:]
src, out = a[0], a[1]
count = int(a[a.index('--frames') + 1]) if '--frames' in a else 6
size = int(a[a.index('--size') + 1]) if '--size' in a else 260
only = a[a.index('--clips') + 1].split(',') if '--clips' in a else None
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
for o in list(bpy.context.scene.objects):
    if o.name.startswith('Icosphere'):
        bpy.data.objects.remove(o)
rig = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE')
mesh = next(o for o in bpy.context.scene.objects if o.type == 'MESH')
height = max((mesh.matrix_world @ Vector(c)).z for c in mesh.bound_box)
sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE'
sc.render.resolution_x = sc.render.resolution_y = size
sc.render.film_transparent = True
world = bpy.data.worlds.new('w'); sc.world = world; world.use_nodes = True
world.node_tree.nodes['Background'].inputs[1].default_value = 2.5
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')); sc.collection.objects.link(sun)
sun.rotation_euler = (.8, .2, .6); sun.data.energy = 5
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
cam.data.type = 'ORTHO'; cam.data.ortho_scale = height * 1.25
# The Yard camera looks down from offset (19, 24, 31) in glTF, (19, -31, 24) here.
d = Vector((19, -31, 24)).normalized()
target = Vector((0, 0, height * .5))
cam.location = target + d * 20
cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
rig.animation_data_create()
actions = [x for x in bpy.data.actions if not only or x.name in only]
order = ['walk', 'idle_0', 'idle_1', 'idle_2', 'pause', 'work_0', 'work_1', 'done', 'idle', 'working', 'waiting', 'move']
actions.sort(key=lambda x: order.index(x.name) if x.name in order else 99)
tmp = tempfile.mkdtemp()
tiles = []
for action in actions:
    rig.animation_data.action = action
    start, end = action.frame_range
    for i in range(count):
        f = int(start + (end - start) * i / count)
        sc.frame_set(f)
        path = os.path.join(tmp, f'{action.name}-{i}.png')
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)
        tiles.append((action.name, i, path))
img = bpy.data.images.new('sheet', count * size, len(actions) * size, alpha=True)
pixels = [.78, .78, .78, 1] * (count * size * len(actions) * size)
for name, i, path in tiles:
    tile = bpy.data.images.load(path)
    row = len(actions) - 1 - [x.name for x in actions].index(name)
    tp = list(tile.pixels)
    for y in range(size):
        for x in range(size):
            k = (y * size + x) * 4
            alpha = tp[k + 3]
            if alpha <= 0:
                continue
            o = ((row * size + y) * count * size + i * size + x) * 4
            for ch in range(3):
                pixels[o + ch] = tp[k + ch] * alpha + pixels[o + ch] * (1 - alpha)
img.pixels = pixels
img.filepath_raw = out
img.file_format = 'PNG'
img.save()
print('YARD_SHEET', out, ','.join(x.name for x in actions), flush=True)
