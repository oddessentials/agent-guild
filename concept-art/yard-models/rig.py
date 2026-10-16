"""Rig a Yard character or helper to the shared skeleton and author its clips
(docs/yard/CONTRACT.md).

  blender -b --factory-startup --python rig.py -- IN.glb OUT.glb HEIGHT [--kind builder|familiar]
      [--work tinker|conduct|steady|pound] [--gait walk|waddle|glide] [--robe] [--busy L|R]
      [--prop JSON] [--neck SHARE] [--hips SHARE] [--report FILE]

IN is a generated TRELLIS.2 model, or a shipped Yard model. A shipped model's
old skeleton and clips are removed, and a held tool is found again as the loose
part that was wholly weighted to one hand.

The mesh is scaled to HEIGHT metres, stood on the ground facing -Y (glTF +Z,
toward the Yard camera), and fitted with the contract skeleton, named after
Godot's humanoid profile, at joints taken from its own silhouette: shoulders
from the chest's width, hands from the end of each arm (followed down from the
armpit when it hangs clear of the body), hips and knees from the legs. An arm
modelled held out from the body hangs closer in every clip. Weights are
Blender's bone heat. A held tool (`--prop`) is cut out first so it cannot pass
for an arm, then rides a PropLeft or PropRight socket bone in that hand.
`--robe` lets the middle of a robe hang from the hips; `--busy` names a hand
holding something modelled in, which stays as modelled, as both arms of a
`steady` character do.

Clips are posed in Python and baked to keys, at 24 fps. Legs are solved with
two-bone IK, so planted feet stay put while the hips sway and the walk's
stance foot moves back at exactly the speed the character walks; the stride
and cycle are written into the model as `yard` extras for the runtime. Work
clips that strike something record the moment and place as `events`.
The mesh and textures keep the detail they were generated with; textures are
written as WebP. --report writes the automated checks: foot sliding, how
much of each part of the body tears in each clip, and how far the head's
layers and the surface split at UV seams come apart.
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


def normalise(body, height, prop=None):
    co = [v.co for v in body.data.vertices]
    lo = Vector([min(c[i] for c in co) for i in range(3)])
    hi = Vector([max(c[i] for c in co) for i in range(3)])
    scale = height / (hi.z - lo.z)
    centre = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    for o in (body, prop) if prop else (body,):
        o.data.transform(Matrix.Scale(scale, 4) @ Matrix.Translation(-centre))
        o.data.update()


def centre(body, prop):
    """Move the body's footprint centre to the origin, the prop with it."""
    co = [v.co for v in body.data.vertices]
    x = (min(c.x for c in co) + max(c.x for c in co)) / 2
    y = (min(c.y for c in co) + max(c.y for c in co)) / 2
    for o in (body, prop):
        o.data.transform(Matrix.Translation((-x, -y, 0)))
        o.data.update()


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
    """Separate the prop: the loose parts ranked `part` by size (0 is the
    body), and the faces whose centres fall in any of `boxes`."""
    import bmesh
    bm = bmesh.new(); bm.from_mesh(body.data); bm.verts.ensure_lookup_table()
    part = spec.get('part', [])
    parts = loose_parts(bm) if part != [] else []
    chosen = set().union(*(parts[i] for i in (part if isinstance(part, list) else [part])))
    inside = lambda c: any(all(lo[i] <= c[i] <= hi[i] for i in range(3)) for lo, hi in spec.get('boxes', []))
    picked = [f.index for f in bm.faces if f.verts[0].index in chosen or inside(f.calc_center_median())]
    bm.free()
    return separate(body, picked)


def shipped_prop(body):
    """A shipped model's tool: the loose parts that were wholly one socket's."""
    import bmesh
    hands = {g.index: g.name[4] for g in body.vertex_groups if g.name in ('PropLeft', 'PropRight')}
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
    side = held[next(iter(parts[0]))]
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


def free_arm(body, side, h):
    """The lowest vertices of an arm that hangs clear of the body, followed
    down from the armpit as the outermost band of the front silhouette while a
    gap parts it from the rest. Below the hips the legs also stand apart from
    each other, so the lowest point outside the hips would be a knee. None
    when the arm touches the body (generated models often fuse them)."""
    co = np.array([v.co[:] for v in body.data.vertices])
    co = co[side * co[:, 0] > 0]
    step, cell = .01 * h, .008 * h
    track, touching = [], 0
    for z in np.arange(.74 * h, .15 * h, -step):
        band = co[(co[:, 2] < z) & (co[:, 2] >= z - step)]
        if not len(band):
            break
        cells = np.unique(np.floor(side * band[:, 0] / cell).astype(int))
        runs = np.split(cells, np.where(np.diff(cells) > 2)[0] + 1)
        outer = runs[-1]
        lo, hi = outer[0] * cell, (outer[-1] + 1) * cell
        apart = len(runs) > 1
        # A band that soon breaks off was a sliver of sparse vertices near
        # the armpit, not an arm: start again lower down.
        short = track and track[0][0] - z < .05 * h
        if track and hi < track[-1][1] - .04 * h:
            if short:
                track = []
                continue
            break  # the arm ended: the outermost band is now a leg or a hem
        if track and not apart:
            if track[0][0] - z < .1 * h:
                track = []  # the arm parts from the body lower down
                continue
            touching += 1
            if touching > 3:
                return None  # the hand rests on the body
            continue  # brushing a pouch or a fold on the way down
        touching = 0
        if apart:
            # The body is the widest band inside; between it and the outermost
            # band, narrow bands are the same arm, broken up by sparse vertices.
            body_run = max(runs[:-1], key=len)
            edge = (body_run[-1] + 1) * cell
            inner = min(r[0] * cell for r in runs if r[0] * cell > edge)
            track.append((z, hi, lo, edge, inner))
    if not track or track[0][0] - track[-1][0] < .08 * h:
        return None
    z, hi, lo, edge, inner = track[-1]
    # The hand: the arm's width over its last few slices, so a narrowing
    # fingertip still finds the whole hand.
    near = [s for s in track if s[0] < z + .06 * h]
    left, right = min(s[4] for s in near), max(s[1] for s in near)
    end = [Vector(c) for c in co if z - step <= c[2] < z + .06 * h and left <= side * c[0] <= right]
    # Where the arm joins the body: its centre line, followed back up past
    # where it parts from the body, meets the body's edge. Shoulders sit
    # there, under any hat or crest that makes a share of the height wrong.
    z = np.array([s[0] for s in track]); x = np.array([(s[4] + s[1]) / 2 for s in track])
    slope, at = np.polyfit(z, x, 1)
    body_edge = float(np.median([s[3] for s in track]))
    root = track[0][0] if slope >= 0 else (body_edge - at) / slope
    shoulder = min(.74 * h, max(track[0][0], root + .03 * h))
    return (end, max(0.0, inner - edge - .02 * h), shoulder) if len(end) >= 20 else None


def front_outline(co, h, cell):
    """The front silhouette of the body's main part (props held clear of it
    drop out), as each row's outermost extent to the left and right of the
    centre line; rows run from the ground up."""
    cols = np.floor(co[:, 0] / cell).astype(int)
    rows = np.floor(co[:, 2] / cell).astype(int)
    off = -cols.min() + 2
    img = np.zeros((rows.max() + 3, cols.max() + off + 3), bool)
    img[np.clip(rows, 0, None), cols + off] = True
    # Close the gaps between sparse vertices.
    img = img | np.roll(img, 1, 0) | np.roll(img, -1, 0) | np.roll(img, 1, 1) | np.roll(img, -1, 1)
    r = int(.5 * h / cell)
    on = np.flatnonzero(img[r])
    part = np.zeros_like(img)
    part[r, on[np.argmin(abs(on - off))]] = True
    while True:
        grown = part.copy()
        grown[1:] |= part[:-1]; grown[:-1] |= part[1:]; grown[:, 1:] |= part[:, :-1]; grown[:, :-1] |= part[:, 1:]
        grown &= img
        if (grown == part).all():
            break
        part = grown
    filled = part.any(1)
    right = np.array([(np.flatnonzero(p).max() - off) * cell if f else 0 for p, f in zip(part, filled)])
    left = np.array([(off - np.flatnonzero(p).min()) * cell if f else 0 for p, f in zip(part, filled)])
    return (np.arange(len(part)) + .5) * cell, left, right, filled


def find_neck(body, h):
    """The neck's height: where the front silhouette pinches in on both sides
    between the body and the head above it, which carries any hat, helmet,
    hood or beard with it. Each side's outline is compared with its convex
    envelope; a pinch is a dent in both sides at the same height. The lowest
    pinch at least half as deep as the deepest is the neck, so a hat brim or
    ears above the face are not taken for it. A silhouette with no pinch
    keeps the usual 0.80 of the height."""
    co = np.array([v.co[:] for v in body.data.vertices])
    z, left, right, filled = front_outline(co, h, .006 * h)
    top = z[np.flatnonzero(filled)[-1]]
    keep = (z >= .42 * h) & filled
    dents = []
    for outline in (left, right):
        zs, xs = z[keep], outline[keep]
        hull = []
        for p in zip(zs, xs):
            while len(hull) >= 2 and (hull[-1][1] - hull[-2][1]) * (p[0] - hull[-2][0]) <= (p[1] - hull[-2][1]) * (hull[-1][0] - hull[-2][0]):
                hull.pop()
            hull.append(p)
        depth = np.interp(zs, [p[0] for p in hull], [p[1] for p in hull]) - xs
        depth = np.convolve(np.pad(depth, 2, mode='edge'), np.ones(5) / 5, mode='valid')
        dents.append([(zs[i], depth[i]) for i in range(1, len(depth) - 1)
                      if depth[i] >= depth[i - 1] and depth[i] >= depth[i + 1] and zs[i] < top - .08 * h])
    pinches = [((a + b) / 2, min(da, db)) for a, da in dents[0] for b, db in dents[1]
               if abs(a - b) <= .04 * h and min(da, db) >= .025 * h]
    if not pinches:
        return .80 * h
    deepest = max(d for _, d in pinches)
    return min(zz for zz, d in pinches if d >= .5 * deepest)


def head_part(body, neck, h):
    """Which vertices are the head: the piece of surface above the neck
    (pieces joined without passing below it) that shows the face, the walls
    hidden inside it, and every piece wholly above the neck whose middle lies
    over it, within the widest run of the silhouette round the centre line.
    A hat, hood, hair, ears or
    a beard's top come with it; a staff held up beside the head sits off to
    the side, and a sword or a hammer slung on the back carries on below the
    neck, so they stay with the body."""
    co = np.array([v.co[:] for v in body.data.vertices])
    floor = neck - .01 * h
    up = co[:, 2] >= floor
    edges = np.empty(len(body.data.edges) * 2, dtype=np.int64)
    body.data.edges.foreach_get('vertices', edges)
    edges = edges.reshape(-1, 2)
    edges = edges[up[edges[:, 0]] & up[edges[:, 1]]]
    # UV seams split a surface into twins at the same place; join them.
    keys = {}
    twins = [(i, keys.setdefault(tuple(np.round(c, 4)), i)) for i, c in enumerate(co) if up[i]]
    root = np.arange(len(co))
    def find(i):
        while root[i] != i:
            root[i] = root[root[i]]; i = root[i]
        return i
    for a, b in list(map(tuple, edges)) + twins:
        ra, rb = find(a), find(b)
        if ra != rb:
            root[ra] = rb
    labels = np.array([find(i) for i in range(len(co))])
    # Which pieces carry on below the neck: the same surface, unrestricted.
    whole = np.arange(len(co))
    def top(i):
        while whole[i] != i:
            whole[i] = whole[whole[i]]; i = whole[i]
        return i
    every = np.empty(len(body.data.edges) * 2, dtype=np.int64)
    body.data.edges.foreach_get('vertices', every)
    for a, b in list(map(tuple, every.reshape(-1, 2))) + twins:
        ra, rb = top(a), top(b)
        if ra != rb:
            whole[ra] = rb
    surface = np.array([top(i) for i in range(len(co))])
    below = set(surface[~up])
    from mathutils.bvhtree import BVHTree
    from mathutils.kdtree import KDTree
    body.data.calc_loop_triangles()
    tris = np.empty(len(body.data.loop_triangles) * 3, dtype=np.int64)
    body.data.loop_triangles.foreach_get('vertices', tris)
    tris = tris.reshape(-1, 3)
    bvh = BVHTree.FromPolygons([Vector(c) for c in co], tris.tolist())
    # The face: of the pieces carrying on below the neck, the one rays from
    # the front reach most over the middle of the head, through a visor or
    # a mask wholly above it; a tail or a pack behind is hidden by the head.
    hits = []
    far = co[:, 1].min() - h
    for x in np.arange(-.1, .1, .005) * h:
        for z in np.arange(neck, neck + .15 * h, .005 * h):
            start = Vector((x, far, z))
            while (hit := bvh.ray_cast(start, Y))[2] is not None and up[tris[hit[2]][0]]:
                if surface[tris[hit[2]][0]] in below:
                    hits.append(labels[tris[hit[2]][0]])
                    break
                start = hit[0] + Y * 1e-4 * h
    ids, counts = np.unique(hits, return_counts=True)
    main = ids[np.argmax(counts)] if len(ids) else -1
    seen = visible(body, co, up)
    # Generated heads often have walls inside the visible one, each carrying
    # on below the neck: mostly hidden, closed in on every side over the
    # skull and lying under the face's piece, they are the head's.
    skull = co[:, 2] > neck + .04 * h
    outside = np.flatnonzero(up & seen)
    kd = KDTree(len(outside))
    for n, i in enumerate(outside):
        kd.insert(co[i], n)
    kd.balance()
    around = [Vector(d).normalized() for d in [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)] +
              [(x, y, z) for x in (1, -1) for y in (1, -1) for z in (1, -1)]]
    hidden = {}
    for label in np.unique(labels[up]):
        over = up & (labels == label) & skull
        hidden[label] = over.any() and seen[over].mean() < .5 and np.mean(
            [labels[outside[kd.find(co[i])[1]]] == main for i in np.flatnonzero(over)]) >= .5 and np.mean(
            [all(bvh.ray_cast(Vector(co[i]) + d * 1e-4 * h, d)[0] is not None for d in around) for i in np.flatnonzero(over)]) >= .9
    # The head's half width: the run of the silhouette holding the centre
    # line, widest over the rows above the neck.
    cell, half = .006 * h, .05 * h
    above = co[up]
    for z in np.arange(floor, above[:, 2].max(), cell):
        row = above[(above[:, 2] >= z) & (above[:, 2] < z + cell)]
        if len(row):
            cells = np.unique(np.floor(row[:, 0] / cell).astype(int))
            runs = np.split(cells, np.flatnonzero(np.diff(cells) > 2) + 1)
            run = min(runs, key=lambda r: 0 if r[0] <= 0 <= r[-1] else min(abs(r[0]), abs(r[-1])))
            half = max(half, -run[0] * cell, (run[-1] + 1) * cell)
    part = np.zeros(len(co), bool)
    for label in np.unique(labels[up]):
        piece = up & (labels == label)
        # Beside the face's own piece, a piece seen from outside that carries
        # on below the neck (a sword or a hammer slung on the back, a cape) is
        # not the head's.
        if label == main or (abs(co[piece, 0].mean()) <= half and (hidden[label] or surface[np.flatnonzero(piece)[0]] not in below)):
            part |= piece
    return part


def visible(body, co, where):
    """Which vertices a ray from outside reaches first, over the region `where`."""
    from mathutils.bvhtree import BVHTree
    body.data.calc_loop_triangles()
    tris = np.empty(len(body.data.loop_triangles) * 3, dtype=np.int64)
    body.data.loop_triangles.foreach_get('vertices', tris)
    tris = tris.reshape(-1, 3)
    bvh = BVHTree.FromPolygons([Vector(c) for c in co], tris.tolist())
    centre = Vector(co[where].mean(0))
    radius = float(np.linalg.norm(co[where] - co[where].mean(0), axis=1).max())
    far = float(np.linalg.norm(co - co[where].mean(0), axis=1).max()) + radius
    seen = np.zeros(len(co), bool)
    for el in np.linspace(-1.2, 1.4, 12):
        for az in np.linspace(0, 2 * math.pi, 48, endpoint=False):
            d = Vector((math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)))
            side = d.cross(Z).normalized() if abs(d.z) < .999 else X.copy()
            up = side.cross(d)
            for a in np.linspace(-1, 1, 9) * radius:
                for b in np.linspace(-1, 1, 9) * radius:
                    hit = bvh.ray_cast(centre + d * far + side * a + up * b, -d)[2]
                    if hit is not None:
                        seen[tris[hit]] = True
    return seen


def joints(body, height, kind, neck=None, hip=None):
    """Joint positions from the silhouette. The neck is where the outline
    pinches in under the head (find_neck), so a tall hat or helmet is carried
    by the head instead of holding it, unless `neck` gives its share of the
    height; the trunk's joints divide the hips to the neck in fixed shares.
    The legs leave the body at 0.48 of the height unless `hip` says."""
    h = height
    j = {'root': Vector((0, 0, 0)), 'hips': Vector((0, 0, .50 * h)), 'spine': Vector((0, 0, .57 * h)),
         'chest': Vector((0, 0, .64 * h)), 'upperChest': Vector((0, 0, .71 * h)), 'neck': Vector((0, 0, .80 * h)),
         'head': Vector((0, 0, .84 * h)), 'top': Vector((0, 0, h))}
    if kind == 'familiar':
        return j
    neck = neck * h if neck else find_neck(body, h)
    co = [v.co for v in body.data.vertices if abs(v.co.z - neck) < .015 * h]
    y = sorted(c.y for c in co)[len(co) // 2] if co else 0.0
    # A big head on a short body leaves the trunk at least 0.15 of the height.
    pelvis = min(.50 * h, neck - .15 * h)
    j['hips'] = Vector((0, 0, pelvis))
    for name, share in (('spine', .23), ('chest', .47), ('upperChest', .70)):
        j[name] = Vector((0, y * share, pelvis + share * (neck - pelvis)))
    j['neck'] = Vector((0, y, neck))
    j['head'] = Vector((0, y, neck + .04 * h))
    j['headPart'] = head_part(body, neck, h)
    chest = slices(body, neck - .14 * h, neck - .06 * h)
    width = max(abs(c.x) for c in chest)
    hips = slices(body, .40 * h, .50 * h)
    # Arms are what stands outside the torso below the shoulders.
    torso = sorted(abs(c.x) for c in hips)[int(len(hips) * .5)] if hips else width * .5
    free = {side: free_arm(body, side, h) for side in (1, -1)}
    found = [f[2] for f in free.values() if f]
    # Shoulders sit under the neck, however a free arm reads.
    level = min(sum(found) / len(found) if found else .74 * h, neck - .03 * h)
    for side, name in ((1, 'L'), (-1, 'R')):
        low, j['room' + name] = free[side][:2] if free[side] else (None, 0.0)
        if not low:
            arm = [c for c in body.data.vertices if side * c.co.x > torso * 1.05 and .2 * h < c.co.z < .66 * h]
            arm = [v.co for v in arm]
            if len(arm) < 50:
                arm = [c for c in slices(body, .25 * h, .6 * h) if side * c.x > torso * .8]
            low = sorted(arm, key=lambda c: c.z)[:max(20, len(arm) // 12)]
        hand = sum(low, Vector()) / len(low)
        hand.z += .03 * h
        shoulder = Vector((side * width * .72, 0, level))
        elbow = (shoulder + hand) / 2 + Vector((side * .02 * h, .04 * h, 0))
        j['clavicle' + name] = Vector((side * width * .16, 0, shoulder.z + .01 * h))
        j['shoulder' + name], j['elbow' + name], j['wrist' + name] = shoulder, elbow, hand
        j['hand' + name] = hand + (hand - elbow).normalized() * .07 * h
        x = side * max(torso * .45, .06 * h)
        j['hip' + name] = Vector((x, 0, (hip or .48) * h))
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


def weights(body, rig, robe=False, still=(), head=None):
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
    claim_strays(body, rig)
    keep_arms_to_arms(body, rig)
    keep_head_to_head(body, rig, head)
    smooth(body)
    if head is not None:
        shape_head(body, rig, head)
    split_legs(body, rig, robe)
    # Normalise and limit to four influences for glTF.
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)
    if 'LeftUpperArm' in rig.data.bones:
        unfuse(body, robe, still)
    # The clean-ups can leave a vertex with no weight, which the exporter
    # would bind to an extra bone outside the contract skeleton.
    claim_strays(body, rig)


def claim_strays(body, rig):
    """A vertex nothing weights follows its nearest bone."""
    from mathutils.geometry import intersect_point_line
    segments = [(b.name, b.head_local, b.tail_local) for b in rig.data.bones if b.name != 'Root' and not b.name.startswith('Prop')]
    for v in body.data.vertices:
        if not any(g.weight > .01 for g in v.groups):
            def gap(seg):
                point, t = intersect_point_line(v.co, seg[1], seg[2])
                return (v.co - (seg[1] if t < 0 else seg[2] if t > 1 else point)).length
            body.vertex_groups[min(segments, key=gap)[0]].add([v.index], 1, 'REPLACE')


def keep_head_to_head(body, rig, part=None):
    """Bone heat lets the head claim a hood's back, a pack or a crest that
    touches it, which tears when the head turns or nods. The head and neck
    keep only what is the head: for a character, head_part, so a tall hat or
    a hood turns with it; for a helper, the head bone's sphere. The rest goes
    to the upper chest. Over the head joint a character's head comes to turn
    as one piece, so a face cannot shear between the head and the chest."""
    head = rig.data.bones['Head']
    centre = (head.head_local + head.tail_local) / 2
    inside = (lambda v: part[v.index]) if part is not None else (lambda v: (v.co - centre).length <= head.length)
    # The neck to head joint is 0.04 of the height (joints); over the next
    # 0.1 of it the head's hold rises to whole.
    height = (head.head_local.z - rig.data.bones['Neck'].head_local.z) / .04
    chest = body.vertex_groups['UpperChest']
    skull = body.vertex_groups['Head']
    groups = {body.vertex_groups[n].index: body.vertex_groups[n] for n in ('Head', 'Neck')}
    for v in body.data.vertices:
        if inside(v):
            rigid = min(1.0, (v.co.z - head.head_local.z) / (.1 * height)) if part is not None else 0
            have = next((g.weight for g in v.groups if g.group == skull.index), 0.0)
            if rigid > have:
                others = [(g.group, g.weight) for g in v.groups if g.group != skull.index and g.weight > 0]
                total = sum(w for _, w in others) or 1
                for group, w in others:
                    body.vertex_groups[group].add([v.index], w / total * (1 - rigid), 'REPLACE')
                skull.add([v.index], rigid, 'REPLACE')
            continue
        moved = 0.0
        for group, weight in [(g.group, g.weight) for g in v.groups]:
            if group in groups and weight > 0:
                moved += weight
                groups[group].remove([v.index])
        if moved:
            chest.add([v.index], moved, 'ADD')


LIMBS = ('Shoulder', 'Arm', 'Hand', 'Leg', 'Foot', 'Toes')


def shape_head(body, rig, part):
    """Every layer of the head turns by the same rule: from the neck up, its
    weights blend from bone heat to ones set by height alone, all the neck's
    up to the head joint, then rising to all the head's over 0.1 of the
    height, or longer for surface far from the neck (a snout, a brim),
    which a turn would otherwise shear. Walls weighted apart by bone heat
    would slide past each other. What bone heat gives a limb (a hunched
    shoulder) stays, as does the hips' hold below the head joint."""
    neck_bone = rig.data.bones['Neck'].head_local
    neck, head = neck_bone.z, rig.data.bones['Head'].head_local.z
    h = (head - neck) / .04
    floor = neck - .01 * h
    groups = {g.name: g for g in body.vertex_groups}
    for v in body.data.vertices:
        if not part[v.index]:
            continue
        own = {body.vertex_groups[g.group].name: g.weight for g in v.groups}
        total = sum(own.values()) or 1
        keep = sum(w for n, w in own.items() if n.endswith(LIMBS) or (n in ('Hips', 'Root') and v.co.z < head)) / total
        t = (1 - keep) ** 2 * min(1.0, max(0.0, (v.co.z - floor) / (head - floor)))
        out = math.hypot(v.co.x - neck_bone.x, v.co.y - neck_bone.y)
        rise = min(1.0, max(0.0, (v.co.z - head) / max(.1 * h, .45 * out)))
        own = {n: w * (1 - t) for n, w in own.items()}
        own['Head'] = own.get('Head', 0) + t * rise
        own['Neck'] = own.get('Neck', 0) + t * (1 - rise)
        for name, w in own.items():
            groups[name].add([v.index], w, 'REPLACE')


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
            for group, weight in [(g.group, g.weight) for g in v.groups]:
                if group not in groups or weight <= 0:
                    continue
                near = min((v.co - (lambda r: r[0] if 0 <= r[1] <= 1 else (b.head_local if r[1] < 0 else b.tail_local))(
                    intersect_point_line(v.co, b.head_local, b.tail_local))).length for b in bones)
                if v.co.z < low or near > .09 * h:
                    moved += weight
                    groups[group].remove([v.index])
            if moved:
                hips.add([v.index], moved, 'ADD')


def split_legs(body, rig, robe):
    """Below the crotch each leg owns its own side. Trousers then part
    cleanly in a stride instead of tearing at the inseam. A robe or skirt,
    which joins the legs, lets its middle follow the hips instead. Above the
    crotch the legs' hold fades out by the hip joint, so a stride does not
    pull at the belt."""
    if 'LeftUpperLeg' not in rig.data.bones:
        return
    h = max(v.co.z for v in body.data.vertices)
    crotch = rig.data.bones['LeftUpperLeg'].head_local.z - .05 * h
    hip_x = abs(rig.data.bones['LeftUpperLeg'].head_local.x)
    groups = {g.name: g for g in body.vertex_groups}
    legs = [n for n in groups if any(n.endswith(k) for k in ('UpperLeg', 'LowerLeg', 'Foot', 'Toes'))]
    index = {groups[n].index: n for n in legs}
    hip = rig.data.bones['LeftUpperLeg'].head_local.z
    for v in body.data.vertices:
        # A robe hangs mostly from the hips, its middle wholly.
        share = .6 + .35 * max(0, 1 - abs(v.co.x) / hip_x) if robe else 0
        if v.co.z > crotch:
            # Above the crotch a robe stays at least as much the hips' as below.
            fade = max(share, min(1.0, (v.co.z - crotch) / max(hip - crotch, 1e-6)))
            for group, w in [(g.group, g.weight) for g in v.groups]:
                name = index.get(group)
                if name and w > 0:
                    groups[name].add([v.index], w * (1 - fade), 'REPLACE')
                    groups['Hips'].add([v.index], w * fade, 'ADD')
            continue
        own = 'Left' if v.co.x > 0 else 'Right'
        for group, w in [(g.group, g.weight) for g in v.groups]:
            name = index.get(group)
            if not name or w <= 0:
                continue
            if robe:
                groups[name].add([v.index], w * (1 - share), 'REPLACE')
                groups['Hips'].add([v.index], w * share, 'ADD')
            elif not name.startswith(own):
                groups[name].remove([v.index])
                twin = own + name[len('Right' if name.startswith('Right') else 'Left'):]
                groups[twin].add([v.index], w, 'ADD')


def unfuse(body, robe, still=()):
    """Generated models often fuse a hanging hand to the thigh, or one leg to
    the other, with a skin of triangles that tears once the limb moves. Cut
    those bridges: the faces joining a moving forearm or hand to the hips or
    a leg, and, unless a robe joins them by design, the left leg to the right.
    Where they met, the limbs touched, so the cut is out of sight. An arm that
    stays as modelled keeps its skin: cut, it would leave a hole in a sleeve
    or robe that shows in every pose."""
    import bmesh
    groups = {g.index: g.name for g in body.vertex_groups}
    def owner(v):
        best = max(v.groups, key=lambda g: g.weight, default=None)
        return groups.get(best.group, '') if best else ''
    owners = [owner(v) for v in body.data.vertices]
    arm = lambda n: (n.endswith('LowerArm') or n.endswith('Hand')) and not n.startswith(still)
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
    the joint instead of creasing it. Twins split at a UV seam are smoothed
    as one vertex, so the seam stays shut."""
    n, groups = len(body.data.vertices), body.vertex_groups
    node = twins(body)
    m = node.max() + 1
    w = np.zeros((n, len(groups)))
    for v in body.data.vertices:
        for g in v.groups:
            w[v.index, g.group] = g.weight
    shared = np.zeros((m, len(groups)))
    np.add.at(shared, node, w)
    shared /= np.bincount(node, minlength=m)[:, None]
    edges = np.empty(len(body.data.edges) * 2, dtype=np.int64)
    body.data.edges.foreach_get('vertices', edges)
    pairs = np.unique(np.sort(node[edges.reshape(-1, 2)], 1), axis=0)
    a, b = pairs[pairs[:, 0] != pairs[:, 1]].T
    count = np.bincount(a, minlength=m) + np.bincount(b, minlength=m)
    for _ in range(6):
        total = np.stack([np.bincount(a, shared[b, k], m) + np.bincount(b, shared[a, k], m) for k in range(len(groups))], 1)
        mean = np.where(count[:, None] > 0, total / np.maximum(count, 1)[:, None], shared)
        shared += .5 * (mean - shared)
    w = shared[node]
    for k, group in enumerate(groups):
        group.remove(range(n))
        for i in np.flatnonzero(w[:, k] > 1e-4):
            group.add([int(i)], float(w[i, k]), 'REPLACE')


def twins(body):
    """For each vertex, one index shared by every vertex at its place (twins
    split at a UV seam)."""
    from mathutils.kdtree import KDTree
    n = len(body.data.vertices)
    kd = KDTree(n)
    for v in body.data.vertices:
        kd.insert(v.co, v.index)
    kd.balance()
    node = np.arange(n)
    for v in body.data.vertices:
        if node[v.index] == v.index:
            for _, i, _ in kd.find_range(v.co, 1e-5):
                node[i] = v.index
    return np.unique(node, return_inverse=True)[1]


def weld(body):
    """Put twins at exactly one place, so every rule placing a vertex by
    where it is (which leg, the head's floor) treats them alike."""
    node = twins(body)
    first = np.full(node.max() + 1, -1)
    for i in range(len(node) - 1, -1, -1):
        first[node[i]] = i
    for v in body.data.vertices:
        v.co = body.data.vertices[int(first[node[v.index]])].co.copy()


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

    def __init__(self, rig, reach=1.0, still=()):
        # reach scales how far the arms move from rest: animate() lowers it
        # for a clip that tears the model at full reach. Arms on the `still`
        # sides stay as modelled.
        self.rig, self.reach, self.still = rig, reach, tuple(still)
        for pb in rig.pose.bones:
            pb.rotation_mode = 'QUATERNION'
            pb.rotation_quaternion = Quaternion()
            pb.location = (0, 0, 0)
            pb.scale = (1, 1, 1)

    def has(self, name):
        return name in self.rig.pose.bones

    def turn(self, name, axis, angle, reach=True):
        """Rotate a bone about a world axis, composed onto what it has."""
        pb = self.rig.pose.bones.get(name)
        if not pb or not angle:
            return
        if name.startswith(self.still) and name.endswith(('Arm', 'Hand', 'Shoulder')):
            return
        # Arms are often joined to the body below the chest, so a bend of the
        # trunk pulls at them as a moving arm would.
        if reach and (name.endswith(('Arm', 'Hand', 'Shoulder')) or name in ('Spine', 'Chest', 'UpperChest')):
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
        if side in self.still:
            return
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


def still_sides(work, busy, prop_side):
    """Arms modelled holding something (a staff, folded, in pockets, or a hand
    round a tablet) are joined to what they hold, so they stay as modelled;
    moving them would tear it. A tool on a socket moves with its hand."""
    return ('Left', 'Right') if work == 'steady' else (busy,) if busy and not prop_side else ()


class Character:
    """Rest measurements a clip poses against."""

    def __init__(self, rig, height, work, prop_side, busy=None, gait='walk', robe=False, room=None, surface=None):
        self.rig, self.h, self.work, self.prop, self.gait = rig, height, work, prop_side, gait
        # The height of the working surface in front of it, in metres, if any.
        self.surface = surface
        # The arm's angle from straight down at a hammer's blow, and how far
        # the hammer tilts in the hand there (work_pound).
        self.blow, self.tilt = .5, 0.0
        # The hand that holds something, a tool socket's or one modelled in.
        self.busy = {'L': 'Left', 'R': 'Right'}[prop_side] if prop_side else busy
        self.free = 'Left' if self.busy == 'Right' else 'Right'
        self.still = still_sides(work, busy, prop_side)
        bones = rig.data.bones
        self.humanoid = 'LeftUpperLeg' in bones
        self.settle = {}
        if self.humanoid:
            self.ankle = {s: bones[s + 'Foot'].head_local.copy() for _, s, _ in SIDES}
            self.shoulder = {s: bones[s + 'UpperArm'].head_local.copy() for _, s, _ in SIDES}
            self.wrist = {}
            for _, s, sign in SIDES:
                # An arm modelled held out from the body (`room` metres clear
                # of it at the hand) hangs closer in every clip, short of
                # touching; poses aim from where it then hangs.
                arm = bones[s + 'Hand'].head_local - self.shoulder[s]
                out = math.atan2(sign * arm.x, -arm.z)
                angle = min((room or {}).get(s, 0) / arm.length, max(0, out - .12))
                self.settle[s] = sign * angle
                self.wrist[s] = self.shoulder[s] + Matrix.Rotation(sign * angle, 3, Y) @ arm
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
    p.turn('Hips', Z, .07 * p.reach * wave(u, 1, .25))
    # A waddle rolls the whole body over each foot.
    p.turn('Hips', Y, (.11 if waddle else .025) * p.reach * wave(u, 1, 0))
    if waddle:
        p.turn('Chest', Y, -.05 * wave(u, 1, .05))
    p.turn('Spine', X, .05)
    # Already scaled by reach, so not again (Pose.turn).
    p.turn('Chest', Z, -.09 * p.reach * wave(u, 1, .25), reach=False)
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
    # The head bows no further than a client turns it to look (LOOK_PITCH).
    p.turn('Neck', X, .1); p.turn('Head', X, .15 + .05 * sigh)
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
    # Hands work just above the station's surface when there is one.
    bench = lambda s: (c.surface + .04 * h - c.shoulder[s].z) if c.surface else -.2 * h
    if variant == 0:
        for _, s, sign in SIDES:
            if s == c.busy and not c.prop:
                continue
            k = 1 if s == 'Left' else -1
            reach = c.shoulder[s] + Vector((-sign * .07 * h, -.2 * h, bench(s)))
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
            low = c.shoulder[s] + Vector((-sign * .08 * h, -.2 * h, bench(s)))
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
    """Holding steady (a staff, arms folded, hands in pockets): the arms stay
    as modelled, so focus shows in the trunk and head, small corrections and
    nods; the variant draws itself up to look out over the work, holds, and
    settles back."""
    h = c.h
    p.turn('Spine', X, .07); p.turn('Head', X, .16)
    if variant == 0:
        p.turn('Spine', X, .05 * wave(u, 2)); p.turn('Head', X, .1 * wave(u, 2, .15))
        p.turn('Chest', Z, .07 * wave(u, 1)); p.turn('Head', Z, .12 * wave(u, 1, .1))
        p.shift('Hips', (.012 * h * wave(u, 1, .3), 0, -.006 * h * abs(wave(u, 2))))
    else:
        rise = keys(u, [(0, 0), (.12, -.1), (.3, 1), (.62, 1), (.78, 0)])
        p.turn('Spine', X, -.08 * rise); p.turn('Head', X, -.2 * rise)
        scan = max(0, rise) * wave(u, 1.5, .1)
        p.turn('Chest', Z, .05 * scan); p.turn('Head', Z, .2 * scan)
        p.shift('Hips', (0, .01 * h * rise, .004 * h * max(0, rise)))
    c.breathe(p, u, 2, .8)
    c.plant(p)


def work_pound(c, p, u, variant):
    """A sledge swung up over the shoulder: wind up with the weight back,
    a held beat, the fast drop with the knees taking the blow, the jolt of
    impact, then the lift back to the start. The variant rests the hammer,
    wipes a brow and checks the work."""
    h, side = c.h, {'L': 'Left', 'R': 'Right'}[c.prop or 'L']
    sign = 1 if side == 'Left' else -1
    other = 'Right' if side == 'Left' else 'Left'
    if variant == 0:
        # Two blows a loop. `a` is the hand's angle about the shoulder from
        # straight down, forward positive: low in front at the blow, at the
        # shoulder at the top of the swing, where the wrist carries the hammer
        # on up over it. Arms raised overhead stretch the shoulders, and any
        # cape or pauldron on them, past what skinning can follow.
        v = (u * 2) % 1
        # The blow is the lowest point of the swing, wherever the surface puts it.
        low = c.blow
        a = keys(v, [(0, low + .25), (.08, low + .12), (.42, max(1.65, low + .9)), (.5, max(1.75, low + 1)), (.6, low), (.66, low + .08), (.82, low + .32)])
        up = max(0, (a - low - .25) / 1.0)
        drop = max(0, (low + .25 - a) / .25)
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
        # At the blow the hammer tilts in the hand to meet the surface (aim_blow).
        p.turn('Prop' + side, X, 1.6 * up - .35 * drop + c.tilt * drop)
        # The other hand takes the handle below the first for the blow and
        # lets go as the hammer rises, so it is not dragged over the shoulder.
        p.update()
        grip = rig_point(p.rig, 'Prop' + side, Vector((0, .1 * h, 0)))
        free = c.shoulder[other] + Vector((sign * .06 * h, -.16 * h, -.22 * h))
        p.arm(other, grip.lerp(free, min(1, up * 2.5)), Vector((-sign * .8, .25, -.7)))
    else:
        wipe = keys(u, [(0, 0), (.15, 0), (.3, 1), (.45, 1), (.55, 0)])
        look = keys(u, [(0, 0), (.55, 0), (.7, 1), (.9, 1)])
        brow = Vector((-sign * .03 * h, c.shoulder[other].y - .1 * h, c.shoulder[other].z + .12 * h))
        p.arm(other, c.wrist[other].lerp(brow, wipe), Vector((-sign, .2, -.6)))
        p.turn(other + 'Hand', Z, -sign * .6 * wipe * wave(u, 4))
        p.turn('Head', X, -.12 * wipe + .25 * look); p.turn('Spine', X, .12 * look)
        p.turn('Head', Z, .12 * look * wave(u, 1.5))
        c.breathe(p, u, 2, 1.4)
    c.plant(p)


def hammer_head(rig, c):
    """Where the hammer's head is in the current pose: a handle's length
    (the wrist's rest height, as plant stands the tool) along the socket."""
    side = {'L': 'Left', 'R': 'Right'}[c.prop or 'L']
    return (rig.pose.bones['Prop' + side].matrix @ Matrix.Translation(Vector((0, c.wrist[side].z, 0)))).translation


def aim_blow(rig, c, reach=1.0):
    """Find how far the hammer tilts in the hand at the blow to bring its
    head down on the station's surface, at the reach the clip is baked with:
    the arm swings as it would, so a shorter reach costs it nothing."""
    def head_at(tilt):
        c.tilt = tilt
        p = Pose(rig, reach, c.still)
        for s, angle in c.settle.items():
            p.turn(s + 'UpperArm', Y, angle, reach=False)
        work_pound(c, p, .3, 0)
        p.update()
        return hammer_head(rig, c).z
    lo, hi = -1.6, 1.6
    rising = head_at(hi) > head_at(lo)
    for _ in range(16):
        mid = (lo + hi) / 2
        if (head_at(mid) > c.surface) == rising:
            hi = mid
        else:
            lo = mid
    c.tilt = (lo + hi) / 2
    Pose(rig)


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
    again with the arms moving less (REACH), and a walk with a shorter stride
    and less twist, so no clip ships torn when a gentler one would not be."""
    rig.animation_data_create()
    c.reach = {}
    step = c.step
    for name, frames, fn in clips_for(c):
        c.loop_frames = frames
        for reach in REACH if body is not None else REACH[:1]:
            if name == 'work_0' and c.work == 'pound' and c.surface and c.prop:
                aim_blow(rig, c, reach)
            if name == 'walk':
                # The stride is written into the model, so feet keep pace.
                c.step = step * STRIDE[reach]
                c.speed = 2 * c.step / c.cycle
            old = bpy.data.actions.get(name)
            if old:
                bpy.data.actions.remove(old)
            action = bpy.data.actions.new(name)
            action.use_fake_user = True
            rig.animation_data.action = action
            for f in range(frames + 1):
                p = Pose(rig, reach, c.still)
                for s, angle in c.settle.items():
                    p.turn(s + 'UpperArm', Y, angle, reach=False)
                fn(c, p, (f % frames) / frames)
                p.update()
                for pb in rig.pose.bones:
                    pb.keyframe_insert('rotation_quaternion', frame=f, group=pb.name)
                    if pb.name in ('Hips', 'Root'):
                        pb.keyframe_insert('location', frame=f, group=pb.name)
            action.frame_range = (0, frames)
            if body is None or tearing(rig, body, action)[0] < TORN:
                break
        c.reach[name] = reach
        if name == 'work_0' and c.work == 'pound':
            impact(rig, c, action, frames)
    rig.animation_data.action = None
    Pose(rig)


# Arm reach tried in turn for a clip that tears, and the walk's stride with it.
REACH = (1.0, .8, .6, .45, .3, .15)
STRIDE = {1.0: 1.0, .8: .9, .6: .8, .45: .7, .3: .6, .15: .5}


def impact(rig, c, action, frames):
    """Record where and when each hammer blow lands, in glTF coordinates
    relative to the character, for the runtime's sparks: at the swing's
    lowest arm angle, twice a loop (work_pound)."""
    rig.animation_data.action = action
    for u in (.3, .8):
        f = round(u * frames)
        bpy.context.scene.frame_set(f)
        head = hammer_head(rig, c)
        c.events.append({'clip': 'work_0', 'time': round(f / FPS, 4), 'kind': 'impact',
                         'at': [round(head.x, 3), round(max(0, head.z), 3), round(-head.y, 3)]})


# ---------------------------------------------------------------- checks

def check(rig, body, c, report):
    """Foot sliding in the walk, and in every clip the share of each part of
    the body (an arm, a hand, a leg with its foot, the trunk, the head)
    torn: triangles whose longest edge stretches past STRETCH times its rest
    length, which shows as a smear or a spike; how far twins split at UV
    seams come apart (Seams); and for a character, how far the head's layers
    come apart (Layers)."""
    result = {'height': c.h, 'stride': round(2 * c.step, 4), 'cycle': c.cycle, 'gait': c.gait, 'clips': {}}
    layers = Layers(rig, body) if c.humanoid else None
    seams = Seams(rig, body)
    for action in bpy.data.actions:
        rig.animation_data.action = action
        frames = int(action.frame_range[1])
        worst, part = tearing(rig, body, action)
        apart = layers.apart(clip_poses(rig, action)) if layers else 0.0
        entry = {'torn': round(worst, 5), 'part': part, 'reach': c.reach.get(action.name, 1.0)}
        if layers:
            entry['apart'] = round(apart, 4)
        if action.name == 'walk' and c.gait != 'glide':
            entry['footSlide'] = foot_slide(rig, c, frames)
        entry['seams'] = round(seams.apart(clip_poses(rig, action)), 4)
        entry['ok'] = worst < TORN and apart < APART and entry['seams'] < SEAM and entry.get('footSlide', 0) < .02 * c.h
        result['clips'][action.name] = entry
    if c.humanoid:
        worst, part = look_tearing(rig, body)
        apart = layers.apart(look_poses(rig))
        gap = seams.apart(look_poses(rig))
        result['look'] = {'torn': round(worst, 5), 'part': part, 'apart': round(apart, 4), 'seams': round(gap, 4),
                          'ok': worst < TORN and apart < APART and gap < SEAM}
    rig.animation_data.action = None
    bpy.context.scene.frame_set(0)
    result['ok'] = all(e['ok'] for e in result['clips'].values()) and result.get('look', {}).get('ok', True)
    with open(report, 'w') as f:
        json.dump(result, f, indent=1)
    print('YARD_QA', json.dumps(result), flush=True)


# An edge stretched past twice its length shows as a smear. A part of the
# body torn over more than TORN of its surface needs fixing. Measured over
# the whole body instead, a torn arm hides in the rest.
STRETCH, TORN, FLOOR = 2.0, .03, .02
PARTS = {'Shoulder': 'arm', 'UpperArm': 'arm', 'LowerArm': 'arm', 'Hand': 'hand',
         'UpperLeg': 'leg', 'LowerLeg': 'leg', 'Foot': 'leg', 'Toes': 'leg'}


def part_of(bone):
    if bone in ('Neck', 'Head'):
        return 'head'
    if bone.startswith('Prop'):
        return None  # a held tool is rigid
    for suffix, part in PARTS.items():
        if bone.endswith(suffix):
            return part + bone[0]
    return 'trunk'


def clip_poses(rig, action):
    """16 moments of a clip."""
    frames = int(action.frame_range[1])
    rig.animation_data.action = action
    for f in range(0, frames, max(1, frames // 16)):
        bpy.context.scene.frame_set(f)
        yield


def tearing(rig, body, action):
    """The largest share of any part of the body torn at 16 moments of a
    clip, and which part."""
    return torn(rig, body, clip_poses(rig, action))


# Where a client turns a character's head to look at someone (CONTRACT.md):
# up to LOOK_YAW either way and LOOK_PITCH up or down, the neck taking
# LOOK_NECK of the turn and the head the rest.
LOOK_YAW, LOOK_PITCH, LOOK_NECK = .7, .3, .4


def look_poses(rig):
    """The head turned to the look-at limits, at rest."""
    rig.animation_data.action = None
    for yaw in (-LOOK_YAW, 0, LOOK_YAW):
        for pitch in (-LOOK_PITCH, 0, LOOK_PITCH):
            p = Pose(rig)
            for bone, share in (('Neck', LOOK_NECK), ('Head', 1 - LOOK_NECK)):
                p.turn(bone, Z, share * yaw, reach=False)
                p.turn(bone, X, share * pitch, reach=False)
            p.update()
            yield
    Pose(rig).update()


def look_tearing(rig, body):
    """The largest share of any part torn with the head turned to the
    look-at limits, at rest, and which part."""
    return torn(rig, body, look_poses(rig))


# A head whose surface layers move as one shows the same surface from every
# view fixed to it; more than APART of those views reaching surface hidden
# inside the model at rest means a layer has come apart.
APART = .05
ENCLOSING = [Vector(d).normalized() for d in [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)] +
             [(x, y, z) for x in (1, -1) for y in (1, -1) for z in (1, -1)]]


class Layers:
    """Rays fixed in the head bone's frame, aimed at the head from all round,
    and where each lands at rest."""

    def __init__(self, rig, body):
        from mathutils.bvhtree import BVHTree
        rig.animation_data.action = None
        Pose(rig).update()
        self.rig, self.body = rig, body
        self.tris = triangles(body)[0]
        co = positions(body)
        h = co[:, 2].max() - co[:, 2].min()
        frame = rig.pose.bones['Head'].matrix.copy()
        above = co[:, 2] > frame.translation.z + .05 * h
        centre = Vector(co[above].mean(0))
        radius = float(np.linalg.norm(co[above] - co[above].mean(0), axis=1).max())
        far = float(np.linalg.norm(co - co[above].mean(0), axis=1).max()) + radius
        bvh = BVHTree.FromPolygons([Vector(c) for c in co], self.tris.tolist())
        middle = co[self.tris].mean(1)
        self.enclosed = np.zeros(len(self.tris), bool)
        for t in np.flatnonzero(np.linalg.norm(middle - co[above].mean(0), axis=1) < 1.3 * radius):
            m = Vector(middle[t])
            self.enclosed[t] = all(bvh.ray_cast(m + d * 1e-4 * h, d)[0] is not None for d in ENCLOSING)
        inverse = frame.inverted()
        self.rays = []
        for el in np.linspace(-.5, 1.3, 10):
            for az in np.linspace(0, 2 * math.pi, 40, endpoint=False):
                d = Vector((math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)))
                side = d.cross(Z).normalized() if abs(d.z) < .999 else X.copy()
                up = side.cross(d)
                for a in np.linspace(-.6, .6, 7) * radius:
                    for b in np.linspace(-.6, .6, 7) * radius:
                        self.rays.append((inverse @ (centre + d * far + side * a + up * b), inverse.to_3x3() @ -d))
        rest = self.cast(bvh, frame)
        self.on = (rest >= 0) & (middle[np.maximum(rest, 0), 2] > frame.translation.z + .05 * h) & ~self.enclosed[np.maximum(rest, 0)]

    def cast(self, bvh, frame):
        turn = frame.to_3x3()
        return np.array([-1 if hit[2] is None else hit[2] for hit in (bvh.ray_cast(frame @ o, turn @ d) for o, d in self.rays)])

    def apart(self, poses):
        """Over the poses a generator steps through, the largest share of the
        rays on the head that reach hidden surface."""
        from mathutils.bvhtree import BVHTree
        worst = 0.0
        for _ in poses:
            bvh = BVHTree.FromPolygons([Vector(c) for c in positions(self.body)], self.tris.tolist())
            hit = self.cast(bvh, self.rig.pose.bones['Head'].matrix)
            worst = max(worst, float((self.on & (hit >= 0) & self.enclosed[np.maximum(hit, 0)]).sum() / max(self.on.sum(), 1)))
        return worst


# Surface split at a UV seam is shut if its twins stay within SEAM of the
# height of each other.
SEAM = .002


class Seams:
    """Twins split at UV seams, outside a held tool, which every pose must keep together."""

    def __init__(self, rig, body):
        rig.animation_data.action = None
        Pose(rig).update()
        self.body = body
        node = twins(body)
        props = {g.index for g in body.vertex_groups if g.name.startswith('Prop')}
        held = np.array([any(g.group in props and g.weight > 0 for g in v.groups) for v in body.data.vertices])
        order = np.argsort(node, kind='stable')
        same = node[order][1:] == node[order][:-1]
        self.pairs = np.stack([order[:-1][same], order[1:][same]], 1)
        self.pairs = self.pairs[~held[self.pairs].any(1)]
        co = positions(body)
        self.h = co[:, 2].max() - co[:, 2].min()

    def apart(self, poses):
        """Over the poses a generator steps through, the widest gap between twins, as a share of the height."""
        worst = 0.0
        for _ in poses:
            co = positions(self.body)
            if len(self.pairs):
                worst = max(worst, float(np.linalg.norm(co[self.pairs[:, 0]] - co[self.pairs[:, 1]], axis=1).max() / self.h))
        return worst


def torn(rig, body, poses):
    """Over the poses a generator steps through, the largest share of any
    part of the body torn, and which part."""
    rig.animation_data.action = None
    Pose(rig).update()
    tris, rest, rest_area = triangles(body)
    names = {g.index: g.name for g in body.vertex_groups}
    owner = [names.get(max(v.groups, key=lambda g: g.weight).group) if len(v.groups) else None
             for v in body.data.vertices]
    parts = np.array([part_of(owner[t[0]] or 'Hips') or '' for t in tris])
    worst, which = 0.0, ''
    for _ in poses:
        _, edges, _ = triangles(body, tris)
        stretched = (edges / np.maximum(rest, 1e-9)).max(1) > STRETCH
        for part in set(parts) - {''}:
            m = parts == part
            # A small part (a hand, or a patch a model's hand bone holds) is
            # measured against no less than FLOOR of the body, so a few
            # stretched triangles in it are not read as a torn limb.
            share = float(rest_area[m & stretched].sum() / max(rest_area[m].sum(), FLOOR * rest_area.sum()))
            if share > worst:
                worst, which = share, part
    return worst, which


def positions(body):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    mesh = body.evaluated_get(depsgraph).to_mesh()
    co = np.empty(len(mesh.vertices) * 3); mesh.vertices.foreach_get('co', co)
    body.evaluated_get(depsgraph).to_mesh_clear()
    return co.reshape(-1, 3)


def triangles(body, tris=None):
    """Triangles, their edge lengths and their areas."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    mesh = body.evaluated_get(depsgraph).to_mesh()
    co = np.empty(len(mesh.vertices) * 3); mesh.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    if tris is None:
        mesh.calc_loop_triangles()
        tris = np.empty(len(mesh.loop_triangles) * 3, dtype=np.int64)
        mesh.loop_triangles.foreach_get('vertices', tris); tris = tris.reshape(-1, 3)
    body.evaluated_get(depsgraph).to_mesh_clear()
    a, b, d = co[tris[:, 0]], co[tris[:, 1]], co[tris[:, 2]]
    edges = np.stack([np.linalg.norm(b - a, axis=1), np.linalg.norm(d - b, axis=1), np.linalg.norm(a - d, axis=1)], 1)
    return tris, edges, np.linalg.norm(np.cross(b - a, d - a), axis=1) / 2


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

def export(rig, c, path):
    # Only the rig and its mesh ship; nothing a step left behind.
    for o in list(bpy.context.scene.objects):
        if o is not rig and o.name != 'character':
            bpy.data.objects.remove(o)
    rig['yard'] = {'height': round(c.h, 4), 'stride': round(2 * c.step, 4), 'cycle': round(c.cycle, 4),
                   'events': c.events}
    if c.surface:
        rig['yard']['surface'] = round(c.surface, 4)
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
    spec = json.loads(a[a.index('--prop') + 1]) if '--prop' in a else None
    report = a[a.index('--report') + 1] if '--report' in a else None
    gait = a[a.index('--gait') + 1] if '--gait' in a else 'walk'
    busy = {'L': 'Left', 'R': 'Right'}.get(a[a.index('--busy') + 1]) if '--busy' in a else None
    robe = '--robe' in a
    surface = float(a[a.index('--surface') + 1]) if '--surface' in a else None
    neck = float(a[a.index('--neck') + 1]) if '--neck' in a else None
    hip = float(a[a.index('--hips') + 1]) if '--hips' in a else None
    body, shipped = load(src)
    prop, side = (None, None)
    if shipped and spec:
        # A shipped model's tool is found again by its socket's weights. A
        # planted tool stands beside the body, so the body alone is centred.
        prop, side = shipped_prop(body)
        normalise(body, height, prop)
    else:
        normalise(body, height)
        if spec:
            prop, side = cut_prop(body, spec), spec.get('hand', 'L')
            # The prop's boxes are measured on the whole model; once it is
            # cut out, centre the body alone, as a recast does.
            centre(body, prop)
    for g in list(body.vertex_groups):
        body.vertex_groups.remove(g)
    weld(body)
    j = joints(body, height, kind, neck, hip)
    rig = skeleton(j, kind)
    still = still_sides(work, busy, side if prop else None)
    weights(body, rig, robe, still, j.get('headPart'))
    if prop:
        if spec and spec.get('plant') and not shipped:
            plant(prop, j, side)
        bind_prop(body, prop, side)
    # The surface is given for a 2 m figure, whose shoulders stand at 1.5 m;
    # each character works at the same height relative to its own shoulders.
    if surface and kind != 'familiar':
        surface *= (j['shoulderL'].z + j['shoulderR'].z) / 2 / 1.5
    c = Character(rig, height, work, side if prop else None, busy, gait, robe,
                  {s: j.get('room' + k, 0) for k, s, _ in SIDES}, surface if kind != 'familiar' else None)
    animate(rig, c, bpy.data.objects['character'])
    if report:
        check(rig, bpy.data.objects['character'], c, report)
    export(rig, c, out)


if __name__ == '__main__':
    main()
