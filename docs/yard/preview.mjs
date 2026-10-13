import { startFixture } from './fixture.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
const fixture=await startFixture({port:Number(process.env.YARD_PREVIEW_PORT)||0});
const url=fixture.api.url+'/#token='+fixture.token;
await mkdir('.cache',{recursive:true});
await writeFile('.cache/yard-preview.json',JSON.stringify({url,pid:process.pid},null,2));
console.log('Isolated Yard preview: '+url);
console.log('Fixture data only. No real sessions, accounts, GitHub changes, or manager lifecycle actions.');
// YARD_PREVIEW_CYCLE=1: a fixed schedule of output starting and stopping,
// so staging can be watched. Every 6 s the next session flips: a quiet one
// starts working, a working one goes quiet as if it stopped 15 s ago (so it
// pauses at its station, then walks to rest). Every 40 s a session arrives
// from its hall, and the oldest arrival leaves.
if(process.env.YARD_PREVIEW_CYCLE==='1'){
  const arrivals=[],providers=['anthropic','openai','google','xai','shell'];let step=0;
  setInterval(()=>{
    const sessions=[...fixture.data.values()].filter(s=>s.status==='running');
    const s=sessions[step++%Math.max(1,sessions.length)];if(!s)return;
    if(s.activity==='active'){s.activity='quiet';s.lastOutputAt=new Date(Date.now()-15000).toISOString();}
    else {s.activity='active';s.lastOutputAt=new Date().toISOString();}
    fixture.manager.emit('event',{type:'session.updated',session:s});
  },6000).unref?.();
  setInterval(()=>{
    arrivals.push(fixture.manager.create({providerId:providers[arrivals.length%providers.length],name:'Arrival '+(arrivals.length+1)}).toJSON().id);
    if(arrivals.length>3)fixture.manager.remove(arrivals.splice(0,1)[0]);
  },40000).unref?.();
  console.log('Cycling session output to show staging.');
}
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{await fixture.close();process.exit(0);});
