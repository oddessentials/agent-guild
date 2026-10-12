"""Rig a generated character and give it the Yard's five clips.

  blender -b --factory-startup --python rig.py -- IN.glb OUT.glb HEIGHT [--kind builder|familiar]
      [--work tinker|conduct|steady|pound] [--faces N] [--texture PX] [--prop JSON]

The mesh is scaled to HEIGHT metres, stood on the ground facing -Y (glTF +Z,
toward the Yard camera), and fitted with a skeleton whose joints come from its
own silhouette: shoulders from the chest's width, hands from the lowest point
of each arm, hips and knees from the legs. Weights are Blender's bone heat.
A held tool (`--prop`) is cut out first so it cannot pass for an arm, then
follows one hand rigidly; `pound` lifts and drops it, held upright.
Clips are 72 frames at 24 fps (`arrival` grows in over 18), keyed per bone as
rotations about world axes so every character moves the same way.
The mesh is decimated to --faces triangles and textures are written as
--texture px WebP (25,000 and 1024 by default).
"""
import bpy, json, math, sys
from mathutils import Vector, Quaternion, Matrix

CLIPS = ('resting', 'working', 'waiting', 'done', 'arrival')

def load(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = 24
    bpy.ops.import_scene.gltf(filepath=path)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    for o in bpy.context.scene.objects:
        o.select_set(o in meshes)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    body = bpy.context.view_layer.objects.active
    bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for o in list(bpy.context.scene.objects):
        if o is not body:
            bpy.data.objects.remove(o)
    body.name = body.data.name = 'character'
    return body

def decimate(body, faces):
    """Collapse to about `faces` triangles; baked normals keep the fine detail."""
    count = len(body.data.polygons)
    if count <= faces:
        return
    mod = body.modifiers.new('decimate', 'DECIMATE')
    mod.ratio = faces / count
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.modifier_apply(modifier='decimate')

def normalise(body, height):
    co = [v.co for v in body.data.vertices]
    lo = Vector([min(c[i] for c in co) for i in range(3)])
    hi = Vector([max(c[i] for c in co) for i in range(3)])
    scale = height / (hi.z - lo.z)
    centre = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    body.data.transform(Matrix.Scale(scale, 4) @ Matrix.Translation(-centre))
    body.data.update()

def cut_prop(body, spec):
    """Separate the prop: the loose part ranked `part` by size (0 is the body,
    with UV seams welded), or the faces whose centres fall in any of `boxes`."""
    import bmesh
    bm = bmesh.new(); bm.from_mesh(body.data); bm.verts.ensure_lookup_table()
    if 'part' in spec:
        root = list(range(len(bm.verts)))
        def find(i):
            while root[i] != i:
                root[i] = root[root[i]]; i = root[i]
            return i
        def join(a, b):
            root[find(a)] = find(b)
        for e in bm.edges:
            join(e.verts[0].index, e.verts[1].index)
        at = {}
        for v in bm.verts:
            join(v.index, at.setdefault(tuple(round(x, 3) for x in v.co), v.index))
        groups = {}
        for v in bm.verts:
            groups.setdefault(find(v.index), set()).add(v.index)
        chosen = sorted(groups.values(), key=len, reverse=True)[spec['part']]
        picked = [f for f in bm.faces if f.verts[0].index in chosen]
    else:
        inside = lambda c: any(all(lo[i] <= c[i] <= hi[i] for i in range(3)) for lo, hi in spec['boxes'])
        picked = [f for f in bm.faces if inside(f.calc_center_median())]
    for element in (*bm.verts, *bm.edges, *bm.faces):
        element.select_set(False)
    for f in picked:
        f.select_set(True)
    bm.to_mesh(body.data); bm.free()
    bpy.ops.object.select_all(action='DESELECT')
    body.select_set(True); bpy.context.view_layer.objects.active = body
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.separate(type='SELECTED')
    bpy.ops.object.mode_set(mode='OBJECT')
    prop = next(o for o in bpy.context.selected_objects if o is not body)
    print('YARD_PROP faces %d' % len(prop.data.polygons), flush=True)
    return prop

def plant(prop, j, side):
    """Stand a tool on its head beside the foot with its handle up through the
    fist, the head's long side across the body."""
    import numpy as np
    co = np.array([v.co for v in prop.data.vertices])
    centre = co.mean(0)
    axis = np.linalg.eigh(np.cov((co - centre).T))[1][:, -1]
    t = (co - centre) @ axis
    spread = lambda m: np.linalg.norm(co[m] - centre - np.outer(t[m], axis), axis=1).mean()
    if spread(t < 0) > spread(t > 0):  # the head is the wider end
        axis, t = -axis, -t
    head = co[t > t.max() - .25 * (t.max() - t.min())]
    flat = (head - head.mean(0)) - np.outer((head - head.mean(0)) @ axis, axis)
    across = np.linalg.eigh(np.cov(flat.T))[1][:, -1]
    down = Vector(axis).normalized()
    side_axis = (Vector(across) - Vector(across).project(down)).normalized()
    frame = Matrix((side_axis, down.cross(side_axis), down)).transposed()  # columns: local x, y, z
    rotate = (Matrix((X, -Y, -Z)).transposed() @ frame.inverted()).to_4x4()
    prop.data.transform(rotate @ Matrix.Translation(-Vector(centre)))
    grip = (j['wrist' + side] + j['hand' + side]) / 2
    low = min(v.co.z for v in prop.data.vertices)
    prop.data.transform(Matrix.Translation(Vector((grip.x, grip.y, -low))))
    prop.data.update()

def bind_prop(body, prop, side):
    """Join the prop back on, wholly weighted to one hand."""
    group = prop.vertex_groups.new(name='hand' + side)
    group.add(range(len(prop.data.vertices)), 1, 'REPLACE')
    bpy.ops.object.select_all(action='DESELECT')
    prop.select_set(True); body.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()

def slices(body, h0, h1):
    return [v.co for v in body.data.vertices if h0 <= v.co.z < h1]

def joints(body, height, kind):
    """Joint positions from the silhouette, as fractions of height where the
    silhouette cannot say."""
    h = height
    chest = slices(body, .66 * h, .74 * h)
    width = max(abs(c.x) for c in chest)
    hips = slices(body, .40 * h, .50 * h)
    # Arms are what stands outside the torso below the shoulders.
    torso = sorted(abs(c.x) for c in hips)[int(len(hips) * .5)] if hips else width * .5
    j = {'root': Vector((0, 0, 0)), 'hips': Vector((0, 0, .50 * h)), 'spine': Vector((0, 0, .58 * h)),
         'chest': Vector((0, 0, .68 * h)), 'neck': Vector((0, 0, .80 * h)), 'head': Vector((0, 0, .84 * h)),
         'top': Vector((0, 0, h))}
    if kind == 'familiar':
        return j
    for side, name in ((1, 'L'), (-1, 'R')):
        arm = [c for c in body.data.vertices if side * c.co.x > torso * 1.05 and .2 * h < c.co.z < .66 * h]
        arm = [v.co for v in arm]
        if len(arm) < 50:
            arm = [c for c in slices(body, .25 * h, .6 * h) if side * c.x > torso * .8]
        low = sorted(arm, key=lambda c: c.z)[:max(20, len(arm) // 12)]
        hand = sum(low, Vector()) / len(low)
        hand.z += .03 * h
        shoulder = Vector((side * width * .72, 0, .74 * h))
        elbow = (shoulder + hand) / 2 + Vector((side * .02 * h, .04 * h, 0))
        j['shoulder' + name], j['elbow' + name], j['wrist' + name] = shoulder, elbow, hand
        j['hand' + name] = hand + (hand - elbow).normalized() * .07 * h
        x = side * max(torso * .45, .06 * h)
        j['hip' + name] = Vector((x, 0, .48 * h))
        j['knee' + name] = Vector((x, -.02 * h, .26 * h))
        j['ankle' + name] = Vector((x, .01 * h, .06 * h))
        j['toe' + name] = Vector((x, -.09 * h, .02 * h))
    return j

def skeleton(j, kind):
    bones = [('root', 'root', Vector((0, 0, .15)) + j['root'], None),
             ('hips', 'hips', 'spine', 'root'), ('spine', 'spine', 'chest', 'hips'),
             ('chest', 'chest', 'neck', 'spine'), ('neck', 'neck', 'head', 'chest'), ('head', 'head', 'top', 'neck')]
    if kind != 'familiar':
        for s in 'LR':
            bones += [('upperArm' + s, 'shoulder' + s, 'elbow' + s, 'chest'), ('foreArm' + s, 'elbow' + s, 'wrist' + s, 'upperArm' + s),
                      ('hand' + s, 'wrist' + s, 'hand' + s, 'foreArm' + s), ('thigh' + s, 'hip' + s, 'knee' + s, 'hips'),
                      ('shin' + s, 'knee' + s, 'ankle' + s, 'thigh' + s), ('foot' + s, 'ankle' + s, 'toe' + s, 'shin' + s)]
    data = bpy.data.armatures.new('rig')
    rig = bpy.data.objects.new('rig', data)
    bpy.context.scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    for name, a, b, parent in bones:
        bone = data.edit_bones.new(name)
        bone.head = j[a] if isinstance(a, str) else a
        bone.tail = j[b] if isinstance(b, str) else b
        if parent:
            bone.parent = data.edit_bones[parent]
            bone.use_connect = False
    bpy.ops.object.mode_set(mode='OBJECT')
    return rig

def weights(body, rig):
    """Bone heat on a closed voxel proxy, copied to the real mesh by nearest
    surface, so open or self-intersecting generated geometry still weights.
    Bone heat needs a clean enough solid: finer proxies are tried first."""
    for div in (90, 70, 55, 45, 35):
        proxy = body.copy()
        proxy.data = body.data.copy()
        bpy.context.scene.collection.objects.link(proxy)
        mod = proxy.modifiers.new('remesh', 'REMESH')
        mod.mode, mod.voxel_size = 'VOXEL', max(proxy.dimensions) / div
        bpy.context.view_layer.objects.active = proxy
        bpy.ops.object.modifier_apply(modifier='remesh')
        bpy.ops.object.select_all(action='DESELECT')
        proxy.select_set(True); rig.select_set(True)
        bpy.context.view_layer.objects.active = rig
        bpy.ops.object.parent_set(type='ARMATURE_AUTO')
        weighted = {g.group for v in proxy.data.vertices for g in v.groups if g.weight > .01}
        if len(weighted) >= len(rig.data.bones) - 1:  # every bone but root
            break
        bpy.data.objects.remove(proxy)
    else:
        raise SystemExit('Bone heat found no solution for ' + body.name)
    print('YARD_WEIGHTS proxy 1/%d' % div, flush=True)
    for bone in rig.data.bones:
        body.vertex_groups.new(name=bone.name)
    transfer = body.modifiers.new('weights', 'DATA_TRANSFER')
    transfer.object = proxy
    transfer.use_vert_data, transfer.data_types_verts = True, {'VGROUP_WEIGHTS'}
    transfer.vert_mapping = 'POLYINTERP_NEAREST'
    transfer.layers_vgroup_select_src, transfer.layers_vgroup_select_dst = 'ALL', 'NAME'
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.modifier_apply(modifier='weights')
    bpy.data.objects.remove(proxy)
    bpy.ops.object.select_all(action='DESELECT')
    body.select_set(True); rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type='ARMATURE_NAME')  # keeps the transferred groups
    body.vertex_groups.active_index = 0
    bpy.ops.object.mode_set(mode='OBJECT')
    # Anything the proxy missed follows its nearest bone.
    from mathutils.geometry import intersect_point_line
    segments = [(b.name, b.head_local, b.tail_local) for b in rig.data.bones if b.name != 'root']
    for v in body.data.vertices:
        if not any(g.weight > .01 for g in v.groups):
            def gap(seg):
                point, t = intersect_point_line(v.co, seg[1], seg[2])
                return (v.co - (seg[1] if t < 0 else seg[2] if t > 1 else point)).length
            body.vertex_groups[min(segments, key=gap)[0]].add([v.index], 1, 'REPLACE')
    # Normalise and limit to four influences for glTF.
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)

X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))

def turn(rig, name, axis, angle):
    """Rotate a pose bone about a world axis, composed onto what it has."""
    pb = rig.pose.bones.get(name)
    if not pb:
        return
    local = rig.data.bones[name].matrix_local.to_3x3().inverted() @ axis
    pb.rotation_quaternion = Quaternion(local, angle) @ pb.rotation_quaternion

def lift(rig, height):
    """Raise the whole figure by `height` metres."""
    root = rig.data.bones['root']
    rig.pose.bones['root'].location = root.matrix_local.to_3x3().inverted() @ Vector((0, 0, height))

def creature(rig, clip, t, f):
    """Familiars and helpers: a body that bobs, sways and looks about."""
    s = math.sin(t)
    turn(rig, 'spine', Y, .04 * s)
    turn(rig, 'head', Z, .1 * math.sin(t + .9))
    if clip == 'resting':
        rig.pose.bones['chest'].scale = (1 + .02 * s, 1, 1 + .02 * s)
    elif clip == 'working':
        lift(rig, .06 * abs(math.sin(2 * t)))
        turn(rig, 'chest', X, .12 * math.sin(4 * t)); turn(rig, 'head', X, .15 * math.sin(4 * t + 1))
    elif clip == 'waiting':
        turn(rig, 'head', Z, .5 * math.sin(t / 2))
    elif clip == 'done':
        turn(rig, 'spine', X, .15); turn(rig, 'head', X, .3)
    elif clip == 'arrival':
        rig.pose.bones['root'].scale = (min(1, .05 + f / 18),) * 3

def strike(t):
    """Two blows a loop: a slow lift, a fast drop, then a jolt on impact."""
    u = t / math.pi % 1
    if u < .62:
        lift = (1 - math.cos(math.pi * u / .62)) / 2
    elif u < .70:
        lift = 1
    elif u < .78:
        lift = 1 - ((u - .70) / .08) ** 2
    else:
        lift = 0
    return lift, math.exp(-((u - .80) / .05) ** 2)

def pose(rig, clip, t, f, work, hand='L'):
    s, c = math.sin(t), math.cos(t)
    for pb in rig.pose.bones:
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = Quaternion()
        pb.location = (0, 0, 0)
        pb.scale = (1, 1, 1)
    if 'upperArmL' not in rig.pose.bones:
        return creature(rig, clip, t, f)
    # Breathing and weight shifts under everything.
    turn(rig, 'chest', X, -.02 * s)
    turn(rig, 'spine', Y, .015 * c)
    turn(rig, 'head', Z, .05 * math.sin(t + .7))
    turn(rig, 'upperArmL', Y, .03 * s); turn(rig, 'upperArmR', Y, -.03 * s)
    turn(rig, 'head', Y, .03 * s)
    if clip == 'working':
        k = math.sin(2 * t)
        turn(rig, 'spine', X, .12); turn(rig, 'head', X, .18)
        if work == 'steady':  # hands stay put: they hold a staff or sit in pockets
            turn(rig, 'spine', X, .06 * k); turn(rig, 'head', X, .12 * math.sin(2 * t + .6))
            turn(rig, 'chest', Z, .06 * s); turn(rig, 'head', Z, .1 * s)
        elif work == 'pound':  # one hand lifts and drops a tool, keeping it upright
            lift, jolt = strike(t)
            other = 'R' if hand == 'L' else 'L'
            raise_arm, bend = -.2 - .6 * lift, -.6 * lift
            turn(rig, 'spine', X, -.12 - .08 * lift + .1 * jolt); turn(rig, 'head', X, .06 * jolt - .06 * lift)
            turn(rig, 'upperArm' + hand, X, raise_arm); turn(rig, 'foreArm' + hand, X, bend)
            turn(rig, 'hand' + hand, X, -raise_arm - bend)
            turn(rig, 'upperArm' + other, X, -.25 - .1 * lift); turn(rig, 'foreArm' + other, X, -.5)
            turn(rig, 'chest', Z, (.08 if hand == 'L' else -.08) * lift)
        elif work == 'conduct':
            turn(rig, 'upperArmL', X, -.7 - .25 * k); turn(rig, 'upperArmL', Y, .25 * s)
            turn(rig, 'foreArmL', X, -.5); turn(rig, 'upperArmR', X, -.35 + .2 * math.sin(2 * t + 1))
            turn(rig, 'head', Z, .12 * s)
        else:  # tinker: both hands busy in front
            turn(rig, 'upperArmL', X, -.55 - .15 * k); turn(rig, 'foreArmL', X, -.9 + .25 * k)
            turn(rig, 'upperArmR', X, -.55 + .15 * k); turn(rig, 'foreArmR', X, -.9 - .25 * k)
            turn(rig, 'upperArmL', Z, -.15); turn(rig, 'upperArmR', Z, .15)
        turn(rig, 'hips', Z, .03 * k)
    elif clip == 'waiting':
        turn(rig, 'head', Z, .35 * math.sin(t / 2)); turn(rig, 'head', X, -.05)
        if work not in ('steady', 'pound'):
            turn(rig, 'upperArmL', X, -.25); turn(rig, 'foreArmL', X, -.6)
        turn(rig, 'hips', Y, .03 * math.sin(t / 2))
    elif clip == 'done':
        turn(rig, 'spine', X, .1); turn(rig, 'chest', X, .08); turn(rig, 'head', X, .28)
        turn(rig, 'upperArmL', Y, -.06); turn(rig, 'upperArmR', Y, .06)
    elif clip == 'arrival':
        rig.pose.bones['root'].scale = (min(1, .05 + f / 18),) * 3

def animate(rig, work, hand):
    rig.animation_data_create()
    # Every frame: a blow drops in about three of them.
    step = 1 if work == 'pound' else 4
    for clip in CLIPS:
        action = bpy.data.actions.new(clip)
        action.use_fake_user = True
        rig.animation_data.action = action
        for f in range(0, 73, step):
            pose(rig, clip, f / 72 * 2 * math.pi, f, work, hand)
            for pb in rig.pose.bones:
                pb.keyframe_insert('rotation_quaternion', frame=f, group=pb.name)
                pb.keyframe_insert('location', frame=f, group=pb.name)
                pb.keyframe_insert('scale', frame=f, group=pb.name)
    rig.animation_data.action = None
    for pb in rig.pose.bones:
        pb.rotation_quaternion = Quaternion(); pb.scale = (1, 1, 1)

def shrink_textures(size):
    for img in bpy.data.images:
        if img.size[0] > size:
            img.scale(size, size)

def export(path):
    bpy.context.scene.frame_set(0)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_animations=True,
                              export_animation_mode='ACTIONS', export_force_sampling=True,
                              export_frame_range=False, export_yup=True, export_lights=False,
                              export_cameras=False, export_image_format='WEBP', export_image_quality=85)
    print('YARD_RIGGED', path, flush=True)

def main():
    a = sys.argv[sys.argv.index('--') + 1:]
    src, out, height = a[0], a[1], float(a[2])
    kind = a[a.index('--kind') + 1] if '--kind' in a else 'builder'
    work = a[a.index('--work') + 1] if '--work' in a else 'tinker'
    faces = int(a[a.index('--faces') + 1]) if '--faces' in a else 25000
    texture = int(a[a.index('--texture') + 1]) if '--texture' in a else 1024
    spec = json.loads(a[a.index('--prop') + 1]) if '--prop' in a else None
    hand = spec.get('hand', 'L') if spec else 'L'
    body = load(src)
    decimate(body, faces)
    normalise(body, height)
    prop = cut_prop(body, spec) if spec else None
    j = joints(body, height, kind)
    rig = skeleton(j, kind)
    weights(body, rig)
    if prop:
        if spec.get('plant'):
            plant(prop, j, hand)
        bind_prop(body, prop, hand)
    animate(rig, work, hand)
    shrink_textures(texture)
    export(out)

if __name__ == '__main__':
    main()
