import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const candidates=[process.env.CHROME_PATH,'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','/usr/bin/google-chrome','/usr/bin/chromium','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
export const browserBinary=candidates.find(p=>p&&existsSync(p));
export const pause=ms=>new Promise(r=>setTimeout(r,ms));
export async function until(fn,ms=20000) {
  const start=Date.now();
  while(Date.now()-start<ms){const result=await fn();if(result)return result;await pause(100);}
  throw new Error('Browser condition timed out');
}
export async function openBrowser({width=1440,height=1000,software=process.env.YARD_SOFTWARE_GL==='1'}={}) {
  const binary=browserBinary;if(!binary)throw new Error('Set CHROME_PATH to Chrome or Edge.');
  const cache=path.join(root,'.cache');await fs.mkdir(cache,{recursive:true});
  const profile=await fs.mkdtemp(path.join(cache,'yard-browser-'));
  // CI may have no GPU. This opt-in is confined to a disposable browser
  // profile serving our trusted local fixtures; normal app browsers are untouched.
  const graphics=software?['--use-gl=angle','--use-angle=swiftshader-webgl','--enable-unsafe-swiftshader']:process.env.CI?['--enable-unsafe-swiftshader']:[];
  const chrome=spawn(binary,['--headless=new',...graphics,'--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--force-color-profile=srgb','--window-size='+width+','+height,'about:blank'],{stdio:'ignore',windowsHide:true});
  let launchError;chrome.on('error',e=>{launchError=e;});
  let port;
  try {
    port=await until(async()=>{if(launchError)throw launchError;if(chrome.exitCode!==null)throw new Error('Chrome exited before opening its test profile');try{return Number((await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);}catch{return 0;}});
  } catch (err) {
    if(chrome.exitCode===null)chrome.kill();
    throw err;
  }
  const target=(await (await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(t=>t.type==='page');
  const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  const pending=new Map(),errors=[],requests=[],events=[];let next=0;
  ws.onmessage=({data})=>{
    const msg=JSON.parse(data),p=pending.get(msg.id);
    if(p){pending.delete(msg.id);clearTimeout(p.timer);if(msg.error)p.reject(new Error(msg.error.message));else p.resolve(msg.result);}
    else {events.push(msg);if(msg.method==='Runtime.exceptionThrown')errors.push(msg.params.exceptionDetails.exception?.description||msg.params.exceptionDetails.text);
      if(msg.method==='Network.requestWillBeSent')requests.push(msg.params.request);
    }
  };
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timed out'));},20000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  await send('Runtime.enable');await send('Page.enable');await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  return {send,evaluate,errors,requests,events,
    click:selector=>evaluate('document.querySelector('+JSON.stringify(selector)+').click()'),
    wait:async expression=>{try{return await until(()=>evaluate(expression));}catch(err){throw new Error(err.message+': '+expression+'\n'+errors.join('\n'),{cause:err});}},
    async shot(file){const {data}=await send('Page.captureScreenshot',{format:'png'});await fs.writeFile(file,Buffer.from(data,'base64'));},
    async close(){
      try{await send('Browser.close');}catch{}ws.close();
      if(chrome.exitCode===null)await Promise.race([new Promise(r=>chrome.once('exit',r)),pause(3000)]);
      if(chrome.exitCode===null)chrome.kill();
      // Only this helper's verified profile directory can be removed.
      if(!path.resolve(profile).startsWith(path.resolve(cache)+path.sep))throw new Error('Profile escaped preview cache');
      await fs.rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});
    }
  };
}
