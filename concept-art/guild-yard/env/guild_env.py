"""Guild environment for the Yard's pre-rendered plates: a lakeside estate on a
meadow, an orchard, and forested hills beyond.

Preview renders from the live camera into .cache/yard-env/:
  blender -b --factory-startup --python concept-art/guild-yard/env/guild_env.py -- --preview
Sources are Poly Haven CC0 assets fetched by polyhaven.py. Layout uses the
screen-aligned ground frame described in common.py.
"""
import math, random, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import polyhaven
from camera import ROOT
# plates.py and preview() call render_settings through this module.
from common import (COURTYARD_RADIUS, to_ground, to_frame, smooth, play_distance, live_distance,
                    tall_clear, line_distance, surface, painted, mix, textured, source, scatter,
                    variant_sets, reeds, sun, lights as sky_lights, lantern_posts, render_settings, preview)

# Sky per theme: late morning for light, dusk for dark.
SKIES = {'light': 'kloofendal_48d_partly_cloudy_puresky', 'dark': 'qwantani_dusk_2_puresky'}
TEXTURES = {
    'forest': 'forest_ground_04', 'shore': 'brown_mud_rocks_01', 'path': 'forest_ground_06', 'gravel': 'gravel_floor', 'courtyard': 'cobblestone_floor_08', 'kerb': 'castle_wall_slates',
}
# Model, target height in metres (None keeps Poly Haven's real size), and
# whether the .blend holds variants to pick between rather than one model.
MODELS = {
    'fir_tree_01': (16, False), 'pine_tree_01': (18, False), 'island_tree_01': (9, False),
    'island_tree_02': (8, False), 'island_tree_03': (10, False), 'tree_small_02': (4.2, False),
    'shrub_01': (1.3, False), 'shrub_02': (1.1, False), 'shrub_04': (1.2, False),
    'fern_02': (None, True), 'rock_moss_set_01': (None, True), 'rock_moss_set_02': (None, True),
    'boulder_01': (None, False), 'stone_01': (None, False), 'modular_wooden_pier': (None, True),
}
# Live hall materials by name: Poly Haven set, metres per repeat, and whether
# the palette colour tints it (provider roofs) or the texture shows as is.
SURFACES = {
    'wall': ('castle_wall_varriation', 2.5, ['stone', 'stoneLight'], False),
    'plinth': ('castle_wall_slates', 2.5, ['stoneDark', 'edge'], False),
    'roof': ('grey_roof_tiles_02', 1.5, ['amber', 'blue', 'emerald', 'violet', 'cyan', 'iron'], True),
    'wood': ('dark_wooden_planks', 2, ['wood', 'woodLight'], False),
}
WATER_LEVEL = -.5

def fetch_all():
    for sky in SKIES.values():
        polyhaven.hdri(sky)
    polyhaven.model('Lantern_01')
    for asset in TEXTURES.values():
        polyhaven.texture(asset)
    for asset in MODELS:
        polyhaven.model(asset)

# --- Layout -----------------------------------------------------------------
LAKE = (-84, 4, 44, 32)       # centre a, b and radii in the screen frame
PATHS = [[(0, -12), (-14, -20), (-30, -14), (-41, -6)],    # gate to the pier
         [(12, 4), (26, 2), (40, 4), (64, 2)],              # east gate through the orchard
         [(-4, 13), (-6, 28), (2, 44), (-4, 70)],           # north gate into the woods
         [(0, -14), (4, -34), (-6, -56), (2, -82)]]         # south road
ORCHARD = (34, 60, -24, 24)

def lake_shape(a, b):
    from mathutils import noise, Vector
    ca, cb, ra, rb = LAKE
    wobble = noise.noise(Vector((a / 18, b / 18, 2.1))) * .16
    return ((a - ca) / ra) ** 2 + ((b - cb) / rb) ** 2 + wobble

def path_distance(a, b):
    return line_distance(PATHS, a, b)

def masks(x, y):
    from mathutils import noise, Vector
    a, b = to_frame(x, y)
    n = noise.noise(Vector((x / 25, y / 25, 7.3)))
    lake = lake_shape(a, b)
    out = play_distance(x, y)
    path = 1 - smooth(.8, 1.7, path_distance(a, b) + n * .3) if math.hypot(x, y) > COURTYARD_RADIUS else 0
    shore = 1 - smooth(.86, .98, lake + n * .04)
    clear = 1 if tall_clear(a, b) else 0
    woods = max(smooth(22, 32, b + n * 9), smooth(58, 68, a + n * 9),
                smooth(52, 64, -b + n * 9) * smooth(30, 50, abs(a)))
    woods *= clear * (1 - shore)
    patches = noise.noise(Vector((x / 16, y / 16, 3.1)))
    copse = smooth(.12, .26, patches) * clear * (1 - path)
    oa0, oa1, ob0, ob1 = ORCHARD
    orchard = smooth(-1, 1, min(a - oa0, oa1 - a, b - ob0, ob1 - b)) * (1 - woods)
    meadow = max(0, 1 - woods - shore - path) * (1 if lake > 1.02 else 0)
    tall_grass = smooth(-.1, .35, noise.noise(Vector((x / 9, y / 9, 5.7))))
    return {'lake': lake, 'shore': shore, 'path': path, 'woods': woods, 'orchard': orchard,
            'meadow': meadow, 'clear': smooth(0, 6, out) * meadow, 'copse': copse * meadow,
            'reeds': (1 - smooth(.95, 1.06, lake)) * smooth(.8, .88, lake), 'tint': tall_grass}

def height(x, y):
    from mathutils import noise, Vector
    a, b = to_frame(x, y)
    m = masks(x, y)
    hills = smooth(30, 80, b) * 26 + smooth(60, 130, a) * 14 + smooth(55, 90, -b) * 6
    rough = noise.fractal(Vector((x / 70, y / 70, .3)), 1.0, 2.0, 5) * (1.2 + hills * .3)
    lake = -3.2 * smooth(1.05, .35, m['lake'])
    h = hills + rough + lake
    if m['lake'] > 1.1:
        h = max(h, WATER_LEVEL + .4)  # only the lake holds water
    # The play area stays level so live halls and characters stand on y = 0.
    return h * smooth(2, 14, play_distance(x, y))

# --- Materials --------------------------------------------------------------
def ground_material():
    """Terrain layers blended by the per-vertex masks."""
    import bpy
    m = bpy.data.materials.new('ground')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = nodes['Principled BSDF']
    coord = nodes.new('ShaderNodeTexCoord').outputs['Object']
    color, rough, normal = painted(nodes, links, 'meadow', 6, coord)
    tint = nodes.new('ShaderNodeAttribute')
    tint.attribute_name = 'tint'
    olive = nodes.new('ShaderNodeMix')
    olive.data_type, olive.blend_type = 'RGBA', 'MULTIPLY'
    links.new(tint.outputs['Fac'], olive.inputs['Factor'])
    links.new(color, olive.inputs[6])
    olive.inputs[7].default_value = (.72, .74, .5, 1)
    layers = [(olive.outputs[2], rough, normal)]
    for name, scale in [('woods', 3.5), ('shore', 3), ('path', 2.4)]:
        attr = nodes.new('ShaderNodeAttribute')
        attr.attribute_name = name
        top = surface(nodes, links, TEXTURES[{'woods': 'forest'}.get(name, name)], scale, coord)
        if name == 'path':
            gravel = surface(nodes, links, TEXTURES['gravel'], 1.6, coord)
            grit = nodes.new('ShaderNodeTexNoise')
            grit.inputs['Scale'].default_value = .4
            links.new(coord, grit.inputs['Vector'])
            top = tuple(mix(nodes, links, kind, grit.outputs['Fac'], a, b)
                        for kind, a, b in zip(('RGBA', 'FLOAT', 'VECTOR'), top, gravel))
            dull = nodes.new('ShaderNodeHueSaturation')
            dull.inputs['Saturation'].default_value, dull.inputs['Value'].default_value = .55, .92
            links.new(top[0], dull.inputs['Color'])
            top = (dull.outputs['Color'], top[1], top[2])
        layers = [tuple(mix(nodes, links, kind, attr.outputs['Fac'], low, high)
                        for kind, low, high in zip(('RGBA', 'FLOAT', 'VECTOR'), layers[0], top))]
    color, rough, normal = layers[0]
    links.new(color, bsdf.inputs['Base Color'])
    links.new(rough, bsdf.inputs['Roughness'])
    links.new(normal, bsdf.inputs['Normal'])
    return m

def water_material():
    """Dark and reflective where deep; clear over the lakebed in the shallows."""
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
    tint.inputs[6].default_value = (.07, .09, .06, 1)
    tint.inputs[7].default_value = (.008, .022, .026, 1)
    links.new(tint.outputs[2], bsdf.inputs['Base Color'])
    clear = nodes.new('ShaderNodeBsdfTransparent')
    clear.inputs['Color'].default_value = (.62, .7, .6, 1)
    shallow = nodes.new('ShaderNodeMapRange')
    shallow.inputs['From Min'].default_value, shallow.inputs['From Max'].default_value = 0, .7
    shallow.inputs['To Min'].default_value, shallow.inputs['To Max'].default_value = .7, 0
    links.new(depth.outputs['Fac'], shallow.inputs['Value'])
    blend = nodes.new('ShaderNodeMixShader')
    links.new(shallow.outputs['Result'], blend.inputs['Fac'])
    links.new(bsdf.outputs['BSDF'], blend.inputs[1])
    links.new(clear.outputs['BSDF'], blend.inputs[2])
    links.new(blend.outputs['Shader'], nodes['Material Output'].inputs['Surface'])
    bsdf.inputs['Roughness'].default_value = .02
    bsdf.inputs['IOR'].default_value = 1.33
    ripples = nodes.new('ShaderNodeTexNoise')
    ripples.inputs['Scale'].default_value = 1.4
    ripples.inputs['Detail'].default_value = 8
    bump = nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = .08
    links.new(ripples.outputs['Fac'], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
    return m

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
        v.co.z = height(x, y) - .03
        for key, value in masks(x, y).items():
            layers.setdefault(key, []).append(value)
    for key, values in layers.items():
        mesh.attributes.new(key, 'FLOAT', 'POINT').data.foreach_set('value', values)
    mesh.shade_smooth()
    obj = bpy.data.objects.new('terrain', mesh)
    obj.data.materials.append(ground_material())
    bpy.context.scene.collection.objects.link(obj)
    return obj

def water():
    """The lake surface, carrying the depth beneath each point for the shader."""
    import bpy, bmesh
    ca, cb, ra, rb = LAKE
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

def courtyard():
    import bpy
    bpy.ops.mesh.primitive_cylinder_add(vertices=256, radius=COURTYARD_RADIUS, depth=.4, location=(0, 0, -.2))
    floor = bpy.context.object
    floor.data.materials.append(textured('cobbles', TEXTURES['courtyard'], 2.4))
    bpy.ops.mesh.primitive_torus_add(major_segments=256, minor_segments=16, major_radius=COURTYARD_RADIUS + .15,
                                     minor_radius=.32, location=(0, 0, -.06))
    kerb = bpy.context.object
    kerb.scale.z = .45
    kerb.data.materials.append(textured('kerb', TEXTURES['kerb'], 1.6))
    bpy.ops.object.shade_smooth()

WALLS = [[(6, -18), (8, -40), (2, -62)], [(-8, -24), (-12, -46), (-18, -66)],
         [(32, -26), (62, -26)], [(32, 26), (60, 26)], [(32, -26), (32, -8)], [(32, 12), (32, 26)],
         [(22, -40), (52, -48), (78, -44)]]

def walls(rocks):
    """Dry-stone walls: mossy stones laid along each line, kept off the live area."""
    import bpy
    from mathutils import Vector
    rng = random.Random(77)
    sizes = {c: max(max(o.dimensions) for o in c.objects) for c in rocks}
    for line in WALLS:
        for (a0, b0), (a1, b1) in zip(line, line[1:]):
            steps = int(math.hypot(a1 - a0, b1 - b0) / .36)
            for i in range(steps):
                t = i / steps
                a, b = a0 + (a1 - a0) * t, b0 + (b1 - b0) * t
                x, y = to_ground(a + rng.uniform(-.12, .12), b + rng.uniform(-.12, .12))
                if live_distance(x, y) < 3:
                    continue
                for layer in range(3):
                    c = rng.choice(rocks)
                    inst = bpy.data.objects.new('wall', None)
                    inst.instance_type, inst.instance_collection = 'COLLECTION', c
                    inst.location = (x, y, height(x, y) + layer * .3 - .1)
                    inst.rotation_euler = (rng.uniform(-.2, .2), rng.uniform(-.2, .2), rng.uniform(0, math.tau))
                    inst.scale = (rng.uniform(.75, 1.1) * (1 - layer * .15) / sizes[c],) * 3
                    bpy.context.scene.collection.objects.link(inst)

PIER = ((-42, -6), (-56, -2))   # shore end and lake end, screen frame

def pier():
    """A wooden pier from the gate path's end out over the lake."""
    import bpy
    path = polyhaven.model('modular_wooden_pier')
    with bpy.data.libraries.load(str(path)) as (src, dst):
        dst.objects = [n for n in src.objects if n.endswith('section_02')]
    section = dst.objects[0]
    deck = max(c[2] for c in section.bound_box)
    (a0, b0), (a1, b1) = PIER
    (x0, y0), (x1, y1) = to_ground(a0, b0), to_ground(a1, b1)
    length, step = math.hypot(x1 - x0, y1 - y0), 2.9
    heading = math.atan2(y1 - y0, x1 - x0) - math.pi / 2
    for i in range(int(length / step) + 1):
        t = i * step / length
        obj = section.copy()
        obj.location = (x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, WATER_LEVEL + .55 - deck)
        obj.rotation_euler = (0, 0, heading)
        bpy.context.scene.collection.objects.link(obj)

def cloud_shadows():
    """Soft cloud shadows over the outer landscape, never over the live area:
    a hidden layer above the ground that only casts shadow."""
    import bpy
    from mathutils import Vector
    light = sun('light').normalized()
    lift = 24
    # A point on the layer shades the ground this far away from the sun.
    shift = Vector((-light.x, -light.y)) * lift / light.z
    bpy.ops.mesh.primitive_plane_add(size=520, location=(-shift.x, -shift.y, lift))
    layer = bpy.context.object
    layer.visible_camera = layer.visible_glossy = layer.visible_diffuse = False
    m = bpy.data.materials.new('clouds')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    nodes.remove(nodes['Principled BSDF'])
    coord = nodes.new('ShaderNodeTexCoord')
    noise = nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 5
    noise.inputs['Detail'].default_value = 4
    links.new(coord.outputs['Generated'], noise.inputs['Vector'])
    cover = nodes.new('ShaderNodeMapRange')
    cover.inputs['From Min'].default_value, cover.inputs['From Max'].default_value = .46, .6
    links.new(noise.outputs['Fac'], cover.inputs['Value'])
    # Clear within 60 m of the live area, fading in beyond.
    distance = nodes.new('ShaderNodeVectorMath')
    distance.operation = 'LENGTH'
    links.new(coord.outputs['Object'], distance.inputs[0])
    edge = nodes.new('ShaderNodeMapRange')
    edge.inputs['From Min'].default_value, edge.inputs['From Max'].default_value = 60, 95
    links.new(distance.outputs['Value'], edge.inputs['Value'])
    density = nodes.new('ShaderNodeMath')
    density.operation = 'MULTIPLY'
    links.new(cover.outputs['Result'], density.inputs[0])
    links.new(edge.outputs['Result'], density.inputs[1])
    strength = nodes.new('ShaderNodeMath')
    strength.operation = 'MULTIPLY'
    strength.inputs[1].default_value = .8
    links.new(density.outputs['Value'], strength.inputs[0])
    shade = nodes.new('ShaderNodeMixShader')
    links.new(strength.outputs['Value'], shade.inputs['Fac'])
    links.new(nodes.new('ShaderNodeBsdfTransparent').outputs['BSDF'], shade.inputs[1])
    links.new(nodes.new('ShaderNodeBsdfDiffuse').outputs['BSDF'], shade.inputs[2])
    links.new(shade.outputs['Shader'], nodes['Material Output'].inputs['Surface'])
    layer.data.materials.append(m)

def lights(theme):
    dusk = theme == 'dark'
    sky_lights(SKIES[theme], theme, .5 if dusk else .9, 3.4, 2.5 if dusk else 1.2,
               (1, .56, .3) if dusk else (1, .94, .84))

def lanterns(theme):
    """Lantern posts along the paths and at the pier's end."""
    spots = []
    for line in PATHS:
        for (a0, b0), (a1, b1) in zip(line, line[1:]):
            length = math.hypot(a1 - a0, b1 - b0)
            na, nb = -(b1 - b0) / length, (a1 - a0) / length
            for i in range(int(length / 12)):
                t = (i + .5) * 12 / length
                side = 1.7 if (len(spots) % 2) else -1.7
                spots.append((a0 + (a1 - a0) * t + na * side, b0 + (b1 - b0) * t + nb * side))
    spots.append(PIER[1])
    posts = []
    for a, b in spots:
        x, y = to_ground(a, b)
        on_pier = (a, b) == PIER[1]
        if live_distance(x, y) < 3 or not tall_clear(a, b, 3) or (lake_shape(a, b) < 1.05 and not on_pier):
            continue
        posts.append((x, y, WATER_LEVEL + .55 if on_pier else height(x, y)))
    lantern_posts(posts, theme)

def halls():
    import bpy
    bpy.ops.import_scene.gltf(filepath=str(ROOT / 'web/yard/assets/guild.glb'))
    for obj in list(bpy.context.scene.objects):
        if obj.name.startswith('courtyard'):
            bpy.data.objects.remove(obj)

def build(with_halls=True, theme='light'):
    import bpy
    bpy.ops.wm.read_factory_settings(use_empty=True)
    lights(theme)
    terrain()
    water()
    courtyard()
    s = {a: source(a, h) for a, (h, variants) in MODELS.items() if not variants}
    v = {a: variant_sets(a) for a, (h, variants) in MODELS.items() if variants}
    # Woods: conifers deep in, broadleaves at the edges.
    scatter('conifers', [s['fir_tree_01'], s['pine_tree_01']], 'woods', .05, 3.4, (.7, 1.25), 11)
    scatter('broadleaf', [s['island_tree_01'], s['island_tree_02'], s['island_tree_03']], 'woods', .02, 5, (.8, 1.2), 12)
    scatter('orchard', [s['tree_small_02']], 'orchard', .035, 4.5, (.85, 1.1), 13)
    scatter('shrubs', [s['shrub_01'], s['shrub_02'], s['shrub_04']], 'clear', .01, 2.5, (.7, 1.3), 14)
    scatter('understory', [s['shrub_01'], s['shrub_02'], s['shrub_04']], 'woods', .05, 1.6, (.8, 1.6), 19)
    scatter('ferns', v['fern_02'], 'woods', .6, .8, (.9, 1.6), 17)
    scatter('rocks', v['rock_moss_set_01'] + v['rock_moss_set_02'], 'clear', .002, 6, (.5, 1.2), 18)
    scatter('copses', [s['island_tree_01'], s['island_tree_02'], s['island_tree_03'], s['tree_small_02']], 'copse', .03, 4, (.7, 1.1), 20)
    scatter('thickets', [s['shrub_01'], s['shrub_02'], s['shrub_04']], 'copse', .12, 1.4, (.8, 1.5), 21)
    scatter('reeds', reeds(), 'reeds', .5, .8, (.8, 1.2), 22)
    pier()
    lanterns(theme)
    if theme == 'light':
        cloud_shadows()
    walls(v['rock_moss_set_01'] + v['rock_moss_set_02'])
    if with_halls:
        halls()

if __name__ == '__main__' and '--preview' in sys.argv:
    preview(sys.modules[__name__], 'dark' if '--dark' in sys.argv else 'light')
