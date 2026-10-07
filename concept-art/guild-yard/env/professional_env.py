"""Professional environment for the Yard's pre-rendered plates: a busy city
of glass, concrete and brick round a paved civic square, with a street grid,
parked traffic, street furniture and a pocket park.

Preview renders from the live camera into .cache/yard-env/:
  blender -b --factory-startup --python concept-art/guild-yard/env/professional_env.py -- --preview [--dark]
The live halls and characters stand on a level paved plaza at y = 0.
The buildings are modelled here with a curtain-wall shader; the vehicles are
TRELLIS.2 models from concept-art/professional-yard; everything else is Poly
Haven CC0, fetched by polyhaven.py. Layout uses the screen-aligned ground
frame described in common.py.
"""
import math, random, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import polyhaven
from camera import ROOT
# plates.py and preview() call render_settings through this module.
from common import (COURTYARD_RADIUS, to_ground, to_frame, smooth, play_distance, live_distance, tall_clear,
                    line_distance, surface, painted, mix, scatter, variant_sets, slab, building, lights as sky_lights,
                    render_settings, preview)

# Sky per theme: a clear late morning for light, dusk for dark.
SKIES = {'light': 'kloofendal_38d_partly_cloudy_puresky', 'dark': 'qwantani_dusk_1_puresky'}
TEXTURES = {'plaza': 'large_grey_tiles', 'path': 'concrete_pavers_02', 'road': 'asphalt_02', 'kerb': 'granite_tile',
            'concrete': 'concrete_wall_008', 'panel': 'concrete_tile_facade', 'roof': 'gravel_floor',
            'brick': 'red_brick_03', 'brown': 'brown_brick_02', 'plaster': 'plaster_grey_04'}
# Model and target height in metres (None keeps Poly Haven's real size).
# Only the named objects are used: the plant sets also hold lower LODs.
MODELS = {
    'island_tree_02': (8, ['island_tree_02_LOD0']), 'tree_small_02': (6.5, ['tree_small_02_LOD0']),
    'jacaranda_tree': (8, ['jacaranda_tree_LOD0']),
    'planter_box_02': (None, ['planter_box_02']), 'painted_wooden_bench': (None, ['painted_wooden_bench']),
    'outdoor_table_chair_set_01': (None, None), 'street_lamp_01': (None, ['street_lamp_01']),
    'street_lamp_02': (None, ['street_lamp_02']),
    'fire_hydrant': (None, ['fire_hydrant', 'fire_hydrant_cap_01', 'fire_hydrant_cap_02', 'fire_hydrant_cap_03', 'fire_hydrant_chain']),
    'metal_trash_can': (None, ['metal_trash_can', 'metal_trash_can_lid', 'metal_trash_can_handle_left', 'metal_trash_can_handle_right']),
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
# The city's TRELLIS.2 vehicles: target height in metres.
VEHICLES = ROOT / '.cache/professional-yard/models'
CARS = {'car_sedan': 1.5, 'car_hatch': 1.55, 'car_suv': 1.75, 'car_taxi': 1.6}
BIG = {'city_bus': 3.3, 'delivery_van': 2.6}
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
# Streets: avenues either side of the square, cross streets behind and in
# front of it, and the grid beyond. Each is a straight two-point line.
ROAD_WIDTH, SIDEWALK = 8, 4.5
AVENUES = [-150, -92, -26, 26, 92, 150]
CROSS = [-116, -46, 24, 80]
STREETS = [[(a, -170), (a, 170)] for a in AVENUES] + [[(-210, b), (210, b)] for b in CROSS]
# City blocks: the cells of the grid, as (a0, a1, b0, b1). The cells beside the
# square hold only its promenade.
EDGES_A = [-210, *AVENUES, 210]
EDGES_B = [-170, *CROSS, 170]
PARKS = [(-92, -26, 24, 80), (26, 92, -116, -46)]
# Footpaths across the parks, corner to corner.
PATHS = ([[(a0 + 5, b0 + 5), ((a0 + a1) / 2, (b0 + b1) / 2), (a1 - 5, b1 - 5)] for a0, a1, b0, b1 in PARKS]
         + [[(a0 + 5, b1 - 5), ((a0 + a1) / 2, (b0 + b1) / 2), (a1 - 5, b0 + 5)] for a0, a1, b0, b1 in PARKS])
# Facade styles: bay width, storey height, the solid share of each bay
# (across, up), glass tint and the solid material's Poly Haven set.
STYLES = {
    'glass': (1.6, 3.9, .07, .16, (.05, .09, .11), 'panel'),
    'band': (1.8, 3.9, .05, .42, (.07, .1, .12), 'concrete'),
    'grid': (2.2, 3.9, .42, .45, (.06, .08, .09), 'concrete'),
    'brick': (2.6, 3.6, .52, .48, (.05, .07, .08), 'brick'),
    'brown': (2.4, 3.6, .5, .46, (.06, .08, .09), 'brown'),
    'plaster': (2.8, 3.6, .55, .5, (.06, .09, .1), 'plaster'),
}
TALL_STYLES, LOW_STYLES = ['glass', 'band', 'grid'], ['brick', 'brown', 'plaster', 'grid']
AWNINGS = [(.78, .2, .16), (.12, .35, .6), (.1, .45, .3), (.85, .6, .1), (.45, .2, .5), (.2, .2, .22)]

def on_plaza(x, y, margin=0):
    x0, x1, y0, y1 = PLAZA_FRONT
    in_front = x0 - margin <= x <= x1 + margin and y0 - margin <= y <= y1 + margin
    return math.hypot(x, y) <= PLAZA_RADIUS + margin or in_front

def plaza_distance(x, y):
    x0, x1, y0, y1 = PLAZA_FRONT
    ring = math.hypot(x, y) - PLAZA_RADIUS
    box = math.hypot(max(x0 - x, 0, x - x1), max(y0 - y, 0, y - y1))
    return 0 if on_plaza(x, y) else min(ring, box)

def in_park(a, b, margin=0):
    return any(a0 + margin <= a <= a1 - margin and b0 + margin <= b <= b1 - margin for a0, a1, b0, b1 in PARKS)

def cells():
    """The city blocks between the streets, inset to the building line."""
    inset = ROAD_WIDTH / 2 + SIDEWALK
    for a0, a1 in zip(EDGES_A, EDGES_A[1:]):
        for b0, b1 in zip(EDGES_B, EDGES_B[1:]):
            if (a0, a1, b0, b1) in PARKS or (a0 == -26 and b0 >= -46 and b1 <= 24):
                continue
            yield a0 + inset, a1 - inset, b0 + inset, b1 - inset

def parcels(rng):
    """Buildings filling each block: rows of parcels along the street, each a
    footprint, a height for its part of the city and a facade style."""
    for a0, a1, b0, b1 in cells():
        wa, wb = a1 - a0, b1 - b0
        rows = max(1, round(wb / 24))
        depth = wb / rows
        for r in range(rows):
            b_lo = b0 + r * depth
            a = a0
            while a1 - a > 8:
                w = min(rng.uniform(12, 28), a1 - a)
                if a1 - (a + w) < 10:
                    w = a1 - a
                ca, cb = a + w / 2, b_lo + depth / 2
                a += w + 1.5
                d = depth - 1.5
                # Taller the farther up the screen; low shopfronts in front.
                if cb > 24:
                    tall = rng.uniform(22, 48) + (rng.uniform(20, 40) if rng.random() < .22 and abs(ca) > 40 else 0)
                elif cb > -46:
                    tall = rng.uniform(14, 36)
                else:
                    tall = rng.uniform(8, 16) if abs(ca) < 70 else rng.uniform(12, 30)
                tall = round(tall / 3.9) * 3.9 + 4
                style = rng.choice(TALL_STYLES if tall > 24 else LOW_STYLES)
                yield (ca, cb), (w - 1.5, d), tall, style

def masks(x, y):
    from mathutils import noise, Vector
    a, b = to_frame(x, y)
    park = 1 if in_park(a, b, 2) else 0
    road = line_distance(STREETS, a, b)
    paved = min(road - ROAD_WIDTH / 2 - 1.5, line_distance(PATHS, a, b) - 2.2)
    lawn = smooth(0, 1.5, paved) * park
    copse = smooth(.2, .34, noise.noise(Vector((x / 12, y / 12, 3.1)))) * lawn
    shrubs = smooth(.25, .36, noise.noise(Vector((x / 6, y / 6, 8.3)))) * lawn
    return {'lawn': lawn, 'copse': copse, 'shrubs': shrubs,
            'tint': smooth(-.1, .4, noise.noise(Vector((x / 11, y / 11, 5.7))))}

def height(x, y):
    """Level city ground, with a barely-there roll away from the square."""
    from mathutils import noise, Vector
    roll = noise.fractal(Vector((x / 40, y / 40, .7)), 1.0, 2.0, 3) * .12
    return roll * smooth(2, 10, play_distance(x, y)) * smooth(2, 6, plaza_distance(x, y))

# --- Materials --------------------------------------------------------------
def ground_material():
    """City pavement, with mown lawn in the parks."""
    import bpy
    m = bpy.data.materials.new('ground')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = nodes['Principled BSDF']
    coord = nodes.new('ShaderNodeTexCoord').outputs['Object']
    grass, grass_rough, grass_normal = painted(nodes, links, 'meadow', 5, coord, dry=(1.04, 1, .8, 1))
    tint = nodes.new('ShaderNodeAttribute')
    tint.attribute_name = 'tint'
    mown = nodes.new('ShaderNodeMix')
    mown.data_type, mown.blend_type = 'RGBA', 'MULTIPLY'
    links.new(tint.outputs['Fac'], mown.inputs['Factor'])
    links.new(grass, mown.inputs[6])
    mown.inputs[7].default_value = (.8, .9, .7, 1)
    color, rough, normal = surface(nodes, links, TEXTURES['path'], 2.2, coord)
    tone = nodes.new('ShaderNodeHueSaturation')
    tone.inputs['Saturation'].default_value, tone.inputs['Value'].default_value = .35, 1.0
    links.new(color, tone.inputs['Color'])
    wear = nodes.new('ShaderNodeTexNoise')
    wear.inputs['Scale'].default_value = .05
    links.new(coord, wear.inputs['Vector'])
    span = nodes.new('ShaderNodeMapRange')
    span.inputs['To Min'].default_value, span.inputs['To Max'].default_value = .82, 1.04
    links.new(wear.outputs['Fac'], span.inputs['Value'])
    shade = nodes.new('ShaderNodeMix')
    shade.data_type, shade.blend_type = 'RGBA', 'MULTIPLY'
    shade.inputs['Factor'].default_value = 1
    links.new(tone.outputs['Color'], shade.inputs[6])
    links.new(span.outputs['Result'], shade.inputs[7])
    lawn = nodes.new('ShaderNodeAttribute')
    lawn.attribute_name = 'lawn'
    color, rough, normal = (mix(nodes, links, kind, lawn.outputs['Fac'], low, high)
                            for kind, low, high in zip(('RGBA', 'FLOAT', 'VECTOR'), (shade.outputs[2], rough, normal),
                                                       (mown.outputs[2], grass_rough, grass_normal)))
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
    """Still, dark and reflective: the pool on the square."""
    import bpy
    m = bpy.data.materials.new('water')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (.01, .03, .035, 1)
    bsdf.inputs['Roughness'].default_value = .03
    bsdf.inputs['IOR'].default_value = 1.33
    ripples = nodes.new('ShaderNodeTexNoise')
    ripples.inputs['Scale'].default_value = 2
    ripples.inputs['Detail'].default_value = 6
    bump = nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = .04
    links.new(ripples.outputs['Fac'], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
    return m

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
    tone.inputs['Saturation'].default_value = .5 if solid in ('concrete', 'panel') else .8
    tone.inputs['Value'].default_value = {'concrete': 1.15, 'panel': .9, 'plaster': 1.05}.get(solid, .95)
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
        lit = math_node('GREATER_THAN', noise.outputs['Value'], .55)
        glass.inputs['Emission Color'].default_value = (1, .72, .45, 1)
        links.new(math_node('MULTIPLY', lit, 1.6), glass.inputs['Emission Strength'])
    blend = nodes.new('ShaderNodeMixShader')
    links.new(solid_mask, blend.inputs['Fac'])
    links.new(glass.outputs['BSDF'], blend.inputs[1])
    links.new(wall.outputs['BSDF'], blend.inputs[2])
    links.new(blend.outputs['Shader'], out.inputs['Surface'])
    return m

def plain(name, rgb, rough=.6, metal=0, glow=0):
    import bpy
    m = bpy.data.materials.new(name)
    bsdf = m.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    if glow:
        bsdf.inputs['Emission Color'].default_value = (*rgb, 1)
        bsdf.inputs['Emission Strength'].default_value = glow
    return m

# --- Geometry ---------------------------------------------------------------
def terrain():
    import bpy, bmesh
    size, cuts = 460, 460
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

def frame_box(a, b, z, size, material, turn=0, name='box'):
    """A box placed in the screen frame, squared to it."""
    x, y = to_ground(a, b)
    return box((x, y, z), size, heading() + turn, material, name)

def heading():
    """The ground angle of screen-right, so geometry squares to the view."""
    return math.atan2(*to_ground(1, 0)[::-1])

def plaza(theme):
    """The paved square the live halls and characters stand on: a granite kerb, a
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

def intersections():
    for a in AVENUES:
        for b in CROSS:
            yield a, b

def streets(theme):
    """Asphalt streets with granite kerbs and paved sidewalks, lane dashes,
    crosswalks and traffic lights at every intersection."""
    road = paving('road', TEXTURES['road'], 4, .8, .2)
    path = paving('path', TEXTURES['path'], 1.6, 1.15, .4)
    kerb = paving('road_kerb', TEXTURES['kerb'], 1.8, 1.05, .25)
    paint = plain('paint', (.92, .92, .88), .5)
    yellow = plain('paint_yellow', (.9, .75, .2), .5)
    for i, line in enumerate(STREETS):
        ribbon(f'road_{i}', line, ROAD_WIDTH, .04, road)
        ribbon(f'kerb_{i}', line, ROAD_WIDTH + 1, .02, kerb)
        ribbon(f'walk_{i}', line, ROAD_WIDTH + 2 * SIDEWALK, -.004, path)
        # A dashed centre line, broken at the intersections.
        (a0, b0), (a1, b1) = line
        along = (a1 - a0, b1 - b0)
        length = math.hypot(*along)
        da, db = along[0] / length, along[1] / length
        turn = math.atan2(db, da)
        for k in range(int(length / 9)):
            t = (k + .5) * 9
            a, b = a0 + da * t, b0 + db * t
            if any(math.hypot(a - ia, b - ib) < 11 for ia, ib in intersections()) or plaza_distance(*to_ground(a, b)) < 3:
                continue
            frame_box(a, b, .085, (3, .18, .02), yellow, turn, 'dash')
    for i, line in enumerate(PATHS):
        ribbon(f'path_{i}', line, 3.2, .03, path)
    for ia, ib in intersections():
        for da, db in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            # Five stripes across the arm, just outside the junction.
            a, b = ia + da * (ROAD_WIDTH / 2 + 2.2), ib + db * (ROAD_WIDTH / 2 + 2.2)
            for s in range(-2, 3):
                frame_box(a + db * s * 1.5, b + da * s * 1.5, .085, (1.6, .7, .02) if da else (.7, 1.6, .02), paint, 0, 'stripe')
        traffic_lights(ia, ib, theme)

def traffic_lights(ia, ib, theme):
    """A signal on two opposite corners of the junction."""
    pole = plain('signal_pole', (.2, .21, .22), .5, .6)
    housing = plain('signal_housing', (.12, .12, .12), .6)
    lamps = [plain(f'signal_{c}', rgb, .3, 0, 6 if theme == 'dark' else 2)
             for c, rgb in (('red', (1, .1, .05)), ('amber', (1, .6, .05)), ('green', (.1, 1, .3)))]
    r = ROAD_WIDTH / 2 + 1.2
    for k, (sa, sb) in enumerate(((1, 1), (-1, -1))):
        a, b = ia + sa * r, ib + sb * r
        x, y = to_ground(a, b)
        z = height(x, y)
        frame_box(a, b, z + 2.4, (.14, .14, 4.8), pole, 0, 'signal_pole')
        frame_box(a, b, z + 4.4, (.36, .3, 1.0), housing, 0, 'signal_housing')
        on = (k + ia // 10 + ib // 10) % 3
        for j, lamp in enumerate(lamps):
            frame_box(a, b - .17 * sb, z + 4.75 - j * .32, (.18, .04, .18), lamp if j == on else housing, 0, 'signal_lamp')

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

def buildings(theme):
    """The city's buildings: a facade over a glazed ground floor, a parapet and
    plant on the roof; shopfront awnings and signs on the low ones, a setback
    crown and a beacon on the towers. Heights drop where a building would rise
    over the live area on screen."""
    import bpy
    rng = random.Random(23)
    roof = paving('roof', TEXTURES['roof'], 2, .5, .2)
    trim = paving('trim', TEXTURES['concrete'], 3, 1.1, .3)
    plant = plain('plant', (.32, .33, .34), .45, .7)
    panels = plain('panels', (.08, .1, .16), .25, .4)
    beacon = plain('beacon', (1, .15, .1), .4, 0, 30 if theme == 'dark' else 3)
    pool = {style: [facade(style, theme, s) for s in range(4)] for style in STYLES}
    lobbies = [facade('glass', theme, 100 + s) for s in range(4)]
    awnings = [plain(f'awning_{i}', rgb, .7) for i, rgb in enumerate(AWNINGS)]
    signs = [plain(f'sign_{i}', rgb, .4, 0, 14 if theme == 'dark' else 1.5)
             for i, rgb in enumerate([(1, .3, .2), (.3, .6, 1), (.2, 1, .5), (1, .8, .2), (.9, .4, 1), (1, 1, 1)])]
    turn = heading()
    k = 0
    lobby_lights = 0
    for (a, b), (wa, wb), tall, style in parcels(rng):
        # Lower a building until its screen rise stays off the live area.
        while tall > 8 and not tall_clear(a, b - wb / 2, tall):
            tall -= 3.9
        if not tall_clear(a, b - wb / 2, tall):
            continue
        x, y = to_ground(a, b)
        z = min(height(*to_ground(a + i * wa / 2, b + j * wb / 2)) for i in (-1, 1) for j in (-1, 1)) - .2
        lobby = block_mesh(f'lobby_{k}', wa - 1.0, wb - 1.0, 4.2, [rng.choice(lobbies), roof])
        body = block_mesh(f'block_{k}', wa, wb, tall - 4, [rng.choice(pool[style]), roof])
        for obj, lift in ((lobby, 0), (body, 4)):
            obj.location = (x, y, z + lift)
            obj.rotation_euler = (0, 0, turn)
        def local(oa, ob):
            return x + oa * math.cos(turn) - ob * math.sin(turn), y + oa * math.sin(turn) + ob * math.cos(turn)
        # Parapet and rooftop plant.
        for s in (-1, 1):
            for along, size in ((0, (wa + .3, .3, 1.1)), (1, (.3, wb + .3, 1.1))):
                oa, ob = (0, s * wb / 2) if along == 0 else (s * wa / 2, 0)
                box((*local(oa, ob), z + tall + .55), size, turn, trim, 'parapet')
        for j in range(rng.randint(2, 5)):
            oa, ob = rng.uniform(-wa / 3, wa / 3), rng.uniform(-wb / 3, wb / 3)
            box((*local(oa, ob), z + tall + .9), (rng.uniform(2, 5), rng.uniform(2, 4), 1.8), turn, plant, 'plant')
        if tall > 44:
            crown = block_mesh(f'crown_{k}', wa * .62, wb * .62, 6, [rng.choice(pool['glass']), roof])
            crown.location, crown.rotation_euler = (x, y, z + tall + .2), (0, 0, turn)
        elif rng.random() < .35:
            # A penthouse or plant room, or a field of solar panels.
            if rng.random() < .5:
                house = block_mesh(f'penthouse_{k}', wa * .45, wb * .45, 3.4, [rng.choice(pool['plaster']), roof])
                house.location, house.rotation_euler = (*local(rng.uniform(-.2, .2) * wa, rng.uniform(-.2, .2) * wb), z + tall + .2), (0, 0, turn)
            else:
                for j in range(int(wb / 3.2)):
                    box((*local(0, -wb / 2 + 2 + j * 3.2), z + tall + .6), (wa * .7, 2.2, .12), turn, panels, 'panels')
            bpy.ops.mesh.primitive_uv_sphere_add(radius=.35, location=(x, y, z + tall + 6.8))
            bpy.context.object.data.materials.append(beacon)
        if tall < 20:
            # Shopfronts along the face toward the square, where the camera looks.
            face = (0, -1) if abs(b) > abs(a) * .8 and b > 0 else (0, 1) if b < -40 else (-1 if a > 0 else 1, 0)
            fa, fb = face
            width = wa if fb else wb
            n = max(1, int(width / 6))
            for j in range(n):
                offset = (j + .5) * width / n - width / 2
                oa, ob = (offset, fb * (wb / 2 + .5)) if fb else (fa * (wa / 2 + .5), offset)
                size = (width / n - .6, 1.1, .12) if fb else (1.1, width / n - .6, .12)
                box((*local(oa, ob), z + 3.1), size, turn, rng.choice(awnings), 'awning')
            oa, ob = (0, fb * (wb / 2 + .12)) if fb else (fa * (wa / 2 + .12), 0)
            size = (width * .5, .14, .7) if fb else (.14, width * .5, .7)
            box((*local(oa, ob), z + 4.9), size, turn, rng.choice(signs), 'sign')
        if theme == 'dark' and lobby_lights < 90 and abs(a) < 110 and -100 < b < 100:
            lamp = bpy.data.objects.new('lobby_light', bpy.data.lights.new('lobby_light', 'AREA'))
            lamp.data.energy, lamp.data.color = 700, (1, .8, .6)
            lamp.data.size = min(wa, wb) * .6
            lamp.location = (x, y, z + 3.9)
            bpy.context.scene.collection.objects.link(lamp)
            lobby_lights += 1
        k += 1
    print('YARD_ENV buildings', k, flush=True)

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
        if names and len(names) == 1:
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

def along_streets(spacing, offset, phase=.5):
    """Points along both sides of every street, `offset` metres from its centre
    line, with the street's heading, skipping the junctions."""
    for line in STREETS:
        (a0, b0), (a1, b1) = line
        length = math.hypot(a1 - a0, b1 - b0)
        da, db = (a1 - a0) / length, (b1 - b0) / length
        for i in range(int(length / spacing)):
            t = (i + phase) * spacing
            for side in (-1, 1):
                a, b = a0 + da * t - db * offset * side, b0 + db * t + da * offset * side
                if any(math.hypot(a - ia, b - ib) < 13 for ia, ib in intersections()):
                    continue
                yield a, b, math.atan2(db, da), side

def clear(a, b, tall=4):
    x, y = to_ground(a, b)
    return live_distance(x, y) > 4 and plaza_distance(x, y) > 2 and tall_clear(a, b, tall)

def street_trees(s):
    """Trees along the sidewalks, round the square's promenade and in the parks."""
    rng = random.Random(31)
    kinds = [s['tree_small_02'], s['jacaranda_tree'], s['island_tree_02']]
    for a, b, facing, side in along_streets(14, ROAD_WIDTH / 2 + 3.2, .3):
        if clear(a, b, 8) and not in_park(a, b, -1):
            place(rng.choice(kinds), *to_ground(a, b), rng.uniform(0, math.tau), rng.uniform(.8, 1.05))
    # A ring of trees on the promenade round the square, behind the live area.
    for i in range(14):
        t = math.pi * (.1 + .8 * i / 13)
        a, b = 19 * math.cos(t), 19 * math.sin(t)
        if clear(a, b, 8):
            place(rng.choice(kinds), *to_ground(a, b), rng.uniform(0, math.tau), rng.uniform(.85, 1.0))

def street_lamps(s, theme):
    """Street lamps along the streets and paths, lit at dusk."""
    import bpy
    lamp = s['street_lamp_02']
    if theme == 'dark':
        glow = plain('lamp_glow', (1, 1, 1))
        bsdf = glow.node_tree.nodes['Principled BSDF']
        bsdf.inputs['Emission Color'].default_value = (1, .78, .5, 1)
        bsdf.inputs['Emission Strength'].default_value = 60
        for o in lamp.objects:
            for i, m in enumerate(o.data.materials):
                if m.name.endswith(('glass', 'bulb')):
                    o.data.materials[i] = glow
    spots = [(a, b, facing + (math.pi / 2 if side > 0 else -math.pi / 2))
             for a, b, facing, side in along_streets(26, ROAD_WIDTH / 2 + 1.0, .7)]
    for line in PATHS:
        for (a0, b0), (a1, b1) in zip(line, line[1:]):
            length = math.hypot(a1 - a0, b1 - b0)
            na, nb = -(b1 - b0) / length, (a1 - a0) / length
            for i in range(int(length / 16)):
                t = (i + .4) * 16 / length
                spots.append((a0 + (a1 - a0) * t + na * 2.2, b0 + (b1 - b0) * t + nb * 2.2, math.atan2(nb, na)))
    lit = 0
    for a, b, facing in spots:
        if not clear(a, b):
            continue
        x, y = to_ground(a, b)
        place(lamp, x, y, facing + heading() + math.pi)
        if theme == 'dark' and lit < 160 and abs(a) < 130 and -110 < b < 110:
            bulb = bpy.data.objects.new('lamp_light', bpy.data.lights.new('lamp_light', 'POINT'))
            bulb.data.energy, bulb.data.color, bulb.data.shadow_soft_size = 900, (1, .72, .45), .15
            bulb.location = (x, y, height(x, y) + 3.6)
            bpy.context.scene.collection.objects.link(bulb)
            lit += 1

def furniture(s):
    """Planters and benches round the square's back edges and promenade,
    hydrants and bins along the sidewalks, and café tables in the parks."""
    rng = random.Random(17)
    edge = [(x * 1.06, y * 1.06) for x, y in plaza_outline(3.2) if y > 3 or (x < -12 and y > PLAZA_FRONT[2] + 2)]
    for i, (x, y) in enumerate(edge):
        turn = math.atan2(y, x) + math.pi / 2 if math.hypot(x, y) < PLAZA_RADIUS * 1.2 else math.pi / 2
        place(s['planter_box_02'] if i % 2 else s['painted_wooden_bench'], x, y, turn)
    for i, (a, b, facing, side) in enumerate(along_streets(31, ROAD_WIDTH / 2 + 1.1, .15)):
        if clear(a, b, 1):
            place(s['fire_hydrant'] if i % 3 else s['metal_trash_can'], *to_ground(a, b), rng.uniform(0, math.tau))
    for a0, a1, b0, b1 in PARKS:
        for k in range(6):
            a, b = rng.uniform(a0 + 12, a1 - 12), rng.uniform(b0 + 12, b1 - 12)
            if line_distance(PATHS, a, b) > 3 and clear(a, b, 1):
                place(s['outdoor_table_chair_set_01'], *to_ground(a, b), rng.uniform(0, math.tau))

def vehicles(theme):
    """Parked cars along every kerb and a few in the lanes, with the buses and
    vans among them. TRELLIS.2 models face -Y, which is a car's front."""
    import bpy
    rng = random.Random(41)
    loaded = {}
    def load(name):
        if name not in loaded:
            path = VEHICLES / f'{name}.glb'
            loaded[name] = building(path, theme) if path.exists() else None
        return loaded[name]
    def put(name, a, b, facing):
        got = load(name)
        if not got:
            return
        coll, lo, size = got
        target = {**CARS, **BIG}[name]
        scale = target / size
        x, y = to_ground(a, b)
        inst = bpy.data.objects.new(name, None)
        inst.instance_type, inst.instance_collection = 'COLLECTION', coll
        inst.location = (x, y, height(x, y) - lo * scale + .04)
        inst.scale = (scale,) * 3
        inst.rotation_euler = (0, 0, facing + heading() + math.pi / 2)
        bpy.context.scene.collection.objects.link(inst)
    n = 0
    for a, b, facing, side in along_streets(7.5, ROAD_WIDTH / 2 - 1.2, .5):
        if not clear(a, b, 2) or rng.random() > .62:
            continue
        put(rng.choice(list(CARS)), a, b, facing + (math.pi if side < 0 else 0))
        n += 1
    for a, b, facing, side in along_streets(23, 1.6, .35):
        if not clear(a, b, 3) or rng.random() > .5:
            continue
        name = rng.choice(['city_bus', 'delivery_van', *CARS])
        put(name, a, b, facing + (math.pi if side < 0 else 0))
        n += 1
    print('YARD_ENV vehicles', n, flush=True)

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
    plaza(theme)
    streets(theme)
    s = {a: model(a, h, names) for a, (h, names) in MODELS.items()}
    scatter('copses', [s['island_tree_02'], s['tree_small_02'], s['jacaranda_tree']], 'copse', .03, 6, (.75, 1.1), 62)
    scatter('shrubs', [c for a in SHRUBS for c in variant_sets(a)], 'shrubs', .25, 1.5, (.8, 1.4), 63)
    buildings(theme)
    street_trees(s)
    street_lamps(s, theme)
    furniture(s)
    vehicles(theme)
    if with_halls:
        halls()

if __name__ == '__main__' and '--preview' in sys.argv:
    preview(sys.modules[__name__], 'dark' if '--dark' in sys.argv else 'light')
