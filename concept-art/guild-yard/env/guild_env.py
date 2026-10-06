"""Guild environment for the Yard's pre-rendered plates: a lakeside estate on a
meadow, an orchard, and forested hills beyond.

Preview renders from the live camera into .cache/yard-env/:
  blender -b --factory-startup --python concept-art/guild-yard/env/guild_env.py -- --preview
Sources are Poly Haven CC0 assets fetched by polyhaven.py.

Layout uses a ground frame aligned with the screen: `a` runs screen-right and
`b` runs screen-up (away from the viewer), both in metres on the ground.
"""
import math, random, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import polyhaven
from camera import ROOT, view, to_blender, ortho_camera

OUT = ROOT / '.cache/yard-env'
# Generated with local-image-studio where Poly Haven has no match; see ART.md.
PAINTED = Path(__file__).resolve().parent / 'textures'
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
COURTYARD_RADIUS = 13.7
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
def frame():
    """Unit ground vectors (Blender x, y) for screen-right and screen-up."""
    b = view()['basis']
    r, f = to_blender(b['right']), to_blender(b['forward'])
    up = (f.x, f.y)
    n = math.hypot(*up)
    return (r.x, r.y), (up[0] / n, up[1] / n)

def to_ground(a, b):
    (rx, ry), (ux, uy) = frame()
    return a * rx + b * ux, a * ry + b * uy

def to_frame(x, y):
    (rx, ry), (ux, uy) = frame()
    return x * rx + y * ry, x * ux + y * uy

def smooth(e0, e1, x):
    t = min(1, max(0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)

def play_distance(x, y):
    """Metres outside the camera's pan bounds (0 inside). Blender y is -z in glTF."""
    p = view()['camera']['pan']
    dx = max(p['minX'] - x, 0, x - p['maxX'])
    dz = max(p['minZ'] - (-y), 0, (-y) - p['maxZ'])
    return math.hypot(dx, dz)

def live_distance(x, y):
    """Metres from where live halls and characters can stand: the courtyard and
    the rows of sessions and extra halls in front of it (glTF z 0..32)."""
    ring = max(0, math.hypot(x, y) - COURTYARD_RADIUS - 1)
    dx, dz = max(abs(x) - 13, 0), max(-y - 32, 0, y)
    return min(ring, math.hypot(dx, dz))

def tall_clear(a, b, height=12):
    """Whether something `height` metres tall at (a, b) stays off the live area
    on screen. Tall props rise up the screen, over what stands behind them."""
    reach = height * 1.55
    return all(live_distance(*to_ground(a, b + reach * t / 4)) > 4 for t in range(5))

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
    best = 1e9
    for line in PATHS:
        for (a0, b0), (a1, b1) in zip(line, line[1:]):
            da, db = a1 - a0, b1 - b0
            t = max(0, min(1, ((a - a0) * da + (b - b0) * db) / (da * da + db * db)))
            best = min(best, math.hypot(a - a0 - t * da, b - b0 - t * db))
    return best

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
def image(nodes, links, path, color, vector):
    import bpy
    node = nodes.new('ShaderNodeTexImage')
    node.image = bpy.data.images.load(str(path), check_existing=True)
    node.image.colorspace_settings.name = 'sRGB' if color else 'Non-Color'
    links.new(vector, node.inputs['Vector'])
    return node

def surface(nodes, links, asset, scale, coord):
    """A PBR texture set's colour, roughness and normal outputs at `scale` metres."""
    maps = polyhaven.texture(asset)
    mapping = nodes.new('ShaderNodeMapping')
    mapping.inputs['Scale'].default_value = (1 / scale,) * 3
    links.new(coord, mapping.inputs['Vector'])
    v = mapping.outputs['Vector']
    normal = nodes.new('ShaderNodeNormalMap')
    links.new(image(nodes, links, maps['nor_gl'], False, v).outputs['Color'], normal.inputs['Color'])
    return (image(nodes, links, maps['Diffuse'], True, v).outputs['Color'],
            image(nodes, links, maps['Rough'], False, v).outputs['Color'], normal.outputs['Normal'])

# ShaderNodeMix socket indices for (A, B) inputs and the result, by data type.
MIX_SOCKETS = {'FLOAT': (2, 3, 0), 'VECTOR': (4, 5, 1), 'RGBA': (6, 7, 2)}

def tileable(name):
    """A generated texture made to wrap: each axis is cross-faded with a copy
    rolled by half, which moves the seam to where the original is continuous."""
    import bpy, numpy as np
    out = ROOT / '.cache/yard-env/tiles' / (name + '.png')
    src = PAINTED / (name + '.jpg')
    if out.exists() and out.stat().st_mtime > src.stat().st_mtime:
        return out
    img = bpy.data.images.load(str(src))
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    for axis, n in ((1, w), (0, h)):
        window = np.sin(np.pi * (np.arange(n) + .5) / n) ** 2
        shape = (1, n, 1) if axis == 1 else (n, 1, 1)
        window = window.reshape(shape)
        px = px * window + np.roll(px, n // 2, axis) * (1 - window)
    result = bpy.data.images.new(name + '_tile', w, h)
    result.pixels[:] = px.ravel()
    out.parent.mkdir(parents=True, exist_ok=True)
    result.filepath_raw, result.file_format = str(out), 'PNG'
    result.save()
    return out

def painted(nodes, links, name, scale, coord):
    """A generated colour texture with two scales blended by noise, plus broad
    brightness variation, so its repeats do not show across a 400 m terrain."""
    path = tileable(name)
    def sample(size, angle):
        mapping = nodes.new('ShaderNodeMapping')
        mapping.inputs['Scale'].default_value = (1 / size,) * 3
        mapping.inputs['Rotation'].default_value = (0, 0, angle)
        links.new(coord, mapping.inputs['Vector'])
        return image(nodes, links, path, True, mapping.outputs['Vector']).outputs['Color']
    def noise(size, seed):
        node = nodes.new('ShaderNodeTexNoise')
        node.inputs['Scale'].default_value = 1 / size
        node.inputs['Detail'].default_value = 4
        node.noise_dimensions = '4D'
        node.inputs['W'].default_value = seed
        links.new(coord, node.inputs['Vector'])
        return node.outputs['Fac']
    pick = nodes.new('ShaderNodeMapRange')
    pick.inputs['From Min'].default_value, pick.inputs['From Max'].default_value = .42, .58
    links.new(noise(30, 1), pick.inputs['Value'])
    color = mix(nodes, links, 'RGBA', pick.outputs['Result'], sample(scale, 0), sample(scale * 2.3, .9))
    dry = nodes.new('ShaderNodeMapRange')
    dry.inputs['From Min'].default_value, dry.inputs['From Max'].default_value = .5, .7
    dry.inputs['To Max'].default_value = .45
    links.new(noise(90, 3), dry.inputs['Value'])
    straw = nodes.new('ShaderNodeMix')
    straw.data_type, straw.blend_type = 'RGBA', 'MULTIPLY'
    links.new(dry.outputs['Result'], straw.inputs['Factor'])
    links.new(color, straw.inputs[6])
    straw.inputs[7].default_value = (1.1, .95, .55, 1)
    calm = nodes.new('ShaderNodeHueSaturation')
    calm.inputs['Saturation'].default_value = .82
    links.new(straw.outputs[2], calm.inputs['Color'])
    color = calm.outputs['Color']
    shade = nodes.new('ShaderNodeMapRange')
    shade.inputs['To Min'].default_value, shade.inputs['To Max'].default_value = .62, .92
    links.new(noise(55, 2), shade.inputs['Value'])
    tint = nodes.new('ShaderNodeMix')
    tint.data_type, tint.blend_type = 'RGBA', 'MULTIPLY'
    tint.inputs['Factor'].default_value = 1
    links.new(color, tint.inputs[6])
    links.new(shade.outputs['Result'], tint.inputs[7])
    gray = nodes.new('ShaderNodeRGBToBW')
    links.new(color, gray.inputs['Color'])
    bump = nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = .35
    bump.inputs['Distance'].default_value = .05
    links.new(gray.outputs['Val'], bump.inputs['Height'])
    rough = nodes.new('ShaderNodeValue')
    rough.outputs[0].default_value = .88
    return tint.outputs[2], rough.outputs[0], bump.outputs['Normal']

def mix(nodes, links, kind, fac, a, b):
    node = nodes.new('ShaderNodeMix')
    node.data_type = kind
    first, second, result = MIX_SOCKETS[kind]
    links.new(fac, node.inputs['Factor'])
    links.new(a, node.inputs[first])
    links.new(b, node.inputs[second])
    return node.outputs[result]

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

def textured(name, asset, scale):
    import bpy
    m = bpy.data.materials.new(name)
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = nodes['Principled BSDF']
    coord = nodes.new('ShaderNodeTexCoord').outputs['Object']
    color, rough, normal = surface(nodes, links, asset, scale, coord)
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

def source(asset, target):
    """A Poly Haven model as an unlinked collection, scaled to `target` metres tall."""
    import bpy
    from mathutils import Matrix, Vector
    path = polyhaven.model(asset)
    with bpy.data.libraries.load(str(path), link=False) as (src, dst):
        dst.objects = list(src.objects)
    coll = bpy.data.collections.new(asset)
    meshes = [o for o in dst.objects if o and o.type == 'MESH']
    for o in meshes:
        coll.objects.link(o)
    if target:
        top = max((o.matrix_world @ Vector(c)).z for o in meshes for c in o.bound_box)
        scale = target / top
        for o in meshes:
            o.matrix_world = Matrix.Scale(scale, 4) @ o.matrix_world
    return coll

def scatter(name, collections, attribute, density, spacing, scale, seed):
    """Geometry-nodes scatter over the terrain, weighted by a mask attribute."""
    import bpy
    tree = bpy.data.node_groups.new(name, 'GeometryNodeTree')
    tree.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    n, l = tree.nodes, tree.links
    info = n.new('GeometryNodeObjectInfo')
    info.inputs['Object'].default_value = bpy.data.objects['terrain']
    info.transform_space = 'RELATIVE'
    weight = n.new('GeometryNodeInputNamedAttribute')
    weight.data_type = 'FLOAT'
    weight.inputs['Name'].default_value = attribute
    dist = n.new('GeometryNodeDistributePointsOnFaces')
    dist.distribute_method = 'POISSON'
    dist.inputs['Distance Min'].default_value = spacing
    dist.inputs['Density Max'].default_value = density
    dist.inputs['Seed'].default_value = seed
    l.new(info.outputs['Geometry'], dist.inputs['Mesh'])
    l.new(weight.outputs['Attribute'], dist.inputs['Density Factor'])
    holder = bpy.data.collections.new(name + '_pick')
    for c in collections:
        holder.children.link(c)
    pick = n.new('GeometryNodeCollectionInfo')
    pick.inputs['Collection'].default_value = holder
    pick.inputs['Separate Children'].default_value = True
    pick.inputs['Reset Children'].default_value = True
    inst = n.new('GeometryNodeInstanceOnPoints')
    inst.inputs['Pick Instance'].default_value = True
    l.new(dist.outputs['Points'], inst.inputs['Points'])
    l.new(pick.outputs['Instances'], inst.inputs['Instance'])
    def random(kind, low, high, offset):
        node = n.new('FunctionNodeRandomValue')
        node.data_type = kind
        live = [i for i in node.inputs if i.enabled]
        next(i for i in live if i.name == 'Min').default_value = low
        next(i for i in live if i.name == 'Max').default_value = high
        node.inputs['Seed'].default_value = seed + offset
        return next(o for o in node.outputs if o.enabled)
    l.new(random('FLOAT_VECTOR', (0, 0, 0), (0, 0, math.tau), 0), inst.inputs['Rotation'])
    l.new(random('FLOAT', *scale, 1), inst.inputs['Scale'])
    l.new(random('INT', 0, 10000, 2), inst.inputs['Instance Index'])
    out = n.new('NodeGroupOutput')
    l.new(inst.outputs['Instances'], out.inputs[0])
    obj = bpy.data.objects.new(name, bpy.data.meshes.new(name))
    obj.modifiers.new(name, 'NODES').node_group = tree
    bpy.context.scene.collection.objects.link(obj)
    return obj

def variant_sets(asset):
    """Each mesh in a variant .blend as its own collection, so scatters pick between them."""
    import bpy
    coll = source(asset, None)
    result = []
    for o in list(coll.objects):
        if 'LOD' in o.name and 'LOD0' not in o.name:
            continue
        c = bpy.data.collections.new(o.name)
        c.objects.link(o)
        o.location = (0, 0, 0)
        result.append(c)
    return result

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

def reeds():
    """Reed clumps: tapered blades leaning out from a base, in three variants."""
    import bpy
    m = bpy.data.materials.new('reed')
    bsdf = m.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (.12, .15, .05, 1)
    bsdf.inputs['Roughness'].default_value = .55
    bsdf.inputs['Subsurface Weight'].default_value = .15
    variants = []
    for k in range(3):
        rng = random.Random(300 + k)
        verts, faces = [], []
        for _ in range(55):
            r, a = rng.uniform(0, .45), rng.uniform(0, math.tau)
            bx, by = r * math.cos(a), r * math.sin(a)
            tall, lean, width = rng.uniform(.9, 1.9), rng.uniform(.05, .35), rng.uniform(.018, .03)
            facing = rng.uniform(0, math.tau)
            fx, fy = math.cos(facing) * width, math.sin(facing) * width
            start = len(verts)
            for j in range(4):
                t = j / 3
                w = 1 - t * .9
                cx, cy = bx + math.cos(a) * lean * t * t, by + math.sin(a) * lean * t * t
                verts += [(cx - fx * w, cy - fy * w, tall * t), (cx + fx * w, cy + fy * w, tall * t)]
            faces += [(start + 2 * j, start + 2 * j + 1, start + 2 * j + 3, start + 2 * j + 2) for j in range(3)]
        mesh = bpy.data.meshes.new(f'reeds_{k}')
        mesh.from_pydata(verts, [], faces)
        mesh.materials.append(m)
        obj = bpy.data.objects.new(f'reeds_{k}', mesh)
        c = bpy.data.collections.new(f'reeds_{k}')
        c.objects.link(obj)
        variants.append(c)
    return variants

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

def sun(theme):
    """The theme's sun position in Blender coordinates, from model.mjs."""
    return to_blender(view()['sun'][theme])

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
    import bpy
    dusk = theme == 'dark'
    world = bpy.data.worlds.new('sky')
    bpy.context.scene.world = world
    env = world.node_tree.nodes.new('ShaderNodeTexEnvironment')
    env.image = bpy.data.images.load(str(polyhaven.hdri(SKIES[theme])))
    world.node_tree.links.new(env.outputs['Color'], world.node_tree.nodes['Background'].inputs['Color'])
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = .5 if dusk else .9
    lamp = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    lamp.data.energy = 3.4 if dusk else 3.4
    lamp.data.angle = math.radians(2.5 if dusk else 1.2)
    lamp.data.color = (1, .56, .3) if dusk else (1, .94, .84)
    lamp.rotation_euler = sun(theme).to_track_quat('Z', 'Y').to_euler()
    bpy.context.scene.collection.objects.link(lamp)

def lanterns(theme):
    """Lantern posts along the paths and at the pier, lit at dusk. They stand
    in both themes so the plates differ only in light."""
    import bpy
    path = polyhaven.model('Lantern_01')
    with bpy.data.libraries.load(str(path)) as (src, dst):
        dst.objects = list(src.objects)
    head = bpy.data.collections.new('lantern')
    for o in dst.objects:
        head.objects.link(o)
        if theme == 'dark' and o.name.endswith('glass'):
            glow = bpy.data.materials.new('lantern_glow')
            bsdf = glow.node_tree.nodes['Principled BSDF']
            bsdf.inputs['Emission Color'].default_value = (1, .62, .3, 1)
            bsdf.inputs['Emission Strength'].default_value = 40
            o.data.materials[0] = glow
    post = textured('post', 'dark_wooden_planks', .6)
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
    for a, b in spots:
        x, y = to_ground(a, b)
        on_pier = (a, b) == PIER[1]
        if live_distance(x, y) < 3 or not tall_clear(a, b, 3) or (lake_shape(a, b) < 1.05 and not on_pier):
            continue
        base = WATER_LEVEL + .55 if on_pier else height(x, y)
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x, y, base + 1.15))
        pole = bpy.context.object
        pole.scale = (.09, .09, 2.3)
        pole.data.materials.append(post)
        inst = bpy.data.objects.new('lantern', None)
        inst.instance_type, inst.instance_collection = 'COLLECTION', head
        inst.location, inst.scale = (x, y, base + 2.3), (2, 2, 2)
        bpy.context.scene.collection.objects.link(inst)
        if theme == 'dark':
            bulb = bpy.data.objects.new('lantern_light', bpy.data.lights.new('lantern_light', 'POINT'))
            bulb.data.energy, bulb.data.color, bulb.data.shadow_soft_size = 320, (1, .6, .3), .12
            bulb.location = (x, y, base + 2.6)
            bpy.context.scene.collection.objects.link(bulb)

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

# --- Rendering --------------------------------------------------------------
def render_settings(scene, width, height, samples):
    import bpy
    scene.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'OPTIX'
    prefs.get_devices()
    for d in prefs.devices:
        d.use = True
    scene.cycles.device = 'GPU'
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = width, height
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = 'AgX - Medium High Contrast'

def preview(theme):
    import bpy
    build(theme=theme)
    scene = bpy.context.scene
    OUT.mkdir(parents=True, exist_ok=True)
    v = view()
    cam, target, b = v['camera'], v['camera']['target'], v['basis']
    center = (sum(t * r for t, r in zip(target, b['right'])), sum(t * u for t, u in zip(target, b['up'])))
    for name, aspect, zoom, width in [('overview-16x9', 16 / 9, cam['zoom']['overview'], 1920),
                                      ('ultrawide-32x9', 32 / 9, cam['zoom']['min'], 3200)]:
        h = cam['height'] / zoom
        ortho_camera(scene, name, center, h * aspect, h)
        render_settings(scene, width, round(width / aspect), 128)
        scene.render.filepath = str(OUT / f'{name}-{theme}.png')
        bpy.ops.render.render(write_still=True)
        print('YARD_ENV_PREVIEW', scene.render.filepath, flush=True)

if __name__ == '__main__' and '--preview' in sys.argv:
    preview('dark' if '--dark' in sys.argv else 'light')
