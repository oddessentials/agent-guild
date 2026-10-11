# Renders the Professional skin's card art with Blender: one glass object per tool, in the
# tool's colour, under soft studio light, over transparency with its shadow. The card paints
# the backdrop, so one scene renders every tool, theme and state and the set stays consistent.
#   blender -b -P source/scene.py -- [tool[:theme[:state]] ...] [--samples N] [--out DIR]
# Writes objects/<tool>/<theme>-<state>.png in this pack (1400x1400 RGBA) unless --out says otherwise.
import math, sys
from pathlib import Path
import bpy, mathutils

HERE = Path(__file__).resolve().parent
PACK = HERE.parent
TOOLS = {'anthropic': '#d97757', 'openai': '#10a37f', 'google': '#4285f4', 'xai': '#14b8c4', 'shell': '#7c6cf0', 'docker': '#2496ed'}
LOCKED = '#8b929e'
# The empty state, before the first session: a blank slate-grey tile, rendered idle only.
EXTRA = {'empty': '#a3adbd'}
# The world is not seen, but the glass reflects it: bright and white for light, deep slate for dark.
THEMES = {
    'light': {'top': '#ffffff', 'bottom': '#e9edf3', 'tint': 0.08, 'world': 1.0, 'key': 1400, 'fill': 350, 'rim': 500, 'glass': 1.0},
    'dark': {'top': '#2a3140', 'bottom': '#0e1117', 'tint': 0.07, 'world': 0.8, 'key': 1100, 'fill': 220, 'rim': 900, 'glass': 0.85},
}
STATES = {'idle': {'glow': 0, 'rim': 1.0}, 'working': {'glow': 0.3, 'rim': 2.4}, 'locked': {'glow': 0, 'rim': 0.5}}
SIZE = 1400

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
samples = int(argv[argv.index('--samples') + 1]) if '--samples' in argv else 160
out_dir = Path(argv[argv.index('--out') + 1]) if '--out' in argv else PACK / 'objects'
jobs = [a for i, a in enumerate(argv) if not a.startswith('--') and (i == 0 or argv[i - 1] not in ('--samples', '--out'))]


def rgb(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]


def mix(a, b, t):
    return [a[i] + (b[i] - a[i]) * t for i in range(3)]


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = samples
scene.cycles.use_denoising = True
prefs = bpy.context.preferences.addons['cycles'].preferences
try:
    prefs.compute_device_type = 'OPTIX'
    prefs.get_devices()
    for d in prefs.devices:
        d.use = True
    scene.cycles.device = 'GPU'
except Exception:
    pass
scene.render.resolution_x = scene.render.resolution_y = SIZE
scene.render.film_transparent = True
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.view_settings.view_transform = 'AgX'
scene.view_settings.look = 'AgX - Base Contrast'


def smooth(o, bevel=0.0):
    if bevel:
        b = o.modifiers.new('bevel', 'BEVEL')
        b.width, b.segments = bevel, 8
    bpy.ops.object.shade_smooth()
    return o


def cube(size, loc, rot=(0, 0, 0), bevel=0.06):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=[math.radians(r) for r in rot])
    o = bpy.context.object
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    return smooth(o, bevel)


def sphere(r, loc):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=96, ring_count=48, radius=r, location=loc)
    return smooth(bpy.context.object)


def torus(major, minor, loc, rot):
    bpy.ops.mesh.primitive_torus_add(major_segments=128, minor_segments=64, major_radius=major, minor_radius=minor, location=loc, rotation=[math.radians(r) for r in rot])
    return smooth(bpy.context.object)


def aim(o, target):
    o.rotation_euler = mathutils.Vector([target[i] - o.location[i] for i in range(3)]).to_track_quat('-Z', 'Y').to_euler()


# One hero object per tool, built from primitives and gathered in a collection so only the
# tool being rendered is visible. Each stands on the floor at the origin, about 2 units tall.
def hero_anthropic():
    # Three thin slabs fanned like pages.
    return [cube((1.5, 0.12, 1.8), (-0.4 + i * 0.4, 0.3 - i * 0.3, 0.92), (0, 0, 10 + i * 18)) for i in range(3)]


def hero_openai():
    return [torus(0.95, 0.3, (0, 0, 1.28), (78, 0, 20))]


def hero_google():
    return [sphere(0.52, (-0.55, 0.1, 0.52)), sphere(0.52, (0.55, 0.1, 0.52)), sphere(0.52, (0, -0.3, 1.38)), sphere(0.36, (0.1, 0.9, 1.5))]


def hero_xai():
    o = cube((0.9, 0.9, 2.0), (0, 0, 1.0), bevel=0.05)
    tw = o.modifiers.new('twist', 'SIMPLE_DEFORM')
    tw.deform_method, tw.angle, tw.deform_axis = 'TWIST', math.radians(55), 'Z'
    sub = o.modifiers.new('sub', 'SUBSURF')
    sub.levels = sub.render_levels = 3
    return [o]


def hero_shell():
    # A cube balanced on one corner.
    return [cube((1.25, 1.25, 1.25), (0, 0, 1.1), (45, 35.264, 0), bevel=0.08)]


def hero_empty():
    # A blank tile standing at a slant.
    return [cube((2.1, 0.12, 1.4), (0, 0, 0.72), (0, 0, -22), bevel=0.05)]


def hero_docker():
    # Stacked containers, the top one set across.
    return [cube((2.0, 0.9, 0.62), (0, 0, 0.31)), cube((2.0, 0.9, 0.62), (0.15, 0.05, 0.95)), cube((0.9, 2.0, 0.62), (-0.25, 0, 1.59), (0, 0, 8))]


heroes = {}
for tool in {**TOOLS, **EXTRA}:
    col = bpy.data.collections.new(tool)
    scene.collection.children.link(col)
    for o in globals()[f'hero_{tool}']():
        for c in o.users_collection:
            c.objects.unlink(o)
        col.objects.link(o)
    heroes[tool] = col

# The floor only catches the object's shadow and reflection; the card paints what is behind.
bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 10, 0))
floor = bpy.context.object
floor.is_shadow_catcher = True

glass = bpy.data.materials.new('glass')
glass.use_nodes = True
gnode = glass.node_tree.nodes['Principled BSDF']
for col in heroes.values():
    for o in col.objects:
        o.data.materials.append(glass)
fmat = bpy.data.materials.new('floor')
fmat.use_nodes = True
fnode = fmat.node_tree.nodes['Principled BSDF']
floor.data.materials.append(fmat)


# Studio lighting: a large soft key from the upper left, a fill from the right, a rim from behind
# in the tool colour, and a gradient world that the glass reflects.
def light(name, loc, size):
    data = bpy.data.lights.new(name, 'AREA')
    data.size = size
    o = bpy.data.objects.new(name, data)
    scene.collection.objects.link(o)
    o.location = loc
    aim(o, (0, 0, 1.0))
    return o


key = light('key', (-4, -5, 7), 6)
fill = light('fill', (5, -4, 3), 5)
rim = light('rim', (2.5, 5, 4), 4)

world = bpy.data.worlds.new('world')
world.use_nodes = True
scene.world = world
nodes, links = world.node_tree.nodes, world.node_tree.links
wbg = nodes['Background']
coord = nodes.new('ShaderNodeTexCoord')
sep = nodes.new('ShaderNodeSeparateXYZ')
ramp = nodes.new('ShaderNodeValToRGB')
links.new(coord.outputs['Generated'], sep.inputs['Vector'])
links.new(sep.outputs['Z'], ramp.inputs['Fac'])
links.new(ramp.outputs['Color'], wbg.inputs['Color'])
ramp.color_ramp.elements[0].position, ramp.color_ramp.elements[1].position = 0.3, 0.75

cam_data = bpy.data.cameras.new('cam')
cam_data.lens = 85
cam = bpy.data.objects.new('cam', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
cam.location = (0.5, -9.0, 2.5)
aim(cam, (0, 0, 1.0))


def render(tool, theme, state):
    th, st = THEMES[theme], STATES[state]
    color = rgb(LOCKED if state == 'locked' else {**TOOLS, **EXTRA}[tool])
    for name, col in heroes.items():
        col.hide_render = col.hide_viewport = name != tool
    ramp.color_ramp.elements[0].color = (*mix(rgb(th['bottom']), color, th['tint']), 1)
    ramp.color_ramp.elements[1].color = (*mix(rgb(th['top']), color, th['tint'] * 0.5), 1)
    wbg.inputs['Strength'].default_value = th['world']
    fnode.inputs['Base Color'].default_value = (*mix(rgb(th['bottom']), color, th['tint']), 1)
    fnode.inputs['Roughness'].default_value = 0.5 if theme == 'light' else 0.4
    frosted = state == 'locked'
    gnode.inputs['Base Color'].default_value = (*color, 1)
    gnode.inputs['Roughness'].default_value = 0.35 if frosted else 0.04
    gnode.inputs['Transmission Weight'].default_value = th['glass'] * (0.6 if frosted else 1)
    gnode.inputs['IOR'].default_value = 1.5
    gnode.inputs['Coat Weight'].default_value = 0 if frosted else 0.6
    gnode.inputs['Emission Color'].default_value = (*color, 1)
    gnode.inputs['Emission Strength'].default_value = st['glow'] * (0.25 if theme == 'light' else 1)
    key.data.energy = th['key']
    fill.data.energy = th['fill']
    rim.data.energy = th['rim'] * (min(st['rim'], 1.4) if theme == 'light' else st['rim'])
    rim.data.color = mix([1, 1, 1], color, 0.6)
    out = out_dir / tool / f'{theme}-{state}.png'
    out.parent.mkdir(parents=True, exist_ok=True)
    scene.render.filepath = str(out)
    bpy.ops.render.render(write_still=True)
    print('wrote', out, flush=True)


for job in jobs or [*TOOLS, 'empty:light:idle', 'empty:dark:idle']:
    parts = job.split(':')
    for theme in ([parts[1]] if len(parts) > 1 else list(THEMES)):
        for state in ([parts[2]] if len(parts) > 2 else list(STATES)):
            render(parts[0], theme, state)
