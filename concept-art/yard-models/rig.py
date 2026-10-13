"""Rig a Yard character or helper to the shared skeleton and author its clips
(docs/yard/CONTRACT.md).

  blender -b --factory-startup --python rig.py -- IN.glb OUT.glb HEIGHT [--kind builder|familiar]
      [--work tinker|conduct|steady|pound] [--gait walk|waddle|glide] [--robe] [--busy L|R]
      [--faces N] [--texture PX] [--prop JSON] [--report FILE]

IN is a generated TRELLIS.2 model, or a shipped Yard model. A shipped model's
old skeleton and clips are removed, and a held tool is found again as the loose
part that was wholly weighted to one hand.

The mesh is scaled to HEIGHT metres, stood on the ground facing -Y (glTF +Z,
toward the Yard camera), and fitted with the contract skeleton, named after
Godot's humanoid profile, at joints taken from its own silhouette: shoulders
from the chest's width, hands from the lowest point of each arm, hips and knees
from the legs. Weights are Blender's bone heat. A held tool (`--prop`) is cut
out first so it cannot pass for an arm, then rides a PropLeft or PropRight
socket bone in that hand. `--robe` lets the middle of a robe hang from the
hips; `--busy` names a hand holding something modelled in, which gestures
leave alone.

Clips are posed in Python and baked to keys, at 24 fps. Legs are solved with
two-bone IK, so planted feet stay put while the hips sway and the walk's
stance foot moves back at exactly the speed the character walks; the stride
and cycle are written into the model as `yard` extras for the runtime. Work
clips that strike something record the moment and place as `events`.
The mesh is decimated to --faces triangles and textures are written as
--texture px WebP (25,000 and 1024 by default). --report writes the automated
checks: foot sliding, joint stretch and how far a held tool strays from its hand.
"""
import bpy, json, math, sys
import numpy as np
from mathutils import Vector, Quaternion, Matrix

FPS = 24
X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
SIDES = (('L', 'Left', 1), ('R', 'Right', -1))
# Walk: one cycle is two steps; each foot is planted for STANCE of it.
WALK_FRAMES, STANCE = 32, .62
# Step length per gait, as a share of height. Small round characters waddle;
# those with no legs to speak of (a robed pair, a crab) glide.
STEPS = {'walk': .3, 'waddle': .16, 'glide': .24}


def load(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = FPS
    bpy.ops.import_scene.gltf(filepath=path)
    shipped = any(o.type == 'ARMATURE' for o in bpy.context.scene.objects)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH' and not o.name.startswith('Icosphere')]
    for o in meshes:
        for mod in list(o.modifiers):
            if mod.type == 'ARMATURE':
                o.modifiers.remove(mod)
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
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)
    body.name = body.data.name = 'character'
    return body, shipped


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


def loose_parts(bm):
    """Vertex index sets of each loose part, with UV seams welded."""
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
    return sorted(groups.values(), key=len, reverse=True)


def separate(body, picked):
    import bmesh
    bm = bmesh.new(); bm.from_mesh(body.data); bm.faces.ensure_lookup_table()
    for element in (*bm.verts, *bm.edges, *bm.faces):
        element.select_set(False)
    for i in picked:
        bm.faces[i].select_set(True)
    bm.to_mesh(body.data); bm.free()
    bpy.ops.object.select_all(action='DESELECT')
    body.select_set(True); bpy.context.view_layer.objects.active = body
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.separate(type='SELECTED')
    bpy.ops.object.mode_set(mode='OBJECT')
    prop = next(o for o in bpy.context.selected_objects if o is not body)
    print('YARD_PROP faces %d' % len(prop.data.polygons), flush=True)
    return prop


def cut_prop(body, spec):
    """Separate the prop: the loose part ranked `part` by size (0 is the body),
    or the faces whose centres fall in any of `boxes`."""
    import bmesh
    bm = bmesh.new(); bm.from_mesh(body.data); bm.verts.ensure_lookup_table()
    if 'part' in spec:
        chosen = loose_parts(bm)[spec['part']]
        picked = [f.index for f in bm.faces if f.verts[0].index in chosen]
    else:
        inside = lambda c: any(all(lo[i] <= c[i] <= hi[i] for i in range(3)) for lo, hi in spec['boxes'])
        picked = [f.index for f in bm.faces if inside(f.calc_center_median())]
    bm.free()
    return separate(body, picked)


def shipped_prop(body):
    """A shipped model's tool: the loose parts that were wholly one hand's."""
    import bmesh
    hands = {g.index: g.name for g in body.vertex_groups if g.name in ('handL', 'handR')}
    if not hands:
        return None, None
    held = {}
    for v in body.data.vertices:
        for g in v.groups:
            if g.group in hands and g.weight > .99:
                held[v.index] = hands[g.group]
    bm = bmesh.new(); bm.from_mesh(body.data); bm.verts.ensure_lookup_table()
    parts = [p for p in loose_parts(bm)[1:] if all(i in held for i in p)]
    if not parts:
        bm.free()
        return None, None
    side = held[next(iter(parts[0]))][-1]
    chosen = set().union(*parts)
    picked = [f.index for f in bm.faces if f.verts[0].index in chosen]
    bm.free()
    return separate(body, picked), side


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
    j = {'root': Vector((0, 0, 0)), 'hips': Vector((0, 0, .50 * h)), 'spine': Vector((0, 0, .57 * h)),
         'chest': Vector((0, 0, .64 * h)), 'upperChest': Vector((0, 0, .71 * h)), 'neck': Vector((0, 0, .80 * h)),
         'head': Vector((0, 0, .84 * h)), 'top': Vector((0, 0, h))}
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
        j['clavicle' + name] = Vector((side * width * .16, 0, .75 * h))
        j['shoulder' + name], j['elbow' + name], j['wrist' + name] = shoulder, elbow, hand
        j['hand' + name] = hand + (hand - elbow).normalized() * .07 * h
        x = side * max(torso * .45, .06 * h)
        j['hip' + name] = Vector((x, 0, .48 * h))
        j['knee' + name] = Vector((x, -.02 * h, .26 * h))
        j['ankle' + name] = Vector((x, .01 * h, .06 * h))
        j['ball' + name] = Vector((x, -.07 * h, .025 * h))
        j['toe' + name] = Vector((x, -.11 * h, .02 * h))
    return j


def skeleton(j, kind):
    """The contract skeleton: Godot's humanoid profile names, plus a prop
    socket per hand. Helpers carry its trunk only."""
    bones = [('Root', 'root', Vector((0, 0, .15)) + j['root'], None),
             ('Hips', 'hips', 'spine', 'Root'), ('Spine', 'spine', 'chest', 'Hips'), ('Chest', 'chest', 'upperChest', 'Spine'),
             ('UpperChest', 'upperChest', 'neck', 'Chest'), ('Neck', 'neck', 'head', 'UpperChest'), ('Head', 'head', 'top', 'Neck')]
    if kind != 'familiar':
        for s, side, _ in SIDES:
            bones += [(side + 'Shoulder', 'clavicle' + s, 'shoulder' + s, 'UpperChest'),
                      (side + 'UpperArm', 'shoulder' + s, 'elbow' + s, side + 'Shoulder'),
                      (side + 'LowerArm', 'elbow' + s, 'wrist' + s, side + 'UpperArm'),
                      (side + 'Hand', 'wrist' + s, 'hand' + s, side + 'LowerArm'),
                      ('Prop' + side, 'wrist' + s, 'hand' + s, side + 'Hand'),
                      (side + 'UpperLeg', 'hip' + s, 'knee' + s, 'Hips'),
                      (side + 'LowerLeg', 'knee' + s, 'ankle' + s, side + 'UpperLeg'),
                      (side + 'Foot', 'ankle' + s, 'ball' + s, side + 'LowerLeg'),
                      (side + 'Toes', 'ball' + s, 'toe' + s, side + 'Foot')]
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


def weights(body, rig, robe=False):
    """Bone heat on a closed voxel proxy, copied to the real mesh by nearest
    surface, so open or self-intersecting generated geometry still weights.
    Bone heat needs a clean enough solid: finer proxies are tried first.
    Prop sockets carry only their tool, so they take no part."""
    sockets = [b for b in rig.data.bones if b.name.startswith('Prop')]
    for b in sockets:
        b.use_deform = False
    best = None
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
        weighted = {proxy.vertex_groups[g.group].name for v in proxy.data.vertices for g in v.groups if g.weight > .01}
        # Short bones (toes, collarbones, the upper chest, the neck) may find
        # nothing on a coarse proxy; their neighbours carry the skin there.
        # The limbs, hips and head must all be found.
        key = [b.name for b in rig.data.bones if b.use_deform and b.name in ('Hips', 'Head') or
               any(b.name.endswith(k) for k in ('UpperArm', 'LowerArm', 'UpperLeg', 'LowerLeg'))]
        found = sum(n in weighted for n in key)
        if found == len(key):
            if best:
                bpy.data.objects.remove(best[2])
            break
        # Keep the best proxy so far: a limb bone heat missed then moves with
        # its neighbours instead of failing the whole model.
        if best and best[0] >= found:
            bpy.data.objects.remove(proxy)
        else:
            if best:
                bpy.data.objects.remove(best[2])
            best = (found, div, proxy)
        proxy = None
    if proxy is None:
        if not best or not best[0]:
            raise SystemExit('Bone heat found no solution for ' + body.name)
        _, div, proxy = best
        bpy.ops.object.select_all(action='DESELECT')
    for b in sockets:
        b.use_deform = True
    print('YARD_WEIGHTS proxy 1/%d' % div, flush=True)
    for bone in rig.data.bones:
        if bone.name not in body.vertex_groups:
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
    segments = [(b.name, b.head_local, b.tail_local) for b in rig.data.bones if b.name != 'Root' and not b.name.startswith('Prop')]
    for v in body.data.vertices:
        if not any(g.weight > .01 for g in v.groups):
            def gap(seg):
                point, t = intersect_point_line(v.co, seg[1], seg[2])
                return (v.co - (seg[1] if t < 0 else seg[2] if t > 1 else point)).length
            body.vertex_groups[min(segments, key=gap)[0]].add([v.index], 1, 'REPLACE')
    keep_arms_to_arms(body, rig)
    smooth(body)
    split_legs(body, rig, robe)
    # Normalise and limit to four influences for glTF.
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)
    if 'LeftUpperArm' in rig.data.bones:
        unfuse(body, robe)


def keep_arms_to_arms(body, rig):
    """Bone heat lets a hand that hangs beside a robe or coat claim the cloth
    around it, which tears when the arm lifts. Arm bones keep only what lies
    near the arm and not below the hand; the rest goes to the hips."""
    from mathutils.geometry import intersect_point_line
    if 'LeftUpperArm' not in rig.data.bones:
        return
    h = max(v.co.z for v in body.data.vertices)
    hips = body.vertex_groups['Hips']
    for side in ('Left', 'Right'):
        names = [side + n for n in ('UpperArm', 'LowerArm', 'Hand')]
        bones = [rig.data.bones[n] for n in names]
        groups = {body.vertex_groups[n].index: body.vertex_groups[n] for n in names}
        low = bones[2].tail_local.z - .04 * h
        for v in body.data.vertices:
            moved = 0.0
            for g in list(v.groups):
                if g.group not in groups or g.weight <= 0:
                    continue
                near = min((v.co - (lambda r: r[0] if 0 <= r[1] <= 1 else (b.head_local if r[1] < 0 else b.tail_local))(
                    intersect_point_line(v.co, b.head_local, b.tail_local))).length for b in bones)
                if v.co.z < low or near > .09 * h:
                    moved += g.weight
                    groups[g.group].remove([v.index])
            if moved:
                hips.add([v.index], moved, 'ADD')


def split_legs(body, rig, robe):
    """Below the crotch each leg owns its own side. Trousers then part
    cleanly in a stride instead of tearing at the inseam. A robe or skirt,
    which joins the legs, lets its middle follow the hips instead."""
    if 'LeftUpperLeg' not in rig.data.bones:
        return
    h = max(v.co.z for v in body.data.vertices)
    crotch = rig.data.bones['LeftUpperLeg'].head_local.z - .05 * h
    hip_x = abs(rig.data.bones['LeftUpperLeg'].head_local.x)
    groups = {g.name: g for g in body.vertex_groups}
    legs = [n for n in groups if any(n.endswith(k) for k in ('UpperLeg', 'LowerLeg', 'Foot', 'Toes'))]
    index = {groups[n].index: n for n in legs}
    for v in body.data.vertices:
        if v.co.z > crotch:
            continue
        own = 'Left' if v.co.x > 0 else 'Right'
        for g in list(v.groups):
            name = index.get(g.group)
            if not name or g.weight <= 0:
                continue
            w = g.weight
            if robe:
                # A robe hangs mostly from the hips, its middle wholly.
                share = .6 + .35 * max(0, 1 - abs(v.co.x) / hip_x)
                groups[name].add([v.index], w * (1 - share), 'REPLACE')
                groups['Hips'].add([v.index], w * share, 'ADD')
            elif not name.startswith(own):
                groups[name].remove([v.index])
                twin = own + name[len('Right' if name.startswith('Right') else 'Left'):]
                groups[twin].add([v.index], w, 'ADD')


def unfuse(body, robe):
    """Generated models often fuse a hanging hand to the thigh, or one leg to
    the other, with a skin of triangles that tears once the limb moves. Cut
    those bridges: the faces joining a forearm or hand to the hips or a leg,
    and, unless a robe joins them by design, the left leg to the right.
    Where they met, the limbs touched, so the cut is out of sight."""
    import bmesh
    groups = {g.index: g.name for g in body.vertex_groups}
    def owner(v):
        best = max(v.groups, key=lambda g: g.weight, default=None)
        return groups.get(best.group, '') if best else ''
    owners = [owner(v) for v in body.data.vertices]
    arm = lambda n: n.endswith('LowerArm') or n.endswith('Hand')
    low = lambda n: n == 'Hips' or n.endswith('UpperLeg') or n.endswith('LowerLeg')
    leg = lambda n: n.endswith('UpperLeg') or n.endswith('LowerLeg') or n.endswith('Foot')
    bm = bmesh.new(); bm.from_mesh(body.data); bm.faces.ensure_lookup_table()
    cut = []
    for f in bm.faces:
        names = {owners[v.index] for v in f.verts}
        if any(arm(n) for n in names) and any(low(n) for n in names):
            cut.append(f)
        elif not robe and any(leg(n) and n.startswith('Left') for n in names) and any(leg(n) and n.startswith('Right') for n in names):
            cut.append(f)
    bmesh.ops.delete(bm, geom=cut, context='FACES_ONLY')
    bm.to_mesh(body.data); bm.free(); body.data.update()
    print('YARD_UNFUSE faces %d' % len(cut), flush=True)


def smooth(body):
    """A few passes of weight smoothing soften the seams bone heat leaves at
    the shoulders and hips, so a raised arm or a stride bends the cloth around
    the joint instead of creasing it."""
    bpy.ops.object.select_all(action='DESELECT')
    body.select_set(True); bpy.context.view_layer.objects.active = body
    bpy.ops.object.mode_set(mode='WEIGHT_PAINT')
    bpy.ops.object.vertex_group_smooth(group_select_mode='ALL', factor=.5, repeat=6, expand=0)
    bpy.ops.object.mode_set(mode='OBJECT')


def bind_prop(body, prop, side):
    """Join the prop back on, wholly weighted to its hand's socket."""
    for g in list(prop.vertex_groups):
        prop.vertex_groups.remove(g)
    group = prop.vertex_groups.new(name='Prop' + {'L': 'Left', 'R': 'Right'}[side])
    group.add(range(len(prop.data.vertices)), 1, 'REPLACE')
    bpy.ops.object.select_all(action='DESELECT')
    prop.select_set(True); body.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()


# ---------------------------------------------------------------- posing

class Pose:
    """One frame's pose, built in a fixed order: trunk rotations, hips offset,
    arms, then legs by IK and props last."""

    def __init__(self, rig, reach=1.0):
        # reach scales how far the arms move from rest: animate() lowers it
        # for a clip that tears the model at full reach.
        self.rig, self.reach = rig, reach
        for pb in rig.pose.bones:
            pb.rotation_mode = 'QUATERNION'
            pb.rotation_quaternion = Quaternion()
            pb.location = (0, 0, 0)
            pb.scale = (1, 1, 1)

    def has(self, name):
        return name in self.rig.pose.bones

    def turn(self, name, axis, angle):
        """Rotate a bone about a world axis, composed onto what it has."""
        pb = self.rig.pose.bones.get(name)
        if not pb or not angle:
            return
        if name.endswith(('Arm', 'Hand', 'Shoulder')):
            angle *= self.reach
        local = self.rig.data.bones[name].matrix_local.to_3x3().inverted() @ axis
        pb.rotation_quaternion = Quaternion(local, angle) @ pb.rotation_quaternion

    def shift(self, name, offset):
        """Move a bone by a world-space offset (its parent at rest)."""
        pb = self.rig.pose.bones[name]
        pb.location = self.rig.data.bones[name].matrix_local.to_3x3().inverted() @ Vector(offset)

    def update(self):
        bpy.context.view_layer.update()

    def aim(self, name, point):
        """Point a bone's length at `point` with the least twist from rest."""
        self.update()
        pb, bone = self.rig.pose.bones[name], self.rig.data.bones[name]
        head = pb.head.copy()
        rest = bone.matrix_local.to_3x3()
        want = (point - head)
        if want.length < 1e-6:
            return
        q = (rest @ Y).rotation_difference(want.normalized())
        pb.matrix = Matrix.Translation(head) @ (q.to_matrix() @ rest).to_4x4()

    def orient(self, name, rotation):
        """Give a bone its rest orientation turned by `rotation`, where it stands."""
        self.update()
        pb, bone = self.rig.pose.bones[name], self.rig.data.bones[name]
        head = pb.head.copy()
        pb.matrix = Matrix.Translation(head) @ (rotation.to_matrix() @ bone.matrix_local.to_3x3()).to_4x4()

    def leg(self, side, ankle, pitch=0.0, toe=0.0):
        """Two-bone IK: put the ankle at `ankle`, knee forward, foot flat but
        for `pitch` (heel up when positive) and `toe` bend."""
        upper, lower = side + 'UpperLeg', side + 'LowerLeg'
        b1, b2 = self.rig.data.bones[upper], self.rig.data.bones[lower]
        self.update()
        hip = self.rig.pose.bones[upper].head.copy()
        a, b = b1.length, b2.length
        to = ankle - hip
        d = max(abs(a - b) + 1e-4, min(a + b - 1e-4, to.length))
        direction = to.normalized()
        cos_a = (a * a + d * d - b * b) / (2 * a * d)
        pole = Vector((0, -1, .15))
        n = (pole - direction * pole.dot(direction)).normalized()
        knee = hip + direction * (a * cos_a) + n * (a * math.sqrt(max(0, 1 - cos_a * cos_a)))
        self.aim(upper, knee)
        self.aim(lower, hip + direction * d)
        self.orient(side + 'Foot', Quaternion(X, pitch))
        if toe:
            self.rig.pose.bones[side + 'Toes'].rotation_quaternion = Quaternion(
                self.rig.data.bones[side + 'Toes'].matrix_local.to_3x3().inverted() @ X, -toe)

    def arm(self, side, wrist, pole=Vector((0, .3, -1))):
        """Two-bone IK for an arm: wrist at `wrist`, elbow toward `pole`."""
        upper, lower = side + 'UpperArm', side + 'LowerArm'
        b1, b2 = self.rig.data.bones[upper], self.rig.data.bones[lower]
        rest = self.rig.data.bones[side + 'Hand'].head_local
        wrist = rest + (wrist - rest) * self.reach
        self.update()
        sh = self.rig.pose.bones[upper].head.copy()
        # A hand raised above the shoulder lifts the collarbone with it,
        # spreading the bend over the shoulder instead of one crease.
        rise = (wrist - sh).normalized().dot(Z) + .2
        if rise > 0:
            self.turn(side + 'Shoulder', Y, -(1 if side == 'Left' else -1) * .32 * min(1.2, rise))
            self.update()
            sh = self.rig.pose.bones[upper].head.copy()
        a, b = b1.length, b2.length
        to = wrist - sh
        d = max(abs(a - b) + 1e-4, min(a + b - 1e-4, to.length))
        direction = to.normalized()
        cos_a = (a * a + d * d - b * b) / (2 * a * d)
        n = (pole - direction * pole.dot(direction)).normalized()
        elbow = sh + direction * (a * cos_a) + n * (a * math.sqrt(max(0, 1 - cos_a * cos_a)))
        self.aim(upper, elbow)
        self.aim(lower, sh + direction * d)


# Timing helpers: every clip is a loop of phase u in [0, 1).
def ease(t):
    t = min(1, max(0, t))
    return t * t * (3 - 2 * t)


def wave(u, k=1, phase=0.0):
    return math.sin(2 * math.pi * (k * u + phase))


def keys(u, points):
    """Smoothly interpolate (u, value) points around the loop."""
    points = sorted(points)
    for (u0, v0), (u1, v1) in zip(points, points[1:] + [(points[0][0] + 1, points[0][1])]):
        uu = u if u >= u0 else u + 1
        if u0 <= uu < u1:
            return v0 + (v1 - v0) * ease((uu - u0) / (u1 - u0))
    return points[0][1]


class Character:
    """Rest measurements a clip poses against."""

    def __init__(self, rig, height, work, prop_side, busy=None, gait='walk', robe=False):
        self.rig, self.h, self.work, self.prop, self.gait = rig, height, work, prop_side, gait
        # The hand that holds something, a tool socket's or one modelled in.
        self.busy = {'L': 'Left', 'R': 'Right'}[prop_side] if prop_side else busy
        self.free = 'Left' if self.busy == 'Right' else 'Right'
        bones = rig.data.bones
        self.humanoid = 'LeftUpperLeg' in bones
        if self.humanoid:
            self.ankle = {s: bones[s + 'Foot'].head_local.copy() for _, s, _ in SIDES}
            self.wrist = {s: bones[s + 'Hand'].head_local.copy() for _, s, _ in SIDES}
            self.shoulder = {s: bones[s + 'UpperArm'].head_local.copy() for _, s, _ in SIDES}
            self.leg = bones['LeftUpperLeg'].length + bones['LeftLowerLeg'].length
        # A long robe shortens the stride.
        self.step = STEPS[gait] * height * (.75 if robe and gait == 'walk' else 1)
        self.cycle = WALK_FRAMES / FPS
        self.speed = 2 * self.step / self.cycle
        self.events = []

    def breathe(self, p, u, k=1, amount=1.0):
        p.turn('Chest', X, -.025 * amount * wave(u, k))
        p.turn('UpperChest', X, -.015 * amount * wave(u, k, .1))
        p.turn('LeftShoulder', Y, .02 * amount * wave(u, k, .15))
        p.turn('RightShoulder', Y, -.02 * amount * wave(u, k, .15))

    def plant(self, p, sway=0.0):
        """Both feet where they stand at rest, whatever the hips do."""
        for _, s, _ in SIDES:
            p.leg(s, self.ankle[s].copy())

    def hang(self, p, u, k=1, amount=1.0, lag=.06):
        """Arms hang and follow the body a beat late."""
        for _, s, sign in SIDES:
            p.turn(s + 'UpperArm', X, .03 * amount * wave(u, k, lag))
            p.turn(s + 'UpperArm', Y, sign * .025 * amount * wave(u, k, lag + .25))
            p.turn(s + 'LowerArm', X, -.06 - .03 * amount * wave(u, k, lag * 2))


# ---------------------------------------------------------------- clips

def clip_walk(c, p, u):
    """Contact, down, passing, up: hips lowest just after each heel strike and
    highest passing, swaying over the planted foot; shoulders counter the hips
    and arms swing against the legs, the forearms a beat behind."""
    h, D = c.h, c.speed * STANCE * c.cycle
    if c.gait == 'glide':
        return clip_glide(c, p, u)
    waddle = c.gait == 'waddle'
    bob = (.012 if waddle else .018) * h
    p.shift('Hips', ((.03 if waddle else .012) * h * wave(u, 1, 0), 0, -bob * math.cos(4 * math.pi * (u - .06))))
    p.turn('Hips', Z, .07 * wave(u, 1, .25))
    # A waddle rolls the whole body over each foot.
    p.turn('Hips', Y, (.11 if waddle else .025) * wave(u, 1, 0))
    if waddle:
        p.turn('Chest', Y, -.05 * wave(u, 1, .05))
    p.turn('Spine', X, .05)
    p.turn('Chest', Z, -.09 * wave(u, 1, .25))
    p.turn('Neck', Z, .05 * wave(u, 1, .25))
    p.turn('Head', X, -.03 + .02 * math.cos(4 * math.pi * (u - .1)))
    swing = .4 if c.work not in ('steady',) else .18
    for _, s, sign in SIDES:
        held = s == c.busy
        amount = swing * (.35 if held else 1)
        # The left arm swings forward as the right foot does (at u = .5).
        forward = wave(u, 1, .25 if s == 'Left' else -.25)
        p.turn(s + 'UpperArm', X, amount * forward)
        p.turn(s + 'UpperArm', Y, -sign * .06)
        p.turn(s + 'LowerArm', X, -.2 - .18 * max(0, -wave(u, 1, (.25 if s == 'Left' else -.25) - .06)))
    p.turn('LeftShoulder', X, .03 * wave(u, 1, .25)); p.turn('RightShoulder', X, -.03 * wave(u, 1, .25))
    if c.work == 'pound' and c.prop:
        # A sledge rides on the shoulder, handle forward, head behind.
        side = {'L': 'Left', 'R': 'Right'}[c.prop]
        sign = 1 if side == 'Left' else -1
        bounce = .01 * h * math.cos(4 * math.pi * (u - .1))
        p.arm(side, c.shoulder[side] + Vector((-sign * .02 * h, -.14 * h, -.1 * h + bounce)), Vector((sign * .5, .2, -1)))
        p.turn('Prop' + side, X, 2.5)
    for _, s, _ in SIDES:
        # Left heel strikes at u = 0, right at u = .5.
        q = (u - (0 if s == 'Left' else .5)) % 1
        rest = c.ankle[s]
        if q < STANCE:
            t = q / STANCE
            y = rest.y - D / 2 + D * t
            z = rest.z
            pitch = .25 * max(0, (t - .75) / .25) ** 2 - .15 * max(0, 1 - t / .15)
            toe = .4 * max(0, (t - .8) / .2)
        else:
            t = (q - STANCE) / (1 - STANCE)
            e = ease(t)
            y = rest.y + D / 2 - D * e
            z = rest.z + (.035 if waddle else .07) * h * math.sin(math.pi * t) ** 1.4
            pitch = .3 * (1 - t) ** 2 - .2 * max(0, (t - .7) / .3)
            toe = .2 * (1 - t)
        p.leg(s, Vector((rest.x, y, z)), pitch, toe)


def clip_glide(c, p, u):
    """Moving without steps: a float and lean into the direction of travel,
    the trunk swaying a beat behind, hems and arms trailing."""
    h = c.h
    p.shift('Hips', (.006 * h * wave(u, 1), 0, .02 * h * wave(u, 2, .1)))
    p.turn('Spine', X, .07); p.turn('Chest', X, .03 * wave(u, 2, .2))
    p.turn('Hips', Z, .04 * wave(u, 1, .25)); p.turn('Chest', Z, -.05 * wave(u, 1, .3))
    p.turn('Head', X, -.04 + .02 * wave(u, 2, .3))
    for _, s, sign in SIDES:
        p.turn(s + 'UpperArm', X, .12 + .04 * wave(u, 2, .35))
        p.turn(s + 'LowerArm', X, -.15)
    c.plant(p)


def clip_idle_0(c, p, u):
    """Standing easy: breathing, a slow weight shift from foot to foot with the
    knees taking it, a glance round."""
    h = c.h
    shift = keys(u, [(0, -1), (.2, -1), (.5, 1), (.7, 1)])
    p.shift('Hips', (.02 * h * shift, 0, -.006 * h * (1 - abs(shift))))
    p.turn('Hips', Y, -.03 * shift)
    p.turn('Spine', Y, .03 * shift)
    c.breathe(p, u, 3)
    look = keys(u, [(0, 0), (.3, 0), (.42, .35), (.62, .35), (.75, -.1), (.9, 0)])
    p.turn('Neck', Z, .4 * look); p.turn('Head', Z, .6 * look)
    p.turn('Head', X, .03 * wave(u, 2))
    c.hang(p, u, 3)
    c.plant(p)


def clip_idle_1(c, p, u):
    """A long look round: the head leads, the shoulders follow, then the other
    way, each turn with a small lead-in and a settle."""
    h = c.h
    turn = keys(u, [(0, 0), (.08, -.06), (.25, .55), (.42, .5), (.5, .52), (.58, -.08), (.75, -.5), (.88, -.45), (.95, 0)])
    lag = keys((u - .04) % 1, [(0, 0), (.08, -.06), (.25, .55), (.42, .5), (.5, .52), (.58, -.08), (.75, -.5), (.88, -.45), (.95, 0)])
    p.turn('Hips', Z, .08 * lag)
    p.turn('Spine', Z, .12 * lag); p.turn('Chest', Z, .15 * lag)
    p.turn('Neck', Z, .3 * turn); p.turn('Head', Z, .45 * turn)
    p.turn('Head', X, -.06 * abs(turn))
    p.shift('Hips', (-.012 * h * lag, 0, 0))
    c.breathe(p, u, 4)
    c.hang(p, u, 4, 1.4)
    for _, s, sign in SIDES:
        p.turn(s + 'UpperArm', Z, .1 * lag)
    c.plant(p)


def clip_idle_2(c, p, u):
    """Chatting: one hand comes up to make a point twice, the head nods with it,
    the weight goes onto the back foot to listen."""
    h = c.h
    side = c.free
    sign = 1 if side == 'Left' else -1
    up = keys(u, [(0, 0), (.1, 0), (.2, 1), (.32, .8), (.38, 1), (.5, .85), (.6, 0)])
    beat = up * wave(u, 6) * .5 + .5 * up
    p.turn(side + 'UpperArm', X, -.55 * up)
    p.turn(side + 'UpperArm', Y, sign * .2 * up)
    p.turn(side + 'LowerArm', X, -1.0 * up - .15 * beat)
    p.turn(side + 'Hand', Z, sign * .4 * up * wave(u, 3))
    nod = keys(u, [(0, 0), (.22, .1), (.3, -.04), (.4, .08), (.5, 0), (.7, .06), (.8, 0)])
    p.turn('Head', X, .2 * nod)
    p.turn('Head', Y, sign * .08 * up)
    lean = keys(u, [(0, 0), (.15, .4), (.55, .4), (.7, -.5), (.9, -.5)])
    p.turn('Spine', X, .04 * lean)
    p.shift('Hips', (0, .012 * h * lean, -.004 * h * abs(lean)))
    c.breathe(p, u, 4)
    other = 'Left' if side == 'Right' else 'Right'
    p.turn(other + 'UpperArm', X, .03 * wave(u, 2, .2))
    p.turn(other + 'LowerArm', X, -.08)
    c.plant(p)


def clip_pause(c, p, u):
    """Quiet at the station: weight back, looking over the work, a hand rising
    to the chin to think, a slow nod."""
    h = c.h
    side = c.free
    sign = 1 if side == 'Left' else -1
    think = keys(u, [(0, .2), (.15, 1), (.65, 1), (.8, .2)])
    p.turn('Spine', X, .06 + .03 * think); p.turn('Head', X, .14 + .06 * think)
    p.turn('Head', Z, sign * .12 * wave(u, 1, .3))
    wrist = c.shoulder[side] + Vector((-sign * .1 * h, -.16 * h, -.06 * h))
    rest = c.wrist[side]
    target = rest.lerp(wrist, think)
    p.arm(side, target, Vector((sign * .6, .4, -1)))
    p.turn(side + 'Hand', X, -.8 * think)
    c.breathe(p, u, 3)
    other = 'Left' if side == 'Right' else 'Right'
    p.turn(other + 'UpperArm', X, -.15 * think); p.turn(other + 'LowerArm', X, -.6 * think)
    p.shift('Hips', (0, .01 * h, -.004 * h * think))
    c.plant(p)


def clip_done(c, p, u):
    """Winding down: a long breath out, shoulders dropping, head low, knees soft."""
    h = c.h
    sigh = keys(u, [(0, 0), (.25, 1), (.4, 1), (.75, .6)])
    p.shift('Hips', (0, .01 * h, -.02 * h - .01 * h * sigh))
    p.turn('Spine', X, .12 + .04 * sigh); p.turn('Chest', X, .1 + .04 * sigh)
    p.turn('Neck', X, .15); p.turn('Head', X, .25 + .08 * sigh)
    for _, s, sign in SIDES:
        p.turn(s + 'Shoulder', X, .06 * sigh)
        p.turn(s + 'UpperArm', Y, -sign * .05)
        p.turn(s + 'LowerArm', X, -.12)
    c.breathe(p, u, 2, 1.6)
    c.plant(p)


def work_tinker(c, p, u, variant):
    """Both hands busy at the bench in front: alternate twists and taps with the
    body bobbing into each; the variant lifts the piece to look at it closely."""
    h = c.h
    p.turn('Spine', X, .12); p.turn('Chest', X, .06); p.turn('Head', X, .22)
    if variant == 0:
        for _, s, sign in SIDES:
            if s == c.busy and not c.prop:
                continue
            k = 1 if s == 'Left' else -1
            reach = c.shoulder[s] + Vector((-sign * .07 * h, -.2 * h, -.2 * h))
            reach += Vector((sign * .02 * h * wave(u, 2, .25 * k), -.02 * h * wave(u, 4, .1 * k), .03 * h * max(0, wave(u, 4, .25 * k))))
            p.arm(s, reach, Vector((sign * .8, .3, -1)))
            p.turn(s + 'Hand', Z, sign * .35 * wave(u, 4, .25 * k))
        p.shift('Hips', (.008 * h * wave(u, 2), 0, -.008 * h * abs(wave(u, 4))))
        p.turn('Head', Z, .08 * wave(u, 1))
    else:
        lift = keys(u, [(0, 0), (.15, 0), (.3, 1), (.7, 1), (.85, 0)])
        turn = lift * wave(u, 1.5, .1)
        for _, s, sign in SIDES:
            if s == c.busy and not c.prop:
                continue
            low = c.shoulder[s] + Vector((-sign * .08 * h, -.2 * h, -.2 * h))
            high = Vector((sign * .04 * h, c.shoulder[s].y - .2 * h, c.shoulder[s].z + .02 * h))
            p.arm(s, low.lerp(high, lift), Vector((sign * .9, .2, -1)))
            p.turn(s + 'Hand', Z, sign * .4 * turn)
        p.turn('Head', X, -.2 * lift); p.turn('Head', Z, .15 * turn)
        p.turn('Spine', X, -.07 * lift)
    c.breathe(p, u, 2, .7)
    c.plant(p)


def work_conduct(c, p, u, variant):
    """Directing the work: one arm sweeps out and points, the other on the hip;
    the variant opens both arms, then points again."""
    h = c.h
    side = c.free
    sign = 1 if side == 'Left' else -1
    other = 'Left' if side == 'Right' else 'Right'
    if variant == 0:
        sweep = keys(u, [(0, -.6), (.2, .7), (.3, .6), (.5, -.2), (.65, .9), (.8, .9), (.9, -.6)])
        lift = keys(u, [(0, .3), (.25, .8), (.45, .5), (.7, 1), (.85, .9)])
        reach = c.shoulder[side] + Vector((sign * .25 * h * (.5 + .5 * sweep), -.3 * h, .02 * h + .12 * h * lift - .1 * h))
        p.arm(side, reach, Vector((1, .5, -.6)))
        p.turn('Chest', Z, sign * .2 * sweep); p.turn('Head', Z, sign * .3 * sweep); p.turn('Neck', Z, sign * .1 * sweep)
        jab = max(0, wave(u, 4)) ** 4
        p.turn(side + 'Hand', X, -.4 * jab)
        p.turn('Head', X, .08 - .06 * jab)
        if c.busy != other:
            # A free hand rests on the hip.
            p.arm(other, c.wrist[other] + Vector((sign * .06 * h, .02 * h, .12 * h)), Vector((-sign, .6, 0)))
    else:
        open_ = keys(u, [(0, 0), (.1, -.15), (.3, 1), (.55, 1), (.7, 0)])
        for _, s, sg in SIDES:
            if s == c.busy:
                continue
            out = c.shoulder[s] + Vector((sg * .3 * h, -.18 * h, -.12 * h))
            p.arm(s, c.wrist[s].lerp(out, max(0, open_)), Vector((sg, .4, -1)))
        point = keys(u, [(0, 0), (.6, 0), (.75, 1), (.92, 1)])
        p.arm(side, (c.wrist[side].lerp(c.shoulder[side] + Vector((sign * .3 * h, -.18 * h, -.12 * h)), max(0, open_))).lerp(
            c.shoulder[side] + Vector((sign * .06 * h, -.4 * h, .04 * h)), point), Vector((sign, .4, -.6)))
        p.turn('Spine', X, -.05 * open_ + .06 * point); p.turn('Head', X, -.08 * open_)
    p.shift('Hips', (-.01 * h, 0, 0))
    c.breathe(p, u, 2, .8)
    c.plant(p)


def work_steady(c, p, u, variant):
    """Holding steady (a staff, or hands at rest): focus shows in the trunk and
    head, small corrections and nods; the variant raises a hand, holds it as
    if casting, and lets it fall."""
    h = c.h
    p.turn('Spine', X, .07); p.turn('Head', X, .16)
    if variant == 0:
        p.turn('Spine', X, .05 * wave(u, 2)); p.turn('Head', X, .1 * wave(u, 2, .15))
        p.turn('Chest', Z, .07 * wave(u, 1)); p.turn('Head', Z, .12 * wave(u, 1, .1))
        p.shift('Hips', (.012 * h * wave(u, 1, .3), 0, -.006 * h * abs(wave(u, 2))))
        c.hang(p, u, 2, 1.5)
    else:
        side = c.free
        sign = 1 if side == 'Left' else -1
        raise_ = keys(u, [(0, 0), (.12, -.1), (.3, 1), (.62, 1), (.78, 0)])
        high = c.shoulder[side] + Vector((sign * .05 * h, -.22 * h, .12 * h))
        p.arm(side, c.wrist[side].lerp(high, max(0, raise_)), Vector((sign, .3, -.8)))
        p.turn(side + 'Hand', X, -.5 * max(0, raise_))
        p.turn('Spine', X, -.08 * raise_); p.turn('Head', X, -.2 * raise_)
        hold = max(0, raise_) * wave(u, 6)
        p.turn('Chest', Z, .03 * hold)
        p.shift('Hips', (0, .01 * h * raise_, -.008 * h * abs(raise_)))
    c.breathe(p, u, 2, .8)
    c.plant(p)


def work_pound(c, p, u, variant):
    """A sledge swung overhead: wind up behind the shoulder with the weight back,
    a held beat, the fast drop with the knees taking the blow, the jolt of
    impact, then the lift back to the start. The variant rests the hammer,
    wipes a brow and checks the work."""
    h, side = c.h, {'L': 'Left', 'R': 'Right'}[c.prop or 'L']
    sign = 1 if side == 'Left' else -1
    other = 'Right' if side == 'Left' else 'Left'
    if variant == 0:
        # Two blows a loop. `a` is the hand's angle about the shoulder from
        # straight down, forward positive: low in front at the blow, high
        # behind the head at the top of the swing.
        v = (u * 2) % 1
        a = keys(v, [(0, .75), (.08, .62), (.42, 2.85), (.5, 2.95), (.6, .5), (.66, .58), (.82, .82)])
        up = max(0, (a - .75) / 2.2)
        drop = max(0, (.75 - a) / .25)
        jolt = math.exp(-((v - .6) / .035) ** 2)
        shoulder = c.shoulder[side]
        r = .85 * (c.wrist[side] - shoulder).length
        hand = shoulder + Vector((-sign * .12 * h, -r * math.sin(a), -r * math.cos(a)))
        p.turn('Spine', X, .2 * drop + .1 * jolt - .14 * up)
        p.turn('Chest', X, .1 * drop - .1 * up)
        p.turn('Chest', Z, sign * .2 * up)
        p.turn('Head', X, .1 * drop - .14 * up + .06 * jolt)
        p.shift('Hips', (sign * .01 * h * up, .025 * h * up, -.03 * h * drop - .015 * h * jolt))
        p.arm(side, hand, Vector((sign * .8, .25, -.6)))
        p.turn('Prop' + side, X, .7 * up - .35 * drop)
        # The other hand takes the handle below the first.
        p.update()
        p.arm(other, rig_point(p.rig, 'Prop' + side, Vector((0, .1 * h, 0))), Vector((-sign * .8, .25, -.7)))
    else:
        wipe = keys(u, [(0, 0), (.15, 0), (.3, 1), (.45, 1), (.55, 0)])
        look = keys(u, [(0, 0), (.55, 0), (.7, 1), (.9, 1)])
        brow = Vector((-sign * .03 * h, c.shoulder[other].y - .1 * h, .86 * h))
        p.arm(other, c.wrist[other].lerp(brow, wipe), Vector((-sign, .2, -.6)))
        p.turn(other + 'Hand', Z, -sign * .6 * wipe * wave(u, 4))
        p.turn('Head', X, -.12 * wipe + .25 * look); p.turn('Spine', X, .12 * look)
        p.turn('Head', Z, .12 * look * wave(u, 1.5))
        c.breathe(p, u, 2, 1.4)
    c.plant(p)


def rig_point(rig, bone, offset):
    pb = rig.pose.bones[bone]
    return (pb.matrix @ Matrix.Translation(offset)).translation.copy()


WORK = {'tinker': work_tinker, 'conduct': work_conduct, 'steady': work_steady, 'pound': work_pound}

# Helpers: no legs, so their life is in the trunk and head.
def creature(c, p, u, clip):
    s = wave(u)
    h = c.h
    p.turn('Spine', Y, .04 * s)
    p.turn('Head', Z, .12 * wave(u, 1, .2))
    if clip == 'idle':
        p.shift('Hips', (0, 0, .015 * h * wave(u, 2)))
        p.turn('Chest', X, -.03 * wave(u, 2, .1)); p.turn('Head', X, .05 * wave(u, 2, .2))
    elif clip == 'working':
        hop = abs(wave(u, 2))
        p.shift('Hips', (0, 0, .07 * h * hop))
        p.turn('Chest', X, .14 * wave(u, 4)); p.turn('Head', X, .16 * wave(u, 4, .12))
        p.turn('Spine', Z, .08 * wave(u, 2, .25))
    elif clip == 'waiting':
        look = keys(u, [(0, 0), (.2, .7), (.45, .7), (.6, -.7), (.85, -.7)])
        p.turn('Neck', Z, .3 * look); p.turn('Head', Z, .4 * look)
        p.shift('Hips', (0, 0, .01 * h * wave(u, 1)))
    elif clip == 'done':
        p.turn('Spine', X, .16); p.turn('Head', X, .3)
        p.shift('Hips', (0, 0, -.03 * h + .008 * h * wave(u, 1)))
    elif clip == 'move':
        bound = abs(wave(u, 2))
        p.shift('Hips', (0, 0, .09 * h * bound))
        p.turn('Spine', X, .18 - .1 * bound); p.turn('Head', X, -.1 + .08 * bound)
        p.turn('Chest', Z, .06 * wave(u, 1))


def clips_for(c):
    """Name, frames and pose function of every clip this model carries."""
    if not c.humanoid:
        return [(name, frames, (lambda n: lambda c, p, u: creature(c, p, u, n))(name))
                for name, frames in (('idle', 72), ('working', 48), ('waiting', 96), ('done', 72), ('move', 24))]
    work = WORK.get(c.work, work_tinker)
    return [('walk', WALK_FRAMES, clip_walk),
            ('idle_0', 120, clip_idle_0), ('idle_1', 144, clip_idle_1), ('idle_2', 120, clip_idle_2),
            ('pause', 120, clip_pause), ('done', 96, clip_done),
            ('work_0', 96 if c.work == 'pound' else 72, lambda c, p, u: work(c, p, u, 0)),
            ('work_1', 120, lambda c, p, u: work(c, p, u, 1))]


def animate(rig, c, body=None):
    """Bake every clip. A clip that tears the model at full reach is baked
    again with the arms moving less (REACH), so no clip ships torn when a
    gentler one would not be."""
    rig.animation_data_create()
    c.reach = {}
    for name, frames, fn in clips_for(c):
        c.loop_frames = frames
        for reach in REACH if body is not None else REACH[:1]:
            old = bpy.data.actions.get(name)
            if old:
                bpy.data.actions.remove(old)
            action = bpy.data.actions.new(name)
            action.use_fake_user = True
            rig.animation_data.action = action
            for f in range(frames + 1):
                p = Pose(rig, reach)
                fn(c, p, (f % frames) / frames)
                p.update()
                for pb in rig.pose.bones:
                    pb.keyframe_insert('rotation_quaternion', frame=f, group=pb.name)
                    if pb.name in ('Hips', 'Root'):
                        pb.keyframe_insert('location', frame=f, group=pb.name)
            action.frame_range = (0, frames)
            # A swung tool is the clip itself; its reach is not reduced.
            if body is None or (name == 'work_0' and c.work == 'pound') or tearing(rig, body, action)[0] < TORN:
                break
        c.reach[name] = reach
        if name == 'work_0' and c.work == 'pound':
            impact(rig, c, action, frames)
    rig.animation_data.action = None
    Pose(rig)


# Arm reach tried in turn for a clip that tears.
REACH = (1.0, .6, .3)


def impact(rig, c, action, frames):
    """Record where and when each hammer blow lands, in glTF coordinates
    relative to the character, for the runtime's sparks."""
    side = {'L': 'Left', 'R': 'Right'}[c.prop or 'L']
    rig.animation_data.action = action
    best = []
    lows = []
    for f in range(frames):
        bpy.context.scene.frame_set(f)
        grip = rig.pose.bones['Prop' + side].matrix
        head = (grip @ Matrix.Translation(Vector((0, c.wrist[side].z, 0)))).translation
        lows.append((f, head))
    # A blow lands where the head is lowest, once per half loop.
    for half in (0, 1):
        span = [x for x in lows if (x[0] // (frames // 2)) == half]
        f, head = min(span, key=lambda x: x[1].z)
        c.events.append({'clip': 'work_0', 'time': round(f / FPS, 4), 'kind': 'impact',
                         'at': [round(head.x, 3), round(max(0, head.z), 3), round(-head.y, 3)]})


# ---------------------------------------------------------------- checks

def check(rig, body, c, report):
    """Foot sliding in the walk, and in every clip the share of the surface
    torn (triangles stretched past TEAR times their rest area, which shows as
    spikes) and pinched (squeezed under a TEARth, the inside of a bent elbow
    or knee, which a fold hides)."""
    result = {'height': c.h, 'stride': round(2 * c.step, 4), 'cycle': c.cycle, 'gait': c.gait, 'clips': {}}
    for action in bpy.data.actions:
        rig.animation_data.action = action
        frames = int(action.frame_range[1])
        worst, pinched = tearing(rig, body, action)
        entry = {'torn': round(worst, 5), 'pinched': round(pinched, 5), 'reach': c.reach.get(action.name, 1.0)}
        if action.name == 'walk' and c.gait != 'glide':
            entry['footSlide'] = foot_slide(rig, c, frames)
        result['clips'][action.name] = entry
    rig.animation_data.action = None
    bpy.context.scene.frame_set(0)
    result['ok'] = all(e['torn'] < TORN and e.get('footSlide', 0) < .02 * c.h for e in result['clips'].values())
    with open(report, 'w') as f:
        json.dump(result, f, indent=1)
    print('YARD_QA', json.dumps(result), flush=True)


# A triangle stretched past three times its rest area shows as a spike;
# torn over more than one percent of the surface, a model needs fixing.
TEAR, TORN = 3.0, .01


def tearing(rig, body, action):
    """The largest share of the surface torn, and pinched, at a dozen moments of a clip."""
    rig.animation_data.action = None
    Pose(rig).update()
    tris, rest = triangles(body)
    rig.animation_data.action = action
    frames = int(action.frame_range[1])
    worst, pinched = 0.0, 0.0
    bpy.context.scene.frame_set(0)
    for f in range(0, frames, max(1, frames // 12)):
        bpy.context.scene.frame_set(f)
        _, area = triangles(body, tris)
        ratio = area / np.maximum(rest, 1e-12)
        worst = max(worst, float(rest[ratio > TEAR].sum() / rest.sum()))
        pinched = max(pinched, float(rest[ratio < 1 / TEAR].sum() / rest.sum()))
    return worst, pinched


def triangles(body, tris=None):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    mesh = body.evaluated_get(depsgraph).to_mesh()
    co = np.empty(len(mesh.vertices) * 3); mesh.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    if tris is None:
        mesh.calc_loop_triangles()
        tris = np.empty(len(mesh.loop_triangles) * 3, dtype=np.int64)
        mesh.loop_triangles.foreach_get('vertices', tris); tris = tris.reshape(-1, 3)
    body.evaluated_get(depsgraph).to_mesh_clear()
    a, b, d = co[tris[:, 0]], co[tris[:, 1]], co[tris[:, 2]]
    return tris, np.linalg.norm(np.cross(b - a, d - a), axis=1) / 2


def foot_slide(rig, c, frames):
    """How far a planted foot moves on the ground once the walk's own
    progress is added, in metres."""
    worst = 0.0
    for _, s, _ in SIDES:
        start = 0 if s == 'Left' else .5
        planted = []
        for f in range(frames):
            q = (f / frames - start) % 1
            if .05 < q < STANCE - .05:
                bpy.context.scene.frame_set(f)
                ankle = rig.pose.bones[s + 'Foot'].head
                # The body moves forward (-Y) at speed, so a planted foot
                # moves back at the same speed in the character's frame.
                planted.append(ankle.y - c.speed * q * c.cycle)
        if planted:
            worst = max(worst, max(planted) - min(planted))
    return round(worst, 4)


# ---------------------------------------------------------------- output

def shrink_textures(size):
    for img in bpy.data.images:
        if img.size[0] > size:
            img.scale(size, size)


def export(rig, c, path):
    # Only the rig and its mesh ship; nothing a step left behind.
    for o in list(bpy.context.scene.objects):
        if o is not rig and o.name != 'character':
            bpy.data.objects.remove(o)
    rig['yard'] = {'height': round(c.h, 4), 'stride': round(2 * c.step, 4), 'cycle': round(c.cycle, 4),
                   'events': c.events}
    bpy.context.scene.frame_set(0)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_animations=True,
                              export_animation_mode='ACTIONS', export_force_sampling=True,
                              export_frame_range=False, export_yup=True, export_lights=False,
                              export_cameras=False, export_extras=True,
                              export_image_format='WEBP', export_image_quality=85)
    print('YARD_RIGGED', path, flush=True)


def main():
    a = sys.argv[sys.argv.index('--') + 1:]
    src, out, height = a[0], a[1], float(a[2])
    kind = a[a.index('--kind') + 1] if '--kind' in a else 'builder'
    work = a[a.index('--work') + 1] if '--work' in a else 'tinker'
    faces = int(a[a.index('--faces') + 1]) if '--faces' in a else 25000
    texture = int(a[a.index('--texture') + 1]) if '--texture' in a else 1024
    spec = json.loads(a[a.index('--prop') + 1]) if '--prop' in a else None
    report = a[a.index('--report') + 1] if '--report' in a else None
    gait = a[a.index('--gait') + 1] if '--gait' in a else 'walk'
    busy = {'L': 'Left', 'R': 'Right'}.get(a[a.index('--busy') + 1]) if '--busy' in a else None
    robe = '--robe' in a
    body, shipped = load(src)
    decimate(body, faces)
    normalise(body, height)
    prop, side = (None, None)
    if shipped and spec and 'boxes' not in spec:
        # A shipped model's tool is found again by its weights; one cut by
        # boxes is cut by the same boxes, the shipped mesh standing as rig.py left it.
        prop, side = shipped_prop(body)
    elif spec:
        prop, side = cut_prop(body, spec), spec.get('hand', 'L')
    for g in list(body.vertex_groups):
        body.vertex_groups.remove(g)
    j = joints(body, height, kind)
    rig = skeleton(j, kind)
    weights(body, rig, robe)
    if prop:
        if spec and spec.get('plant') and not shipped:
            plant(prop, j, side)
        bind_prop(body, prop, side)
    c = Character(rig, height, work, side if prop else None, busy, gait, robe)
    animate(rig, c, bpy.data.objects['character'])
    if report:
        check(rig, bpy.data.objects['character'], c, report)
    shrink_textures(texture)
    export(rig, c, out)


if __name__ == '__main__':
    main()
