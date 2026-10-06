"""Gnomeland environment for the Yard's pre-rendered plates: a timber-and-stone
mountain village of gnome builders, with a lake, a waterfall off a cliff and
mountains beyond.

Preview renders from the live camera into .cache/yard-env/:
  blender -b --factory-startup --python concept-art/guild-yard/env/gnomeland_env.py -- --preview [--dark]
The live halls and characters stand on a level cobbled square at y = 0.
Cobbled roads lead from it between the village's cottages, which are TRELLIS.2
models made from concept images (concept-art/gnomeland-yard); everything else
is Poly Haven CC0, fetched by polyhaven.py. Layout uses the screen-aligned
ground frame described in common.py.
"""
import math, random, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import polyhaven
from camera import ROOT
# plates.py and preview() call render_settings through this module.
from common import (COURTYARD_RADIUS, frame, to_ground, to_frame, smooth, play_distance, live_distance, tall_clear,
                    line_distance, surface, painted, mix, textured, source, scatter, variant_sets, reeds,
                    lights as sky_lights, lantern_posts, slab, building, render_settings, preview)

TOWN = ROOT / '.cache/gnomeland-yard/models'
# Sky per theme: a soft misty morning for light, dusk with the moon rising for dark.
SKIES = {'light': 'kloofendal_misty_morning_puresky', 'dark': 'qwantani_moonrise_puresky'}
TEXTURES = {'square': 'cobblestone_floor_04', 'road': 'grassy_cobblestone', 'kerb': 'castle_wall_slates',
            'wall': 'rustic_stone_wall', 'cliff': 'lichen_rock', 'scree': 'rocky_trail', 'forest': 'forest_ground_04',
            'shore': 'river_small_rocks', 'beam': 'dark_wooden_planks'}
# Model, target height in metres (None keeps Poly Haven's real size), and
# whether the .blend holds variants to pick between rather than one model.
MODELS = {
    'fir_tree_01': (16, False), 'pine_tree_01': (18, False), 'island_tree_01': (9, False),
    'island_tree_02': (8, False), 'tree_small_02': (4.2, False),
    'shrub_01': (1.3, False), 'shrub_02': (1.1, False), 'shrub_04': (1.2, False),
    'fern_02': (None, True), 'grass_medium_01': (None, True),
    'celandine_01': (None, True), 'dandelion_01': (None, True), 'rock_moss_set_01': (None, True),
    'rock_moss_set_02': (None, True), 'boulder_01': (None, False), 'modular_wooden_pier': (None, True),
    'wine_barrel_01': (None, False), 'wooden_crate_01': (None, False),
    'wooden_bucket_01': (None, False), 'WoodenTable_01': (None, False), 'wooden_stool_01': (None, False),
    'garden_gnome': (None, False),
}
# The live halls are TRELLIS.2 models with their own baked textures.
SURFACES = {}
WATER_LEVEL = -.8
SQUARE_RADIUS = COURTYARD_RADIUS + .9
# Square in front of the courtyard, under the rows of sessions (Blender y = -glTF z).
SQUARE_FRONT = (-14.2, 14.2, -33.5, 0)

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
LAKE = (0, 30.5, 36, 6.5)       # centre a, b and radii
CLIFF_B = 38.5                  # foot of the cliff behind the lake
CLIFF_HEIGHT = 18
FALL_A = 8                      # where the river leaves the cliff
RIVER = [(FALL_A, CLIFF_B + 1), (FALL_A + 5, CLIFF_B + 14), (FALL_A + 2, CLIFF_B + 30), (FALL_A + 12, CLIFF_B + 60)]
ROADS = [[(0, 14), (1, 19), (-1, 24.5)],                       # up to the lake shore
         [(-15, 1), (-28, 4), (-44, 2), (-62, 6), (-90, 4)],  # west, past the mill
         [(15, -2), (28, -5), (44, -2), (64, -6), (95, -4)],  # east
         [(-10, -17), (-22, -30), (-26, -46), (-36, -70)],    # south-west, toward the viewer
         [(10, -19), (24, -32), (30, -50), (44, -72)]]        # south-east
# Village buildings: model, screen position, metres tall, turn (degrees).
BUILDINGS = [
    # Either side of the lake road, behind the square.
    ('town_cottage_a', (-8.5, 19), 7.5, 20), ('town_tower', (-16, 21), 11, 0), ('town_cottage_b', (-24, 18.5), 6.5, 10),
    ('town_cottage_b', (8.5, 18.5), 6.5, -20), ('town_workshop', (16, 20.5), 6, -35), ('town_cottage_a', (24, 18), 8, -10),
    ('town_mill', (-33, 22), 8, 30),
    # Along the west road.
    ('town_cottage_a', (-23, 8), 8, 50), ('town_workshop', (-31, 10), 6, 30), ('town_cottage_b', (-40, 9), 6.5, 15),
    ('town_cottage_a', (-49, 11), 8.5, 35), ('town_tower', (-57, 14), 12.5, 0), ('town_cottage_b', (-35, -6), 6.5, 70),
    ('town_cottage_a', (-46, -4), 8, 55), ('town_workshop', (-56, -2), 6, 40), ('town_cottage_b', (-66, 4), 6.5, 25),
    # Along the east road.
    ('town_cottage_b', (23, 6), 6.5, -50), ('town_cottage_a', (31, 9), 8, -30), ('town_tower', (40, 12), 12, 0),
    ('town_workshop', (48, 7), 6, -25), ('town_cottage_a', (57, 9), 8.5, -40), ('town_cottage_b', (34, -9), 6.5, -65),
    ('town_cottage_a', (45, -8), 8, -55), ('town_cottage_b', (56, -12), 6.5, -45), ('town_mill', (66, 2), 8, -20),
    # Down the southern roads, toward the viewer.
    ('town_cottage_b', (-30, -26), 6.5, 60), ('town_cottage_a', (-40, -36), 8, 45), ('town_workshop', (-46, -50), 6, 30),
    ('town_cottage_b', (33, -28), 6.5, -60), ('town_cottage_a', (42, -40), 8, -40), ('town_tower', (52, -52), 12, 0),
]

def on_square(x, y, margin=0):
    x0, x1, y0, y1 = SQUARE_FRONT
    in_front = x0 - margin <= x <= x1 + margin and y0 - margin <= y <= y1 + margin
    return math.hypot(x, y) <= SQUARE_RADIUS + margin or in_front

def square_distance(x, y):
    x0, x1, y0, y1 = SQUARE_FRONT
    ring = math.hypot(x, y) - SQUARE_RADIUS
    box = math.hypot(max(x0 - x, 0, x - x1), max(y0 - y, 0, y - y1))
    return 0 if on_square(x, y) else min(ring, box)

def lake_shape(a, b):
    from mathutils import noise, Vector
    ca, cb, ra, rb = LAKE
    wobble = noise.noise(Vector((a / 14, b / 14, 2.6))) * .12
    return ((a - ca) / ra) ** 2 + ((b - cb) / rb) ** 2 + wobble

def cliff_line(a):
    """The cliff foot's b at screen position a: it bows round behind the lake."""
    from mathutils import noise, Vector
    return CLIFF_B + (a / 40) ** 2 * 4 + noise.noise(Vector((a / 9, 0, 3.3))) * 1.4

def masks(x, y):
    from mathutils import noise, Vector
    a, b = to_frame(x, y)
    n = noise.noise(Vector((x / 25, y / 25, 7.3)))
    lake = lake_shape(a, b)
    road = 1 - smooth(1.1, 1.9, line_distance(ROADS, a, b) + n * .25) if not on_square(x, y, .4) else 0
    shore = 1 - smooth(.9, 1.15, lake + n * .05)
    rise = b - cliff_line(a)
    cliff = (1 - smooth(.5, 3.5, abs(rise - 1.5))) * smooth(-.2, .2, rise + 2)
    plateau = smooth(2, 4, rise)
    river = 1 - smooth(1.2, 2.6, line_distance([RIVER], a, b)) if rise > 1 else 0
    clear = 1 if tall_clear(a, b) else 0
    # Conifers climb the slopes above the village; a few broadleaves round it.
    woods = max(plateau * smooth(.1, .4, n + .45), smooth(66, 80, abs(a) + n * 10) * smooth(-40, -20, b)) * clear * (1 - river)
    meadow = max(0, 1 - shore - road - cliff - plateau) * (1 if lake > 1.1 else 0) * smooth(.5, 2, square_distance(x, y))
    flowers = smooth(.05, .35, noise.noise(Vector((x / 7, y / 7, 1.9)))) * meadow * smooth(1.5, 4, square_distance(x, y))
    copse = smooth(.1, .24, noise.noise(Vector((x / 16, y / 16, 3.1)))) * meadow * clear * smooth(6, 12, square_distance(x, y))
    return {'lake': lake, 'shore': shore, 'road': road, 'cliff': cliff, 'plateau': plateau, 'river': river,
            'woods': woods, 'meadow': meadow, 'flowers': flowers, 'copse': copse * (1 - road),
            'reeds': (1 - smooth(1.0, 1.12, lake)) * smooth(.85, .95, lake),
            'rocks': max(cliff, shore * .5) * (1 - river), 'tint': smooth(-.1, .35, noise.noise(Vector((x / 9, y / 9, 5.7))))}

def height(x, y):
    from mathutils import noise, Vector
    a, b = to_frame(x, y)
    m = masks(x, y)
    rolling = noise.fractal(Vector((x / 45, y / 45, .3)), 1.0, 2.0, 4) * 1.4 + smooth(-30, -90, b) * 3
    rise = b - cliff_line(a)
    # The cliff, a plateau with a river cut into it, and mountains behind.
    mountains = (smooth(-.5, 2.5, rise) * CLIFF_HEIGHT + smooth(6, 80, rise) * 48
                 + smooth(62, 120, abs(a)) * smooth(-50, 0, b) * 42)
    ridges = (1 - abs(noise.noise(Vector((x / 38, y / 38, 6.1))))) * smooth(8, 50, rise + abs(a) * .4) * 16
    # Ledges and buttresses down the cliff face.
    face = 1 - smooth(1, 4, abs(rise - 1))
    h = rolling + mountains + ridges + noise.fractal(Vector((x / 12, y / 12, 1.1)), 1.0, 2.0, 3) * .5 * smooth(0, 3, rise)
    h += noise.fractal(Vector((x / 4, y / 4, 2.7)), 1.0, 2.0, 4) * 2.2 * face
    h -= m['river'] * 1.1
    lake = -2.6 * smooth(1.05, .35, m['lake'])
    h = h + lake if m['lake'] < 1.3 else max(h, WATER_LEVEL + .5)
    # The live area stays level so halls and characters stand on y = 0.
    return h * smooth(2, 12, play_distance(x, y))

# --- Materials --------------------------------------------------------------
def ground_material():
    """Meadow, shore stones, cobbled roads, forest floor and rock, blended by masks."""
    import bpy
    m = bpy.data.materials.new('ground')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = nodes['Principled BSDF']
    coord = nodes.new('ShaderNodeTexCoord').outputs['Object']
    color, rough, normal = painted(nodes, links, 'meadow', 6, coord, dry=(1.05, 1, .7, 1))
    tint = nodes.new('ShaderNodeAttribute')
    tint.attribute_name = 'tint'
    lush = nodes.new('ShaderNodeMix')
    lush.data_type, lush.blend_type = 'RGBA', 'MULTIPLY'
    links.new(tint.outputs['Fac'], lush.inputs['Factor'])
    links.new(color, lush.inputs[6])
    lush.inputs[7].default_value = (.7, .82, .5, 1)
    deep = nodes.new('ShaderNodeMix')
    deep.data_type, deep.blend_type = 'RGBA', 'MULTIPLY'
    deep.inputs['Factor'].default_value = 1
    links.new(lush.outputs[2], deep.inputs[6])
    deep.inputs[7].default_value = (.66, .74, .5, 1)
    layers = (deep.outputs[2], rough, normal)
    def over(attribute, top):
        nonlocal layers
        attr = nodes.new('ShaderNodeAttribute')
        attr.attribute_name = attribute
        layers = tuple(mix(nodes, links, kind, attr.outputs['Fac'], low, high)
                       for kind, low, high in zip(('RGBA', 'FLOAT', 'VECTOR'), layers, top))
    over('woods', surface(nodes, links, TEXTURES['forest'], 3.5, coord))
    over('shore', surface(nodes, links, TEXTURES['shore'], 2.5, coord))
    over('road', surface(nodes, links, TEXTURES['road'], 2.2, coord))
    over('rock', surface(nodes, links, TEXTURES['scree'], 4, coord))
    # The cliff faces the viewer, so it is mapped across the screen and up.
    xyz = nodes.new('ShaderNodeSeparateXYZ')
    links.new(coord, xyz.inputs['Vector'])
    (rx, ry), _ = frame()
    across = nodes.new('ShaderNodeMath')
    across.operation = 'MULTIPLY_ADD'
    links.new(xyz.outputs['X'], across.inputs[0])
    across.inputs[1].default_value = rx
    side = nodes.new('ShaderNodeMath')
    side.operation = 'MULTIPLY'
    links.new(xyz.outputs['Y'], side.inputs[0])
    side.inputs[1].default_value = ry
    links.new(side.outputs['Value'], across.inputs[2])
    face = nodes.new('ShaderNodeCombineXYZ')
    links.new(across.outputs['Value'], face.inputs['X'])
    links.new(xyz.outputs['Z'], face.inputs['Y'])
    over('cliff', surface(nodes, links, TEXTURES['cliff'], 5, face.outputs['Vector']))
    color, rough, normal = layers
    links.new(color, bsdf.inputs['Base Color'])
    links.new(rough, bsdf.inputs['Roughness'])
    links.new(normal, bsdf.inputs['Normal'])
    return m

def water_material(foam=False):
    """Clear mountain water: green over the stones in the shallows, deep blue-green
    and mirror-like further out. `foam` whitens it where the waterfall lands."""
    import bpy
    m = bpy.data.materials.new('water')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = nodes['Principled BSDF']
    depth = nodes.new('ShaderNodeAttribute')
    depth.attribute_name = 'depth'
    deep = nodes.new('ShaderNodeMapRange')
    deep.inputs['From Min'].default_value, deep.inputs['From Max'].default_value = 0, 1.8
    links.new(depth.outputs['Fac'], deep.inputs['Value'])
    tint = nodes.new('ShaderNodeMix')
    tint.data_type = 'RGBA'
    links.new(deep.outputs['Result'], tint.inputs['Factor'])
    tint.inputs[6].default_value = (.08, .12, .09, 1)
    tint.inputs[7].default_value = (.01, .035, .045, 1)
    color = tint.outputs[2]
    if foam:
        churn = nodes.new('ShaderNodeAttribute')
        churn.attribute_name = 'foam'
        bubbles = nodes.new('ShaderNodeTexNoise')
        bubbles.inputs['Scale'].default_value = 3.5
        bubbles.inputs['Detail'].default_value = 8
        froth = nodes.new('ShaderNodeMath')
        froth.operation = 'MULTIPLY'
        links.new(churn.outputs['Fac'], froth.inputs[0])
        links.new(bubbles.outputs['Fac'], froth.inputs[1])
        white = nodes.new('ShaderNodeMapRange')
        white.inputs['From Min'].default_value, white.inputs['From Max'].default_value = .2, .55
        links.new(froth.outputs['Value'], white.inputs['Value'])
        whiten = nodes.new('ShaderNodeMix')
        whiten.data_type = 'RGBA'
        links.new(white.outputs['Result'], whiten.inputs['Factor'])
        links.new(color, whiten.inputs[6])
        whiten.inputs[7].default_value = (.85, .9, .9, 1)
        color = whiten.outputs[2]
        rough = nodes.new('ShaderNodeMapRange')
        rough.inputs['To Min'].default_value, rough.inputs['To Max'].default_value = .03, .6
        links.new(white.outputs['Result'], rough.inputs['Value'])
        links.new(rough.outputs['Result'], bsdf.inputs['Roughness'])
    else:
        bsdf.inputs['Roughness'].default_value = .03
    links.new(color, bsdf.inputs['Base Color'])
    clear = nodes.new('ShaderNodeBsdfTransparent')
    clear.inputs['Color'].default_value = (.6, .72, .62, 1)
    shallow = nodes.new('ShaderNodeMapRange')
    shallow.inputs['From Min'].default_value, shallow.inputs['From Max'].default_value = 0, .6
    shallow.inputs['To Min'].default_value, shallow.inputs['To Max'].default_value = .65, 0
    links.new(depth.outputs['Fac'], shallow.inputs['Value'])
    blend = nodes.new('ShaderNodeMixShader')
    links.new(shallow.outputs['Result'], blend.inputs['Fac'])
    links.new(bsdf.outputs['BSDF'], blend.inputs[1])
    links.new(clear.outputs['BSDF'], blend.inputs[2])
    links.new(blend.outputs['Shader'], nodes['Material Output'].inputs['Surface'])
    bsdf.inputs['IOR'].default_value = 1.33
    ripples = nodes.new('ShaderNodeTexNoise')
    ripples.inputs['Scale'].default_value = 1.6
    ripples.inputs['Detail'].default_value = 8
    bump = nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = .06
    links.new(ripples.outputs['Fac'], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
    return m

def falling_water_material():
    """Streaks of white water over a darker, half-clear sheet."""
    import bpy
    m = bpy.data.materials.new('waterfall')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = nodes['Principled BSDF']
    coord = nodes.new('ShaderNodeTexCoord').outputs['UV']
    stretch = nodes.new('ShaderNodeMapping')
    stretch.inputs['Scale'].default_value = (14, 1.2, 1)
    links.new(coord, stretch.inputs['Vector'])
    streaks = nodes.new('ShaderNodeTexNoise')
    streaks.inputs['Scale'].default_value = 3
    streaks.inputs['Detail'].default_value = 10
    streaks.inputs['Roughness'].default_value = .65
    links.new(stretch.outputs['Vector'], streaks.inputs['Vector'])
    white = nodes.new('ShaderNodeMapRange')
    white.inputs['From Min'].default_value, white.inputs['From Max'].default_value = .38, .62
    links.new(streaks.outputs['Fac'], white.inputs['Value'])
    color = nodes.new('ShaderNodeMix')
    color.data_type = 'RGBA'
    links.new(white.outputs['Result'], color.inputs['Factor'])
    color.inputs[6].default_value = (.18, .26, .26, 1)
    color.inputs[7].default_value = (.92, .95, .95, 1)
    links.new(color.outputs[2], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = .35
    clear = nodes.new('ShaderNodeBsdfTransparent')
    sheer = nodes.new('ShaderNodeMapRange')
    sheer.inputs['To Min'].default_value, sheer.inputs['To Max'].default_value = .45, 0
    links.new(white.outputs['Result'], sheer.inputs['Value'])
    blend = nodes.new('ShaderNodeMixShader')
    links.new(sheer.outputs['Result'], blend.inputs['Fac'])
    links.new(bsdf.outputs['BSDF'], blend.inputs[1])
    links.new(clear.outputs['BSDF'], blend.inputs[2])
    links.new(blend.outputs['Shader'], nodes['Material Output'].inputs['Surface'])
    return m

def mist_material(theme, density):
    """Scattering mist, thickest at the centre of its object and fading out."""
    import bpy
    m = bpy.data.materials.new('mist')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    nodes.remove(nodes['Principled BSDF'])
    vol = nodes.new('ShaderNodeVolumeScatter')
    vol.inputs['Color'].default_value = (.9, .93, .95, 1) if theme == 'light' else (.7, .72, .85, 1)
    coord = nodes.new('ShaderNodeTexCoord')
    radius = nodes.new('ShaderNodeVectorMath')
    radius.operation = 'LENGTH'
    links.new(coord.outputs['Object'], radius.inputs[0])
    fade = nodes.new('ShaderNodeMapRange')
    fade.inputs['From Min'].default_value, fade.inputs['From Max'].default_value = .2, 1
    fade.inputs['To Min'].default_value, fade.inputs['To Max'].default_value = 1, 0
    links.new(radius.outputs['Value'], fade.inputs['Value'])
    puffs = nodes.new('ShaderNodeTexNoise')
    puffs.inputs['Scale'].default_value = 3
    puffs.inputs['Detail'].default_value = 4
    links.new(coord.outputs['Object'], puffs.inputs['Vector'])
    d = nodes.new('ShaderNodeMath')
    d.operation = 'MULTIPLY'
    links.new(fade.outputs['Result'], d.inputs[0])
    links.new(puffs.outputs['Fac'], d.inputs[1])
    s = nodes.new('ShaderNodeMath')
    s.operation = 'MULTIPLY'
    s.inputs[1].default_value = density
    links.new(d.outputs['Value'], s.inputs[0])
    links.new(s.outputs['Value'], vol.inputs['Density'])
    links.new(vol.outputs['Volume'], nodes['Material Output'].inputs['Volume'])
    return m

# --- Geometry ---------------------------------------------------------------
def stonework(name, asset, scale):
    """A PBR set box-projected, so walls and kerbs show it on their sides too."""
    m = textured(name, asset, scale)
    for node in m.node_tree.nodes:
        if node.type == 'TEX_IMAGE':
            node.projection, node.projection_blend = 'BOX', .25
    return m

def box(location, size, angle, material):
    """A box `size` metres along its own axes, turned `angle` about the vertical.
    The size is in the mesh, not the object's scale, so textures keep their scale."""
    import bpy
    from mathutils import Matrix
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.data.transform(Matrix.Diagonal((*size, 1)))
    obj.rotation_euler = (0, 0, angle)
    obj.data.materials.append(material)
    return obj

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
    rock = np.clip((slope - .7) / .5, 0, 1) * (1 - np.array(layers['river']))
    layers['rock'] = list(rock * (1 - np.array(layers['cliff'])))
    for key, values in layers.items():
        mesh.attributes.new(key, 'FLOAT', 'POINT').data.foreach_set('value', values)
    mesh.shade_smooth()
    obj = bpy.data.objects.new('terrain', mesh)
    obj.data.materials.append(ground_material())
    bpy.context.scene.collection.objects.link(obj)
    return obj

def water():
    """The lake, carrying the depth beneath each point and foam where the fall lands."""
    import bpy, bmesh
    ca, cb, ra, rb = LAKE
    x, y = to_ground(ca, cb + 2)
    size = ra * 2.6
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=int(size * 1.5), y_segments=int(size * 1.5), size=size / 2)
    mesh = bpy.data.meshes.new('water')
    bm.to_mesh(mesh)
    bm.free()
    fx, fy = to_ground(FALL_A, cliff_line(FALL_A) - .5)
    depths, foam = [], []
    for v in mesh.vertices:
        v.co.x += x
        v.co.y += y
        v.co.z = WATER_LEVEL
        depths.append(max(0, WATER_LEVEL - height(v.co.x, v.co.y)))
        foam.append(1 - smooth(1, 7, math.hypot(v.co.x - fx, v.co.y - fy)))
    mesh.attributes.new('depth', 'FLOAT', 'POINT').data.foreach_set('value', depths)
    mesh.attributes.new('foam', 'FLOAT', 'POINT').data.foreach_set('value', foam)
    obj = bpy.data.objects.new('water', mesh)
    obj.data.materials.append(water_material(foam=True))
    bpy.context.scene.collection.objects.link(obj)

def river():
    """The river on the plateau: a ribbon of water down its channel to the lip."""
    import bpy
    verts, faces, depths = [], [], []
    points = []
    for (a0, b0), (a1, b1) in zip(RIVER, RIVER[1:]):
        n = int(math.hypot(a1 - a0, b1 - b0) / .6)
        points += [(a0 + (a1 - a0) * i / n, b0 + (b1 - b0) * i / n) for i in range(n)]
    for i, (a, b) in enumerate(points):
        a1, b1 = points[min(i + 1, len(points) - 1)]
        a0, b0 = points[max(i - 1, 0)]
        da, db = a1 - a0, b1 - b0
        l = math.hypot(da, db)
        na, nb = -db / l, da / l
        for side in (-1.6, 1.6):
            x, y = to_ground(a + na * side, b + nb * side)
            centre = to_ground(a, b)
            verts.append((x, y, height(*centre) + .75))
            depths.append(.5)
        if i:
            k = 2 * i
            faces.append((k - 2, k - 1, k + 1, k))
    mesh = bpy.data.meshes.new('river')
    mesh.from_pydata(verts, [], faces)
    mesh.attributes.new('depth', 'FLOAT', 'POINT').data.foreach_set('value', depths)
    obj = bpy.data.objects.new('river', mesh)
    obj.data.materials.append(water_material())
    bpy.context.scene.collection.objects.link(obj)
    return verts[0], verts[1]

def waterfall(lip, theme):
    """A curtain of falling water from the river's lip to the lake, facing the
    camera, with spray where it lands."""
    import bpy
    from mathutils import Vector
    top = (Vector(lip[0]) + Vector(lip[1])) / 2
    across = (Vector(lip[1]) - Vector(lip[0])).normalized()
    out = Vector(to_ground(0, -1)).to_3d().normalized()  # toward the viewer, off the cliff face
    rows, cols = 24, 8
    verts, faces, uvs = [], [], []
    drop = top.z - WATER_LEVEL
    for r in range(rows + 1):
        t = r / rows
        # A short throw over the lip, then straight down, spreading as it falls.
        reach = 1.2 * math.sin(min(t * 3, 1) * math.pi / 2) + t * .6
        half = 1.5 + t * 1.4
        for c in range(cols + 1):
            s = c / cols * 2 - 1
            p = top + out * reach + across * (s * half) - Vector((0, 0, drop * t))
            verts.append(p[:])
            uvs.append((c / cols, 1 - t))
    for r in range(rows):
        for c in range(cols):
            k = r * (cols + 1) + c
            faces.append((k, k + 1, k + cols + 2, k + cols + 1))
    mesh = bpy.data.meshes.new('waterfall')
    mesh.from_pydata(verts, [], faces)
    layer = mesh.uv_layers.new(name='UVMap')
    for poly in mesh.polygons:
        for li in poly.loop_indices:
            layer.data[li].uv = uvs[mesh.loops[li].vertex_index]
    obj = bpy.data.objects.new('waterfall', mesh)
    obj.data.materials.append(falling_water_material())
    bpy.context.scene.collection.objects.link(obj)
    base = top + out * 1.8
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1, location=(base.x, base.y, WATER_LEVEL + 1))
    spray = bpy.context.object
    spray.scale = (5, 5, 3.2)
    spray.data.materials.append(mist_material(theme, 1.2))

def square_outline(step=.5):
    """The square's edge: the courtyard circle joined to the rectangle in front."""
    x0, x1, y0, y1 = SQUARE_FRONT
    pts = []
    a0 = math.asin(x1 / SQUARE_RADIUS)
    start, end = -math.pi / 2 + a0, 3 * math.pi / 2 - a0
    n = int((end - start) * SQUARE_RADIUS / step)
    for i in range(n + 1):
        t = start + (end - start) * i / n
        pts.append((SQUARE_RADIUS * math.cos(t), SQUARE_RADIUS * math.sin(t)))
    pts += [(x0, y0), (x1, y0)]
    return pts

def cobbles_material():
    """Cobbles sampled at two scales and angles, blended by noise and darkened in
    broad patches, so a square this size shows no repeat."""
    import bpy
    m = bpy.data.materials.new('cobbles')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = nodes['Principled BSDF']
    coord = nodes.new('ShaderNodeTexCoord').outputs['Object']
    turned = nodes.new('ShaderNodeVectorRotate')
    turned.rotation_type = 'Z_AXIS'
    turned.inputs['Angle'].default_value = .7
    links.new(coord, turned.inputs['Vector'])
    near = surface(nodes, links, TEXTURES['square'], 2.6, coord)
    far = surface(nodes, links, TEXTURES['square'], 3.3, turned.outputs['Vector'])
    def noise(size, seed):
        node = nodes.new('ShaderNodeTexNoise')
        node.noise_dimensions = '4D'
        node.inputs['Scale'].default_value = 1 / size
        node.inputs['W'].default_value = seed
        links.new(coord, node.inputs['Vector'])
        return node.outputs['Fac']
    pick = nodes.new('ShaderNodeMapRange')
    pick.inputs['From Min'].default_value, pick.inputs['From Max'].default_value = .45, .55
    links.new(noise(12, 1), pick.inputs['Value'])
    color, rough, normal = (mix(nodes, links, kind, pick.outputs['Result'], a, b)
                            for kind, a, b in zip(('RGBA', 'FLOAT', 'VECTOR'), near, far))
    third = nodes.new('ShaderNodeVectorRotate')
    third.rotation_type = 'Z_AXIS'
    third.inputs['Angle'].default_value = 2.1
    links.new(coord, third.inputs['Vector'])
    other = surface(nodes, links, TEXTURES['square'], 2.1, third.outputs['Vector'])
    pick2 = nodes.new('ShaderNodeMapRange')
    pick2.inputs['From Min'].default_value, pick2.inputs['From Max'].default_value = .42, .58
    links.new(noise(7, 4), pick2.inputs['Value'])
    color, rough, normal = (mix(nodes, links, kind, pick2.outputs['Result'], a, b)
                            for kind, a, b in zip(('RGBA', 'FLOAT', 'VECTOR'), (color, rough, normal), other))
    grey = nodes.new('ShaderNodeHueSaturation')
    grey.inputs['Saturation'].default_value, grey.inputs['Value'].default_value = .55, .92
    links.new(color, grey.inputs['Color'])
    color = grey.outputs['Color']
    wear = nodes.new('ShaderNodeMapRange')
    wear.inputs['To Min'].default_value, wear.inputs['To Max'].default_value = .78, 1.04
    links.new(noise(18, 2), wear.inputs['Value'])
    shade = nodes.new('ShaderNodeMix')
    shade.data_type, shade.blend_type = 'RGBA', 'MULTIPLY'
    shade.inputs['Factor'].default_value = 1
    links.new(color, shade.inputs[6])
    links.new(wear.outputs['Result'], shade.inputs[7])
    links.new(shade.outputs[2], bsdf.inputs['Base Color'])
    links.new(rough, bsdf.inputs['Roughness'])
    links.new(normal, bsdf.inputs['Normal'])
    return m

def square():
    """The cobbled square the live halls and characters stand on, edged with a
    kerb, with a millstone set flush at its centre."""
    import bpy
    slab('square', square_outline(), 0, .4, cobbles_material())
    kerb = stonework('kerb', TEXTURES['kerb'], 1.6)
    edge = square_outline(.5)
    for (xa, ya), (xb, yb) in zip(edge, edge[1:] + edge[:1]):
        length = math.hypot(xb - xa, yb - ya)
        box(((xa + xb) / 2, (ya + yb) / 2, -.05), (length + .02, .45, .2), math.atan2(yb - ya, xb - xa), kerb)
    # A ring of dressed stone round the courtyard, and setts across the front rows.
    bpy.ops.mesh.primitive_torus_add(major_segments=256, minor_segments=8, major_radius=COURTYARD_RADIUS + .2,
                                     minor_radius=.22, location=(0, 0, -.02))
    ring = bpy.context.object
    ring.scale.z = .12
    ring.data.materials.append(kerb)
    x0, x1, y0, y1 = SQUARE_FRONT
    for k in range(1, int((y1 - y0) / 5)):
        y = y1 - k * 5
        if y > -COURTYARD_RADIUS - .5:
            continue
        box((0, y, -.02), (x1 - x0 - .2, .32, .045), 0, kerb)
    mill = [(2.2 * math.cos(i / 64 * math.tau), 2.2 * math.sin(i / 64 * math.tau)) for i in range(64)]
    slab('millstone', mill, .006, .05, textured('millstone', TEXTURES['kerb'], .9))
    hub = [(.5 * math.cos(i / 32 * math.tau), .5 * math.sin(i / 32 * math.tau)) for i in range(32)]
    slab('millstone_hub', hub, .008, .05, textured('hub', TEXTURES['beam'], .6))
    wall()

def wall():
    """A low dry-stone wall along the square's back and left edges, which stand
    farther from the camera than anything on the square; the front and right,
    toward the camera, stay open."""
    stone = stonework('wall', TEXTURES['wall'], 1.4)
    edge = [(x * 1.03, y * 1.03) for x, y in square_outline(.8) if y > 2.5 or (x < -12 and y > SQUARE_FRONT[2] + 1)]
    for (xa, ya), (xb, yb) in zip(edge, edge[1:]):
        length = math.hypot(xb - xa, yb - ya)
        if length > 2:
            continue
        box(((xa + xb) / 2, (ya + yb) / 2, .3), (length + .05, .55, .62), math.atan2(yb - ya, xb - xa), stone)

def fences():
    """Split-rail fences along the roads, off the live area."""
    import bpy
    wood = stonework('fence', TEXTURES['beam'], .8)
    rng = random.Random(23)
    for line in ROADS:
        for (a0, b0), (a1, b1) in zip(line, line[1:]):
            length = math.hypot(a1 - a0, b1 - b0)
            na, nb = -(b1 - b0) / length, (a1 - a0) / length
            for side in (-2.4, 2.4):
                posts = []
                for i in range(int(length / 2.4) + 1):
                    t = i * 2.4 / length
                    a, b = a0 + (a1 - a0) * t + na * side, b0 + (b1 - b0) * t + nb * side
                    x, y = to_ground(a, b)
                    ok = (live_distance(x, y) > 3 and not on_square(x, y, 1.5) and tall_clear(a, b, 1.2)
                          and masks(x, y)['lake'] > 1.2 and rng.random() > .12)
                    posts.append((x, y, height(x, y)) if ok else None)
                for p in posts:
                    if p:
                        bpy.ops.mesh.primitive_cylinder_add(vertices=6, radius=.06, depth=1.1, location=(p[0], p[1], p[2] + .5))
                        bpy.context.object.data.materials.append(wood)
                for p, q in zip(posts, posts[1:]):
                    if not (p and q):
                        continue
                    for z in (.45, .85):
                        mid = ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2 + z)
                        span = math.hypot(q[0] - p[0], q[1] - p[1])
                        bpy.ops.mesh.primitive_cylinder_add(vertices=6, radius=.04, depth=span, location=mid)
                        rail = bpy.context.object
                        rail.rotation_euler = (math.pi / 2 - math.atan2(q[2] - p[2], span), 0,
                                               math.atan2(q[1] - p[1], q[0] - p[0]) - math.pi / 2)
                        rail.data.materials.append(wood)

def jetty():
    """A short wooden jetty out into the lake from the end of the lake road."""
    import bpy
    path = polyhaven.model('modular_wooden_pier')
    with bpy.data.libraries.load(str(path)) as (src, dst):
        dst.objects = [n for n in src.objects if n.endswith('section_02')]
    section = dst.objects[0]
    top = max(c[2] for c in section.bound_box)
    a, b = ROADS[0][-1]
    for i in range(4):
        x, y = to_ground(a - 1.5, b + 1 + i * 2.9)
        obj = section.copy()
        obj.location = (x, y, WATER_LEVEL + .55 - top)
        obj.rotation_euler = (0, 0, math.atan2(*to_ground(0, 1)[::-1]) - math.pi / 2)
        bpy.context.scene.collection.objects.link(obj)

def village(theme):
    """The village's TRELLIS.2 cottages, towers, mill and workshops."""
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
        # Sunk a little so the footing sits in the ground on a slope.
        inst.location = (x, y, height(x, y) - lo * scale - .25)
        inst.scale = (scale,) * 3
        inst.rotation_euler = (0, 0, math.radians(turn))
        bpy.context.scene.collection.objects.link(inst)

def props(s):
    """Barrels, crates, tables, ladders and a garden gnome or two by the cottages
    and along the roads, off the live area."""
    import bpy
    rng = random.Random(41)
    kinds = [s[n] for n in ('wine_barrel_01', 'wine_barrel_01', 'wooden_bucket_01', 'wooden_crate_01',
                            'WoodenTable_01', 'wooden_stool_01', 'garden_gnome')]
    spots = []
    for name, (a, b), tall, turn in BUILDINGS:
        for k in range(rng.randint(2, 4)):
            ang = rng.uniform(0, math.tau)
            spots.append((a + math.cos(ang) * tall * .55, b + math.sin(ang) * tall * .4 - tall * .2))
    for line in ROADS:
        for (a0, b0), (a1, b1) in zip(line, line[1:]):
            for k in range(2):
                t = rng.uniform(.1, .9)
                length = math.hypot(a1 - a0, b1 - b0)
                side = rng.choice((-1, 1)) * 3.2
                spots.append((a0 + (a1 - a0) * t - (b1 - b0) / length * side, b0 + (b1 - b0) * t + (a1 - a0) / length * side))
    for a, b in spots:
        x, y = to_ground(a, b)
        m = masks(x, y)
        if live_distance(x, y) < 3 or on_square(x, y, 1.5) or m['lake'] < 1.2 or m['road'] > .3 or not tall_clear(a, b, 1.5):
            continue
        for j in range(rng.randint(1, 3)):
            px, py = x + rng.uniform(-.7, .7), y + rng.uniform(-.7, .7)
            inst = bpy.data.objects.new('prop', None)
            inst.instance_type, inst.instance_collection = 'COLLECTION', rng.choice(kinds)
            inst.location = (px, py, height(px, py))
            inst.rotation_euler = (0, 0, rng.uniform(0, math.tau))
            bpy.context.scene.collection.objects.link(inst)

def haze(theme):
    """Thin air between the village and the mountains, so ridges pale with distance."""
    import bpy
    # A 420 m box whose near face is just behind the cliff.
    bpy.ops.mesh.primitive_cube_add(size=1, location=(*to_ground(0, CLIFF_B + 214), 30))
    box = bpy.context.object
    box.scale = (420, 420, 70)
    box.rotation_euler = (0, 0, math.atan2(*to_ground(0, 1)[::-1]) - math.pi / 2)
    m = bpy.data.materials.new('haze')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    nodes.remove(nodes['Principled BSDF'])
    vol = nodes.new('ShaderNodeVolumeScatter')
    vol.inputs['Color'].default_value = (.82, .88, .95, 1) if theme == 'light' else (.55, .58, .8, 1)
    vol.inputs['Density'].default_value = .006 if theme == 'light' else .004
    links.new(vol.outputs['Volume'], nodes['Material Output'].inputs['Volume'])
    box.data.materials.append(m)

def lights(theme):
    dusk = theme == 'dark'
    # Dusk is dimmer than other worlds' so the lanterns and windows carry the village.
    sky_lights(SKIES[theme], theme, .3 if dusk else .9, 1.7 if dusk else 3.3, 2.5 if dusk else 1.4,
               (1, .5, .3) if dusk else (1, .93, .82))

def lanterns(theme):
    """Lantern posts along the roads, and along the square's back and left edges:
    those stand farther from the camera than anything on the square, so live
    models correctly draw in front of them."""
    posts = [(x * 1.07, y * 1.07, 0) for i, (x, y) in enumerate(square_outline(2.6))
             if i % 3 == 1 and (y > 3 or (x < -12 and y > SQUARE_FRONT[2] + 2))]
    for line in ROADS:
        for (a0, b0), (a1, b1) in zip(line, line[1:]):
            length = math.hypot(a1 - a0, b1 - b0)
            na, nb = -(b1 - b0) / length, (a1 - a0) / length
            for i in range(int(length / 11)):
                t = (i + .5) * 11 / length
                side = 1.9 if (len(posts) + i) % 2 else -1.9
                a, b = a0 + (a1 - a0) * t + na * side, b0 + (b1 - b0) * t + nb * side
                x, y = to_ground(a, b)
                if live_distance(x, y) < 3 or not tall_clear(a, b, 3) or on_square(x, y, .5):
                    continue
                posts.append((x, y, height(x, y)))
    lantern_posts(posts, theme)

def halls():
    import bpy
    bpy.ops.import_scene.gltf(filepath=str(ROOT / 'web/yard/assets/gnomeland.glb'))

def build(with_halls=True, theme='light'):
    import bpy
    bpy.ops.wm.read_factory_settings(use_empty=True)
    random.seed(915)
    lights(theme)
    terrain()
    water()
    waterfall(river(), theme)
    square()
    s = {a: source(a, h) for a, (h, variants) in MODELS.items() if not variants}
    v = {a: variant_sets(a) for a, (h, variants) in MODELS.items() if variants}
    scatter('conifers', [s['fir_tree_01'], s['pine_tree_01']], 'woods', .06, 3.2, (.6, 1.2), 51)
    scatter('understory', [s['shrub_01'], s['shrub_02']] + v['fern_02'], 'woods', .08, 1.6, (.8, 1.5), 52)
    scatter('copses', [s['island_tree_01'], s['island_tree_02'], s['tree_small_02']], 'copse', .03, 4, (.7, 1.1), 53)
    scatter('thickets', [s['shrub_01'], s['shrub_02'], s['shrub_04']], 'copse', .1, 1.4, (.8, 1.5), 54)
    scatter('grass', v['grass_medium_01'], 'meadow', .5, .7, (.7, 1.3), 55)
    scatter('flowers', v['celandine_01'] + v['dandelion_01'], 'flowers', 1.2, .35, (.9, 1.5), 56)
    scatter('reeds', reeds(), 'reeds', .6, .7, (.7, 1.1), 57)
    scatter('rocks', v['rock_moss_set_01'] + v['rock_moss_set_02'], 'rocks', .01, 3, (.6, 1.6), 58)
    scatter('boulders', [s['boulder_01']], 'rocks', .006, 5, (1.5, 3.5), 59)
    jetty()
    village(theme)
    fences()
    props(s)
    lanterns(theme)
    haze(theme)
    if with_halls:
        halls()

if __name__ == '__main__' and '--preview' in sys.argv:
    preview(sys.modules[__name__], 'dark' if '--dark' in sys.argv else 'light')
