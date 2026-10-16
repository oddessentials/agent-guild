"""blender -b --factory-startup --python test_rig.py"""
import bmesh, bpy, os, sys
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rig


def two_walled_figure():
    """A body and head as one closed wall, with a denser copy 1 cm inside."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.mesh.primitive_cylinder_add(radius=.25, depth=1.5, location=(0, 0, .75))
    bpy.ops.mesh.primitive_uv_sphere_add(radius=.3, location=(0, 0, 1.75))
    for o in bpy.context.scene.objects:
        o.select_set(True)
    bpy.ops.object.join()
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    body = bpy.context.active_object
    remesh = body.modifiers.new('remesh', 'REMESH')
    remesh.mode, remesh.voxel_size = 'VOXEL', .04
    bpy.ops.object.modifier_apply(modifier='remesh')
    bm = bmesh.new(); bm.from_mesh(body.data)
    outer = len(bm.verts)
    inner = bmesh.ops.duplicate(bm, geom=list(bm.verts) + list(bm.edges) + list(bm.faces))['geom']
    bm.normal_update()
    for v in (g for g in inner if isinstance(g, bmesh.types.BMVert)):
        v.co -= v.normal * .01
    bmesh.ops.subdivide_edges(bm, edges=[g for g in inner if isinstance(g, bmesh.types.BMEdge)], cuts=1, use_grid_fill=True)
    bm.to_mesh(body.data); bm.free()
    return body, outer


def test_both_walls_of_the_head_are_the_heads():
    body, outer = two_walled_figure()
    co = np.array([v.co[:] for v in body.data.vertices])
    part = rig.head_part(body, 1.5, 2.05)
    skull = co[:, 2] > 1.6
    walls = np.arange(len(co)) < outer
    assert part[skull & walls].all(), 'the visible wall is not the head'
    assert part[skull & ~walls].all(), 'the hidden wall is not the head'


test_both_walls_of_the_head_are_the_heads()
print('test_rig ok')
