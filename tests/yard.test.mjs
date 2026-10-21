import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { sessionPose, familiarPose, layoutSessions, providerPositions, characterIndex, lookLimits, WORLDS, CAMERA, SUN, minZoom, overviewFor, clampPan, viewBasis, plateExtent,
 stage, stagingMode, nextStagingChange, restSpots, route, clipFor, doorFor, stationProp, STAGING, CLIPS, SKELETON, PROVIDER_ORDER } from '../web/yard/model.mjs';
import { goldenVectors } from '../scripts/yard-golden.mjs';
import { Matrix4, Vector3 } from 'three';
const providers=['anthropic','openai','google','xai','shell','docker'].map(id=>({id}));
const session=(id,provider='anthropic')=>({id,provider:{id:provider},createdAt:'2026-01-01T00:00:00Z'});

test('a model narrows its glance with yard.look but never widens it',()=>{
  assert.deepEqual(lookLimits(undefined),{yaw:.7,pitch:.3,neck:.4});
  assert.deepEqual(lookLimits({look:{yaw:.3}}),{yaw:.3,pitch:.3,neck:.4});
  assert.deepEqual(lookLimits({look:{yaw:1.2,pitch:.9}}),{yaw:.7,pitch:.3,neck:.4});
});

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
test('crews behind a front hall start at their right end, the others at their left end',()=>{
 const anchors=providerPositions(providers);
 for(const id of ['anthropic','openai','google','xai','shell','docker']) {
  const slots=layoutSessions([session(id+'-a',id),session(id+'-b',id)],providers);
  const first=slots.get(id+'-a').x-anchors.get(id).x,second=slots.get(id+'-b').x-anchors.get(id).x;
  if(id==='anthropic'||id==='google'||id==='xai')assert.ok(first>0&&second<first,id);
  else assert.ok(first<0&&second>first,id);
 }
 // Docker Agent's hall is 1.3 times the 5.2 m footprint; its crew stands clear of it.
 const docker=layoutSessions([session('d','docker')],providers).get('d');
 assert.ok(docker.z-anchors.get('docker').z>5.2*1.3/2,'Docker crew in front of its hall');
});
test('staging follows only reported state: work, pause, then rest after a quiet spell, and done',()=>{
 const now=Date.parse('2026-10-13T12:00:00Z'),at=ms=>new Date(now-ms).toISOString();
 const s=(status,activity,quiet)=>({status,activity,lastOutputAt:at(quiet),createdAt:at(3600000)});
 assert.equal(stagingMode(s('running','active',60000),now),'work');
 assert.equal(stagingMode(s('running','quiet',STAGING.restAfter-1),now),'pause');
 assert.equal(stagingMode(s('running','quiet',STAGING.restAfter),now),'rest');
 assert.equal(stagingMode(s('exited','active',0),now),'done');
 // A session that reports no output time rests from when it was created.
 assert.equal(stagingMode({status:'running',activity:'quiet',createdAt:at(STAGING.restAfter)},now),'rest');
 const quiet=[{...s('running','quiet',5000),id:'a'},{...s('running','quiet',1000),id:'b'},{...s('running','active',0),id:'c'}];
 assert.equal(nextStagingChange(quiet,now),now-5000+STAGING.restAfter,'the longest-quiet session leaves first');
 assert.equal(nextStagingChange([quiet[2]],now),null);
});
test('resting sessions take distinct plaza spots, keep them, and overflow to their stations',()=>{
 const now=Date.parse('2026-10-13T12:00:00Z'),spots=restSpots(providers);
 const rested=n=>Array.from({length:n},(_,i)=>({...session('r'+String(i).padStart(2,'0'),providers[i%6].id),status:'running',activity:'quiet',lastOutputAt:'2026-10-13T11:00:00Z'}));
 const first=stage(rested(spots.length+3),providers,now);
 const used=[...first.places.values()].filter(p=>p.mode==='rest');
 assert.equal(used.length,spots.length);
 assert.equal(new Set(used.map(p=>p.x+','+p.z)).size,spots.length);
 assert.equal([...first.places.values()].filter(p=>p.mode==='pause').length,3,'overflow waits at its station');
 const fewer=rested(spots.length+3).filter((_,i)=>i!==1);
 const second=stage(fewer,providers,now,first);
 for(const s of fewer)if(first.places.get(s.id).mode==='rest')assert.deepEqual(second.places.get(s.id),first.places.get(s.id),s.id);
 assert.equal([...second.places.values()].filter(p=>p.mode==='rest').length,spots.length,'a freed spot is taken');
});
test('rest spots, doors and routes keep out of the halls and the centrepiece',()=>{
 const custom=[...providers,{id:'custom-1'},{id:'custom-2'}];
 const boxes=[...providerPositions(custom)].map(([id,p])=>({...p,half:id==='docker'?STAGING.hall.docker:STAGING.hall.half}));
 boxes.push({x:STAGING.plaza.x,z:STAGING.plaza.z,half:STAGING.plaza.half});
 const inside=p=>boxes.some(b=>Math.abs(p.x-b.x)<b.half-.06&&Math.abs(p.z-b.z)<b.half-.06);
 assert.ok(restSpots(custom).length>=12);
 for(const spot of restSpots(custom))assert.ok(!inside(spot),JSON.stringify(spot));
 for(const p of custom)assert.ok(!inside(doorFor({provider:{id:p.id}},custom)),p.id);
 const points=[];for(let x=-14;x<=14;x+=3.5)for(let z=-12;z<=18;z+=3.5)if(!inside({x,z}))points.push({x,z});
 for(const a of points)for(const b of points){
  const path=route(a,b,custom);
  assert.deepEqual(path.at(-1),b);
  let from=a;
  for(const to of path){for(let t=0;t<=1;t+=.02)assert.ok(!inside({x:from.x+(to.x-from.x)*t,z:from.z+(to.z-from.z)*t}),JSON.stringify([a,b,path]));from=to;}
 }
});
test('station props face their characters, who never turn their backs to the camera, and walkers keep round them',()=>{
 const camera=Math.atan2(CAMERA.offset[0],CAMERA.offset[2]),turn=a=>Math.abs(Math.atan2(Math.sin(a),Math.cos(a)));
 const slots=[...layoutSessions(Array.from({length:12},(_,i)=>session('s'+i,providers[i%6].id)),providers).entries()];
 const props=slots.map(([id,p])=>stationProp(p,id));
 assert.deepEqual(new Set(props.map(p=>p.arrangement)),new Set(['counter','left','right']));
 for(const [i,[,p]] of slots.entries()){
  const prop=props[i];
  assert.ok(turn(prop.characterFace-camera)<Math.PI/2,'facing the camera side');
  assert.ok(Math.abs(Math.atan2(prop.x-p.x,prop.z-p.z)-prop.characterFace)<1e-3&&turn(prop.face-prop.characterFace-Math.PI)<1e-3,'prop and character face each other');
 }
 const half=STAGING.station.half-.06;
 for(const [,a] of slots)for(const [,b] of slots){
  let from=a;
  for(const to of route(a,b,providers,props)){
   for(let t=0;t<=1;t+=.02){
    const x=from.x+(to.x-from.x)*t,z=from.z+(to.z-from.z)*t;
    assert.ok(!props.some(p=>Math.abs(x-p.x)<half&&Math.abs(z-p.z)<half),JSON.stringify([a,b]));
   }
   from=to;
  }
 }
});
test('clip choices are seeded per session and come from the contract clip set',()=>{
 for(const mode of Object.keys(CLIPS.character).filter(m=>m!=='walk'))for(let n=0;n<30;n++)assert.ok(CLIPS.character[mode].includes(clipFor('s1',mode,n)));
 const seq=id=>Array.from({length:30},(_,n)=>clipFor(id,'rest',n)).join();
 assert.equal(seq('s1'),seq('s1'));
 assert.notEqual(seq('s1'),seq('s2'));
});
test('the staging contract matches its golden vectors',()=>{
 const golden=JSON.parse(readFileSync(new URL('./fixtures/yard-choreography.json',import.meta.url),'utf8'));
 assert.deepEqual(JSON.parse(JSON.stringify(goldenVectors())),golden,'run node scripts/yard-golden.mjs --write only for a deliberate contract change (docs/yard/CONTRACT.md)');
});
test('Docker Agent sessions wear its own character, custom providers the shell one',()=>{
 assert.equal(characterIndex('docker'),5);
 assert.equal(characterIndex('custom-0'),characterIndex('shell'));
});
test('custom providers and non-provider task sessions have distinct stable placements',()=>{
 const custom=Array.from({length:18},(_,i)=>({id:'custom-'+i}));
 const anchors=providerPositions([...providers,...custom]);
 assert.equal(new Set([...anchors.values()].map(p=>p.x+','+p.z)).size,24);
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
test('a VS Code tab or the Apple app opens the view named next to its token and keeps it; a browser ignores it',()=>{
 const source=readFileSync(new URL('../web/theme.js',import.meta.url),'utf8');
 const open=(framed,hash,app=false)=>{
  const storage=new Map([['agentGuild.view','cards']]);
  const document={documentElement:{dataset:{}}};
  const window={matchMedia:()=>({matches:false})};
  window.parent=framed?{}:window;
  if(app)window.webkit={messageHandlers:{agentGuild:{}}};
  runInNewContext(source,{document,window,URLSearchParams,location:{hash},localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),length:0}});
  return [document.documentElement.dataset.view,storage.get('agentGuild.view')];
 };
 assert.deepEqual(open(true,'#token=t&view=yard'),['yard','yard']);
 assert.deepEqual(open(true,'#token=t&view=map'),['cards','cards']);
 assert.deepEqual(open(false,'#token=t&view=yard'),['cards','cards']);
 assert.deepEqual(open(false,'#token=t&view=yard',true),['yard','yard']);
});
test('a compact host view opens the Yard with the look it names, and keeps none of it',()=>{
 const source=readFileSync(new URL('../web/theme.js',import.meta.url),'utf8');
 const open=(framed,hash)=>{
  const storage=new Map([['agentGuild.view','cards'],['agentGuild.skin','guild'],['agentGuild.theme','light']]);
  const document={documentElement:{dataset:{}}};
  const window={matchMedia:()=>({matches:false})};
  window.parent=framed?{}:window;
  runInNewContext(source,{document,window,URLSearchParams,location:{hash},localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),length:0}});
  const {layout,view,skin,theme}=document.documentElement.dataset;
  return [layout,view,skin,theme,storage.get('agentGuild.view'),storage.get('agentGuild.skin'),storage.get('agentGuild.theme')];
 };
 assert.deepEqual(open(true,'#token=t&layout=compact&skin=grove&theme=dark'),['compact','yard','grove','dark','cards','guild','light']);
 assert.deepEqual(open(true,'#token=t&layout=compact&skin=moon&theme=dim'),['compact','yard','guild','light','cards','guild','light']);
 assert.deepEqual(open(false,'#token=t&layout=compact&skin=grove'),[undefined,'cards','guild','light','cards','guild','light']);
});
test('the overview keeps every hall in sight on narrow stages, and is unchanged on wide ones',()=>{
 const {right,up}=viewBasis(),dot=(p,v)=>p[0]*v[0]+p[1]*v[1]+p[2]*v[2];
 for(const aspect of [.75,1,4/3,16/9,3,5]){
  const {target,zoom}=overviewFor(aspect),halfH=CAMERA.height/2/zoom,halfW=halfH*aspect;
  assert.ok(zoom>=minZoom(aspect)&&zoom<=CAMERA.zoom.overview,`zoom at ${aspect}`);
  assert.deepEqual(clampPan({x:target[0],z:target[2]}),{x:target[0],z:target[2]});
  for(const [id,{x,z}] of providerPositions(providers)){
   const h=id==='docker'?STAGING.hall.docker:STAGING.hall.half;
   for(const corner of [[x-h,0,z-h],[x+h,0,z-h],[x-h,0,z+h],[x+h,0,z+h]]){
    const p=corner.map((v,i)=>v-target[i]);
    assert.ok(Math.abs(dot(p,right))<=halfW&&Math.abs(dot(p,up))<=halfH,`${id} at ${aspect}`);
   }
  }
 }
 assert.deepEqual(overviewFor(16/9),{target:CAMERA.target,zoom:CAMERA.zoom.overview});
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
 for(const [skin,world]of Object.entries(WORLDS))assert.ok(world.characters&&world.helpers.agent&&world.helpers.shell,skin+' has a cast');
});
test('the shipped characters and helpers follow the contract skeleton and carry every contract clip',()=>{
 const counts=new Map();
 for(const world of Object.values(WORLDS)){
  if(world.characters)counts.set(world.characters,['character',6]);
  if(world.helpers)for(const prefix of Object.values(world.helpers))counts.set(prefix,['helper',4]);
 }
 const clips={character:Object.values(CLIPS.character).flat(),helper:CLIPS.helper};
 for(const [prefix,[kind,count]] of counts){
  for(let i=0;i<count;i++){
   const name=prefix+i,asset=glb(name);
   assert.equal(asset.skins?.length,1,name);
   const joints=asset.skins[0].joints.map(j=>asset.nodes[j].name);
   assert.deepEqual([...joints].sort(),[...SKELETON[kind]].sort(),name+' skeleton');
   for(const clip of clips[kind]){
    const animation=asset.animations.find(a=>a.name===clip);assert.ok(animation,name+' '+clip);
    assert.ok(animation.channels.length>0);
    assert.ok(animation.samplers.every(s=>asset.accessors[s.input].count>1),name+' '+clip+' has keys');
   }
   // The runtime walks a character at the speed its stride and cycle give.
   const yard=asset.nodes.find(n=>n.extras?.yard)?.extras.yard;
   assert.ok(yard?.stride>0&&yard?.cycle>0&&yard?.height>0,name+' yard extras');
   // Builders work at their station's surface, scaled to their own shoulders.
   if(kind==='character')assert.ok(yard.surface>0,name+' working height');
   for(const event of yard.events||[]){
    assert.ok(clips[kind].includes(event.clip)&&event.time>=0&&event.at.length===3,name+' event');
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
test('every world has a skinless station prop within its budget, and every hall smoke and glow anchors',()=>{
 const assets=new URL('../web/yard/assets/',import.meta.url);
 for(const [skin,world] of Object.entries(WORLDS)){
  const prop=glb(world.station.asset);
  assert.ok(prop.meshes?.length,skin+' prop has a model');
  assert.ok(!prop.skins?.length&&!prop.animations?.length,skin+' prop is skinless');
  // The rig, the prop and the renderer agree on how high its working surface is.
  const built=prop.nodes.find(n=>n.extras?.yard)?.extras.yard.surface;
  const rigged=JSON.parse(readFileSync(new URL(`../concept-art/${skin}-yard/world.json`,import.meta.url),'utf8')).station.surface;
  assert.ok(Math.abs(built-world.station.surface)<.01&&rigged===world.station.surface,`${skin} surface: prop ${built}, rig ${rigged}, WORLDS ${world.station.surface}`);
  let bytes=statSync(new URL(world.station.asset+'.glb',assets)).size;
  for(const image of prop.images||[])if(image.uri)bytes+=statSync(new URL(image.uri,assets)).size;
  assert.ok(bytes<=PROP_BUDGET*MiB,`${skin} prop is ${(bytes/MiB).toFixed(2)} MiB`);
  const nodes=new Set(glb(world.asset).nodes.map(n=>n.name));
  for(const {id} of providers)for(const anchor of ['smoke','glow'])assert.ok(nodes.has(`hall_${id}_${anchor}`),`${skin} hall_${id}_${anchor}`);
 }
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
// A station prop and its maps, in MiB.
const PROP_BUDGET=5;
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
  assert.ok(bytes<=36*MiB,`${skin} world is ${(bytes/MiB).toFixed(2)} MiB`);
 }
});
