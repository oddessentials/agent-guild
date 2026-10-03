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
HDRI = 'kloofendal_48d_partly_cloudy_puresky'
TEXTURES = {
    'forest': 'forest_ground_04', 'shore': 'brown_mud_rocks_01', 'path': 'forest_ground_06', 'courtyard': 'cobblestone_floor_08', 'kerb': 'castle_wall_slates',
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
COURTYARD_RADIUS = 13.7
WATER_LEVEL = -.5
SUN = (-12, 25, 15)  # renderer.js sun, glTF coordinates

def fetch_all():
    polyhaven.hdri(HDRI)
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
    import bpy
    m = bpy.data.materials.new('water')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (.012, .028, .03, 1)
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
    import bpy
    ca, cb, ra, rb = LAKE
    x, y = to_ground(ca, cb)
    bpy.ops.mesh.primitive_plane_add(size=1, location=(x, y, WATER_LEVEL))
    obj = bpy.context.object
    obj.scale = (ra * 3, ra * 3, 1)
    obj.data.materials.append(water_material())

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
            steps = int(math.hypot(a1 - a0, b1 - b0) / .42)
            for i in range(steps):
                t = i / steps
                a, b = a0 + (a1 - a0) * t, b0 + (b1 - b0) * t
                x, y = to_ground(a + rng.uniform(-.12, .12), b + rng.uniform(-.12, .12))
                if live_distance(x, y) < 3:
                    continue
                for layer in range(2):
                    c = rng.choice(rocks)
                    inst = bpy.data.objects.new('wall', None)
                    inst.instance_type, inst.instance_collection = 'COLLECTION', c
                    inst.location = (x, y, height(x, y) + layer * .32 - .08)
                    inst.rotation_euler = (rng.uniform(-.2, .2), rng.uniform(-.2, .2), rng.uniform(0, math.tau))
                    inst.scale = (rng.uniform(.65, .95) / sizes[c],) * 3
                    bpy.context.scene.collection.objects.link(inst)

def lights():
    import bpy
    world = bpy.data.worlds.new('sky')
    bpy.context.scene.world = world
    env = world.node_tree.nodes.new('ShaderNodeTexEnvironment')
    env.image = bpy.data.images.load(str(polyhaven.hdri(HDRI)))
    world.node_tree.links.new(env.outputs['Color'], world.node_tree.nodes['Background'].inputs['Color'])
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = .9
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 3.4
    sun.data.angle = math.radians(1.2)
    sun.data.color = (1, .94, .84)
    sun.rotation_euler = to_blender(SUN).to_track_quat('Z', 'Y').to_euler()
    bpy.context.scene.collection.objects.link(sun)

def halls():
    import bpy
    bpy.ops.import_scene.gltf(filepath=str(ROOT / 'web/yard/assets/guild.glb'))
    for obj in list(bpy.context.scene.objects):
        if obj.name.startswith('courtyard'):
            bpy.data.objects.remove(obj)

def build(with_halls=True):
    import bpy
    bpy.ops.wm.read_factory_settings(use_empty=True)
    lights()
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
    scatter('reeds', [s['shrub_02'], s['shrub_04']], 'reeds', .25, 1.1, (.6, 1.1), 22)
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

def preview():
    import bpy
    build()
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
        scene.render.filepath = str(OUT / (name + '.png'))
        bpy.ops.render.render(write_still=True)
        print('YARD_ENV_PREVIEW', scene.render.filepath, flush=True)

if __name__ == '__main__' and '--preview' in sys.argv:
    preview()
