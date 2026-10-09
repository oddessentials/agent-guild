"""Authored hall models for the Guild and Professional yards.
Run: blender --background --factory-startup --python concept-art/guild-yard/build.py
Rebuild only some worlds: ... build.py -- --only guild
Coordinates are metres; Blender Z-up exports to glTF Y-up. No downloaded models.
"""
import bpy, math, json, sys
from pathlib import Path
from mathutils import Matrix, Vector, Euler
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'web/yard/assets'
SOURCE = Path(__file__).resolve().parent
OUT.mkdir(parents=True,exist_ok=True)
PI=math.pi
ARGS=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
ONLY=ARGS[ARGS.index('--only')+1].split(',') if '--only' in ARGS else None
PALETTE={
 'stone':'777966','stoneLight':'a2a08b','stoneDark':'434b42','edge':'bcb08b','leaf':'447653',
 'wood':'624735','woodLight':'98704a','gold':'bb914a','iron':'28353b',
 'amber':'b86930','emerald':'295947','blue':'345777','cyan':'2b6976','violet':'614778','docker':'2496ed','crimson':'8a1f2b',
 'window':'ffb35a','magic':'83d8d0','white':'c4d0c5',
 'office':'c4c8bf','officeDark':'6c7d80','officeGlass':'5a8994','steel':'a2b9c1'
}
M={}
def clear():
 bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
 for m in list(bpy.data.meshes):
  if m.users==0: bpy.data.meshes.remove(m)
def mat(name):
 if name in M:return M[name]
 h=PALETTE.get(name,name.lstrip('#'));rgb=[int(h[i:i+2],16)/255 for i in (0,2,4)]
 m=bpy.data.materials.new(name);m.diffuse_color=(*rgb,1);m.use_nodes=True
 bs=m.node_tree.nodes.get('Principled BSDF')
 bs.inputs['Base Color'].default_value=(*(v**2.2 for v in rgb),1)
 bs.inputs['Roughness'].default_value=.08 if name=='officeGlass' else .7 if name not in ['gold','iron'] else .33
 bs.inputs['Metallic'].default_value=.7 if name in ['gold','iron','steel','officeGlass'] else .05
 if name in ['window','magic']:
  bs.inputs['Emission Color'].default_value=(*(v**2.2 for v in rgb),1);bs.inputs['Emission Strength'].default_value=1.6
 M[name]=m;return m

class Sculpt:
 def __init__(self):self.v=[];self.f=[];self.m=[];self.smooth=[]
 def add(self,verts,faces,material,pos=(0,0,0),scale=(1,1,1),rot=(0,0,0),smooth=False):
  transform=Matrix.Translation(Vector(pos))@Euler(rot).to_matrix().to_4x4()@Matrix.Diagonal(Vector((*scale,1)))
  start=len(self.v);self.v.extend([tuple(transform@Vector(v)) for v in verts])
  self.f.extend([tuple(start+i for i in f) for f in faces]);self.m.extend([material]*len(faces));self.smooth.extend([smooth]*len(faces))
 def box(self,pos,size,material,bevel=.035,rot=(0,0,0)):
  x,y,z=[n/2 for n in size];b=min(bevel,x*.4,y*.4,z*.4)
  ring=[(-x+b,-y),(x-b,-y),(x,-y+b),(x,y-b),(x-b,y),(-x+b,y),(-x,y-b),(-x,-y+b)]
  verts=[]
  for h,inset in [(-z,b),(-z+b,0),(z-b,0),(z,b)]:
   verts.extend([(a*(1-inset/max(x,.01)),c*(1-inset/max(y,.01)),h) for a,c in ring])
  faces=[tuple(range(7,-1,-1)),tuple(range(24,32))]
  for j in range(3):
   for i in range(8):faces.append((j*8+i,j*8+(i+1)%8,(j+1)*8+(i+1)%8,(j+1)*8+i))
  self.add(verts,faces,material,pos=pos,rot=rot)
 def cone(self,pos,r1,r2,height,material,n=16,rot=(0,0,0)):
  verts=[(r*math.cos(i*2*PI/n),r*math.sin(i*2*PI/n),z) for z,r in [(-height/2,r1),(height/2,r2)] for i in range(n)]
  faces=[tuple(range(n-1,-1,-1)),tuple(range(n,2*n))]
  faces.extend([(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)])
  self.add(verts,faces,material,pos=pos,rot=rot,smooth=True)
 def sphere(self,pos,size,material,n=16,rings=10):
  verts=[(math.sin(j*PI/rings)*math.cos(i*2*PI/n),math.sin(j*PI/rings)*math.sin(i*2*PI/n),math.cos(j*PI/rings)) for j in range(rings+1) for i in range(n)]
  faces=[(j*n+i,j*n+(i+1)%n,(j+1)*n+(i+1)%n,(j+1)*n+i) for j in range(rings) for i in range(n)]
  self.add(verts,faces,material,pos=pos,scale=size,smooth=True)
 def torus(self,pos,r,t,material,n=32,rot=(0,0,0)):
  verts=[((r+t*math.cos(j*2*PI/6))*math.cos(i*2*PI/n),(r+t*math.cos(j*2*PI/6))*math.sin(i*2*PI/n),t*math.sin(j*2*PI/6)) for i in range(n) for j in range(6)]
  faces=[(i*6+j,((i+1)%n)*6+j,((i+1)%n)*6+(j+1)%6,i*6+(j+1)%6) for i in range(n) for j in range(6)]
  self.add(verts,faces,material,pos=pos,rot=rot,smooth=True)
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
def guild_hall(index):
 s=Sculpt();color=['amber','emerald','blue','cyan','violet','docker'][index]
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
 elif index==4:
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
 else:
  # Harbour warehouse: a broad stone store under an azure roof, a timber jib crane and crimson cargo.
  s.box((0,0,1.7),(3.4,2.6,2.8),'stone',.08)
  s.roof((0,0,3.1),3.75,2.95,1.45,color)
  arch(s,0,-1.33,.36,1.05,1.75)
  for x in [-1.1,1.1]:s.box((x,-1.32,2.2),(.42,.07,.6),'window',.03)
  s.box((1.72,.2,2.0),(.07,1.2,.55),'window',.02)
  s.box((1.4,.95,3.6),(.24,.24,4.4),'wood',.03)
  s.box((1.4,-.35,5.6),(.2,2.8,.2),'wood',.03)
  s.box((1.4,.3,5.0),(.12,.12,1.4),'wood',.02,rot=(-PI/4,0,0))
  s.box((1.4,-1.65,4.75),(.035,.035,1.55),'woodLight',.01)
  s.torus((1.4,-1.65,3.85),.16,.04,'iron',16,rot=(0,PI/2,0))
  s.box((1.4,-1.65,3.62),(.4,.3,.35),'crimson',.03)
  for x,y,z in [(-1.75,-1.75,.62),(-1.15,-1.8,.62),(-1.5,-1.72,1.2)]:
   s.box((x,y,z),(.56,.5,.52),'crimson',.03)
   for dz in [-.18,.18]:s.box((x,y,z+dz),(.6,.54,.05),'iron',.01)
  # The anchor over the door.
  s.box((0,-1.36,3.05),(.08,.06,.75),'gold',.015)
  s.box((0,-1.36,3.35),(.42,.06,.07),'gold',.015)
  for side in [-1,1]:s.box((side*.17,-1.36,2.75),(.32,.06,.07),'gold',.015,rot=(0,side*.6,0))
  s.torus((0,-1.37,3.5),.08,.02,'gold',12,rot=(PI/2,0,0))
 # Dressed stone courses, corner quoins and roof seams.
 if index in [0,1,3,5]:
  width,depth,top=([2.9,2.3,3.05] if index==0 else [2.8,2.7,3.32] if index==1 else [3.4,2.6,3.1] if index==5 else [2.25,2.3,3.62])
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
 if index!=4:
  for x in [-.95,.95]:
   lantern(s,x,-1.65,1.4)
 if index<4:
  for y in [-.75,0,.75]:
   if index!=2:s.box((-1.48,y,1.3),(.12,.08,1.6),'stoneDark',.02)
 s.box((.86,-1.43,2.48),(.45,.065,.75),color,.015)
 s.box((.86,-1.47,2.83),(.6,.09,.065),'gold',.02)
 s.add([(-.16,0,0),(.16,0,0),(0,0,-.2)],[(0,1,2)],color,pos=(.86,-1.48,2.08))
 s.torus((.86,-1.49,2.48),.10,.025,'gold',12,rot=(PI/2,0,0))
 return s

def glazing(s,x,y,z,width,height,mullions,face='front'):
 # A glass wall a few centimetres proud of its face, with white mullions.
 # face: 'front' faces the camera (-Y), 'side' the right (+X).
 if face=='front':
  s.box((x,y,z),(width,.05,height),'officeGlass',.01)
  for i in range(mullions+1):s.box((x-width/2+i*width/mullions,y-.03,z),(.05,.05,height),'white',.008)
  s.box((x,y-.03,z+height/2),(width,.06,.06),'white',.008)
 else:
  s.box((x,y,z),(.05,width,height),'officeGlass',.01)
  for i in range(mullions+1):s.box((x+.03,y-width/2+i*width/mullions,z),(.05,.05,height),'white',.008)

def campus_hall(index):
 s=Sculpt();color=['amber','emerald','blue','cyan','violet','docker'][index]
 # Each stands on a granite plinth with steps to its entrance, facing the camera.
 s.box((0,0,.12),(4.9,4.3,.24),'officeDark',.03)
 for i in range(2):s.box((0,-2.3-i*.22,.1-i*.05),(1.8,.4,.12),'officeDark',.02)
 if index==0:
  # Studio: a glazed ground floor, a set-back upper storey behind timber fins, a roof terrace.
  s.box((0,.1,1.25),(4.4,3.6,2.0),'office',.03)
  glazing(s,-.2,-1.73,1.15,3.4,1.6,6)
  glazing(s,2.23,.1,1.15,2.6,1.6,4,'side')
  s.box((0,.1,2.32),(4.6,3.8,.16),'white',.02)
  s.box((-.3,.5,3.25),(3.4,2.8,1.7),'office',.03)
  glazing(s,-.3,-.93,3.2,3.1,1.4,5)
  for i in range(14):s.box((-1.9+i*.25,-1.02,3.25),(.07,.14,1.75),'woodLight',.01)
  s.box((-.3,.5,4.17),(3.6,3.0,.14),'white',.02)
  s.box((1.55,-.6,2.55),(1.1,1.4,.3),'leaf',.08)
  s.box((-.2,-2.05,2.05),(1.6,.8,.1),color,.02)
  s.box((1.9,-1.8,1.55),(.12,.12,2.6),color,.01)
 elif index==1:
  # Rotunda: a glass drum under a wide disc canopy on slim columns.
  s.cone((0,.1,.36),2.05,2.05,.24,'white',48)
  s.cone((0,.1,1.55),1.75,1.75,2.2,'officeGlass',48)
  for i in range(24):
   a=i*2*PI/24;s.box((1.78*math.cos(a),.1+1.78*math.sin(a),1.55),(.06,.06,2.2),'white',.01,rot=(0,0,a))
  for i in range(12):
   a=i*2*PI/12+PI/12;s.cone((2.15*math.cos(a),.1+2.15*math.sin(a),1.6),.07,.07,2.5,'white',10)
  s.cone((0,.1,2.95),2.45,2.45,.26,'white',64)
  s.cone((0,.1,2.78),2.42,2.42,.1,color,64)
  s.cone((0,.1,3.6),1.1,1.1,1.05,'office',32)
  s.cone((0,.1,4.16),1.2,1.2,.1,'white',32)
  s.cone((0,.1,4.35),.75,.2,.3,'officeGlass',24)
  for x in [-.35,.35]:s.box((x,-1.68,1.25),(.66,.04,1.6),'window',.01)
 elif index==2:
  # Stack: three glazed volumes, each turned and cantilevered off the one below.
  for k,(w,d,z,dx,turn) in enumerate([(4.2,3.2,.95,0,0),(3.7,2.7,2.45,.45,.2),(3.1,2.3,3.9,-.4,-.14)]):
   rot=(0,0,turn)
   s.box((dx,.15,z),(w,d,1.42),'office',.03,rot=rot)
   c,sn=math.cos(turn),math.sin(turn)
   s.box((dx+(d/2+.02)*sn,.15-(d/2+.02)*c,z),(w-.3,.05,.9),'officeGlass',.01,rot=rot)
   s.box((dx+(d/2+.04)*sn,.15-(d/2+.04)*c,z+.6),(w,.08,.14),color if k==1 else 'white',.01,rot=rot)
  s.box((-.4,.15,4.68),(3.3,2.5,.12),'white',.02,rot=(0,0,-.14))
  s.box((1.6,-1.2,.85),(.12,.12,1.2),'white',.01)
 elif index==3:
  # Tower: a slender dark stone shaft with tall glass slots and a sloped crown, beside a low wing.
  s.box((-.6,.3,2.65),(2.4,2.4,4.8),'officeDark',.03)
  for x in [-1.25,-.6,.05]:s.box((x,-.92,2.7),(.34,.05,4.2),'officeGlass',.01)
  for y in [-.35,.3,.95]:s.box((.62,y,2.7),(.05,.34,4.2),'officeGlass',.01)
  s.add([(-1.85,-.95,5.05),(.65,-.95,5.05),(.65,1.55,5.05),(-1.85,1.55,5.05),(-1.85,-.95,5.65),(-1.85,1.55,5.65)],
        [(0,1,4),(1,2,5,4),(2,3,5),(0,4,5,3),(3,2,1,0)],'iron')
  s.box((-.6,-.95,5.0),(2.5,.06,.1),color,.01)
  s.box((1.25,-.3,.95),(2.1,2.9,1.4),'office',.03)
  glazing(s,1.25,-1.77,.95,1.8,1.0,3)
  glazing(s,2.32,-.3,.95,2.6,1.0,4,'side')
  s.box((1.25,-.3,1.7),(2.3,3.1,.12),'white',.02)
  s.box((-.6,-1.6,.95),(1.2,.9,.08),color,.01)
 elif index==4:
  # Hangar: a long glass hall under a barrel vault, with coloured gable ends.
  s.box((0,.1,1.0),(4.6,3.4,1.5),'office',.03)
  glazing(s,0,-1.63,1.0,4.2,1.3,8)
  glazing(s,2.33,.1,1.0,3.0,1.3,5,'side')
  s.cone((0,.1,1.75),1.75,1.75,4.7,'white',32,rot=(0,PI/2,0))
  for x in [-2.36,2.36]:s.cone((x,.1,1.75),1.78,1.78,.08,color,32,rot=(0,PI/2,0))
  for i in range(7):s.torus((-1.8+i*.6,.1,1.75),1.77,.025,'iron',32,rot=(0,PI/2,0))
  s.box((-1.5,-2.05,1.95),(1.0,.7,.08),color,.02)
 else:
  # Depot: a ribbed azure shed with loading bays, shipping containers stacked on its roof.
  s.box((0,.3,1.25),(4.5,3.4,2.0),color,.03)
  for i in range(19):s.box((-2.16+i*.24,-1.42,1.25),(.05,.06,1.9),'steel',.008)
  for x in [-1.4,0,1.4]:
   s.box((x,-1.47,.92),(1.0,.05,1.26),'office',.01)
   for k in range(6):s.box((x,-1.5,.38+k*.21),(1.0,.03,.025),'officeDark',.004)
   s.box((x,-1.5,1.62),(1.12,.08,.1),'crimson',.01)
  glazing(s,2.27,.3,1.25,2.8,1.2,4,'side')
  s.box((0,.3,2.32),(4.7,3.6,.14),'white',.02)
  s.box((0,-1.5,2.0),(3.6,.06,.3),'crimson',.01)
  for x,z,c in [(-1.15,2.95,'crimson'),(1.15,2.95,'white'),(0,4.05,'crimson')]:
   s.box((x,.3,z),(2.1,2.9,1.05),c,.02)
   for k in range(11):s.box((x-1.0+k*.2,-1.17,z),(.04,.05,.95),'officeDark' if c=='white' else 'iron',.006)
 return s

def environment(skin):
 # The ground and surroundings are pre-rendered plates (env/); the glTF carries only the halls.
 clear(); bpy.context.collection.objects.link(bpy.data.objects.new('courtyard',None))
 for i,(id,x,y) in enumerate([('anthropic',-7,5),('openai',0,7),('google',7,5),('xai',-8,-3),('shell',8,-3),('docker',-10,-11)]):
  sculpt=guild_hall(i) if skin=='guild' else campus_hall(i)
  obj=sculpt.object('hall_'+id);obj.location=(x,y,0)
  # Docker Agent arrived as an expansion, and its hall stands larger than the rest.
  if id=='docker':obj.data.transform(Matrix.Scale(1.3,4))
 export(skin,save=skin=='guild')

WORLDS=['guild','professional']
for skin in WORLDS:
 if ONLY is None or skin in ONLY:environment(skin)
if ONLY is not None:
 print('Guild worlds rebuilt:',','.join(ONLY),flush=True);sys.exit(0)
manifest={'version':1,'worlds':WORLDS,'up':'Y','units':'metres','source':'concept-art/guild-yard/build.py'}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
print('Guild art set complete',flush=True)
