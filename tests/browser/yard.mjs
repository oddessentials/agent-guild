import test from 'node:test';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFixture } from '../../docs/yard/fixture.mjs';
import { browserBinary, openBrowser, until } from '../../docs/yard/browser.mjs';

const options={skip:!browserBinary && 'Set CHROME_PATH to run browser coverage',timeout:120000};
const q=JSON.stringify;
const inspector='#yard-inspector';
const provider=id=>`.yard-row[data-key="provider:${id}"]`;
const session=id=>`.yard-row[data-key="session:${id}"]`;
let shared;
const installedScripts=[];
test.after(async()=>{if(shared)await shared.close();});
async function browser(){if(!shared)shared=await openBrowser();return shared;}
const nextFrames=b=>b.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
function assetInflight(b){
  const done=new Set();
  for(const event of b.events){
    if(event.method==='Network.loadingFinished'||event.method==='Network.loadingFailed')done.add(event.params.requestId);
  }
  return b.events.some(event=>event.method==='Network.requestWillBeSent'&&/\.(?:glb|gltf|webp|hdr)(?:$|\?)/.test(event.params?.request?.url||'')&&!done.has(event.params.requestId));
}
// The page counts every animation frame, including these probes. A quiet scene
// adds exactly the two probe frames. Two quiet probes in a row, after the
// downloads have finished, means reduced motion is not looping.
async function framesSettled(b){
  let quiet=0;
  const settled=await until(async()=>{
    if(assetInflight(b)){quiet=0;return false;}
    const before=await b.evaluate('window.__frames');
    await nextFrames(b);
    if(assetInflight(b)){quiet=0;return false;}
    const frames=await b.evaluate('window.__frames');
    quiet=frames-before===2?quiet+1:0;
    return quiet>=2?{frames}:false;
  });
  return settled.frames;
}
async function setup(t,{yard=false,auth=true,source='',width=1440,height=1000,hash='',until=null,yardWorlds,yardPieces}={}) {
  const fixture=await startFixture({yardWorlds,yardPieces});t.after(()=>fixture.close());
  const b=await browser();
  await b.navigate('about:blank');
  b.errors.length=0;b.requests.length=0;b.events.length=0;
  for(const identifier of installedScripts)await b.send('Page.removeScriptToEvaluateOnNewDocument',{identifier});
  installedScripts.length=0;
  await b.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  await b.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  const added=await b.send('Page.addScriptToEvaluateOnNewDocument',{source:`
    localStorage.setItem('agentGuild.theme','dark');
    localStorage.setItem('agentGuild.skin','guild');
    localStorage.setItem('agentGuild.view',${q(yard?'yard':'cards')});
    window.__frames=0;
    const raf=window.requestAnimationFrame;
    window.requestAnimationFrame=callback=>raf.call(window,time=>{window.__frames++;callback(time);});
    ${source}`});
  installedScripts.push(added.identifier);
  await b.navigate(fixture.api.url+'/' +(auth?'#token='+fixture.token+hash:''));
  await b.wait(until||(auth?"document.querySelector('#connection')?.classList.contains('ok')":"document.querySelector('#auth')?.hidden===false"));
  return {f:fixture,b};
}
const fill=(b,selector,value)=>b.evaluate(`document.querySelector(${q(selector)}).value=${q(value)};document.querySelector(${q(selector)}).dispatchEvent(new Event('input',{bubbles:true}))`);
const closeTerminal=b=>b.click('#panel-close');
// Answers the page's in-page question, typing `value` first when it asks for text.
const answer=async(b,value)=>{await b.wait("document.querySelector('#ask').open");if(value!==undefined)await b.evaluate(`document.querySelector('#ask-input').value=${q(value)}`);await b.click('#ask-ok');};
const terminalReady=b=>b.wait("!document.querySelector('#terminal-panel').hidden && document.querySelector('.terminal-host .xterm')");
const ready=b=>b.wait("document.querySelector('#yard-stage').dataset.ready==='true'");
// Pending controls use aria-disabled so they keep focus; either form blocks.
const blocked=selector=>`(e=>e.disabled||e.getAttribute('aria-disabled')==='true')(document.querySelector(${q(selector)}))`;

function holdRequests(t, manager, method) {
  const original=manager[method].bind(manager),pending=[];
  manager[method]=(...args)=>new Promise((resolve,reject)=>{
    let settled=false;
    const finish=error=>{
      if(settled)return;settled=true;
      if(error)return reject(error);
      try{resolve(original(...args));}catch(err){reject(err);}
    };
    pending.push({args,finish});
  });
  t.after(()=>pending.forEach(p=>p.finish(new Error('Fixture closed'))));
  return pending;
}

test('New pending state follows the account and folder across views, independently of install/update',options,async t=>{
  const {f,b}=await setup(t);
  const pending=holdRequests(t,f.manager,'create'),installs=holdRequests(t,f.manager,'install');
  const card='#providers [data-id="anthropic"]';
  const disabled=selector=>b.evaluate(blocked(selector));
  await fill(b,'#cwd','project-a');
  await b.click(card+' .new');await until(()=>pending.length===1);
  await b.evaluate(`document.querySelector('${card} .new').dispatchEvent(new Event('click'))`);
  assert.equal(await disabled(card+' .new'),true);
  await b.click('#view-yard');await ready(b);await b.click(provider('anthropic'));
  assert.equal(await disabled(inspector+' .new'),true,'newly mounted Yard control shares the pending action');
  assert.equal(await b.evaluate(`document.querySelector('${inspector} .new').textContent`),'Starting…');
  assert.equal(await disabled(inspector+' .existing'),false);
  assert.equal(await disabled(inspector+' .update'),false);
  await b.evaluate(`document.querySelector('${inspector} .new').dispatchEvent(new Event('click'))`);
  assert.equal(pending.length,1,'duplicate submissions through either view are blocked');

  await b.click(inspector+' [data-account="work"]');
  assert.equal(await disabled(inspector+' .new'),false);
  await b.click(inspector+' .new');await until(()=>pending.length===2);
  await fill(b,'#cwd','project-b');
  assert.equal(await disabled(inspector+' .new'),false);
  await b.click(inspector+' .new');await until(()=>pending.length===3);
  await fill(b,'#cwd','project-a');
  assert.equal(await disabled(inspector+' .new'),true);
  pending[1].finish();await terminalReady(b);await closeTerminal(b);
  assert.equal(await disabled(inspector+' .new'),false);
  await b.click('#view-cards');await b.click(card+' [data-account="default"]');
  assert.equal(await disabled(card+' .new'),true,'finishing Work did not clear Personal');
  await b.click(card+' [data-account="work"]');await fill(b,'#cwd','project-b');
  assert.equal(await disabled(card+' .new'),true,'finishing project A did not clear project B');

  await b.click(card+' .update');await until(()=>installs.length===1);
  installs[0].finish(Object.assign(new Error('Provider is in use'),{code:'provider_in_use',status:409,running:2}));
  await answer(b);await until(()=>installs.length===2);
  assert.deepEqual(installs.map(p=>p.args[1]),[{force:false},{force:true}]);
  assert.equal(await disabled(card+' .update'),true);
  await fill(b,'#cwd','project-c');
  assert.equal(await disabled(card+' .new'),false,'install has no shared New/Resume pending flag');
  await b.click(card+' .new');await until(()=>pending.length===4);
  installs[1].finish();await terminalReady(b);await closeTerminal(b);
  assert.equal(await disabled(card+' .new'),true,'install completion does not clear New');
  assert.equal(await disabled(card+' .update'),false);
  pending[3].finish(Object.assign(new Error('Fixture start failed'),{status:400,code:'fixture_failure'}));
  await b.wait('!'+blocked(card+' .new'));
  await b.click(card+' .new');await until(()=>pending.length===5);
  pending[0].finish();await terminalReady(b);await closeTerminal(b);
  assert.equal(await disabled(card+' .new'),true);
  pending[2].finish();await terminalReady(b);await closeTerminal(b);
  assert.equal(await disabled(card+' .new'),true);
  pending[4].finish();await terminalReady(b);await closeTerminal(b);
  assert.equal(await disabled(card+' .new'),false);
  assert.deepEqual(pending.map(p=>[p.args[0].account,p.args[0].cwd]),[
    ['default','project-a'],['work','project-a'],['work','project-b'],['work','project-c'],['work','project-c'],
  ]);
  assert.deepEqual(b.errors,[]);
});

test('Resume shares one pending action across cards, Yard and history without blocking other conversations',options,async t=>{
  const {f,b}=await setup(t);
  const pending=holdRequests(t,f.manager,'create');
  const stopped=[...f.data.values()][0];stopped.toolSessionId='history-1';f.manager.stop(stopped.id);
  const card='#providers [data-id="anthropic"]',resume=`#sessions [data-id="${stopped.id}"] .resume`;
  const history='#history-list [data-id="history-1"] .history-resume';
  const missing='#history-list [data-id="history-missing"] .history-resume';
  const manual='#history-form button[type="submit"]';
  const disabled=selector=>b.evaluate(blocked(selector));
  await fill(b,'#cwd','fallback');
  await b.click(card+' .new');await until(()=>pending.length===1);
  await b.wait(`!document.querySelector(${q(resume)}).hidden`);
  assert.equal(await disabled(resume),false,'New does not block Resume for the same provider');
  await b.click(resume);await until(()=>pending.length===2);
  await b.click('#view-yard');await ready(b);await b.click(session(stopped.id));
  assert.equal(await disabled(inspector+' .resume'),true);
  assert.equal(await b.evaluate(`document.querySelector('${inspector} .resume').textContent`),'Resuming…');
  await b.click(provider('anthropic'));await b.click(inspector+' .existing');await b.wait(`document.querySelector(${q(history)})`);
  assert.equal(await disabled(history),true);
  assert.equal(await disabled(missing),false);
  await fill(b,'#history-id','history-1');assert.equal(await disabled(manual),true);
  await b.evaluate("document.querySelector('#history-form').dispatchEvent(new Event('submit',{cancelable:true}))");
  await b.evaluate(`document.querySelector(${q(history)}).dispatchEvent(new Event('click'))`);
  assert.equal(pending.length,2,'manual id and history cannot duplicate a card Resume');
  await b.click('#history-close');await b.click(inspector+' [data-account="work"]');
  await b.click(inspector+' .existing');await b.wait(`document.querySelector(${q(history)}) && !${blocked(history)}`);
  await b.click(history);await until(()=>pending.length===3);
  await b.click('#history-close');await b.click(inspector+' [data-account="default"]');
  await b.click(inspector+' .existing');await b.wait(`document.querySelector(${q(missing)})`);
  await b.click(missing);await until(()=>pending.length===4);
  pending[2].finish();await terminalReady(b);await closeTerminal(b);
  await b.click(inspector+' .existing');await b.wait(`document.querySelector(${q(history)}) && document.querySelector(${q(missing)})`);
  assert.equal(await disabled(history),true,'Work completion leaves Personal pending');
  assert.equal(await disabled(missing),true,'one conversation cannot clear another');
  pending[1].finish(Object.assign(new Error('Fixture resume failed'),{status:400,code:'fixture_failure'}));
  await b.wait('!'+blocked(history));
  assert.equal(await b.evaluate("document.querySelector('#history').open"),true);
  assert.equal(await disabled(resume),false,'failed Resume can be tried again');
  await fill(b,'#history-id','history-1');assert.equal(await disabled(manual),false);
  await b.click(manual);await until(()=>pending.length===5);
  pending[3].finish();await until(()=>pending.length===6);
  assert.deepEqual(pending.slice(3).filter(p=>p.args[0].resume==='history-missing').map(p=>p.args[0].cwd),['missing','fallback']);
  assert.equal(await disabled(missing),true,'missing-folder fallback keeps the original Resume pending');
  pending[5].finish();await terminalReady(b);await closeTerminal(b);
  assert.equal(await disabled(resume),true);
  pending[0].finish();await terminalReady(b);await closeTerminal(b);
  assert.equal(await disabled(resume),true,'New completion leaves Resume pending');
  pending[4].finish();await terminalReady(b);await closeTerminal(b);
  assert.equal(await disabled(resume),false);
  assert.equal(await b.evaluate(`document.querySelector(${q(resume)}).hidden`),true,'the resumed conversation now has a running session');
  assert.equal(pending.length,6);
  assert.deepEqual(b.errors,[]);
});

test('pending New and Resume keep keyboard focus, ignore presses and recover focus after failure',options,async t=>{
  const {f,b}=await setup(t);
  await b.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  const pending=holdRequests(t,f.manager,'create');
  const stopped=[...f.data.values()][0];stopped.toolSessionId='history-1';f.manager.stop(stopped.id);
  const card='#providers [data-id="anthropic"]',resume=`#sessions [data-id="${stopped.id}"] .resume`;
  const history='#history-list [data-id="history-1"] .history-resume';
  const failure=()=>Object.assign(new Error('Fixture start failed'),{status:400,code:'fixture_failure'});
  const focused=selector=>b.evaluate(`document.activeElement===document.querySelector(${q(selector)})`);
  const text=selector=>b.evaluate(`document.querySelector(${q(selector)}).textContent`);
  async function enter() {
    await b.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
    await b.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  }
  async function press(selector,{release=true}={}) {
    const {x,y}=await b.evaluate(`(()=>{const e=document.querySelector(${q(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await b.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
    await b.evaluate(`document.querySelector(${q(selector)}).style.transition='none'`);
    await b.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
    await nextFrames(b);
    const transform=await b.evaluate(`getComputedStyle(document.querySelector(${q(selector)})).transform`);
    // Releasing elsewhere presses without clicking.
    if(!release)await b.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1});
    await b.send('Input.dispatchMouseEvent',{type:'mouseReleased',...(release?{x,y}:{x:1,y:1}),button:'left',clickCount:1});
    return transform;
  }
  async function keepsFocus(selector,label,pendingLabel,index) {
    await b.evaluate(`document.querySelector(${q(selector)}).focus()`);
    await enter();await until(()=>pending.length===index+1);
    assert.equal(await focused(selector),true,'pending control keeps focus');
    assert.equal(await text(selector),pendingLabel);
    await enter();
    assert.equal(pending.length,index+1,'Enter on a pending control is ignored');
    pending[index].finish(failure());
    await b.wait('!'+blocked(selector));
    assert.equal(await focused(selector),true,'focus stays on the control after failure');
    assert.equal(await text(selector),label);
  }

  assert.notEqual(await press(card+' .existing',{release:false}),'none','an enabled button still presses down');
  await keepsFocus(card+' .new','New','Starting…',0);
  await b.click(card+' .new');await until(()=>pending.length===2);
  assert.equal(await press(card+' .new'),'none','a pending button does not press down');
  assert.equal(pending.length,2,'clicking a pending control is ignored');
  pending[1].finish(failure());await b.wait('!'+blocked(card+' .new'));

  await b.wait(`!document.querySelector(${q(resume)}).hidden`);
  await keepsFocus(resume,'Resume','Resuming…',2);
  await b.click(card+' .existing');await b.wait(`document.querySelector(${q(history)})`);
  await keepsFocus(history,'Resume','Resuming…',3);
  assert.equal(await b.evaluate("document.querySelector('#history').open"),true);
  assert.deepEqual(b.errors,[]);
});

test('failed character and helper downloads recover on state changes without retrying unchanged updates',options,async t=>{
  const {f,b}=await setup(t,{source:`
    const originalFetch=window.fetch;
    window.__assetAttempts={};window.__assetFailures={hero_0:2,familiar_0:1};
    window.__holdNextFailure={hero_0:true,familiar_0:true};window.__heldFailures={};
    window.fetch=(...args)=>{
      const match=String(args[0]?.url||args[0]).match(/\\/((?:hero|familiar)_\\d)\\.glb$/);
      if(match){
        const name=match[1];window.__assetAttempts[name]=(window.__assetAttempts[name]||0)+1;
        if(window.__assetFailures[name]>0){
          window.__assetFailures[name]--;
          const error=new TypeError('Fixture download interrupted');
          if(window.__holdNextFailure[name]){
            delete window.__holdNextFailure[name];
            return new Promise((resolve,reject)=>{window.__heldFailures[name]=()=>reject(error);});
          }
          return Promise.reject(error);
        }
      }
      return originalFetch(...args);
    };`});
  const sessions=[...f.data.values()].slice(0,2).map(s=>({...s,agents:[],shells:[]}));
  sessions[0].agents=[{id:'helper',name:'D',status:'working'},{id:'peer',name:'E',status:'working'}];
  await b.evaluate(`(async()=>{
    const {YardRenderer}=await import('/yard/renderer.js');
    const host=document.createElement('div'),labels=document.createElement('div');
    host.style.cssText='position:fixed;width:900px;height:700px;top:0;left:0';host.append(labels);document.body.append(host);
    window.__renderer=new YardRenderer(host,labels,{select(){},open(){}});
    window.__sessions=${q(sessions)};window.__providers=${q(f.providers)};
    await __renderer.setWorld('guild','dark');__renderer.update(__providers,__sessions);__renderer.setActive(true);
    window.__unit=__renderer.units.get(__sessions[0].id);
  })()`);
  await b.wait('__heldFailures.hero_0');
  await b.evaluate("__sessions[0].activity='quiet';__renderer.update(__providers,__sessions);__heldFailures.hero_0()");
  await b.wait("__unit.label.title.includes('unavailable') && !__unit.loading && !__renderer.cache.has('hero_0')");
  const unchanged=()=>b.evaluate(`(async()=>{
    for(let i=0;i<20;i++){
      __sessions=__sessions.map(s=>({...s,lastOutputAt:new Date().toISOString(),name:s.name+' '}));
      __renderer.update(__providers,__sessions);await new Promise(requestAnimationFrame);
    }
  })()`);
  await unchanged();
  assert.equal(await b.evaluate('__assetAttempts.hero_0'),1,'a shared failed request waits for a fresh transition, even after a state change during loading');
  await b.evaluate("__sessions[0].activity='active';__renderer.update(__providers,__sessions)");
  await b.wait("__assetAttempts.hero_0===2 && !__unit.loading && !__renderer.cache.has('hero_0')");
  await unchanged();
  assert.equal(await b.evaluate('__assetAttempts.hero_0'),2,'a second failure also waits for another state transition');
  await b.evaluate("__sessions[0].activity='quiet';__renderer.update(__providers,__sessions)");
  await b.wait('__unit.loaded && __unit.helpers.length===1 && __heldFailures.familiar_0');
  await b.evaluate("__sessions[0].activity='active';__renderer.update(__providers,__sessions);__heldFailures.familiar_0()");
  await b.wait("__unit.loaded && __unit.helpers.length===1 && !__renderer.cache.has('familiar_0')");
  assert.equal(await b.evaluate('__unit.label.title'),'','recovered character clears its failure message');
  assert.equal(await b.evaluate('__renderer.units.get(__sessions[0].id)===__unit'),true,'existing character recovers in place');
  await unchanged();
  assert.deepEqual(await b.evaluate('__assetAttempts'),{hero_0:3,familiar_0:1,familiar_1:1},'a failed helper cannot retry on every update or render frame');
  await b.evaluate("__sessions[0].agents[0].status='waiting';__sessions[1].activity='quiet';__renderer.update(__providers,__sessions)");
  await b.wait('__unit.helpers.length===2 && __renderer.units.get(__sessions[1].id).loaded');
  assert.deepEqual(await b.evaluate('__assetAttempts'),{hero_0:3,familiar_0:2,familiar_1:1},'helper state retries a missing familiar; successful model assets stay cached');
  await b.evaluate("(async()=>{await __renderer.setWorld('orbital','dark');await __renderer.setWorld('guild','dark');})()");
  await b.wait('[...__renderer.units.values()].every(u=>u.loaded) && __renderer.units.get(__sessions[0].id).helpers.length===2');
  assert.deepEqual(await b.evaluate('__assetAttempts'),{hero_0:3,familiar_0:2,familiar_1:1});
  await b.evaluate('__renderer.dispose()');
  assert.deepEqual(b.errors,[]);
});

// Deterministic: the renderer runs on a fixed clock and is never started, so
// no animation frame runs; the test advances it with step() in fixed steps.
test('characters walk to where their sessions\' states put them, arrive from their hall, and snap into place with reduced motion',options,async t=>{
  const {f,b}=await setup(t);
  const T0=Date.parse('2026-10-13T12:00:00.000Z'),iso=ms=>new Date(T0-ms).toISOString();
  const sessions=[...f.data.values()].slice(0,3).map(s=>({...s,activity:'active',lastOutputAt:iso(0),createdAt:iso(3600000),agents:[],shells:[]}));
  await b.evaluate(`(async()=>{
    const {YardRenderer}=await import('/yard/renderer.js');
    window.__model=await import('/yard/model.mjs');
    const host=document.createElement('div'),labels=document.createElement('div');
    host.style.cssText='position:fixed;width:900px;height:700px;top:0;left:0';host.append(labels);document.body.append(host);
    window.__renderer=new YardRenderer(host,labels,{select(){},open(){},clock:()=>${T0}});
    window.__sessions=${q(sessions)};window.__providers=${q(f.providers)};
    await __renderer.setWorld('guild','dark');__renderer.update(__providers,__sessions);
    window.__at=id=>{const p=__renderer.units.get(id).root.position;return [p.x,p.z];};
    window.__place=id=>{const p=__renderer.staged.places.get(id);return [p.x,p.z];};
    // Steps until the character stops, at most 4000 times; returns the count.
    window.__walk=id=>{let n=0;while(__renderer.units.get(id).moving&&n<4000){__renderer.step(.05);n++;}return n;};
    // How many 0.05 s steps a walk along a route at a speed takes.
    window.__steps=(from,path,speed)=>{let d=0,a=from;for(const p of path){d+=Math.hypot(p.x-a.x,p.z-a.z);a=p;}return Math.ceil(d/speed/.05);};
  })()`);
  const id=sessions[0].id,unit=`__renderer.units.get(${q(id)})`;
  await b.wait('[...__renderer.units.values()].every(u=>u.loaded)');
  assert.deepEqual(await b.evaluate(`__at(${q(id)})`),await b.evaluate(`__place(${q(id)})`),'sessions open at their stations');
  assert.equal(await b.evaluate(`${unit}.clip`),'work_0','a working session plays its work');
  // Quiet for a minute: the character walks to a rest spot round the plaza.
  const walk=await b.evaluate(`(()=>{
    const from={x:${unit}.root.position.x,z:${unit}.root.position.z};
    __sessions[0].activity='quiet';__sessions[0].lastOutputAt=${q(iso(60000))};__renderer.update(__providers,__sessions);
    const u=${unit},expected=__steps(from,u.path,u.speed),mode=__renderer.staged.places.get(${q(id)}).mode,clip=u.clip,moving=u.moving;
    return {mode,clip,moving,expected,taken:__walk(${q(id)})};
  })()`);
  assert.equal(walk.mode,'rest');
  assert.equal(walk.moving,true);
  assert.equal(walk.clip,'walk');
  assert.ok(walk.taken===walk.expected||walk.taken===walk.expected+1,`a walk of ${walk.expected} steps took ${walk.taken}`);
  assert.deepEqual(await b.evaluate(`__at(${q(id)})`),await b.evaluate(`__place(${q(id)})`),'it arrives at its rest spot');
  assert.equal(await b.evaluate(`${unit}.clip`),await b.evaluate(`__model.clipFor(${q(id)},'rest',0)`),'and rests there');
  // A session created a second ago steps out of its hall's door.
  await b.evaluate(`__sessions.push({...__sessions[1],id:'arrival',createdAt:${q(iso(1000))}});__renderer.update(__providers,__sessions)`);
  assert.deepEqual(await b.evaluate(`__at('arrival')`),await b.evaluate(`(d=>[d.x,d.z])(__model.doorFor(__sessions.at(-1),__providers))`),'a new session starts at its door');
  await b.wait(`__renderer.units.get('arrival').loaded`);
  assert.ok(await b.evaluate(`__walk('arrival')`)<4000,'and reaches its place');
  assert.deepEqual(await b.evaluate(`__at('arrival')`),await b.evaluate(`__place('arrival')`));
  await b.evaluate(`__renderer.setReducedMotion(true);__sessions[0].activity='active';__sessions[0].lastOutputAt=${q(iso(0))};__renderer.update(__providers,__sessions)`);
  assert.equal(await b.evaluate(`${unit}.moving`),false);
  assert.deepEqual(await b.evaluate(`__at(${q(id)})`),await b.evaluate(`__place(${q(id)})`),'reduced motion places it at once');
  assert.equal(await b.evaluate(`(__renderer.fireworks(),__renderer.shows.length)`),0,'reduced motion shows no fireworks');
  await b.evaluate('__renderer.dispose()');
  assert.deepEqual(b.errors,[]);
});

// Deterministic like the walk check: a fixed clock, no animation frames, and
// step() in fixed steps.
test('station props come and go with their sessions, halls glow and smoke with their working crews, and resting characters glance at each other',options,async t=>{
  const {f,b}=await setup(t);
  const T0=Date.parse('2026-10-13T12:00:00.000Z'),iso=ms=>new Date(T0-ms).toISOString();
  // Two Claude Code sessions working, one Codex session quiet.
  const sessions=[...f.data.values()].slice(0,3).map((s,i)=>({...s,activity:i<2?'active':'quiet',lastOutputAt:iso(i<2?0:5000),createdAt:iso(3600000),agents:[],shells:[]}));
  await b.evaluate(`(async()=>{
    const {YardRenderer}=await import('/yard/renderer.js');
    window.__model=await import('/yard/model.mjs');
    const host=document.createElement('div'),labels=document.createElement('div');
    host.style.cssText='position:fixed;width:900px;height:700px;top:0;left:0';host.append(labels);document.body.append(host);
    window.__renderer=new YardRenderer(host,labels,{select(){},open(){},clock:()=>${T0}});
    window.__sessions=${q(sessions)};window.__providers=${q(f.providers)};
    await __renderer.setWorld('guild','dark');__renderer.update(__providers,__sessions);
    window.__steps=n=>{for(let i=0;i<n;i++)__renderer.step(.05);};
    window.__hall=id=>{const h=__renderer.halls.get(id);return {level:h.level,glow:Math.max(...h.glows.map(m=>m.emissiveIntensity))};};
    const T=await import('/yard/vendor/engine.js'),body=new T.Quaternion(),head=new T.Quaternion(),ahead=new T.Vector3();
    window.__headYaw=id=>{const u=__renderer.units.get(id);u.model.updateMatrixWorld(true);u.model.getWorldQuaternion(body);u.lookBones.head.getWorldQuaternion(head);
      ahead.set(0,0,1).applyQuaternion(body.invert().multiply(head));return Math.atan2(ahead.x,ahead.z);};
  })()`);
  await b.wait('__renderer.props.size===3 && [...__renderer.props.values()].every(p=>p.model) && [...__renderer.units.values()].every(u=>u.loaded)');
  assert.deepEqual(await b.evaluate(`__sessions.map(s=>{const p=__renderer.props.get(s.id).root,slot=__renderer.staged.slots.get(s.id);
    const want=__model.stationProp({x:Math.round(slot.x*1000)/1000,z:Math.round(slot.z*1000)/1000},s.id);
    return [p.position.x===want.x,p.position.z===want.z,p.rotation.y===want.face];})`),sessions.map(()=>[true,true,true]),'each station has its prop, where the contract puts it');
  assert.equal(await b.evaluate(`__renderer.frame`),0,'nothing animates while rendering is paused');
  const idle=await b.evaluate(`__hall('openai')`);
  await b.evaluate('__steps(40)');
  const busy=await b.evaluate(`__hall('anthropic')`);
  assert.equal(busy.level,1,'two working sessions light their hall fully');
  assert.ok(busy.glow>idle.glow,'and it glows brighter than a hall with nobody working');
  assert.equal(await b.evaluate(`__hall('openai').level`),0);
  assert.ok(await b.evaluate('__renderer.effects.live')>0,'its chimney smokes');
  // Both quiet: the glow fades out and the last smoke clears.
  await b.evaluate(`for(const s of __sessions)Object.assign(s,{activity:'quiet',lastOutputAt:${q(iso(1000))}});__renderer.update(__providers,__sessions)`);
  await b.evaluate('__steps(10)');
  const fading=await b.evaluate(`__hall('anthropic').level`);
  assert.ok(fading>0&&fading<1,'the glow fades rather than snapping off');
  await b.evaluate('__steps(150)');
  assert.deepEqual(await b.evaluate(`[__hall('anthropic').level,__renderer.effects.live]`),[0,0]);
  // The two pausing Claude Code characters stand side by side and glance at each other.
  const glance=await b.evaluate(`[__renderer.units.get(__sessions[0].id).lookYaw,__model.lookTarget(__sessions[0].id,__renderer.staged.places)]`);
  assert.equal(glance[1],sessions[1].id);
  assert.ok(Math.abs(glance[0])>.05,'a pausing character turns its head to its neighbour');
  // The head holds the glance, within the contract's limit and the clip's own sway, frame after frame.
  const [limit,turns]=await b.evaluate(`[__model.STAGING.look.yaw,Array.from({length:60},()=>(__renderer.step(.05),__headYaw(__sessions[0].id)))]`);
  assert.ok(turns.every(yaw=>Math.abs(yaw)<limit+.3),'the head never turns past its glance');
  assert.ok(turns.every(yaw=>Math.sign(yaw)===Math.sign(glance[0])&&Math.abs(yaw)>.3),'and keeps looking at its neighbour');
  // Working again under reduced motion: the glow is there at once, with no smoke, and no glance.
  await b.evaluate(`__renderer.setReducedMotion(true);for(const s of __sessions.slice(0,2))s.activity='active';__renderer.update(__providers,__sessions)`);
  assert.deepEqual(await b.evaluate(`[__hall('anthropic').level,__renderer.effects.live]`),[1,0]);
  assert.ok(await b.evaluate(`(u=>{const neck=u.lookBones.neck,track=u.action.getClip().tracks.find(t=>t.name==='Neck.quaternion');
    const [x,y,z,w]=track.createInterpolant().evaluate(u.action.time);return Math.abs(neck.quaternion.x*x+neck.quaternion.y*y+neck.quaternion.z*z+neck.quaternion.w*w)>.99999;})(__renderer.units.get(__sessions[0].id))`),'the neck comes back from its glance to where the clip holds it');
  // A session that ends takes its prop with it; a world switch releases the prop model.
  await b.evaluate(`__sessions.pop();__renderer.update(__providers,__sessions)`);
  assert.equal(await b.evaluate('__renderer.props.size'),2);
  assert.equal(await b.evaluate(`__renderer.scene.children.filter(c=>c.userData.prop).length`),2);
  await b.evaluate(`__renderer.setWorld('orbital','dark')`);
  await b.wait(`__renderer.skin==='orbital' && [...__renderer.props.values()].every(p=>p.model)`);
  assert.equal(await b.evaluate(`__renderer.cache.has('guild_station')`),false,'the old world prop is released');
  await b.evaluate('__renderer.dispose()');
  assert.deepEqual(b.errors,[]);
});

test('marks show reported state over the crew and leave every character\'s motion as it was',options,async t=>{
  const {f,b}=await setup(t);
  const T0=Date.parse('2026-10-13T12:00:00.000Z'),iso=ms=>new Date(T0-ms).toISOString();
  const sessions=[...f.data.values()].slice(0,2).map(s=>({...s,activity:'active',lastOutputAt:iso(0),createdAt:iso(3600000),agents:[],shells:[]}));
  await b.evaluate(`(async()=>{
    const {YardRenderer}=await import('/yard/renderer.js');
    const make=async()=>{const host=document.createElement('div'),labels=document.createElement('div');
      host.style.cssText='position:fixed;width:900px;height:700px;top:0;left:0';host.append(labels);document.body.append(host);
      const r=new YardRenderer(host,labels,{select(){},open(){},clock:()=>${T0}});await r.setWorld('guild','dark');r.update(${q(f.providers)},${q(sessions)});return r;};
    window.__renderer=await make();window.__plain=await make();__plain.mark=()=>{};__plain.stepMarks=()=>{};
    window.__sessions=${q(sessions)};window.__providers=${q(f.providers)};
    window.__set=(i,patch)=>{Object.assign(__sessions[i],patch);for(const r of [__renderer,__plain])r.update(__providers,structuredClone(__sessions));};
    window.__pose=r=>[...r.units.values()].map(u=>[u.root.position.x,u.root.position.z,u.heading,u.clip,u.action?.time]);
    window.__marks=id=>[...(__renderer.units.get(id).marks||new Map()).values()].map(m=>m.anchor+':'+m.kind+':'+m.alpha);
    window.__sprites=id=>[...__renderer.units.get(id).marks.values()].flatMap(m=>m.sprites).map(s=>[s.visible,+s.position.y.toFixed(3),+s.material.opacity.toFixed(3)]);
  })()`);
  const [a,c]=sessions.map(s=>s.id);
  await b.wait('[__renderer,__plain].every(r=>[...r.units.values()].every(u=>u.loaded))');
  const motion=[];
  const steps=n=>b.evaluate(`(()=>{const out=[];for(let i=0;i<${n};i++){__renderer.step(.05);__plain.step(.05);out.push([__pose(__renderer),__pose(__plain)]);}return out;})()`).then(out=>motion.push(...out));
  assert.deepEqual(await b.evaluate(`__marks(${q(a)})`),[],'a working character has no mark');
  // Quiet for a minute: it walks to the plaza with no mark, then falls asleep there.
  await b.evaluate(`__set(0,{activity:'quiet',lastOutputAt:${q(iso(60000))}})`);
  assert.equal(await b.evaluate(`__renderer.units.get(${q(a)}).moving`),true);
  await steps(5);
  assert.deepEqual(await b.evaluate(`__marks(${q(a)})`),[':asleep:0'],'no zzz while it walks');
  await b.evaluate(`(()=>{let n=0;while(__renderer.units.get(${q(a)}).moving&&n<4000){__renderer.step(.05);__plain.step(.05);n++;}})()`);
  await steps(10);
  assert.deepEqual(await b.evaluate(`__marks(${q(a)})`),[':asleep:1'],'it fades in once the character rests');
  const before=await b.evaluate(`__sprites(${q(a)})`);
  assert.equal(before.length,3);assert.ok(before.every(([visible])=>visible));
  await steps(10);
  assert.notDeepEqual(await b.evaluate(`__sprites(${q(a)})`),before,'the zzz drifts');
  // A helper ends the nap; a waiting one is marked over itself once it is shown.
  await b.evaluate(`__set(0,{agents:[{id:'w',name:'W',status:'waiting'}]})`);
  await b.wait(`__renderer.units.get(${q(a)}).helpers.length===1`);
  await steps(10);
  assert.deepEqual(await b.evaluate(`__marks(${q(a)})`),['w:waiting:1'],'the zzz fades out and the helper carries the mark');
  assert.ok(await b.evaluate(`(([m],h)=>m.sprites[0].position.y>h.model.position.y+h.top)([...__renderer.units.get(${q(a)}).marks.values()],__renderer.units.get(${q(a)}).helpers[0])`));
  // A waiting helper past the six shown is marked over its character instead.
  await b.evaluate(`__set(0,{agents:Array.from({length:7},(_,i)=>({id:'h'+i,name:'H'+i,status:i===6?'waiting':'working'}))})`);
  await steps(10);
  assert.deepEqual(await b.evaluate(`__marks(${q(a)})`),[':waiting:1']);
  // A failed exit is marked red; a clean one swaps to the white mark.
  await b.evaluate(`__set(1,{status:'exited',exitCode:1,activity:'quiet',agents:[],shells:[]})`);
  await steps(10);
  assert.deepEqual(await b.evaluate(`__marks(${q(c)})`),[':failed:1']);
  await b.evaluate(`__set(1,{exitCode:0})`);
  await steps(10);
  assert.deepEqual(await b.evaluate(`__marks(${q(c)})`),[':exited:1']);
  assert.equal(await b.evaluate(`__renderer.marks.children.length`),await b.evaluate(`[...__renderer.units.values()].reduce((n,u)=>n+[...u.marks.values()].reduce((k,m)=>k+m.sprites.length,0),0)`),'spent marks are released');
  for(const [i,[marked,plain]]of motion.entries())assert.deepEqual(marked,plain,`step ${i}: marks change no character's motion`);
  // Reduced motion holds the zzz still.
  await b.evaluate(`__set(0,{agents:[]});for(const r of [__renderer,__plain])r.setReducedMotion(true);__renderer.stepMarks(0)`);
  const still=await b.evaluate(`__sprites(${q(a)})`);
  await b.evaluate('__renderer.stepMarks(0)');
  assert.deepEqual(await b.evaluate(`__sprites(${q(a)})`),still);
  assert.ok(still.every(([visible])=>visible));
  await b.evaluate('__renderer.dispose();__plain.dispose()');
  assert.deepEqual(b.errors,[]);
});

test('a mark drawn before its glyph loads is drawn again once it loads, with reduced motion and nothing else changing',options,async t=>{
  const {f,b}=await setup(t);
  const T0=Date.parse('2026-10-13T12:00:00.000Z'),iso=ms=>new Date(T0-ms).toISOString();
  const sessions=[{...[...f.data.values()][0],activity:'quiet',lastOutputAt:iso(60000),createdAt:iso(3600000),agents:[],shells:[]}];
  await b.evaluate(`(async()=>{
    const T=await import('/yard/vendor/engine.js'),{YardRenderer}=await import('/yard/renderer.js');
    const host=document.createElement('div'),labels=document.createElement('div');
    host.style.cssText='position:fixed;width:900px;height:700px;top:0;left:0';host.append(labels);document.body.append(host);
    window.__renderer=new YardRenderer(host,labels,{select(){},open(){},clock:()=>${T0}});
    await __renderer.setWorld('guild','dark');
    __renderer.setReducedMotion(true);__renderer.setActive(true);
    const load=T.TextureLoader.prototype.load;window.__held=[];
    T.TextureLoader.prototype.load=function(url,onLoad,...rest){return load.call(this,url,url.startsWith('data:')?texture=>__held.push(()=>onLoad?.(texture)):onLoad,...rest);};
    const render=__renderer.renderer.render.bind(__renderer.renderer);window.__draws=0;
    __renderer.renderer.render=(...args)=>{__draws++;return render(...args);};
    __renderer.update(${q(f.providers)},${q(sessions)});
  })()`);
  await b.wait('__held.length===2 && [...__renderer.units.values()].every(u=>u.loaded)');
  await b.wait('__renderer.frame===0 && !__renderer.dirty');
  const idle=await b.evaluate('__draws');
  await nextFrames(b);
  assert.equal(await b.evaluate('__draws'),idle,'the scene is idle while the glyph is still loading');
  await b.evaluate('__held.splice(0).forEach(release=>release())');
  await b.wait(`__draws>${idle}`);
  assert.ok(await b.evaluate(`[...__renderer.units.get(${q(sessions[0].id)}).marks.values()].every(m=>m.sprites.every(s=>s.visible&&s.material.map.image))`));
  const drawn=await b.evaluate('__draws');
  await nextFrames(b);
  assert.equal(await b.evaluate('__draws'),drawn,'and idle again after one redraw');
  await b.evaluate('__renderer.dispose()');
  assert.deepEqual(b.errors,[]);
});

test('Cards and Yard use the same actions, accounts, dialogs and terminal',options,async t=>{
  const {f,b}=await setup(t);
  await b.wait("document.querySelector('#providers .usage .meter')");
  assert.equal(b.requests.some(r=>/\/yard\/(assets|vendor|renderer)/.test(r.url)),false,'Cards does not load the world or graphics engine');
  await b.click('#providers [data-id="anthropic"] .card-toggle');
  await fill(b,'#cwd','E:\\projects\\parity');
  await b.click('#providers [data-id="anthropic"] [data-account="work"]');
  await b.click('#providers [data-id="anthropic"] .new');await terminalReady(b);
  const fromCards=f.calls.find(c=>c[0]==='create')[1];
  const terminal=await b.evaluate("window.__terminal=document.querySelector('.terminal-host .xterm');Boolean(window.__terminal)");
  assert.equal(terminal,true);
  const sockets=b.events.filter(e=>e.method==='Network.webSocketCreated').length;
  await b.click('#view-yard');await ready(b);
  assert.equal(await b.evaluate("window.__terminal===document.querySelector('.terminal-host .xterm')"),true);
  assert.equal(b.events.filter(e=>e.method==='Network.webSocketCreated').length,sockets,'switching does not replace sockets');
  await closeTerminal(b);await b.click(provider('anthropic'));
  assert.deepEqual(await b.evaluate(`(()=>{const c=document.querySelector('${inspector} .provider');return [c.classList.contains('collapsed'),c.querySelector('.card-toggle').hidden,c.querySelector('.usage').checkVisibility()]})()`),[false,true,true],'the Yard shows the whole card a collapsed Cards card stands for, with no collapse control');
  assert.equal(await b.evaluate(`document.querySelector('${inspector} [data-account="work"]').getAttribute('aria-selected')`),'true');
  await b.click(inspector+' .new');await terminalReady(b);
  assert.deepEqual(f.calls.filter(c=>c[0]==='create').at(-1)[1],fromCards,'identical request body in both views');
  await closeTerminal(b);
  await b.click(inspector+' [data-account="default"]');
  await b.click('#view-cards');
  assert.equal(await b.evaluate("document.querySelector('#providers [data-id=anthropic] [data-account=default]').getAttribute('aria-selected')"),'true','account selection updates both layouts');
  await b.click('#view-yard');await b.click(inspector+' [data-account="work"]');
  assert.ok(await b.evaluate(`document.querySelector('${inspector} .usage').textContent.includes('32%')`),'work account usage is current');
  await b.click(inspector+' .model-stats-head');await b.wait("document.querySelector('#models').open");
  assert.match(await b.evaluate("document.querySelector('#models-list').textContent"),/Preview model/);
  await b.click('#models-close');
  await b.click(inspector+' .existing');await b.wait("document.querySelector('#history-list [data-id=history-1]')");
  assert.deepEqual(f.calls.filter(c=>c[0]==='history').at(-1),['history','anthropic','work']);
  await b.click('#history-list [data-id="history-1"] .history-resume');await terminalReady(b);
  assert.equal(f.calls.filter(c=>c[0]==='create').at(-1)[1].cwd,'E:\\projects\\example');
  await closeTerminal(b);
  const creates=f.calls.filter(c=>c[0]==='create').length;
  // The dialog opens before its rows load, so each wait is for the row it clicks.
  await b.click(inspector+' .existing');await b.wait("document.querySelector('#history-list [data-id=history-1] .history-resume')");
  await b.click('#history-list [data-id="history-1"] .history-resume');await terminalReady(b);
  assert.equal(f.calls.filter(c=>c[0]==='create').length,creates,'history reuses the running session');
  await closeTerminal(b);
  await b.click(inspector+' .existing');await b.wait("document.querySelector('#history-list [data-id=history-missing] .history-resume')");
  await b.click('#history-list [data-id="history-missing"] .history-resume');await terminalReady(b);
  assert.deepEqual(f.calls.filter(c=>c[0]==='create').slice(-2).map(c=>c[1].cwd),['missing','E:\\projects\\parity']);
  await closeTerminal(b);
  await b.click(inspector+' .update');await terminalReady(b);
  assert.equal(f.calls.filter(c=>c[0]==='install').at(-1)[1],'anthropic');
  await closeTerminal(b);
  await b.click(provider('google'));await b.click(inspector+' .reporting-toggle');
  await until(()=>f.calls.some(c=>c[0]==='reporting'));
  assert.deepEqual(f.calls.find(c=>c[0]==='reporting'),['reporting','google',true]);
  await b.wait(`document.querySelector('${inspector} .reporting-text').textContent.includes('on')`);
  f.providers[3].available=false;f.registry.emit('updated');
  await b.click(provider('xai'));await b.wait(`document.querySelector('${inspector} .install')?.hidden===false`);
  await b.click(inspector+' .install');await terminalReady(b);await closeTerminal(b);
  assert.equal(f.calls.filter(c=>c[0]==='install').at(-1)[1],'xai');

  const id=[...f.data.keys()][0];
  await b.click(session(id));await b.click(inspector+' .rename');await answer(b,'Renamed from Yard');
  await b.wait(`document.querySelector('${inspector} .name').textContent==='Renamed from Yard'`);
  assert.equal(f.data.get(id).name,'Renamed from Yard');
  await b.click(inspector+' .stop');await answer(b);await b.wait(`document.querySelector('${inspector} .resume').hidden===false`);
  await b.click(inspector+' .resume');await terminalReady(b);await closeTerminal(b);
  assert.equal(f.calls.filter(c=>c[0]==='create').at(-1)[1].resume,f.data.get(id).toolSessionId);
  await b.click(inspector+' .remove');await b.wait(`!document.querySelector(${q(session(id))})`);
  assert.equal(f.data.has(id),false);assert.equal(await b.evaluate("document.querySelector('#yard-inspector').children.length"),0);
  await b.click('#yard-news');await b.wait("document.querySelector('#news').open");await b.click('#news-close');
  // Opening it is checked in dialogs.mjs, which keeps the page away from YouTube.
  await b.wait("document.querySelector('#yard-videos').checkVisibility()");
  await b.click('#version');await b.wait("document.querySelector('#changelog').open");await b.click('#changelog-close');

  await b.click('#github-open');await b.wait("document.querySelector('#github-list .github-action') && !document.querySelector('#github-list .github-action').disabled");
  await b.click('#github-list .github-action');await terminalReady(b);await closeTerminal(b);
  assert.deepEqual(f.calls.find(c=>c[0]==='clone')[1],{account:42,repo:'preview/demo',parent:'E:\\projects\\parity'});
  const clone=[...f.data.values()].find(s=>s.task==='clone');f.manager.stop(clone.id);
  await b.click(session(clone.id));await b.wait(`document.querySelector('${inspector} .use-folder').hidden===false`);
  await b.click(inspector+' .use-folder');
  assert.equal(await b.evaluate("document.querySelector('#cwd').value"),clone.clone.path);
  await b.click('#github-open');await b.wait("!document.querySelector('#github-new').hidden");await b.click('#github-new');
  await fill(b,'#github-create-name','new-yard-project');
  await b.evaluate("document.querySelector('#github-create-clone').checked=false");
  await b.click('#github-create-submit');await until(()=>f.calls.some(c=>c[0]==='create-repo'));
  assert.deepEqual(f.calls.find(c=>c[0]==='create-repo').slice(1),['42',{owner:'preview',name:'new-yard-project',description:null,private:true,readme:true}]);
  await b.click('#dock-close');
  await b.click('#upgrade');await terminalReady(b);assert.ok(f.calls.some(c=>c[0]==='upgrade'));await closeTerminal(b);
  assert.deepEqual(b.errors,[]);
});

test('the Yard follows the theme, and its view choice lives in Settings, out of the top bar',options,async t=>{
  const {b}=await setup(t,{yard:true});await ready(b);
  const choose=async selector=>{
    await b.click('#settings');await b.click(selector);
    await b.evaluate("document.querySelector('#settings-menu').hidePopover()");
  };
  await b.wait("document.querySelector('#yard-stage').dataset.world==='guild' && document.documentElement.dataset.view==='yard'");
  assert.equal(await b.evaluate("document.querySelector('#view-yard').checked"),true);
  assert.equal(await b.evaluate("['#view-cards','#view-yard'].every(s=>document.querySelector(s).closest('#settings-menu'))"),true,'the view choice is in Settings');
  for (const theme of ['light','dark']) {
    await choose(`input[name=theme][value=${theme}]`);
    await b.wait(`document.documentElement.dataset.theme===${q(theme)} && document.querySelector('#yard-stage').dataset.world==='guild' && document.querySelector('#yard-failure').hidden`);
  }
  await choose('#view-cards');
  await b.wait("document.documentElement.dataset.view==='cards' && document.querySelector('#view-cards').checked");
  await choose('#view-yard');
  await b.wait("document.documentElement.dataset.view==='yard' && document.querySelector('#view-yard').checked");
  await b.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await nextFrames(b);
  assert.equal(await b.evaluate('document.documentElement.scrollWidth>innerWidth'),false,'no sideways scroll on a phone');
  assert.deepEqual(b.errors,[]);
});

test('Yard retains every session through skins, reduced motion, mobile and reconnect',options,async t=>{
  const {f,b}=await setup(t,{yard:true});await ready(b);
  for(let i=0;i<34;i++)f.add({providerId:'anthropic',name:'Extra session '+i,quiet:true});
  await b.wait("document.querySelectorAll('.yard-row[data-key^=\"session:\"]').length===40");
  const last=[...f.data.values()].at(-1);await b.click(session(last.id));
  await b.click('#yard-focus');
  for(const skin of ['orbital','grove','professional','goblinville','gnomeland','guild']){
    await b.click('#settings');await b.click(`input[name=skin][value=${skin}]`);
    await b.evaluate("document.querySelector('#settings-menu').hidePopover()");
    await b.wait(`document.documentElement.dataset.skin===${q(skin)}`);
    await b.wait(`document.querySelector('#yard-stage').dataset.world===${q(skin)}`);
    assert.equal(await b.evaluate(`document.querySelector('${inspector} .session-card').dataset.id`),last.id);
    assert.equal(await b.evaluate("document.querySelector('#yard-failure').hidden"),true);
  }
  const frames=await framesSettled(b);
  assert.ok(frames>0,'the scene rendered');
  const before=await b.evaluate('window.__frames');
  await nextFrames(b);
  assert.equal(await b.evaluate('window.__frames')-before,2,'reduced motion renders only on changes');
  await b.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await nextFrames(b);
  assert.equal(await b.evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'no horizontal overflow on mobile');
  await fill(b,'#yard-filter',last.name);
  assert.equal(await b.evaluate("[...document.querySelectorAll('.yard-row')].filter(x=>!x.hidden).length"),1);
  await b.click(session(last.id));await b.click(inspector+' .open');await terminalReady(b);await closeTerminal(b);
  f.data.delete(last.id);f.manager.emit('event',{type:'hello',version:'1.0.0',pid:process.pid,sessions:f.manager.list()});
  await b.wait("document.querySelector('#yard-inspector').children.length===0");
  assert.deepEqual(b.errors,[]);
});

test('the latest skin wins during initial loading and an interrupted world switch',options,async t=>{
  const {b}=await setup(t,{yard:true,source:`
    const originalFetch=window.fetch;
    window.__gates={};window.__holdWorlds=true;
    window.fetch=(...args)=>{
      const url=String(args[0]?.url||args[0]);
      const name=url.match(/\\/(guild|orbital)\\.glb$/)?.[1];
      if(!window.__holdWorlds||!name)return originalFetch(...args);
      return new Promise((resolve,reject)=>{window.__gates[name]=()=>originalFetch(...args).then(resolve,reject);});
    };`});
  await b.wait('window.__gates.guild');
  await b.evaluate("document.documentElement.dataset.skin='grove';window.__gates.guild()");
  await ready(b);await b.wait("document.querySelector('#yard-stage').dataset.world==='grove'");
  await b.evaluate("document.documentElement.dataset.skin='orbital'");
  await b.wait('window.__gates.orbital');
  await b.evaluate("document.documentElement.dataset.skin='grove'");
  await nextFrames(b);
  await b.evaluate('window.__gates.orbital()');
  await framesSettled(b);
  assert.equal(await b.evaluate("document.querySelector('#yard-stage').dataset.world"),'grove');
  assert.deepEqual(b.errors,[]);
});

test('a context lost during initialization cancels the load and Retry starts a fresh scene',options,async t=>{
  const {b}=await setup(t,{yard:true,source:`
    const originalFetch=window.fetch;
    window.__pendingWorld=false;window.__abortedWorld=false;
    window.fetch=(...args)=>{
      const request=args[0];
      if(!window.__pendingWorld && String(request?.url||request).endsWith('/guild.glb')) {
        window.__pendingWorld=true;
        return new Promise((resolve,reject)=>{
          const signal=request.signal||args[1]?.signal;
          signal.addEventListener('abort',()=>{window.__abortedWorld=true;reject(new DOMException('Aborted','AbortError'));},{once:true});
        });
      }
      return originalFetch(...args);
    };`});
  await b.wait('window.__pendingWorld');
  await b.evaluate("document.querySelector('#yard-stage canvas').dispatchEvent(new Event('webglcontextlost',{cancelable:true}))");
  await b.wait("document.querySelector('#yard-failure').hidden===false");
  assert.equal(await b.evaluate('window.__abortedWorld'),true,'the obsolete world request is aborted');
  await b.click('#yard-retry');await ready(b);
  assert.equal(await b.evaluate("document.querySelectorAll('#yard-stage canvas').length"),1);
  assert.deepEqual(b.errors,[]);
});

test('roster filtering and selection removal preserve keyboard access',options,async t=>{
  const {f,b}=await setup(t,{yard:true});await ready(b);
  await fill(b,'#yard-filter','not-a-session-name');
  await b.wait("document.querySelector('#yard-no-results')?.hidden===false");
  await fill(b,'#yard-filter','');
  const id=[...f.data.keys()][0];
  await b.click(session(id));
  await b.evaluate(`document.querySelector('${inspector} .open').focus()`);
  f.manager.remove(id);
  await b.wait("document.activeElement.id==='yard-filter'");
  const next=[...f.data.keys()][0];
  await b.click(session(next));
  await b.evaluate("document.querySelector('#yard-stage').focus()");
  await b.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await b.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await terminalReady(b);
  assert.equal(await b.evaluate("document.querySelector('#panel-title').textContent"),f.data.get(next).name);
  assert.deepEqual(b.errors,[]);
});

test('the side panel never covers the Yard sidebar: it docks beside it, or makes way for a selection',options,async t=>{
  const {f,b}=await setup(t,{yard:true});await ready(b);
  const layout=()=>b.evaluate(`(()=>{const side=document.querySelector('.yard-sidebar').getBoundingClientRect(),dock=document.querySelector('#dock');
    const r=dock.getBoundingClientRect(),hit=document.elementFromPoint(side.left+side.width/2,side.top+side.height/2);
    return {open:!dock.hidden,clear:dock.hidden||side.right<=r.left+1,sidebarOnTop:Boolean(hit?.closest('.yard-sidebar'))};})()`);
  const id=[...f.data.keys()][0];
  await b.click('#notes-open');
  await b.wait("!document.querySelector('#dock').hidden");
  await nextFrames(b);
  assert.deepEqual(await layout(),{open:true,clear:true,sidebarOnTop:true},'a wide window docks the panel beside the sidebar');
  await b.click(session(id));
  assert.deepEqual(await layout(),{open:true,clear:true,sidebarOnTop:true},'a selection keeps a panel that covers nothing');
  await b.send('Emulation.setDeviceMetricsOverride',{width:1100,height:900,deviceScaleFactor:1,mobile:false});
  await nextFrames(b);
  assert.deepEqual(await layout(),{open:true,clear:false,sidebarOnTop:false},'a mid-size window lays the panel over the sidebar');
  await b.click(provider('anthropic'));
  assert.deepEqual(await layout(),{open:false,clear:true,sidebarOnTop:true},'selecting shows the inspector instead');
  assert.equal(await b.evaluate(`document.querySelector('${inspector} .provider')?.dataset.id`),'anthropic');
  assert.deepEqual(b.errors,[]);
});

test('a stalled world times out, aborts its request and can be retried',options,async t=>{
  const {b}=await setup(t,{yard:true,source:`
    const originalTimeout=window.setTimeout,originalFetch=window.fetch;
    window.__stallWorld=true;window.__abortedWorld=false;
    window.setTimeout=(callback,delay,...args)=>originalTimeout(callback,window.__stallWorld && delay===30000?0:delay,...args);
    window.fetch=(...args)=>{
      const request=args[0];
      if(window.__stallWorld && String(request?.url||request).endsWith('.glb')) {
        return new Promise((resolve,reject)=>{
          const signal=request.signal||args[1]?.signal;
          signal.addEventListener('abort',()=>{window.__abortedWorld=true;reject(new DOMException('Aborted','AbortError'));},{once:true});
        });
      }
      return originalFetch(...args);
    };`});
  await b.wait("document.querySelector('#yard-failure').hidden===false");
  assert.equal(await b.evaluate('window.__abortedWorld'),true);
  await b.click(provider('anthropic'));
  assert.equal(await b.evaluate(`document.querySelector('${inspector} .new').hidden`),false);
  await b.evaluate('window.__stallWorld=false');await b.click('#yard-retry');await ready(b);
  assert.deepEqual(b.errors,[]);
});

// Deterministic: a fixed clock, viewport and camera, layouts run by hand,
// and animation driven by tick() at fixed timestamps.
test('a crowd hides the tags it cannot fit, counts them on its hall, and lists them from there',options,async t=>{
  const {f,b}=await setup(t);
  const T0=Date.parse('2026-10-13T12:00:00.000Z'),iso=ms=>new Date(T0-ms).toISOString();
  const base=[...f.data.values()][0];
  const sessions=Array.from({length:16},(_,i)=>({...base,id:'crowd'+i,name:'Crowd '+i,activity:'active',lastOutputAt:iso(0),createdAt:iso(3600000),agents:[],shells:[]}));
  // Clones have no hall, so no chip to count them.
  sessions.push(...Array.from({length:6},(_,i)=>({...sessions[0],id:'clone'+i,name:'Clone '+i,provider:{id:'github',vendor:'GitHub',tool:'Git',color:'#24292f'}})));
  await b.evaluate(`(async()=>{
    const {YardRenderer}=await import('/yard/renderer.js');
    const host=document.createElement('div'),labels=document.createElement('div');
    host.style.cssText='position:fixed;width:900px;height:700px;top:0;left:0';labels.className='yard-labels';host.append(labels);document.body.append(host);window.__host=host;
    window.__opened=[];
    window.__renderer=new YardRenderer(host,labels,{select(s){__renderer.select(s);},open(id){__opened.push(id);},clock:()=>${T0}});
    window.__sessions=${q(sessions)};window.__providers=${q(f.providers)};
    await __renderer.setWorld('guild','dark');__renderer.update(__providers,__sessions);
    window.__hall=__renderer.halls.get(${q(base.provider.id)});
    window.__shown=el=>el.style.visibility!=='hidden';
    window.__hidden=()=>[...__renderer.units.entries()].filter(([,u])=>!__shown(u.label)&&!u.offscreen).map(([id])=>id).filter(id=>id.startsWith('crowd'));
    window.__clones=()=>[...__renderer.units.entries()].filter(([id,u])=>id.startsWith('clone')&&!__shown(u.label)).map(([id])=>id);
    window.__layout=()=>{
      __renderer.positionLabels();
      const r=__renderer,box=el=>el.getBoundingClientRect(),hits=(a,c)=>a.left<c.right&&c.left<a.right&&a.top<c.bottom&&c.top<a.bottom;
      const tags=[...r.halls.values()].flatMap(i=>[{el:i.label,keep:true},{el:i.chip,keep:true}])
        .concat([...r.units.entries()].map(([id,u])=>({el:u.label,keep:r.selected?.id===id||!r.halls.has(u.session.provider.id),unit:u}))).filter(x=>__shown(x.el));
      const overlaps=[],far=[];
      for(const [i,a]of tags.entries())for(const c of tags.slice(i+1))if(!(a.keep&&c.keep)&&hits(box(a.el),box(c.el)))overlaps.push([a.el.textContent,c.el.textContent]);
      for(const x of tags)if(x.unit&&!x.keep){
        const v=x.unit.root.position.clone();v.y+=2.4;v.project(r.camera);
        const rise=(-v.y*.5+.5)*700-box(x.el).bottom;
        if(rise>2*(box(x.el).height+6)+.5)far.push([x.el.textContent,rise]);
      }
      const chip=box(__hall.chip);
      return {overlaps,far,hidden:__hidden(),shown:[...r.units.values()].filter(u=>__shown(u.label)).length,
        chip:__shown(__hall.chip)?__hall.chip.textContent:'',chipInside:chip.left>=0&&chip.right<=900&&chip.top>=0&&chip.bottom<=700,
        hall:__shown(__hall.label),clones:__clones()};
    };
  })()`);
  await b.wait('[...__renderer.units.values()].every(u=>u.loaded)');
  const crowded=async what=>{
    const l=await b.evaluate('__layout()');
    assert.ok(l.hidden.length>0&&l.shown>0,`${what}: some tags show and some hide: ${q(l)}`);
    assert.deepEqual(l.overlaps,[],`${what}: no tag overlaps a character's tag or the chip`);
    assert.deepEqual(l.far,[],`${what}: every shown tag stays near its character`);
    assert.ok(l.hall&&l.chipInside,`${what}: the hall's tag and chip show on screen`);
    assert.equal(l.chip,'+'+l.hidden.length,`${what}: the chip counts the hidden tags`);
    assert.deepEqual(l.clones,[],`${what}: sessions with no hall keep their tags`);
    return l;
  };
  const overview=await crowded('overview');
  await b.evaluate('__renderer.camera.zoom=__renderer.controls.minZoom;__renderer.camera.updateProjectionMatrix()');
  await crowded('furthest zoom-out');
  await b.evaluate('__renderer.overview()');
  // The selected tag shows even where it was crowded out.
  const chosen=overview.hidden[0];
  await b.evaluate(`__renderer.select({kind:'session',id:${q(chosen)}})`);
  const lit=await crowded('selected');
  assert.ok(!lit.hidden.includes(chosen),'the selected tag shows');
  await b.evaluate('__renderer.select(null);__layout()');

  // A crowd-hidden character animates every frame, as a shown one does; only
  // an off-screen one waits for 0.2 s.
  const cadence=await b.evaluate(`(()=>{
    const r=__renderer,hid=r.units.get(__hidden()[0]),shown=[...r.units.values()].find(u=>__shown(u.label));
    r.active=true;r.schedule=()=>{};r.lastTime=0;r.tick(1000);
    const time=u=>u.mixers[0].time,before=[time(hid),time(shown)];
    r.tick(1050);r.tick(1100);
    const crowd=[time(hid)-before[0],time(shown)-before[1]];
    r.controls.target.x+=500;r.camera.position.x+=500;r.camera.updateMatrixWorld();r.dirty=true;r.tick(1150);
    const off=time(hid),offscreen=hid.offscreen;
    r.tick(1200);r.tick(1250);r.tick(1300);const waited=time(hid)-off;r.tick(1350);const caught=time(hid)-off;
    r.active=false;delete r.schedule;r.overview();
    return {crowd,offscreen,waited,caught};
  })()`);
  assert.ok(Math.abs(cadence.crowd[0]-.1)<1e-9&&Math.abs(cadence.crowd[1]-.1)<1e-9,`crowd-hidden and shown characters both advance each frame: ${q(cadence)}`);
  assert.ok(cadence.offscreen&&cadence.waited===0&&Math.abs(cadence.caught-.2)<1e-9,`an off-screen character catches up every 0.2 s: ${q(cadence)}`);
  const hidden=(await b.evaluate('__layout()')).hidden;

  // The chip opens a list of the hidden sessions, by keyboard and by click.
  const state=()=>b.evaluate(`(()=>{const list=__renderer.list,a=document.activeElement,box=list.getBoundingClientRect();return {
    open:!list.hidden,expanded:__hall.chip.getAttribute('aria-expanded'),controls:__hall.chip.getAttribute('aria-controls')===list.id,
    rows:[...list.children].map(row=>row.children[0].children[0].textContent),
    focus:a===__hall.chip?'chip':a===document.body?'body':list.contains(a)?'row'+[...list.children].findIndex(r=>r.contains(a))+':'+a.className:a.className,
    inside:list.hidden||(box.left>=0&&box.right<=900&&box.top>=0&&box.bottom<=700),bounded:list.clientHeight<=240};})()`);
  const key=async(k,code,vk)=>{
    await b.send('Input.dispatchKeyEvent',{type:'keyDown',key:k,code,windowsVirtualKeyCode:vk,...(k==='Enter'?{text:'\r'}:{})});
    await b.send('Input.dispatchKeyEvent',{type:'keyUp',key:k,code,windowsVirtualKeyCode:vk});
  };
  const names=hidden.map(id=>sessions.find(s=>s.id===id).name);
  await b.evaluate('__hall.chip.focus()');
  await key('Enter','Enter',13);
  let s=await state();
  assert.deepEqual(s,{open:true,expanded:'true',controls:true,rows:names,focus:'row0:yard-crowd-pick',inside:true,bounded:true},'Enter on the chip opens the list and moves focus into it');
  assert.equal(await b.evaluate(`(()=>{
    const camera=Object.assign(document.createElement('div'),{className:'yard-overlay'});camera.style.cssText='position:absolute;inset:0;pointer-events:auto';__host.append(camera);
    const row=__renderer.list.children[0].getBoundingClientRect(),hit=document.elementFromPoint(row.left+row.width/2,row.top+row.height/2);
    camera.remove();return __renderer.list.contains(hit);
  })()`),true,'the list shows above the camera controls');
  await key('Escape','Escape',27);
  s=await state();
  assert.deepEqual([s.open,s.expanded,s.focus],[false,'false','chip'],'Escape closes it and returns focus to the chip');
  await b.evaluate('__hall.chip.click()');
  await key('Tab','Tab',9);
  s=await state();
  assert.equal(s.focus,'row0:yard-crowd-open','each row has its own terminal button');
  // A rename updates its row in place; when the focused session leaves, focus
  // moves to the row that takes its place.
  await b.evaluate(`__sessions=__sessions.map(x=>x.id===${q(hidden[1])}?{...x,name:'Renamed'}:x);__renderer.update(__providers,__sessions);__renderer.positionLabels()`);
  s=await state();
  assert.equal(s.rows[1],'Renamed','a renamed session updates its row');
  assert.equal(s.focus,'row0:yard-crowd-open','and focus stays put');
  await b.evaluate(`__sessions=__sessions.filter(x=>x.id!==${q(hidden[0])});__renderer.update(__providers,__sessions);__renderer.positionLabels()`);
  s=await state();
  assert.equal(s.rows[0],'Renamed','the session that left drops from the list');
  assert.equal(s.focus,'row0:yard-crowd-open','focus moves to the row now in its place');
  await key('Enter','Enter',13);
  s=await state();
  assert.deepEqual([s.open,await b.evaluate('__opened')],[false,[hidden[1]]],'Open terminal opens that session and closes the list');
  // Picking a session selects it, shows its tag by its character and focuses it.
  await b.evaluate('__hall.chip.click()');
  await key('Enter','Enter',13);
  s=await state();
  assert.equal(s.open,false,'picking a session closes the list');
  assert.deepEqual(await b.evaluate(`[__renderer.selected?.id,__shown(__renderer.units.get(${q(hidden[1])}).label),document.activeElement===__renderer.units.get(${q(hidden[1])}).label]`),[hidden[1],true,true],'and selects it, showing and focusing its tag');
  // A click on the stage closes it too.
  await b.evaluate('__hall.chip.click()');
  assert.equal((await state()).open,true);
  await b.send('Input.dispatchMouseEvent',{type:'mousePressed',x:20,y:680,button:'left',clickCount:1});
  await b.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:20,y:680,button:'left',clickCount:1});
  assert.equal((await state()).open,false,'a click on the stage closes the list');
  await b.evaluate('__renderer.dispose()');
  assert.deepEqual(b.errors,[]);
});

test('a gilded card gets a gold hall and character of its own, and Shell keeps its look',options,async t=>{
  const {f,b}=await setup(t);
  const shell=f.providers.find(p=>p.id==='shell'),gold={...shell,id:'terminal-ai-chat',tool:'Terminal AI Chat'};
  const base=[...f.data.values()][0];
  const sessions=[{...base,id:'gold',provider:gold,agents:[],shells:[]},{...base,id:'plain',provider:shell,agents:[],shells:[]}];
  const looks=await b.evaluate(`(async()=>{
    const {YardRenderer}=await import('/yard/renderer.js');
    const host=document.createElement('div'),labels=document.createElement('div');
    host.style.cssText='position:fixed;width:900px;height:700px;top:0;left:0';host.append(labels);document.body.append(host);
    window.__renderer=new YardRenderer(host,labels,{select(){},open(){}});
    await __renderer.setWorld('guild','dark');__renderer.update(${q([...f.providers,gold])},${q(sessions)});
    while(![...__renderer.units.values()].every(u=>u.loaded))await new Promise(requestAnimationFrame);
    const materials=root=>{const all=new Set();root.traverse(n=>{if(n.isMesh)for(const m of [n.material].flat())all.add(m);});return [...all];};
    const plain=m=>m.onBeforeCompile===Object.getPrototypeOf(m).onBeforeCompile;
    const look=root=>({materials:materials(root),bare:materials(root).filter(m=>!/^(window|magic|officeGlass)$/.test(m.name))});
    const goldHall=look(__renderer.halls.get('terminal-ai-chat').root),shellHall=look(__renderer.halls.get('shell').root);
    const goldUnit=look(__renderer.units.get('gold').model),shellUnit=look(__renderer.units.get('plain').model);
    return {
      hallShared:goldHall.materials.filter(m=>shellHall.materials.includes(m)).length,
      hallGilded:goldHall.bare.length>0&&goldHall.bare.every(m=>!plain(m)),
      unitShared:goldUnit.materials.filter(m=>shellUnit.materials.includes(m)).length,
      unitGilded:goldUnit.bare.every(m=>!plain(m)),
      shellPlain:[...shellHall.materials,...shellUnit.materials].every(plain),
    };
  })()`);
  assert.deepEqual(looks,{hallShared:0,hallGilded:true,unitShared:0,unitGilded:true,shellPlain:true});
  await b.evaluate('__renderer.dispose()');
  assert.deepEqual(b.errors,[]);
});

test('a capture draws twice the stage in tiles without the selection ring, and leaves the live view as it was even when it fails',options,async t=>{
  const {f,b}=await setup(t);
  const sessions=[...f.data.values()];
  const result=await b.evaluate(`(async()=>{
    const {YardRenderer}=await import('/yard/renderer.js');
    const host=document.createElement('div'),labels=document.createElement('div');
    host.style.cssText='position:fixed;width:900px;height:700px;top:0;left:0';labels.className='yard-labels';host.append(labels);document.body.append(host);
    const r=new YardRenderer(host,labels,{select(){},open(){}});
    await r.setWorld('guild','dark');r.update(${q(f.providers)},${q(sessions)});
    const id=${q(sessions[0].id)},ring=r.units.get(id).ring;
    r.select({kind:'session',id});r.fireworks();r.updateSparks(.8);
    const gl=r.renderer.getContext();
    const live=()=>[ring.scale.x,ring.material.color.getHex(),r.camera.view?.enabled??false,r.camera.projectionMatrix.elements.join(),
      [...gl.getParameter(gl.VIEWPORT)],r.effects.points.material.uniforms.scale.value,r.canvas.width,r.canvas.height,r.sparks.find(s=>s.firework)?.points.material.size];
    const before=live(),renders=[],render=r.renderer.render.bind(r.renderer);
    let fail=0;
    r.renderer.render=(scene,camera)=>{renders.push([ring.scale.x,ring.material.color.getHex(),camera.view?.enabled??false]);if(fail&&renders.length===fail)throw new Error('lost');render(scene,camera);};
    const shot=r.capture(),ok={size:[shot.canvas.width,shot.canvas.height],scale:shot.scale,skin:shot.skin,renders:[...renders],after:live(),tags:shot.tags.length};
    renders.length=0;fail=2;
    let threw=false;try{r.capture();}catch{threw=true;}
    const result={before,ok,threw,failed:{renders:[...renders],after:live()},provider:new (await import('/yard/vendor/engine.js')).Color(${q(sessions[0].provider.color||'#baaa80')}).getHex()};
    r.dispose();host.remove();
    return result;
  })()`);
  const plain=[1,result.provider,true],restored=[1.15,0xffdf92,false];
  assert.deepEqual(result.ok.size,[1800,1400]);
  assert.equal(result.ok.scale,2);
  assert.equal(result.ok.skin,'guild');
  assert.ok(result.ok.tags>0);
  assert.deepEqual(result.ok.renders,[plain,plain,plain,plain,restored]);
  assert.deepEqual(result.ok.after,result.before);
  assert.equal(result.threw,true);
  assert.deepEqual(result.failed.renders,[plain,plain,restored]);
  assert.deepEqual(result.failed.after,result.before);
});

test('capture preserves particles across tile edges at different pixel ratios',options,async t=>{
  const {b}=await setup(t);
  const results=await b.evaluate(`(async()=>{
    const {YardRenderer}=await import('/yard/renderer.js');
    const T=await import('/yard/vendor/engine.js'),{WORLDS}=await import('/yard/model.mjs');
    const host=document.createElement('div'),labels=document.createElement('div');
    host.style.cssText='position:fixed;width:180px;height:140px;top:0;left:0';host.append(labels);document.body.append(host);
    const r=new YardRenderer(host,labels,{select(){},open(){}}),results=[];
    r.world=new T.Group();r.atOverview=false;
    try {
      for(const skin of ['guild','orbital','grove'])for(const ratio of [1,1.5])for(const clipCenters of [false,true]){
        r.releaseEffects();r.makeEffects(WORLDS[skin].effect);
        // Some backends expand points before clipping. Also exercise the
        // center-clipping behavior that loses sprites outside a tile's frustum.
        if(clipCenters)r.effects.points.material.vertexShader=r.effects.points.material.vertexShader.replace('gl_PointSize=',
          'if(any(greaterThan(abs(gl_Position.xy),vec2(gl_Position.w))))gl_Position.z=2.*gl_Position.w;gl_PointSize=');
        r.renderer.setPixelRatio(2);r.resize();r.camera.zoom=r.controls.maxZoom;r.camera.updateProjectionMatrix();
        r.camera.updateMatrixWorld();
        const {geometry}=r.effects.points;let index=0;
        // Place centers on both sides of horizontal and vertical tile seams.
        for(const x of [179.5,180.5,269.5,270.5])for(const y of [139.5,140.5,209.5,210.5]){
          const p=new T.Vector3(x/360*2-1,1-y/280*2,0).unproject(r.camera);
          geometry.attributes.position.setXYZ(index,p.x,p.y,p.z);
          geometry.attributes.size.setX(index,Math.max(...r.effects.preset.size));
          geometry.attributes.alpha.setX(index,.7);index++;
        }
        geometry.setDrawRange(0,index);
        r.renderer.render(r.scene,r.camera);
        const reference=Object.assign(document.createElement('canvas'),{width:360,height:280}),context=reference.getContext('2d');
        context.drawImage(r.canvas,0,0);
        const expected=context.getImageData(0,0,360,280).data;
        r.renderer.setPixelRatio(ratio);r.resize();
        const shot=r.capture(),actual=shot.canvas.getContext('2d').getImageData(0,0,360,280).data;
        let maxDelta=0,alpha=0;
        for(let i=0;i<actual.length;i+=4){maxDelta=Math.max(maxDelta,Math.abs(actual[i+3]-expected[i+3]));alpha+=expected[i+3];}
        results.push({skin,ratio,clipCenters,maxDelta,alpha});
      }
    } finally {r.dispose();host.remove();}
    return results;
  })()`);
  for(const result of results){
    assert.ok(result.alpha>0,'the reference contains visible particles');
    assert.ok(result.maxDelta<=2,JSON.stringify(result));
  }
  assert.deepEqual(b.errors,[]);
});

test('Photo opens the picture without labels, adds them on request from the same moment, and copies, saves and shares it',options,async t=>{
  const {b}=await setup(t,{yard:true,source:`
    navigator.canShare=()=>true;
    navigator.share=async data=>{window.__shared=data.files.map(file=>[file.name,file.type,file.size]);};
    navigator.clipboard.write=async items=>{const blob=await items[0].getType('image/png');window.__copied=[blob.type,blob.size];};`});
  await ready(b);
  const downloads=await fs.mkdtemp(path.join(os.tmpdir(),'yard-photo-'));t.after(()=>fs.rm(downloads,{recursive:true,force:true}));
  await b.send('Page.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  assert.equal(await b.evaluate("(e=>!e.hidden&&!e.disabled)(document.querySelector('#yard-photo'))"),true);
  await b.click('.yard-row[data-key^="session:"]');
  await b.wait("[...document.querySelectorAll('#yard-labels .yard-label[data-kind=session]')].some(e=>e.style.visibility!=='hidden')");
  await b.click('#yard-photo');
  await b.wait("document.querySelector('#yard-photo-dialog').open");
  const region=`(()=>{
    const dialog=document.querySelector('#yard-photo-dialog'),preview=dialog.querySelector('canvas'),stage=document.querySelector('#yard-stage');
    const scale=preview.width/stage.clientWidth,origin=stage.getBoundingClientRect();
    const label=[...document.querySelectorAll('#yard-labels .yard-label[data-kind=session]')].find(e=>e.style.visibility!=='hidden').getBoundingClientRect();
    const sum=(x,y,w,h)=>preview.getContext('2d').getImageData(Math.round(x*scale),Math.round(y*scale),Math.round(w*scale),Math.round(h*scale)).data.reduce((a,v)=>a+v,0);
    return {size:[preview.width,preview.height],stage:[stage.clientWidth,stage.clientHeight],label:sum(label.left-origin.left,label.top-origin.top,label.width,label.height),corner:sum(0,0,120,120),
      focused:document.activeElement.textContent,share:!dialog.querySelector('[data-share]').hidden,labels:dialog.querySelector('[data-labels]').checked};
  })()`;
  const off=await b.evaluate(region);
  assert.deepEqual(off.size,off.stage.map(n=>n*2));
  assert.equal(off.focused,'Copy image');
  assert.equal(off.share,true);
  assert.equal(off.labels,false);
  await b.click('#yard-photo-dialog [data-labels]');
  const on=await b.evaluate(region);
  await b.click('#yard-photo-dialog [data-labels]');
  const again=await b.evaluate(region);
  assert.notEqual(on.label,off.label,'labels draw over their tags');
  assert.equal(on.corner,off.corner,'the captured moment stays the same');
  assert.deepEqual(again,off);
  await b.click('#yard-photo-dialog [data-copy]');
  await b.wait("document.querySelector('#yard-photo-dialog [role=status]').textContent==='Copied'");
  await b.click('#yard-photo-dialog [data-save]');
  const name=await b.wait("(t=>t.startsWith('Saved ')&&t.slice(6))(document.querySelector('#yard-photo-dialog [role=status]').textContent)");
  assert.match(name,/^agent-guild-guild-yard-\d{4}-\d{2}-\d{2}\.png$/);
  const file=path.join(downloads,name);
  const png=await until(async()=>{try{const data=await fs.readFile(file);return data.length>24&&data;}catch{return false;}});
  assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],off.size);
  await b.click('#yard-photo-dialog [data-share]');
  await b.wait("document.querySelector('#yard-photo-dialog [role=status]').textContent==='Shared'");
  assert.deepEqual(await b.evaluate('[window.__copied,window.__shared]'),[['image/png',png.length],[[name,'image/png',png.length]]]);
  await b.click('#yard-photo-dialog [data-done]');
  await b.wait("!document.querySelector('#yard-photo-dialog').open&&document.activeElement.id==='yard-photo'");
  assert.deepEqual(b.errors,[]);
});

test('the camera controls stay whole and reachable beside the swap status and help, at every stage width',options,async t=>{
  for(const [width,height,dock] of [[1440,1000],[390,844],[1280,900,700],[1280,900,720]]){
    const name=dock?`${width} with a ${dock}px dock`:String(width);
    const {b}=await setup(t,{yard:true,width,height,source:dock?`localStorage.setItem('agentGuild.dock','notes');localStorage.setItem('agentGuild.dockWidth','${dock}');`:''});
    await ready(b);
    if(dock)await b.wait("document.querySelector('#dock')?.hidden===false");
    for(const status of ['none','yard-swap-failure','yard-loading']){
      const layout=await b.evaluate(`(async()=>{
        const $=s=>document.querySelector(s),R=e=>e.getBoundingClientRect(),status=${q(status)};
        if(status==='yard-swap-failure'){$('#yard-swap-failure-text').textContent='Orbital Station could not load.';$('#yard-swap-failure').hidden=false;}
        if(status==='yard-loading'){$('#yard-loading').dataset.mode='swap';$('#yard-loading-text').textContent='Loading Orbital Station…';$('#yard-loading').hidden=false;}
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const stage=R($('#yard-stage')),bar=R($('.yard-camera'));
        const inside=r=>r.left>=stage.left&&r.right<=stage.right&&r.top>=stage.top&&r.bottom<=stage.bottom;
        const meets=r=>r.left<bar.right&&bar.left<r.right&&r.top<bar.bottom&&bar.top<r.bottom;
        const buttons=[...document.querySelectorAll('.yard-camera .btn:not([hidden])')].map(e=>{const r=R(e);
          return {label:e.getAttribute('aria-label')||e.textContent,inside:inside(r),reached:e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)),height:r.height};});
        const overlaps=['#yard-help',...(status==='none'?[]:['#'+status])].filter(s=>meets(R($(s))));
        $('#yard-swap-failure').hidden=true;$('#yard-loading').hidden=true;
        return {buttons,overlaps};
      })()`);
      const at=`${name}, ${status} shown`;
      assert.deepEqual(layout.buttons.map(c=>c.label),['Zoom in','Zoom out','Overview','Focus selected','Save a picture of the Yard','Fireworks in this Yard only','Vibes Mode'],at);
      assert.deepEqual(layout.buttons.filter(c=>!c.inside||!c.reached).map(c=>c.label),[],at);
      assert.equal(new Set(layout.buttons.map(c=>c.height)).size,1,`every label stays on one line: ${at}`);
      assert.deepEqual(layout.overlaps,[],at);
    }
  }
});

test('Photo says so when its code cannot load',options,async t=>{
  const {b}=await setup(t,{yard:true});
  await ready(b);
  await b.send('Network.enable');
  await b.send('Network.setBlockedURLs',{urls:['*/yard/photo.js']});
  await b.click('#yard-photo');
  await b.wait("document.querySelector('#toast').textContent==='Couldn’t open the picture. Reload the page and try again.'");
  assert.equal(await b.evaluate("document.querySelector('#yard-photo-dialog').open"),false);
  assert.deepEqual(b.errors,[]);
});

test('loading shows progress for the first world and for a swap, then clears',options,async t=>{
  const {b}=await setup(t,{yard:true,source:`
    const originalFetch=window.fetch;
    window.__gates={};window.__released={};window.__sizes=[];
    window.fetch=(...args)=>{
      const url=String(args[0]?.url||args[0]);
      const name=url.match(/\\/(guild|orbital)\\.glb$/)?.[1];
      if(!name||window.__released[name])return originalFetch(...args);
      return new Promise((resolve,reject)=>{window.__gates[name]=()=>{window.__released[name]=true;originalFetch(...args).then(resolve,reject);};});
    };
    addEventListener('DOMContentLoaded',()=>new MutationObserver(()=>{
      const text=document.querySelector('#yard-loading-size').textContent;if(text)window.__sizes.push(text);
    }).observe(document.querySelector('#yard-loading-size'),{childList:true,characterData:true,subtree:true}));`});
  const loading="(e=>!e.hidden&&e.dataset.mode+':'+document.querySelector('#yard-loading-text').textContent)(document.querySelector('#yard-loading'))";
  await b.wait('window.__gates.guild');
  assert.equal(await b.evaluate(loading),'scene:Loading The Guild Yard…');
  await b.evaluate('window.__gates.guild()');await ready(b);
  assert.equal(await b.evaluate("document.querySelector('#yard-loading').hidden"),true);
  assert.ok((await b.evaluate('window.__sizes')).some(text=>/^\d+\.\d MB$/.test(text)),'the first load reports downloaded size');
  await b.evaluate("document.documentElement.dataset.skin='orbital'");
  await b.wait('window.__gates.orbital');
  assert.equal(await b.wait(loading),'swap:Loading Orbital Station…');
  assert.equal(await b.evaluate("document.querySelector('#yard-stage').dataset.world"),'guild','the current world stays up during a swap');
  await b.evaluate('window.__gates.orbital()');
  await b.wait("document.querySelector('#yard-stage').dataset.world==='orbital' && document.querySelector('#yard-loading').hidden");
  assert.deepEqual(b.errors,[]);
});

test('a slow world that keeps downloading is not timed out',options,async t=>{
  const {b}=await setup(t,{yard:true,source:`
    const originalTimeout=window.setTimeout,originalFetch=window.fetch;
    window.__slow=true;
    // A fixed limit of a second would fail this three-second download.
    window.setTimeout=(callback,delay,...args)=>originalTimeout(callback,window.__slow && delay===30000?1000:delay,...args);
    window.fetch=async(...args)=>{
      const response=await originalFetch(...args);
      if(!String(args[0]?.url||args[0]).endsWith('/guild.glb'))return response;
      const body=new Uint8Array(await response.arrayBuffer()),chunks=10,size=Math.ceil(body.length/chunks);
      let sent=0;
      return new Response(new ReadableStream({pull:controller=>new Promise(resolve=>originalTimeout(()=>{
        controller.enqueue(body.slice(sent*size,(sent+1)*size));
        if(++sent===chunks){window.__slow=false;controller.close();}
        resolve();
      },300))}),{headers:{'content-type':'model/gltf-binary'}});
    };`});
  await ready(b);
  assert.equal(await b.evaluate("document.querySelector('#yard-failure').hidden"),true);
  assert.equal(await b.evaluate("document.querySelector('#yard-stage').dataset.world"),'guild');
  assert.deepEqual(b.errors,[]);
});

test('a world swap that stalls keeps the current world, and Retry finishes it',options,async t=>{
  const {b}=await setup(t,{yard:true,source:`
    const originalTimeout=window.setTimeout,originalFetch=window.fetch;
    window.__stallWorld=false;window.__abortedWorld=false;
    window.setTimeout=(callback,delay,...args)=>originalTimeout(callback,window.__stallWorld && delay===30000?0:delay,...args);
    window.fetch=(...args)=>{
      const request=args[0];
      if(window.__stallWorld && String(request?.url||request).endsWith('/orbital.glb')) {
        return new Promise((resolve,reject)=>{
          const signal=request.signal||args[1]?.signal;
          signal.addEventListener('abort',()=>{window.__abortedWorld=true;reject(new DOMException('Aborted','AbortError'));},{once:true});
        });
      }
      return originalFetch(...args);
    };`});
  await ready(b);
  await b.evaluate("window.__stallWorld=true;document.documentElement.dataset.skin='orbital'");
  await b.wait("document.querySelector('#yard-swap-failure').hidden===false");
  assert.equal(await b.evaluate('window.__abortedWorld'),true,'the abandoned swap stops downloading');
  assert.match(await b.evaluate("document.querySelector('#yard-swap-failure-text').textContent"),/Orbital Station/);
  assert.equal(await b.evaluate("document.querySelector('#yard-failure').hidden"),true);
  assert.equal(await b.evaluate("document.querySelector('#yard-loading').hidden"),true);
  assert.equal(await b.evaluate("document.querySelector('#yard-stage').dataset.world"),'guild');
  assert.equal(await b.evaluate("document.querySelector('#yard-stage').dataset.ready"),'true');
  await b.click(provider('anthropic'));
  assert.equal(await b.evaluate(`document.querySelector('${inspector} .new').hidden`),false);
  await b.evaluate('window.__stallWorld=false');await b.click('#yard-swap-retry');
  await b.wait("document.querySelector('#yard-stage').dataset.world==='orbital' && document.querySelector('#yard-swap-failure').hidden && document.querySelector('#yard-loading').hidden");
  assert.deepEqual(b.errors,[]);
});

test('background plate loads and a preloaded theme switch show no progress',options,async t=>{
  const {b}=await setup(t,{yard:true,source:`
    window.__loadingShown=0;
    addEventListener('DOMContentLoaded',()=>{
      const el=document.querySelector('#yard-loading');
      new MutationObserver(()=>{if(document.querySelector('#yard-stage').dataset.ready==='true'&&!el.hidden)window.__loadingShown++;})
        .observe(el,{attributes:true,attributeFilter:['hidden']});
    });`});
  await ready(b);await framesSettled(b);
  assert.ok(b.requests.some(r=>/\/guild\/light-base-/.test(r.url)),'the other theme loaded in the background');
  await b.evaluate("document.documentElement.dataset.theme='light'");
  await b.evaluate('new Promise(resolve=>setTimeout(resolve,600))');
  assert.equal(await b.evaluate('window.__loadingShown'),0);
  assert.equal(await b.evaluate("document.querySelector('#yard-loading').hidden"),true);
  assert.deepEqual(b.errors,[]);
});

test('a compact host view fills itself with the scene, shows every hall, and sends a double-clicked session to its host',options,async t=>{
  const {f,b}=await setup(t,{width:360,height:440,hash:'&layout=compact&skin=grove&theme=light',source:`
    window.__posted=[];
    window.parent={postMessage:message=>window.__posted.push(message)};
    const Socket=window.WebSocket;window.__sockets=[];
    window.WebSocket=class extends Socket{constructor(...args){super(...args);__sockets.push(this);}};
    window.__offlineShown=0;
    addEventListener('DOMContentLoaded',()=>{const el=document.getElementById('yard-offline');new MutationObserver(()=>{if(!el.hidden)__offlineShown++;}).observe(el,{attributes:true,attributeFilter:['hidden']});});`});
  await ready(b);await nextFrames(b);
  assert.equal(await b.evaluate('__offlineShown'),0,'no notice while the first connection opens');
  const page=await b.evaluate(`(()=>{
    const shown=selector=>document.querySelector(selector).checkVisibility();
    const stage=document.querySelector('#yard-stage').getBoundingClientRect();
    const halls=[...document.querySelectorAll('.yard-label[data-kind="provider"]')].map(el=>el.getBoundingClientRect()).map(r=>[r.left+r.width/2,r.top+r.height/2]);
    const {skin,theme,layout}=document.documentElement.dataset;
    return {skin,theme,layout,view:localStorage.getItem('agentGuild.view'),saved:localStorage.getItem('agentGuild.skin'),
      chrome:['.topbar','#app > .launcher','.yard-heading','.yard-sidebar','.yard-news'].filter(shown),
      stage:[stage.left,stage.top,stage.width,stage.height],halls,tools:document.querySelectorAll('.yard-row[data-key^="provider:"]').length,
      looks:__posted.filter(m=>m.type==='look').length};
  })()`);
  assert.deepEqual([page.layout,page.skin,page.theme,page.view,page.saved],['compact','grove','light','cards','guild'],'the look it was given, and nothing kept');
  assert.deepEqual(page.chrome,[]);
  assert.deepEqual(page.stage,[0,0,360,440]);
  assert.ok(page.tools>0);
  assert.equal(page.halls.length,page.tools);
  for(const [x,y] of page.halls)assert.ok(x>=0&&x<=360&&y>=0&&y<=440,'hall in sight at '+x+','+y);
  assert.equal(page.looks,0);
  assert.equal(await b.evaluate('location.hash'),'#layout=compact&skin=grove&theme=light','the token leaves the address, the compact settings stay');
  await b.reload();
  await b.wait("document.querySelector('#yard-stage')?.dataset.ready==='true'");
  assert.deepEqual(await b.evaluate("(({layout,view,skin,theme})=>[layout,view,skin,theme])(document.documentElement.dataset)"),['compact','yard','grove','light'],'a reload stays compact, in the same look');
  assert.equal(await b.evaluate("document.querySelector('#terminal-panel').hidden"),true);
  assert.equal(await b.evaluate("document.querySelector('#yard-offline').hidden"),true,'no notice while connected');
  await b.evaluate("__sockets.filter(s=>s.url.includes('/events')).at(-1).close()");
  await b.wait("!document.querySelector('#yard-offline').hidden");
  await b.evaluate("document.querySelector('#yard-offline-open').click()");
  assert.deepEqual(await b.evaluate("__posted.filter(m=>m.type==='expand')"),[{source:'agent-guild',type:'expand'}]);
  await b.wait("document.querySelector('#yard-offline').hidden");
  await b.evaluate("__posted.length=0");
  await b.send('Emulation.setDeviceMetricsOverride',{width:1000,height:220,deviceScaleFactor:1,mobile:false});
  await nextFrames(b);await nextFrames(b);
  const wide=await b.evaluate(`[...document.querySelectorAll('.yard-label[data-kind="provider"]')].map(el=>el.getBoundingClientRect()).map(r=>[r.left+r.width/2,r.top+r.height/2])`);
  for(const [x,y] of wide)assert.ok(x>=0&&x<=1000&&y>=0&&y<=220,'hall in sight in a short panel at '+x+','+y);
  await b.evaluate(`document.querySelector('.yard-label[data-kind="session"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  const expanded=await b.evaluate("__posted.filter(m=>m.type==='expand')");
  assert.equal(expanded.length,1);
  assert.equal(typeof expanded[0].session,'string');
  assert.equal(await b.evaluate("document.querySelector('#terminal-panel').hidden"),true);
  await b.navigate('about:blank');
  await b.navigate(f.api.url+'/#token='+f.token+'&view=yard');
  await b.wait("document.querySelector('#connection')?.classList.contains('ok')");
  assert.deepEqual(await b.evaluate("[location.hash,document.documentElement.dataset.layout??null]"),['',null],'a full framed page keeps nothing in its address');
});

test('a compact view that cannot reach its manager says so instead of preparing, and recovers when it can; a full page is unchanged',options,async t=>{
  const blocked=`
    window.__posted=[];
    window.parent={postMessage:message=>window.__posted.push(message)};
    window.__block=true;
    const Socket=window.WebSocket;
    window.WebSocket=class extends Socket{constructor(url,...args){super(window.__block&&String(url).includes('/events')?'ws://127.0.0.1:9/events':url,...args);}};`;
  const {f,b}=await setup(t,{width:300,height:400,hash:'&layout=compact',source:blocked,until:"document.querySelector('#yard-offline')?.hidden===false"});
  const offline=await b.evaluate(`[document.querySelector('#yard-offline').textContent,...['#yard-download','#yard-loading'].map(s=>document.querySelector(s).checkVisibility())]`);
  assert.deepEqual(offline,['Can’t reach Agent Guild. Retrying…Open Agent Guild',false,false]);
  await b.click('#yard-offline-open');
  assert.deepEqual(await b.evaluate("__posted.filter(m=>m.type==='expand')"),[{source:'agent-guild',type:'expand'}]);
  await b.evaluate('window.__block=false');
  await b.wait("document.querySelector('#connection').classList.contains('ok') && document.querySelector('#yard-offline').hidden");
  await ready(b);

  await b.navigate('about:blank');
  await b.navigate(f.api.url+'/#token='+f.token+'&view=yard');
  await b.wait("document.querySelector('#yard-summary')?.textContent==='Reconnecting…' && !document.querySelector('#yard-download').hidden");
  assert.deepEqual(await b.evaluate("[document.querySelector('#yard-offline').hidden,document.querySelector('#yard-download-title').textContent,document.querySelector('.topbar').checkVisibility()]"),
    [true,'Preparing your yard…',true],'a full page keeps its own badge and screens');
});

test('a compact view whose host has no full page shows no control that asks for one, and never sends expand',options,async t=>{
  const {b}=await setup(t,{width:360,height:440,hash:'&layout=compact&expand=none',source:`
    window.__posted=[];
    window.parent={postMessage:message=>window.__posted.push(message)};
    window.__block=sessionStorage.getItem('unblocked')!=='1';
    const Socket=window.WebSocket;
    window.WebSocket=class extends Socket{constructor(url,...args){super(window.__block&&String(url).includes('/events')?'ws://127.0.0.1:9/events':url,...args);}};`,
  until:"document.querySelector('#yard-offline')?.hidden===false"});
  const shown=`['#yard-offline-open','#yard-cards','#yard-download-cards','#yard-retry'].map(s=>getComputedStyle(document.querySelector(s)).display!=='none')`;
  assert.deepEqual(await b.evaluate(`[document.querySelector('#yard-offline-text').textContent,...${shown}]`),['Can’t reach Agent Guild. Retrying…',false,false,false,true]);
  await b.evaluate("window.__block=false;sessionStorage.setItem('unblocked','1')");
  await b.wait("document.querySelector('#connection').classList.contains('ok') && document.querySelector('#yard-offline').hidden");
  await ready(b);
  const tryOpen=`(()=>{
    const crowd=Object.assign(document.createElement('button'),{className:'yard-crowd-open'});document.querySelector('#yard-labels').append(crowd);
    const crowdShown=getComputedStyle(crowd).display!=='none';crowd.remove();
    const label=document.querySelector('.yard-label[data-kind="session"]');
    label.click();label.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    const stage=document.querySelector('#yard-stage');stage.focus();
    stage.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    return [location.hash,document.documentElement.dataset.expand,crowdShown,__posted.filter(m=>m.type==='expand').length,document.querySelector('#terminal-panel').hidden];
  })()`;
  assert.deepEqual(await b.evaluate(tryOpen),['#layout=compact&expand=none','none',false,0,true],'the token leaves the address and the setting stays');
  await b.reload();
  await b.wait("document.querySelector('#connection')?.classList.contains('ok') && document.querySelector('#yard-stage')?.dataset.ready==='true'");
  assert.deepEqual(await b.evaluate(tryOpen),['#layout=compact&expand=none','none',false,0,true],'a reload keeps it');
});

test('a world changed while the Yard first loads is the one it shows',options,async t=>{
  const assets=fileURLToPath(new URL('../../web/yard/assets/',import.meta.url));
  const yardWorlds=Object.assign(new EventEmitter(),{
    current:{guild:{title:'World A',revision:'aaaa',lights:null}},
    snapshot(){return this.current;},
    file:(skin,name)=>path.join(assets,skin,name),
  });
  const b=await browser();
  await b.send('Fetch.enable',{patterns:[{urlPattern:'*/yard/worlds/*v=aaaa*'}]});
  t.after(()=>b.send('Fetch.disable'));
  await setup(t,{yard:true,yardWorlds});
  await until(()=>b.events.some(event=>event.method==='Fetch.requestPaused'));
  yardWorlds.current={guild:{title:'World B',revision:'bbbb',lights:null}};
  yardWorlds.emit('updated',yardWorlds.current);
  await b.wait("document.querySelector('#yard-title').textContent==='World B'");
  await b.send('Fetch.disable');
  await ready(b);
  assert.ok(b.requests.some(request=>request.url.includes('/yard/worlds/guild/')&&request.url.includes('v=bbbb')),'the Yard loads the world it is named for');
  assert.deepEqual(b.errors,[]);
});

test('auth, graphics failure, retry, manager restart and stopped screen remain usable',options,async t=>{
  const {f,b}=await setup(t,{yard:true,auth:false,source:`
    const getContext=HTMLCanvasElement.prototype.getContext;
    window.__blockGraphics=true;
    HTMLCanvasElement.prototype.getContext=function(kind,...args){return window.__blockGraphics && kind==='webgl2'?null:getContext.call(this,kind,...args);};`});
  assert.equal(b.requests.some(r=>r.url.endsWith('/renderer.js')),false,'unauthenticated page does not load the scene');
  await fill(b,'#auth-token','invalid-fixture-token');await b.click('#auth-form button');
  await b.wait("document.querySelector('#auth-error').textContent.length>0");
  await fill(b,'#auth-token',f.token);await b.click('#auth-form button');
  await b.wait("document.querySelector('#yard-failure').hidden===false");
  await b.click(provider('anthropic'));await b.click(inspector+' .new');await terminalReady(b);await closeTerminal(b);
  assert.ok(f.calls.some(c=>c[0]==='create'),'graphics failure keeps the canonical action usable');
  await b.evaluate('window.__blockGraphics=false');await b.click('#yard-retry');await ready(b);
  await b.evaluate("document.querySelector('#yard-stage canvas').dispatchEvent(new Event('webglcontextlost',{cancelable:true}))");
  await b.wait("document.querySelector('#yard-failure').hidden===false");
  await b.click('#yard-retry');await ready(b);
  await b.click('#manager');await b.wait("document.querySelector('#manager-menu').matches(':popover-open')");
  await b.click('#restart-manager');await answer(b);await until(()=>f.calls.some(c=>c[0]==='shutdown' && c[1]));
  await b.wait("!document.querySelector('#app').hidden && document.querySelector('#stopped').hidden && document.querySelector('#version').textContent==='v1.1.0'");
  assert.equal(await b.evaluate("document.documentElement.dataset.view"),'yard');
  assert.equal(await b.evaluate("document.querySelectorAll('.yard-row[data-key^=\"session:\"]').length"),0);
  f.add({providerId:'openai'});await b.wait("document.querySelector('.yard-row[data-key^=\"session:\"]')");
  await b.click('#manager');await b.wait("document.querySelector('#manager-menu').matches(':popover-open')");
  await b.click('#stop-manager');await answer(b);await b.wait("!document.querySelector('#stopped').hidden && !document.querySelector('#stopped-help').hidden");
  assert.equal(await b.evaluate("document.querySelector('#app').hidden"),true);
  const shutdown=b.requests.filter(r=>r.url.endsWith('/shutdown'));
  assert.deepEqual(shutdown.map(r=>r.postData?JSON.parse(r.postData):{}),[{restart:true},{force:true,restart:true},{}, {force:true}]);
  assert.deepEqual(b.errors,[]);
});


test('fireworks stay bounded under repeated triggers, finish deterministically, and release their resources',options,async t=>{
  const {b}=await setup(t);
  const result=await b.evaluate(`(async()=>{
    const {YardRenderer}=await import('/yard/renderer.js'),T=await import('/yard/vendor/engine.js');
    const host=document.createElement('div'),labels=document.createElement('div');
    host.style.cssText='position:fixed;width:900px;height:700px;top:0;left:0';host.append(labels);document.body.append(host);
    const r=new YardRenderer(host,labels,{select(){},open(){},clock:()=>0}),random=Math.random;
    let seed=1,created=0,released=0;
    Math.random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/4294967296);
    const scatter=r.scatter.bind(r);
    r.scatter=(...args)=>{scatter(...args);const spark=r.sparks.at(-1);if(spark?.firework){created+=2;spark.points.geometry.addEventListener('dispose',()=>released++);spark.points.material.addEventListener('dispose',()=>released++);}};
    try {
      r.fireworks();const unloaded=r.shows.length+r.sparks.length;
      r.world=new T.Group();r.scene.add(r.world);
      for(let i=0;i<100;i++){
        const root=new T.Group();root.position.set(i%5-2,0,Math.floor(i/5)%5-2);r.world.add(root);
        r.halls.set(String(i),{root,glows:[],level:0,target:0,label:document.createElement('button'),chip:document.createElement('button')});
      }
      const run=repeat=>{
        seed=7;r.fireworks();const scheduled=r.shows.length+1,trace=[],kinds=new Set();let peakPoints=0,peakBatches=0;
        for(let i=0;i<120;i++){
          if(repeat&&(r.shows.length||r.sparks.some(s=>s.firework)))for(let n=0;n<20;n++)r.fireworks();
          r.updateShows(.05);r.updateSparks(.05);
          const live=r.sparks.filter(s=>s.firework);
          peakPoints=Math.max(peakPoints,live.reduce((n,s)=>n+s.points.geometry.attributes.position.count,0));peakBatches=Math.max(peakBatches,live.length);
          for(const s of live)if(s.firework.bloom)kinds.add(s.firework.kind);
          if(i%10===0)trace.push([r.shows.length,live.length,...live.flatMap(s=>Array.from(s.points.geometry.attributes.position.array.slice(0,3)))]);
        }
        return {scheduled,peakPoints,peakBatches,kinds:[...kinds].sort(),trace,left:r.shows.length+r.sparks.length,frame:r.frame};
      };
      r.fireworkMap();
      const first=run(false),map=r.fireworkTexture,second=run(true),reused=map===r.fireworkTexture;
      for(let i=0;i<12;i++)r.burst({x:0,y:5,z:0,index:i,color:0xffc857,finale:true});
      const saturated={batches:r.sparks.length,points:r.sparks.reduce((n,s)=>n+s.points.geometry.attributes.position.count,0)};
      r.clearFireworks();r.fireworks();r.updateShows(.6);r.updateSparks(.6);r.spark(0,1,0);
      const workshop=r.sparks.find(s=>!s.firework);r.setReducedMotion(true);r.fireworks();
      const reduced={queued:r.shows.length,live:r.sparks.filter(s=>s.firework).length,workshop:r.sparks.includes(workshop)};
      r.setReducedMotion(false);r.clearFireworks();r.updateSparks(1);
      host.style.width='220px';r.resize();r.zoom(20);r.controls.target.set(15,1,20);r.camera.position.set(19,24,31).add(r.controls.target);r.camera.updateMatrixWorld();
      const camera=r.camera.matrixWorld.toArray();r.fireworks();r.updateShows(.6);r.updateSparks(.6);
      const centers=r.sparks.filter(s=>s.firework).map(s=>new T.Vector3(s.firework.x,s.firework.y,s.firework.z).project(r.camera).toArray());
      const stillCamera=JSON.stringify(camera)===JSON.stringify(r.camera.matrixWorld.toArray());
      let textureReleased=0;map.addEventListener('dispose',()=>textureReleased++);r.dispose();r.fireworks();
      return {unloaded,first,second,reused,saturated,reduced,centers,stillCamera,created,released,textureReleased,disposed:r.shows.length+r.sparks.length};
    } finally {Math.random=random;r.dispose();host.remove();}
  })()`);
  assert.equal(result.unloaded,0);
  assert.deepEqual(result.second,result.first,'rapid repeated triggers cannot extend or alter the show');
  assert.ok(result.first.scheduled<=24);
  assert.ok(result.first.peakPoints>0&&result.first.peakPoints<=1024);
  assert.ok(result.first.peakBatches>0&&result.first.peakBatches<=8);
  assert.deepEqual(result.first.kinds,[0,1,2]);
  assert.equal(result.first.left,0);
  assert.equal(result.first.frame,0,'an inactive renderer never schedules animation');
  assert.equal(result.reused,true);
  assert.deepEqual(result.saturated,{batches:8,points:1024});
  assert.deepEqual(result.reduced,{queued:0,live:0,workshop:true});
  assert.ok(result.centers.length>0);
  for(const [x,y]of result.centers)assert.ok(Math.abs(x)<=.551&&y>=-.101&&y<=.551,'burst centers stay inside a narrow, zoomed, panned view');
  assert.equal(result.stillCamera,true);
  assert.equal(result.created,result.released);
  assert.equal(result.textureReleased,1);
  assert.equal(result.disposed,0);
  assert.deepEqual(b.errors,[]);
});

test('the fireworks button is local, accessible, and follows loading, motion and graphics recovery',options,async t=>{
  const {b}=await setup(t,{yard:true,source:`
    const originalFetch=window.fetch;
    window.fetch=(...args)=>String(args[0]?.url||args[0]).endsWith('/guild.glb')&&!window.__releaseWorld
      ?new Promise((resolve,reject)=>{window.__releaseWorld=()=>originalFetch(...args).then(resolve,reject);}) : originalFetch(...args);`});
  const button="document.querySelector('#yard-fireworks')";
  await b.wait('window.__releaseWorld');
  assert.equal(await b.evaluate(button+'.disabled'),true);
  await b.evaluate('window.__releaseWorld()');await ready(b);
  assert.equal(await b.evaluate(button+'.disabled'),true);
  assert.match(await b.evaluate(button+'.title'),/reduced motion/);
  await b.evaluate(`(async()=>{
    const {YardRenderer}=await import('/yard/renderer.js'),original=YardRenderer.prototype.fireworks;
    window.__fireworkCalls=0;
    YardRenderer.prototype.fireworks=function(){this.setActive(false);window.__yardRenderer=this;window.__fireworkCalls++;return original.call(this);};
  })()`);
  await b.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await b.wait(button+'.disabled===false');
  assert.deepEqual(await b.evaluate('['+button+'.title,'+button+'.getAttribute("aria-label")]'),['Fireworks in this Yard only','Fireworks in this Yard only']);
  assert.equal(await b.evaluate(button+'.previousElementSibling.id'),'yard-photo');
  const center=await b.evaluate('(()=>{const r='+button+'.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
  await b.send('Input.dispatchMouseEvent',{type:'mousePressed',...center,button:'left',clickCount:1});
  await b.send('Input.dispatchMouseEvent',{type:'mouseReleased',...center,button:'left',clickCount:1});
  assert.equal(await b.evaluate('__fireworkCalls'),1);
  for(const [key,code,windowsVirtualKeyCode]of [['Enter','Enter',13],[' ','Space',32]]){
    await b.evaluate(button+'.focus()');
    await b.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode,...(key==='Enter'?{text:'\r'}:{})});
    await b.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode});
  }
  assert.equal(await b.evaluate('__fireworkCalls'),3);
  await b.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...center,radiusX:1,radiusY:1}]});
  await b.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await b.wait('__fireworkCalls===4');
  assert.equal(b.requests.some(r=>r.url.endsWith('/yard/fireworks')),false,'the button makes no broadcast request');
  await b.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await b.wait(button+'.disabled');
  assert.equal(await b.evaluate('__yardRenderer.shows.length+__yardRenderer.sparks.filter(s=>s.firework).length'),0);
  await b.click('#yard-fireworks');assert.equal(await b.evaluate('__fireworkCalls'),4);
  await b.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await b.wait(button+'.disabled===false');await b.click('#yard-fireworks');
  await b.evaluate("document.documentElement.dataset.skin='orbital'");
  await b.wait("document.querySelector('#yard-stage').dataset.world==='orbital'");
  assert.equal(await b.evaluate('__yardRenderer.shows.length+__yardRenderer.sparks.filter(s=>s.firework).length'),0,'world replacement clears the previous show');
  await b.click('#view-cards');
  const before=await b.evaluate('__fireworkCalls');await b.click('#yard-fireworks');
  assert.equal(await b.evaluate('__fireworkCalls'),before,'a hidden Yard does not celebrate');
  await b.click('#view-yard');await ready(b);
  await b.evaluate("document.querySelector('#yard-stage canvas').dispatchEvent(new Event('webglcontextlost',{cancelable:true}))");
  await b.wait("document.querySelector('#yard-failure').hidden===false");
  assert.equal(await b.evaluate(button+'.disabled'),true);
  await b.click('#yard-retry');await ready(b);
  assert.equal(await b.evaluate(button+'.disabled'),false);
  assert.deepEqual(b.errors,[]);
});


test('fireworks keep their size and glow across photo tiles at different pixel ratios',options,async t=>{
  const {b}=await setup(t);
  const result=await b.evaluate(`(async()=>{
    const {YardRenderer}=await import('/yard/renderer.js'),T=await import('/yard/vendor/engine.js');
    const host=document.createElement('div'),labels=document.createElement('div');
    host.style.cssText='position:fixed;width:180px;height:140px;top:0;left:0';host.append(labels);document.body.append(host);
    const r=new YardRenderer(host,labels,{select(){},open(){}}),random=Math.random,results=[];
    r.world=new T.Group();r.atOverview=false;Math.random=()=>.5;
    try {
      await new Promise((resolve,reject)=>{
        const load=T.TextureLoader.prototype.load;
        T.TextureLoader.prototype.load=function(url,onLoad){return load.call(this,url,texture=>{onLoad?.(texture);resolve();},undefined,reject);};
        try{r.fireworkMap();}finally{T.TextureLoader.prototype.load=load;}
      });
      r.fireworks();r.updateSparks(.8);
      const spark=r.sparks[0],size=spark.points.material.size;
      r.renderer.setPixelRatio(2);r.resize();r.camera.updateMatrixWorld();
      let index=0;
      for(const x of [179,181,269,271])for(const y of [139,141,209,211]){
        const p=new T.Vector3(x/360*2-1,1-y/280*2,0).unproject(r.camera);
        spark.points.geometry.attributes.position.setXYZ(index++,p.x,p.y,p.z);
      }
      spark.points.geometry.attributes.position.needsUpdate=true;spark.points.geometry.setDrawRange(0,index);
      r.renderer.render(r.scene,r.camera);
      const canvas=Object.assign(document.createElement('canvas'),{width:360,height:280}),c=canvas.getContext('2d');
      c.drawImage(r.canvas,0,0);const expected=c.getImageData(0,0,360,280).data;
      for(const ratio of [1,1.5]){
        r.renderer.setPixelRatio(ratio);r.resize();
        const shot=r.capture(),actual=shot.canvas.getContext('2d').getImageData(0,0,360,280).data;
        let maxDelta=0,alpha=0;
        for(let i=3;i<actual.length;i+=4){maxDelta=Math.max(maxDelta,Math.abs(actual[i]-expected[i]));alpha+=expected[i];}
        results.push({ratio,maxDelta,alpha,size:spark.points.material.size});
      }
      return {size,results};
    } finally {Math.random=random;r.dispose();host.remove();}
  })()`);
  for(const shot of result.results){assert.ok(shot.alpha>0);assert.ok(shot.maxDelta<=2,JSON.stringify(shot));assert.equal(shot.size,result.size);}
  assert.deepEqual(b.errors,[]);
});

const PIECE_FILES=fileURLToPath(new URL('../fixtures/pieces/',import.meta.url));
function fakePieces(current,files={}){
  return Object.assign(new EventEmitter(),{
    current,
    snapshot(){return this.current;},
    file(skin,slot,name){
      if(!this.current[skin]?.[slot]?.revision)return null;
      if(files[slot])return files[slot];
      if(slot==='openai')return path.join(PIECE_FILES,'truncated.glb');
      return path.join(PIECE_FILES,slot==='companion'?'companion.glb':'character.glb');
    },
  });
}

test('pieces replace one crew and the helpers, keep Terminal AI Chat gold, fall back whole, and never let an older load return',options,async t=>{
  const yardPieces=fakePieces({guild:{anthropic:{revision:'r1'},shell:{revision:'s1'},companion:{revision:'c1'},openai:{revision:'x1'}}});
  const {f,b}=await setup(t,{yardPieces,source:`
    const originalFetch=window.fetch;window.__held=[];window.__hold=null;
    window.fetch=(...args)=>{
      const url=String(args[0]?.url||args[0]);
      if(window.__hold&&url.includes(window.__hold))return new Promise((resolve,reject)=>window.__held.push(()=>originalFetch(...args).then(resolve,reject)));
      return originalFetch(...args);
    };`});
  const by=id=>f.providers.find(p=>p.id===id),gold={...by('shell'),id:'terminal-ai-chat',tool:'Terminal AI Chat'};
  const base=[...f.data.values()][0];
  const sessions=[
    {...base,id:'claude',provider:by('anthropic'),agents:[{id:'a',name:'A',status:'working'},{id:'b',name:'B',status:'working'}],shells:[]},
    {...base,id:'codex',provider:by('openai'),agents:[],shells:[]},
    {...base,id:'gold',provider:gold,agents:[],shells:[]},
    {...base,id:'grok',provider:by('xai'),agents:[],shells:[]},
  ];
  await b.evaluate(`(async()=>{
    const {YardRenderer}=await import('/yard/renderer.js');
    const host=document.createElement('div'),labels=document.createElement('div');
    host.style.cssText='position:fixed;width:900px;height:700px;top:0;left:0';host.append(labels);document.body.append(host);
    window.__events=[];
    window.__renderer=new YardRenderer(host,labels,{select(){},open(){},piece:e=>{__events.push(e);if(!e.ok){const p={...__renderer.pieceSets[e.skin]};delete p[e.slot];__renderer.setPieces(e.skin,p);}}});
    window.__providers=${q([...f.providers,gold])};window.__sessions=${q(sessions)};
    __renderer.setPieces('guild',{anthropic:{revision:'r1'},shell:{revision:'s1'},companion:{revision:'c1'},openai:{revision:'x1'}});
    await __renderer.setWorld('guild','dark');__renderer.update(__providers,__sessions);
    window.__unit=id=>__renderer.units.get(id);
    window.__pieceKeys=()=>[...__renderer.cache.keys()].filter(k=>k.includes('/pieces/')).map(k=>k.replace(/^(gold:)?.*\\/pieces\\//,'$1')).sort();
    window.__maps=root=>{const out=[];root?.traverse(n=>{if(n.isMesh)for(const m of [n.material].flat())if(m.map)out.push(m.map.image?.width||0);});return out;};
  })()`);
  await b.wait("['claude','codex','gold','grok'].every(id=>__unit(id).loaded) && __unit('claude').helpers.length===2 && __events.length===4");
  const first=await b.evaluate(`({
    events:__events.map(e=>e.slot+':'+e.revision+':'+e.ok).sort(),
    claudeTexture:__maps(__unit('claude').model),
    claudeClips:[...__unit('claude').animations.keys()].sort(),
    goldGilded:(()=>{const ms=[];__unit('gold').model.traverse(n=>{if(n.isMesh)ms.push(...[n.material].flat());});return ms.length>0&&ms.every(m=>m.onBeforeCompile!==Object.getPrototypeOf(m).onBeforeCompile);})(),
    keys:__pieceKeys(),
    original:['hero_1','hero_3'].every(k=>__renderer.cache.has(k)),
  })`);
  assert.deepEqual(first.events,['anthropic:r1:true','companion:c1:true','openai:x1:false','shell:s1:true']);
  assert.ok(first.claudeTexture.length>0&&first.claudeTexture.every(w=>w>0),'the embedded texture decodes under the page’s policy');
  assert.deepEqual(first.claudeClips,['done','idle_0','idle_1','idle_2','pause','walk','work_0','work_1']);
  assert.equal(first.goldGilded,true,'Terminal AI Chat wears the Shell piece in gold');
  assert.deepEqual(first.keys,['gold:guild/shell/character.glb?v=s1','guild/anthropic/character.glb?v=r1','guild/companion/companion_0.glb?v=c1','guild/companion/companion_1.glb?v=c1','guild/companion/companion_2.glb?v=c1','guild/companion/companion_3.glb?v=c1','guild/shell/character.glb?v=s1']);
  assert.equal(first.original,true,'the broken Codex piece falls back to the shipped character, and Grok keeps its own');
  const grok=await b.evaluate("__unit('grok').model.uuid");
  await b.evaluate("__events.length=0;__renderer.setPieces('guild',{...__renderer.pieceSets.guild,anthropic:{revision:'r2'}});__renderer.setPieces('guild',{...__renderer.pieceSets.guild,anthropic:{revision:'r3'}})");
  await b.wait("__unit('claude').loaded && __events.some(e=>e.revision==='r3')");
  assert.deepEqual(await b.evaluate("__events.map(e=>e.revision)"),['r3'],'a superseded revision reports nothing');
  assert.deepEqual(await b.evaluate("__pieceKeys().filter(k=>k.startsWith('guild/anthropic'))"),['guild/anthropic/character.glb?v=r3']);
  assert.equal(await b.evaluate("__unit('grok').model.uuid"),grok,'an unaffected character keeps its model');
  await b.evaluate("__hold='v=r4';__renderer.setPieces('guild',{...__renderer.pieceSets.guild,anthropic:{revision:'r4'}});window.__r4=[...__renderer.cache].find(([k])=>k.endsWith('v=r4'))[1];(async()=>{await __renderer.setWorld('orbital','dark');})()");
  await b.wait("__renderer.skin==='orbital' && ['claude','codex','gold','grok'].every(id=>__unit(id)?.loaded) && __unit('claude').helpers.length===2");
  await b.evaluate("(async()=>{__hold=null;for(const go of __held.splice(0))go();await __r4.catch(()=>{});await new Promise(resolve=>setTimeout(resolve,0));})()");
  assert.deepEqual(await b.evaluate("({keys:__pieceKeys(),robot:__renderer.cache.has('robot_0'),late:__events.some(e=>e.revision==='r4')})"),{keys:[],robot:true,late:false},'another Yard shows its own cast, the Guild’s pieces are released, and a late download reports nothing');
  await b.evaluate("(async()=>{await __renderer.setWorld('guild','dark');})()");
  await b.wait("__renderer.skin==='guild' && __unit('claude')?.loaded && __pieceKeys().includes('guild/anthropic/character.glb?v=r4')");
  await b.evaluate("__renderer.setPieces('guild',{})");
  await b.wait("__unit('claude').loaded && __unit('claude').helpers.length===2 && __pieceKeys().length===0");
  assert.equal(await b.evaluate("__renderer.cache.has('hero_0')"),true,'restoring brings back the original');
  await b.evaluate('__renderer.dispose()');
  assert.deepEqual(b.errors,[]);
});

test('a released piece load never decides the piece after its Yard returns, whichever load finishes first',options,async t=>{
  const yardPieces=fakePieces({guild:{anthropic:{revision:'r1'}}});
  const {f,b}=await setup(t,{yardPieces});
  await b.evaluate(`(()=>{
    window.__piece=()=>[...__renderer.cache].find(([key])=>key.includes('/pieces/guild/anthropic/'))?.[1];
    window.__settled=async pending=>{await pending.then(()=>{},()=>{});await new Promise(resolve=>setTimeout(resolve,0));};
  })()`);
  for(const [lateOk,lateFirst] of [[true,false],[true,true],[false,false],[false,true]]){
    const label=`a late ${lateOk?'success':'failure'} ${lateFirst?'before':'after'} the current load`;
    await b.evaluate(`(async()=>{
      window.__held=[];window.__events=[];
      const {YardRenderer}=await import('/yard/renderer.js');
      const host=document.createElement('div'),labels=document.createElement('div');
      host.style.cssText='position:fixed;width:900px;height:700px;top:0;left:0';host.append(labels);document.body.append(host);
      window.__renderer=new YardRenderer(host,labels,{select(){},open(){},piece:e=>{__events.push(e);if(!e.ok){const p={...__renderer.pieceSets[e.skin]};delete p[e.slot];__renderer.setPieces(e.skin,p);}}});
      const asset=__renderer.asset.bind(__renderer);
      __renderer.asset=(name,url)=>{
        const pending=asset(name,url);
        if(!url?.includes('/pieces/guild/anthropic/'))return pending;
        const held={pending};
        held.promise=new Promise((resolve,reject)=>Object.assign(held,{succeed:()=>pending.then(resolve,()=>resolve(null)),fail:()=>reject(new Error('Failed to fetch'))}));
        __held.push(held);
        return held.promise;
      };
      __renderer.setPieces('guild',{anthropic:{revision:'r1'}});
      await __renderer.setWorld('guild','dark');__renderer.update(${q(f.providers)},[]);
    })()`);
    await b.wait('__held.length===1');
    await b.evaluate("window.__a1=__piece();0");
    await b.evaluate("(async()=>{await __renderer.setWorld('orbital','dark');await __renderer.setWorld('guild','dark');})()");
    await b.wait('__held.length===2');
    await b.evaluate('window.__a2=__piece();0');
    assert.equal(await b.evaluate('Boolean(__a1&&__a2&&__a1!==__a2)'),true,label+': the return starts a load of its own');
    const late=`(async()=>{__held[0].${lateOk?'succeed':'fail'}();await __settled(__held[0].promise);})()`;
    const current=`__held[1].${lateOk?'fail':'succeed'}()`;
    if(lateFirst){
      await b.evaluate(late);
      assert.deepEqual(await b.evaluate('__events'),[],label+': reports nothing');
      await b.evaluate(current);
      await b.wait('__events.length===1');
    } else {
      await b.evaluate(current);
      await b.wait('__events.length===1');
      await b.evaluate(late);
    }
    await b.evaluate('__settled(__held[1].promise)');
    assert.deepEqual(await b.evaluate("__events.map(e=>[e.skin,e.slot,e.revision,e.ok])"),[['guild','anthropic','r1',!lateOk]],label+': only the current load decides');
    assert.equal(await b.evaluate("Boolean(__renderer.pieceSets.guild.anthropic)"),!lateOk,label+': the piece stays exactly when the current load drew it');
    assert.equal(await b.evaluate(lateOk?'__piece()===undefined':'__piece()===__a2'),true,label+': the cache holds only the current load');
    await b.evaluate('__renderer.dispose()');
  }
  assert.deepEqual(b.errors,[]);
});

test('picking and drawing follow the animated pose, not the pose a character first had',options,async t=>{
  const yardPieces=fakePieces({guild:{anthropic:{revision:'r1'}}});
  const {f,b}=await setup(t,{yardPieces});
  const session={...[...f.data.values()][0],id:'claude',provider:f.providers.find(p=>p.id==='anthropic'),agents:[{id:'a',name:'A',status:'working'}],shells:[]};
  await b.evaluate(`(async()=>{
    const {YardRenderer}=await import('/yard/renderer.js');
    const host=document.createElement('div'),labels=document.createElement('div');
    host.style.cssText='position:fixed;width:900px;height:700px;top:0;left:0';host.append(labels);document.body.append(host);
    window.__renderer=new YardRenderer(host,labels,{select(){},open(){}});
    __renderer.setPieces('guild',{anthropic:{revision:'r1'}});
    await __renderer.setWorld('guild','dark');__renderer.update(${q(f.providers)},[${q(session)}]);
  })()`);
  await b.wait("__renderer.units.get('claude')?.loaded && __renderer.units.get('claude').helpers.length===1");
  const result=await b.evaluate(`(async()=>{
    const r=__renderer,unit=r.units.get('claude'),out={};
    r.renderer.render(r.scene,r.camera);
    const skinned=[];unit.model.traverse(n=>{if(n.isSkinnedMesh)skinned.push(n);});
    const helpers=[];unit.crew.traverse(n=>{if(n.isSkinnedMesh)helpers.push(n);});
    const halls=[];for(const hall of r.halls.values())hall.root?.traverse(n=>{if(n.isMesh&&!n.isSkinnedMesh)halls.push(n);});
    out.animatedUnculled=[...skinned,...helpers].length>0&&[...skinned,...helpers].every(n=>n.frustumCulled===false);
    out.staticCulled=halls.length>0&&halls.every(n=>n.frustumCulled===true);
    const rect=r.canvas.getBoundingClientRect();
    const at=world=>{const p=world.clone().project(r.camera);return {clientX:rect.left+(p.x+1)/2*rect.width,clientY:rect.top+(1-p.y)/2*rect.height,onScreen:Math.abs(p.x)<1&&Math.abs(p.y)<1};};
    const head=unit.model.getObjectByName('Head'),hips=unit.model.getObjectByName('Hips');
    const before=at(head.getWorldPosition(new head.position.constructor()));
    out.normal=r.pick(before)?.id??null;
    for(const n of skinned)if(!n.boundingSphere)n.computeBoundingSphere();
    const reach=Math.max(...skinned.map(n=>n.boundingSphere.radius*n.getWorldScale(new head.position.constructor()).y))*1.5;
    for(const mixer of unit.mixers)mixer.stopAllAction();
    const lifted=hips.getWorldPosition(new head.position.constructor()),toward=r.camera.position.clone().sub(lifted).setY(0).normalize();
    lifted.addScaledVector(toward,reach);lifted.y+=reach;
    hips.position.copy(hips.parent.worldToLocal(lifted));
    r.renderer.render(r.scene,r.camera);
    const raised=head.getWorldPosition(new head.position.constructor()),after=at(raised);
    out.raisedOnScreen=after.onScreen;
    out.raised=r.pick(after)?.id??null;
    const camera=r.camera.clone();Object.assign(camera,{left:-.3,right:.3,top:.3,bottom:-.3,zoom:1});camera.position.copy(raised).addScaledVector(toward.clone().cross(new head.position.constructor(0,1,0)).normalize(),8);camera.lookAt(raised);camera.updateProjectionMatrix();camera.updateMatrixWorld(true);
    let drawn=0;for(const n of skinned)n.onBeforeRender=()=>{drawn++;};
    const shadows=r.renderer.shadowMap.autoUpdate;r.renderer.shadowMap.autoUpdate=false;r.renderer.shadowMap.needsUpdate=false;
    r.renderer.render(r.scene,camera);
    r.renderer.shadowMap.autoUpdate=shadows;
    out.drawnAtRaisedPose=drawn>0;
    return out;
  })()`);
  assert.deepEqual(result,{animatedUnculled:true,staticCulled:true,normal:'claude',raisedOnScreen:true,raised:'claude',drawnAtRaisedPose:true});
  await b.evaluate('__renderer.dispose()');
  assert.deepEqual(b.errors,[]);
});

test('companion changes clear helpers and pending loads even while their character reloads',options,async t=>{
  const yardPieces=fakePieces({guild:{anthropic:{revision:'r1'},companion:{revision:'c1'}}});
  const {f,b}=await setup(t,{yardPieces});
  const session={...[...f.data.values()][0],provider:f.providers.find(p=>p.id==='anthropic'),agents:[{id:'a',name:'A',status:'working'}],shells:[]};
  await b.evaluate(`(async()=>{
    const {YardRenderer}=await import('/yard/renderer.js');
    const host=document.createElement('div'),labels=document.createElement('div');
    host.style.cssText='position:fixed;width:900px;height:700px;top:0;left:0';host.append(labels);document.body.append(host);
    window.__renderer=new YardRenderer(host,labels,{select(){},open(){}});
    __renderer.setReducedMotion(true);
    __renderer.setPieces('guild',${q(yardPieces.current.guild)});
    await __renderer.setWorld('guild','dark');__renderer.update(${q(f.providers)},[${q(session)}]);
    window.__unit=__renderer.units.get(${q(session.id)});
    window.__released=0;
    window.__holdRevision=null;window.__held=[];
    const asset=__renderer.asset.bind(__renderer);
    __renderer.asset=(name,...args)=>{
      const pending=asset(name,...args);
      return name.includes('v='+__holdRevision)?new Promise((resolve,reject)=>__held.push(()=>pending.then(resolve,reject))):pending;
    };
    window.__change=(character,companion)=>__renderer.setPieces('guild',{anthropic:{revision:character},companion:{revision:companion}});
    window.__matches=async revision=>{
      const assets=await Promise.all([...__renderer.cache].filter(([key])=>key.includes('/companion/')&&key.endsWith('v='+revision)).map(([,asset])=>asset));
      return assets.length===4&&__unit.helpers.length===1&&__unit.helpers.every(helper=>assets.some(asset=>helper.clips===asset.animations));
    };
  })()`);
  await b.wait('__unit.loaded && __unit.helpers.length===1');
  await b.evaluate(`(async()=>{
    for(const [key,pending]of __renderer.cache)if(key.includes('/companion/')&&key.endsWith('v=c1')){
      (await pending).scene.traverse(n=>{if(n.isMesh)n.geometry.addEventListener('dispose',()=>__released++);});
    }
    window.__oldHelpers=__unit.helpers.slice();
    __holdRevision='r2';__change('r2','c2');
  })()`);
  assert.equal(await b.evaluate('__unit.helpers.length'),0,'a simultaneous character/companion change immediately removes old helpers');
  assert.equal(await b.evaluate('__oldHelpers.every(h=>!h.model.parent)'),true);
  await b.wait('__released>0');
  assert.equal(await b.evaluate("[...__renderer.cache.keys()].some(k=>k.includes('/companion/')&&k.endsWith('v=c1'))"),false);
  await b.evaluate("__change('r2','c3');__holdRevision=null;for(const go of __held.splice(0))go()");
  await b.wait('__unit.loaded && __unit.helpers.length===1');
  assert.equal(await b.evaluate("__matches('c3')"),true,'a companion changed during character loading supplies the new helper clips');
  await b.evaluate("__holdRevision='c4';__change('r2','c4');__change('r2','c5')");
  await b.wait('__unit.helpers.length===1');
  assert.equal(await b.evaluate("__matches('c5')"),true);
  await b.evaluate("(async()=>{__holdRevision=null;for(const go of __held.splice(0))go();await new Promise(resolve=>setTimeout(resolve,0));})()");
  assert.equal(await b.evaluate("__matches('c5')"),true,'a superseded helper download cannot reappear');
  await b.evaluate('__renderer.dispose()');
  assert.deepEqual(b.errors,[]);
});

test('pieces changed during the first world load are drawn and reported as Customized',options,async t=>{
  const yardPieces=fakePieces({guild:{anthropic:{title:'old',revision:'old'}}});
  const b=await browser();
  await b.send('Fetch.enable',{patterns:[{urlPattern:'*/yard/assets/guild/dark*'}]});
  t.after(()=>b.send('Fetch.disable'));
  await setup(t,{yard:true,yardPieces});
  await until(()=>b.events.some(event=>event.method==='Fetch.requestPaused'));
  await b.click('#yard-customize-open');
  const status="document.querySelector('#yard-customize-list [data-slot=anthropic] .yard-customize-status').textContent";
  yardPieces.current={guild:{anthropic:{title:'new',revision:'new'}}};
  yardPieces.emit('updated',yardPieces.current);
  await b.wait(status+"==='Loading new…'");
  await b.send('Fetch.disable');
  await ready(b);
  await b.wait(status+"==='Customized: new'");
  assert.ok(b.requests.some(r=>r.url.includes('/pieces/guild/anthropic/')&&r.url.includes('v=new')));
  assert.equal(b.requests.some(r=>r.url.includes('/pieces/guild/anthropic/')&&r.url.includes('v=old')),false);
  assert.deepEqual(b.errors,[]);
});

test('the Customize dialog tells installed from drawn, per Yard, and returns focus',options,async t=>{
  const yardPieces=fakePieces({guild:{anthropic:{title:'Patchwork',revision:'p1'},openai:{title:'Broken',revision:'b1'}}});
  const {b}=await setup(t,{yard:true,yardPieces});
  await ready(b);
  await b.evaluate("(button=>{button.focus();button.click();})(document.querySelector('#yard-customize-open'))");
  const row=slot=>`document.querySelector('#yard-customize-list [data-slot="${slot}"]')`;
  await b.wait(`${row('anthropic')}?.dataset.state==='custom' && ${row('openai')}?.dataset.state==='failed'`);
  const shown=await b.evaluate(`[...document.querySelectorAll('#yard-customize-list > li')].map(li=>li.dataset.slot?[li.dataset.slot,li.querySelector('.yard-customize-status').textContent,li.querySelectorAll('button')[1].disabled]:li.textContent)`);
  assert.deepEqual(shown,[
    'Yard',['world','Original',true],
    'Characters',['anthropic','Customized: Patchwork',false],['openai','Broken could not load. Showing the original character.',false],['google','Original',true],['xai','Original',true],['shell','Original',true],['docker','Original',true],
    'Companions',['companion','Original',true],
  ]);
  assert.equal(await b.evaluate("document.querySelector('#yard-world-note').textContent"),'Broken could not load. Showing the original character.');
  assert.deepEqual(await b.evaluate("['world','anthropic','shell','companion'].map(s=>(n=>n.hidden?null:n.textContent)(document.querySelector('#yard-customize-list [data-slot='+s+'] .yard-customize-note')))"),
    [null,'Shows on your Claude Code sessions in this Yard.','Shows on your Shell sessions in this Yard.','Shows beside sessions with helpers in this Yard.']);
  await b.evaluate("document.documentElement.dataset.skin='grove'");
  await b.wait(`${row('anthropic')}.dataset.state==='original' && ${row('openai')}.dataset.state==='original'`);
  assert.equal(await b.evaluate("document.querySelector('#yard-customize-sub').textContent"),await b.evaluate("document.querySelector('#yard-title').textContent+' only. Other Yards keep their own.'"));
  await b.evaluate("document.documentElement.dataset.skin='guild'");
  await b.wait(`${row('openai')}.dataset.state==='failed'`);
  yardPieces.current={guild:{anthropic:{title:'Patchwork',revision:'p1'}}};
  yardPieces.emit('updated',yardPieces.current);
  await b.wait(`${row('openai')}.dataset.state==='original' && document.querySelector('#yard-world-note').hidden`);
  await b.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await b.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await b.wait("!document.querySelector('#yard-customize').open && document.activeElement===document.querySelector('#yard-customize-open')");
  assert.deepEqual(b.errors,[]);
});

test('a piece whose texture cannot be decoded falls back to the original without touching other pieces',options,async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'guild-blank-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const glb=await fs.readFile(path.join(PIECE_FILES,'character.glb')),size=glb.readUInt32LE(12),json=JSON.parse(glb.toString('utf8',20,20+size));
  const view=json.bufferViews[json.images[0].bufferView],start=20+size+8+(view.byteOffset||0);
  const blank=Buffer.from(glb);blank.fill(0,start+24,start+view.byteLength);
  await fs.writeFile(path.join(temp,'character.glb'),blank);
  const yardPieces=fakePieces({guild:{anthropic:{revision:'good'},google:{revision:'blank'}}},{google:path.join(temp,'character.glb')});
  const {f,b}=await setup(t,{yardPieces});
  const base=[...f.data.values()][0],by=id=>f.providers.find(p=>p.id===id);
  const sessions=[{...base,id:'claude',provider:by('anthropic'),agents:[],shells:[]},{...base,id:'antigravity',provider:by('google'),agents:[],shells:[]}];
  await b.evaluate(`(async()=>{
    const {YardRenderer}=await import('/yard/renderer.js');
    const host=document.createElement('div'),labels=document.createElement('div');
    host.style.cssText='position:fixed;width:900px;height:700px;top:0;left:0';host.append(labels);document.body.append(host);
    window.__events=[];
    window.__renderer=new YardRenderer(host,labels,{select(){},open(){},piece:e=>{__events.push(e.slot+':'+e.ok);if(!e.ok){const p={...__renderer.pieceSets[e.skin]};delete p[e.slot];__renderer.setPieces(e.skin,p);}}});
    __renderer.setPieces('guild',{anthropic:{revision:'good'},google:{revision:'blank'}});
    await __renderer.setWorld('guild','dark');__renderer.update(${q(f.providers)},${q(sessions)});
  })()`);
  await b.wait("__events.length===2 && ['claude','antigravity'].every(id=>__renderer.units.get(id).loaded)");
  assert.deepEqual(await b.evaluate(`({
    events:__events.slice().sort(),
    original:__renderer.cache.has('hero_2'),
    pieces:[...__renderer.cache.keys()].filter(k=>k.includes('/pieces/')).map(k=>k.replace(/^.*\\/pieces\\//,'')),
    textured:(()=>{let maps=0;__renderer.units.get('claude').model.traverse(n=>{if(n.isMesh&&n.material.map)maps++;});return maps>0;})(),
  })`),{events:['anthropic:true','google:false'],original:true,pieces:['guild/anthropic/character.glb?v=good'],textured:true});
  await b.evaluate('__renderer.dispose()');
  assert.deepEqual(b.errors,[]);
});
test('a rigged mesh the engine cannot bound fails its load and falls back, so drawing and picking keep working',options,async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'guild-bones-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const glb=await fs.readFile(path.join(PIECE_FILES,'character.glb')),size=glb.readUInt32LE(12),json=JSON.parse(glb.toString('utf8',20,20+size));
  const joints=json.accessors[json.meshes[0].primitives[0].attributes.JOINTS_0];
  const bad=Buffer.from(glb);bad[20+size+8+(json.bufferViews[joints.bufferView].byteOffset||0)+(joints.byteOffset||0)]=250;
  await fs.writeFile(path.join(temp,'character.glb'),bad);
  const yardPieces=fakePieces({guild:{google:{revision:'bones'}}},{google:path.join(temp,'character.glb')});
  const {f,b}=await setup(t,{yardPieces});
  const session={...[...f.data.values()][0],id:'antigravity',provider:f.providers.find(p=>p.id==='google'),agents:[],shells:[]};
  await b.evaluate(`(async()=>{
    const {YardRenderer}=await import('/yard/renderer.js');
    const host=document.createElement('div'),labels=document.createElement('div');
    host.style.cssText='position:fixed;width:900px;height:700px;top:0;left:0';host.append(labels);document.body.append(host);
    window.__events=[];
    window.__renderer=new YardRenderer(host,labels,{select(){},open(){},piece:e=>{__events.push(e.slot+':'+e.ok);if(!e.ok)__renderer.setPieces(e.skin,{});}});
    __renderer.setPieces('guild',{google:{revision:'bones'}});
    await __renderer.setWorld('guild','dark');__renderer.update(${q(f.providers)},[${q(session)}]);
  })()`);
  await b.wait("__events.length===1 && __renderer.units.get('antigravity').loaded");
  await b.evaluate("(async()=>{__renderer.dirty=true;__renderer.drawOnce();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const u=__renderer.units.get('antigravity'),p=u.root.position.clone().project(__renderer.camera);__renderer.ray.setFromCamera({x:p.x,y:p.y},__renderer.camera);__renderer.ray.intersectObjects([u.root],true);})()");
  assert.deepEqual(await b.evaluate("({events:__events,original:__renderer.cache.has('hero_2'),piece:[...__renderer.cache.keys()].some(k=>k.includes('/pieces/'))})"),{events:['google:false'],original:true,piece:false});
  await b.evaluate('__renderer.dispose()');
  assert.deepEqual(b.errors,[]);
});
test('a piece with a triangle that misses its vertices fails its load and falls back without disturbing the Yard',options,async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'guild-triangles-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const glb=await fs.readFile(path.join(PIECE_FILES,'character.glb')),size=glb.readUInt32LE(12),json=JSON.parse(glb.toString('utf8',20,20+size));
  const indices=json.accessors[json.meshes[0].primitives[0].indices],bad=Buffer.from(glb);
  bad.writeUInt16LE(250,20+size+8+(json.bufferViews[indices.bufferView].byteOffset||0)+(indices.byteOffset||0));
  await fs.writeFile(path.join(temp,'character.glb'),bad);
  const yardPieces=fakePieces({guild:{google:{revision:'triangles'}}},{google:path.join(temp,'character.glb')});
  const {f,b}=await setup(t,{yardPieces});
  const session={...[...f.data.values()][0],id:'antigravity',provider:f.providers.find(p=>p.id==='google'),agents:[],shells:[]};
  await b.evaluate(`(async()=>{
    const {YardRenderer}=await import('/yard/renderer.js');
    const host=document.createElement('div'),labels=document.createElement('div');
    host.style.cssText='position:fixed;width:900px;height:700px;top:0;left:0';host.append(labels);document.body.append(host);
    window.__events=[];
    window.__renderer=new YardRenderer(host,labels,{select(){},open(){},piece:e=>{__events.push(e.slot+':'+e.ok);if(!e.ok)__renderer.setPieces(e.skin,{});}});
    __renderer.setPieces('guild',{google:{revision:'triangles'}});
    await __renderer.setWorld('guild','dark');__renderer.update(${q(f.providers)},[${q(session)}]);
  })()`);
  await b.wait("__events.length===1 && __renderer.units.get('antigravity').loaded");
  await b.evaluate("(async()=>{for(let i=0;i<3;i++){__renderer.dirty=true;__renderer.drawOnce();await new Promise(r=>requestAnimationFrame(r));}const u=__renderer.units.get('antigravity'),p=u.root.position.clone().project(__renderer.camera);__renderer.ray.setFromCamera({x:p.x,y:p.y},__renderer.camera);__renderer.ray.intersectObjects([u.root],true);})()");
  assert.deepEqual(await b.evaluate("({events:__events,original:__renderer.cache.has('hero_2'),piece:[...__renderer.cache.keys()].some(k=>k.includes('/pieces/'))})"),{events:['google:false'],original:true,piece:false});
  await b.evaluate('__renderer.dispose()');
  assert.deepEqual(b.errors,[]);
});

async function offsetPiece(dir){
  const glb=await fs.readFile(path.join(PIECE_FILES,'character.glb')),size=glb.readUInt32LE(12),json=JSON.parse(glb.toString('utf8',20,20+size));
  const binary=glb.subarray(20+size+8,20+size+8+glb.readUInt32LE(20+size)),most=Math.max(...json.animations.map(a=>json.accessors[a.samplers[0].input].count));
  const offsets=Buffer.alloc(most*12);for(let i=0;i<most;i++)offsets.writeFloatLE(0.5,i*12);
  const view=json.bufferViews.push({buffer:0,byteOffset:binary.length,byteLength:offsets.length})-1,root=json.nodes.findIndex(n=>n.name==='Root');
  for(const animation of json.animations){
    const input=animation.samplers[0].input,output=json.accessors.push({bufferView:view,componentType:5126,count:json.accessors[input].count,type:'VEC3'})-1;
    animation.channels.push({sampler:animation.samplers.push({input,output})-1,target:{node:root,path:'translation'}});
  }
  const data=Buffer.concat([binary,offsets]);json.buffers[0].byteLength=data.length;
  const text=Buffer.from(JSON.stringify(json)),padded=Buffer.concat([text,Buffer.alloc((4-text.length%4)%4,0x20)]);
  const head=Buffer.alloc(20),chunk=Buffer.alloc(8);head.write('glTF',0,'latin1');head.writeUInt32LE(2,4);head.writeUInt32LE(20+padded.length+8+data.length,8);head.writeUInt32LE(padded.length,12);head.write('JSON',16,'latin1');
  chunk.writeUInt32LE(data.length,0);chunk.write('BIN\0',4,'latin1');
  await fs.writeFile(path.join(dir,'character.glb'),Buffer.concat([head,padded,chunk,data]));
  return path.join(dir,'character.glb');
}

test('an animated piece stays pickable and drawn at every pose, with nothing left on its cached asset',options,async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'guild-posed-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const yardPieces=fakePieces({guild:{google:{revision:'posed'},xai:{revision:'offset'}}},{xai:await offsetPiece(temp)});
  const {f,b}=await setup(t,{yardPieces});
  const sessions=[['antigravity','google'],['grok','xai']].map(([id,provider])=>({...[...f.data.values()][0],id,provider:f.providers.find(p=>p.id===provider),agents:[],shells:[]}));
  await b.evaluate(`(async()=>{
    const {YardRenderer}=await import('/yard/renderer.js');
    const host=document.createElement('div'),labels=document.createElement('div');
    host.style.cssText='position:fixed;width:900px;height:700px;top:0;left:0';host.append(labels);document.body.append(host);
    window.__renderer=new YardRenderer(host,labels,{select(){},open(){},piece(){}});
    __renderer.setPieces('guild',{google:{revision:'posed'},xai:{revision:'offset'}});
    await __renderer.setWorld('guild','dark');__renderer.update(${q(f.providers)},${q(sessions)});
  })()`);
  await b.wait("['antigravity','grok'].every(id=>__renderer.units.get(id)?.loaded)");
  const results=await b.evaluate(`(async()=>{
    const T=await import('/yard/vendor/engine.js');
    const r=__renderer,frame=()=>{r.renderer.render(r.scene,r.camera);},out=[];
    frame();
    for(const id of ['antigravity','grok']){const unit=r.units.get(id);let mesh=null;unit.model.traverse(n=>{if(n.isSkinnedMesh)mesh=n;});
    for(const [name,action] of unit.animations)for(const share of [0,0.3,0.6,0.9]){
      unit.mixers[0].stopAllAction();action.reset().play();unit.mixers[0].setTime(action.getClip().duration*share);
      r.scene.updateMatrixWorld(true);mesh.skeleton.update();frame();
      const index=mesh.geometry.index.array,point=new T.Vector3(),corner=new T.Vector3();
      for(let k=0;k<3;k++){mesh.getVertexPosition(index[k],corner);point.add(corner);}
      point.divideScalar(3);mesh.localToWorld(point);
      const ndc=point.clone().project(r.camera);
      r.ray.setFromCamera({x:ndc.x,y:ndc.y},r.camera);
      const hit=r.ray.intersectObject(mesh,false).length>0;
      const drawn=r.renderer.info.render.triangles;mesh.visible=false;frame();const hidden=r.renderer.info.render.triangles;mesh.visible=true;frame();
      out.push({pose:id+' '+name+'@'+share,inView:Math.abs(ndc.x)<1&&Math.abs(ndc.y)<1,hit,culled:drawn<=hidden});
    }}
    let leftover=false;for(const [key,pending] of r.cache)if(key.includes('/pieces/'))(await pending).scene.traverse(n=>{if(n.isSkinnedMesh&&(n.boundingBox||n.boundingSphere))leftover=true;});
    return {out,leftover};
  })()`);
  const wrong=results.out.filter(r=>!r.inView||!r.hit||r.culled);
  assert.deepEqual(wrong,[],'every pose is in view, picked and drawn');
  assert.equal(results.out.length>=48,true);
  assert.equal(results.leftover,false,'the cached piece keeps no bounding volumes from its check');
  await b.evaluate('__renderer.dispose()');
  assert.deepEqual(b.errors,[]);
});
test('a piece with an animation the Yard cannot play fails its load and falls back without disturbing the Yard',options,async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'guild-nan-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const glb=await fs.readFile(path.join(PIECE_FILES,'character.glb')),size=glb.readUInt32LE(12),json=JSON.parse(glb.toString('utf8',20,20+size));
  const sampler=json.animations[0].samplers[json.animations[0].channels[0].sampler],output=json.accessors[sampler.output],bad=Buffer.from(glb);
  const start=20+size+8+(json.bufferViews[output.bufferView].byteOffset||0)+(output.byteOffset||0);
  for(let i=0;i<output.count*4;i++)bad.writeFloatLE(NaN,start+i*4);
  await fs.writeFile(path.join(temp,'character.glb'),bad);
  const yardPieces=fakePieces({guild:{google:{revision:'nan'}}},{google:path.join(temp,'character.glb')});
  const {f,b}=await setup(t,{yardPieces});
  const session={...[...f.data.values()][0],id:'antigravity',provider:f.providers.find(p=>p.id==='google'),agents:[],shells:[]};
  await b.evaluate(`(async()=>{
    const {YardRenderer}=await import('/yard/renderer.js');
    const host=document.createElement('div'),labels=document.createElement('div');
    host.style.cssText='position:fixed;width:900px;height:700px;top:0;left:0';host.append(labels);document.body.append(host);
    window.__events=[];
    window.__renderer=new YardRenderer(host,labels,{select(){},open(){},piece:e=>{__events.push(e.slot+':'+e.ok);if(!e.ok)__renderer.setPieces(e.skin,{});}});
    __renderer.setPieces('guild',{google:{revision:'nan'}});
    await __renderer.setWorld('guild','dark');__renderer.update(${q(f.providers)},[${q(session)}]);
  })()`);
  await b.wait("__events.length===1 && __renderer.units.get('antigravity').loaded");
  await b.evaluate("(async()=>{for(let i=0;i<3;i++){__renderer.dirty=true;__renderer.drawOnce();await new Promise(r=>requestAnimationFrame(r));}})()");
  assert.deepEqual(await b.evaluate("({events:__events,original:__renderer.cache.has('hero_2'),piece:[...__renderer.cache.keys()].some(k=>k.includes('/pieces/'))})"),{events:['google:false'],original:true,piece:false});
  await b.evaluate('__renderer.dispose()');
  assert.deepEqual(b.errors,[]);
});
test('a piece whose rotations are not unit quaternions fails its load and falls back without disturbing the Yard',options,async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'guild-quaternion-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const glb=await fs.readFile(path.join(PIECE_FILES,'character.glb')),size=glb.readUInt32LE(12),json=JSON.parse(glb.toString('utf8',20,20+size));
  const sampler=json.animations[0].samplers[json.animations[0].channels[0].sampler],output=json.accessors[sampler.output],bad=Buffer.from(glb);
  const start=20+size+8+(json.bufferViews[output.bufferView].byteOffset||0)+(output.byteOffset||0);
  for(let i=0;i<output.count;i++)[0.5,0.5,0,0].forEach((value,k)=>bad.writeFloatLE(value,start+(i*4+k)*4));
  await fs.writeFile(path.join(temp,'character.glb'),bad);
  const yardPieces=fakePieces({guild:{google:{revision:'half'}}},{google:path.join(temp,'character.glb')});
  const {f,b}=await setup(t,{yardPieces});
  const session={...[...f.data.values()][0],id:'antigravity',provider:f.providers.find(p=>p.id==='google'),agents:[],shells:[]};
  await b.evaluate(`(async()=>{
    const {YardRenderer}=await import('/yard/renderer.js');
    const host=document.createElement('div'),labels=document.createElement('div');
    host.style.cssText='position:fixed;width:900px;height:700px;top:0;left:0';host.append(labels);document.body.append(host);
    window.__events=[];
    window.__renderer=new YardRenderer(host,labels,{select(){},open(){},piece:e=>{__events.push(e.slot+':'+e.ok);if(!e.ok)__renderer.setPieces(e.skin,{});}});
    __renderer.setPieces('guild',{google:{revision:'half'}});
    await __renderer.setWorld('guild','dark');__renderer.update(${q(f.providers)},[${q(session)}]);
  })()`);
  await b.wait("__events.length===1 && __renderer.units.get('antigravity').loaded");
  await b.evaluate("(async()=>{for(let i=0;i<3;i++){__renderer.dirty=true;__renderer.drawOnce();await new Promise(r=>requestAnimationFrame(r));}})()");
  assert.deepEqual(await b.evaluate("({events:__events,original:__renderer.cache.has('hero_2'),piece:[...__renderer.cache.keys()].some(k=>k.includes('/pieces/'))})"),{events:['google:false'],original:true,piece:false});
  await b.evaluate('__renderer.dispose()');
  assert.deepEqual(b.errors,[]);
});
test('restoring a piece or disposing the Yard cancels its download, and the original still draws',options,async t=>{
  const yardPieces=fakePieces({guild:{anthropic:{revision:'first'}}});
  const {f,b}=await setup(t,{yardPieces,source:`
    const originalFetch=window.fetch;window.__held=[];
    window.fetch=(...args)=>{
      const url=String(args[0]?.url||args[0]);
      if(!url.includes('/yard/pieces/'))return originalFetch(...args);
      const signal=args[0]?.signal||args[1]?.signal,entry={url,signal};window.__held.push(entry);
      return new Promise((resolve,reject)=>signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))));
    };`});
  const session={...[...f.data.values()][0],id:'claude',provider:f.providers.find(p=>p.id==='anthropic'),agents:[],shells:[]};
  await b.evaluate(`(async()=>{
    const {YardRenderer}=await import('/yard/renderer.js');
    const host=document.createElement('div'),labels=document.createElement('div');
    host.style.cssText='position:fixed;width:900px;height:700px;top:0;left:0';host.append(labels);document.body.append(host);
    window.__renderer=new YardRenderer(host,labels,{select(){},open(){},piece(){}});
    __renderer.setPieces('guild',{anthropic:{revision:'first'}});
    await __renderer.setWorld('guild','dark');__renderer.update(${q(f.providers)},[${q(session)}]);
  })()`);
  await b.wait("__held.some(h=>h.url.includes('v=first'))");
  await b.evaluate("__renderer.setPieces('guild',{})");
  await b.wait("__renderer.units.get('claude').loaded && __renderer.cache.has('hero_0')");
  assert.equal(await b.evaluate("__held.filter(h=>h.url.includes('v=first')).every(h=>h.signal?.aborted)"),true,'restoring cancels the download');
  await b.evaluate("__renderer.setPieces('guild',{anthropic:{revision:'second'}})");
  await b.wait("__held.some(h=>h.url.includes('v=second'))");
  await b.evaluate('__renderer.dispose()');
  assert.equal(await b.evaluate("__held.filter(h=>h.url.includes('v=second')).every(h=>h.signal?.aborted)"),true,'disposing cancels the download');
  assert.deepEqual(b.errors,[]);
});
test('a Yard that reloads shows its pieces as loading until they draw, and a failed piece stays failed without new downloads',options,async t=>{
  const yardPieces=fakePieces({guild:{anthropic:{title:'Patchwork',revision:'p1'}}});
  const {b}=await setup(t,{yard:true,yardPieces,source:`
    const originalFetch=window.fetch;window.__mode='fail';window.__held=[];window.__requests=0;
    window.fetch=(...args)=>{
      const url=String(args[0]?.url||args[0]);
      if(!url.includes('/yard/pieces/'))return originalFetch(...args);
      window.__requests++;
      if(window.__mode==='pass')return originalFetch(...args);
      if(window.__mode==='fail')return Promise.reject(new TypeError('Fixture download failed'));
      return new Promise((resolve,reject)=>window.__held.push(()=>originalFetch(...args).then(resolve,reject)));
    };`});
  await ready(b);
  await b.evaluate("(x=>{x.focus();x.click();})(document.querySelector('#yard-customize-open'))");
  const status="document.querySelector('#yard-customize-list [data-slot=anthropic] .yard-customize-status').textContent";
  const visit=async()=>{
    await b.evaluate("document.documentElement.dataset.skin='grove'");await b.wait("document.querySelector('#yard-stage').dataset.world==='grove'");
    await b.evaluate("document.documentElement.dataset.skin='guild'");await b.wait("document.querySelector('#yard-stage').dataset.world==='guild'");
  };
  await b.wait(status+"==='Patchwork could not load. Showing the original character.'");
  const requests=await b.evaluate('__requests');
  await b.evaluate("__mode='pass'");
  await visit();
  assert.equal(await b.evaluate(status),'Patchwork could not load. Showing the original character.','a failed piece keeps its failure after a reload');
  assert.equal(await b.evaluate('__requests'),requests,'a failed piece is not downloaded again');
  yardPieces.current={guild:{anthropic:{title:'Patchwork',revision:'p2'}}};yardPieces.emit('updated',yardPieces.current);
  await b.wait(status+"==='Customized: Patchwork'");
  await b.evaluate("__mode='hold'");
  await visit();
  await b.wait("__held.length>0");
  assert.equal(await b.evaluate(status),'Loading Patchwork…','a reload shows the piece as loading while it downloads');
  await b.evaluate("__mode='pass';for(const go of __held.splice(0))go()");
  await b.wait(status+"==='Customized: Patchwork'");
  assert.deepEqual(b.errors,[]);
});

test('the row being replaced says Checking replacement until the check answers',options,async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'guild-checking-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  await fs.mkdir(path.join(temp,'mine'));
  await fs.writeFile(path.join(temp,'mine','piece.json'),JSON.stringify({format:1,kind:'character',title:'Mine'}));
  await fs.copyFile(path.join(PIECE_FILES,'character.glb'),path.join(temp,'mine','character.glb'));
  const yardPieces=fakePieces({});let answer;
  yardPieces.replace=(skin,slot)=>new Promise(resolve=>{answer=()=>{yardPieces.current={[skin]:{[slot]:{title:'Mine',revision:'m1'}}};yardPieces.emit('updated',yardPieces.current);resolve(yardPieces.current);};});
  const {b}=await setup(t,{yard:true,yardPieces,source:`localStorage.setItem('agentGuild.pieceFolder',${q(temp)});`});
  await ready(b);
  await b.evaluate("(x=>{x.focus();x.click();})(document.querySelector('#yard-customize-open'))");
  const status="document.querySelector('#yard-customize-list [data-slot=anthropic] .yard-customize-status').textContent";
  await b.wait(status+"==='Original'");
  await b.evaluate("document.querySelector('#yard-customize-list [data-slot=anthropic] button').click()");
  await b.wait("[...document.querySelectorAll('.folder-piece-title')].some(e=>e.textContent==='Mine')");
  await b.evaluate("[...document.querySelectorAll('.folder-piece')].find(r=>r.querySelector('.folder-piece-title').textContent==='Mine').click()");
  await b.wait(status+"==='Checking replacement…'");
  assert.equal(await b.evaluate("document.querySelector('#yard-customize-list [data-slot=openai] .yard-customize-status').textContent"),'Original','only the row being replaced says it is checking');
  answer();
  await b.wait(status+"==='Customized: Mine'");
  assert.deepEqual(b.errors,[]);
});
test('Vibes Mode sets every character wandering and every helper flying, and turning it off or reducing motion puts them back',options,async t=>{
  const {f,b}=await setup(t);
  const T0=Date.parse('2026-10-13T12:00:00.000Z'),iso=ms=>new Date(T0-ms).toISOString();
  const sessions=[...f.data.values()].slice(0,3).map((s,i)=>({...s,activity:'active',lastOutputAt:iso(0),createdAt:iso(3600000),shells:[],
    agents:i===0?[{id:'a1',name:'Explorer',status:'working'}]:[]}));
  await b.evaluate(`(async()=>{
    const {YardRenderer}=await import('/yard/renderer.js');
    window.__model=await import('/yard/model.mjs');
    const host=document.createElement('div'),labels=document.createElement('div');
    const top=document.createElement('div'),bottom=document.createElement('div');
    top.style.cssText='position:absolute;top:0;left:0;right:0;height:90px';bottom.style.cssText='position:absolute;bottom:0;left:0;right:0;height:120px';
    host.style.cssText='position:fixed;width:900px;height:700px;top:0;left:0';host.append(labels,top,bottom);document.body.append(host);
    window.__renderer=new YardRenderer(host,labels,{select(){},open(){},clock:()=>${T0},cover:[top,bottom]});
    window.__sessions=${q(sessions)};window.__providers=${q(f.providers)};
    await __renderer.setWorld('guild','dark');__renderer.update(__providers,__sessions);
    window.__units=()=>[...__renderer.units.values()];
    window.__home=()=>[...__renderer.units].every(([id,u])=>{const p=__renderer.staged.places.get(id);return !u.moving&&u.root.position.x===p.x&&u.root.position.z===p.z;});
    window.__run=n=>{for(let i=0;i<n;i++)__renderer.step(.05);};
    window.__settle=()=>{let n=0;while(__units().some(u=>u.moving)&&n<4000){__renderer.step(.05);n++;}return n;};
    window.__offScreen=()=>{
      const camera=__renderer.camera,w=host.clientWidth,h=host.clientHeight,v=camera.position.clone(),out=[];
      const px=(x,y,z)=>{v.set(x,y,z).project(camera);return {x:(v.x+1)/2*w,y:(1-v.y)/2*h};};
      const off=p=>p.y<90||p.y>h-120||p.x<0||p.x>w,edge=__model.VIBE.roam.edge*h*camera.zoom/__model.CAMERA.height-.5;
      for(const u of __units()){
        const t=u.target,feet=px(t.x,0,t.z),head=px(t.x,__model.VIBE.roam.head,t.z);
        if([feet,head].some(p=>p.x<edge||p.x>w-edge)||head.y<134+edge||feet.y>h-120-edge)out.push(['stop',t]);
        for(const helper of u.helpers){const p=helper.model.position;if(off(px(p.x,p.y,p.z)))out.push(['helper',p.x,p.y,p.z]);}
      }
      return out;
    };
    window.__helper=()=>{const h=__renderer.units.get(__sessions[0].id).helpers[0];return {y:h.model.position.y,scale:h.model.scale.x,clip:h.action.getClip().name};};
  })()`);
  await b.wait('__units().every(u=>u.loaded)&&__units()[0].helpers.length===1');
  assert.equal(await b.evaluate('__home()'),true,'sessions open at their stations');
  const roaming=await b.evaluate(`(()=>{
    __renderer.setVibe(true);
    const u=__units()[0],from={x:u.root.position.x,z:u.root.position.z},leg=Math.hypot(u.path[0].x-from.x,u.path[0].z-from.z);
    __renderer.step(.05);
    const first={moved:Math.hypot(u.root.position.x-from.x,u.root.position.z-from.z),pace:u.speed*.05,leg};
    __run(800);
    const boxes=[...__model.providerPositions(__providers)].map(([id,p])=>({...p,half:id==='docker'?__model.STAGING.hall.docker:__model.STAGING.hall.half}));
    return {first,moving:__units().every(u=>u.moving),clips:__units().map(u=>u.clip),legs:__units().map(u=>u.roamed),
      inHall:__units().some(u=>boxes.some(b=>Math.abs(u.root.position.x-b.x)<b.half-.06&&Math.abs(u.root.position.z-b.z)<b.half-.06)),helper:__helper(),offScreen:__offScreen()};
  })()`);
  assert.ok(roaming.first.leg<roaming.first.pace||Math.abs(roaming.first.moved-roaming.first.pace)<1e-9,'a character walks at its usual speed');
  assert.equal(roaming.moving,true,'every character keeps walking');
  assert.deepEqual(roaming.clips,sessions.map(()=>'walk'));
  assert.ok(roaming.legs.every(n=>n>=1),'each has gone on from its first stop');
  assert.equal(roaming.inHall,false,'none walks through a hall');
  const flight=await b.evaluate('__model.VIBE.flight');
  assert.ok(roaming.helper.y>=flight.height[0]-.5&&roaming.helper.y<=flight.height[1],'the helper flies');
  assert.ok(Math.abs(roaming.helper.scale-flight.scale)<1e-6,'at its flying size');
  assert.equal(roaming.helper.clip,'move');
  assert.deepEqual(roaming.offScreen,[],'every stop and helper stays on screen, clear of what covers it');
  const turned=await b.evaluate(`(()=>{const frame=__model.vibeFrame(380/700,134/700,120/700),count=()=>__units().filter(u=>!__model.inVibeFrame(frame,u.target.x,0,u.target.z)||!__model.inVibeFrame(frame,u.target.x,__model.VIBE.roam.head,u.target.z)).length;
    for(let n=0;n<4000&&!count();n++)__renderer.step(.05);
    const leaving=count();__renderer.host.style.width='380px';__renderer.resize();const stops=__offScreen().filter(([kind])=>kind==='stop');__run(200);return {leaving,stops,after:__offScreen(),moving:__units().every(u=>u.moving)};})()`);
  assert.ok(turned.leaving>0,'the turn leaves someone heading off screen');
  assert.deepEqual(turned.stops,[],'turned to portrait, nobody heads off screen');
  assert.deepEqual(turned.after,[],'and everyone stays on screen');
  assert.equal(turned.moving,true);
  assert.equal(await b.evaluate(`(()=>{const before=__units().map(u=>u.target);__renderer.update(__providers,__sessions);return __units().every((u,i)=>u.target===before[i]&&u.moving);})()`),true);
  assert.ok(await b.evaluate('(__renderer.setVibe(false),__settle())')<4000,'turned off, everyone walks back');
  assert.equal(await b.evaluate('__home()'),true);
  assert.ok(await b.evaluate('__units().every(u=>__model.CLIPS.character.work.includes(u.clip))'),'and takes up its work');
  const landed=await b.evaluate('(__run(200),__helper())');
  assert.ok(Math.abs(landed.y-.27)<.01&&Math.abs(landed.scale-.45)<1e-6,'the helper comes back down beside its character');
  assert.equal(await b.evaluate('(__renderer.setVibe(true),__run(100),__renderer.setReducedMotion(true),__home())'),true,'reduced motion puts everyone back at once');
  assert.deepEqual(await b.evaluate('__helper()').then(h=>[h.y,h.scale]),[.27,.45]);
  assert.equal(await b.evaluate('(__renderer.setReducedMotion(false),__units().every(u=>u.moving))'),true,'and they wander again when motion returns');
  await b.evaluate('__renderer.dispose()');
  assert.deepEqual(b.errors,[]);
});

test('Vibes destination selection keeps normal and crowded crews moving through portrait resizing and a covered view',options,async t=>{
  const {f,b}=await setup(t),now=Date.parse('2026-10-13T12:00:00.000Z');
  await b.evaluate(`(async()=>{
    const {YardRenderer}=await import('/yard/renderer.js');window.__destModel=await import('/yard/model.mjs');
    const host=document.createElement('div'),labels=document.createElement('div'),top=document.createElement('div'),bottom=document.createElement('div');
    host.style.cssText='position:fixed;top:0;left:0;width:900px;height:700px';
    top.style.cssText='position:absolute;top:0;width:100%;height:90px';bottom.style.cssText='position:absolute;bottom:0;width:100%;height:120px';
    host.append(labels,top,bottom);document.body.append(host);
    const r=window.__destRenderer=new YardRenderer(host,labels,{select(){},open(){},clock:()=>${now},cover:[top,bottom]});
    window.__destCover={top,bottom};
    window.__destProviders=${q([...f.providers,{id:'docker',tool:'Docker Agent',available:true}])};
    await r.setWorld('guild','dark');
    window.__destCalls=0;window.__destTimes=[];window.__destOutside=[];window.__destExpectVisible=true;
    window.__destVisible=p=>__destModel.inVibeFrame(r.vibeFrames.stop,p.x,0,p.z)&&__destModel.inVibeFrame(r.vibeFrames.stop,p.x,__destModel.VIBE.roam.head,p.z);
    const roam=r.roam;r.roam=function(u){const at=performance.now();roam.call(this,u);__destTimes.push(performance.now()-at);__destCalls++;if(__destExpectVisible&&!__destVisible(u.target))__destOutside.push(u.target);};
    window.__destStats=values=>{const sorted=[...values].sort((a,b)=>a-b),at=p=>Number((sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))]||0).toFixed(3));return {p50:at(.5),p95:at(.95),max:at(1)};};
    window.__destUpdates=()=>{
      const calls=__destCalls,targets=[...r.units.values()].map(u=>u.target),times=[];
      for(let n=0;n<40;n++){const at=performance.now();r.update(__destProviders,__destSessions);times.push(performance.now()-at);}
      return {ms:__destStats(times),searches:__destCalls-calls,sameTargets:[...r.units.values()].every((u,i)=>u.target===targets[i])};
    };
    window.__destWalk=()=>{
      const units=[...r.units.values()],distance=units.map(()=>0),legs=units.map(u=>u.roamed),steps=[];
      for(let n=0;n<1600;n++){
        const before=units.map(u=>({x:u.root.position.x,z:u.root.position.z})),at=performance.now();r.step(.05);steps.push(performance.now()-at);
        units.forEach((u,i)=>{distance[i]+=Math.hypot(u.root.position.x-before[i].x,u.root.position.z-before[i].z);});
      }
      return {ms:__destStats(steps),minDistance:Math.min(...distance),minLegs:Math.min(...units.map((u,i)=>u.roamed-legs[i])),moving:units.every(u=>u.moving&&u.path.length>0)};
    };
  })()`);
  t.after(()=>b.evaluate('__destRenderer.dispose();__destRenderer.host.remove()'));
  for(const [name,count,provider] of [['normal',3,null],['crowded-xai',24,'xai'],['crowded-openai',24,'openai']]){
    const sessions=Array.from({length:count},(_,i)=>({...f.data.values().next().value,id:name+'-'+i,name:name+' '+i,
      provider:f.providers.find(p=>p.id===(provider||f.providers[i%f.providers.length].id)),activity:'active',createdAt:new Date(now-3600000).toISOString(),lastOutputAt:new Date(now).toISOString(),agents:[],shells:[]}));
    await b.evaluate(`(()=>{const r=__destRenderer;r.setVibe(false);__destExpectVisible=true;r.host.style.width='900px';r.host.style.height='700px';__destCover.top.style.height='90px';__destCover.bottom.style.height='120px';r.resize();window.__destSessions=${q(sessions)};r.update(__destProviders,__destSessions);})()`);
    await b.wait('[...__destRenderer.units.values()].every(u=>u.loaded)');
    const result=await b.evaluate(`(()=>{
      const r=__destRenderer,slots=JSON.stringify([...r.staged.slots]);__destTimes=[];__destOutside=[];
      const at=performance.now();r.setVibe(true);const activationMs=performance.now()-at;
      const landscape={updates:__destUpdates(),walk:__destWalk()};
      r.host.style.width='360px';r.host.style.height='780px';__destCover.bottom.style.height='195px';
      const turn=performance.now();r.resize();const resizeMs=performance.now()-turn;
      const portrait={updates:__destUpdates(),walk:__destWalk()};
      __destExpectVisible=false;__destCover.top.style.height='500px';__destCover.bottom.style.height='500px';r.resize();
      const covered={updates:__destUpdates(),walk:__destWalk()};
      __destExpectVisible=true;__destCover.top.style.height='90px';__destCover.bottom.style.height='195px';r.resize();
      const recovered=[...r.units.values()].every(u=>u.moving&&__destVisible(u.target));
      return {activationMs,resizeMs,landscape,portrait,covered,recovered,outside:__destOutside,roamMs:__destStats(__destTimes),sameSlots:JSON.stringify([...r.staged.slots])===slots};
    })()`);
    for(const phase of ['landscape','portrait','covered']){
      assert.equal(result[phase].updates.searches,0,`${name} ${phase}: unchanged snapshots do not select destinations again`);
      assert.equal(result[phase].updates.sameTargets,true);
      assert.equal(result[phase].walk.moving,true,`${name} ${phase}: nobody freezes`);
      assert.ok(result[phase].walk.minDistance>1&&result[phase].walk.minLegs>=1,`${name} ${phase}: every character travels and starts another leg`);
    }
    assert.deepEqual(result.outside,[],`${name}: every newly chosen destination fits the usable view`);
    assert.equal(result.recovered,true,`${name}: uncovering the view immediately restores visible destinations`);
    assert.equal(result.sameSlots,true,`${name}: station slots stay unchanged`);
    t.diagnostic(JSON.stringify({name,...result}));
  }
  assert.deepEqual(b.errors,[]);
});

test('the Vibes Mode button stays on across Yards and reloads, and reduced motion disables it',options,async t=>{
  const {b}=await setup(t,{yard:true});
  const button="document.querySelector('#yard-vibe')",state='['+button+'.getAttribute("aria-pressed"),'+button+'.disabled,localStorage.getItem("agentGuild.vibe")]';
  await ready(b);
  assert.deepEqual(await b.evaluate(state),['false',true,null]);
  assert.match(await b.evaluate(button+'.title'),/reduced motion/);
  await b.evaluate(`(async()=>{
    const {YardRenderer}=await import('/yard/renderer.js'),original=YardRenderer.prototype.setVibe;
    window.__vibes=[];
    YardRenderer.prototype.setVibe=function(value){window.__vibes.push(value);window.__yardRenderer=this;return original.call(this,value);};
  })()`);
  await b.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await b.wait(button+'.disabled===false');
  assert.equal(await b.evaluate(button+'.getAttribute("aria-label")'),'Vibes Mode');
  assert.equal(await b.evaluate(button+'.previousElementSibling.id'),'yard-fireworks');
  await b.click('#yard-vibe');
  assert.deepEqual(await b.evaluate(state),['true',false,'on']);
  assert.deepEqual(await b.evaluate('[__vibes,__yardRenderer.vibe]'),[[true],true]);
  await b.evaluate("document.documentElement.dataset.skin='orbital'");
  await b.wait("document.querySelector('#yard-stage').dataset.world==='orbital'");
  assert.deepEqual(await b.evaluate('['+button+'.getAttribute("aria-pressed"),__yardRenderer.vibe]'),['true',true],'another Yard keeps it');
  await b.reload();await ready(b);
  assert.deepEqual(await b.evaluate(state),['true',false,'on'],'a reload keeps it');
  await b.click('#yard-vibe');
  assert.deepEqual(await b.evaluate(state),['false',false,'off']);
  assert.deepEqual(b.errors,[]);
});
