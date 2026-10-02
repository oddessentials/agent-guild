import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { sessionPose, familiarPose, layoutSessions, providerPositions, WORLDS } from '../web/yard/model.mjs';
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
});
test('the shipped characters and familiars have actual skinning and usable animation tracks',()=>{
 for(const prefix of ['hero_','robot_','spirit_','familiar_','drone_']){
  for(let i=0;i<(prefix.includes('familiar')||prefix.includes('drone')?4:5);i++){
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
