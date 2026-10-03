"""The Yard's orthographic view, read from web/yard/model.mjs so renders and the
live scene cannot drift apart. glTF/three (x, y, z) is Blender (x, -z, y)."""
import json, subprocess
from functools import cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]

@cache
def view():
    script = ("import('./web/yard/model.mjs').then(m=>console.log(JSON.stringify("
              "{camera:m.CAMERA,basis:m.viewBasis(),extent:m.plateExtent()})))")
    out = subprocess.run(['node', '-e', script], cwd=ROOT, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)

def to_blender(v):
    from mathutils import Vector
    return Vector((v[0], -v[2], v[1]))

def ortho_camera(scene, name, center, width, height, distance=400):
    """A camera whose image spans `width` x `height` world units, centred on
    view-plane coordinates `center` = (right, up) as model.mjs defines them."""
    import bpy
    from mathutils import Matrix
    v = view()
    right, up, forward = (to_blender(v['basis'][k]) for k in ('right', 'up', 'forward'))
    position = right * center[0] + up * center[1] - forward * distance
    data = bpy.data.cameras.new(name)
    data.type = 'ORTHO'
    data.ortho_scale = max(width, height)
    data.sensor_fit = 'AUTO'
    data.clip_start, data.clip_end = .1, distance * 2
    cam = bpy.data.objects.new(name, data)
    rotation = Matrix((right, up, -forward)).transposed()
    cam.matrix_world = Matrix.Translation(position) @ rotation.to_4x4()
    scene.collection.objects.link(cam)
    scene.camera = cam
    scene.render.resolution_percentage = 100
    return cam, v
