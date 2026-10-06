"""Grove environment for the Yard's pre-rendered plates: a sunlit glade in an
old forest, where woodland spirits live in tree dwellings, with a spring at
its centre, a stream behind it running into a lily pond, and wooded hills
beyond.

Preview renders from the live camera into .cache/yard-env/:
  blender -b --factory-startup --python concept-art/guild-yard/env/grove_env.py -- --preview [--dark]
The live halls and characters stand on the level glade at y = 0. Forest paths
lead from it between the village's treehouses, stump houses and toadstool
houses, which are TRELLIS.2 models made from concept images
(concept-art/grove-yard); everything else is Poly Haven CC0, fetched by
polyhaven.py. Layout uses the screen-aligned ground frame described in common.py.
"""
import math, random, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import polyhaven
from camera import ROOT
# plates.py and preview() call render_settings through this module.
from common import (COURTYARD_RADIUS, to_ground, to_frame, smooth, play_distance, live_distance, tall_clear,
                    line_distance, surface, painted, mix, textured, source, scatter, variant_sets, reeds,
                    lights as sky_lights, lantern_posts, slab, building, render_settings, preview)

TOWN = ROOT / '.cache/grove-yard/models'
# Sky per theme: a clear morning for light, a warm sunset sky for dark.
SKIES = {'light': 'qwantani_mid_morning_puresky', 'dark': 'kloppenheim_06_puresky'}
TEXTURES = {'floor': 'forest_leaves_02', 'leaves': 'leaves_forest_ground', 'path': 'forest_ground_04',
            'bank': 'brown_mud_leaves_01', 'shore': 'river_small_rocks', 'rock': 'lichen_rock', 'stone': 'mossy_rock'}
# Model, target height in metres (None keeps Poly Haven's real size), and
# whether the .blend holds variants to pick between rather than one model.
MODELS = {
    'fir_tree_01': (18, False), 'pine_tree_01': (19, False), 'island_tree_01': (11, False),
    'island_tree_02': (9, False), 'island_tree_03': (8, False), 'tree_small_02': (4.5, False),
    'jacaranda_tree': (16, False),
    'shrub_02': (1.2, False), 'shrub_04': (1.1, False),
    'fern_02': (None, True), 'moss_01': (None, True), 'grass_medium_01': (None, True),
    'celandine_01': (None, True), 'periwinkle_plant': (None, True), 'dandelion_01': (None, True),
    'rock_moss_set_01': (None, True), 'rock_moss_set_02': (None, True), 'boulder_01': (None, False),
    'dead_tree_trunk_02': (None, False), 'tree_stump_01': (None, False), 'tree_stump_02': (None, False),
    'root_cluster_01': (None, False), 'pine_roots': (None, False),
}
# The live halls are TRELLIS.2 models with their own baked textures.
SURFACES = {}
WATER_LEVEL = -.6
GLADE_RADIUS = COURTYARD_RADIUS + .9
# The glade in front of the courtyard, under the rows of sessions (Blender y = -glTF z).
GLADE_FRONT = (-14.2, 14.2, -33.5, 0)

def fetch_all():
    for sky in SKIES.values():
        polyhaven.hdri(sky)
    polyhaven.model('Lantern_01')
    for asset in TEXTURES.values():
        polyhaven.texture(asset)
    for asset in MODELS:
        polyhaven.model(asset)

# --- Layout -----------------------------------------------------------------
# Everything is in the screen frame: `a` right, `b` up the screen (away).
POND = (-31, 31, 11, 6.5)       # centre a, b and radii
# The stream comes down from the hills on the right, behind the glade, into the pond.
STREAM = [(70, 78), (50, 50), (30, 31), (12, 25), (-6, 26), (-20, 30)]
OUTFLOW = [(-42, 29), (-58, 22), (-76, 25), (-100, 20)]
PATHS = [[(0, 14), (1, 19.5), (0, 25), (-3, 33), (3, 46), (-2, 72)],   # up over the stream
         [(-15, 1), (-27, 5), (-42, 3), (-60, 8), (-90, 5)],           # west
         [(15, -2), (27, -6), (42, -2), (62, -7), (95, -4)],           # east
         [(-10, -17), (-22, -30), (-27, -48), (-36, -70)],             # south-west, toward the viewer
         [(10, -19), (24, -32), (30, -50), (44, -72)]]                 # south-east
# Village dwellings: model, screen position, metres tall, turn (degrees).
BUILDINGS = [
    # Either side of the stream path, behind the glade.
    ('town_treehouse', (-10, 18), 9, 15), ('town_stump', (-18, 19.5), 4.5, -10), ('town_mushroom', (10, 17), 6, -20),
    ('town_treehouse', (19, 20), 9.5, -30), ('town_stump', (-8, 37), 4.5, 30), ('town_mushroom', (12, 40), 6.5, 10),
    # Along the west path.
    ('town_treehouse', (-24, 11), 9, 40), ('town_mushroom', (-35, 11), 5.5, 20), ('town_stump', (-47, 10), 4.5, 60),
    ('town_treehouse', (-55, 16), 10, 30), ('town_stump', (-33, -5), 4.5, 70), ('town_mushroom', (-48, -4), 6, 50),
    ('town_treehouse', (-66, 1), 9.5, 25),
    # Along the east path.
    ('town_stump', (23, 5), 4.5, -50), ('town_treehouse', (33, 8), 9.5, -30), ('town_mushroom', (45, 6), 6, -25),
    ('town_treehouse', (56, 9), 10, -40), ('town_stump', (34, -11), 4.5, -65), ('town_treehouse', (48, -12), 9, -55),
    ('town_mushroom', (66, 2), 6, -20),
    # Down the southern paths, toward the viewer.
    ('town_stump', (-29, -26), 4.5, 60), ('town_mushroom', (-38, -38), 6, 45), ('town_treehouse', (-45, -52), 9, 30),
    ('town_stump', (32, -28), 4.5, -60), ('town_mushroom', (41, -41), 6, -40), ('town_treehouse', (51, -54), 9, 0),
]
# Old flowering trees that stand out over the forest.
GIANTS = [(-44, 44), (40, 58), (-70, 62), (64, 30)]

def on_glade(x, y, margin=0):
    x0, x1, y0, y1 = GLADE_FRONT
    in_front = x0 - margin <= x <= x1 + margin and y0 - margin <= y <= y1 + margin
    return math.hypot(x, y) <= GLADE_RADIUS + margin or in_front

def glade_distance(x, y):
    x0, x1, y0, y1 = GLADE_FRONT
    ring = math.hypot(x, y) - GLADE_RADIUS
    box = math.hypot(max(x0 - x, 0, x - x1), max(y0 - y, 0, y - y1))
    return 0 if on_glade(x, y) else min(ring, box)

def pond_shape(a, b):
    from mathutils import noise, Vector
    ca, cb, ra, rb = POND
    wobble = noise.noise(Vector((a / 9, b / 9, 4.2))) * .14
    return ((a - ca) / ra) ** 2 + ((b - cb) / rb) ** 2 + wobble

def masks(x, y):
    from mathutils import noise, Vector
    a, b = to_frame(x, y)
    n = noise.noise(Vector((x / 22, y / 22, 6.1)))
    pond = pond_shape(a, b)
    water = line_distance([STREAM, OUTFLOW], a, b)
    stream = 1 - smooth(1.3, 2.2, water + n * .3)
    bank = (1 - smooth(2.2, 4, water + n * .5)) * (1 - stream)
    path = 1 - smooth(.8, 1.5, line_distance(PATHS, a, b) + n * .3) if not on_glade(x, y, .4) else 0
    shore = (1 - smooth(.9, 1.25, pond + n * .05)) * smooth(.75, .95, pond)
    edge = glade_distance(x, y)
    clear = 1 if tall_clear(a, b) else 0
    # The glade is grass and moss; the forest closes in a few metres past its edge.
    # Patches of moss and leaf litter break up the grass, more of them toward the edge.
    patches = smooth(.15, .4, noise.noise(Vector((x / 3, y / 3, 8.8))) + edge * .04)
    glade = (1 - smooth(1, 7, edge + n * 6)) * (1 - patches * .6)
    open_ground = (1 - stream) * (1 - path) * (1 if pond > 1.2 else 0)
    woods = smooth(4, 9, edge + n * 4) * open_ground * smooth(.6, 1, line_distance(PATHS, a, b) / 3)
    under = smooth(1.5, 4, edge + n * 2) * open_ground
    flowers = smooth(.1, .4, noise.noise(Vector((x / 6, y / 6, 2.3)))) * smooth(.5, 2, edge) * (1 - smooth(4, 8, edge)) * open_ground
    fireflies = smooth(3, 6, edge) * (1 - smooth(30, 45, edge))
    return {'pond': pond, 'stream': stream, 'bank': max(bank, shore), 'path': path, 'glade': glade,
            'woods': woods * clear, 'giants': woods, 'under': under, 'flowers': flowers,
            'leaves': smooth(-.1, .3, noise.noise(Vector((x / 11, y / 11, 3.4)))) * (1 - glade),
            'rocks': max(bank, shore * .6) * (1 - stream), 'fireflies': fireflies * (1 - stream),
            'tint': smooth(-.1, .35, noise.noise(Vector((x / 9, y / 9, 5.7))))}

def height(x, y):
    from mathutils import noise, Vector
    a, b = to_frame(x, y)
    m = masks(x, y)
    # Rolling forest floor, rising into wooded hills behind and to either side.
    rolling = noise.fractal(Vector((x / 30, y / 30, .7)), 1.0, 2.0, 4) * 1.6
    hills = smooth(40, 110, b) * 26 + smooth(55, 120, abs(a)) * smooth(-60, 10, b) * 20
    ridges = (1 - abs(noise.noise(Vector((x / 34, y / 34, 2.2))))) * smooth(30, 90, b + abs(a) * .5) * 12
    h = rolling + hills + ridges
    # The stream runs in a shallow valley, cut deeper at its channel.
    h -= (1 - smooth(1.5, 9, line_distance([STREAM, OUTFLOW], a, b))) * 1.2 + m['stream'] * .9
    pond = -2.2 * smooth(1.05, .3, m['pond'])
    h = h + pond if m['pond'] < 1.3 else max(h, WATER_LEVEL + .4)
    # The live area stays level so halls and characters stand on y = 0.
    return h * smooth(2, 12, play_distance(x, y))

# --- Materials --------------------------------------------------------------
def ground_material():
    """Glade grass, forest floor, fallen leaves, paths and stream banks, blended by masks."""
    import bpy
    m = bpy.data.materials.new('ground')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = nodes['Principled BSDF']
    coord = nodes.new('ShaderNodeTexCoord').outputs['Object']
    color, rough, normal = painted(nodes, links, 'meadow', 5, coord, dry=(1.0, 1.0, .75, 1))
    tint = nodes.new('ShaderNodeAttribute')
    tint.attribute_name = 'tint'
    lush = nodes.new('ShaderNodeMix')
    lush.data_type, lush.blend_type = 'RGBA', 'MULTIPLY'
    links.new(tint.outputs['Fac'], lush.inputs['Factor'])
    links.new(color, lush.inputs[6])
    lush.inputs[7].default_value = (.62, .7, .4, 1)
    deep = nodes.new('ShaderNodeMix')
    deep.data_type, deep.blend_type = 'RGBA', 'MULTIPLY'
    deep.inputs['Factor'].default_value = 1
    links.new(lush.outputs[2], deep.inputs[6])
    deep.inputs[7].default_value = (.6, .7, .45, 1)
    layers = (deep.outputs[2], rough, normal)
    def over(attribute, top, invert=False):
        nonlocal layers
        attr = nodes.new('ShaderNodeAttribute')
        attr.attribute_name = attribute
        fac = attr.outputs['Fac']
        if invert:
            flip = nodes.new('ShaderNodeMath')
            flip.operation = 'SUBTRACT'
            flip.inputs[0].default_value = 1
            links.new(fac, flip.inputs[1])
            fac = flip.outputs['Value']
        layers = tuple(mix(nodes, links, kind, fac, low, high)
                       for kind, low, high in zip(('RGBA', 'FLOAT', 'VECTOR'), layers, top))
    def moss(layer, rgb):
        """A surface's colour pulled toward moss green."""
        color, *rest = layer
        node = nodes.new('ShaderNodeMix')
        node.data_type, node.blend_type = 'RGBA', 'MULTIPLY'
        node.inputs['Factor'].default_value = 1
        links.new(color, node.inputs[6])
        node.inputs[7].default_value = (*rgb, 1)
        return (node.outputs[2], *rest)
    # A mossy forest floor wherever the glade ends, fallen leaves in drifts.
    over('glade', moss(surface(nodes, links, TEXTURES['floor'], 3.5, coord), (.33, .55, .26)), invert=True)
    over('leaves', moss(surface(nodes, links, TEXTURES['leaves'], 3, coord), (.8, .85, .6)))
    over('bank', surface(nodes, links, TEXTURES['bank'], 3, coord))
    over('path', surface(nodes, links, TEXTURES['path'], 2.4, coord))
    over('rock', surface(nodes, links, TEXTURES['rock'], 5, coord))
    over('stream', surface(nodes, links, TEXTURES['shore'], 2, coord))
    color, rough, normal = layers
    links.new(color, bsdf.inputs['Base Color'])
    links.new(rough, bsdf.inputs['Roughness'])
    links.new(normal, bsdf.inputs['Normal'])
    return m

def water_material():
    """Still forest water: clear and amber-brown over the stones in the shallows,
    dark green and mirror-like where deep."""
    import bpy
    m = bpy.data.materials.new('water')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = nodes['Principled BSDF']
    depth = nodes.new('ShaderNodeAttribute')
    depth.attribute_name = 'depth'
    deep = nodes.new('ShaderNodeMapRange')
    deep.inputs['From Min'].default_value, deep.inputs['From Max'].default_value = 0, 1.6
    links.new(depth.outputs['Fac'], deep.inputs['Value'])
    tint = nodes.new('ShaderNodeMix')
    tint.data_type = 'RGBA'
    links.new(deep.outputs['Result'], tint.inputs['Factor'])
    tint.inputs[6].default_value = (.1, .1, .05, 1)
    tint.inputs[7].default_value = (.012, .03, .022, 1)
    links.new(tint.outputs[2], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = .04
    bsdf.inputs['IOR'].default_value = 1.33
    clear = nodes.new('ShaderNodeBsdfTransparent')
    clear.inputs['Color'].default_value = (.7, .66, .5, 1)
    shallow = nodes.new('ShaderNodeMapRange')
    shallow.inputs['From Min'].default_value, shallow.inputs['From Max'].default_value = 0, .5
    shallow.inputs['To Min'].default_value, shallow.inputs['To Max'].default_value = .6, 0
    links.new(depth.outputs['Fac'], shallow.inputs['Value'])
    blend = nodes.new('ShaderNodeMixShader')
    links.new(shallow.outputs['Result'], blend.inputs['Fac'])
    links.new(bsdf.outputs['BSDF'], blend.inputs[1])
    links.new(clear.outputs['BSDF'], blend.inputs[2])
    links.new(blend.outputs['Shader'], nodes['Material Output'].inputs['Surface'])
    ripples = nodes.new('ShaderNodeTexNoise')
    ripples.inputs['Scale'].default_value = 2.2
    ripples.inputs['Detail'].default_value = 6
    bump = nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = .04
    links.new(ripples.outputs['Fac'], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
    return m

def flat(name, rgb, rough=.6, emit=0):
    import bpy
    m = bpy.data.materials.new(name)
    bsdf = m.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    bsdf.inputs['Roughness'].default_value = rough
    if emit:
        bsdf.inputs['Emission Color'].default_value = (*rgb, 1)
        bsdf.inputs['Emission Strength'].default_value = emit
    return m

def stonework(name, asset, scale):
    """A PBR set box-projected, so rims and stones show it on their sides too."""
    m = textured(name, asset, scale)
    for node in m.node_tree.nodes:
        if node.type == 'TEX_IMAGE':
            node.projection, node.projection_blend = 'BOX', .25
    return m

# --- Geometry ---------------------------------------------------------------
def terrain():
    """The ground, with a `rock` mask where it is steep, from the height grid."""
    import bpy, bmesh
    import numpy as np
    size, cuts = 440, 640
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=cuts, y_segments=cuts, size=size / 2)
    mesh = bpy.data.meshes.new('terrain')
    bm.to_mesh(mesh)
    bm.free()
    layers = {}
    co = np.zeros((len(mesh.vertices), 3))
    for i, v in enumerate(mesh.vertices):
        x, y = v.co.x, v.co.y
        v.co.z = height(x, y) - .03
        co[i] = v.co
        for key, value in masks(x, y).items():
            layers.setdefault(key, []).append(value)
    step = size / cuts
    ix = np.rint((co[:, 0] + size / 2) / step).astype(int)
    iy = np.rint((co[:, 1] + size / 2) / step).astype(int)
    grid = np.zeros((cuts + 1, cuts + 1))
    grid[iy, ix] = co[:, 2]
    gy, gx = np.gradient(grid, step)
    slope = np.hypot(gx, gy)[iy, ix]
    layers['rock'] = list(np.clip((slope - .65) / .45, 0, 1) * (1 - np.array(layers['stream'])))
    for key, values in layers.items():
        mesh.attributes.new(key, 'FLOAT', 'POINT').data.foreach_set('value', values)
    mesh.shade_smooth()
    obj = bpy.data.objects.new('terrain', mesh)
    obj.data.materials.append(ground_material())
    bpy.context.scene.collection.objects.link(obj)
    return obj

def pond():
    """The lily pond, carrying the depth beneath each point."""
    import bpy, bmesh
    ca, cb, ra, rb = POND
    x, y = to_ground(ca, cb)
    size = ra * 2.8
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=int(size * 1.5), y_segments=int(size * 1.5), size=size / 2)
    mesh = bpy.data.meshes.new('pond')
    bm.to_mesh(mesh)
    bm.free()
    depths = []
    for v in mesh.vertices:
        v.co.x += x
        v.co.y += y
        v.co.z = WATER_LEVEL
        depths.append(max(0, WATER_LEVEL - height(v.co.x, v.co.y)))
    mesh.attributes.new('depth', 'FLOAT', 'POINT').data.foreach_set('value', depths)
    obj = bpy.data.objects.new('pond', mesh)
    obj.data.materials.append(water_material())
    bpy.context.scene.collection.objects.link(obj)

def stream():
    """The stream: a ribbon of water down its channel, following the ground."""
    import bpy
    verts, faces, depths = [], [], []
    for line in (STREAM, OUTFLOW):
        points = []
        for (a0, b0), (a1, b1) in zip(line, line[1:]):
            n = int(math.hypot(a1 - a0, b1 - b0) / .6)
            points += [(a0 + (a1 - a0) * i / n, b0 + (b1 - b0) * i / n) for i in range(n)]
        start = len(verts)
        for i, (a, b) in enumerate(points):
            a1, b1 = points[min(i + 1, len(points) - 1)]
            a0, b0 = points[max(i - 1, 0)]
            l = math.hypot(a1 - a0, b1 - b0)
            na, nb = -(b1 - b0) / l, (a1 - a0) / l
            centre = to_ground(a, b)
            level = max(height(*centre) + .5, WATER_LEVEL)
            for side in (-1.7, 1.7):
                x, y = to_ground(a + na * side, b + nb * side)
                verts.append((x, y, level))
                depths.append(.35)
            if i:
                k = start + 2 * i
                faces.append((k - 2, k - 1, k + 1, k))
    mesh = bpy.data.meshes.new('stream')
    mesh.from_pydata(verts, [], faces)
    mesh.attributes.new('depth', 'FLOAT', 'POINT').data.foreach_set('value', depths)
    obj = bpy.data.objects.new('stream', mesh)
    obj.data.materials.append(water_material())
    bpy.context.scene.collection.objects.link(obj)

def lilies():
    """Lily pads on the pond, a few with pink lotus flowers."""
    import bpy
    rng = random.Random(61)
    pad = flat('lily_pad', (.14, .34, .07), .45)
    lotus = flat('lotus', (.9, .32, .45), .5)
    ca, cb, ra, rb = POND
    placed = 0
    while placed < 70:
        a, b = ca + rng.uniform(-ra, ra), cb + rng.uniform(-rb, rb)
        if pond_shape(a, b) > .8:
            continue
        x, y = to_ground(a, b)
        r = rng.uniform(.25, .55)
        notch = rng.uniform(0, math.tau)
        ring = [(x + r * math.cos(notch + .35 + t * (math.tau - .7) / 20), y + r * math.sin(notch + .35 + t * (math.tau - .7) / 20))
                for t in range(21)] + [(x, y)]
        slab('lily', ring, WATER_LEVEL + .015, .01, pad)
        if rng.random() < .18:
            bpy.ops.mesh.primitive_uv_sphere_add(segments=10, ring_count=6, radius=.13, location=(x, y, WATER_LEVEL + .08))
            bpy.context.object.scale.z = .7
            bpy.context.object.data.materials.append(lotus)
        placed += 1

def stepping_stones(points, stone, rng, size=(.45, .7), top=.02):
    """Flat mossy stones set into the ground or the stream bed."""
    for x, y, z in points:
        r = rng.uniform(*size)
        k = 9
        ring = [(x + r * math.cos(t * math.tau / k) * rng.uniform(.85, 1.1), y + r * math.sin(t * math.tau / k) * rng.uniform(.75, 1))
                for t in range(k)]
        slab('stepping_stone', ring, z + top, .3, stone)

def glade(rng):
    """The spring at the glade's centre, with a mossy stone rim and a ring of
    stepping stones round it, and the stones where the stream path crosses the water."""
    import bpy
    stone = stonework('stone', TEXTURES['stone'], 1.1)
    spring = [(2.1 * math.cos(i / 64 * math.tau), 2.1 * math.sin(i / 64 * math.tau)) for i in range(64)]
    obj = slab('spring', spring, .004, .1, water_material())
    obj.data.attributes.new('depth', 'FLOAT', 'POINT').data.foreach_set('value', [.9] * len(obj.data.vertices))
    bpy.ops.mesh.primitive_torus_add(major_segments=96, minor_segments=8, major_radius=2.25, minor_radius=.26,
                                     location=(0, 0, -.03))
    ring = bpy.context.object
    ring.scale.z = .25
    ring.data.materials.append(stone)
    # Lily pads on the spring too, kept small.
    pad = flat('spring_pad', (.14, .34, .07), .45)
    for k in range(6):
        t = k / 6 * math.tau + .4
        x, y, r = 1.3 * math.cos(t), 1.3 * math.sin(t), .2 + .05 * (k % 3)
        slab('spring_lily', [(x + r * math.cos(t + .4 + u * 5.6 / 16), y + r * math.sin(t + .4 + u * 5.6 / 16)) for u in range(17)]
             + [(x, y)], .012, .006, pad)
    points = []
    for i in range(16):
        t = (i + rng.uniform(.3, .7)) / 16 * math.tau
        if rng.random() > .2:
            r = 4.4 + rng.uniform(-.25, .25)
            points.append((r * math.cos(t), r * math.sin(t), 0))
    stepping_stones(points, stone, rng, (.32, .5), top=.006)
    # Across the stream where the north path crosses it.
    a0, b0 = PATHS[0][1]
    a1, b1 = PATHS[0][3]
    across = []
    for k in range(9):
        t = k / 8
        x, y = to_ground(a0 + (a1 - a0) * t, b0 + (b1 - b0) * t)
        if masks(x, y)['stream'] > .2:
            across.append((x, y, height(x, y) + .45))
    stepping_stones(across, stone, rng, (.5, .7), .12)

def village(theme):
    """The village's TRELLIS.2 treehouses, stump houses and toadstool houses."""
    import bpy
    loaded = {}
    for name, (a, b), tall, turn in BUILDINGS:
        if not tall_clear(a, b, tall):
            print('YARD_ENV skipped', name, (a, b), flush=True)
            continue
        if name not in loaded:
            loaded[name] = building(TOWN / f'{name}.glb', theme)
        coll, lo, size = loaded[name]
        x, y = to_ground(a, b)
        scale = tall / size
        inst = bpy.data.objects.new(name, None)
        inst.instance_type, inst.instance_collection = 'COLLECTION', coll
        # Sunk a little so the roots sit in the ground on a slope.
        inst.location = (x, y, height(x, y) - lo * scale - .3)
        inst.scale = (scale,) * 3
        inst.rotation_euler = (0, 0, math.radians(turn))
        bpy.context.scene.collection.objects.link(inst)

def stone_lanterns(theme):
    """Stone lanterns (a TRELLIS.2 model) where the paths leave the glade, along
    its back and left edges, lit at dusk."""
    import bpy
    coll, lo, size = building(TOWN / 'town_lantern.glb', theme)
    tall = 2.2
    scale = tall / size
    glow = flat('lantern_flame', (1, .62, .3), emit=30)
    for line in PATHS:
        (a0, b0), (a1, b1) = line[0], line[1]
        length = math.hypot(a1 - a0, b1 - b0)
        na, nb = -(b1 - b0) / length, (a1 - a0) / length
        for side in (-1.6, 1.6):
            a, b = a0 + (a1 - a0) * 2.5 / length + na * side, b0 + (b1 - b0) * 2.5 / length + nb * side
            x, y = to_ground(a, b)
            if live_distance(x, y) < 1.5 or not (y > 2 or x < -12) or not tall_clear(a, b, tall):
                continue
            z = height(x, y)
            inst = bpy.data.objects.new('stone_lantern', None)
            inst.instance_type, inst.instance_collection = 'COLLECTION', coll
            inst.location, inst.scale = (x, y, z - lo * scale), (scale,) * 3
            inst.rotation_euler = (0, 0, math.atan2(-y, -x) + math.pi / 2)
            bpy.context.scene.collection.objects.link(inst)
            if theme == 'dark':
                bpy.ops.mesh.primitive_uv_sphere_add(radius=.12, location=(x, y, z + tall * .58))
                bpy.context.object.data.materials.append(glow)
                bulb = bpy.data.objects.new('lantern_light', bpy.data.lights.new('lantern_light', 'POINT'))
                bulb.data.energy, bulb.data.color, bulb.data.shadow_soft_size = 160, (1, .6, .3), .1
                bulb.location = (x, y, z + tall * .58)
                bpy.context.scene.collection.objects.link(bulb)

def giants(s):
    """A few old flowering trees standing over the forest, where they stay off the live area."""
    import bpy
    rng = random.Random(29)
    for a, b in GIANTS:
        if not tall_clear(a, b, 16):
            continue
        x, y = to_ground(a, b)
        inst = bpy.data.objects.new('giant', None)
        inst.instance_type, inst.instance_collection = 'COLLECTION', s['jacaranda_tree']
        inst.location = (x, y, height(x, y) - .2)
        inst.rotation_euler = (0, 0, rng.uniform(0, math.tau))
        inst.scale = (rng.uniform(.9, 1.15),) * 3
        bpy.context.scene.collection.objects.link(inst)

def fireflies():
    """Dusk: small warm lights drifting over the forest floor, off the live area."""
    import bpy, bmesh
    glow = flat('firefly', (.85, 1, .3), emit=35)
    variants = []
    for k, z in enumerate((.6, 1.2, 1.9)):
        mesh = bpy.data.meshes.new(f'firefly_{k}')
        obj = bpy.data.objects.new(f'firefly_{k}', mesh)
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=1, radius=.035)
        bm.to_mesh(mesh)
        bm.free()
        mesh.materials.append(glow)
        obj.location = (0, 0, z)
        c = bpy.data.collections.new(f'firefly_{k}')
        c.objects.link(obj)
        variants.append(c)
    scatter('fireflies', variants, 'fireflies', .08, 1.5, (.8, 1.3), 71)

def haze(theme):
    """Thin air over the hills behind, so ridges pale with distance."""
    import bpy
    bpy.ops.mesh.primitive_cube_add(size=1, location=(*to_ground(0, 255), 30))
    box = bpy.context.object
    box.scale = (420, 420, 80)
    box.rotation_euler = (0, 0, math.atan2(*to_ground(0, 1)[::-1]) - math.pi / 2)
    m = bpy.data.materials.new('haze')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    nodes.remove(nodes['Principled BSDF'])
    vol = nodes.new('ShaderNodeVolumeScatter')
    vol.inputs['Color'].default_value = (.8, .9, .88, 1) if theme == 'light' else (.75, .6, .7, 1)
    vol.inputs['Density'].default_value = .006 if theme == 'light' else .004
    links.new(vol.outputs['Volume'], nodes['Material Output'].inputs['Volume'])
    box.data.materials.append(m)

def lights(theme):
    dusk = theme == 'dark'
    sky_lights(SKIES[theme], theme, .8 if dusk else .9, 3 if dusk else 3.3, 2.5 if dusk else 1.4,
               (1, .52, .32) if dusk else (1, .94, .82))

def lanterns(theme):
    """Lantern posts along the forest paths, off the live area."""
    posts = []
    for line in PATHS:
        for (a0, b0), (a1, b1) in zip(line, line[1:]):
            length = math.hypot(a1 - a0, b1 - b0)
            na, nb = -(b1 - b0) / length, (a1 - a0) / length
            for i in range(int(length / 10)):
                t = (i + .5) * 10 / length
                side = 1.5 if (len(posts) + i) % 2 else -1.5
                a, b = a0 + (a1 - a0) * t + na * side, b0 + (b1 - b0) * t + nb * side
                x, y = to_ground(a, b)
                m = masks(x, y)
                if live_distance(x, y) < 3 or not tall_clear(a, b, 3) or on_glade(x, y, 2) or m['stream'] > .1 or m['pond'] < 1.2:
                    continue
                posts.append((x, y, height(x, y)))
    lantern_posts(posts, theme)

def halls():
    import bpy
    bpy.ops.import_scene.gltf(filepath=str(ROOT / 'web/yard/assets/grove.glb'))

def build(with_halls=True, theme='light'):
    import bpy
    bpy.ops.wm.read_factory_settings(use_empty=True)
    random.seed(137)
    rng = random.Random(137)
    lights(theme)
    terrain()
    pond()
    stream()
    lilies()
    glade(rng)
    s = {a: source(a, h) for a, (h, variants) in MODELS.items() if not variants}
    v = {a: variant_sets(a) for a, (h, variants) in MODELS.items() if variants}
    broadleaf = [s['island_tree_01'], s['island_tree_02'], s['island_tree_03']]
    scatter('forest', broadleaf + [s['fir_tree_01'], s['pine_tree_01']], 'woods', .05, 3.4, (.75, 1.2), 51)
    scatter('saplings', [s['tree_small_02'], s['shrub_02']], 'under', .02, 3, (.7, 1.2), 52)
    scatter('understory', [s['shrub_04']] + v['fern_02'], 'under', .5, .9, (1.2, 2), 53)
    scatter('moss', v['moss_01'] + v['grass_medium_01'], 'under', .6, .6, (1.2, 2), 54)
    scatter('deadwood', [s['dead_tree_trunk_02'], s['tree_stump_01'], s['tree_stump_02'], s['root_cluster_01'], s['pine_roots']],
            'woods', .006, 6, (.8, 1.2), 55)
    scatter('flowers', v['celandine_01'] + v['periwinkle_plant'] + v['dandelion_01'], 'flowers', 1.0, .35, (.9, 1.5), 56)
    scatter('reeds', reeds(), 'bank', .25, .9, (.6, 1), 57)
    scatter('rocks', v['rock_moss_set_01'] + v['rock_moss_set_02'], 'rocks', .02, 2.5, (.5, 1.3), 58)
    scatter('boulders', [s['boulder_01']], 'under', .002, 9, (.8, 2), 59)
    giants(s)
    village(theme)
    stone_lanterns(theme)
    lanterns(theme)
    if theme == 'dark':
        fireflies()
    haze(theme)
    if with_halls:
        halls()

if __name__ == '__main__' and '--preview' in sys.argv:
    preview(sys.modules[__name__], 'dark' if '--dark' in sys.argv else 'light')
