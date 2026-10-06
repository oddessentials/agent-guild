"""Shared building blocks for the Yard's environment plates: the screen-aligned
ground frame and live-area tests, PBR and painted materials, Poly Haven model
scatters, TRELLIS.2 buildings with lit windows, sky and sun, lantern posts,
Cycles settings and previews. Each
world's `<world>_env.py` composes these into its own surroundings.

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
# Every world's halls stand around this courtyard (build.py places them).
COURTYARD_RADIUS = 13.7

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

def line_distance(lines, a, b):
    """Distance from (a, b) to the nearest segment of any polyline."""
    best = 1e9
    for line in lines:
        for (a0, b0), (a1, b1) in zip(line, line[1:]):
            da, db = a1 - a0, b1 - b0
            t = max(0, min(1, ((a - a0) * da + (b - b0) * db) / (da * da + db * db)))
            best = min(best, math.hypot(a - a0 - t * da, b - b0 - t * db))
    return best

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

def painted(nodes, links, name, scale, coord, dry=(1.1, .95, .55, 1)):
    """A generated colour texture with two scales blended by noise, plus broad
    brightness variation and `dry` patches multiplied in, so its repeats do not
    show across a 400 m terrain."""
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
    patches = nodes.new('ShaderNodeMapRange')
    patches.inputs['From Min'].default_value, patches.inputs['From Max'].default_value = .5, .7
    patches.inputs['To Max'].default_value = .45
    links.new(noise(90, 3), patches.inputs['Value'])
    straw = nodes.new('ShaderNodeMix')
    straw.data_type, straw.blend_type = 'RGBA', 'MULTIPLY'
    links.new(patches.outputs['Result'], straw.inputs['Factor'])
    links.new(color, straw.inputs[6])
    straw.inputs[7].default_value = dry
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

# --- Models -----------------------------------------------------------------
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
        # Lower LODs, and the geometry-nodes helper some plant sets carry.
        if ('LOD' in o.name and 'LOD0' not in o.name) or o.name.endswith('geometry_nodes'):
            continue
        c = bpy.data.collections.new(o.name)
        c.objects.link(o)
        o.location = (0, 0, 0)
        result.append(c)
    return result

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

def building(path, theme):
    """A TRELLIS.2 model as an unlinked collection for instancing, with its lit
    windows at dusk. Returns the collection, its lowest point and its height."""
    import bpy
    from mathutils import Vector
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    parts = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
    coll = bpy.data.collections.new(Path(path).stem)
    for o in parts:
        for c in o.users_collection:
            c.objects.unlink(o)
        coll.objects.link(o)
        for m in o.data.materials:
            lit_windows(m, theme)
    lo = min((o.matrix_world @ Vector(c)).z for o in parts for c in o.bound_box)
    hi = max((o.matrix_world @ Vector(c)).z for o in parts for c in o.bound_box)
    return coll, lo, hi - lo

# --- Light ------------------------------------------------------------------
def sun(theme):
    """The theme's sun position in Blender coordinates, from model.mjs."""
    return to_blender(view()['sun'][theme])

def lights(sky, theme, strength, energy, angle, color):
    """The sky as world light, and the theme's sun from model.mjs: `energy`,
    `angle` (degrees of softness) and `color` set the sun lamp."""
    import bpy
    world = bpy.data.worlds.new('sky')
    bpy.context.scene.world = world
    env = world.node_tree.nodes.new('ShaderNodeTexEnvironment')
    env.image = bpy.data.images.load(str(polyhaven.hdri(sky)))
    world.node_tree.links.new(env.outputs['Color'], world.node_tree.nodes['Background'].inputs['Color'])
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = strength
    lamp = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    lamp.data.energy = energy
    lamp.data.angle = math.radians(angle)
    lamp.data.color = color
    lamp.rotation_euler = sun(theme).to_track_quat('Z', 'Y').to_euler()
    bpy.context.scene.collection.objects.link(lamp)

def lantern_posts(spots, theme):
    """Poly Haven lanterns on wooden posts at each (x, y, ground height), lit at
    dusk. They stand in both themes so the plates differ only in light."""
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
    for x, y, base in spots:
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

def preview(env, theme):
    """Render a world's scene with its halls from the live camera, at the default
    and widest zoom, into .cache/yard-env/."""
    import bpy
    env.build(theme=theme)
    scene = bpy.context.scene
    OUT.mkdir(parents=True, exist_ok=True)
    v = view()
    cam, target, b = v['camera'], v['camera']['target'], v['basis']
    center = (sum(t * r for t, r in zip(target, b['right'])), sum(t * u for t, u in zip(target, b['up'])))
    world = Path(env.__file__).stem.removesuffix('_env')
    for name, aspect, zoom, width in [('overview-16x9', 16 / 9, cam['zoom']['overview'], 1920),
                                      ('ultrawide-32x9', 32 / 9, cam['zoom']['min'], 3200)]:
        h = cam['height'] / zoom
        ortho_camera(scene, name, center, h * aspect, h)
        env.render_settings(scene, width, round(width / aspect), 128)
        scene.render.filepath = str(OUT / f'{world}-{name}-{theme}.png')
        bpy.ops.render.render(write_still=True)
        print('YARD_ENV_PREVIEW', scene.render.filepath, flush=True)
