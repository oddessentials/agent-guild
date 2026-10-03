import * as T from './vendor/engine.js';
import { WORLDS, PROVIDER_ORDER, providerPositions, layoutSessions, sessionPose, familiarPose, hash } from './model.mjs';

const ASSETS = new URL('./assets/', import.meta.url);
const vector = new T.Vector3();
const noop = () => {};
function disposeSkeletons(root) {
  const skeletons=new Set();
  root?.traverse(node=>{if(node.skeleton)skeletons.add(node.skeleton);});
  for(const skeleton of skeletons)skeleton.dispose();
}
function disposeTree(root) {
  disposeSkeletons(root);
  const geometries=new Set(),materials=new Set();
  root?.traverse(node => {
    if(node.geometry) geometries.add(node.geometry);
    for(const m of (Array.isArray(node.material)?node.material:node.material?[node.material]:[])) materials.add(m);
  });
  for(const g of geometries) g.dispose();
  for(const m of materials) { for(const v of Object.values(m)) if(v?.isTexture) v.dispose(); m.dispose(); }
}
export class YardRenderer {
  constructor(host,labels,{select,open,error=noop}) {
    this.host=host;this.labels=labels;this.onSelect=select;this.onOpen=open;this.onError=error;
    this.scene=new T.Scene();this.units=new Map();this.halls=new Map();this.slots=new Map();this.cache=new Map();
    this.loadingManager=new T.LoadingManager();
    this.providers=[];this.sessions=[];this.selected=null;this.world=null;this.skin=null;this.request=0;this.worldRequest=0;
    this.active=false;this.reduced=false;this.disposed=false;this.frame=0;this.lastTime=0;this.dirty=true;
    this.renderer=new T.WebGLRenderer({antialias:true,alpha:true,powerPreference:'low-power'});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
    this.renderer.outputColorSpace=T.SRGBColorSpace;
    this.renderer.toneMapping=T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure=1.3;
    this.renderer.shadowMap.enabled=true;
    this.renderer.shadowMap.type=T.PCFSoftShadowMap;
    this.canvas=this.renderer.domElement;this.canvas.setAttribute('aria-hidden','true');
    this.contextLost=e=>{e.preventDefault();this.onError();};
    this.canvas.addEventListener('webglcontextlost',this.contextLost);
    host.prepend(this.canvas);
    this.camera=new T.OrthographicCamera(-20,20,15,-15,.1,160);
    this.controls=new T.OrbitControls(this.camera,this.canvas);
    this.controls.enableRotate=false;this.controls.enableDamping=false;
    this.controls.screenSpacePanning=false;this.controls.minZoom=.6;this.controls.maxZoom=3.8;
    this.controls.mouseButtons={LEFT:T.MOUSE.PAN,MIDDLE:T.MOUSE.DOLLY,RIGHT:T.MOUSE.PAN};
    this.controls.touches={ONE:T.TOUCH.PAN,TWO:T.TOUCH.DOLLY_PAN};
    this.controls.addEventListener('change',()=>{this.dirty=true;this.drawOnce();});
    this.hemi=new T.HemisphereLight(0xc5dfed,0x495741,3.0);this.scene.add(this.hemi);
    this.sun=new T.DirectionalLight(0xffe4bc,4);this.sun.position.set(-12,25,15);this.sun.castShadow=true;
    this.sun.shadow.mapSize.set(2048,2048);
    Object.assign(this.sun.shadow.camera,{left:-22,right:22,top:22,bottom:-22,near:1,far:75});
    this.sun.shadow.normalBias=.045;this.sun.shadow.bias=-.0001;this.scene.add(this.sun);
    this.rim=new T.DirectionalLight(0x99c5ee,1.4);this.rim.position.set(8,12,-15);this.scene.add(this.rim);
    this.ray=new T.Raycaster();this.pointer=new T.Vector2();
    this.down=null;
    this.onPointerDown=e=>{this.down={x:e.clientX,y:e.clientY};};
    this.onClick=e=>{
      if(!this.down||Math.hypot(e.clientX-this.down.x,e.clientY-this.down.y)>5)return;
      const item=this.pick(e);
      this.onSelect(item);
    };
    this.onDouble=e=>{const item=this.pick(e);if(item?.kind==='session')this.onOpen(item.id);};
    this.canvas.addEventListener('pointerdown',this.onPointerDown);
    this.canvas.addEventListener('click',this.onClick);
    this.canvas.addEventListener('dblclick',this.onDouble);
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(host);
    this.overview();this.resize();
  }
  async asset(name) {
    if(!this.cache.has(name)) this.cache.set(name,new T.GLTFLoader(this.loadingManager).loadAsync(new URL(name+'.glb',ASSETS).href));
    return this.cache.get(name);
  }
  async setWorld(skin,theme) {
    if(this.disposed)return;
    skin=WORLDS[skin]?skin:'guild';
    const request=++this.worldRequest;
    this.light(skin,theme);
    if(this.skin===skin&&this.world){this.drawOnce();return;}
    let loaded;
    try {
      loaded=await new T.GLTFLoader(this.loadingManager).loadAsync(new URL(skin+'.glb',ASSETS).href);
      if(this.disposed||request!==this.worldRequest){disposeTree(loaded.scene);return;}
      await this.textureWorld(loaded.scene, skin);
    } catch(err) {
      disposeTree(loaded?.scene);
      if(!this.disposed&&request===this.worldRequest)throw err;
      return;
    }
    if(this.disposed||request!==this.worldRequest){disposeTree(loaded.scene);return;}
    this.request++;
    this.clearUnits();
    for(const item of this.halls.values())item.label.remove();
    this.halls.clear();
    if(this.world){this.scene.remove(this.world);disposeTree(this.world);}
    this.world=loaded.scene;this.skin=skin;this.scene.add(this.world);
    this.host.dataset.world=skin;
    this.world.traverse(node=>{if(node.isMesh){node.castShadow=true;node.receiveShadow=true;}});
    this.update(this.providers,this.sessions);
    this.dirty=true;this.drawOnce();
  }
  async textureWorld(world,skin) {
    if(skin!=='guild'&&skin!=='grove')return;
    const loader=new T.TextureLoader(this.loadingManager);
    const results=await Promise.allSettled(['stone','wood'].map(async name=>{
      const texture=await loader.loadAsync(new URL(name+'.webp',ASSETS).href);
      texture.wrapS=texture.wrapT=T.RepeatWrapping;texture.colorSpace=T.SRGBColorSpace;
      texture.anisotropy=Math.min(8,this.renderer.capabilities.getMaxAnisotropy());
      return texture;
    }));
    if(results.some(result=>result.status==='rejected')){
      for(const result of results)if(result.status==='fulfilled')result.value.dispose();
      throw results.find(result=>result.status==='rejected').reason;
    }
    const textures=results.map(result=>result.value);
    const touched=new Set();
    world.traverse(node=>{
      for(const m of (Array.isArray(node.material)?node.material:node.material?[node.material]:[])){
        if(touched.has(m))continue;touched.add(m);
        const index=/stone|paver|edge/.test(m.name)?0:/wood|Wood|bark/.test(m.name)?1:-1;
        if(index<0)continue;
        m.map=textures[index];m.bumpMap=textures[index];m.bumpScale=index===0?.07:.045;
        m.color.multiplyScalar(index===0?1.5:1.8);m.needsUpdate=true;
      }
    });
  }
  light(skin,theme) {
    const light=theme==='light';
    this.renderer.toneMappingExposure=light?1.65:1.12;
    this.hemi.color.set(skin==='grove'?0xccebd6:skin==='orbital'?0xa7c9ff:0xc4dced);
    this.hemi.intensity=light?3.2:1.8;
    this.sun.color.set(skin==='orbital'?0xc5d8ff:0xffe0ad);
    this.sun.intensity=light?4.0:2.7;
    this.dirty=true;
  }
  resize() {
    if(this.disposed)return;
    const w=this.host.clientWidth,h=this.host.clientHeight;
    if(!w||!h)return;
    this.renderer.setSize(w,h,false);
    const half=15;
    this.camera.left=-half*w/h;this.camera.right=half*w/h;
    this.camera.top=half;this.camera.bottom=-half;this.camera.updateProjectionMatrix();
    this.dirty=true;this.drawOnce();
  }
  overview() {
    this.camera.position.set(19,25,31);
    this.camera.zoom=1.02;
    this.controls.target.set(0,1,0);
    this.camera.lookAt(this.controls.target);this.camera.updateProjectionMatrix();this.controls.update();this.dirty=true;this.drawOnce();
  }
  zoom(factor) {
    this.camera.zoom=T.MathUtils.clamp(this.camera.zoom*factor,.6,3.8);
    this.camera.updateProjectionMatrix();this.dirty=true;this.drawOnce();
  }
  pan(key) {
    const delta={ArrowLeft:[-1,0,0],ArrowRight:[1,0,0],ArrowUp:[0,0,-1],ArrowDown:[0,0,1]}[key];
    if(!delta)return;
    const move=new T.Vector3(...delta).multiplyScalar(1.3/this.camera.zoom);
    this.camera.position.add(move);this.controls.target.add(move);this.controls.update();this.dirty=true;this.drawOnce();
  }
  focus(selection) {
    const item=selection?.kind==='provider'?this.halls.get(selection.id):this.units.get(selection?.id);
    if(!item)return;
    const target=item.root.position.clone();target.y=1;
    const move=target.clone().sub(this.controls.target);
    this.camera.position.add(move);this.controls.target.copy(target);this.camera.zoom=1.7;
    this.camera.updateProjectionMatrix();this.controls.update();this.dirty=true;this.drawOnce();
  }
  label(kind,id) {
    const el=document.createElement('button');el.type='button';el.className='yard-label';el.dataset.kind=kind;
    el.append(Object.assign(document.createElement('span'),{className:'label-name'}),Object.assign(document.createElement('span'),{className:'label-state'}));
    el.addEventListener('click',e=>{e.stopPropagation();this.onSelect({kind,id});});
    el.addEventListener('dblclick',e=>{e.stopPropagation();if(kind==='session')this.onOpen(id);});
    this.labels.append(el);return el;
  }
  update(providers,sessions) {
    this.providers=providers;this.sessions=sessions;
    if(!this.world||this.disposed)return;
    const anchors=providerPositions(providers),ids=new Set(providers.map(p=>p.id));
    for(const id of PROVIDER_ORDER) {
      const object=this.world.getObjectByName('hall_'+id);
      if(object)object.visible=ids.has(id);
    }
    for(const p of providers) {
      let item=this.halls.get(p.id);
      if(!item) {
        let root=PROVIDER_ORDER.includes(p.id)?this.world.getObjectByName('hall_'+p.id):null;
        let custom=false;
        if(!root) {
          root=this.world.getObjectByName('hall_shell').clone(true);
          root.visible=true;root.name='custom_'+p.id;this.world.add(root);custom=true;
        }
        item={root,label:this.label('provider',p.id),custom};this.halls.set(p.id,item);
        root.userData.entity={kind:'provider',id:p.id};
      }
      const anchor=anchors.get(p.id);
      item.root.position.set(anchor.x,0,anchor.z);
      item.label.children[0].textContent=p.tool;
      const working=sessions.filter(s=>s.provider.id===p.id&&sessionPose(s)==='working').length;
      item.label.children[1].textContent=!p.available?'Not installed':working?working+' working':'Ready';
      item.label.dataset.status=p.available?'ready':'locked';
      item.label.style.setProperty('--unit-color',p.color||'#d0ba82');
      item.label.setAttribute('aria-label',p.tool+', '+item.label.children[1].textContent);
    }
    for(const [id,item]of this.halls)if(!ids.has(id)) {
      item.label.remove();if(item.custom)this.world.remove(item.root);this.halls.delete(id);
    }
    this.slots=layoutSessions(sessions,providers,this.slots);
    const live=new Set(sessions.map(s=>s.id));
    for(const [id,item]of this.units)if(!live.has(id)){this.removeUnit(item);this.units.delete(id);}
    for(const session of sessions) {
      let unit=this.units.get(session.id);
      if(!unit) {
        const root=new T.Group();root.userData.entity={kind:'session',id:session.id};
        const ring=new T.Mesh(new T.RingGeometry(.53,.58,40),new T.MeshBasicMaterial({color:session.provider.color||0xd4bd86,transparent:true,opacity:.4,side:T.DoubleSide,depthWrite:false}));
        ring.rotation.x=-Math.PI/2;ring.position.y=.19;root.add(ring);
        unit={root,ring,label:this.label('session',session.id),mixers:[],helpers:[],pose:null,revision:0,loaded:false};
        this.units.set(session.id,unit);this.scene.add(root);
        this.loadUnit(unit,session);
      }
      const slot=this.slots.get(session.id);unit.root.position.set(slot.x,.17,slot.z);
      unit.session=session;
      unit.label.children[0].textContent=session.name;
      const helpers=(session.agents?.length||0)+(session.shells?.length||0);
      unit.label.children[1].textContent=(sessionPose(session)==='working'?'Working':sessionPose(session)==='exited'?'Exited':'Running')+(helpers?' · '+helpers+' helpers':'');
      unit.label.dataset.status=sessionPose(session);
      unit.label.style.setProperty('--unit-color',session.provider.color||'#d0ba82');
      unit.label.setAttribute('aria-label',session.name+', '+unit.label.children[1].textContent);
      if(unit.loaded) { this.pose(unit,sessionPose(session));this.helpers(unit,session); }
    }
    this.select(this.selected);this.dirty=true;this.drawOnce();
  }
  async loadUnit(unit,session) {
    const generation=this.request;
    if(this.skin==='professional') {
      const material=new T.MeshStandardMaterial({color:session.provider.color||0x70868e,roughness:.5});
      const mesh=new T.Mesh(new T.BoxGeometry(.45,.65,.45),material);mesh.position.y=.33;mesh.castShadow=true;unit.root.add(mesh);unit.token=mesh;unit.loaded=true;return;
    }
    const prefix=this.skin==='orbital'?'robot_':this.skin==='grove'?'spirit_':'hero_';
    const index=Math.max(0,PROVIDER_ORDER.indexOf(session.provider.id));
    try {
      const asset=await this.asset(prefix+index);
      if(this.disposed||generation!==this.request||!unit.root.parent)return;
      const model=T.cloneSkeleton(asset.scene);
      model.rotation.y=-.3;
      model.traverse(n=>{if(n.isMesh){n.castShadow=true;n.receiveShadow=true;}});
      unit.root.add(model);unit.model=model;unit.loaded=true;
      const mixer=new T.AnimationMixer(model);unit.mixers.push(mixer);
      unit.animations=new Map(asset.animations.map(clip=>[clip.name,mixer.clipAction(clip)]));
      this.pose(unit,sessionPose(unit.session||session));
      this.helpers(unit,unit.session||session);this.dirty=true;this.drawOnce();
    } catch(err){if(!this.disposed){console.warn('Yard character unavailable:',err.message);unit.label.title='Character art unavailable. Session controls remain available.';}}
  }
  pose(unit,pose) {
    if(unit.pose===pose)return;
    unit.pose=pose;
    if(unit.animations) {
      const next=unit.animations.get(pose==='exited'?'done':pose);
      if(next&&next!==unit.action) {
        next.reset().play();
        if(unit.action) { if(this.reduced)unit.action.stop();else unit.action.crossFadeTo(next,.25,false); }
        unit.action=next;
        if(this.reduced)unit.mixers[0].update(.15);
      }
    }
    unit.ring.material.opacity=pose==='working'?.65:pose==='exited'?.15:.35;
    unit.root.visible=true;
  }
  async helpers(unit,session) {
    const agents=[...(session.agents||[]).map(a=>({...a,pose:familiarPose(a)})),...(session.shells||[]).map(s=>({id:s.id,name:'Shell command',pose:'working',shell:true}))];
    const signature=JSON.stringify(agents.map(a=>[a.id,a.pose]));
    if(unit.helperSignature===signature)return;
    unit.helperSignature=signature;
    const rev=++unit.revision,generation=this.request;
    for(const helper of unit.helpers){unit.root.remove(helper.model);helper.mixer?.stopAllAction();helper.mixer?.uncacheRoot(helper.model);disposeSkeletons(helper.model);}
    unit.helpers=[];
    if(this.skin==='professional')return;
    // The full helper count and all helper details remain in the canonical inspector.
    // Small squads preserve readable character silhouettes at the overview scale.
    await Promise.all(agents.slice(0,6).map(async(agent,i)=>{
      try {
        const asset=await this.asset((this.skin==='orbital'||agent.shell?'drone_':'familiar_')+(hash(agent.name||agent.id)%4));
        if(this.disposed||generation!==this.request||rev!==unit.revision||!unit.root.parent)return;
        const model=T.cloneSkeleton(asset.scene);
        const angle=(i/Math.min(agents.length,6))*Math.PI*2;
        model.scale.setScalar(.45);model.position.set(Math.cos(angle)*.82,.10,Math.sin(angle)*.72);
        unit.root.add(model);
        const mixer=new T.AnimationMixer(model);
        const clip=asset.animations.find(c=>c.name===(agent.pose==='idle'?'resting':agent.pose))||asset.animations[0];
        if(clip)mixer.clipAction(clip).play();
        mixer.update(.3+(hash(agent.id)%40)/10);
        unit.helpers.push({model,mixer,angle,pose:agent.pose});
        this.dirty=true;this.drawOnce();
      } catch {}
    }));
  }
  select(selection) {
    this.selected=selection;
    for(const [id,item]of this.halls) item.label.setAttribute('aria-pressed',String(selection?.kind==='provider'&&selection.id===id));
    for(const [id,item]of this.units) {
      const on=selection?.kind==='session'&&selection.id===id;
      item.label.setAttribute('aria-pressed',String(on));
      item.ring.material.color.set(on?0xffdf92:(item.session?.provider.color||0xbaaa80));
      item.ring.scale.setScalar(on?1.15:1);
    }
    this.dirty=true;this.drawOnce();
  }
  pick(event) {
    const rect=this.canvas.getBoundingClientRect();
    this.pointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);
    this.ray.setFromCamera(this.pointer,this.camera);
    const hits=this.ray.intersectObjects([...this.halls.values(),...this.units.values()].map(i=>i.root),true);
    for(const hit of hits) { for(let node=hit.object;node;node=node.parent) if(node.userData.entity)return node.userData.entity; }
    return null;
  }
  positionLabels() {
    const w=this.host.clientWidth,h=this.host.clientHeight,placed=[];
    for(const item of [...this.halls.values(),...this.units.values()]) {
      const hall=item.label.dataset.kind==='provider';
      vector.copy(item.root.position);vector.y+=hall?.5:2.4;
      if(hall)vector.z+=2.1;
      vector.project(this.camera);
      const hidden=vector.z<-1||vector.z>1||Math.abs(vector.x)>1.1||Math.abs(vector.y)>1.1;
      item.label.hidden=hidden;
      if(hidden)continue;
      const lw=item.label.offsetWidth||120,lh=item.label.offsetHeight||28;
      let x=(vector.x*.5+.5)*w,y=(-vector.y*.5+.5)*h;
      for(let tries=0;tries<12;tries++){
        const overlap=placed.find(r=>Math.abs(x-r.x)<(lw+r.w)/2+4 && y>r.y-r.h-5 && y-lh<r.y+5);
        if(!overlap)break;
        y=overlap.y-overlap.h-6;
      }
      x=Math.max(lw/2+5,Math.min(w-lw/2-5,x));y=Math.max(lh+6,y);
      placed.push({x,y,w:lw,h:lh});
      item.label.style.left=x+'px';item.label.style.top=y+'px';
    }
  }
  setReducedMotion(value) {
    this.reduced=value;
    this.dirty=true;this.drawOnce();
  }
  setActive(value) {
    if(this.disposed)return;
    if(this.active===Boolean(value))return;
    this.active=Boolean(value);this.controls.enabled=this.active;
    if(this.active){this.lastTime=0;this.dirty=true;this.schedule();}
    else {cancelAnimationFrame(this.frame);this.frame=0;}
  }
  schedule() {
    if(!this.active||this.frame||this.disposed)return;
    this.frame=requestAnimationFrame(time=>this.tick(time));
  }
  tick(time) {
    this.frame=0;if(!this.active||this.disposed)return;
    const dt=this.lastTime?Math.min((time-this.lastTime)/1000,.05):0;this.lastTime=time;
    if(!this.reduced) {
      for(const unit of this.units.values()) {
        for(const mixer of unit.mixers)mixer.update(dt);
        for(const helper of unit.helpers)helper.mixer.update(dt);
      }
    }
    if(this.dirty)this.positionLabels();
    if(!this.reduced||this.dirty){this.renderer.render(this.scene,this.camera);this.dirty=false;}
    if(!this.reduced)this.schedule();
  }
  drawOnce() { if(this.active)this.schedule(); }
  removeUnit(unit) {
    unit.revision++;
    for(const mixer of unit.mixers){mixer.stopAllAction();mixer.uncacheRoot(mixer.getRoot());}
    for(const helper of unit.helpers){helper.mixer.stopAllAction();helper.mixer.uncacheRoot(helper.model);}
    disposeSkeletons(unit.root);
    this.scene.remove(unit.root);unit.label.remove();unit.ring.geometry.dispose();unit.ring.material.dispose();
    if(unit.token){unit.token.geometry.dispose();unit.token.material.dispose();}
  }
  clearUnits() { for(const unit of this.units.values())this.removeUnit(unit);this.units.clear(); }
  dispose() {
    if(this.disposed)return;
    this.disposed=true;this.request++;this.worldRequest++;cancelAnimationFrame(this.frame);
    this.loadingManager.abort();
    this.resizeObserver.disconnect();this.controls.dispose();this.clearUnits();
    for(const item of this.halls.values())item.label.remove();this.halls.clear();
    disposeTree(this.world);
    for(const entry of this.cache.values())entry.then(a=>disposeTree(a.scene)).catch(noop);this.cache.clear();
    this.sun.shadow.map?.dispose();
    this.canvas.removeEventListener('webglcontextlost',this.contextLost);
    this.canvas.removeEventListener('pointerdown',this.onPointerDown);
    this.canvas.removeEventListener('click',this.onClick);this.canvas.removeEventListener('dblclick',this.onDouble);
    this.renderer.dispose();this.renderer.forceContextLoss();this.canvas.remove();
  }
}
