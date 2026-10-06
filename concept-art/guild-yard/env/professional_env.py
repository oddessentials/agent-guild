"""Professional environment for the Yard's pre-rendered plates: an office
campus of glass and concrete, with lawns, tree-lined avenues, a pond and
office blocks round a paved plaza.

Preview renders from the live camera into .cache/yard-env/:
  blender -b --factory-startup --python concept-art/guild-yard/env/professional_env.py -- --preview [--dark]
The live halls and session markers stand on a level paved plaza at y = 0.
The office blocks are modelled here with a curtain-wall shader; everything
else is Poly Haven CC0, fetched by polyhaven.py. Layout uses the
screen-aligned ground frame described in common.py.
"""
import math, random, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import polyhaven
from camera import ROOT
# plates.py and preview() call render_settings through this module.
from common import (COURTYARD_RADIUS, to_ground, to_frame, smooth, play_distance, live_distance, tall_clear,
                    line_distance, surface, painted, mix, scatter, variant_sets, reeds, slab, lights as sky_lights,
                    render_settings, preview)

# Sky per theme: a clear late morning for light, dusk for dark.
SKIES = {'light': 'kloofendal_38d_partly_cloudy_puresky', 'dark': 'qwantani_dusk_1_puresky'}
TEXTURES = {'plaza': 'large_grey_tiles', 'path': 'concrete_pavers_02', 'road': 'asphalt_02', 'kerb': 'granite_tile',
            'concrete': 'concrete_wall_008', 'panel': 'concrete_tile_facade', 'roof': 'gravel_floor',
            'shore': 'river_small_rocks', 'bark': 'brown_mud_rocks_01'}
# Model and target height in metres (None keeps Poly Haven's real size).
# Only the named objects are used: the plant sets also hold lower LODs.
MODELS = {
    'island_tree_01': (9, ['island_tree_01_LOD0']), 'island_tree_02': (8, ['island_tree_02_LOD0']),
    'tree_small_02': (6.5, ['tree_small_02_LOD0']),
    'planter_box_02': (None, ['planter_box_02']), 'painted_wooden_bench': (None, ['painted_wooden_bench']),
    'outdoor_table_chair_set_01': (None, None), 'street_lamp_01': (None, ['street_lamp_01']),
}
# Live hall materials by name (build.py's professional halls): Poly Haven set,
# metres per repeat, and whether the palette colour tints it.
SURFACES = {
    'concrete': ('concrete_wall_008', 3, ['office', 'white'], False),
    'stone': ('granite_tile', 2.5, ['officeDark'], False),
    'timber': ('dark_wooden_planks', 2, ['woodLight'], False),
    'accent': ('white_plaster_02', 2, ['amber', 'emerald', 'blue', 'cyan', 'violet'], True),
}
# Variant sets: each LOD0 mesh is a shrub of its own.
SHRUBS = ['shrub_01', 'shrub_02', 'shrub_04']
WATER_LEVEL = -.35
PLAZA_RADIUS = COURTYARD_RADIUS + .9
# Plaza in front of the courtyard, under the rows of sessions (Blender y = -glTF z).
PLAZA_FRONT = (-14.2, 14.2, -33.5, 0)

def fetch_all():
    for sky in SKIES.values():
        polyhaven.hdri(sky)
    for asset in TEXTURES.values():
        polyhaven.texture(asset)
    for asset in [*MODELS, *SHRUBS]:
        polyhaven.model(asset)

# --- Layout -----------------------------------------------------------------
# Everything is in the screen frame: `a` right, `b` up the screen (away).
POND = (-46, 20, 17, 7.5)        # centre a, b and radii
# Avenues: one down each side of the campus core, a service street behind the
# back row of offices, and a spur off each side.
ROADS = [[(-74, -90), (-74, 54)], [(70, -90), (70, 54)], [(-150, 54), (150, 54)],
         [(-74, 33), (-150, 35)], [(70, 33), (150, 31)], [(-74, -14), (-150, -16)], [(70, -14), (150, -12)]]
# Footpaths from the plaza out across the lawns.
PATHS = [[(-14, 2), (-34, 4), (-56, 6), (-74, 6)], [(14, -2), (36, -6), (54, -4), (70, -6)],
         [(-2, 15), (-3, 22), (-1, 27)], [(-12, -24), (-30, -40), (-48, -58)], [(12, -26), (34, -42), (52, -62)],
         [(-34, 4), (-40, 12)], [(20, 10), (30, 20), (34, 27)]]
# Office blocks: screen position, footprint (along a, along b), height, turn
# (degrees) and facade style. A back row stands behind the plaza and pond, and
# more line the outer sides of the avenues; all low enough to stay in view.
BLOCKS = [
    ((-42, 37), (24, 12), 15, 0, 'band'), ((-14, 40), (22, 12), 19, 0, 'glass'), ((13, 40), (22, 12), 17, 0, 'grid'),
    ((42, 37), (26, 12), 15, 0, 'glass'), ((-62, 42), (14, 12), 12, 0, 'grid'), ((60, 42), (14, 12), 12, 0, 'band'),
    ((-102, 10), (20, 28), 18, 0, 'glass'), ((-102, -40), (20, 40), 13, 0, 'band'), ((-104, 46), (22, 14), 14, 0, 'grid'),
    ((100, 8), (20, 30), 20, 0, 'band'), ((100, -42), (20, 40), 14, 0, 'grid'), ((104, 44), (22, 14), 13, 0, 'glass'),
    ((-104, -78), (24, 18), 10, 0, 'grid'), ((102, -80), (24, 18), 10, 0, 'band'),
]

def on_plaza(x, y, margin=0):
    x0, x1, y0, y1 = PLAZA_FRONT
    in_front = x0 - margin <= x <= x1 + margin and y0 - margin <= y <= y1 + margin
    return math.hypot(x, y) <= PLAZA_RADIUS + margin or in_front

def plaza_distance(x, y):
    x0, x1, y0, y1 = PLAZA_FRONT
    ring = math.hypot(x, y) - PLAZA_RADIUS
    box = math.hypot(max(x0 - x, 0, x - x1), max(y0 - y, 0, y - y1))
    return 0 if on_plaza(x, y) else min(ring, box)

def pond_shape(a, b):
    from mathutils import noise, Vector
    ca, cb, ra, rb = POND
    wobble = noise.noise(Vector((a / 10, b / 10, 4.2))) * .1
    return ((a - ca) / ra) ** 2 + ((b - cb) / rb) ** 2 + wobble

def block_distance(a, b, margin=0):
    """Metres outside the nearest office block's footprint (screen frame)."""
    best = 1e9
    for (ca, cb), (wa, wb), *_ in BLOCKS:
        best = min(best, math.hypot(max(abs(a - ca) - wa / 2 - margin, 0), max(abs(b - cb) - wb / 2 - margin, 0)))
    return best

def masks(x, y):
    from mathutils import noise, Vector
    a, b = to_frame(x, y)
    pond = pond_shape(a, b)
    paved = min(line_distance(ROADS, a, b) - 5.5, line_distance(PATHS, a, b) - 2.5, block_distance(a, b) - 3)
    clear = 1 if tall_clear(a, b) else 0
    lawn = smooth(0, 1.5, paved) * smooth(1, 3, plaza_distance(x, y)) * (1 if pond > 1.25 else 0)
    # Belts of trees past the campus, and copses on the lawns.
    belt = smooth(118, 130, abs(a) + noise.noise(Vector((x / 20, y / 20, 1.3))) * 8) + smooth(-62, -72, b)
    woods = min(1, belt) * clear * lawn
    copse = smooth(.26, .38, noise.noise(Vector((x / 14, y / 14, 3.1)))) * lawn * clear * smooth(8, 14, plaza_distance(x, y))
    shrubs = smooth(.22, .34, noise.noise(Vector((x / 6, y / 6, 8.3)))) * lawn * smooth(3, 5, plaza_distance(x, y))
    return {'pond': pond, 'shore': 1 - smooth(1, 1.25, pond), 'lawn': lawn, 'woods': woods,
            'copse': copse * (1 - woods), 'shrubs': shrubs, 'reeds': (1 - smooth(1.0, 1.1, pond)) * smooth(.85, .95, pond),
            'tint': smooth(-.1, .4, noise.noise(Vector((x / 11, y / 11, 5.7))))}

def height(x, y):
    """Level campus ground with a gentle roll on the lawns, the pond, and low
    rises at the far edges."""
    from mathutils import noise, Vector
    a, b = to_frame(x, y)
    roll = noise.fractal(Vector((x / 40, y / 40, .7)), 1.0, 2.0, 3) * .5
    rise = smooth(115, 150, abs(a)) * 6
    h = roll + rise
    pond = pond_shape(a, b)
    if pond < 1.4:
        h = min(h, WATER_LEVEL - 1.6 * smooth(1.05, .3, pond) + .5 * smooth(.95, 1.4, pond))
    return h * smooth(2, 10, play_distance(x, y)) * smooth(2, 6, plaza_distance(x, y))

# --- Materials --------------------------------------------------------------
def ground_material():
    """Mown lawn, with shore pebbles round the pond."""
    import bpy
    m = bpy.data.materials.new('ground')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = nodes['Principled BSDF']
    coord = nodes.new('ShaderNodeTexCoord').outputs['Object']
    color, rough, normal = painted(nodes, links, 'meadow', 5, coord, dry=(1.04, 1, .8, 1))
    tint = nodes.new('ShaderNodeAttribute')
    tint.attribute_name = 'tint'
    mown = nodes.new('ShaderNodeMix')
    mown.data_type, mown.blend_type = 'RGBA', 'MULTIPLY'
    links.new(tint.outputs['Fac'], mown.inputs['Factor'])
    links.new(color, mown.inputs[6])
    mown.inputs[7].default_value = (.8, .9, .7, 1)
    # Mowing stripes, 2.5 m wide, on the campus lawns.
    rows = nodes.new('ShaderNodeTexWave')
    rows.wave_type, rows.bands_direction = 'BANDS', 'X'
    rows.inputs['Scale'].default_value = 1 / 5
    rows.inputs['Distortion'].default_value = 0
    turned = nodes.new('ShaderNodeVectorRotate')
    turned.rotation_type = 'Z_AXIS'
    turned.inputs['Angle'].default_value = .55
    links.new(coord, turned.inputs['Vector'])
    links.new(turned.outputs['Vector'], rows.inputs['Vector'])
    sharp = nodes.new('ShaderNodeMapRange')
    sharp.inputs['From Min'].default_value, sharp.inputs['From Max'].default_value = .45, .55
    sharp.inputs['To Min'].default_value, sharp.inputs['To Max'].default_value = .88, 1.06
    links.new(rows.outputs['Fac'], sharp.inputs['Value'])
    lawn = nodes.new('ShaderNodeAttribute')
    lawn.attribute_name = 'lawn'
    stripe = nodes.new('ShaderNodeMix')
    stripe.data_type = 'FLOAT'
    links.new(lawn.outputs['Fac'], stripe.inputs['Factor'])
    stripe.inputs[2].default_value = 1
    links.new(sharp.outputs['Result'], stripe.inputs[3])
    striped = nodes.new('ShaderNodeMix')
    striped.data_type, striped.blend_type = 'RGBA', 'MULTIPLY'
    striped.inputs['Factor'].default_value = 1
    links.new(mown.outputs[2], striped.inputs[6])
    links.new(stripe.outputs[0], striped.inputs[7])
    shore = nodes.new('ShaderNodeAttribute')
    shore.attribute_name = 'shore'
    pebbles = surface(nodes, links, TEXTURES['shore'], 2.5, coord)
    color, rough, normal = (mix(nodes, links, kind, shore.outputs['Fac'], low, high)
                            for kind, low, high in zip(('RGBA', 'FLOAT', 'VECTOR'), (striped.outputs[2], rough, normal), pebbles))
    links.new(color, bsdf.inputs['Base Color'])
    links.new(rough, bsdf.inputs['Roughness'])
    links.new(normal, bsdf.inputs['Normal'])
    return m

def paving(name, asset, scale, value=1, saturation=.6):
    """A Poly Haven paving set, toned toward neutral grey and broken up by broad
    patches so long runs show no repeat."""
    import bpy
    m = bpy.data.materials.new(name)
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = nodes['Principled BSDF']
    coord = nodes.new('ShaderNodeTexCoord').outputs['Object']
    color, rough, normal = surface(nodes, links, asset, scale, coord)
    tone = nodes.new('ShaderNodeHueSaturation')
    tone.inputs['Saturation'].default_value, tone.inputs['Value'].default_value = saturation, value
    links.new(color, tone.inputs['Color'])
    wear = nodes.new('ShaderNodeTexNoise')
    wear.inputs['Scale'].default_value = .06
    links.new(coord, wear.inputs['Vector'])
    span = nodes.new('ShaderNodeMapRange')
    span.inputs['To Min'].default_value, span.inputs['To Max'].default_value = .85, 1.05
    links.new(wear.outputs['Fac'], span.inputs['Value'])
    shade = nodes.new('ShaderNodeMix')
    shade.data_type, shade.blend_type = 'RGBA', 'MULTIPLY'
    shade.inputs['Factor'].default_value = 1
    links.new(tone.outputs['Color'], shade.inputs[6])
    links.new(span.outputs['Result'], shade.inputs[7])
    links.new(shade.outputs[2], bsdf.inputs['Base Color'])
    links.new(rough, bsdf.inputs['Roughness'])
    links.new(normal, bsdf.inputs['Normal'])
    return m

def water_material():
    """Still, dark and reflective, clearing over the pebbles at the edge."""
    import bpy
    m = bpy.data.materials.new('water')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (.01, .03, .035, 1)
    bsdf.inputs['Roughness'].default_value = .03
    bsdf.inputs['IOR'].default_value = 1.33
    depth = nodes.new('ShaderNodeAttribute')
    depth.attribute_name = 'depth'
    shallow = nodes.new('ShaderNodeMapRange')
    shallow.inputs['From Min'].default_value, shallow.inputs['From Max'].default_value = 0, .5
    shallow.inputs['To Min'].default_value, shallow.inputs['To Max'].default_value = .75, 0
    links.new(depth.outputs['Fac'], shallow.inputs['Value'])
    clear = nodes.new('ShaderNodeBsdfTransparent')
    clear.inputs['Color'].default_value = (.6, .68, .6, 1)
    blend = nodes.new('ShaderNodeMixShader')
    links.new(shallow.outputs['Result'], blend.inputs['Fac'])
    links.new(bsdf.outputs['BSDF'], blend.inputs[1])
    links.new(clear.outputs['BSDF'], blend.inputs[2])
    links.new(blend.outputs['Shader'], nodes['Material Output'].inputs['Surface'])
    ripples = nodes.new('ShaderNodeTexNoise')
    ripples.inputs['Scale'].default_value = 2
    ripples.inputs['Detail'].default_value = 6
    bump = nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = .04
    links.new(ripples.outputs['Fac'], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
    return m

# Facade styles: bay width, storey height, the solid share of each bay
# (across, up), glass tint and the solid material's Poly Haven set.
STYLES = {
    'glass': (1.6, 3.9, .07, .16, (.05, .09, .11), 'panel'),
    'band': (1.8, 3.9, .05, .42, (.07, .1, .12), 'concrete'),
    'grid': (2.2, 3.9, .42, .45, (.06, .08, .09), 'concrete'),
}

def facade(style, theme, seed):
    """A curtain wall drawn in the shader: mullions and spandrels of the style's
    solid material over reflective glass, in object space so every face of an
    axis-aligned block lines up. At dusk some offices are lit."""
    import bpy
    bay, storey, across, up, tint, solid = STYLES[style]
    m = bpy.data.materials.new(f'facade_{style}_{seed}')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    out = nodes['Material Output']
    wall = nodes['Principled BSDF']
    coord = nodes.new('ShaderNodeTexCoord').outputs['Object']
    color, rough, normal = surface(nodes, links, TEXTURES[solid], 3, coord)
    tone = nodes.new('ShaderNodeHueSaturation')
    tone.inputs['Saturation'].default_value = .5
    tone.inputs['Value'].default_value = 1.15 if solid == 'concrete' else .9
    links.new(color, tone.inputs['Color'])
    links.new(tone.outputs['Color'], wall.inputs['Base Color'])
    links.new(rough, wall.inputs['Roughness'])
    links.new(normal, wall.inputs['Normal'])
    xyz = nodes.new('ShaderNodeSeparateXYZ')
    links.new(coord, xyz.inputs['Vector'])
    def math_node(op, a, b=None):
        n = nodes.new('ShaderNodeMath')
        n.operation = op
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                links.new(v, n.inputs[i])
        return n.outputs['Value']
    u = math_node('DIVIDE', math_node('ADD', xyz.outputs['X'], xyz.outputs['Y']), bay)
    v = math_node('DIVIDE', xyz.outputs['Z'], storey)
    fu, fv = math_node('FRACT', u), math_node('FRACT', v)
    # Solid where within the mullion's share of the bay, or the spandrel's of the storey.
    mullion = math_node('GREATER_THAN', math_node('ABSOLUTE', math_node('SUBTRACT', fu, .5)), .5 - across / 2)
    solid_mask = math_node('MAXIMUM', mullion, math_node('LESS_THAN', fv, up))
    glass = nodes.new('ShaderNodeBsdfPrincipled')
    glass.inputs['Base Color'].default_value = (*tint, 1)
    glass.inputs['Metallic'].default_value = .85
    glass.inputs['Roughness'].default_value = .06
    # Lit offices at dusk: a random share of panes per storey and bay pair.
    if theme == 'dark':
        cell = nodes.new('ShaderNodeCombineXYZ')
        links.new(math_node('FLOOR', math_node('DIVIDE', u, 2)), cell.inputs['X'])
        links.new(math_node('FLOOR', v), cell.inputs['Y'])
        cell.inputs['Z'].default_value = seed
        noise = nodes.new('ShaderNodeTexWhiteNoise')
        noise.noise_dimensions = '3D'
        links.new(cell.outputs['Vector'], noise.inputs['Vector'])
        lit = math_node('GREATER_THAN', noise.outputs['Value'], .6)
        glass.inputs['Emission Color'].default_value = (1, .72, .45, 1)
        links.new(math_node('MULTIPLY', lit, 1.6), glass.inputs['Emission Strength'])
    blend = nodes.new('ShaderNodeMixShader')
    links.new(solid_mask, blend.inputs['Fac'])
    links.new(glass.outputs['BSDF'], blend.inputs[1])
    links.new(wall.outputs['BSDF'], blend.inputs[2])
    links.new(blend.outputs['Shader'], out.inputs['Surface'])
    return m

def plain(name, rgb, rough=.6, metal=0):
    import bpy
    m = bpy.data.materials.new(name)
    bsdf = m.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    return m

# --- Geometry ---------------------------------------------------------------
def terrain():
    import bpy, bmesh
    size, cuts = 440, 560
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=cuts, y_segments=cuts, size=size / 2)
    mesh = bpy.data.meshes.new('terrain')
    bm.to_mesh(mesh)
    bm.free()
    layers = {}
    for v in mesh.vertices:
        x, y = v.co.x, v.co.y
        v.co.z = height(x, y) - .03
        for key, value in masks(x, y).items():
            layers.setdefault(key, []).append(value)
    for key, values in layers.items():
        mesh.attributes.new(key, 'FLOAT', 'POINT').data.foreach_set('value', values)
    mesh.shade_smooth()
    obj = bpy.data.objects.new('terrain', mesh)
    obj.data.materials.append(ground_material())
    bpy.context.scene.collection.objects.link(obj)

def pond():
    import bpy, bmesh
    ca, cb, ra, rb = POND
    x, y = to_ground(ca, cb)
    size = max(ra, rb) * 2.6
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=int(size), y_segments=int(size), size=size / 2)
    mesh = bpy.data.meshes.new('water')
    bm.to_mesh(mesh)
    bm.free()
    depths = []
    for v in mesh.vertices:
        v.co.x += x
        v.co.y += y
        v.co.z = WATER_LEVEL
        depths.append(max(0, WATER_LEVEL - height(v.co.x, v.co.y)))
    mesh.attributes.new('depth', 'FLOAT', 'POINT').data.foreach_set('value', depths)
    obj = bpy.data.objects.new('water', mesh)
    obj.data.materials.append(water_material())
    bpy.context.scene.collection.objects.link(obj)

def ribbon(name, line, width, lift, material, step=1.0):
    """A strip along a screen-frame polyline that follows the ground, `width`
    metres wide, with square ends and mitred joins."""
    import bpy
    pts = []
    for (a0, b0), (a1, b1) in zip(line, line[1:]):
        n = max(1, int(math.hypot(a1 - a0, b1 - b0) / step))
        pts += [(a0 + (a1 - a0) * i / n, b0 + (b1 - b0) * i / n) for i in range(n)]
    pts.append(line[-1])
    ground = [to_ground(a, b) for a, b in pts]
    verts, faces = [], []
    for i, (x, y) in enumerate(ground):
        x0, y0 = ground[max(0, i - 1)]
        x1, y1 = ground[min(len(ground) - 1, i + 1)]
        dx, dy = x1 - x0, y1 - y0
        length = math.hypot(dx, dy)
        nx, ny = -dy / length * width / 2, dx / length * width / 2
        for s in (-1, 1):
            px, py = x + nx * s, y + ny * s
            verts.append((px, py, height(px, py) + lift))
        if i:
            faces.append((2 * i - 2, 2 * i - 1, 2 * i + 1, 2 * i))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    obj = bpy.data.objects.new(name, mesh)
    obj.data.materials.append(material)
    bpy.context.scene.collection.objects.link(obj)
    return obj

def plaza_outline(step=.5):
    """The plaza's edge: the courtyard circle joined to the rectangle in front."""
    x0, x1, y0, y1 = PLAZA_FRONT
    pts = []
    a0 = math.asin(x1 / PLAZA_RADIUS)
    start, end = -math.pi / 2 + a0, 3 * math.pi / 2 - a0
    n = int((end - start) * PLAZA_RADIUS / step)
    for i in range(n + 1):
        t = start + (end - start) * i / n
        pts.append((PLAZA_RADIUS * math.cos(t), PLAZA_RADIUS * math.sin(t)))
    pts += [(x0, y0), (x1, y0)]
    return pts

def box(location, size, angle, material, name='box'):
    import bpy
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = size
    obj.rotation_euler = (0, 0, angle)
    bpy.ops.object.transform_apply(scale=True)
    obj.data.materials.append(material)
    return obj

def plaza(theme):
    """The paved plaza the live halls and markers stand on: a granite kerb, a
    band of darker setts round the courtyard and across the front rows, and a
    still round pool at its centre."""
    import bpy
    slab('plaza', plaza_outline(), 0, .4, paving('slabs', TEXTURES['plaza'], 5, 1.3, .3))
    kerb = paving('kerb', TEXTURES['kerb'], 1.8, .9, .3)
    edge = plaza_outline(.5)
    for (xa, ya), (xb, yb) in zip(edge, edge[1:] + edge[:1]):
        length = math.hypot(xb - xa, yb - ya)
        box(((xa + xb) / 2, (ya + yb) / 2, -.04), (length + .02, .5, .2), math.atan2(yb - ya, xb - xa), kerb)
    bpy.ops.mesh.primitive_torus_add(major_segments=256, minor_segments=8, major_radius=COURTYARD_RADIUS + .2,
                                     minor_radius=.3, location=(0, 0, -.02))
    ring = bpy.context.object
    ring.scale.z = .08
    ring.data.materials.append(kerb)
    x0, x1, y0, y1 = PLAZA_FRONT
    for k in range(1, int((y1 - y0) / 5)):
        y = y1 - k * 5
        if y > -COURTYARD_RADIUS - .5:
            continue
        box((0, y, -.02), (x1 - x0 - .2, .36, .045), 0, kerb)
    rim = [(2.4 * math.cos(i / 96 * math.tau), 2.4 * math.sin(i / 96 * math.tau)) for i in range(96)]
    slab('pool_rim', rim, .03, .08, kerb)
    pool = [(2.05 * math.cos(i / 96 * math.tau), 2.05 * math.sin(i / 96 * math.tau)) for i in range(96)]
    slab('pool', pool, .035, .02, water_material())
    slab('pool_bed', pool, .031, .02, plain('pool_bed', (.3, .5, .52), .5))

def avenues():
    road = paving('road', TEXTURES['road'], 4, .85, .2)
    path = paving('path', TEXTURES['path'], 1.6, 1.15, .4)
    kerb = paving('road_kerb', TEXTURES['kerb'], 1.8, 1.05, .25)
    for i, line in enumerate(ROADS):
        ribbon(f'road_{i}', line, 8, .04, road)
        ribbon(f'kerb_{i}', line, 9, .02, kerb)
        ribbon(f'verge_{i}', line, 11, -.004, path)
    for i, line in enumerate(PATHS):
        ribbon(f'path_{i}', line, 3.4, .03, path)

def block_mesh(name, w, d, h, materials):
    """An axis-aligned block, its walls and roof using separate materials."""
    import bpy
    x, y = w / 2, d / 2
    verts = [(-x, -y, 0), (x, -y, 0), (x, y, 0), (-x, y, 0), (-x, -y, h), (x, -y, h), (x, y, h), (-x, y, h)]
    faces = [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7), (4, 5, 6, 7)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    for m in materials:
        mesh.materials.append(m)
    for p in mesh.polygons:
        p.material_index = 1 if p.normal.z > .5 else 0
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj

def offices(theme):
    """Office blocks round the campus: a facade over a recessed glazed lobby,
    a parapet, and plant on the roof."""
    import bpy
    rng = random.Random(23)
    roof = paving('roof', TEXTURES['roof'], 2, .8, .3)
    trim = paving('trim', TEXTURES['concrete'], 3, 1.2, .3)
    plant = plain('plant', (.32, .33, .34), .45, .7)
    for k, ((a, b), (wa, wb), tall, turn, style) in enumerate(BLOCKS):
        if not tall_clear(a, b - wb / 2, tall):
            print('YARD_ENV skipped block', (a, b), flush=True)
            continue
        x, y = to_ground(a, b)
        # Blocks face the screen frame, so their fronts square to the view.
        heading = math.atan2(*to_ground(1, 0)[::-1]) + math.radians(turn)
        z = min(height(*to_ground(a + i * wa / 2, b + j * wb / 2)) for i in (-1, 1) for j in (-1, 1)) - .2
        lobby = block_mesh(f'lobby_{k}', wa - 1.2, wb - 1.2, 4.2, [facade('glass', theme, 100 + k), roof])
        body = block_mesh(f'block_{k}', wa, wb, tall - 4, [facade(style, theme, k), roof])
        for obj, lift in ((lobby, 0), (body, 4)):
            obj.location = (x, y, z + lift)
            obj.rotation_euler = (0, 0, heading)
        # Parapet and rooftop plant.
        for s in (-1, 1):
            for along, size in ((0, (wa + .3, .3, 1.1)), (1, (.3, wb + .3, 1.1))):
                ox, oy = (0, s * wb / 2) if along == 0 else (s * wa / 2, 0)
                gx, gy = x + ox * math.cos(heading) - oy * math.sin(heading), y + ox * math.sin(heading) + oy * math.cos(heading)
                box((gx, gy, z + tall + .55), size, heading, trim, 'parapet')
        for j in range(rng.randint(2, 4)):
            ox, oy = rng.uniform(-wa / 3, wa / 3), rng.uniform(-wb / 3, wb / 3)
            gx, gy = x + ox * math.cos(heading) - oy * math.sin(heading), y + ox * math.sin(heading) + oy * math.cos(heading)
            box((gx, gy, z + tall + .9), (rng.uniform(2, 5), rng.uniform(2, 4), 1.8), heading, plant, 'plant')
        if theme == 'dark':
            lamp = bpy.data.objects.new('lobby_light', bpy.data.lights.new('lobby_light', 'AREA'))
            lamp.data.energy, lamp.data.color = 800, (1, .8, .6)
            lamp.data.size = min(wa, wb) * .6
            lamp.location = (x, y, z + 3.9)
            bpy.context.scene.collection.objects.link(lamp)

def model(asset, target, names):
    """A Poly Haven model (only the named objects) as an unlinked collection,
    scaled to `target` metres tall."""
    import bpy
    from mathutils import Matrix, Vector
    path = polyhaven.model(asset)
    with bpy.data.libraries.load(str(path), link=False) as (src, dst):
        dst.objects = [n for n in src.objects if names is None or n in names]
    coll = bpy.data.collections.new(asset)
    meshes = [o for o in dst.objects if o and o.type == 'MESH']
    for o in meshes:
        coll.objects.link(o)
        if names:
            o.location = (0, 0, 0)
    if target:
        top = max((o.matrix_world @ Vector(c)).z for o in meshes for c in o.bound_box)
        for o in meshes:
            o.matrix_world = Matrix.Scale(target / top, 4) @ o.matrix_world
    return coll

def place(coll, x, y, turn=0, scale=1, z=None):
    import bpy
    inst = bpy.data.objects.new(coll.name, None)
    inst.instance_type, inst.instance_collection = 'COLLECTION', coll
    inst.location = (x, y, height(x, y) if z is None else z)
    inst.rotation_euler = (0, 0, turn)
    inst.scale = (scale,) * 3
    bpy.context.scene.collection.objects.link(inst)

def street_trees(s):
    """Trees in rows along both sides of the avenues and the main paths."""
    rng = random.Random(31)
    kinds = [s['tree_small_02'], s['tree_small_02'], s['island_tree_02']]
    for lines, offset, spacing in ((ROADS, 7.5, 13), (PATHS[:2], 3.6, 12)):
        for line in lines:
            for (a0, b0), (a1, b1) in zip(line, line[1:]):
                length = math.hypot(a1 - a0, b1 - b0)
                na, nb = -(b1 - b0) / length, (a1 - a0) / length
                for i in range(int(length / spacing)):
                    t = (i + .5) * spacing / length
                    for side in (-1, 1):
                        a, b = a0 + (a1 - a0) * t + na * offset * side, b0 + (b1 - b0) * t + nb * offset * side
                        x, y = to_ground(a, b)
                        if (live_distance(x, y) < 4 or plaza_distance(x, y) < 3 or not tall_clear(a, b, 7)
                                or block_distance(a, b) < 4 or pond_shape(a, b) < 1.3):
                            continue
                        place(rng.choice(kinds), x, y, rng.uniform(0, math.tau), rng.uniform(.85, 1.1))

def street_lamps(s, theme):
    """Street lamps along the avenues and paths, lit at dusk."""
    import bpy
    lamp = s['street_lamp_01']
    if theme == 'dark':
        glow = plain('lamp_glow', (1, 1, 1))
        bsdf = glow.node_tree.nodes['Principled BSDF']
        bsdf.inputs['Emission Color'].default_value = (1, .78, .5, 1)
        bsdf.inputs['Emission Strength'].default_value = 60
        for o in lamp.objects:
            for i, m in enumerate(o.data.materials):
                if m.name.endswith(('glass', 'bulb')):
                    o.data.materials[i] = glow
    spots = []
    for lines, offset, spacing in ((ROADS, 4.6, 22), (PATHS, 2.2, 14)):
        for line in lines:
            for (a0, b0), (a1, b1) in zip(line, line[1:]):
                length = math.hypot(a1 - a0, b1 - b0)
                na, nb = -(b1 - b0) / length, (a1 - a0) / length
                for i in range(int(length / spacing)):
                    t = (i + .25) * spacing / length
                    side = 1 if (len(spots) % 2) else -1
                    spots.append((a0 + (a1 - a0) * t + na * offset * side, b0 + (b1 - b0) * t + nb * offset * side,
                                  math.atan2(nb * side, na * side)))
    for a, b, facing in spots:
        x, y = to_ground(a, b)
        if live_distance(x, y) < 3 or plaza_distance(x, y) < 1.5 or not tall_clear(a, b, 4) or block_distance(a, b) < 2:
            continue
        turn = facing + math.atan2(*to_ground(1, 0)[::-1])
        place(lamp, x, y, turn + math.pi)
        if theme == 'dark':
            bulb = bpy.data.objects.new('lamp_light', bpy.data.lights.new('lamp_light', 'POINT'))
            bulb.data.energy, bulb.data.color, bulb.data.shadow_soft_size = 1100, (1, .72, .45), .15
            bulb.location = (x, y, height(x, y) + 3.6)
            bpy.context.scene.collection.objects.link(bulb)

def furniture(s):
    """Planters and benches round the plaza's back and left edges, which stand
    farther from the camera than anything on it, and café tables by the pond."""
    rng = random.Random(17)
    edge = [(x * 1.06, y * 1.06) for x, y in plaza_outline(3.2) if y > 3 or (x < -12 and y > PLAZA_FRONT[2] + 2)]
    for i, (x, y) in enumerate(edge):
        turn = math.atan2(y, x) + math.pi / 2 if math.hypot(x, y) < PLAZA_RADIUS * 1.2 else math.pi / 2
        place(s['planter_box_02'] if i % 2 else s['painted_wooden_bench'], x, y, turn)
    ca, cb, ra, rb = POND
    for k in range(5):
        a, b = ca + ra * .6 + k * 2.4 - 4, cb - rb - 3 - (k % 2) * 1.5
        x, y = to_ground(a, b)
        if live_distance(x, y) > 3 and tall_clear(a, b, 1):
            place(s['outdoor_table_chair_set_01'], x, y, rng.uniform(0, math.tau))

def lights(theme):
    dusk = theme == 'dark'
    sky_lights(SKIES[theme], theme, .3 if dusk else .9, 1.8 if dusk else 3.4, 2.5 if dusk else 1.2,
               (1, .58, .34) if dusk else (1, .95, .87))

def halls():
    import bpy
    bpy.ops.import_scene.gltf(filepath=str(ROOT / 'web/yard/assets/professional.glb'))

def build(with_halls=True, theme='light'):
    import bpy
    bpy.ops.wm.read_factory_settings(use_empty=True)
    random.seed(406)
    lights(theme)
    terrain()
    pond()
    plaza(theme)
    avenues()
    s = {a: model(a, h, names) for a, (h, names) in MODELS.items()}
    scatter('woods', [s['island_tree_01'], s['island_tree_02'], s['tree_small_02']], 'woods', .05, 4, (.8, 1.3), 61)
    scatter('copses', [s['island_tree_02'], s['tree_small_02']], 'copse', .02, 6, (.75, 1.1), 62)
    scatter('shrubs', [c for a in SHRUBS for c in variant_sets(a)], 'shrubs', .25, 1.5, (.8, 1.4), 63)
    scatter('reeds', reeds(), 'reeds', .5, .8, (.6, .9), 64)
    offices(theme)
    street_trees(s)
    street_lamps(s, theme)
    furniture(s)
    if with_halls:
        halls()

if __name__ == '__main__' and '--preview' in sys.argv:
    preview(sys.modules[__name__], 'dark' if '--dark' in sys.argv else 'light')
