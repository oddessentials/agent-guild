"""Authored miniature worlds and rigged cast for Agent Guild.
Run: blender --background --factory-startup --python concept-art/guild-yard/build.py
Rebuild only some worlds: ... build.py -- --only guild
Coordinates are metres; Blender Z-up exports to glTF Y-up. No downloaded models.
"""
import bpy, math, random, json, sys
from pathlib import Path
from mathutils import Matrix, Vector, Euler
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'web/yard/assets'
SOURCE = Path(__file__).resolve().parent
OUT.mkdir(parents=True,exist_ok=True)
random.seed(714)
PI=math.pi
ARGS=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
ONLY=ARGS[ARGS.index('--only')+1].split(',') if '--only' in ARGS else None
# Worlds whose ground and surroundings are pre-rendered plates (env/); their
# glTF carries only the live halls.
PLATED={'guild'}
PALETTE={
 'stone':'777966','stoneLight':'a2a08b','stoneDark':'434b42','edge':'bcb08b',
 'paver0':'777966','paver1':'898777','paver2':'686e61','paver3':'969281',
 'soil':'26362c','grass':'3f603f','leaf':'447653','leafLight':'739455','bark':'5c4433',
 'wood':'624735','woodLight':'98704a','gold':'bb914a','iron':'28353b',
 'amber':'b86930','emerald':'295947','blue':'345777','cyan':'2b6976','violet':'614778',
 'window':'ffb35a','magic':'83d8d0','glass':'254751','white':'c4d0c5','black':'15232b',
 'orbitalBase':'263540','orbitalPanel':'465b6a','orbitalEdge':'a2b9c1',
 'groveBase':'314531','groveWood':'8b6951','groveLeaf':'59824c',
 'office':'c4c8bf','officeDark':'6c7d80','officeGlass':'5a8994',
 'skin':'c8a27a','hair':'3e3028','cloth':'ded0a2'
}
M={}
def clear():
 bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
 for a in list(bpy.data.actions): bpy.data.actions.remove(a)
 for m in list(bpy.data.meshes):
  if m.users==0: bpy.data.meshes.remove(m)
 bpy.context.scene.render.fps=24
def mat(name):
 if name in M:return M[name]
 h=PALETTE.get(name,name.lstrip('#'));rgb=[int(h[i:i+2],16)/255 for i in (0,2,4)]
 m=bpy.data.materials.new(name);m.diffuse_color=(*rgb,1);m.use_nodes=True
 bs=m.node_tree.nodes.get('Principled BSDF')
 bs.inputs['Base Color'].default_value=(*(v**2.2 for v in rgb),1)
 bs.inputs['Roughness'].default_value=.7 if name not in ['gold','iron','glass','officeGlass'] else .33
 bs.inputs['Metallic'].default_value=.7 if name in ['gold','iron','orbitalEdge'] else .05
 if name in ['window','magic']:
  bs.inputs['Emission Color'].default_value=(*(v**2.2 for v in rgb),1);bs.inputs['Emission Strength'].default_value=1.6
 M[name]=m;return m

class Sculpt:
 def __init__(self):self.v=[];self.f=[];self.m=[];self.b=[];self.smooth=[]
 def add(self,verts,faces,material,bone='root',pos=(0,0,0),scale=(1,1,1),rot=(0,0,0),smooth=False):
  transform=Matrix.Translation(Vector(pos))@Euler(rot).to_matrix().to_4x4()@Matrix.Diagonal(Vector((*scale,1)))
  start=len(self.v);self.v.extend([tuple(transform@Vector(v)) for v in verts]);self.b.extend([bone]*len(verts))
  self.f.extend([tuple(start+i for i in f) for f in faces]);self.m.extend([material]*len(faces));self.smooth.extend([smooth]*len(faces))
 def box(self,pos,size,material,bevel=.035,rot=(0,0,0),bone='root'):
  x,y,z=[n/2 for n in size];b=min(bevel,x*.4,y*.4,z*.4)
  ring=[(-x+b,-y),(x-b,-y),(x,-y+b),(x,y-b),(x-b,y),(-x+b,y),(-x,y-b),(-x,-y+b)]
  verts=[]
  for h,inset in [(-z,b),(-z+b,0),(z-b,0),(z,b)]:
   verts.extend([(a*(1-inset/max(x,.01)),c*(1-inset/max(y,.01)),h) for a,c in ring])
  faces=[tuple(range(7,-1,-1)),tuple(range(24,32))]
  for j in range(3):
   for i in range(8):faces.append((j*8+i,j*8+(i+1)%8,(j+1)*8+(i+1)%8,(j+1)*8+i))
  self.add(verts,faces,material,bone,pos=pos,rot=rot)
 def cone(self,pos,r1,r2,height,material,n=16,bone='root',rot=(0,0,0)):
  verts=[(r*math.cos(i*2*PI/n),r*math.sin(i*2*PI/n),z) for z,r in [(-height/2,r1),(height/2,r2)] for i in range(n)]
  faces=[tuple(range(n-1,-1,-1)),tuple(range(n,2*n))]
  faces.extend([(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)])
  self.add(verts,faces,material,bone,pos=pos,rot=rot,smooth=True)
 def sphere(self,pos,size,material,n=16,rings=10,bone='root'):
  verts=[(math.sin(j*PI/rings)*math.cos(i*2*PI/n),math.sin(j*PI/rings)*math.sin(i*2*PI/n),math.cos(j*PI/rings)) for j in range(rings+1) for i in range(n)]
  faces=[(j*n+i,j*n+(i+1)%n,(j+1)*n+(i+1)%n,(j+1)*n+i) for j in range(rings) for i in range(n)]
  self.add(verts,faces,material,bone,pos=pos,scale=size,smooth=True)
 def torus(self,pos,r,t,material,n=32,rot=(0,0,0),bone='root'):
  verts=[((r+t*math.cos(j*2*PI/6))*math.cos(i*2*PI/n),(r+t*math.cos(j*2*PI/6))*math.sin(i*2*PI/n),t*math.sin(j*2*PI/6)) for i in range(n) for j in range(6)]
  faces=[(i*6+j,((i+1)%n)*6+j,((i+1)%n)*6+(j+1)%6,i*6+(j+1)%6) for i in range(n) for j in range(6)]
  self.add(verts,faces,material,bone,pos=pos,rot=rot,smooth=True)
 def roof(self,pos,width,depth,height,material):
  x,y=width/2,depth/2
  self.add([(-x,-y,0),(x,-y,0),(x,y,0),(-x,y,0),(0,-y,height),(0,y,height)],[(0,1,4),(3,5,2),(0,4,5,3),(1,2,5,4),(3,2,1,0)],material,pos=pos)
  for side in [-1,1]:
   for j in range(1,8):
    f=j/8
    self.box((pos[0]+side*x*f,pos[1],pos[2]+height*(1-f)+.025),(.065,depth+.045,.052),material,.018)
   for row in range(8):
    f=(row+.5)/8
    for col in range(max(4,int(depth/.35))):
     y=-depth/2+(col+.5)*depth/max(4,int(depth/.35))
     self.box((pos[0]+side*x*f,pos[1]+y,pos[2]+height*(1-f)+.033),(.18,.014,.027),'iron',.004,rot=(0,side*math.atan2(height,x),0))
  self.box((pos[0],pos[1],pos[2]+height+.04),(.12,depth+.1,.1),'gold',.025)
 def object(self,name):
  mesh=bpy.data.meshes.new(name);mesh.from_pydata(self.v,[],self.f);mesh.update()
  uv=mesh.uv_layers.new(name='Surface')
  for poly in mesh.polygons:
   axis=max(range(3),key=lambda a:abs(poly.normal[a]))
   axes=[a for a in range(3) if a!=axis]
   for loop in poly.loop_indices:
    co=mesh.vertices[mesh.loops[loop].vertex_index].co
    uv.data[loop].uv=(co[axes[0]]*.7,co[axes[1]]*.7)
  obj=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(obj)
  names=list(dict.fromkeys(self.m))
  for material in names:mesh.materials.append(mat(material))
  for i,p in enumerate(mesh.polygons):p.material_index=names.index(self.m[i]);p.use_smooth=self.smooth[i]
  return obj
 def bind(self,obj,rig):
  for bone in set(self.b):
   group=obj.vertex_groups.new(name=bone);group.add([i for i,b in enumerate(self.b) if b==bone],1,'REPLACE')
  mod=obj.modifiers.new('Guild armature','ARMATURE');mod.object=rig;obj.parent=rig

def export(name,save=False):
 bpy.context.scene.frame_set(0)
 if save:bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE/(name+'.blend')),compress=True)
 bpy.ops.export_scene.gltf(filepath=str(OUT/(name+'.glb')),export_format='GLB',export_animations=True,export_animation_mode='ACTIONS',export_force_sampling=True,export_frame_range=False,export_yup=True,export_lights=False,export_cameras=False)
 print('YARD_ASSET',name,flush=True)

def arch(s,x,y,z,width,height,material='edge'):
 # Door faces toward the camera (negative Blender Y).
 s.box((x,y,z+height*.4),(width,.1,height*.8),'wood',.025)
 s.sphere((x,y,z+height*.8),(width*.5,.055,width*.5),'wood')
 for side in [-1,1]:
  s.box((x+side*(width*.5+.12),y-.07,z+height*.42),(.2,.24,height*.84),material,.03)
 for i in range(9):
  a=i*PI/8
  s.box((x+math.cos(a)*(width*.5+.11),y-.07,z+height*.82+math.sin(a)*(width*.5+.11)),(.23,.25,.23),material,.025,rot=(0,-a,0))
 for j in range(1,5):s.box((x-width*.5+j*width/5,y-.07,z+height*.4),(.022,.045,height*.76),'iron',.005)
 s.torus((x+.16,y-.16,z+height*.44),.06,.015,'gold',12,rot=(PI/2,0,0))
def lantern(s,x,y,z):
 s.box((x,y,z),(.2,.2,.28),'window',.025)
 s.cone((x,y,z+.2),.2,0,.14,'iron',8)
 s.box((x,y,z-.18),(.25,.25,.07),'gold',.02)
def tree(s,x,y,scale=1,grove=False):
 s.cone((x,y,scale),.2*scale,.09*scale,2*scale,'bark',9)
 for h,r in [(1.9,1),(2.6,.75),(3.15,.42)]:
  if grove:s.sphere((x,y,h*scale),(r*scale,r*.8*scale,r*.65*scale),'leafLight',12,7)
  else:s.cone((x,y,h*scale),r*scale,.08,1.5*scale,'leaf' if h<3 else 'leafLight',10)
def floor_world(s,skin):
 base={'guild':'stoneDark','orbital':'orbitalBase','grove':'groveBase','professional':'officeDark'}[skin]
 s.cone((0,0,-.7),14,13.6,1.3,base,72)
 s.cone((0,0,-.08),13.7,13.7,.2,'stone' if skin=='guild' else base,72)
 for radius,height in [(13.7,.06),(13.3,.14)]:
  s.torus((0,0,height),radius,.10,'gold' if skin=='guild' else 'orbitalEdge' if skin=='orbital' else 'groveWood' if skin=='grove' else 'white',96)
 if skin=='guild':
  for j in range(-15,16):
   for i in range(-15,16):
    x=i*.83+(j%2)*.42;y=j*.76
    if x*x+y*y<12.9**2:
     s.box((x,y,.055+random.random()*.025),(.79,.70,.12),'paver'+str(random.randrange(4)),.055,rot=(0,0,random.uniform(-.018,.018)))
  # Perimeter masonry, overlooking the forest.
  for i in range(45):
   a=i*PI/44;x=13.2*math.cos(a);y=13.2*math.sin(a)
   s.box((x,y,.68),(1.0,.38,1.3),'stoneDark',.05,rot=(0,0,a+PI/2))
   s.box((x,y,1.38),(1.05,.46,.16),'edge',.035,rot=(0,0,a+PI/2))
   if i%2==0:s.box((x,y,1.66),(.42,.45,.45),'stone',.04,rot=(0,0,a+PI/2))
  for x in [-11,11]:
   s.cone((x,7,1.15),.9,.85,2.4,'stone',14)
   s.cone((x,7,2.65),1.05,0,1,'blue',14)
  for x,y,k in [(-11,1,.7),(11,0,.9),(-4,10,.7),(4,10,.8),(-11,-6,.55),(11,-6,.6)]:
   tree(s,x,y,k)
  for x,y in [(-4,3),(4,3),(-5,-4),(5,-4),(-11,5),(11,5)]:
   s.box((x,y,.22),(1.1,.7,.35),'stoneDark',.08)
   for i in range(5):s.sphere((x+random.uniform(-.4,.4),y+random.uniform(-.2,.2),.58),(.36,.3,.4),'leaf',10,6)
  for x,y in [(-4,-1),(4,-1),(-5,-7),(5,-7),(-11,-2),(11,-2),(-4,7),(4,7)]:
   s.cone((x,y,.5),.22,.15,1,'stoneDark',8);lantern(s,x,y,1.16)
  for x in [-3,3]:
   s.box((x,-5,.55),(1.4,.6,.17),'wood',.04)
   for dx in [-.5,.5]:s.box((x+dx,-5,.28),(.1,.4,.55),'iron',.025)
 elif skin=='orbital':
  for i in range(-6,7):
   for j in range(-6,7):
    if i*i+j*j<40:
     s.box((i*1.9,j*1.9,.08),(1.82,1.82,.12),'orbitalPanel',.07)
  for r in [3,9,12.5]:s.torus((0,0,.18),r,.055,'magic',72)
  for x in [-11,11]:
   s.box((x,1,.45),(1.4,6,.7),'orbitalBase',.1)
   for y in [-1,0,1,2,3]:s.box((x,y,.83),(1.1,.3,.06),'magic',.02)
 elif skin=='grove':
  for r in [2.9,6,9.5]:
   for i in range(int(r*7)):
    a=i*2*PI/int(r*7)
    s.sphere((r*math.cos(a),r*math.sin(a),.07),(.45,.33,.1),'paver'+str(i%4),10,5)
  for x,y,k in [(-11,5,1.4),(11,6,1.5),(0,11,1.3),(-11,-4,.9),(11,-5,.8)]:tree(s,x,y,k,True)
  for i in range(70):
   a=random.random()*2*PI;r=random.uniform(11.4,13.0);x=r*math.cos(a);y=r*math.sin(a)
   s.sphere((x,y,.2),(.3,.3,.3),'leaf',9,6)
   if i%5==0:
    s.cone((x,y,.4),.045,.045,.5,'woodLight',7);s.sphere((x,y,.67),(.25,.23,.12),'amber',12,6)
 elif skin=='professional':
  for i in range(-6,7):
   for j in range(-6,7):
    if i*i+j*j<40:s.box((i*1.9,j*1.9,.05),(1.86,1.86,.06),'office',.015)
  for x,y in [(-11,3),(11,4),(-4,9),(4,9)]:
   s.box((x,y,.3),(1.5,1,.55),'officeDark',.05)
   s.box((x,y,.67),(1.3,.85,.3),'leaf',.1)
 # Central focal point / commons.
 for r,h in [(2.35,.16),(2.05,.27),(1.75,.38)]:
  s.cone((0,0,h),r,r,.15,'edge' if skin=='guild' else 'orbitalPanel' if skin=='orbital' else 'groveWood' if skin=='grove' else 'white',48)
 if skin=='guild':
  s.torus((0,0,.5),1.65,.07,'gold',48)
  for i in range(12):
   a=i*PI/6;s.box((1.4*math.cos(a),1.4*math.sin(a),.49),(.33,.06,.04),'gold',.01,rot=(0,0,a))
  s.cone((0,0,.84),.75,.45,.72,'stoneDark',12)
  s.torus((0,0,1.2),.54,.08,'gold',24)
  s.sphere((0,0,1.75),(.38,.38,.42),'magic',20,12)
  for a in [0,PI/2]:s.torus((0,0,1.75),.63,.035,'gold',36,rot=(PI/2,a,0))
 elif skin=='orbital':
  s.cone((0,0,.8),1,.7,.7,'orbitalBase',24)
  for z in [1.3,1.65,2]:s.torus((0,0,z),.7,.05,'magic',32)
 elif skin=='grove':
  tree(s,0,0,.9,True)
 else:
  s.box((0,0,1.0),(1,1,1.3),'officeGlass',.1)
  s.box((0,0,1.7),(1.2,1.2,.12),'white',.025)

def guild_hall(index):
 s=Sculpt();color=['amber','emerald','blue','cyan','violet'][index]
 s.cone((0,0,.15),2.55,2.55,.25,'stoneDark',32)
 s.cone((0,0,.30),2.30,2.30,.12,'edge',32)
 # welcoming steps, facade detail and lanterns
 for i in range(3):s.box((0,-2.0-i*.18,.26-i*.06),(1.45,.5,.14),'stoneLight',.035)
 if index==0:
  s.box((0,0,1.7),(2.9,2.3,2.8),'stone',.09)
  s.cone((0,0,3.75),2.15,.1,1.55,color,4,rot=(0,0,PI/4))
  for x,y in [(-1.4,.8),(1.4,.8)]:
   s.cone((x,y,2.2),.58,.58,3.6,'stoneLight',12)
   s.torus((x,y,3.7),.6,.09,'edge',16)
   s.cone((x,y,4.25),.8,0,1.25,color,12)
   s.sphere((x,y,4.91),(.08,.08,.13),'gold',10,6)
  arch(s,0,-1.18,.38,1,1.7)
 elif index==1:
  s.box((0,0,1.85),(2.8,2.7,3.0),'stoneLight',.07)
  s.roof((0,0,3.38),3.15,3.05,1.5,color)
  for x in [-1.4,1.4]:
   for y in [-1,.7]:
    s.box((x,y,1.9),(.26,.4,3.1),'edge',.03)
    s.cone((x,y,3.75),.3,0,.8,color,4)
  arch(s,0,-1.38,.36,1.05,1.6)
  s.torus((0,-1.42,2.88),.36,.07,'gold',24,rot=(PI/2,0,0))
  s.sphere((0,-1.40,2.88),(.32,.035,.32),'magic',16,8)
  s.cone((0,.6,4.8),.5,0,1.65,color,8)
 elif index==2:
  s.cone((0,0,1.9),1.55,1.55,3.1,'stoneLight',24)
  for z in [.45,1.35,2.6,3.45]:s.torus((0,0,z),1.59,.07,'gold',32)
  s.sphere((0,0,3.45),(1.65,1.65,1.45),color,32,14)
  # dome ribs
  for a in range(8):s.torus((0,0,3.47),1.65,.025,'gold',48,rot=(PI/2,0,a*PI/8))
  s.cone((0,0,5),.09,0,.4,'gold',8)
  arch(s,0,-1.52,.32,.95,1.7)
  for x in [-1,1]:
   s.box((x,-1.12,2.3),(.35,.1,.7),'window',.04)
 elif index==3:
  s.box((0,0,2.0),(2.25,2.3,3.3),'stoneDark',.07)
  s.cone((0,0,4.3),1.85,.04,2.1,'iron',4,rot=(0,0,PI/4))
  for x in [-1,1]:
   s.cone((x,.6,2.6),.4,.3,4.3,'iron',8)
   s.cone((x,.6,5),.5,0,1.1,color,8)
  arch(s,0,-1.2,.35,.85,1.75,'stone')
  for x in [-.78,.78]:
   s.box((x,-1.18,2.65),(.18,.08,.9),'magic',.015)
   s.box((x,-1.2,2.65),(.04,.12,1),'iron',.005)
 else:
  s.box((0,0,1.4),(3.15,2.5,2.1),'woodLight',.05)
  s.roof((0,0,2.48),3.7,3.2,1.65,color)
  for x in [-1.5,0,1.5]:s.box((x,-1.28,1.4),(.14,.14,2.1),'wood',.02)
  for z in [.5,1.6,2.45]:s.box((0,-1.29,z),(3.15,.13,.12),'wood',.02)
  s.box((1,1,3),(.55,.6,2),'stoneDark',.04)
  s.box((1,1,4.05),(.7,.75,.18),'edge',.03)
  arch(s,0,-1.33,.33,.85,1.45,'wood')
  for x in [-1,1]:s.box((x,-1.32,1.6),(.5,.08,.65),'window',.035)
  s.box((-1.6,-1.7,.65),(.7,.5,.6),'wood',.04)
  for x in [-1.8,-1.5]:s.sphere((x,-1.7,1.03),(.12,.12,.18),color,12,8)
 # Dressed stone courses, corner quoins and roof seams.
 if index in [0,1,3]:
  width,depth,top=([2.9,2.3,3.05] if index==0 else [2.8,2.7,3.32] if index==1 else [2.25,2.3,3.62])
  for course in range(1,9):
   z=.35+course*(top-.35)/9
   s.box((0,-depth/2-.012,z),(width,.018,.022),'stoneDark',.004)
   for side in [-1,1]:
    s.box((side*(width/2+.012),0,z),(.018,depth,.022),'stoneDark',.004)
    for joint in [-.65,0,.65]:
     y=joint+(course%2)*.25
     s.box((side*(width/2+.015),y,z-.13),(.022,.018,.26),'stoneDark',.003)
  for side in [-1,1]:
   for course in range(8):
    s.box((side*(width/2-.11),-depth/2-.055,.56+course*.34),(.24,.13,.30),'stoneLight' if index!=3 else 'stone',.025)
 if index==0:
  for tier in range(6):
   f=tier/6
   s.cone((0,0,3.04+f*1.48),2.19*(1-f),2.19*(1-f)-.035,.065,color,4,rot=(0,0,PI/4))
 if index==2:
  for z in [.9,1.8,2.25,2.9]:s.torus((0,0,z),1.555,.018,'stoneDark',48)
 # Bands and the provider's hanging pennant.
 if index<4:
  for x in [-.95,.95]:
   lantern(s,x,-1.65,1.4)
  for y in [-.75,0,.75]:
   if index!=2:s.box((-1.48,y,1.3),(.12,.08,1.6),'stoneDark',.02)
 s.box((.86,-1.43,2.48),(.45,.065,.75),color,.015)
 s.box((.86,-1.47,2.83),(.6,.09,.065),'gold',.02)
 s.add([(-.16,0,0),(.16,0,0),(0,0,-.2)],[(0,1,2)],color,pos=(.86,-1.48,2.08))
 s.torus((.86,-1.49,2.48),.10,.025,'gold',12,rot=(PI/2,0,0))
 return s

def other_hall(index,skin):
 s=Sculpt();color=['amber','emerald','blue','cyan','violet'][index]
 if skin=='orbital':
  s.cone((0,0,.25),2.3,2.3,.35,'orbitalBase',8)
  s.box((0,0,1.2),(2.8,2.4,1.7),'orbitalPanel',.18)
  for x in [-1.3,1.3]:
   s.box((x,0,1.45),(.25,2.5,2.15),'orbitalEdge',.08)
   s.box((x,-1.26,1.45),(.15,.06,1.75),'magic',.015)
  s.box((0,-1.24,1.25),(1.8,.08,.6),'glass',.035)
  s.box((0,-1.30,.95),(1.9,.04,.055),color,.01)
  if index%2==0:
   s.sphere((0,0,2.1),(1.45,1.25,.85),'glass',24,10)
   s.torus((0,0,2.12),1.3,.08,'orbitalEdge',32)
  else:
   s.cone((0,0,2.7),.85,.65,1.7,'orbitalBase',8)
   for z in [2,2.5,3]:s.torus((0,0,z),.84,.06,color,24)
  if index==2:
   s.cone((0,0,3.8),.08,.08,1.2,'orbitalEdge',8)
   s.sphere((0,0,4.4),(.95,.65,.15),'white',24,8)
 elif skin=='grove':
  s.cone((0,0,.25),2.3,2.2,.4,'groveWood',16)
  s.cone((0,0,1.7),1.25,1.05,2.7,'bark',14)
  for i in range(12):
   a=i*PI/6;s.cone((1.2*math.cos(a),1.2*math.sin(a),1.5),.1,.08,2.5,'woodLight',7)
  arch(s,0,-1.22,.45,.9,1.55,'groveWood')
  for h,r in [(3,2.1),(3.65,1.6),(4.15,1.0)]:
   s.cone((0,0,h),r,.12,.95,'groveLeaf' if index%2 else 'leaf',12)
   s.torus((0,0,h-.4),r*.92,.045,'woodLight',24)
  s.sphere((0,-1.27,2.8),(.19,.08,.19),color,12,8)
  for x in [-1.6,1.6]:
   s.cone((x,-.3,.48),.06,.05,.8,'woodLight',8);s.sphere((x,-.3,.95),(.48,.42,.2),color,16,8)
 else:
  s.box((0,0,.25),(4,3.3,.35),'white',.05)
  s.box((0,0,1.3),(2.8,2.4,1.8),'office',.055)
  for x in [-1.1,0,1.1]:s.box((x,-1.22,1.4),(.9,.05,1.2),'officeGlass',.02)
  s.box((0,0,2.27),(3.15,2.75,.17),'white',.02)
  s.box((0,-1.32,2.3),(2.8,.07,.10),color,.01)
  s.box((.6,.1,3.0),(1.4,1.8,1.4),'officeGlass',.05)
  s.box((.6,.1,3.74),(1.6,2,.14),'white',.02)
 return s

def environment(skin):
 clear();random.seed(714)
 s=Sculpt()
 if skin in PLATED:
  bpy.context.collection.objects.link(bpy.data.objects.new('courtyard',None))
 else:
  floor_world(s,skin);s.object('courtyard')
 for i,(id,x,y) in enumerate([('anthropic',-7,5),('openai',0,7),('google',7,5),('xai',-8,-3),('shell',8,-3)]):
  sculpt=guild_hall(i) if skin=='guild' else other_hall(i,skin)
  obj=sculpt.object('hall_'+id);obj.location=(x,y,0)
 export(skin,save=skin=='guild')

def armature():
 data=bpy.data.armatures.new('GuildRig');rig=bpy.data.objects.new('GuildRig',data);bpy.context.collection.objects.link(rig)
 bpy.context.view_layer.objects.active=rig;rig.select_set(True);bpy.ops.object.mode_set(mode='EDIT')
 bones={
  'root':((0,0,0),(0,0,.3),None),
  'body':((0,0,.85),(0,0,1.45),'root'),
  'head':((0,0,1.45),(0,0,1.85),'body'),
  'armL':((.36,0,1.38),(.51,0,.87),'body'),
  'armR':((-.36,0,1.38),(-.51,0,.87),'body'),
  'legL':((.16,0,.8),(.16,0,.16),'root'),
  'legR':((-.16,0,.8),(-.16,0,.16),'root'),
 }
 for name,(a,b,parent) in bones.items():
  bone=data.edit_bones.new(name);bone.head=a;bone.tail=b
  if parent:bone.parent=data.edit_bones[parent]
 bpy.ops.object.mode_set(mode='OBJECT');return rig
def animate(rig):
 for pose in ['resting','working','waiting','done','arrival']:
  action=bpy.data.actions.new(pose);action.use_fake_user=True
  rig.animation_data_create();rig.animation_data.action=action
  for f in range(0,73,6):
   t=f/72*2*PI
   for b in rig.pose.bones:b.rotation_mode='XYZ';b.rotation_euler=(0,0,0);b.location=(0,0,0);b.scale=(1,1,1)
   root=rig.pose.bones['root'];body=rig.pose.bones['body'];head=rig.pose.bones['head']
   root.location.z=.018*math.sin(t)
   body.rotation_euler.y=.025*math.sin(t)
   head.rotation_euler.y=.035*math.cos(t)
   rig.pose.bones['armL'].rotation_euler.x=.03*math.sin(t)
   rig.pose.bones['armR'].rotation_euler.x=-.03*math.sin(t)
   if pose=='working':
    body.rotation_euler.x=.10+.05*math.sin(t*2)
    rig.pose.bones['armL'].rotation_euler.x=-.75+.22*math.sin(t*2)
    rig.pose.bones['armL'].rotation_euler.z=-.30
    rig.pose.bones['armR'].rotation_euler.x=-.60-.22*math.sin(t*2)
    rig.pose.bones['armR'].rotation_euler.z=.30
    head.rotation_euler.x=.15
   elif pose=='waiting':
    head.rotation_euler.y=.16*math.sin(t/2)
    rig.pose.bones['armL'].rotation_euler.x=-.3
   elif pose=='done':
    body.rotation_euler.x=.12;head.rotation_euler.x=.14
   elif pose=='arrival':
    root.scale=(min(1,.05+f/18),)*3
   for b in rig.pose.bones:
    b.keyframe_insert(data_path='location',frame=f,group=b.name)
    b.keyframe_insert(data_path='rotation_euler',frame=f,group=b.name)
    b.keyframe_insert(data_path='scale',frame=f,group=b.name)
 rig.animation_data.action=None
 for b in rig.pose.bones:b.rotation_euler=(0,0,0);b.location=(0,0,0);b.scale=(1,1,1)
def hero(index,skin='guild'):
 clear();s=Sculpt();color=['amber','emerald','blue','cyan','violet'][index]
 robot=skin=='orbital';spirit=skin=='grove';wraith=index==4 and not robot
 main='orbitalPanel' if robot else 'groveWood' if spirit else color
 # Boots, trousers, coat and shaped shoulder silhouette.
 for side,bone in [(1,'legL'),(-1,'legR')]:
  s.box((side*.16,-.1,.13),(.24,.40,.22),'iron' if not spirit else 'bark',.07,bone=bone)
  s.cone((side*.16,0,.53),.115,.14,.67,main,12,bone=bone)
 s.cone((0,0,.91),.34,.27,.47,main,16,bone='body')
 s.sphere((0,0,1.25),(.36,.24,.38),main,20,12,bone='body')
 s.box((0,-.21,1.11),(.50,.10,.13),'gold',.03,bone='body')
 for side,bone in [(1,'armL'),(-1,'armR')]:
  s.sphere((side*.36,0,1.38),(.20,.22,.18),'iron' if index==1 or robot else main,16,9,bone=bone)
  s.cone((side*.45,0,1.12),.13,.16,.48,main,12,bone=bone,rot=(0,-side*.18,0))
  s.torus((side*.5,0,.91),.12,.025,'gold',16,bone=bone)
  s.sphere((side*.5,-.01,.86),(.11,.105,.14),'orbitalEdge' if robot else 'bark' if spirit else 'skin',14,8,bone=bone)
 # Head, face and hood/helm
 if index==1 or robot:
  s.sphere((0,0,1.72),(.245,.21,.29),'iron' if not robot else 'orbitalEdge',20,12,bone='head')
  s.box((0,-.201,1.77),(.34,.035,.063),'magic',.018,bone='head')
  s.box((0,-.21,1.59),(.09,.04,.18),'gold',.025,bone='head')
  for side in [-1,1]:s.box((side*.17,-.18,1.68),(.055,.08,.22),color,.018,bone='head')
 else:
  s.sphere((0,.015,1.71),(.28,.26,.33),color if not spirit else 'leaf',20,12,bone='head')
  s.sphere((0,-.162,1.7),(.185,.11,.225),'black' if wraith else 'skin' if not spirit else 'woodLight',18,12,bone='head')
  if not wraith:
   for side in [-1,1]:
    s.sphere((side*.074,-.261,1.75),(.026,.018,.025),'black',10,6,bone='head')
    s.box((side*.074,-.265,1.806),(.069,.023,.021),'hair',.005,bone='head')
   s.sphere((0,-.27,1.69),(.032,.027,.06),'skin',10,6,bone='head')
   if index==0:s.cone((0,-.19,1.48),.06,.15,.28,'cloth',12,bone='head')
  else:
   for side in [-1,1]:s.box((.025,-.282,1.71+side*.055),(.16,.018,.032),'magic',.008,rot=(0,side*-.62,0),bone='head')
 # Cape as tailored panels, not an ungrounded card portrait.
 for i in range(9):
  a=(i-4)*.13;x=math.sin(a)*.43;y=.12+math.cos(a)*.12
  s.cone((x,y,.98),.11,.05,.9,main,6,bone='body',rot=(0,-a*.2,0))
 if index in [0,2,4] and not robot:
  s.cone((0,0,.58),.46,.29,.74,main,18,bone='body')
  for a in range(12):
   t=a*2*PI/12;s.box((.37*math.cos(t),.37*math.sin(t),.49),(.022,.022,.48),'gold',.008,bone='body')
 if index==0:
  s.cone((-.61,0,1.12),.035,.035,1.95,'wood',12,bone='armR')
  s.sphere((-.61,0,2.14),(.14,.14,.18),'window',16,10,bone='armR')
  s.torus((-.61,0,2.14),.20,.025,'gold',20,rot=(PI/2,0,0),bone='armR')
 elif index==1:
  s.box((-.49,-.08,.55),(.12,.06,.8),'orbitalEdge',.025,bone='armR')
  s.box((-.49,-.08,.97),(.42,.09,.065),'gold',.025,bone='armR')
 elif index==2:
  s.box((.5,-.12,.96),(.28,.18,.1),'blue',.035,bone='armL')
  s.box((.5,-.12,1.02),(.25,.16,.035),'cloth',.005,bone='armL')
 elif index==3:
  s.cone((-.52,0,.56),.065,0,.6,'orbitalEdge',4,bone='armR')
 s.torus((0,-.25,1.34),.075,.024,'gold',16,rot=(PI/2,0,0),bone='body')
 mesh=s.object('character');rig=armature();s.bind(mesh,rig);animate(rig)
 export(('robot_' if robot else 'spirit_' if spirit else 'hero_')+str(index),save=skin=='guild')
def familiar(index,robot=False):
 clear();s=Sculpt();color=['amber','emerald','violet','blue'][index]
 s.sphere((0,0,1.05),(.36,.25,.3),'orbitalPanel' if robot else color,20,12,bone='body')
 s.sphere((0,-.17,1.28),(.3,.2,.23),color,18,10,bone='head')
 for side in [-1,1]:
  s.sphere((side*.105,-.34,1.31),(.055,.032,.055),'window',12,8,bone='head')
  s.sphere((side*.11,-.363,1.32),(.022,.014,.028),'black',10,6,bone='head')
  if robot:
   s.torus((side*.42,0,1.18),.18,.055,'orbitalEdge',16,bone='armL' if side==1 else 'armR')
  else:
   s.sphere((side*.39,.02,1.32),(.3,.07,.16),'cloth' if index==0 else 'leafLight' if index==1 else 'magic',16,8,bone='armL' if side==1 else 'armR')
   s.cone((side*.17,0,1.58),.09,0,.25,color,10,bone='head')
 s.cone((0,.26,.94),.16,0,.55,color,12,bone='body',rot=(PI/3,0,0))
 mesh=s.object('familiar');rig=armature();s.bind(mesh,rig);animate(rig)
 export(('drone_' if robot else 'familiar_')+str(index))
for skin in ['guild','orbital','grove','professional']:
 if ONLY is None or skin in ONLY:environment(skin)
if ONLY is not None:
 print('Guild worlds rebuilt:',','.join(ONLY),flush=True);sys.exit(0)
for skin in ['guild','orbital','grove']:
 for i in range(5):hero(i,skin)
for i in range(4):familiar(i);familiar(i,True)
manifest={'version':1,'seed':714,'worlds':['guild','orbital','grove','professional'],'heroes':5,'familiars':4,'clips':['resting','working','waiting','done','arrival'],'up':'Y','units':'metres','source':'concept-art/guild-yard/build.py'}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
print('Guild art set complete',flush=True)
