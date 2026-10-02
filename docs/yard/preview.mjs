import { startFixture } from './fixture.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
const fixture=await startFixture({port:Number(process.env.YARD_PREVIEW_PORT)||0});
const url=fixture.api.url+'/#token='+fixture.token;
await mkdir('.cache',{recursive:true});
await writeFile('.cache/yard-preview.json',JSON.stringify({url,pid:process.pid},null,2));
console.log('Isolated Yard preview: '+url);
console.log('Fixture data only. No real sessions, accounts, GitHub changes, or manager lifecycle actions.');
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{await fixture.close();process.exit(0);});
