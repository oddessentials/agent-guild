import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { sessionPose, familiarPose, layoutSessions, providerPositions, WORLDS, CAMERA, SUN, minZoom, clampPan, viewBasis, plateExtent } from '../web/yard/model.mjs';
import { Matrix4, Vector3 } from 'three';
const providers=['anthropic','openai','google','xai','shell'].map(id=>({id}));
const session=(id,provider='anthropic')=>({id,provider:{id:provider},createdAt:'2026-01-01T00:00:00Z'});

test('visual poses preserve running/quiet vs exited and reported helper states',()=>{
 assert.equal(sessionPose({status:'running',activity:'active'}),'working');
 assert.equal(sessionPose({status:'running',activity:'quiet'}),'resting');
 assert.equal(sessionPose({status:'exited',activity:'active'}),'exited');
 for(const status of ['working','waiting','idle','done'])assert.equal(familiarPose({status}),status);
 assert.equal(familiarPose({status:'unknown'}),'idle');
});
test('all sessions remain addressable beyond the prototype limit and retain their slots',()=>{
 const sessions=Array.from({length:40},(_,i)=>session('s'+i));
 const first=layoutSessions(sessions,providers);
 assert.equal(first.size,40);
 assert.equal(new Set([...first.values()].map(p=>p.x+','+p.z)).size,40);
 const second=layoutSessions(sessions.filter(s=>s.id!=='s11'),providers,first);
 for(const [id,p]of second)assert.deepEqual(p,first.get(id));
 const added=layoutSessions([...sessions.filter(s=>s.id!=='s11'),session('new')],providers,second);
 assert.equal(added.get('new').slot,first.get('s11').slot);
});
test('custom providers and non-provider task sessions have distinct stable placements',()=>{
 const custom=Array.from({length:18},(_,i)=>({id:'custom-'+i}));
 const anchors=providerPositions([...providers,...custom]);
 assert.equal(new Set([...anchors.values()].map(p=>p.x+','+p.z)).size,23);
 const slots=layoutSessions([session('clone','github'),session('upgrade','agent-guild'),session('custom','custom-12')],[...providers,...custom]);
 assert.notDeepEqual(slots.get('clone'),slots.get('upgrade'));
 assert.equal(slots.get('custom').group,'custom-12');
});
test('view restores before paint, tolerates blocked storage, and defaults to Cards',()=>{
 const source=readFileSync(new URL('../web/theme.js',import.meta.url),'utf8');
 for(const value of [null,'yard','invalid']){
  const document={documentElement:{dataset:{}}};
  runInNewContext(source,{document,window:{matchMedia:()=>({matches:true})},localStorage:{getItem:key=>key==='agentGuild.view'?value:null}});
  assert.equal(document.documentElement.dataset.view,value==='yard'?'yard':'cards');
 }
 const document={documentElement:{dataset:{}}};
 runInNewContext(source,{document,window:{matchMedia:()=>({matches:false})},localStorage:{getItem:()=>{throw new Error('blocked');}}});
 assert.equal(document.documentElement.dataset.view,'cards');
});
test('every skin has a yard world',()=>{
 const source=readFileSync(new URL('../web/theme.js',import.meta.url),'utf8');
 const window={matchMedia:()=>({matches:false})};
 runInNewContext(source,{document:{documentElement:{dataset:{}}},window,localStorage:{getItem:()=>null}});
 const skins=JSON.parse(JSON.stringify(window.agentGuildSkins.map(skin=>skin.id).sort()));
 assert.deepEqual(Object.keys(WORLDS).sort(),skins);
});
function glb(name){
 const bytes=readFileSync(new URL('../web/yard/assets/'+name+'.glb',import.meta.url));
 assert.equal(bytes.toString('ascii',0,4),'glTF');
 assert.equal(bytes.readUInt32LE(8),bytes.length);
 return JSON.parse(bytes.toString('utf8',20,20+bytes.readUInt32LE(12)));
}
test('each skin has a distinct authored world with named provider anchors',()=>{
 for(const [skin,world]of Object.entries(WORLDS)){
  const asset=glb(world.asset);
  for(const {id}of providers)assert.ok(asset.nodes.some(n=>n.name==='hall_'+id),skin+' '+id);
 }
 assert.equal(WORLDS.professional.characters,false);
 assert.equal(WORLDS.professional.helpers,false);
});
test('the shipped characters and helpers have actual skinning and usable animation tracks',()=>{
 const counts=new Map();
 for(const world of Object.values(WORLDS)){
  if(world.characters)counts.set(world.characters,5);
  if(world.helpers)for(const prefix of Object.values(world.helpers))counts.set(prefix,4);
 }
 for(const [prefix,count] of counts){
  for(let i=0;i<count;i++){
   const asset=glb(prefix+i);
   assert.ok(asset.skins?.length);
   for(const name of ['resting','working','waiting','done','arrival']){
    const clip=asset.animations.find(a=>a.name===name);assert.ok(clip,prefix+i+' '+name);
    assert.ok(clip.channels.length>0);
    assert.ok(clip.samplers.every(s=>asset.accessors[s.input].count>1));
   }
  }
 }
});
test('the view basis matches the camera, and no permitted view sees past the plates',()=>{
 const m=new Matrix4().lookAt(new Vector3(...CAMERA.offset),new Vector3(),new Vector3(0,1,0));
 const {right,up}=viewBasis(),x=new Vector3(),y=new Vector3(),z=new Vector3();m.extractBasis(x,y,z);
 for(const [a,b] of [[right,x],[up,y]])a.forEach((v,i)=>assert.ok(Math.abs(v-b.getComponent(i))<1e-9));
 const extent=plateExtent(),dot=(p,v)=>p[0]*v[0]+p[1]*v[1]+p[2]*v[2];
 for(const aspect of [390/844,1,4/3,16/9,21/9,32/9,4,5.5])for(const zoom of [minZoom(aspect),1,CAMERA.zoom.max]){
  for(const [px,pz] of [[-99,-99],[99,99],[-99,99],[99,-99],[0,0]]){
   const {x:tx,z:tz}=clampPan({x:px,z:pz}),t=[tx,CAMERA.target[1],tz];
   const halfH=CAMERA.height/2/zoom,halfW=halfH*aspect,cx=dot(t,right),cy=dot(t,up);
   assert.ok(cx-halfW>=extent.right[0]-1e-9&&cx+halfW<=extent.right[1]+1e-9,`width at ${aspect} x${zoom}`);
   assert.ok(cy-halfH>=extent.up[0]-1e-9&&cy+halfH<=extent.up[1]+1e-9,`height at ${aspect} x${zoom}`);
  }
 }
 assert.ok(minZoom(32/9)===CAMERA.zoom.min&&minZoom(8)>CAMERA.zoom.min);
});
// WebP stores its canvas size in the VP8X chunk (24-bit width-1, height-1).
function webpSize(bytes){
 assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.toString('ascii',8,12),'WEBP');
 const chunk=bytes.toString('ascii',12,16);
 if(chunk==='VP8X')return [1+bytes.readUIntLE(24,3),1+bytes.readUIntLE(27,3)];
 if(chunk==='VP8 ')return [bytes.readUInt16LE(26)&0x3fff,bytes.readUInt16LE(28)&0x3fff];
 if(chunk==='VP8L'){const b=bytes.readUInt32LE(21);return [(b&0x3fff)+1,((b>>14)&0x3fff)+1];}
 throw new Error('Unknown WebP chunk '+chunk);
}
const MiB=1048576;
test('every world\'s plates match the live camera, cover every view, and stay within budget',()=>{
 const assets=new URL('../web/yard/assets/',import.meta.url);
 for(const [skin,world] of Object.entries(WORLDS)){
  const plates=JSON.parse(readFileSync(new URL(skin+'/plates.json',assets),'utf8'));
  assert.deepEqual(plates.camera,CAMERA,'plates were rendered for the current camera');
  assert.deepEqual(plates.sun,SUN,'plates were rendered for the current suns');
  assert.deepEqual(Object.keys(plates.themes).sort(),['dark','light']);
  // The world model and the textures it references beside it.
  let bytes=statSync(new URL(world.asset+'.glb',assets)).size;
  for(const image of glb(world.asset).images||[])if(image.uri)bytes+=statSync(new URL(image.uri,assets)).size;
  const extent=plateExtent();
  for(const [theme,layers] of Object.entries(plates.themes)){
   for(const layer of layers)for(const tile of layer.tiles){
    const file=readFileSync(new URL(tile.file,assets));bytes+=file.length;
    const [w,h]=webpSize(file);
    assert.deepEqual([w,h],[tile.width,tile.height],tile.file);
    assert.ok(w<=4096&&h<=4096,tile.file+' fits every GPU texture limit');
   }
   const [base]=layers;
   const span=(axis,i)=>i?Math.max(...base.tiles.map(t=>t[axis][1])):Math.min(...base.tiles.map(t=>t[axis][0]));
   assert.ok(span('right',0)<=extent.right[0]&&span('right',1)>=extent.right[1],`${theme} base layer spans every view horizontally`);
   assert.ok(span('up',0)<=extent.up[0]&&span('up',1)>=extent.up[1],`${theme} base layer spans every view vertically`);
  }
  const {sky,surfaces}=JSON.parse(readFileSync(new URL(skin+'/surfaces.json',assets),'utf8'));
  const materials=new Set(glb(world.asset).materials.map(m=>m.name));
  assert.deepEqual(Object.keys(sky).sort(),['dark','light']);
  for(const file of Object.values(sky))bytes+=statSync(new URL(file,assets)).size;
  for(const [name,surface] of Object.entries(surfaces)){
   for(const material of surface.materials)assert.ok(materials.has(material),`${name} textures ${material}, which ${world.asset}.glb must contain`);
   for(const key of ['color','normal','rough'])bytes+=readFileSync(new URL(surface[key],assets)).length;
  }
  assert.ok(bytes<=21*MiB,`${skin} world is ${(bytes/MiB).toFixed(2)} MiB`);
 }
});
