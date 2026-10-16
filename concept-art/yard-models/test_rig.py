"""blender -b --factory-startup --python test_rig.py"""
import bmesh, bpy, math, os, sys
import numpy as np
from mathutils import Matrix, Vector

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


def add_walled(build, inset):
    """A closed solid from `build`, with a copy `inset` inside it; vertex index ranges of both."""
    scene = bpy.context.scene.objects
    before = set(scene)
    build()
    piece = next(o for o in scene if o not in before)
    bm = bmesh.new(); bm.from_mesh(piece.data)
    outer = len(bm.verts)
    inner = bmesh.ops.duplicate(bm, geom=list(bm.verts) + list(bm.edges) + list(bm.faces))['geom']
    bm.normal_update()
    for v in (g for g in inner if isinstance(g, bmesh.types.BMVert)):
        v.co -= v.normal * inset
    bm.to_mesh(piece.data); bm.free()
    return piece, outer, len(piece.data.vertices)


def test_a_tail_and_a_slung_rods_walls_are_not_the_heads():
    body, outer = two_walled_figure()
    head = len(body.data.vertices)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=128, ring_count=64, radius=.2, location=(0, .75, 1.55))
    rod, rod_outer, rod_all = add_walled(lambda: bpy.ops.mesh.primitive_cube_add(size=1, location=(.2, .4, 1.3), scale=(.08, .08, 1.6)), .01)
    for o in bpy.context.scene.objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    co = np.array([v.co[:] for v in body.data.vertices])
    part = rig.head_part(body, 1.5, 2.05)
    up = co[:, 2] > 1.6
    index = np.arange(len(co))
    tail = (index >= head) & (np.linalg.norm(co - (0, .75, 1.55), axis=1) < .21)
    rod_inner = (index >= head) & ~tail & (np.abs(co[:, 0] - .2) < .038) & (np.abs(co[:, 1] - .4) < .038)
    assert part[up & (index < outer)].all(), 'the face is not the head'
    assert not part[tail].any(), 'the tail is the head'
    assert not part[up & rod_inner].any(), "the rod's hidden wall is the head"


def test_smoothing_keeps_a_uv_seam_shut():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=8, y_subdivisions=8, size=1)
    sheet = bpy.context.active_object
    bm = bmesh.new(); bm.from_mesh(sheet.data)
    bmesh.ops.split_edges(bm, edges=[e for e in bm.edges if all(abs(v.co.x) < 1e-6 for v in e.verts)])
    bm.to_mesh(sheet.data); bm.free()
    left, right = sheet.vertex_groups.new(name='Left'), sheet.vertex_groups.new(name='Right')
    for v in sheet.data.vertices:
        (left if v.co.x < 0 or (abs(v.co.x) < 1e-6 and v.index % 2) else right).add([v.index], 1, 'REPLACE')
    rig.smooth(sheet)
    weight = lambda v: [next((g.weight for g in v.groups if g.group == k), 0) for k in (0, 1)]
    seam = [v for v in sheet.data.vertices if abs(v.co.x) < 1e-6]
    twins = {}
    for v in seam:
        twins.setdefault(tuple(round(c, 5) for c in v.co), []).append(weight(v))
    assert all(len(w) == 2 and np.allclose(w[0], w[1]) for w in twins.values()), 'twins at a UV seam are weighted apart'


def cut_box(covered):
    """A closed 1 m box on one bone with a 4 cm slit cut down its front wall,
    as unfuse cuts; `covered` closes a larger box round it that is not cut."""
    import bmesh
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=24, use_grid_fill=True)
    if covered:
        outer = bmesh.new()
        bmesh.ops.create_cube(outer, size=1.2)
        mesh = bpy.data.meshes.new('outer'); outer.to_mesh(mesh); outer.free()
        bm.from_mesh(mesh)
    bmesh.ops.translate(bm, verts=bm.verts[:], vec=(0, 0, .6))
    bm.verts.ensure_lookup_table(); bm.faces.ensure_lookup_table()
    cut = [f for f in bm.faces if f.calc_center_median().y < -.49 and f.calc_center_median().y > -.51
           and abs(f.calc_center_median().x) < .02 and .3 < f.calc_center_median().z < .9]
    tris, sides = [], []
    for f in cut:
        vs = [v.index for v in f.verts]
        for i in range(1, len(vs) - 1):
            tris.append([vs[0], vs[i], vs[i + 1]])
            sides.append([bm.verts[k].co.x > 0 for k in (vs[0], vs[i], vs[i + 1])])
    bmesh.ops.delete(bm, geom=cut, context='FACES_ONLY')
    mesh = bpy.data.meshes.new('box'); bm.to_mesh(mesh); bm.free()
    body = bpy.data.objects.new('box', mesh); bpy.context.scene.collection.objects.link(body)
    data = bpy.data.armatures.new('rig')
    arm = bpy.data.objects.new('rig', data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    bone = data.edit_bones.new('Hips'); bone.head, bone.tail = (0, 0, .3), (0, 0, .6)
    bpy.ops.object.mode_set(mode='OBJECT')
    arm.animation_data_create()
    body.vertex_groups.new(name='Hips').add(range(len(mesh.vertices)), 1, 'REPLACE')
    body.modifiers.new('rig', 'ARMATURE').object = arm
    return arm, body, np.array(tris), np.array(sides)


def at_rest(arm):
    bpy.context.view_layer.update()
    yield


def test_a_slit_cut_in_sight_is_a_hole():
    arm, body, tris, sides = cut_box(covered=False)
    assert len(tris), 'the fixture cut nothing'
    assert rig.Holes(arm, body, tris, sides).open(at_rest(arm)) >= rig.HOLE, 'a slit cut in a wall in sight passes'


def test_a_cut_out_of_sight_is_not_a_hole():
    arm, body, tris, sides = cut_box(covered=True)
    assert len(tris), 'the fixture cut nothing'
    assert rig.Holes(arm, body, tris, sides).open(at_rest(arm)) == 0, 'a cut hidden inside another wall is a hole'


def test_a_gap_that_opens_only_in_motion_is_not_a_hole():
    """Two plates joined by a cut strip, hidden inside a closed box at rest,
    slide out of it apart: between them is the gap between two parts."""
    import bmesh
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1)
    box = len(bm.verts)
    bmesh.ops.create_grid(bm, x_segments=20, y_segments=10, size=.2)
    plate = [v for v in bm.verts[box:]]
    bmesh.ops.rotate(bm, verts=plate, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'X'))
    bm.verts.ensure_lookup_table(); bm.faces.ensure_lookup_table()
    cut = [f for f in bm.faces if all(v.index >= box for v in f.verts) and abs(f.calc_center_median().x) < .015]
    tris, sides = [], []
    for f in cut:
        vs = [v.index for v in f.verts]
        for i in range(1, len(vs) - 1):
            tris.append([vs[0], vs[i], vs[i + 1]])
            sides.append([bm.verts[k].co.x > 0 for k in (vs[0], vs[i], vs[i + 1])])
    bmesh.ops.delete(bm, geom=cut, context='FACES_ONLY')
    xs = [(v.index, v.co.x) for v in bm.verts]
    mesh = bpy.data.meshes.new('parts'); bm.to_mesh(mesh); bm.free()
    body = bpy.data.objects.new('parts', mesh); bpy.context.scene.collection.objects.link(body)
    data = bpy.data.armatures.new('rig')
    arm = bpy.data.objects.new('rig', data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    for name, x in (('Hips', 0), ('LeftHand', .1), ('RightHand', -.1)):
        bone = data.edit_bones.new(name); bone.head, bone.tail = (x, 0, 0), (x, 0, .1)
    bpy.ops.object.mode_set(mode='OBJECT')
    arm.animation_data_create()
    groups = {n: body.vertex_groups.new(name=n) for n in ('Hips', 'LeftHand', 'RightHand')}
    for i, x in xs:
        groups['Hips' if i < box else 'LeftHand' if x > 0 else 'RightHand'].add([i], 1, 'REPLACE')
    body.modifiers.new('rig', 'ARMATURE').object = arm
    holes = rig.Holes(arm, body, np.array(tris), np.array(sides))

    def apart():
        arm.pose.bones['RightHand'].location = arm.data.bones['RightHand'].matrix_local.to_3x3().inverted() @ Vector((-2, 0, 0))
        arm.pose.bones['LeftHand'].location = arm.data.bones['LeftHand'].matrix_local.to_3x3().inverted() @ Vector((2, 0, 0))
        bpy.context.view_layer.update()
        yield
    assert holes.open(apart()) == 0, 'the gap between two parts moved apart is a hole'


def test_cloth_across_the_legs_stays_whole_and_shut():
    """A closed skirt held by the left leg on one side of the centre line and
    the right on the other: unfuse keeps all of it and every place on its
    seam keeps one set of weights."""
    import bmesh
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=15, use_grid_fill=True)
    mesh = bpy.data.meshes.new('skirt'); bm.to_mesh(mesh); bm.free()
    body = bpy.data.objects.new('skirt', mesh); bpy.context.scene.collection.objects.link(body)
    groups = {n: body.vertex_groups.new(name=n) for n in ('Hips', 'LeftUpperLeg', 'RightUpperLeg')}
    for v in mesh.vertices:
        groups['LeftUpperLeg' if v.co.x > 1e-6 else 'RightUpperLeg'].add([v.index], 1, 'REPLACE')
    faces = len(mesh.polygons)
    rig.unfuse(body, robe=False)
    assert len(body.data.polygons) == faces, 'cloth across the legs was cut'
    at = {}
    for v in body.data.vertices:
        at.setdefault(tuple(round(c, 5) for c in v.co), []).append(sorted((g.group, round(g.weight, 4)) for g in v.groups))
    assert all(all(w == ws[0] for w in ws) for ws in at.values()), 'the seam opens: one place, two sets of weights'


def test_a_busy_hand_eases_into_the_leg_it_touches():
    """A strip whose left half is a busy hand and right half a thigh: no edge
    across the touch jumps from all hand to all leg."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=40, y_subdivisions=10, size=1, rotation=(math.pi / 2, 0, 0))
    strip = bpy.context.active_object
    bpy.ops.object.transform_apply(rotation=True)
    groups = {n: strip.vertex_groups.new(name=n) for n in ('Hips', 'LeftHand', 'LeftUpperLeg')}
    for v in strip.data.vertices:
        groups['LeftHand' if v.co.x < 0 else 'LeftUpperLeg'].add([v.index], 1, 'REPLACE')
    rig.ease_still_hands(strip, ('Left',))
    hand = groups['LeftHand'].index
    w = [next((g.weight for g in v.groups if g.group == hand), 0) for v in strip.data.vertices]
    jump = max(abs(w[e.vertices[0]] - w[e.vertices[1]]) for e in strip.data.edges)
    assert jump < .5, 'a busy hand meets the leg in one row of edges'


def test_a_moving_hands_bridge_to_the_hips_is_kept():
    """A strip whose left half is a free hand and right half the hips keeps
    every face: a cut would show as a slit, the stretch does not."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=20, y_subdivisions=6, size=1, rotation=(math.pi / 2, 0, 0))
    strip = bpy.context.active_object
    bpy.ops.object.transform_apply(rotation=True)
    groups = {n: strip.vertex_groups.new(name=n) for n in ('Hips', 'LeftHand', 'LeftUpperLeg')}
    for v in strip.data.vertices:
        groups['LeftHand' if v.co.x < 0 else 'Hips'].add([v.index], 1, 'REPLACE')
    faces = len(strip.data.polygons)
    cut = rig.unfuse(strip, robe=False)
    assert len(strip.data.polygons) == faces and not len(cut['cut']), 'the bridge from a moving hand to the hips was cut'


def test_coarse_surface_between_the_legs_is_not_cut():
    """A skirt whose centre faces are many times longer than the rest (a coarse
    body between the legs) keeps every face: it is ripped, not cut as a web."""
    import bmesh
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=15, use_grid_fill=True)
    for v in bm.verts:
        if abs(v.co.x) > 1e-6:
            v.co.x += .5 if v.co.x > 0 else -.5
    mesh = bpy.data.meshes.new('skirt'); bm.to_mesh(mesh); bm.free()
    body = bpy.data.objects.new('skirt', mesh); bpy.context.scene.collection.objects.link(body)
    groups = {n: body.vertex_groups.new(name=n) for n in ('Hips', 'LeftUpperLeg', 'RightUpperLeg')}
    for v in mesh.vertices:
        groups['LeftUpperLeg' if v.co.x > 1e-6 else 'RightUpperLeg'].add([v.index], 1, 'REPLACE')
    faces = len(mesh.polygons)
    rig.unfuse(body, robe=False)
    assert len(body.data.polygons) == faces, 'long faces between the legs were cut as a web'


def test_the_cast_rigs_on_one_thread():
    """build.py rigs with OpenMP on one thread: on more, bone heat's sums land a
    float step apart between runs and the same model exports different bytes."""
    import build
    assert build.BLENDER_ENV.get('OMP_NUM_THREADS') == '1'


def test_a_narrower_glance_turns_the_head_less():
    """look_poses turns a two-bone neck and head to the limits it is given,
    not the contract's."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    data = bpy.data.armatures.new('rig')
    arm = bpy.data.objects.new('rig', data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    neck = data.edit_bones.new('Neck'); neck.head, neck.tail = (0, 0, 1.5), (0, 0, 1.6)
    head = data.edit_bones.new('Head'); head.head, head.tail = (0, 0, 1.6), (0, 0, 1.9); head.parent = neck
    bpy.ops.object.mode_set(mode='OBJECT')
    arm.animation_data_create()
    def widest(**limits):
        turns = []
        for _ in rig.look_poses(arm, **limits):
            across = arm.pose.bones['Head'].matrix.to_3x3() @ Vector((1, 0, 0))
            turns.append(abs(math.atan2(across.y, across.x)))
        return max(turns)
    assert abs(widest(yaw=.3, pitch=.1) - .3) < 1e-3, 'a yaw limit of 0.3 is not honoured'
    assert abs(widest() - rig.LOOK_YAW) < 1e-3, 'the contract limit is not the default'


test_both_walls_of_the_head_are_the_heads()
test_a_narrower_glance_turns_the_head_less()
test_a_tail_and_a_slung_rods_walls_are_not_the_heads()
test_coarse_surface_between_the_legs_is_not_cut()
test_a_moving_hands_bridge_to_the_hips_is_kept()
test_the_cast_rigs_on_one_thread()
test_a_busy_hand_eases_into_the_leg_it_touches()
test_cloth_across_the_legs_stays_whole_and_shut()
test_a_gap_that_opens_only_in_motion_is_not_a_hole()
test_smoothing_keeps_a_uv_seam_shut()
test_a_slit_cut_in_sight_is_a_hole()
test_a_cut_out_of_sight_is_not_a_hole()
print('test_rig ok')
