"""Goblinville environment for the Yard's pre-rendered plates: a steam-powered
goblin town on stilts over a misty bog, with forested hills beyond.

Preview renders from the live camera into .cache/yard-env/:
  blender -b --factory-startup --python concept-art/guild-yard/env/goblinville_env.py -- --preview [--dark]
The live halls and characters stand on a plank deck over the water. The town's
buildings are TRELLIS.2 models made from concept images
(concept-art/goblinville-yard); everything else is Poly Haven CC0, fetched by
polyhaven.py. Layout uses the screen-aligned ground frame described in common.py.
"""
import math, random, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import polyhaven
from camera import ROOT
# plates.py and preview() call render_settings through this module.
from common import (COURTYARD_RADIUS, to_ground, to_frame, smooth, live_distance, tall_clear,
                    line_distance, surface, painted, mix, textured, source, scatter, variant_sets,
                    reeds, lights as sky_lights, lantern_posts, render_settings, preview)

TOWN = ROOT / '.cache/goblinville-yard/models'
# Sky per theme: a misty morning for light, an industrial sunset for dark.
SKIES = {'light': 'kloofendal_28d_misty_puresky', 'dark': 'industrial_sunset_puresky'}
TEXTURES = {'mud': 'brown_mud_leaves_01', 'silt': 'brown_mud_02', 'forest': 'forest_ground_04',
            'deck': 'old_planks_02', 'beam': 'dark_wooden_planks'}
MODELS = {
    'fir_tree_01': (16, False), 'pine_tree_01': (18, False), 'dead_tree_trunk': (None, False),
    'dead_tree_trunk_02': (None, False), 'tree_stump_01': (None, False), 'root_cluster_01': (None, False),
    'grass_medium_01': (None, True), 'grass_medium_02': (None, True), 'shrub_02': (1.1, False),
    'fern_02': (None, True), 'rock_moss_set_02': (None, True), 'modular_wooden_pier': (None, True),
    'wooden_bucket_01': (None, False), 'wine_barrel_01': (None, False), 'wooden_crate_01': (None, False),
    'wooden_crate_02': (None, False), 'rusted_wheel_rim_01': (None, False),
}
# The live halls are TRELLIS.2 models with their own baked textures.
SURFACES = {}
WATER_LEVEL = -1.2
DECK_RADIUS = COURTYARD_RADIUS + .9
# Deck in front of the courtyard, under the rows of sessions (Blender y = -glTF z).
DECK_FRONT = (-14.2, 14.2, -33.5, 0)

def fetch_all():
    for sky in SKIES.values():
        polyhaven.hdri(sky)
    polyhaven.model('Lantern_01')
    for asset in TEXTURES.values():
        polyhaven.texture(asset)
    for asset in MODELS:
        polyhaven.model(asset)

# --- Layout -----------------------------------------------------------------
# Boardwalks from the deck out to the town, in the screen frame.
WALKS = [[(-16, 2), (-28, 6), (-38, 10), (-50, 8)],      # west quarter
         [(16, -2), (28, -4), (40, 2), (50, 4)],         # east quarter
         [(-6, 15), (-6, 24), (-4, 30)],                 # to the factory
         [(8, -20), (20, -24), (32, -22)],               # south-east sheds
         [(-8, -20), (-20, -24), (-30, -27)]]            # south-west sheds
CHANNEL = [(0, 14), (2, 40), (-6, 70), (4, 110)]        # open water running away
# Town buildings: model, screen position, metres tall, turn (degrees).
BUILDINGS = [
    ('factory', (-4, 34), 13, 10), ('water_tower', (-30, 26), 10, -20), ('water_tower', (40, 30), 9.5, 35),
    ('crane', (22, 34), 11, -30), ('crane', (-52, 30), 10, 25),
    ('town_house_a', (-52, 8), 8.5, 30), ('town_house_b', (-38, 14), 7, 5), ('town_house_c', (-26, 20), 5, -15),
    ('town_house_a', (50, 4), 8, -25), ('town_house_b', (60, 16), 7, -5), ('town_house_c', (32, 16), 5, 20),
    ('town_house_c', (34, -22), 5, -35), ('town_house_b', (-48, -12), 7, 40), ('town_house_a', (-70, 26), 9, 10),
    ('town_house_c', (-30, -28), 4.5, 60), ('town_house_b', (46, -18), 6.5, -40),
]
STEAM = {'factory', 'town_house_c', 'town_house_a'}

def on_deck(x, y, margin=0):
    x0, x1, y0, y1 = DECK_FRONT
    in_front = x0 - margin <= x <= x1 + margin and y0 - margin <= y <= y1 + margin
    return math.hypot(x, y) <= DECK_RADIUS + margin or in_front

def deck_distance(x, y):
    x0, x1, y0, y1 = DECK_FRONT
    ring = math.hypot(x, y) - DECK_RADIUS
    box = math.hypot(max(x0 - x, 0, x - x1), max(y0 - y, 0, y - y1))
    return min(ring, box) if not on_deck(x, y) else 0

def masks(x, y):
    from mathutils import noise, Vector
    a, b = to_frame(x, y)
    n = noise.noise(Vector((x / 22, y / 22, 4.1)))
    hills = max(smooth(24, 46, b + n * 8), smooth(70, 100, abs(a) + n * 10))
    channel = 1 - smooth(4, 12, line_distance([CHANNEL], a, b) + n * 3)
    islands = smooth(.05, .3, noise.noise(Vector((x / 14, y / 14, 1.7))) + n * .2) * (1 - channel)
    near = smooth(2, 7, deck_distance(x, y))
    land = max(hills, islands * near)
    walk = 1 - smooth(1.2, 2.2, line_distance(WALKS, a, b))
    clear = 1 if tall_clear(a, b) else 0
    return {'land': land, 'hills': hills, 'islands': islands * near, 'channel': channel,
            'woods': smooth(.5, .9, hills) * clear, 'hillside': smooth(.2, .6, hills), 'deadwood': islands * near * (1 - walk) * smooth(.2, .5, n + .3),
            'tussock': smooth(.1, .5, islands) * near * (1 - walk), 'reeds': smooth(.0, .25, islands) * (1 - smooth(.25, .6, islands)) * near,
            'mud': smooth(.0, .4, islands) * (1 - smooth(.4, .9, islands)), 'debris': near * (1 - land) * (1 - walk)}

def height(x, y):
    from mathutils import noise, Vector
    a, b = to_frame(x, y)
    m = masks(x, y)
    bed = WATER_LEVEL - .7 + noise.fractal(Vector((x / 30, y / 30, .4)), 1.0, 2.0, 4) * .25
    island = WATER_LEVEL + .15 + noise.noise(Vector((x / 6, y / 6, 2.2))) * .12
    hill = WATER_LEVEL + .4 + smooth(24, 70, b) * 20 + smooth(70, 130, abs(a)) * 9 \
        + noise.fractal(Vector((x / 60, y / 60, .3)), 1.0, 2.0, 5) * 2.5
    h = bed + (island - bed) * smooth(0, .4, m['islands'])
    return h + (hill - h) * m['hills']

# --- Materials --------------------------------------------------------------
def ground_material():
    """Lakebed silt, mud flats, marsh grass and forest floor, blended by masks."""
    import bpy
    m = bpy.data.materials.new('ground')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = nodes['Principled BSDF']
    coord = nodes.new('ShaderNodeTexCoord').outputs['Object']
    layers = surface(nodes, links, TEXTURES['silt'], 4, coord)
    def over(attribute, top):
        nonlocal layers
        attr = nodes.new('ShaderNodeAttribute')
        attr.attribute_name = attribute
        layers = tuple(mix(nodes, links, kind, attr.outputs['Fac'], low, high)
                       for kind, low, high in zip(('RGBA', 'FLOAT', 'VECTOR'), layers, top))
    over('mud', surface(nodes, links, TEXTURES['mud'], 3, coord))
    marsh = painted(nodes, links, 'meadow', 6, coord, dry=(1.05, .95, .6, 1))
    olive = nodes.new('ShaderNodeMix')
    olive.data_type, olive.blend_type = 'RGBA', 'MULTIPLY'
    olive.inputs['Factor'].default_value = 1
    links.new(marsh[0], olive.inputs[6])
    olive.inputs[7].default_value = (.8, .85, .6, 1)
    over('tussock', (olive.outputs[2], marsh[1], marsh[2]))
    over('hills', painted(nodes, links, 'meadow', 7, coord))
    over('woods', surface(nodes, links, TEXTURES['forest'], 3.5, coord))
    color, rough, normal = layers
    links.new(color, bsdf.inputs['Base Color'])
    links.new(rough, bsdf.inputs['Roughness'])
    links.new(normal, bsdf.inputs['Normal'])
    return m

def water_material(theme):
    """Still, dark bog water: tea-brown over the shallows, mirror-like and
    lightly filmed with algae where deep."""
    import bpy
    m = bpy.data.materials.new('water')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = nodes['Principled BSDF']
    depth = nodes.new('ShaderNodeAttribute')
    depth.attribute_name = 'depth'
    deep = nodes.new('ShaderNodeMapRange')
    deep.inputs['From Min'].default_value, deep.inputs['From Max'].default_value = 0, 1.2
    links.new(depth.outputs['Fac'], deep.inputs['Value'])
    tint = nodes.new('ShaderNodeMix')
    tint.data_type = 'RGBA'
    links.new(deep.outputs['Result'], tint.inputs['Factor'])
    tint.inputs[6].default_value = (.055, .06, .03, 1)
    tint.inputs[7].default_value = (.008, .014, .011, 1)
    film = nodes.new('ShaderNodeTexNoise')
    film.inputs['Scale'].default_value = .09
    film.inputs['Detail'].default_value = 6
    algae = nodes.new('ShaderNodeMapRange')
    algae.inputs['From Min'].default_value, algae.inputs['From Max'].default_value = .55, .7
    algae.inputs['To Max'].default_value = .55
    links.new(film.outputs['Fac'], algae.inputs['Value'])
    green = nodes.new('ShaderNodeMix')
    green.data_type = 'RGBA'
    links.new(algae.outputs['Result'], green.inputs['Factor'])
    links.new(tint.outputs[2], green.inputs[6])
    green.inputs[7].default_value = (.05, .07, .025, 1)
    links.new(green.outputs[2], bsdf.inputs['Base Color'])
    rough = nodes.new('ShaderNodeMapRange')
    rough.inputs['To Min'].default_value, rough.inputs['To Max'].default_value = .03, .45
    links.new(algae.outputs['Result'], rough.inputs['Value'])
    links.new(rough.outputs['Result'], bsdf.inputs['Roughness'])
    bsdf.inputs['IOR'].default_value = 1.33
    ripples = nodes.new('ShaderNodeTexNoise')
    ripples.inputs['Scale'].default_value = 2.2
    ripples.inputs['Detail'].default_value = 6
    bump = nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = .04
    links.new(ripples.outputs['Fac'], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
    return m

def brass_material():
    """Worn brass: warm metal, polished where feet pass, dull in the grain."""
    import bpy
    m = bpy.data.materials.new('brass')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (.78, .52, .22, 1)
    bsdf.inputs['Metallic'].default_value = .9
    wear = nodes.new('ShaderNodeTexNoise')
    wear.inputs['Scale'].default_value = 6
    wear.inputs['Detail'].default_value = 8
    rough = nodes.new('ShaderNodeMapRange')
    rough.inputs['To Min'].default_value, rough.inputs['To Max'].default_value = .25, .6
    links.new(wear.outputs['Fac'], rough.inputs['Value'])
    links.new(rough.outputs['Result'], bsdf.inputs['Roughness'])
    return m

def lit_windows(material, theme):
    """At dusk, warm window glass in a generated texture glows: bright, saturated,
    orange-to-yellow texels become emission."""
    if theme != 'dark' or not material or not material.node_tree:
        return
    nodes, links = material.node_tree.nodes, material.node_tree.links
    bsdf = next((n for n in nodes if n.type == 'BSDF_PRINCIPLED'), None)
    base = bsdf and bsdf.inputs['Base Color'].links
    if not base:
        return
    color = base[0].from_socket
    hsv = nodes.new('ShaderNodeSeparateColor')
    hsv.mode = 'HSV'
    links.new(color, hsv.inputs['Color'])
    def band(socket, lo, hi):
        r = nodes.new('ShaderNodeMapRange')
        r.inputs['From Min'].default_value, r.inputs['From Max'].default_value = lo, hi
        links.new(socket, r.inputs['Value'])
        return r.outputs['Result']
    def times(a, b):
        n = nodes.new('ShaderNodeMath')
        n.operation = 'MULTIPLY'
        links.new(a, n.inputs[0]); links.new(b, n.inputs[1])
        return n.outputs['Value']
    warm = band(hsv.outputs['Red'], .17, .06)  # 0 at yellow-green, 1 at orange
    glow = times(times(band(hsv.outputs['Blue'], .55, .8), band(hsv.outputs['Green'], .35, .6)), warm)
    links.new(color, bsdf.inputs['Emission Color'])
    strength = nodes.new('ShaderNodeMath')
    strength.operation = 'MULTIPLY'
    strength.inputs[1].default_value = 18
    links.new(glow, strength.inputs[0])
    links.new(strength.outputs['Value'], bsdf.inputs['Emission Strength'])

# --- Geometry ---------------------------------------------------------------
def terrain():
    import bpy, bmesh
    size, cuts = 440, 640
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=cuts, y_segments=cuts, size=size / 2)
    mesh = bpy.data.meshes.new('terrain')
    bm.to_mesh(mesh)
    bm.free()
    layers = {}
    for v in mesh.vertices:
        x, y = v.co.x, v.co.y
        v.co.z = height(x, y)
        for key, value in masks(x, y).items():
            layers.setdefault(key, []).append(value)
    for key, values in layers.items():
        mesh.attributes.new(key, 'FLOAT', 'POINT').data.foreach_set('value', values)
    mesh.shade_smooth()
    obj = bpy.data.objects.new('terrain', mesh)
    obj.data.materials.append(ground_material())
    bpy.context.scene.collection.objects.link(obj)
    return obj

def water(theme):
    import bpy, bmesh
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=300, y_segments=300, size=220)
    mesh = bpy.data.meshes.new('water')
    bm.to_mesh(mesh)
    bm.free()
    depths = []
    for v in mesh.vertices:
        v.co.z = WATER_LEVEL
        depths.append(max(0, WATER_LEVEL - height(v.co.x, v.co.y)))
    mesh.attributes.new('depth', 'FLOAT', 'POINT').data.foreach_set('value', depths)
    obj = bpy.data.objects.new('water', mesh)
    obj.data.materials.append(water_material(theme))
    bpy.context.scene.collection.objects.link(obj)

def slab(name, verts2d, top, thick, material):
    """A flat prism from an outline, its top at `top`."""
    import bpy, bmesh
    bm = bmesh.new()
    lower = [bm.verts.new((x, y, top - thick)) for x, y in verts2d]
    upper = [bm.verts.new((x, y, top)) for x, y in verts2d]
    bm.faces.new(upper)
    bm.faces.new(list(reversed(lower)))
    n = len(verts2d)
    for i in range(n):
        bm.faces.new((lower[i], lower[(i + 1) % n], upper[(i + 1) % n], upper[i]))
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    obj.data.materials.append(material)
    bpy.context.scene.collection.objects.link(obj)
    return obj

def deck_outline(step=.5):
    """The deck's edge: the courtyard circle joined to the rectangle in front."""
    x0, x1, y0, y1 = DECK_FRONT
    pts = []
    a0 = math.asin(x1 / DECK_RADIUS)
    # Circle from the rectangle's right edge, round the back, to its left edge.
    start, end = -math.pi / 2 + a0, 3 * math.pi / 2 - a0
    n = int((end - start) * DECK_RADIUS / step)
    for i in range(n + 1):
        t = start + (end - start) * i / n
        pts.append((DECK_RADIUS * math.cos(t), DECK_RADIUS * math.sin(t)))
    pts += [(x0, y0), (x1, y0)]
    return pts

def deck_material():
    """Weathered planks sampled at two scales and angles, blended by noise and
    darkened in broad patches, so a deck this size shows no repeat."""
    import bpy
    m = bpy.data.materials.new('deck')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = nodes['Principled BSDF']
    coord = nodes.new('ShaderNodeTexCoord').outputs['Object']
    turned = nodes.new('ShaderNodeVectorRotate')
    turned.rotation_type = 'Z_AXIS'
    turned.inputs['Angle'].default_value = math.pi
    links.new(coord, turned.inputs['Vector'])
    near = surface(nodes, links, TEXTURES['deck'], 2.4, coord)
    far = surface(nodes, links, TEXTURES['deck'], 3.1, turned.outputs['Vector'])
    def noise(size, seed):
        node = nodes.new('ShaderNodeTexNoise')
        node.noise_dimensions = '4D'
        node.inputs['Scale'].default_value = 1 / size
        node.inputs['W'].default_value = seed
        links.new(coord, node.inputs['Vector'])
        return node.outputs['Fac']
    pick = nodes.new('ShaderNodeMapRange')
    pick.inputs['From Min'].default_value, pick.inputs['From Max'].default_value = .45, .55
    links.new(noise(14, 1), pick.inputs['Value'])
    color, rough, normal = (mix(nodes, links, kind, pick.outputs['Result'], a, b)
                            for kind, a, b in zip(('RGBA', 'FLOAT', 'VECTOR'), near, far))
    wear = nodes.new('ShaderNodeMapRange')
    wear.inputs['To Min'].default_value, wear.inputs['To Max'].default_value = .62, 1.0
    links.new(noise(9, 2), wear.inputs['Value'])
    shade = nodes.new('ShaderNodeMix')
    shade.data_type, shade.blend_type = 'RGBA', 'MULTIPLY'
    shade.inputs['Factor'].default_value = 1
    links.new(color, shade.inputs[6])
    links.new(wear.outputs['Result'], shade.inputs[7])
    links.new(shade.outputs[2], bsdf.inputs['Base Color'])
    links.new(rough, bsdf.inputs['Roughness'])
    links.new(normal, bsdf.inputs['Normal'])
    return m

def deck():
    """The plank deck the live halls and characters stand on, on stilts over
    the water, with a brass cog inlaid at its centre."""
    import bpy
    planks = deck_material()
    slab('deck', deck_outline(), 0, .32, planks)
    beam = textured('beam', TEXTURES['beam'], 1.2)
    outline = deck_outline(2.1)
    for i, (x, y) in enumerate(outline):
        bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=.16, depth=3.4, location=(x * 1.004, y * 1.004, -1.6))
        post = bpy.context.object
        post.rotation_euler = (random.Random(i).uniform(-.03, .03), random.Random(i + 9).uniform(-.03, .03), 0)
        post.data.materials.append(beam)
    # Fascia board round the edge.
    edge = deck_outline(.5)
    for (xa, ya), (xb, yb) in zip(edge, edge[1:] + edge[:1]):
        length = math.hypot(xb - xa, yb - ya)
        bpy.ops.mesh.primitive_cube_add(size=1, location=((xa + xb) / 2, (ya + yb) / 2, -.26))
        board = bpy.context.object
        board.scale = (length + .02, .09, .34)
        board.rotation_euler = (0, 0, math.atan2(yb - ya, xb - xa))
        board.data.materials.append(beam)
    # Joists across the front deck and a beam round the courtyard break up the planking.
    x0, x1, y0, y1 = DECK_FRONT
    for k in range(1, int((y1 - y0) / 4)):
        y = y1 - k * 4
        if y > -COURTYARD_RADIUS - .5:  # inside the courtyard's ring
            continue
        bpy.ops.mesh.primitive_cube_add(size=1, location=(0, y, .004))
        joist = bpy.context.object
        joist.scale = (x1 - x0 - .1, .14, .03)
        joist.data.materials.append(beam)
    bpy.ops.mesh.primitive_torus_add(major_segments=256, minor_segments=8, major_radius=COURTYARD_RADIUS + .2,
                                     minor_radius=.09, location=(0, 0, .0))
    border = bpy.context.object
    border.scale.z = .35
    border.data.materials.append(beam)
    railing(beam)
    # Brass cog inlay, flush with the planks.
    teeth, outer, inner = 18, 2.3, 2.0
    cog = []
    for i in range(teeth * 4):
        t = i / (teeth * 4) * math.tau
        r = outer if (i % 4) in (1, 2) else inner
        cog.append((r * math.cos(t), r * math.sin(t)))
    slab('cog', cog, .006, .05, brass_material())
    ring = [(1.2 * math.cos(i / 48 * math.tau), 1.2 * math.sin(i / 48 * math.tau)) for i in range(48)]
    slab('cog_hub', ring, .008, .05, textured('hub', TEXTURES['beam'], .8))

def railing(material):
    """Posts and a sagging rope along the deck's back and sides; the front edge,
    toward the camera, stays open."""
    import bpy
    rope = bpy.data.materials.new('rope')
    rope.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (.18, .13, .08, 1)
    rope.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = .9
    posts = [(x, y) for x, y in deck_outline(2.6) if y > DECK_FRONT[2] + 1]
    for x, y in posts:
        bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=.07, depth=.95, location=(x, y, .47))
        bpy.context.object.data.materials.append(material)
    for (xa, ya), (xb, yb) in zip(posts, posts[1:]):
        if math.hypot(xb - xa, yb - ya) > 3.5:
            continue
        curve = bpy.data.curves.new('rope', 'CURVE')
        curve.dimensions, curve.bevel_depth, curve.bevel_resolution = '3D', .022, 2
        spline = curve.splines.new('POLY')
        spline.points.add(6)
        for i, point in enumerate(spline.points):
            t = i / 6
            point.co = (xa + (xb - xa) * t, ya + (yb - ya) * t, .82 - .16 * math.sin(math.pi * t), 1)
        obj = bpy.data.objects.new('rope', curve)
        obj.data.materials.append(rope)
        bpy.context.scene.collection.objects.link(obj)

def walk_segments():
    """Boardwalk sections along WALKS at deck height, skipping the deck itself."""
    import bpy
    path = polyhaven.model('modular_wooden_pier')
    with bpy.data.libraries.load(str(path)) as (src, dst):
        dst.objects = [n for n in src.objects if n.endswith('section_02')]
    section = dst.objects[0]
    top = max(c[2] for c in section.bound_box)
    for line in WALKS:
        for (a0, b0), (a1, b1) in zip(line, line[1:]):
            (x0, y0), (x1, y1) = to_ground(a0, b0), to_ground(a1, b1)
            length, step = math.hypot(x1 - x0, y1 - y0), 2.9
            heading = math.atan2(y1 - y0, x1 - x0) - math.pi / 2
            for i in range(int(length / step) + 1):
                t = i * step / length
                x, y = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
                if on_deck(x, y, -.5):
                    continue
                obj = section.copy()
                obj.location = (x, y, -.02 - top)
                obj.rotation_euler = (0, 0, heading)
                bpy.context.scene.collection.objects.link(obj)

def town(theme):
    """The town's TRELLIS.2 buildings, stood in the water on their own stilts."""
    import bpy
    from mathutils import Vector
    loaded = {}
    for name, (a, b), tall, turn in BUILDINGS:
        if not tall_clear(a, b, tall):
            print('YARD_ENV skipped', name, (a, b), flush=True)
            continue
        if name not in loaded:
            before = set(bpy.data.objects)
            bpy.ops.import_scene.gltf(filepath=str(TOWN / f'{name}.glb'))
            parts = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
            coll = bpy.data.collections.new(name)
            for o in parts:
                for c in o.users_collection:
                    c.objects.unlink(o)
                coll.objects.link(o)
                for m in o.data.materials:
                    lit_windows(m, theme)
            lo = min((o.matrix_world @ Vector(c)).z for o in parts for c in o.bound_box)
            hi = max((o.matrix_world @ Vector(c)).z for o in parts for c in o.bound_box)
            loaded[name] = (coll, lo, hi - lo)
        coll, lo, size = loaded[name]
        x, y = to_ground(a, b)
        scale = tall / size
        inst = bpy.data.objects.new(name, None)
        inst.instance_type, inst.instance_collection = 'COLLECTION', coll
        ground = max(height(x, y), WATER_LEVEL - .5)
        inst.location = (x, y, ground - lo * scale - .3)
        inst.scale = (scale,) * 3
        inst.rotation_euler = (0, 0, math.radians(turn))
        bpy.context.scene.collection.objects.link(inst)
        if name in STEAM:
            steam(x, y, ground - .3 + tall * .96, tall, theme)

def steam(x, y, z, tall, theme):
    """A soft plume drifting up from a chimney top."""
    import bpy
    bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=tall * .05, radius2=tall * .22, depth=tall * .7,
                                    location=(x, y, z + tall * .32))
    plume = bpy.context.object
    plume.rotation_euler = (.12, -.18, 0)
    m = bpy.data.materials.new('steam')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    nodes.remove(nodes['Principled BSDF'])
    vol = nodes.new('ShaderNodeVolumePrincipled')
    vol.inputs['Color'].default_value = (.9, .9, .88, 1) if theme == 'light' else (.75, .62, .55, 1)
    coord = nodes.new('ShaderNodeTexCoord')
    noise = nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 2.2
    noise.inputs['Detail'].default_value = 5
    links.new(coord.outputs['Generated'], noise.inputs['Vector'])
    fade = nodes.new('ShaderNodeSeparateXYZ')
    links.new(coord.outputs['Generated'], fade.inputs['Vector'])
    thin = nodes.new('ShaderNodeMapRange')
    thin.inputs['From Min'].default_value, thin.inputs['From Max'].default_value = 0, 1
    thin.inputs['To Min'].default_value, thin.inputs['To Max'].default_value = 1.4, 0
    links.new(fade.outputs['Z'], thin.inputs['Value'])
    shape = nodes.new('ShaderNodeMapRange')
    shape.inputs['From Min'].default_value, shape.inputs['From Max'].default_value = .4, .75
    links.new(noise.outputs['Fac'], shape.inputs['Value'])
    density = nodes.new('ShaderNodeMath')
    density.operation = 'MULTIPLY'
    links.new(shape.outputs['Result'], density.inputs[0])
    links.new(thin.outputs['Result'], density.inputs[1])
    links.new(density.outputs['Value'], vol.inputs['Density'])
    links.new(vol.outputs['Volume'], nodes['Material Output'].inputs['Volume'])
    plume.data.materials.append(m)

def ground_fog(theme):
    """Low mist over the bog, thinning to nothing over the deck so the live
    halls and characters stand in clear air."""
    import bpy
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, WATER_LEVEL + 2.2))
    fog = bpy.context.object
    fog.scale = (420, 420, 5)
    m = bpy.data.materials.new('fog')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    nodes.remove(nodes['Principled BSDF'])
    vol = nodes.new('ShaderNodeVolumeScatter')
    vol.inputs['Color'].default_value = (.85, .9, .9, 1) if theme == 'light' else (.8, .7, .66, 1)
    coord = nodes.new('ShaderNodeTexCoord')
    xyz = nodes.new('ShaderNodeSeparateXYZ')
    links.new(coord.outputs['Object'], xyz.inputs['Vector'])
    low = nodes.new('ShaderNodeMapRange')  # thick at the water, gone by the top
    low.inputs['From Min'].default_value, low.inputs['From Max'].default_value = -.5, .3
    low.inputs['To Min'].default_value, low.inputs['To Max'].default_value = 1, 0
    links.new(xyz.outputs['Z'], low.inputs['Value'])
    flat = nodes.new('ShaderNodeCombineXYZ')
    links.new(xyz.outputs['X'], flat.inputs['X'])
    links.new(xyz.outputs['Y'], flat.inputs['Y'])
    radius = nodes.new('ShaderNodeVectorMath')
    radius.operation = 'LENGTH'
    links.new(flat.outputs['Vector'], radius.inputs[0])
    far = nodes.new('ShaderNodeMapRange')  # object units: the cube spans 420 m
    far.inputs['From Min'].default_value, far.inputs['From Max'].default_value = 30 / 420, 70 / 420
    links.new(radius.outputs['Value'], far.inputs['Value'])
    wisps = nodes.new('ShaderNodeTexNoise')
    wisps.inputs['Scale'].default_value = 14
    wisps.inputs['Detail'].default_value = 3
    links.new(coord.outputs['Object'], wisps.inputs['Vector'])
    density = nodes.new('ShaderNodeMath')
    density.operation = 'MULTIPLY'
    links.new(low.outputs['Result'], density.inputs[0])
    links.new(far.outputs['Result'], density.inputs[1])
    patchy = nodes.new('ShaderNodeMath')
    patchy.operation = 'MULTIPLY'
    links.new(density.outputs['Value'], patchy.inputs[0])
    links.new(wisps.outputs['Fac'], patchy.inputs[1])
    scale = nodes.new('ShaderNodeMath')
    scale.operation = 'MULTIPLY'
    scale.inputs[1].default_value = .05 if theme == 'light' else .035
    links.new(patchy.outputs['Value'], scale.inputs[0])
    links.new(scale.outputs['Value'], vol.inputs['Density'])
    links.new(vol.outputs['Volume'], nodes['Material Output'].inputs['Volume'])
    fog.data.materials.append(m)

def props():
    """Barrels, crates and scrap along the boardwalks, off the live area."""
    import bpy
    rng = random.Random(41)
    kinds = [source(n, None) for n in ('wine_barrel_01', 'wine_barrel_01', 'wooden_bucket_01', 'wooden_crate_01', 'wooden_crate_02', 'rusted_wheel_rim_01')]
    for line in WALKS:
        for (a0, b0), (a1, b1) in zip(line, line[1:]):
            for k in range(3):
                t = rng.uniform(.1, .9)
                a, b = a0 + (a1 - a0) * t, b0 + (b1 - b0) * t
                side = rng.choice((-1, 1)) * 1.15
                length = math.hypot(a1 - a0, b1 - b0)
                a, b = a - (b1 - b0) / length * side, b + (a1 - a0) / length * side
                x, y = to_ground(a, b)
                if live_distance(x, y) < 3 or on_deck(x, y, 1):
                    continue
                for j in range(rng.randint(1, 3)):
                    inst = bpy.data.objects.new('prop', None)
                    inst.instance_type, inst.instance_collection = 'COLLECTION', rng.choice(kinds)
                    inst.location = (x + rng.uniform(-.5, .5), y + rng.uniform(-.5, .5), 0)
                    inst.rotation_euler = (0, 0, rng.uniform(0, math.tau))
                    bpy.context.scene.collection.objects.link(inst)

def lights(theme):
    dusk = theme == 'dark'
    sky_lights(SKIES[theme], theme, .75 if dusk else .85, 3.8 if dusk else 3.2, 2.5 if dusk else 1.6,
               (1, .5, .26) if dusk else (1, .93, .82))

def lanterns(theme):
    """Lantern posts along the boardwalks, and along the deck's back and left
    edges: those stand farther from the camera than anything on the deck, so
    live models correctly draw in front of them."""
    posts = [(x * 1.03, y * 1.03, 0) for i, (x, y) in enumerate(deck_outline(2.6))
             if i % 3 == 1 and (y > 3 or (x < -12 and y > DECK_FRONT[2] + 2))]
    for line in WALKS:
        for (a0, b0), (a1, b1) in zip(line, line[1:]):
            length = math.hypot(a1 - a0, b1 - b0)
            na, nb = -(b1 - b0) / length, (a1 - a0) / length
            for i in range(int(length / 10)):
                t = (i + .5) * 10 / length
                side = 1.25 if (len(posts) + i) % 2 else -1.25
                a, b = a0 + (a1 - a0) * t + na * side, b0 + (b1 - b0) * t + nb * side
                x, y = to_ground(a, b)
                if live_distance(x, y) < 3 or not tall_clear(a, b, 3) or on_deck(x, y, .5):
                    continue
                posts.append((x, y, -.02))
    lantern_posts(posts, theme)

def halls():
    import bpy
    bpy.ops.import_scene.gltf(filepath=str(ROOT / 'web/yard/assets/goblinville.glb'))

def build(with_halls=True, theme='light'):
    import bpy
    bpy.ops.wm.read_factory_settings(use_empty=True)
    random.seed(714)
    lights(theme)
    terrain()
    water(theme)
    deck()
    s = {a: source(a, h) for a, (h, variants) in MODELS.items() if not variants}
    v = {a: variant_sets(a) for a, (h, variants) in MODELS.items() if variants}
    scatter('conifers', [s['fir_tree_01'], s['pine_tree_01']], 'woods', .05, 3.4, (.7, 1.25), 31)
    scatter('understory', [s['shrub_02']] + v['fern_02'], 'woods', .1, 1.5, (.8, 1.5), 32)
    scatter('hill_growth', [s['shrub_02']] + v['fern_02'] + v['grass_medium_01'], 'hillside', .25, .9, (.8, 1.6), 38)
    scatter('deadwood', [s['dead_tree_trunk'], s['dead_tree_trunk_02'], s['tree_stump_01'], s['root_cluster_01']],
            'deadwood', .012, 5, (.6, 1.1), 33)
    scatter('tussocks', v['grass_medium_01'] + v['grass_medium_02'], 'tussock', 2.5, .35, (.8, 1.7), 34)
    scatter('reeds', reeds(), 'reeds', 1.4, .55, (.8, 1.4), 35)
    scatter('marsh_shrubs', [s['shrub_02']] + v['fern_02'], 'tussock', .01, 3, (.7, 1.3), 37)
    scatter('rocks', v['rock_moss_set_02'], 'mud', .004, 5, (.4, .9), 36)
    walk_segments()
    town(theme)
    props()
    lanterns(theme)
    ground_fog(theme)
    if with_halls:
        halls()

if __name__ == '__main__' and '--preview' in sys.argv:
    preview(sys.modules[__name__], 'dark' if '--dark' in sys.argv else 'light')
