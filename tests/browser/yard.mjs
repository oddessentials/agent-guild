import test from 'node:test';
import assert from 'node:assert/strict';
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
async function setup(t,{yard=false,auth=true,source='',width=1440,height=1000}={}) {
  const fixture=await startFixture();t.after(()=>fixture.close());
  const b=await browser();
  await b.send('Page.navigate',{url:'about:blank'});
  await b.wait('document.readyState==="complete"');
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
  await b.send('Page.navigate',{url:fixture.api.url+'/' +(auth?'#token='+fixture.token:'')});
  await b.wait(auth?"document.querySelector('#connection')?.classList.contains('ok')":"document.querySelector('#auth')?.hidden===false");
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
  // Reduced motion: a change of place is immediate, with no walk.
  await b.evaluate(`__renderer.setReducedMotion(true);__sessions[0].activity='active';__sessions[0].lastOutputAt=${q(iso(0))};__renderer.update(__providers,__sessions)`);
  assert.equal(await b.evaluate(`${unit}.moving`),false);
  assert.deepEqual(await b.evaluate(`__at(${q(id)})`),await b.evaluate(`__place(${q(id)})`),'reduced motion places it at once');
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

test('Cards and Yard use the same actions, accounts, dialogs and terminal',options,async t=>{
  const {f,b}=await setup(t);
  await b.wait("document.querySelector('#providers .usage .meter')");
  assert.equal(b.requests.some(r=>/\/yard\/(assets|vendor|renderer)/.test(r.url)),false,'Cards does not load the world or graphics engine');
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
    const camera=Object.assign(document.createElement('div'),{className:'yard-camera'});camera.style.inset='0';__host.append(camera);
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
