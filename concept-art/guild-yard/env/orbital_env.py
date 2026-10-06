"""Orbital environment for the Yard's pre-rendered plates: a station deck in
orbit, with trusses out to solar wings, a docking hub and habitat modules,
over a planet and a starfield.

Preview renders from the live camera into .cache/yard-env/:
  blender -b --factory-startup --python concept-art/guild-yard/env/orbital_env.py -- --preview [--dark]
The live halls and characters stand on a level deck at y = 0. The station's
structures and cargo are modelled here; its shuttle, dishes and crane are
TRELLIS.2 models made from concept images (concept-art/orbital-yard). The
planet and nebula are generated textures (see concept-art/orbital-yard/ART.md)
and the stars are drawn by a shader; deck and hull detail are Poly Haven CC0
sets, fetched by polyhaven.py. Layout uses the screen-aligned ground frame
described in common.py.

There is no Poly Haven sky in space, so the world light is a shader: dark
space above and the planet's glow below. `sky()` renders it to an
equirectangular HDR for the live models' image-based lighting.
"""
import math, random, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import polyhaven
from camera import ROOT, view, to_blender
# plates.py and preview() call render_settings through this module.
from common import (COURTYARD_RADIUS, MIX_SOCKETS, to_ground, to_frame, live_distance, tall_clear, surface, building,
                    sun, tileable, render_settings, preview)

TOWN = ROOT / '.cache/orbital-yard/models'
# Rendered from the world shader by sky(); no Poly Haven sky shows space.
SKIES = {'light': 'orbital-day', 'dark': 'orbital-dusk'}
TEXTURES = {'deck': 'blue_metal_plate', 'grate': 'metal_plate', 'hull': 'painted_metal_shutter'}
# The live halls are TRELLIS.2 models with their own baked textures.
SURFACES = {}
# The landing zone the live halls and characters stand on: the courtyard and
# the rows in front of it (Blender y = -glTF z), as Professional's plaza.
ZONE_RADIUS = COURTYARD_RADIUS + .9
ZONE_FRONT = (-14.2, 14.2, -33.5, 0)
# The deck reaches this far past the landing zone before its edge.
MARGIN = 3.6
# Planet: centre in view-plane coordinates (right, up), radius, and how far
# behind the view plane its centre is. It is squashed along the view axis to
# fit the cameras' clip range, which an orthographic view cannot see.
PLANET = (185, -472, 500, 250)
STAR_DEPTH = 390
# TRELLIS.2 props: screen position, height in metres and turn in degrees.
PROPS = [('town_shuttle', (-42, -34), 5.5, 200), ('town_crane', (31, -16), 5, 230),
         ('town_dish', (40, 12), 7, 30), ('town_dish', (96, 28), 9, 40)]
# Modelled cargo stacks: screen position.
CARGO = [(-31, -12), (40, -30)]

def fetch_all():
    for asset in TEXTURES.values():
        polyhaven.texture(asset)

# --- Layout -----------------------------------------------------------------
def zone_outline(radius, front, step=.5):
    """The courtyard circle joined to the rectangle in front, as a closed outline."""
    x0, x1, y0, y1 = front
    a0 = math.asin(x1 / radius)
    start, end = -math.pi / 2 + a0, 3 * math.pi / 2 - a0
    n = int((end - start) * radius / step)
    pts = [(radius * math.cos(start + (end - start) * i / n), radius * math.sin(start + (end - start) * i / n))
           for i in range(n + 1)]
    return pts + [(x0, y0), (x1, y0)]

def deck_outline(step=.5):
    x0, x1, y0, y1 = ZONE_FRONT
    return zone_outline(ZONE_RADIUS + MARGIN, (x0 - MARGIN, x1 + MARGIN, y0 - MARGIN, y1), step)

def on_deck(x, y, margin=0):
    x0, x1, y0, y1 = ZONE_FRONT
    r = ZONE_RADIUS + MARGIN + margin
    m = MARGIN + margin
    return math.hypot(x, y) <= r or (x0 - m <= x <= x1 + m and y0 - m <= y <= y1)

def far_edge(x, y):
    """Edges farther from the camera than anything on the deck: the back and
    the left. Live models draw over the plates, so only these take railings."""
    return y > 3 or (x < -12 and y > ZONE_FRONT[2] + 2)

def heading():
    """Blender angle of screen-right, for structures squared to the view."""
    return math.atan2(*to_ground(1, 0)[::-1])

def basis():
    v = view()['basis']
    return tuple(to_blender(v[k]) for k in ('right', 'up', 'forward'))

# --- Materials --------------------------------------------------------------
def node_math(nodes, links, op, a, b=None):
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

def mix(nodes, links, kind, fac, a, b):
    """common.mix, taking constants as well as sockets for any input."""
    node = nodes.new('ShaderNodeMix')
    node.data_type = kind
    first, second, result = MIX_SOCKETS[kind]
    for socket, value in ((node.inputs['Factor'], fac), (node.inputs[first], a), (node.inputs[second], b)):
        if isinstance(value, bpy_socket()):
            links.new(value, socket)
        else:
            socket.default_value = value
    return node.outputs[result]

def bpy_socket():
    import bpy
    return bpy.types.NodeSocket

def panels(name, rgb, size=2.4, rough=.5, metal=.25, detail='deck', seam=.03, vary=.08, accent=.1):
    """Painted hull plating: a grid of panels drawn in object space (tops in x/y,
    sides along their face), each a slightly different shade and an `accent`
    share of them darker, with dark seams and the Poly Haven set's normal and
    roughness for wear."""
    import bpy
    m = bpy.data.materials.new(name)
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = nodes['Principled BSDF']
    coords = nodes.new('ShaderNodeTexCoord')
    coord = coords.outputs['Object']
    color, wear, normal = surface(nodes, links, TEXTURES[detail], 3, coord)
    xyz = nodes.new('ShaderNodeSeparateXYZ')
    links.new(coord, xyz.inputs['Vector'])
    nxyz = nodes.new('ShaderNodeSeparateXYZ')
    links.new(coords.outputs['Normal'], nxyz.inputs['Vector'])
    top = node_math(nodes, links, 'GREATER_THAN', node_math(nodes, links, 'ABSOLUTE', nxyz.outputs['Z']), .6)
    side_u = node_math(nodes, links, 'ADD', xyz.outputs['X'], xyz.outputs['Y'])
    u = mix(nodes, links, 'FLOAT', top, side_u, xyz.outputs['X'])
    v = mix(nodes, links, 'FLOAT', top, xyz.outputs['Z'], xyz.outputs['Y'])
    def edge(t):
        f = node_math(nodes, links, 'FRACT', node_math(nodes, links, 'DIVIDE', t, size))
        near = node_math(nodes, links, 'MINIMUM', f, node_math(nodes, links, 'SUBTRACT', 1, f))
        return node_math(nodes, links, 'LESS_THAN', node_math(nodes, links, 'MULTIPLY', near, size), seam)
    seams = node_math(nodes, links, 'MAXIMUM', edge(u), edge(v))
    cell = nodes.new('ShaderNodeCombineXYZ')
    links.new(node_math(nodes, links, 'FLOOR', node_math(nodes, links, 'DIVIDE', u, size)), cell.inputs['X'])
    links.new(node_math(nodes, links, 'FLOOR', node_math(nodes, links, 'DIVIDE', v, size)), cell.inputs['Y'])
    links.new(top, cell.inputs['Z'])
    noise = nodes.new('ShaderNodeTexWhiteNoise')
    noise.noise_dimensions = '3D'
    links.new(cell.outputs['Vector'], noise.inputs['Vector'])
    shade = nodes.new('ShaderNodeMapRange')
    shade.inputs['To Min'].default_value, shade.inputs['To Max'].default_value = 1 - vary, 1 + vary * .5
    links.new(noise.outputs['Value'], shade.inputs['Value'])
    pick = nodes.new('ShaderNodeSeparateColor')
    links.new(noise.outputs['Color'], pick.inputs['Color'])
    darker = node_math(nodes, links, 'SUBTRACT', 1, node_math(nodes, links, 'MULTIPLY',
                       node_math(nodes, links, 'GREATER_THAN', pick.outputs['Green'], 1 - accent), .16))
    grain = nodes.new('ShaderNodeRGBToBW')
    links.new(color, grain.inputs['Color'])
    grime = nodes.new('ShaderNodeMapRange')
    grime.inputs['From Min'].default_value, grime.inputs['From Max'].default_value = .05, .35
    grime.inputs['To Min'].default_value, grime.inputs['To Max'].default_value = .86, 1.04
    links.new(grain.outputs['Val'], grime.inputs['Value'])
    tone = node_math(nodes, links, 'MULTIPLY', node_math(nodes, links, 'MULTIPLY', shade.outputs['Result'], grime.outputs['Result']), darker)
    tone = node_math(nodes, links, 'MULTIPLY', tone,
                     node_math(nodes, links, 'SUBTRACT', 1, node_math(nodes, links, 'MULTIPLY', seams, .55)))
    paint = nodes.new('ShaderNodeMix')
    paint.data_type, paint.blend_type = 'RGBA', 'MULTIPLY'
    paint.inputs['Factor'].default_value = 1
    paint.inputs[6].default_value = (*rgb, 1)
    links.new(tone, paint.inputs[7])
    links.new(paint.outputs[2], bsdf.inputs['Base Color'])
    r = nodes.new('ShaderNodeMapRange')
    r.inputs['To Min'].default_value, r.inputs['To Max'].default_value = rough * .8, rough * 1.2
    links.new(wear, r.inputs['Value'])
    links.new(r.outputs['Result'], bsdf.inputs['Roughness'])
    bsdf.inputs['Metallic'].default_value = metal
    bump = nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = .4
    bump.inputs['Distance'].default_value = .02
    links.new(node_math(nodes, links, 'SUBTRACT', 1, seams), bump.inputs['Height'])
    links.new(normal, bump.inputs['Normal'])
    links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
    return m

def plain(name, rgb, rough=.5, metal=0, glow=None, strength=0):
    import bpy
    m = bpy.data.materials.new(name)
    bsdf = m.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    if glow:
        bsdf.inputs['Emission Color'].default_value = (*glow, 1)
        bsdf.inputs['Emission Strength'].default_value = strength
    return m

def solar_material():
    """Photovoltaic cells: deep blue squares in a silver grid, a little glossy."""
    import bpy
    m = bpy.data.materials.new('solar')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = nodes['Principled BSDF']
    coord = nodes.new('ShaderNodeTexCoord').outputs['Object']
    xyz = nodes.new('ShaderNodeSeparateXYZ')
    links.new(coord, xyz.inputs['Vector'])
    def grid(t, size, width):
        f = node_math(nodes, links, 'FRACT', node_math(nodes, links, 'DIVIDE', t, size))
        near = node_math(nodes, links, 'MINIMUM', f, node_math(nodes, links, 'SUBTRACT', 1, f))
        return node_math(nodes, links, 'LESS_THAN', node_math(nodes, links, 'MULTIPLY', near, size), width)
    lines = node_math(nodes, links, 'MAXIMUM', grid(xyz.outputs['X'], .7, .025), grid(xyz.outputs['Y'], .7, .025))
    frames = node_math(nodes, links, 'MAXIMUM', grid(xyz.outputs['X'], 4.2, .07), grid(xyz.outputs['Y'], 2.8, .07))
    lines = node_math(nodes, links, 'MAXIMUM', lines, frames)
    links.new(mix(nodes, links, 'RGBA', lines, (.018, .03, .085, 1), (.55, .58, .62, 1)), bsdf.inputs['Base Color'])
    links.new(mix(nodes, links, 'FLOAT', lines, .18, .35), bsdf.inputs['Roughness'])
    links.new(lines, bsdf.inputs['Metallic'])
    return m

def window_material(theme):
    """Lit portholes and window bands: cool by day, warm and bright at dusk."""
    dusk = theme == 'dark'
    return plain('window', (.05, .08, .1), .15, .2, (1, .78, .5) if dusk else (.75, .9, 1), 6 if dusk else 1.5)

def strip_material(theme, rgb=(.55, .85, 1)):
    """Edge light strips."""
    return plain('strip', (.8, .9, 1), .3, 0, rgb, 9 if theme == 'dark' else 2.5)

# --- Geometry ---------------------------------------------------------------
class Parts:
    """Accumulates boxes, cylinders and spheres per material into one object
    each, so a station of thousands of parts stays a handful of meshes."""
    def __init__(self):
        import bmesh
        self.meshes = {}
        self.bmesh = bmesh

    def bm(self, material):
        if material.name not in self.meshes:
            self.meshes[material.name] = (material, self.bmesh.new())
        return self.meshes[material.name][1]

    def box(self, material, center, size, turn=0, tilt=None):
        from mathutils import Matrix
        m = Matrix.Translation(center) @ Matrix.Rotation(turn, 4, 'Z')
        if tilt:
            m = m @ Matrix.Rotation(tilt[1], 4, tilt[0])
        m = m @ Matrix.Diagonal((*size, 1))
        self.bmesh.ops.create_cube(self.bm(material), size=1, matrix=m)

    def cylinder(self, material, p0, p1, r0, r1=None, segments=24, caps=True):
        from mathutils import Matrix, Vector
        p0, p1 = Vector(p0), Vector(p1)
        axis = p1 - p0
        rot = Vector((0, 0, 1)).rotation_difference(axis.normalized()).to_matrix().to_4x4()
        m = Matrix.Translation((p0 + p1) / 2) @ rot
        self.bmesh.ops.create_cone(self.bm(material), cap_ends=caps, segments=segments, radius1=r0,
                                   radius2=r0 if r1 is None else r1, depth=axis.length, matrix=m)

    def sphere(self, material, center, r, segments=24, squash=1):
        from mathutils import Matrix
        m = Matrix.Translation(center) @ Matrix.Diagonal((1, 1, squash, 1))
        self.bmesh.ops.create_uvsphere(self.bm(material), u_segments=segments, v_segments=segments // 2, radius=r, matrix=m)

    def torus(self, material, center, axis, r, t, segments=48):
        from mathutils import Vector
        axis = Vector(axis).normalized()
        u = axis.orthogonal().normalized()
        w = axis.cross(u)
        for i in range(segments):
            a0, a1 = i / segments * math.tau, (i + 1) / segments * math.tau
            p0 = Vector(center) + (u * math.cos(a0) + w * math.sin(a0)) * r
            p1 = Vector(center) + (u * math.cos(a1) + w * math.sin(a1)) * r
            self.cylinder(material, p0, p1, t, segments=8, caps=False)

    def finish(self, name, smooth=False):
        import bpy
        for key, (material, bm) in self.meshes.items():
            mesh = bpy.data.meshes.new(f'{name}_{key}')
            bm.to_mesh(mesh)
            bm.free()
            mesh.materials.append(material)
            if smooth:
                mesh.shade_smooth()
            obj = bpy.data.objects.new(f'{name}_{key}', mesh)
            bpy.context.scene.collection.objects.link(obj)
        self.meshes = {}

def prism(name, outline, top, thick, material, inset=0):
    """A slab from an outline, its top at `top`; `inset` draws its underside in,
    so its edge reads as a sloped hull."""
    import bpy, bmesh
    bm = bmesh.new()
    cx = sum(p[0] for p in outline) / len(outline)
    cy = sum(p[1] for p in outline) / len(outline)
    def shrink(x, y, d):
        r = math.hypot(x - cx, y - cy)
        return (cx + (x - cx) * (r - d) / r, cy + (y - cy) * (r - d) / r) if r > d else (cx, cy)
    upper = [bm.verts.new((x, y, top)) for x, y in outline]
    lower = [bm.verts.new((*shrink(x, y, inset), top - thick)) for x, y in outline]
    bm.faces.new(upper)
    bm.faces.new(list(reversed(lower)))
    n = len(outline)
    for i in range(n):
        bm.faces.new((lower[i], lower[(i + 1) % n], upper[(i + 1) % n], upper[i]))
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    obj.data.materials.append(material)
    bpy.context.scene.collection.objects.link(obj)
    return obj

def deck(theme):
    """The deck: a level plated landing zone under the live area, a darker
    surround to the hull's edge, a lit strip round the zone, flush pads at the
    hall anchors, an iris hatch at the centre, a sloped hull underneath, and
    railings on the far edges."""
    from mathutils import Vector
    hull = panels('deck_hull', (.24, .26, .3), 3, .55, .3)
    zone = panels('deck_zone', (.4, .43, .47), 2.4, .5, .2)
    trim = panels('deck_trim', (.2, .22, .25), 1.2, .45, .6, 'grate')
    strip = strip_material(theme)
    outline = deck_outline()
    prism('deck', outline, -.01, .6, hull)
    prism('deck_skirt', outline, -.6, 3.4, panels('deck_under', (.3, .32, .36), 2, .6, .4, 'hull'), inset=3.2)
    prism('zone', zone_outline(ZONE_RADIUS, ZONE_FRONT), 0, .02, zone)
    p = Parts()
    # A lit strip just inside the zone's edge, and a rim strip on the hull's outer face.
    edge = zone_outline(ZONE_RADIUS + .25, (ZONE_FRONT[0] - .25, ZONE_FRONT[1] + .25, ZONE_FRONT[2] - .25, 0), .6)
    rim = outline
    for pts, z, w, mat in ((edge, .012, .14, strip), (edge, .008, .5, trim)):
        for (xa, ya), (xb, yb) in zip(pts, pts[1:] + pts[:1]):
            length = math.hypot(xb - xa, yb - ya)
            p.box(mat, ((xa + xb) / 2, (ya + yb) / 2, z), (length + .02, w, .02), math.atan2(yb - ya, xb - xa))
    cx = sum(q[0] for q in rim) / len(rim)
    cy = sum(q[1] for q in rim) / len(rim)
    for (xa, ya), (xb, yb) in zip(rim, rim[1:] + rim[:1]):
        length = math.hypot(xb - xa, yb - ya)
        mx, my = (xa + xb) / 2, (ya + yb) / 2
        out = Vector((mx - cx, my - cy)).normalized() * .06
        p.box(strip, (mx + out.x, my + out.y, -.35), (length + .02, .05, .12), math.atan2(yb - ya, xb - xa))
    # Pads under each hall: a dark ring with a lit inner line.
    for x, y in [(-7, 5), (0, 7), (7, 5), (-8, -3), (8, -3)]:
        p.torus(trim, (x, y, .01), (0, 0, 1), 3.35, .16, 64)
        p.torus(strip, (x, y, .02), (0, 0, 1), 3.05, .035, 64)
    # Iris hatch at the centre: rings and eight blades.
    for r, t in ((2.3, .14), (1.7, .05)):
        p.torus(trim, (0, 0, .02), (0, 0, 1), r, t, 64)
    for k in range(8):
        a = k * math.tau / 8
        p.box(trim, (math.cos(a) * .95, math.sin(a) * .95, .015), (1.7, .06, .03), a + .9)
    # Lane markings out to the arms, painted on the surround.
    paint = plain('lane', (.55, .42, .14), .6)
    for a in (heading() + math.pi, heading()):
        for k in range(6):
            r = ZONE_RADIUS + .7 + k * .5
            if r < ZONE_RADIUS + MARGIN - .3:
                p.box(paint, (math.cos(a) * r, math.sin(a) * r, .003), (.25, 2.4, .01), a)
    # Railings: posts and two rails along the far edges.
    rail = plain('rail', (.62, .65, .68), .35, .8)
    posts = [q for q in deck_outline(1.8)]
    for (xa, ya), (xb, yb) in zip(posts, posts[1:]):
        if not (far_edge(xa, ya) and far_edge(xb, yb)):
            continue
        p.box(rail, (xa, ya, .55), (.08, .08, 1.1))
        for z in (.55, 1.08):
            p.cylinder(rail, (xa, ya, z), (xb, yb, z), .035, segments=8)
    # Floor lights round the surround, and consoles, vents and light masts on
    # the far edges, which stand behind everything on the deck.
    lamp = plain('floor_light', (.9, .95, 1), .3, 0, (.7, .88, 1), 14 if theme == 'dark' else 4)
    x0, x1, y0, _ = ZONE_FRONT
    for x, y in zone_outline(ZONE_RADIUS + 1.8, (x0 - 1.8, x1 + 1.8, y0 - 1.8, 0), 2.2):
        p.cylinder(lamp, (x, y, 0), (x, y, .03), .11, segments=10)
    console = panels('console', (.55, .58, .62), .8, .45, .4, 'hull')
    rng = random.Random(5)
    ring = ZONE_RADIUS + MARGIN - 1.1
    for k in range(40):
        a = k / 40 * math.tau
        x, y = ring * math.cos(a), ring * math.sin(a)
        if not far_edge(x, y) or rng.random() < .35:
            continue
        turn = a + math.pi / 2
        kind = rng.random()
        if kind < .45:
            p.box(console, (x, y, .45), (1.3, .6, .9), turn)
            p.box(strip, (x - math.cos(a) * .31, y - math.sin(a) * .31, .75), (1, .02, .08), turn)
        elif kind < .75:
            p.box(trim, (x, y, .02), (1.6, 1, .04), turn)
            for j in range(5):
                p.box(console, (x + math.cos(turn) * (j - 2) * .28, y + math.sin(turn) * (j - 2) * .28, .05), (.08, .85, .04), turn)
        else:
            p.cylinder(console, (x, y, 0), (x, y, .8), .38, segments=16)
            p.cylinder(trim, (x, y, .8), (x, y, .9), .42, segments=16)
    mast = plain('mast', (.5, .53, .57), .4, .7)
    for x, y in ((-17.2, -12),):
        a, b = to_frame(x, y)
        if not tall_clear(a, b, 7):
            print('YARD_ENV skipped mast', (x, y), flush=True)
            continue
        p.cylinder(mast, (x, y, 0), (x, y, 7), .14, segments=10)
        p.cylinder(trim, (x, y, 0), (x, y, .5), .32, segments=12)
        p.box(mast, (x, y, 7.1), (1.2, .5, .35), math.atan2(-y, -x) + math.pi / 2, ('X', -.5))
        p.box(lamp, (x - x / abs(x) * .05, y - y / abs(y) * .1, 6.95), (1, .1, .2), math.atan2(-y, -x) + math.pi / 2, ('X', -.5))
    p.finish('deck')

def truss(p, mat, a0, a1, z, width=2.2, turn=None, step=2.4):
    """A square lattice truss along a straight line in Blender space."""
    from mathutils import Vector
    a0, a1 = Vector((*a0, z)), Vector((*a1, z))
    axis = (a1 - a0).normalized()
    side = Vector((-axis.y, axis.x, 0)) * width / 2
    up = Vector((0, 0, width / 2))
    corners = [side + up, side - up, -side - up, -side + up]
    for c in corners:
        p.cylinder(mat, a0 + c, a1 + c, .09, segments=6)
    n = max(1, int((a1 - a0).length / step))
    for i in range(n + 1):
        q = a0 + (a1 - a0) * i / n
        for j in range(4):
            p.cylinder(mat, q + corners[j], q + corners[(j + 1) % 4], .05, segments=5)
        if i < n:
            r = a0 + (a1 - a0) * (i + 1) / n
            for j in range(4):
                p.cylinder(mat, q + corners[j], r + corners[(j + 1) % 4], .04, segments=5)

def module(p, mats, a, b, z, length, radius, turn, windows=True):
    """A habitat module: a ribbed cylinder with domed ends and a row of portholes
    on the side facing the camera."""
    from mathutils import Vector
    hull, ribs, window = mats
    x, y = to_ground(a, b)
    d = Vector((math.cos(turn), math.sin(turn), 0))
    c = Vector((x, y, z))
    p0, p1 = c - d * length / 2, c + d * length / 2
    p.cylinder(hull, p0, p1, radius, segments=32)
    for q in (p0, p1):
        p.sphere(hull, q, radius * .98, 32)
    for k in range(int(length / 3.2) + 1):
        q = p0 + d * (k * length / max(1, int(length / 3.2)))
        p.torus(ribs, q, d, radius + .05, .12, 40)
    if windows:
        # Toward the camera: the side whose normal points down the view.
        _, _, fwd = basis()
        n = Vector((-d.y, d.x, 0))
        if n.dot(fwd) > 0:
            n = -n
        for k in range(int(length / 1.6) - 1):
            q = p0 + d * (1.6 + k * 1.6) + n * (radius - .05) + Vector((0, 0, radius * .25))
            p.cylinder(window, q - n * .1, q + n * .18, .32, segments=16)

def solar_wing(p, mats, a, b, z, span, turn, tilt=.35):
    """A solar wing: a pair of long arrays either side of a mast, tilted toward the sun."""
    solar, frame = mats
    x, y = to_ground(a, b)
    for side in (-1, 1):
        for k in range(3):
            off = side * (3.2 + k * 6.6)
            cx, cy = x + math.cos(turn + math.pi / 2) * off, y + math.sin(turn + math.pi / 2) * off
            p.box(solar, (cx, cy, z), (span, 6.2, .08), turn, ('X', tilt))
            p.box(frame, (cx, cy, z - .12), (span + .3, .25, .2), turn)
    p.cylinder(frame, (x - math.cos(turn + math.pi / 2) * 23, y - math.sin(turn + math.pi / 2) * 23, z),
               (x + math.cos(turn + math.pi / 2) * 23, y + math.sin(turn + math.pi / 2) * 23, z), .22, segments=10)

def radiator(p, mat, a, b, z, length, height, turn):
    x, y = to_ground(a, b)
    p.box(mat, (x, y, z + height / 2), (length, .12, height), turn)
    for k in range(int(length / .8)):
        off = -length / 2 + .4 + k * .8
        p.box(mat, (x + math.cos(turn) * off, y + math.sin(turn) * off, z + height / 2), (.1, .3, height), turn)

def station(theme):
    """Trusses from the deck out to solar wings on the left, a docking hub with
    modules on the right, and a row of habitat modules with radiators behind."""
    import bpy
    p = Parts()
    hull = panels('hull', (.78, .79, .8), 2, .45, .15, 'hull', vary=.05)
    dark = panels('hull_dark', (.2, .22, .26), 1.6, .4, .55, 'grate')
    ribs = plain('ribs', (.32, .34, .38), .4, .7)
    frame = plain('frame', (.62, .64, .67), .35, .85)
    gold = plain('foil', (.75, .5, .16), .3, 1)
    window = window_material(theme)
    strip = strip_material(theme)
    solar = solar_material()
    h = heading()
    # Left: a truss to the solar wings.
    left0, left1 = to_ground(-17, 4), to_ground(-128, 4)
    truss(p, frame, left0, left1, -1.2, 2.4)
    for a in (-46, -78, -110):
        solar_wing(p, (solar, frame), a, 4, -1.2, 9, h, .3)
        x, y = to_ground(a, 4)
        p.cylinder(dark, (x, y, -2.6), (x, y, .3), 1.3, segments=16)
    # Right: a truss to a docking hub with modules off it.
    truss(p, frame, to_ground(17, -2), to_ground(46, -2), -1.6, 2.6)
    hx, hy = to_ground(54, -2)
    p.sphere(hull, (hx, hy, -1.6), 5.2, 40)
    for r in (5.25,):
        p.torus(ribs, (hx, hy, -1.6), (0, 0, 1), r, .18, 64)
    module(p, (hull, ribs, window), 76, -2, -1.6, 26, 3.6, h)
    module(p, (hull, ribs, window), 54, 20, -1.6, 26, 3.4, h + math.pi / 2)
    module(p, (hull, ribs, window), 54, -22, -3.2, 18, 3.2, h + math.pi / 2)
    # A docking ring on the hub's far module, and gold foil on the lower one.
    ex, ey = to_ground(90, -2)
    p.torus(dark, (ex, ey, -1.6), (math.cos(h), math.sin(h), 0), 2.6, .5, 48)
    fx, fy = to_ground(54, -32)
    p.sphere(gold, (fx, fy, -3.2), 3.1, 32)
    radiator(p, frame, 100, 12, -1.6, 14, 6, h)
    radiator(p, frame, 100, -16, -1.6, 14, 6, h)
    # Behind and below the deck: a row of habitat modules joined by nodes, on a truss.
    truss(p, frame, to_ground(-96, 34), to_ground(96, 34), -10.5, 2.4)
    for a, b, length, radius in ((-64, 34, 22, 3.6), (-26, 36, 16, 4.4), (24, 35, 20, 3.4), (66, 34, 16, 4.2)):
        module(p, (hull, ribs, window), a, b, -6.5, length, radius, h)
        x, y = to_ground(a, b)
        p.cylinder(dark, (x, y, -10.5), (x, y, -6.5 - radius + .3), .8, segments=12)
    for a in (-45, 45):
        x, y = to_ground(a, 35)
        p.sphere(hull, (x, y, -6.5), 3.8, 32)
        p.torus(ribs, (x, y, -6.5), (0, 0, 1), 3.85, .15, 48)
    for a, b in ((-64, 44), (24, 44)):
        radiator(p, frame, a, b, -6.5, 12, 4, h)
    # Beacons at the ends of the arms: red to the left, green to the right.
    beacons = [((-128, 4, 0), (1, .08, .05)), ((90, -2, 1.4), (.1, 1, .25)), ((100, 12, 5), (1, .08, .05))]
    for (a, b, z), rgb in beacons:
        x, y = to_ground(a, b)
        p.sphere(plain('beacon', rgb, .3, 0, rgb, 30 if theme == 'dark' else 12), (x, y, z), .45, 16)
    # Strip lights along the trusses.
    for (a0, b0), (a1, b1), z in (((-17, 4), (-128, 4), -2.5), ((17, -2), (46, -2), -2.95)):
        x0, y0 = to_ground(a0, b0)
        x1, y1 = to_ground(a1, b1)
        p.cylinder(strip, (x0, y0, z), (x1, y1, z), .06, segments=6)
    p.finish('station', smooth=True)
    if theme == 'dark':
        for a, b, z, e in ((-26, 30, 0, 3000), (24, 30, 0, 3000), (54, 8, 4, 2500), (-50, 4, 2, 2000)):
            lamp = bpy.data.objects.new('station_light', bpy.data.lights.new('station_light', 'POINT'))
            lamp.data.energy, lamp.data.color, lamp.data.shadow_soft_size = e, (1, .82, .62), 1
            lamp.location = (*to_ground(a, b), z)
            bpy.context.scene.collection.objects.link(lamp)

def satellites(theme):
    """A few small craft below the deck, over the planet, for depth."""
    p = Parts()
    body = panels('sat', (.75, .76, .78), 1, .45, .3, 'hull')
    solar = solar_material()
    foil = plain('sat_foil', (.8, .55, .2), .3, 1)
    rng = random.Random(7)
    for a, b, z in ((-70, -52, -26), (38, -66, -34), (110, -40, -22), (-112, -30, -18)):
        x, y = to_ground(a, b)
        turn = rng.uniform(0, math.tau)
        p.box(body if rng.random() < .5 else foil, (x, y, z), (1.6, 1.6, 2), turn)
        for side in (-1, 1):
            p.box(solar, (x + math.cos(turn) * side * 3.2, y + math.sin(turn) * side * 3.2, z), (4.2, 1.6, .06), turn)
    p.finish('satellites')

PAD_TOP = -1.2

def pad(name, x, y, theme, radius=5.5):
    """A round landing pad beside the deck, with a lit rim."""
    prism(f'pad_{name}', [(x + radius * math.cos(i / 48 * math.tau), y + radius * math.sin(i / 48 * math.tau))
                          for i in range(48)], PAD_TOP, .8, panels('pad', (.3, .32, .36), 1.5, .5, .4, 'grate'), 1.5)
    p = Parts()
    p.torus(strip_material(theme), (x, y, PAD_TOP + .02), (0, 0, 1), radius - .35, .05, 64)
    # A walkway in to the deck's edge, under a tube handrail on each side.
    d = math.hypot(x, y)
    ux, uy = -x / d, -y / d
    reach = next(t for t in range(int(d)) if on_deck(x + ux * t, y + uy * t, -.5))
    ex, ey = x + ux * reach, y + uy * reach
    walk = panels('walk', (.3, .32, .36), 1.2, .5, .4, 'grate')
    turn = math.atan2(uy, ux)
    p.box(walk, ((x + ex) / 2, (y + ey) / 2, PAD_TOP - .15), (reach, 1.8, .3), turn)
    rail = plain('rail', (.62, .65, .68), .35, .8)
    for side in (-1, 1):
        ox, oy = -uy * .85 * side, ux * .85 * side
        p.cylinder(rail, (x + ox, y + oy, PAD_TOP + .9), (ex + ox, ey + oy, PAD_TOP + .9), .04, segments=8)
    p.finish(f'pad_{name}')

def props(theme):
    """The station's TRELLIS.2 shuttle, dishes and crane, each on a pad beside
    the deck, off the live area."""
    import bpy
    loaded = {}
    for name, (a, b), tall, turn in PROPS:
        x, y = to_ground(a, b)
        if live_distance(x, y) < 3 or not tall_clear(a, b, tall):
            print('YARD_ENV skipped', name, (a, b), flush=True)
            continue
        if name not in loaded:
            loaded[name] = building(TOWN / f'{name}.glb', theme)
        coll, lo, size = loaded[name]
        scale = tall / size
        inst = bpy.data.objects.new(name, None)
        inst.instance_type, inst.instance_collection = 'COLLECTION', coll
        pad(name, x, y, theme)
        inst.location = (x, y, PAD_TOP - lo * scale)
        inst.scale = (scale,) * 3
        inst.rotation_euler = (0, 0, math.radians(turn))
        bpy.context.scene.collection.objects.link(inst)

def cargo(theme):
    """Stacks of rounded cargo containers on pads beside the deck."""
    p = Parts()
    rng = random.Random(11)
    paints = [panels(f'cargo_{k}', rgb, .9, .5, .2, 'hull', vary=.04, accent=0)
              for k, rgb in enumerate(((.8, .81, .82), (.42, .45, .48), (.28, .45, .47)))]
    latch = plain('latch', (.3, .32, .35), .4, .7)
    for k, (a, b) in enumerate(CARGO):
        x, y = to_ground(a, b)
        if live_distance(x, y) < 3 or not tall_clear(a, b, 3):
            print('YARD_ENV skipped cargo', (a, b), flush=True)
            continue
        pad(f'cargo_{k}', x, y, theme, 4.5)
        turn = rng.uniform(0, math.tau)
        c, s_ = math.cos(turn), math.sin(turn)
        for i in range(-1, 2):
            for j in range(-1, 1):
                for level in range(rng.randint(1, 3)):
                    ox, oy = i * 1.7, j * 1.25 + .6
                    cx, cy = x + ox * c - oy * s_, y + ox * s_ + oy * c
                    z = PAD_TOP + .55 + level * 1.08
                    p.box(rng.choice(paints), (cx, cy, z), (1.6, 1.15, 1.02), turn)
                    p.box(latch, (cx, cy, z), (1.64, .12, .5), turn)
    p.finish('cargo')

# --- Backdrop ---------------------------------------------------------------
def squashed_sphere(name, center_view, radius, depth, squash, segments=128):
    """A sphere seen orthographically: built round, then flattened along the
    view axis about its centre. `sn` keeps its true normals for shading and
    `pv` is a projection onto the view plane."""
    import bpy, bmesh
    from mathutils import Matrix
    right, up, fwd = basis()
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=segments // 2, radius=radius)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    sn, uv = [], []
    for v in mesh.vertices:
        n = v.co.normalized()
        sn += list(n)
        uv += [v.co.dot(right) / (2 * radius) + .5, v.co.dot(up) / (2 * radius) + .5]
    mesh.attributes.new('sn', 'FLOAT_VECTOR', 'POINT').data.foreach_set('vector', sn)
    mesh.attributes.new('pv', 'FLOAT2', 'POINT').data.foreach_set('vector', uv)
    f = fwd.to_4d()
    f.w = 0
    flatten = Matrix.Identity(4) + (squash - 1) * Matrix([[f[i] * f[j] if i < 3 and j < 3 else 0 for j in range(4)] for i in range(4)])
    centre = right * center_view[0] + up * center_view[1] + fwd * depth
    mesh.transform(Matrix.Translation(centre) @ flatten)
    mesh.shade_smooth()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    # Light only by its own shader: it neither shadows nor lights the station.
    obj.visible_shadow = False
    obj.visible_diffuse = False
    return obj

def planet(theme):
    """The planet below: its generated surface, procedural clouds, a soft
    terminator toward the theme's sun, limb darkening, an atmosphere rim and,
    on the night side, city lights."""
    import bpy
    r, u, radius, depth = PLANET
    obj = squashed_sphere('planet', (r, u), radius, depth, .15)
    m = bpy.data.materials.new('planet')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    nodes.remove(nodes['Principled BSDF'])
    out = nodes['Material Output']
    sn = nodes.new('ShaderNodeAttribute')
    sn.attribute_type, sn.attribute_name = 'GEOMETRY', 'sn'
    pv = nodes.new('ShaderNodeAttribute')
    pv.attribute_type, pv.attribute_name = 'GEOMETRY', 'pv'
    _, _, fwd = basis()
    light_dir = sun(theme).normalized()
    def dot(vec):
        d = nodes.new('ShaderNodeVectorMath')
        d.operation = 'DOT_PRODUCT'
        links.new(sn.outputs['Vector'], d.inputs[0])
        d.inputs[1].default_value = vec
        return d.outputs['Value']
    lit = nodes.new('ShaderNodeMapRange')
    lit.inputs['From Min'].default_value, lit.inputs['From Max'].default_value = -.08, .45
    links.new(dot(light_dir), lit.inputs['Value'])
    facing = dot(-fwd)
    # Surface: the generated map repeated over the disc, broken by noise warp.
    mapping = nodes.new('ShaderNodeMapping')
    mapping.inputs['Scale'].default_value = (4, 4, 1)
    warp = nodes.new('ShaderNodeTexNoise')
    warp.inputs['Scale'].default_value = .012
    warp.inputs['Detail'].default_value = 3
    links.new(sn.outputs['Vector'], warp.inputs['Vector'])
    offset = nodes.new('ShaderNodeVectorMath')
    offset.operation = 'MULTIPLY_ADD'
    links.new(warp.outputs['Color'], offset.inputs[0])
    offset.inputs[1].default_value = (.04, .04, 0)
    links.new(pv.outputs['Vector'], offset.inputs[2])
    links.new(offset.outputs['Vector'], mapping.inputs['Vector'])
    tex = nodes.new('ShaderNodeTexImage')
    tex.image = bpy.data.images.load(str(tileable('planet')))
    links.new(mapping.outputs['Vector'], tex.inputs['Vector'])
    # Clouds: fractal noise over the true sphere, thresholded into bands.
    scaled = nodes.new('ShaderNodeVectorMath')
    scaled.operation = 'SCALE'
    links.new(sn.outputs['Vector'], scaled.inputs[0])
    scaled.inputs['Scale'].default_value = 9
    stretch = nodes.new('ShaderNodeMapping')
    stretch.inputs['Scale'].default_value = (1, 1, 3)
    links.new(scaled.outputs['Vector'], stretch.inputs['Vector'])
    clouds = nodes.new('ShaderNodeTexNoise')
    clouds.inputs['Scale'].default_value = 1.6
    clouds.inputs['Detail'].default_value = 12
    clouds.inputs['Roughness'].default_value = .62
    clouds.inputs['Distortion'].default_value = .6
    links.new(stretch.outputs['Vector'], clouds.inputs['Vector'])
    cover = nodes.new('ShaderNodeMapRange')
    cover.inputs['From Min'].default_value, cover.inputs['From Max'].default_value = .56, .7
    links.new(clouds.outputs['Fac'], cover.inputs['Value'])
    day = mix(nodes, links, 'RGBA', cover.outputs['Result'], tex.outputs['Color'], (.92, .94, .96, 1))
    # Fine relief over the soft generated map, so the surface stays crisp close up.
    relief = nodes.new('ShaderNodeTexNoise')
    relief.inputs['Scale'].default_value = .15
    relief.inputs['Detail'].default_value = 10
    relief.inputs['Roughness'].default_value = .65
    metres = nodes.new('ShaderNodeVectorMath')
    metres.operation = 'SCALE'
    links.new(sn.outputs['Vector'], metres.inputs[0])
    metres.inputs['Scale'].default_value = radius
    links.new(metres.outputs['Vector'], relief.inputs['Vector'])
    grain = nodes.new('ShaderNodeMapRange')
    grain.inputs['From Min'].default_value, grain.inputs['From Max'].default_value = .3, .7
    grain.inputs['To Min'].default_value, grain.inputs['To Max'].default_value = .8, 1.15
    links.new(relief.outputs['Fac'], grain.inputs['Value'])
    rough = nodes.new('ShaderNodeMix')
    rough.data_type, rough.blend_type = 'RGBA', 'MULTIPLY'
    rough.inputs['Factor'].default_value = 1
    links.new(day, rough.inputs[6])
    links.new(grain.outputs['Result'], rough.inputs[7])
    day = rough.outputs[2]
    shaded = nodes.new('ShaderNodeMix')
    shaded.data_type, shaded.blend_type = 'RGBA', 'MULTIPLY'
    shaded.inputs['Factor'].default_value = 1
    links.new(day, shaded.inputs[6])
    links.new(lit.outputs['Result'], shaded.inputs[7])
    # Limb: darker toward the edge, with a blue haze over it on the lit side.
    limb = nodes.new('ShaderNodeMapRange')
    limb.inputs['From Min'].default_value, limb.inputs['From Max'].default_value = 0, .1
    limb.inputs['To Min'].default_value, limb.inputs['To Max'].default_value = 1, 0
    links.new(facing, limb.inputs['Value'])
    haze_lit = node_math(nodes, links, 'MULTIPLY', limb.outputs['Result'], node_math(nodes, links, 'ADD', lit.outputs['Result'], .12))
    haze_color = (.2, .45, 1, 1) if theme == 'light' else (1, .45, .2, 1)
    color = mix(nodes, links, 'RGBA', node_math(nodes, links, 'MULTIPLY', haze_lit, .45), shaded.outputs[2], haze_color)
    # City lights on the night side, where the map is not sea.
    if theme == 'dark':
        sep = nodes.new('ShaderNodeSeparateColor')
        links.new(tex.outputs['Color'], sep.inputs['Color'])
        land = node_math(nodes, links, 'GREATER_THAN', sep.outputs['Red'], node_math(nodes, links, 'MULTIPLY', sep.outputs['Blue'], .9))
        cities = nodes.new('ShaderNodeTexNoise')
        cities.inputs['Scale'].default_value = 60
        cities.inputs['Detail'].default_value = 8
        links.new(sn.outputs['Vector'], cities.inputs['Vector'])
        spots = nodes.new('ShaderNodeMapRange')
        spots.inputs['From Min'].default_value, spots.inputs['From Max'].default_value = .62, .72
        links.new(cities.outputs['Fac'], spots.inputs['Value'])
        night = node_math(nodes, links, 'MULTIPLY', node_math(nodes, links, 'SUBTRACT', 1, lit.outputs['Result']),
                          node_math(nodes, links, 'MULTIPLY', land, spots.outputs['Result']))
        night = node_math(nodes, links, 'MULTIPLY', night, node_math(nodes, links, 'SUBTRACT', 1, cover.outputs['Result']))
        glow = nodes.new('ShaderNodeMix')
        glow.data_type, glow.blend_type = 'RGBA', 'ADD'
        links.new(night, glow.inputs['Factor'])
        links.new(color, glow.inputs[6])
        glow.inputs[7].default_value = (1, .62, .3, 1)
        color = glow.outputs[2]
    emit = nodes.new('ShaderNodeEmission')
    emit.inputs['Strength'].default_value = 1.05 if theme == 'light' else .8
    links.new(color, emit.inputs['Color'])
    links.new(emit.outputs['Emission'], out.inputs['Surface'])
    obj.data.materials.append(m)
    atmosphere(theme)

def atmosphere(theme):
    """A thin glowing shell just outside the planet, brightest at the limb."""
    import bpy
    r, u, radius, depth = PLANET
    obj = squashed_sphere('atmosphere', (r, u), radius * 1.006, depth - 2, .15)
    m = bpy.data.materials.new('atmosphere')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    nodes.remove(nodes['Principled BSDF'])
    sn = nodes.new('ShaderNodeAttribute')
    sn.attribute_type, sn.attribute_name = 'GEOMETRY', 'sn'
    _, _, fwd = basis()
    def dot(vec):
        d = nodes.new('ShaderNodeVectorMath')
        d.operation = 'DOT_PRODUCT'
        links.new(sn.outputs['Vector'], d.inputs[0])
        d.inputs[1].default_value = vec
        return d.outputs['Value']
    lit = nodes.new('ShaderNodeMapRange')
    lit.inputs['From Min'].default_value, lit.inputs['From Max'].default_value = -.25, .4
    links.new(dot(sun(theme).normalized()), lit.inputs['Value'])
    # Brightest where the shell meets the planet's edge, fading out into space
    # and in over the disc.
    edge = math.sqrt(1 - 1 / 1.006 ** 2)
    outer = nodes.new('ShaderNodeMapRange')
    outer.interpolation_type = 'SMOOTHSTEP'
    outer.inputs['From Min'].default_value, outer.inputs['From Max'].default_value = 0, edge
    links.new(dot(-fwd), outer.inputs['Value'])
    inner = nodes.new('ShaderNodeMapRange')
    inner.interpolation_type = 'SMOOTHSTEP'
    inner.inputs['From Min'].default_value, inner.inputs['From Max'].default_value = edge, edge * 1.3
    inner.inputs['To Min'].default_value, inner.inputs['To Max'].default_value = 1, 0
    links.new(dot(-fwd), inner.inputs['Value'])
    rim2 = node_math(nodes, links, 'POWER', node_math(nodes, links, 'MULTIPLY', outer.outputs['Result'], inner.outputs['Result']), 1.5)
    emit = nodes.new('ShaderNodeEmission')
    emit.inputs['Color'].default_value = (.35, .62, 1, 1) if theme == 'light' else (1, .55, .3, 1)
    links.new(node_math(nodes, links, 'MULTIPLY', node_math(nodes, links, 'MULTIPLY', rim2, lit.outputs['Result']), 1.4),
              emit.inputs['Strength'])
    add = nodes.new('ShaderNodeAddShader')
    links.new(nodes.new('ShaderNodeBsdfTransparent').outputs['BSDF'], add.inputs[0])
    links.new(emit.outputs['Emission'], add.inputs[1])
    links.new(add.outputs['Shader'], nodes['Material Output'].inputs['Surface'])
    obj.data.materials.append(m)

def starfield(theme):
    """A plane square to the view, far behind everything: the generated nebula
    with stars drawn by a shader at two scales."""
    import bpy
    v = view()
    right, up, fwd = basis()
    (r0, r1), (u0, u1) = v['extent']['right'], v['extent']['up']
    w, h = r1 - r0 + 40, u1 - u0 + 40
    cr, cu = (r0 + r1) / 2, (u0 + u1) / 2
    mesh = bpy.data.meshes.new('stars')
    centre = right * cr + up * cu + fwd * STAR_DEPTH
    corners = [centre + right * (sr * w / 2) + up * (su * h / 2) for sr, su in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    mesh.from_pydata([tuple(c) for c in corners], [], [(0, 1, 2, 3)])
    uv = mesh.uv_layers.new(name='uv')
    for loop, (a, b) in zip(uv.data, ((0, 0), (1, 0), (1, 1), (0, 1))):
        loop.uv = (a, b)
    obj = bpy.data.objects.new('stars', mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.visible_shadow = False
    obj.visible_diffuse = False
    obj.visible_glossy = False
    m = bpy.data.materials.new('stars')
    nodes, links = m.node_tree.nodes, m.node_tree.links
    nodes.remove(nodes['Principled BSDF'])
    coords = nodes.new('ShaderNodeTexCoord')
    nebula = nodes.new('ShaderNodeTexImage')
    nebula.image = bpy.data.images.load(str(Path(__file__).resolve().parent / 'textures/nebula.jpg'))
    nebula.extension = 'EXTEND'
    links.new(coords.outputs['UV'], nebula.inputs['Vector'])
    dim = nodes.new('ShaderNodeMix')
    dim.data_type, dim.blend_type = 'RGBA', 'MULTIPLY'
    dim.inputs['Factor'].default_value = 1
    links.new(nebula.outputs['Color'], dim.inputs[6])
    k = .55 if theme == 'light' else .7
    dim.inputs[7].default_value = (k, k, k, 1)
    color = dim.outputs[2]
    # Stars in metres across the plane: a dense faint layer and a sparse bright one.
    metres = nodes.new('ShaderNodeMapping')
    metres.inputs['Scale'].default_value = (w, h, 1)
    links.new(coords.outputs['UV'], metres.inputs['Vector'])
    for cell, size, cut, gain in ((1.3, .08, .8, 2), (4.5, .13, .93, 6)):
        vor = nodes.new('ShaderNodeTexVoronoi')
        vor.inputs['Scale'].default_value = 1 / cell
        links.new(metres.outputs['Vector'], vor.inputs['Vector'])
        bright = nodes.new('ShaderNodeSeparateColor')
        links.new(vor.outputs['Color'], bright.inputs['Color'])
        keep = node_math(nodes, links, 'GREATER_THAN', bright.outputs['Red'], cut)
        core = nodes.new('ShaderNodeMapRange')
        core.inputs['From Min'].default_value, core.inputs['From Max'].default_value = size / cell, 0
        links.new(vor.outputs['Distance'], core.inputs['Value'])
        core = node_math(nodes, links, 'POWER', core.outputs['Result'], 1.5)
        star = node_math(nodes, links, 'MULTIPLY', node_math(nodes, links, 'MULTIPLY', core, keep),
                         node_math(nodes, links, 'MULTIPLY', bright.outputs['Green'], gain))
        tint = mix(nodes, links, 'RGBA', bright.outputs['Blue'], (1, .86, .7, 1), (.75, .85, 1, 1))
        add = nodes.new('ShaderNodeMix')
        add.data_type, add.blend_type = 'RGBA', 'ADD'
        links.new(star, add.inputs['Factor'])
        links.new(color, add.inputs[6])
        links.new(tint, add.inputs[7])
        color = add.outputs[2]
    emit = nodes.new('ShaderNodeEmission')
    links.new(color, emit.inputs['Color'])
    links.new(emit.outputs['Emission'], nodes['Material Output'].inputs['Surface'])
    obj.data.materials.append(m)

# --- Light ------------------------------------------------------------------
def world_shader(theme):
    """Space light: near black above, the planet's glow from below."""
    import bpy
    world = bpy.data.worlds.new('space')
    bpy.context.scene.world = world
    nodes, links = world.node_tree.nodes, world.node_tree.links
    coord = nodes.new('ShaderNodeTexCoord')
    sep = nodes.new('ShaderNodeSeparateXYZ')
    links.new(coord.outputs['Generated'], sep.inputs['Vector'])
    fade = nodes.new('ShaderNodeMapRange')
    fade.inputs['From Min'].default_value, fade.inputs['From Max'].default_value = .15, -.6
    links.new(sep.outputs['Z'], fade.inputs['Value'])
    below = (.2, .36, .62, 1) if theme == 'light' else (.12, .1, .14, 1)
    above = (.012, .018, .035, 1) if theme == 'light' else (.012, .012, .03, 1)
    color = mix(nodes, links, 'RGBA', fade.outputs['Result'], above, below)
    bg = nodes['Background']
    links.new(color, bg.inputs['Color'])
    bg.inputs['Strength'].default_value = 1.4 if theme == 'light' else 1

def lights(theme):
    import bpy
    dusk = theme == 'dark'
    world_shader(theme)
    lamp = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    # Space sun: hard and white by day; low and warm through the atmosphere at dusk.
    lamp.data.energy = 2.2 if dusk else 4.2
    lamp.data.angle = math.radians(1.5 if dusk else .6)
    lamp.data.color = (1, .62, .4) if dusk else (1, .98, .95)
    lamp.rotation_euler = sun(theme).to_track_quat('Z', 'Y').to_euler()
    bpy.context.scene.collection.objects.link(lamp)
    if dusk:
        # Floodlights over the deck's back edge.
        for x, y in ((-12, 14), (10, 15), (-18, -8), (0, 20)):
            flood = bpy.data.objects.new('flood', bpy.data.lights.new('flood', 'POINT'))
            flood.data.energy, flood.data.color, flood.data.shadow_soft_size = 2600, (.85, .92, 1), .5
            flood.location = (x, y, 9)
            bpy.context.scene.collection.objects.link(flood)

def sky(theme, path):
    """Render the world light to an equirectangular HDR at `path`, for the live
    models' image-based lighting (surfaces.py)."""
    import bpy
    bpy.ops.wm.read_factory_settings(use_empty=True)
    world_shader(theme)
    scene = bpy.context.scene
    cam = bpy.data.objects.new('sky', bpy.data.cameras.new('sky'))
    cam.data.type, cam.data.panorama_type = 'PANO', 'EQUIRECTANGULAR'
    cam.rotation_euler = (math.pi / 2, 0, -math.pi / 2)
    scene.collection.objects.link(cam)
    scene.camera = cam
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 4
    scene.render.resolution_x, scene.render.resolution_y = 512, 256
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = 'Standard'
    scene.render.image_settings.file_format = 'HDR'
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)

def halls():
    import bpy
    bpy.ops.import_scene.gltf(filepath=str(ROOT / 'web/yard/assets/orbital.glb'))

def build(with_halls=True, theme='light'):
    import bpy
    bpy.ops.wm.read_factory_settings(use_empty=True)
    random.seed(138)
    lights(theme)
    starfield(theme)
    planet(theme)
    deck(theme)
    station(theme)
    satellites(theme)
    props(theme)
    cargo(theme)
    if with_halls:
        halls()

if __name__ == '__main__' and '--preview' in sys.argv:
    preview(sys.modules[__name__], 'dark' if '--dark' in sys.argv else 'light')
