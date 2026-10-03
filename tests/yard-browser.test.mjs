import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../docs/yard/fixture.mjs';
import { browserBinary, openBrowser, pause, until } from '../docs/yard/browser.mjs';

const options={skip:!browserBinary && 'Set CHROME_PATH to run browser coverage',timeout:180000};
const q=JSON.stringify;
const inspector='#yard-inspector';
const provider=id=>`.yard-row[data-key="provider:${id}"]`;
const session=id=>`.yard-row[data-key="session:${id}"]`;
async function setup(t,{yard=false,auth=true,source='',...size}={}) {
  const fixture=await startFixture();t.after(()=>fixture.close());
  const b=await openBrowser(size);t.after(()=>b.close());
  await b.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await b.send('Page.addScriptToEvaluateOnNewDocument',{source:`
    localStorage.setItem('agentGuild.theme','dark');
    localStorage.setItem('agentGuild.view',${q(yard?'yard':'cards')});
    window.confirm=()=>true; window.prompt=()=>'Renamed from Yard';
    window.__frames=0;
    const raf=window.requestAnimationFrame;
    window.requestAnimationFrame=callback=>raf.call(window,time=>{window.__frames++;callback(time);});
    ${source}`});
  await b.send('Page.navigate',{url:fixture.api.url+'/' +(auth?'#token='+fixture.token:'')});
  await b.wait(auth?"document.querySelector('#connection')?.classList.contains('ok')":"document.querySelector('#auth')?.hidden===false");
  return {f:fixture,b};
}
const fill=(b,selector,value)=>b.evaluate(`document.querySelector(${q(selector)}).value=${q(value)};document.querySelector(${q(selector)}).dispatchEvent(new Event('input',{bubbles:true}))`);
const closeTerminal=b=>b.click('#panel-close');
const terminalReady=b=>b.wait("!document.querySelector('#terminal-panel').hidden && document.querySelector('#terminal-host .xterm')");
const ready=b=>b.wait("document.querySelector('#yard-stage').dataset.ready==='true'");

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
  const disabled=selector=>b.evaluate(`document.querySelector(${q(selector)}).disabled`);
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
  await pause(100);assert.equal(pending.length,1,'duplicate submissions through either view are blocked');

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
  await until(()=>installs.length===2);
  assert.deepEqual(installs.map(p=>p.args[1]),[{force:false},{force:true}]);
  assert.equal(await disabled(card+' .update'),true);
  await fill(b,'#cwd','project-c');
  assert.equal(await disabled(card+' .new'),false,'install has no shared New/Resume pending flag');
  await b.click(card+' .new');await until(()=>pending.length===4);
  installs[1].finish();await terminalReady(b);await closeTerminal(b);
  assert.equal(await disabled(card+' .new'),true,'install completion does not clear New');
  assert.equal(await disabled(card+' .update'),false);
  pending[3].finish(Object.assign(new Error('Fixture start failed'),{status:400,code:'fixture_failure'}));
  await b.wait(`!document.querySelector('${card} .new').disabled`);
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
  const disabled=selector=>b.evaluate(`document.querySelector(${q(selector)}).disabled`);
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
  await pause(100);assert.equal(pending.length,2,'manual id and history cannot duplicate a card Resume');
  await b.click('#history-close');await b.click(inspector+' [data-account="work"]');
  await b.click(inspector+' .existing');await b.wait(`document.querySelector(${q(history)}) && !document.querySelector(${q(history)}).disabled`);
  await b.click(history);await until(()=>pending.length===3);
  await b.click('#history-close');await b.click(inspector+' [data-account="default"]');
  await b.click(inspector+' .existing');await b.wait(`document.querySelector(${q(missing)})`);
  await b.click(missing);await until(()=>pending.length===4);
  pending[2].finish();await terminalReady(b);await closeTerminal(b);
  await b.click(inspector+' .existing');await b.wait("document.querySelector('#history').open");
  assert.equal(await disabled(history),true,'Work completion leaves Personal pending');
  assert.equal(await disabled(missing),true,'one conversation cannot clear another');
  pending[1].finish(Object.assign(new Error('Fixture resume failed'),{status:400,code:'fixture_failure'}));
  await b.wait(`!document.querySelector(${q(history)}).disabled`);
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

test('Cards and Yard use the same actions, accounts, dialogs and terminal',options,async t=>{
  const {f,b}=await setup(t);
  await b.wait("document.querySelector('#providers .usage .meter')");
  assert.equal(b.requests.some(r=>/\/yard\/(assets|vendor|renderer)/.test(r.url)),false,'Cards does not load the world or graphics engine');
  await fill(b,'#cwd','E:\\projects\\parity');
  await b.click('#providers [data-id="anthropic"] [data-account="work"]');
  await b.click('#providers [data-id="anthropic"] .new');await terminalReady(b);
  const fromCards=f.calls.find(c=>c[0]==='create')[1];
  const terminal=await b.evaluate("window.__terminal=document.querySelector('#terminal-host .xterm');Boolean(window.__terminal)");
  assert.equal(terminal,true);
  const sockets=b.events.filter(e=>e.method==='Network.webSocketCreated').length;
  await b.click('#view-yard');await ready(b);
  assert.equal(await b.evaluate("window.__terminal===document.querySelector('#terminal-host .xterm')"),true);
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
  await b.click(inspector+' .existing');await b.wait("document.querySelector('#history').open");
  await b.click('#history-list [data-id="history-1"] .history-resume');await terminalReady(b);
  assert.equal(f.calls.filter(c=>c[0]==='create').length,creates,'history reuses the running session');
  await closeTerminal(b);
  await b.click(inspector+' .existing');await b.wait("document.querySelector('#history').open");
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
  await b.click(session(id));await b.click(inspector+' .rename');
  await b.wait(`document.querySelector('${inspector} .name').textContent==='Renamed from Yard'`);
  assert.equal(f.data.get(id).name,'Renamed from Yard');
  await b.click(inspector+' .stop');await b.wait(`document.querySelector('${inspector} .resume').hidden===false`);
  await b.click(inspector+' .resume');await terminalReady(b);await closeTerminal(b);
  assert.equal(f.calls.filter(c=>c[0]==='create').at(-1)[1].resume,f.data.get(id).toolSessionId);
  await b.click(inspector+' .remove');await b.wait(`!document.querySelector(${q(session(id))})`);
  assert.equal(f.data.has(id),false);assert.equal(await b.evaluate("document.querySelector('#yard-inspector').children.length"),0);
  await b.click('#yard-news');await b.wait("document.querySelector('#news').open");await b.click('#news-close');
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
  await b.click('#github-close');
  await b.click('#upgrade');await terminalReady(b);assert.ok(f.calls.some(c=>c[0]==='upgrade'));await closeTerminal(b);
  assert.deepEqual(b.errors,[]);
});

test('Yard retains every session through skins, reduced motion, mobile and reconnect',options,async t=>{
  const {f,b}=await setup(t,{yard:true});await ready(b);
  for(let i=0;i<34;i++)f.add({providerId:'anthropic',name:'Extra session '+i,quiet:true});
  await b.wait("document.querySelectorAll('.yard-row[data-key^=\"session:\"]').length===40");
  const last=[...f.data.values()].at(-1);await b.click(session(last.id));
  await b.click('#yard-focus');
  for(const skin of ['orbital','grove','professional','guild']){
    await b.click('#appearance');await b.click(`input[name=skin][value=${skin}]`);
    await b.evaluate("document.querySelector('#appearance-menu').hidePopover()");
    await b.wait(`document.documentElement.dataset.skin===${q(skin)}`);
    await b.wait(`document.querySelector('#yard-stage').dataset.world===${q(skin)}`);
    assert.equal(await b.evaluate(`document.querySelector('${inspector} .session-card').dataset.id`),last.id);
    assert.equal(await b.evaluate("document.querySelector('#yard-failure').hidden"),true);
  }
  // Wait for all asset loads, then an unchanged reduced-motion scene has no frame loop.
  await pause(1200);const frames=await b.evaluate('window.__frames');await pause(600);
  assert.equal(await b.evaluate('window.__frames'),frames,'reduced motion renders only on changes');
  await b.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await pause(300);
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
    window.fetch=async(...args)=>{
      const url=String(args[0]?.url||args[0]);
      if(/\\/(guild|orbital)\\.glb$/.test(url))await new Promise(resolve=>setTimeout(resolve,700));
      return originalFetch(...args);
    };`});
  await b.evaluate("document.documentElement.dataset.skin='grove'");
  await ready(b);await b.wait("document.querySelector('#yard-stage').dataset.world==='grove'");
  await b.evaluate("document.documentElement.dataset.skin='orbital'");
  await pause(100);
  await b.evaluate("document.documentElement.dataset.skin='grove'");
  await pause(1200);
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

test('a stalled world times out, aborts its request and can be retried',options,async t=>{
  const {b}=await setup(t,{yard:true,source:`
    const originalTimeout=window.setTimeout,originalFetch=window.fetch;
    window.__stallWorld=true;window.__abortedWorld=false;
    window.setTimeout=(callback,delay,...args)=>originalTimeout(callback,window.__stallWorld && delay===30000?100:delay,...args);
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
  await b.click('#restart-manager');await until(()=>f.calls.some(c=>c[0]==='shutdown' && c[1]));
  await b.wait("!document.querySelector('#app').hidden && document.querySelector('#stopped').hidden && document.querySelector('#version').textContent==='v1.1.0'");
  assert.equal(await b.evaluate("document.documentElement.dataset.view"),'yard');
  assert.equal(await b.evaluate("document.querySelectorAll('.yard-row[data-key^=\"session:\"]').length"),0);
  f.add({providerId:'openai'});await b.wait("document.querySelector('.yard-row[data-key^=\"session:\"]')");
  await b.click('#stop-manager');await b.wait("!document.querySelector('#stopped').hidden && !document.querySelector('#stopped-help').hidden");
  assert.equal(await b.evaluate("document.querySelector('#app').hidden"),true);
  const shutdown=b.requests.filter(r=>r.url.endsWith('/shutdown'));
  assert.deepEqual(shutdown.map(r=>r.postData?JSON.parse(r.postData):{}),[{restart:true},{force:true,restart:true},{}, {force:true}]);
  assert.deepEqual(b.errors,[]);
});
