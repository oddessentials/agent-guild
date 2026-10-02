// Isolated, in-memory demo data behind the real HTTP/WebSocket server.
// No processes, credentials, real accounts, downloads, or user data directories.
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createManagerServer } from '../../src/manager/server.mjs';

export async function startFixture({port=0}={}) {
  const calls=[],data=new Map(),terminals=new Map();
  let next=16;
  const now=()=>new Date().toISOString();
  const error=(code,message,status=409)=>Object.assign(new Error(message),{code,status});
  const providers=[
    ['anthropic','Anthropic','Claude Code','#d69a63'],
    ['openai','OpenAI','Codex CLI','#6bb499'],
    ['google','Google','Antigravity CLI','#779cdb'],
    ['xai','xAI','Grok Build','#69c4d0'],
    ['shell','Local','Shell','#ba91df'],
  ].map(([id,vendor,tool,color])=>({id,vendor,tool,color,monogram:vendor[0],iconUrl:null,available:true,command:'fixture',
    accounts:id==='anthropic'?[{id:'default',label:'Personal'},{id:'work',label:'Work'}]:[{id:'default',label:'Default'}],
    installedVersion:'1.0.0',latestVersion:'1.1.0',updateAvailable:id==='anthropic',updateCommand:'fixture update',installable:true,
    resumable:id!=='shell',historySource:'command',history:{command:'fixture'},modelPattern:'.*',usageSource:id==='anthropic'||id==='openai'?'command':null,
    usageUrl:'https://example.com/usage',billingUrl:'https://example.com/billing',reportingEnabled:id==='google'?false:undefined}));
  const manager=new EventEmitter();
  const update=s=>manager.emit('event',{type:'session.updated',session:s});
  const wrapped=s=>({
    toJSON:()=>s,
    rename(name){s.name=name;calls.push(['rename',s.id,name]);update(s);},
    attach(send){if(!terminals.has(s.id))terminals.set(s.id,new Set());terminals.get(s.id).add(send);
      send({type:'snapshot',data:'\x1b[38;2;209;177;112mAgent Guild · isolated Yard preview\x1b[0m\r\n\r\n'+s.name+'\r\nThis is a fixture terminal. No coding tool is running.\r\n\r\n> ',cols:120,rows:32,session:s});
      return ()=>terminals.get(s.id)?.delete(send);},
    input(text){for(const send of terminals.get(s.id)||[])send({type:'data',data:text});},
    resize(cols,rows){s.cols=cols;s.rows=rows;},
  });
  function add(body={},emit=true) {
    const p=providers.find(p=>p.id===body.providerId)||{id:body.providerId||'github',vendor:'Agent Guild',tool:body.task||'Task',color:'#cab47e'};
    const id=(next++).toString(16).padStart(12,'0');
    const session={id,name:body.name||p.tool,provider:{id:p.id,vendor:p.vendor,tool:p.tool,color:p.color,monogram:p.monogram},cwd:body.cwd||'E:\\projects\\example',
      account:p.accounts?.find(a=>a.id===(body.account||'default'))||null,resume:body.resume||null,toolSessionId:body.resume||'conversation-'+id,
      task:body.task||null,clone:body.clone||null,status:'running',activity:body.quiet?'quiet':'active',pid:1,exitCode:null,signal:null,
      createdAt:new Date(Date.now()-((next%4)+1)*3600000).toISOString(),exitedAt:null,lastOutputAt:now(),cols:120,rows:32,attachedClients:0,
      model:p.id==='shell'?null:{name:'fixture-model',displayName:'Preview model',source:'report'},
      reporting:{state:'active'},agents:body.agents||[],shells:body.shells||[]};
    data.set(id,session);if(emit)manager.emit('event',{type:'session.created',session});return wrapped(session);
  }
  Object.assign(manager,{
    list:()=>[...data.values()],get:id=>{if(!data.has(id))throw error('not_found','No session',404);return wrapped(data.get(id));},
    runningCount:()=>[...data.values()].filter(s=>s.status==='running').length,
    create(body){calls.push(['create',body]);if(body.cwd==='missing')throw error('bad_cwd','Folder not found',400);return add(body);},
    install(providerId,body){calls.push(['install',providerId,body]);return add({providerId,task:'install',name:'Install '+providerId});},
    stop(id){calls.push(['stop',id]);const s=data.get(id);s.status='exited';s.exitedAt=now();s.exitCode=0;s.agents=[];s.shells=[];update(s);return wrapped(s);},
    remove(id){calls.push(['remove',id]);data.delete(id);manager.emit('event',{type:'session.removed',sessionId:id});},
    upgrade(){calls.push(['upgrade']);return add({providerId:'agent-guild',task:'upgrade',name:'Upgrade Agent Guild'});},
    clone(body){calls.push(['clone',body]);return add({providerId:'github',task:'clone',name:'Clone '+body.repo,clone:{repo:body.repo,path:body.parent+'\\demo',accountId:body.account}});},
    resolveCwd:cwd=>cwd,
    sessionHooks:{async setEnabled(p,enabled){calls.push(['reporting',p.id,enabled]);p.reportingEnabled=enabled;}},
  });
  const registry=Object.assign(new EventEmitter(),{
    list:()=>providers,get:id=>providers.find(p=>p.id===id),describe:p=>p,account:(p,id)=>p.accounts.find(a=>a.id===(id||'default')),
    refreshVersions:async()=>{},reload(){},warnings:[],
  });
  const usage={all:async()=>providers.flatMap(p=>p.usageSource?p.accounts.map(a=>({providerId:p.id,accountId:a.id,plan:'pro',signedIn:true,error:null,fetchedAt:now(),
    windows:[{label:'5-hour',usedPercent:a.id==='work'?68:23,resetsAt:new Date(Date.now()+7200000).toISOString()},{label:'7-day',usedPercent:35,resetsAt:new Date(Date.now()+4*86400000).toISOString()}],
    credits:p.id==='openai'?14.5:null})):[])};
  const history={list:async(p,a)=>{calls.push(['history',p.id,a.id]);return {providerId:p.id,accountId:a.id,total:2,fetchedAt:now(),sessions:[
    {id:'history-1',title:'Explore the architecture',cwd:'E:\\projects\\example',updatedAt:now()},
    {id:'history-missing',title:'A moved project',cwd:'missing',updatedAt:now()}]};}};
  const modelStats={snapshot:async(sessions)=>({
    retrievedAt:now(),stale:false,error:null,stats:[],pool:{},providers:Object.fromEntries(providers.filter(p=>p.id!=='shell').map(p=>[p.id,{featured:p.id+'/fixture',models:[p.id+'/fixture']}])),
    models:Object.fromEntries(providers.filter(p=>p.id!=='shell').map(p=>[p.id+'/fixture',{id:p.id+'/fixture',name:'Preview model',context:200000,createdAt:'2026-09-01',price:{input:1,output:3},stats:{}}])),
    sessions:Object.fromEntries(sessions.map(s=>[s.id,s.provider.id+'/fixture'])),
  })};
  const news=Object.assign(new EventEmitter(),{snapshot:()=>({refreshedAt:now(),refreshing:false,sources:[],items:[{id:'preview-news',title:'Welcome to your Guild Yard — every session has a place.',url:'https://example.com',source:'Preview',sourceId:'preview',category:'news',publishedAt:now()}]})});
  const changelog=Object.assign(new EventEmitter(),{snapshot:()=>({refreshing:false,okAt:now(),error:null,releases:[]})});
  const githubState={scopes:['repo','write:public_key'],appUrl:'https://example.com',keysUrl:'https://example.com',newKeyUrl:'https://example.com',tools:{git:true,ssh:true,sshKeygen:true},signIn:null,
    accounts:[{id:42,login:'preview',name:'Preview account',avatar:null,scopes:['repo','write:public_key'],needsSignIn:false,addedAt:now(),ssh:{status:'ready',settingUp:false,error:null,key:'fixture',publicKey:'fixture',verifiedAt:now()}}]};
  const github=Object.assign(new EventEmitter(),{
    snapshot:()=>githubState,
    async startSignIn(){calls.push(['github-sign-in']);githubState.signIn={status:'pending',userCode:'DEMO-ONLY',verificationUri:'https://example.com',expiresAt:new Date(Date.now()+600000).toISOString()};this.emit('updated');},
    cancelSignIn(){calls.push(['github-cancel']);githubState.signIn=null;this.emit('updated');},
    signOut(id){calls.push(['github-sign-out',id]);githubState.accounts=githubState.accounts.filter(a=>String(a.id)!==String(id));this.emit('updated');},
    async repos(id,{parent}){calls.push(['repos',id,parent]);return {accountId:42,owners:[{login:'preview',type:'user'}],parent, fetchedAt:now(),truncated:false,repos:[{fullName:'preview/demo',owner:'preview',name:'demo',description:'An isolated preview repository',private:true,language:'JavaScript',pushedAt:now(),url:'https://example.com',target:(parent||'E:\\projects')+'\\demo',local:'absent'}]};},
    async createRepo(id,body){calls.push(['create-repo',id,body]);return {fullName:body.owner+'/'+body.name,name:body.name,owner:body.owner,url:'https://example.com'};},
    async setupSsh(id){calls.push(['ssh',id]);return githubState.accounts[0];},
  });
  const selfUpdate=Object.assign(new EventEmitter(),{describe:()=>({version:'1.0.0',latestVersion:'1.1.0',available:true,command:'fixture upgrade',pendingVersion:null,installing:false}),refresh:async()=>{}});
  const names=['Design system foundations','Checkout experience','API architecture','Documentation garden','Build & verify','Local workspace'];
  names.forEach((name,i)=>add({providerId:providers[[0,0,1,2,3,4][i]].id,name,quiet:i===2||i===5,
    agents:i===0?[{id:'a1',name:'Explorer',status:'working',detail:'Reading the project'},{id:'a2',name:'Reviewer',status:'waiting',detail:'Waiting for input'}]:i===1?[{id:'a3',name:'Designer',status:'working'}]:[],
    shells:i===4?[{id:'sh1'}]:[]},false));
  const token=randomBytes(24).toString('hex');
  const api=createManagerServer({manager,registry,usage,history,modelStats,news,changelog,github,selfUpdate,token,port,webDir:fileURLToPath(new URL('../../web',import.meta.url)),version:'1.0.0',
    onShutdownRequest:({restart})=>{calls.push(['shutdown',restart]);manager.emit('event',{type:'manager.stopped',remaining:0,restart});if(restart){data.clear();manager.closing=false;setTimeout(()=>manager.emit('event',{type:'hello',version:'1.1.0',pid:process.pid,sessions:[],upgrade:null}),100);}}
  });
  await api.listen();
  return {api,token,calls,manager,registry,providers,data,add,update,githubState,close:()=>api.close()};
}
