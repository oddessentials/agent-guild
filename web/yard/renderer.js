import * as T from './vendor/engine.js';
import { WORLDS, PROVIDER_ORDER, characterIndex, CAMERA, SUN, minZoom, clampPan, viewBasis, providerPositions, sessionPose, familiarPose, hash,
  stage, nextStagingChange, doorFor, arrives, route, clipFor, helperOffset, stationProp, hallActivity, lookTarget, lookLimits, STAGING } from './model.mjs';

const ASSETS = new URL('./assets/', import.meta.url);
const vector = new T.Vector3();
const lookModel = new T.Matrix4(), lookParent = new T.Matrix4(), lookFrame = new T.Quaternion(), lookTurn = new T.Quaternion(), lookTilt = new T.Quaternion();
const axisX = new T.Vector3(1, 0, 0), axisY = new T.Vector3(0, 1, 0);
const noop = () => {};
const vector2 = new T.Vector2();
// How fast characters turn to a new heading, in radians a second, and how
// long a clip change blends.
const TURN = 7, FADE = .3;
// Models rigged before the staging contract name their clips differently.
const LEGACY = { walk: 'working', idle_0: 'resting', idle_1: 'resting', idle_2: 'resting', pause: 'resting', work_0: 'working', work_1: 'working', idle: 'resting', move: 'working' };
// How bright a hall's glow grows at low and high activity, over what the
// theme already gives it, and how long it takes to fade in or out (seconds).
const GLOW = { off: 0, low: .55, high: 1 }, GLOW_GAIN = { light: .9, dark: 2.2 }, GLOW_FADE = 1.2;
// Materials that light up with a hall's crew: lit windows and magic, glass
// fronts, and a generated hall's baked glow map.
const glows = m => m.name === 'window' || m.name === 'magic' || m.name === 'officeGlass' || m.emissiveMap;
const PARTICLES = 640;
const angleTo = (from, to) => { let d = (to - from) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return d; };
function helpersFor(session) {
  return [
    ...(session.agents||[]).map(a=>({id:a.id,name:a.name,pose:familiarPose(a),shell:false})),
    // A monitor watches rather than works, so it rests beside the character.
    ...(session.shells||[]).map(s=>s.kind==='monitor'?{id:s.id,name:'Monitor',pose:'idle',shell:true}:{id:s.id,name:'Shell command',pose:'working',shell:true}),
  ];
}
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
const themeKey=theme=>theme==='light'?'light':'dark';
// One world request's downloads, counted in bytes so the view can show
// progress and tell a slow load from a stalled one. Background loads use the
// renderer's shared manager and never count.
function tracked(progress) {
  const manager=new T.LoadingManager(),urls=new Set(),streaming=new Map();
  let bytes=0;
  const report=()=>{let total=bytes;for(const n of streaming.values())total+=n;progress(total);};
  const itemStart=manager.itemStart;
  manager.itemStart=url=>{urls.add(new URL(url,location.href).href);itemStart(url);};
  manager.onProgress=report;
  const observer=new PerformanceObserver(list=>{
    for(const entry of list.getEntries())if(urls.delete(entry.name)){streaming.delete(entry.name);bytes+=entry.encodedBodySize;}
    report();
  });
  observer.observe({type:'resource'});
  // Once a download's timing entry has counted it, its own progress events
  // only show the load is alive.
  return {manager,stream:url=>event=>{if(urls.has(url))streaming.set(url,event.loaded);report();},close(){observer.disconnect();manager.abort();}};
}
function disposeWorld(root) {
  if(root)root.userData.disposed=true;
  disposeTree(root);
  for(const environment of Object.values(root?.userData.environments||{}))environment.dispose();
}
export class YardRenderer {
  // clock gives the time staging is judged at; tests pass a fixed one.
  constructor(host,labels,{select,open,error=noop,clock=Date.now}) {
    this.host=host;this.labels=labels;this.onSelect=select;this.onOpen=open;this.onError=error;this.clock=clock;
    this.scene=new T.Scene();this.units=new Map();this.halls=new Map();this.slots=new Map();this.cache=new Map();
    this.loadingManager=new T.LoadingManager();
    this.providers=[];this.sessions=[];this.selected=null;this.world=null;this.skin=null;this.request=0;this.worldRequest=0;this.pending=null;
    this.staged=null;this.seen=new Set();this.stageTimer=0;this.sparks=[];
    this.props=new Map();this.propSpots=[];this.station=null;this.effects=null;
    this.active=false;this.reduced=false;this.disposed=false;this.frame=0;this.lastTime=0;this.dirty=true;
    this.renderer=new T.WebGLRenderer({antialias:true,alpha:true,powerPreference:'low-power'});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
    this.renderer.outputColorSpace=T.SRGBColorSpace;
    // Worlds match the AgX curve their plates were rendered with.
    this.renderer.toneMapping=T.AgXToneMapping;
    this.renderer.toneMappingExposure=1.3;
    this.renderer.shadowMap.enabled=true;
    this.renderer.shadowMap.type=T.PCFSoftShadowMap;
    this.canvas=this.renderer.domElement;this.canvas.setAttribute('aria-hidden','true');
    this.contextLost=e=>{e.preventDefault();this.onError();};
    this.canvas.addEventListener('webglcontextlost',this.contextLost);
    host.prepend(this.canvas);
    this.camera=new T.OrthographicCamera(-20,20,15,-15,CAMERA.near,CAMERA.far);
    this.controls=new T.OrbitControls(this.camera,this.canvas);
    this.controls.enableRotate=false;this.controls.enableDamping=false;
    this.controls.screenSpacePanning=false;this.controls.minZoom=CAMERA.zoom.min;this.controls.maxZoom=CAMERA.zoom.max;
    this.controls.mouseButtons={LEFT:T.MOUSE.PAN,MIDDLE:T.MOUSE.DOLLY,RIGHT:T.MOUSE.PAN};
    this.controls.touches={ONE:T.TOUCH.PAN,TWO:T.TOUCH.DOLLY_PAN};
    this.controls.addEventListener('change',()=>{this.bound();this.dirty=true;this.drawOnce();});
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
    if(!this.cache.has(name)) {
      const pending=new T.GLTFLoader(this.loadingManager).loadAsync(new URL(name+'.glb',ASSETS).href).catch(err=>{
        if(this.cache.get(name)===pending)this.cache.delete(name);
        throw err;
      });
      this.cache.set(name,pending);
    }
    return this.cache.get(name);
  }
  // Shows skin's world in theme, or only theme's plates when that world is
  // already up. What is on screen stays until the new world or theme is
  // ready; progress receives the bytes downloaded so far.
  async setWorld(skin,theme,{progress=noop}={}) {
    if(this.disposed)return;
    if(!WORLDS[skin])throw new Error('This skin has no yard.');
    const request=++this.worldRequest;
    this.pending?.close();
    const pending=this.pending=tracked(progress);
    let loaded;
    try {
      if(this.skin===skin&&this.world){
        const world=this.world;
        await this.plateTheme(world,themeKey(theme),pending.manager);
        if(!this.disposed&&request===this.worldRequest&&this.world===world){this.light(skin,theme);this.drawOnce();}
        return;
      }
      const url=new URL(skin+'.glb',ASSETS).href;
      loaded=await new T.GLTFLoader(pending.manager).loadAsync(url,pending.stream(url));
      if(this.disposed||request!==this.worldRequest){disposeWorld(loaded.scene);return;}
      await Promise.all([this.surfaceWorld(loaded.scene,skin,pending.manager),this.plateWorld(loaded.scene,skin,theme,pending.manager)]);
    } catch(err) {
      disposeWorld(loaded?.scene);
      if(!this.disposed&&request===this.worldRequest)throw err;
      return;
    } finally {
      if(this.pending===pending){pending.close();this.pending=null;}
    }
    if(this.disposed||request!==this.worldRequest){disposeWorld(loaded.scene);return;}
    this.request++;
    this.clearUnits();
    this.clearProps();this.releaseStation();this.releaseEffects();
    for(const item of this.halls.values())item.label.remove();
    this.halls.clear();
    if(this.world){this.scene.remove(this.world);disposeWorld(this.world);}
    this.world=loaded.scene;this.skin=skin;this.scene.add(this.world);
    this.makeEffects(WORLDS[skin].effect);
    this.light(skin,theme);
    this.host.dataset.world=skin;
    this.world.traverse(node=>{if(node.isMesh&&!node.userData.plate&&!node.material.isShadowMaterial){node.castShadow=true;node.receiveShadow=true;}});
    this.update(this.providers,this.sessions);
    this.dirty=true;this.drawOnce();
  }
  // Gives up on the pending setWorld and its downloads; what is on screen stays.
  abandonWorld() {
    this.worldRequest++;
    this.pending?.close();this.pending=null;
  }
  // Pre-rendered surroundings drawn behind everything, from the same view
  // direction as the camera, so they line up at any pan or zoom. Each theme
  // has its own set: the current theme's base layer gates the load, and its
  // sharper layers and the other theme follow without blocking it.
  async plateWorld(world,skin,theme,manager) {
    const response=await fetch(new URL(skin+'/plates.json',ASSETS));
    if(!response.ok)throw new Error('The Yard plates could not be loaded.');
    world.userData.plates={themes:(await response.json()).themes,groups:{}};
    await this.plateTheme(world,themeKey(theme),manager);
    // Live halls and characters cast onto the plate's ground.
    const catcher=new T.Mesh(new T.PlaneGeometry(400,400),new T.ShadowMaterial({opacity:.3,depthWrite:false}));
    catcher.rotation.x=-Math.PI/2;catcher.position.y=.01;catcher.receiveShadow=true;catcher.renderOrder=-50;
    world.add(catcher);
  }
  plateTheme(world,theme,manager=this.loadingManager) {
    const plates=world.userData.plates;
    if(plates.groups[theme])return plates.groups[theme].ready;
    const group=new T.Group();group.visible=false;world.add(group);
    const [base,...sharper]=plates.themes[theme];
    // Layers that arrive after their world is gone are released, not added.
    const keep=meshes=>{
      if(this.disposed||world.userData.disposed){for(const mesh of meshes)disposeTree(mesh);return false;}
      group.add(...meshes);return true;
    };
    const ready=this.plateLayer(base,0,manager).then(meshes=>{
      if(!keep(meshes))return;
      sharper.forEach((entry,i)=>this.plateLayer(entry,i+1).then(meshes=>{
        if(keep(meshes)){this.dirty=true;this.drawOnce();}
      }).catch(noop));
    });
    // A failed theme is forgotten, so asking again retries it.
    ready.catch(()=>{if(plates.groups[theme]?.ready===ready){delete plates.groups[theme];world.remove(group);}});
    plates.groups[theme]={group,ready};
    return ready;
  }
  async plateLayer(entry,order,manager=this.loadingManager) {
    const {right,up,forward}=viewBasis(),axes=[right,up,forward].map(v=>new T.Vector3(...v));
    const rotation=new T.Matrix4().makeBasis(axes[0],axes[1],axes[2].clone().negate());
    const depth=CAMERA.far*.75+axes[2].dot(new T.Vector3(...CAMERA.offset));
    const loader=new T.TextureLoader(manager);
    return Promise.all(entry.tiles.map(async tile=>{
      const texture=await loader.loadAsync(new URL(tile.file,ASSETS).href);
      texture.colorSpace=T.SRGBColorSpace;
      texture.anisotropy=Math.min(4,this.renderer.capabilities.getMaxAnisotropy());
      const [r0,r1]=tile.right,[u0,u1]=tile.up;
      const mesh=new T.Mesh(new T.PlaneGeometry(r1-r0,u1-u0),
        new T.MeshBasicMaterial({map:texture,depthTest:false,depthWrite:false,toneMapped:false}));
      mesh.applyMatrix4(rotation);
      mesh.position.copy(axes[0]).multiplyScalar((r0+r1)/2).addScaledVector(axes[1],(u0+u1)/2).addScaledVector(axes[2],depth);
      mesh.renderOrder=-100+order;mesh.frustumCulled=false;mesh.userData.plate=true;
      return mesh;
    }));
  }
  // Show the theme's plates once loaded; until then the other theme stays up.
  showPlates(theme) {
    const plates=this.world?.userData.plates;
    if(!plates)return;
    const want=plates.groups[theme];
    if(!want){this.plateTheme(this.world,theme).then(()=>this.showPlates(themeKey(this.theme))).catch(noop);return;}
    if(!want.group.children.length)return;
    for(const [key,{group}] of Object.entries(plates.groups))group.visible=key===theme;
    // Load the other theme quietly so a later switch is immediate.
    const other=theme==='light'?'dark':'light';
    if(!plates.groups[other])this.plateTheme(this.world,other).catch(noop);
    this.dirty=true;this.drawOnce();
  }
  // Live halls take scanned material sets by material name,
  // and light from a small copy of the plates' sky.
  async surfaceWorld(world,skin,manager) {
    const response=await fetch(new URL(skin+'/surfaces.json',ASSETS));
    if(!response.ok)throw new Error('The Yard surfaces could not be loaded.');
    const {sky,surfaces}=await response.json();
    const loader=new T.TextureLoader(manager),textures=[];
    const load=async(file,color,repeat)=>{
      const texture=await loader.loadAsync(new URL(file,ASSETS).href);textures.push(texture);
      texture.flipY=false;texture.wrapS=texture.wrapT=T.RepeatWrapping;texture.repeat.set(repeat,repeat);
      texture.colorSpace=color?T.SRGBColorSpace:T.NoColorSpace;
      texture.anisotropy=Math.min(8,this.renderer.capabilities.getMaxAnisotropy());
      return texture;
    };
    const environments={};
    try {
      const sets=await Promise.all(Object.values(surfaces).map(async s=>{
        // Hall UVs are 0.7 per metre (build.py).
        const repeat=1/(s.metres*.7);
        const [map,normalMap,roughnessMap]=await Promise.all([load(s.color,true,repeat),load(s.normal,false,repeat),load(s.rough,false,repeat)]);
        return {...s,map,normalMap,roughnessMap};
      }));
      const pmrem=new T.PMREMGenerator(this.renderer);
      try {
        for(const [theme,file] of Object.entries(sky)) {
          const equirect=await new T.HDRLoader(manager).loadAsync(new URL(file,ASSETS).href);
          environments[theme]=pmrem.fromEquirectangular(equirect).texture;equirect.dispose();
        }
      } finally { pmrem.dispose(); }
      const touched=new Set();
      world.traverse(node=>{
        for(const m of (Array.isArray(node.material)?node.material:node.material?[node.material]:[])){
          if(touched.has(m))continue;touched.add(m);
          const set=sets.find(s=>s.materials.includes(m.name));
          if(!set)continue;
          Object.assign(m,{map:set.map,normalMap:set.normalMap,roughnessMap:set.roughnessMap,roughness:1});
          if(set.tint)m.color.multiplyScalar(2.1);else m.color.set(0xffffff);
          m.needsUpdate=true;
        }
      });
    } catch(err) {
      for(const texture of textures)texture.dispose();
      for(const environment of Object.values(environments))environment.dispose();
      throw err;
    }
    world.userData.environments=environments;
  }
  light(skin,theme) {
    this.theme=theme;
    const light=theme==='light';
    const key=themeKey(theme);
    this.world?.traverse(node=>{
      // Lit windows, magic and baked glow maps read as glow at night, not as paint by day.
      for(const m of (Array.isArray(node.material)?node.material:node.material?[node.material]:[]))
        if(m.name==='window'||m.name==='magic'||m.emissiveMap)m.userData.glow=light?.35:1.4;
    });
    this.glow();
    // Each theme uses the sun, sky and plates it was rendered with.
    this.sun.position.set(...SUN[key]);
    this.scene.environment=this.world?.userData.environments?.[key]||null;
    if(this.world&&this.skin===skin)this.showPlates(key);
    this.renderer.toneMappingExposure=light?1.65:1.12;
    this.hemi.color.set(WORLDS[skin].hemi);
    this.hemi.intensity=(light?3.2:1.8)*.35;
    // Blender and three.js place an equirectangular sky half a turn apart.
    this.scene.environmentRotation.y=Math.PI;this.scene.environmentIntensity=light?1.25:.7;
    this.sun.color.set(WORLDS[skin].sun[key]);
    this.sun.intensity=light?4.0:3.2;
    this.dirty=true;
  }
  resize() {
    if(this.disposed)return;
    const w=this.host.clientWidth,h=this.host.clientHeight;
    if(!w||!h)return;
    this.renderer.setSize(w,h,false);
    if(this.effects)this.effects.points.material.uniforms.scale.value=this.renderer.getDrawingBufferSize(vector2).y/2;
    const half=CAMERA.height/2;
    this.camera.left=-half*w/h;this.camera.right=half*w/h;
    this.camera.top=half;this.camera.bottom=-half;
    this.controls.minZoom=minZoom(w/h);
    this.camera.zoom=T.MathUtils.clamp(this.camera.zoom,this.controls.minZoom,this.controls.maxZoom);
    this.camera.updateProjectionMatrix();
    this.dirty=true;this.drawOnce();
  }
  overview() {
    this.controls.target.set(...CAMERA.target);
    this.camera.position.set(...CAMERA.offset).add(this.controls.target);
    this.camera.zoom=Math.max(CAMERA.zoom.overview,this.controls.minZoom);
    this.camera.lookAt(this.controls.target);this.camera.updateProjectionMatrix();this.controls.update();this.dirty=true;this.drawOnce();
  }
  // Keep the view over the environment plates by translating camera and target together.
  bound() {
    const target=this.controls.target,{x,z}=clampPan(target);
    if(x===target.x&&z===target.z)return;
    const move=vector.set(x-target.x,0,z-target.z);
    target.add(move);this.camera.position.add(move);
  }
  zoom(factor) {
    this.camera.zoom=T.MathUtils.clamp(this.camera.zoom*factor,this.controls.minZoom,this.controls.maxZoom);
    this.camera.updateProjectionMatrix();this.dirty=true;this.drawOnce();
  }
  pan(key) {
    const delta={ArrowLeft:[-1,0,0],ArrowRight:[1,0,0],ArrowUp:[0,0,-1],ArrowDown:[0,0,1]}[key];
    if(!delta)return;
    const move=new T.Vector3(...delta).multiplyScalar(1.3/this.camera.zoom);
    this.camera.position.add(move);this.controls.target.add(move);this.bound();this.controls.update();this.dirty=true;this.drawOnce();
  }
  focus(selection) {
    const item=selection?.kind==='provider'?this.halls.get(selection.id):this.units.get(selection?.id);
    if(!item)return;
    const target=item.root.position.clone();target.y=1;
    const move=target.clone().sub(this.controls.target);
    this.camera.position.add(move);this.controls.target.copy(target);this.bound();this.camera.zoom=Math.max(CAMERA.zoom.focus,this.controls.minZoom);
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
        item={root,label:this.label('provider',p.id),custom,glows:this.ownGlow(root),level:0,target:0,emitted:0,
          smoke:root.getObjectByName('hall_'+(custom?'shell':p.id)+'_smoke')};this.halls.set(p.id,item);
        root.userData.entity={kind:'provider',id:p.id};
      }
      item.target=GLOW[hallActivity(sessions,p.id)];
      if(this.reduced)item.level=item.target;
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
      item.label.remove();this.halls.delete(id);
      // A custom hall's own glow materials share their textures with the shell hall's.
      if(item.custom){this.world.remove(item.root);for(const m of item.glows)m.dispose();}
    }
    this.glow();
    // Where every session goes (model.mjs stage). A quiet session leaves for
    // the plaza at a time its own data gives, so the next change is timed, not polled.
    const now=this.clock();
    this.staged=stage(sessions,providers,now,this.staged);
    clearTimeout(this.stageTimer);
    const next=nextStagingChange(sessions,now);
    if(next!==null)this.stageTimer=setTimeout(()=>{if(!this.disposed)this.update(this.providers,this.sessions);},Math.max(50,next-now+50));
    const live=new Set(sessions.map(s=>s.id));
    for(const [id,item]of this.units)if(!live.has(id)){this.removeUnit(item);this.units.delete(id);}
    this.placeProps(sessions);
    for(const session of sessions) {
      let unit=this.units.get(session.id);
      const place=this.staged.places.get(session.id);
      if(!unit) {
        const root=new T.Group();root.userData.entity={kind:'session',id:session.id};
        const ring=new T.Mesh(new T.RingGeometry(.53,.58,40),new T.MeshBasicMaterial({color:session.provider.color||0xd4bd86,transparent:true,opacity:.4,side:T.DoubleSide,depthWrite:false}));
        ring.rotation.x=-Math.PI/2;ring.position.y=.19;root.add(ring);
        const crew=new T.Group();crew.userData.entity={kind:'session',id:session.id};
        unit={root,crew,ring,label:this.label('session',session.id),mixers:[],helpers:[],pose:null,revision:0,loaded:false,
          path:[],heading:place.face,mode:null,clipCount:0,clip:null,action:null,moving:false,target:null,lookYaw:0,lookPitch:0};
        // A session that has just started steps out of its hall; the rest,
        // and any this renderer has already shown, are at their places.
        const start=!this.seen.has(session.id)&&arrives(session,now)?doorFor(session,providers):place;
        root.position.set(start.x,.17,start.z);
        this.units.set(session.id,unit);this.scene.add(root);this.scene.add(crew);
      }
      unit.session=session;
      this.goTo(unit,place);
      // Only visible state transitions grant another load opportunity. Routine
      // snapshots, telemetry and animation frames must not retry failed assets.
      const loadState=JSON.stringify([sessionPose(session),helpersFor(session)]);
      if(unit.loadState!==loadState){
        unit.loadState=loadState;
        this.loadUnit(unit,session);
        if(unit.loaded)this.helpers(unit,session);
      }
      unit.label.children[0].textContent=session.name;
      const helpers=(session.agents?.length||0)+(session.shells?.length||0);
      unit.label.children[1].textContent=(sessionPose(session)==='working'?'Working':sessionPose(session)==='exited'?'Exited':'Running')+(helpers?' · '+helpers+' helpers':'');
      unit.label.dataset.status=sessionPose(session);
      unit.label.style.setProperty('--unit-color',session.provider.color||'#d0ba82');
      unit.label.setAttribute('aria-label',session.name+', '+unit.label.children[1].textContent);
      unit.ring.material.opacity=place.mode==='work'?.65:place.mode==='done'?.15:.35;
    }
    for(const id of live)this.seen.add(id);
    this.select(this.selected);this.dirty=true;this.drawOnce();
  }
  async loadUnit(unit,session) {
    if(unit.loaded||unit.loading)return;
    const generation=this.request;
    const prefix=WORLDS[this.skin].characters;
    const index=characterIndex(session.provider.id);
    unit.loading=true;
    try {
      const asset=await this.asset(prefix+index);
      if(this.disposed||generation!==this.request||!unit.root.parent)return;
      const model=T.cloneSkeleton(asset.scene);
      model.rotation.y=unit.heading;
      model.traverse(n=>{if(n.isMesh){n.castShadow=true;n.receiveShadow=true;}});
      unit.root.add(model);unit.model=model;unit.loaded=true;
      unit.label.title='';
      // The walk's stride and cycle, and where blows land, as rig.py wrote them.
      let yard=null;asset.scene.traverse(n=>{if(n.userData?.yard)yard=n.userData.yard;});
      unit.speed=yard?.stride&&yard?.cycle?yard.stride/yard.cycle:1;
      unit.events=yard?.events||[];unit.height=yard?.height;unit.surface=yard?.surface;unit.look=lookLimits(yard);
      const neck=model.getObjectByName('Neck'),head=model.getObjectByName('Head');
      unit.lookBones=neck&&head&&model.getObjectByName('LeftUpperLeg')?{neck,head}:null;
      this.scaleProp(unit.session?.id||session.id);
      const mixer=new T.AnimationMixer(model);unit.mixers.push(mixer);
      unit.animations=new Map(asset.animations.map(clip=>[clip.name,mixer.clipAction(clip)]));
      mixer.addEventListener('finished',()=>{if(unit.mixers[0]===mixer)this.nextClip(unit);});
      unit.clip=null;this.play(unit);
      this.helpers(unit,unit.session||session);this.dirty=true;this.drawOnce();
    } catch(err){
      if(!this.disposed&&generation===this.request&&unit.root.parent){console.warn('Yard character unavailable:',err.message);unit.label.title='Character art unavailable. Session controls remain available.';}
    } finally {unit.loading=false;}
  }
  // A hall's own copies of the materials that glow with its crew, so one
  // hall lighting up does not light the others that share them.
  ownGlow(root) {
    const own=new Map();
    root.traverse(node=>{
      if(!node.isMesh)return;
      const swap=m=>{
        if(!glows(m))return m;
        if(!own.has(m)){
          const copy=m.clone();copy.userData={...m.userData};
          // Glass fronts glow warm from inside when their crew works.
          if(m.name==='officeGlass'){copy.emissive.set(0xffcf8f);copy.userData.glow=0;}
          own.set(m,copy);
        }
        return own.get(m);
      };
      node.material=Array.isArray(node.material)?node.material.map(swap):swap(node.material);
    });
    return [...own.values()];
  }
  // Each hall's glow: what the theme gives its lit materials, and more as
  // its crew works.
  glow() {
    const gain=GLOW_GAIN[themeKey(this.theme)];
    for(const item of this.halls.values())for(const m of item.glows)m.emissiveIntensity=(m.userData.glow??0)+item.level*gain;
    this.dirty=true;
  }
  // Fades each hall's glow towards its activity, and gives off its effect.
  updateHalls(dt) {
    let changed=false;
    for(const item of this.halls.values()){
      if(item.level!==item.target){
        const step=dt/GLOW_FADE;
        item.level=Math.abs(item.target-item.level)<=step?item.target:item.level+Math.sign(item.target-item.level)*step;
        changed=true;
      }
      if(this.effects&&item.level>0&&item.smoke&&item.root.visible)this.emit(item,dt);
    }
    if(changed)this.glow();
    this.updateEffects(dt);
  }
  // One pooled particle system for every hall, in the world's preset.
  makeEffects(preset) {
    const geometry=new T.BufferGeometry();
    geometry.setAttribute('position',new T.BufferAttribute(new Float32Array(PARTICLES*3),3));
    geometry.setAttribute('size',new T.BufferAttribute(new Float32Array(PARTICLES),1));
    geometry.setAttribute('alpha',new T.BufferAttribute(new Float32Array(PARTICLES),1));
    const material=new T.ShaderMaterial({
      uniforms:{color:{value:new T.Color(preset.color)},scale:{value:1}},
      vertexShader:`attribute float size;attribute float alpha;varying float vAlpha;uniform float scale;
        void main(){vAlpha=alpha;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);gl_PointSize=size*scale*projectionMatrix[1][1];}`,
      fragmentShader:`uniform vec3 color;varying float vAlpha;
        void main(){float a=vAlpha*smoothstep(.5,.1,length(gl_PointCoord-.5));if(a<.004)discard;
          gl_FragColor=vec4(color,a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent:true,depthWrite:false,blending:preset.glow?T.AdditiveBlending:T.NormalBlending,
    });
    const points=new T.Points(geometry,material);points.frustumCulled=false;points.renderOrder=20;
    this.scene.add(points);
    this.effects={preset,points,live:0,
      particles:Array.from({length:PARTICLES},()=>({age:0,life:0,x:0,y:0,z:0,vx:0,vy:0,vz:0,phase:0}))};
    this.resize();
  }
  releaseEffects() {
    if(!this.effects)return;
    this.scene.remove(this.effects.points);this.effects.points.geometry.dispose();this.effects.points.material.dispose();
    this.effects=null;
  }
  // A hall gives off its preset's low rate at low activity and its high rate
  // at high, fading with its glow.
  emit(item,dt) {
    const {preset,particles}=this.effects;
    const rate=item.level<=GLOW.low?preset.rate[0]*item.level/GLOW.low:preset.rate[0]+(preset.rate[1]-preset.rate[0])*(item.level-GLOW.low)/(GLOW.high-GLOW.low);
    item.emitted+=rate*dt;
    if(item.emitted<1)return;
    item.smoke.getWorldPosition(vector);
    for(;item.emitted>=1;item.emitted--){
      const p=particles.find(q=>q.age>=q.life);
      if(!p){item.emitted=0;break;}
      const a=Math.random()*Math.PI*2,r=Math.sqrt(Math.random())*preset.spread;
      // Wanderers (fireflies) start anywhere from the canopy down to the doors.
      Object.assign(p,{age:0,life:preset.life*(.75+Math.random()*.5),phase:Math.random()*Math.PI*2,
        x:vector.x+Math.cos(a)*r,y:preset.wander?.6+Math.random()*(vector.y-.6):vector.y,z:vector.z+Math.sin(a)*r,
        vx:preset.drift[0]+(Math.random()-.5)*.1,vy:preset.rise*(.8+Math.random()*.4),vz:preset.drift[1]+(Math.random()-.5)*.1});
    }
  }
  updateEffects(dt) {
    const effects=this.effects;
    if(!effects)return;
    const {preset,particles,points}=effects,attributes=points.geometry.attributes;
    const position=attributes.position.array,size=attributes.size.array,alpha=attributes.alpha.array;
    let live=0;
    particles.forEach((p,i)=>{
      if(p.age<p.life)p.age+=dt;
      if(p.age<p.life){
        live++;
        const t=p.age/p.life;
        if(preset.wander){p.vx=Math.sin(p.age*1.3+p.phase)*.2;p.vz=Math.cos(p.age*1.1+p.phase*1.7)*.2;p.vy=Math.sin(p.age*.9+p.phase)*.1;}
        p.x+=p.vx*dt;p.y+=p.vy*dt;p.z+=p.vz*dt;
        position[i*3]=p.x;position[i*3+1]=p.y;position[i*3+2]=p.z;
        size[i]=preset.size[0]+(preset.size[1]-preset.size[0])*t;
        alpha[i]=preset.opacity*Math.sin(Math.PI*t)*(preset.wander?.55+.45*Math.sin(p.age*5+p.phase*3):1);
      } else if(size[i]){size[i]=0;alpha[i]=0;}
    });
    if(live||effects.live){attributes.position.needsUpdate=attributes.size.needsUpdate=attributes.alpha.needsUpdate=true;this.dirty=true;}
    effects.live=live;
  }
  // Ends every particle at once, as reduced motion does.
  stillEffects() {
    if(!this.effects)return;
    for(const p of this.effects.particles)p.age=p.life;
    this.updateEffects(0);
  }
  // A prop at every session's station, while the session exists, whether its
  // character is there or resting; walkers keep round them.
  placeProps(sessions) {
    const live=new Set(sessions.map(s=>s.id)),spots=[];
    for(const [id,item]of this.props)if(!live.has(id)){this.scene.remove(item.root);this.props.delete(id);}
    for(const session of sessions){
      const slot=this.staged.slots.get(session.id);
      const prop=stationProp({x:Math.round(slot.x*1000)/1000,z:Math.round(slot.z*1000)/1000},session.id);
      spots.push(prop);
      let item=this.props.get(session.id);
      if(!item){
        item={root:new T.Group(),model:null};item.root.userData.prop=session.id;
        this.props.set(session.id,item);this.scene.add(item.root);this.fillProp(item);
      }
      item.root.position.set(prop.x,.17,prop.z);item.root.rotation.y=prop.face;
      this.scaleProp(session.id);
    }
    this.propSpots=spots;
    if(sessions.length)this.loadStation();
  }
  // A prop is scaled to its character, so hands meet its working surface.
  scaleProp(id) {
    const item=this.props.get(id),surface=this.units.get(id)?.surface;
    if(item)item.root.scale.setScalar(surface?surface/WORLDS[this.skin].station.surface:1);
  }
  // The world's prop loads once, like a helper model; a failed load waits
  // for the next world.
  async loadStation() {
    const name=WORLDS[this.skin].station.asset,generation=this.request;
    if(this.station?.generation===generation)return;
    this.station={name,generation,scene:null};
    try {
      const asset=await this.asset(name);
      if(this.disposed||generation!==this.request)return;
      asset.scene.traverse(n=>{if(n.isMesh){n.castShadow=true;n.receiveShadow=true;}});
      this.station.scene=asset.scene;
      for(const item of this.props.values())this.fillProp(item);
      this.dirty=true;this.drawOnce();
    } catch(err) {
      if(!this.disposed&&generation===this.request)console.warn('Yard station prop unavailable:',err.message);
    }
  }
  fillProp(item) {
    if(item.model||!this.station?.scene)return;
    item.model=this.station.scene.clone(true);item.root.add(item.model);
  }
  clearProps() {
    for(const item of this.props.values())this.scene.remove(item.root);
    this.props.clear();this.propSpots=[];
  }
  // A world switch releases the old world's prop model with its textures.
  releaseStation() {
    const name=this.station?.name;
    this.station=null;
    if(!name||!this.cache.has(name))return;
    const pending=this.cache.get(name);this.cache.delete(name);
    pending.then(asset=>disposeTree(asset.scene)).catch(noop);
  }
  // A resting or pausing character turns its head to whoever lookTarget
  // names, easing in and out, within the contract's limits. The clip has
  // just posed the bones; the turn goes on top, about the model's own up
  // and right axes, the neck taking its share and the head the rest.
  // unlook takes it off again before the next clip update, since the mixer
  // leaves a bone whose clip value has not changed as it stands.
  look(unit,dt) {
    if(!unit.lookBones)return;
    const {yaw:maxYaw,pitch:maxPitch,neck}=unit.look||STAGING.look;
    let yaw=0,pitch=0;
    const target=!unit.moving&&this.staged?lookTarget(unit.session.id,this.staged.places,this.selected?.kind==='session'?this.selected.id:null):null;
    const other=target&&this.units.get(target);
    if(other){
      const dx=other.root.position.x-unit.root.position.x,dz=other.root.position.z-unit.root.position.z;
      yaw=Math.max(-maxYaw,Math.min(maxYaw,angleTo(unit.heading,Math.atan2(dx,dz))));
      pitch=Math.max(-maxPitch,Math.min(maxPitch,Math.atan2(((other.height||2)-(unit.height||2))*.9,Math.hypot(dx,dz))));
    }
    const ease=1-Math.exp(-3*dt);
    unit.lookYaw+=(yaw-unit.lookYaw)*ease;unit.lookPitch+=(pitch-unit.lookPitch)*ease;
    if(Math.abs(unit.lookYaw)<1e-4&&Math.abs(unit.lookPitch)<1e-4)return;
    unit.lookPose??=[new T.Quaternion(),new T.Quaternion()];
    unit.lookPose[0].copy(unit.lookBones.neck.quaternion);unit.lookPose[1].copy(unit.lookBones.head.quaternion);unit.looking=true;
    unit.model.updateMatrixWorld(true);
    const model=lookModel.copy(unit.model.matrixWorld).invert();
    for(const [bone,share] of [[unit.lookBones.neck,neck],[unit.lookBones.head,1-neck]]){
      lookFrame.setFromRotationMatrix(lookParent.multiplyMatrices(model,bone.parent.matrixWorld));
      lookTurn.setFromAxisAngle(axisY,unit.lookYaw*share).multiply(lookTilt.setFromAxisAngle(axisX,-unit.lookPitch*share));
      bone.quaternion.premultiply(lookTurn.premultiply(lookFrame.clone().invert()).multiply(lookFrame));
      bone.updateMatrixWorld(true);
    }
    this.dirty=true;
  }
  unlook(unit) {
    if(!unit.looking)return;
    unit.lookBones.neck.quaternion.copy(unit.lookPose[0]);unit.lookBones.head.quaternion.copy(unit.lookPose[1]);unit.looking=false;
  }
  // A new place: walk there round the halls, or appear there when motion is reduced.
  goTo(unit,place) {
    const target=unit.target;
    unit.mode=place.mode;
    if(target&&target.x===place.x&&target.z===place.z){unit.target=place;if(!unit.moving)this.play(unit);return;}
    unit.target=place;
    const at={x:unit.root.position.x,z:unit.root.position.z};
    if(this.reduced||Math.hypot(place.x-at.x,place.z-at.z)<.05)this.arrive(unit);
    else {unit.path=route(at,place,this.providers,this.propSpots);unit.moving=true;}
    this.play(unit);
  }
  // Straight to its place, helpers with it.
  arrive(unit) {
    const place=unit.target;
    unit.root.position.set(place.x,.17,place.z);unit.path=[];unit.heading=place.face;unit.moving=false;
    if(unit.model)unit.model.rotation.y=unit.heading;
    for(const helper of unit.helpers)helper.model.position.set(place.x+helper.offset.x,.27,place.z+helper.offset.z);
  }
  // The clip a character should be playing now: the walk while it moves,
  // otherwise its mode's seeded sequence (model.mjs clipFor).
  play(unit) {
    if(!unit.animations)return;
    if(unit.moving){this.crossTo(unit,'walk',T.LoopRepeat);return;}
    const mode=unit.mode||'pause';
    if(unit.clip&&unit.clipMode===mode&&unit.clip!=='walk')return;
    unit.clipMode=mode;unit.clipCount=0;
    this.crossTo(unit,clipFor(unit.session.id,mode,unit.clipCount),T.LoopOnce);
  }
  nextClip(unit) {
    if(unit.moving||!unit.animations)return;
    unit.clipCount++;
    const name=clipFor(unit.session.id,unit.clipMode,unit.clipCount);
    if(name===unit.clip){unit.action.reset().play();return;}
    this.crossTo(unit,name,T.LoopOnce);
  }
  crossTo(unit,name,loop) {
    const action=unit.animations.get(name)||unit.animations.get(LEGACY[name])||unit.animations.values().next().value;
    unit.clip=name;
    if(!action||action===unit.action)return;
    action.reset();action.setLoop(loop,Infinity);action.clampWhenFinished=false;action.play();
    if(unit.action){if(this.reduced)unit.action.stop();else unit.action.crossFadeTo(action,FADE,false);}
    unit.action=action;unit.eventTime=0;
    if(this.reduced)unit.mixers[0].update(.15);
    this.dirty=true;
  }
  // Moves a walking character along its path at its stride's speed, turning
  // smoothly, and turns a standing one to face its place.
  advance(unit,dt) {
    const root=unit.root.position;
    let want=unit.target?.face??unit.heading;
    if(unit.moving&&unit.path.length) {
      let step=unit.speed*dt;
      while(step>0&&unit.path.length){
        const next=unit.path[0],dx=next.x-root.x,dz=next.z-root.z,d=Math.hypot(dx,dz);
        if(d>1e-4)want=Math.atan2(dx,dz);
        if(d<=step){root.x=next.x;root.z=next.z;unit.path.shift();step-=d;}
        else {root.x+=dx/d*step;root.z+=dz/d*step;step=0;}
      }
      if(!unit.path.length){unit.moving=false;this.play(unit);}
      this.dirty=true;
    }
    const turn=angleTo(unit.heading,want);
    if(Math.abs(turn)>1e-3){
      unit.heading+=Math.sign(turn)*Math.min(Math.abs(turn),TURN*dt);
      if(unit.model)unit.model.rotation.y=unit.heading;
      this.dirty=true;
    }
    // Helpers trail their character, closing most of the gap in a second.
    const pull=1-Math.exp(-4*dt);
    for(const helper of unit.helpers){
      const tx=root.x+helper.offset.x,tz=root.z+helper.offset.z,p=helper.model.position;
      const dx=tx-p.x,dz=tz-p.z,far=Math.hypot(dx,dz);
      p.x+=dx*pull;p.z+=dz*pull;
      if(far>.05)helper.model.rotation.y=Math.atan2(dx,dz);
      const moving=far>.08;
      if(moving!==helper.moving){helper.moving=moving;this.helperClip(helper,moving?'move':helper.pose);}
      if(far>1e-3)this.dirty=true;
    }
    this.fire(unit);
  }
  // Sparks where a blow lands, at the moment rig.py recorded.
  fire(unit) {
    if(!unit.events?.length||!unit.action||unit.moving)return;
    const time=unit.action.time,last=unit.eventTime??0;unit.eventTime=time;
    for(const event of unit.events){
      if(event.clip!==unit.clip)continue;
      const crossed=last<=time?event.time>last&&event.time<=time:event.time>last||event.time<=time;
      if(!crossed)continue;
      const c=Math.cos(unit.heading),s=Math.sin(unit.heading),[x,y,z]=event.at;
      this.spark(unit.root.position.x+x*c+z*s,unit.root.position.y+y,unit.root.position.z-x*s+z*c,unit.session.provider.color);
    }
  }
  spark(x,y,z,color) {
    if(this.sparks.length>=24)return;
    const count=14,positions=new Float32Array(count*3),velocity=[];
    for(let i=0;i<count;i++){
      positions.set([x,y+.05,z],i*3);
      const a=i/count*Math.PI*2+Math.random()*.4,r=1.2+Math.random()*1.4;
      velocity.push([Math.cos(a)*r,1.6+Math.random()*2.2,Math.sin(a)*r]);
    }
    const geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.BufferAttribute(positions,3));
    const material=new T.PointsMaterial({color:0xffc46b,size:.09,transparent:true,opacity:1,blending:T.AdditiveBlending,depthWrite:false});
    const points=new T.Points(geometry,material);points.frustumCulled=false;
    this.scene.add(points);this.sparks.push({points,velocity,age:0});
  }
  updateSparks(dt) {
    for(const spark of [...this.sparks]){
      spark.age+=dt;
      const array=spark.points.geometry.attributes.position.array;
      spark.velocity.forEach((v,i)=>{v[1]-=9*dt;array[i*3]+=v[0]*dt;array[i*3+1]=Math.max(.02,array[i*3+1]+v[1]*dt);array[i*3+2]+=v[2]*dt;});
      spark.points.geometry.attributes.position.needsUpdate=true;
      spark.points.material.opacity=Math.max(0,1-spark.age/.55);
      if(spark.age>.55){this.scene.remove(spark.points);spark.points.geometry.dispose();spark.points.material.dispose();this.sparks.splice(this.sparks.indexOf(spark),1);}
    }
    if(this.sparks.length)this.dirty=true;
  }
  helperClip(helper,name) {
    const clip=helper.clips.find(c=>c.name===name)||helper.clips.find(c=>c.name===LEGACY[name])||helper.clips[0];
    if(!clip)return;
    const action=helper.mixer.clipAction(clip);
    if(action===helper.action)return;
    action.reset().play();
    if(helper.action){if(this.reduced)helper.action.stop();else helper.action.crossFadeTo(action,FADE,false);}
    helper.action=action;
  }
  async helpers(unit,session) {
    const agents=helpersFor(session);
    const signature=JSON.stringify(agents);
    if(unit.helperSignature===signature)return;
    unit.helperSignature=signature;
    const rev=++unit.revision,generation=this.request;
    for(const helper of unit.helpers){unit.crew.remove(helper.model);helper.mixer?.stopAllAction();helper.mixer?.uncacheRoot(helper.model);disposeSkeletons(helper.model);}
    unit.helpers=[];
    const kinds=WORLDS[this.skin].helpers;
    // The full helper count and all helper details remain in the canonical inspector.
    // Small squads preserve readable character silhouettes at the overview scale.
    await Promise.all(agents.slice(0,6).map(async(agent,i)=>{
      try {
        const asset=await this.asset((agent.shell?kinds.shell:kinds.agent)+(hash(agent.name||agent.id)%4));
        if(this.disposed||generation!==this.request||rev!==unit.revision||!unit.root.parent)return;
        const model=T.cloneSkeleton(asset.scene);
        const offset=helperOffset(i,agents.length);
        model.scale.setScalar(.45);model.position.set(unit.root.position.x+offset.x,.27,unit.root.position.z+offset.z);
        unit.crew.add(model);
        const mixer=new T.AnimationMixer(model);
        const helper={model,mixer,offset,pose:agent.pose,clips:asset.animations,moving:false,action:null};
        this.helperClip(helper,agent.pose);
        mixer.update(.3+(hash(agent.id)%40)/10);
        unit.helpers.push(helper);
        this.dirty=true;this.drawOnce();
      } catch {
        // The next state transition can rebuild this incomplete squad. Routine
        // unchanged updates do not call helpers(), so failure cannot loop.
        if(!this.disposed&&generation===this.request&&rev===unit.revision&&unit.root.parent)unit.helperSignature=null;
      }
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
    const hits=this.ray.intersectObjects([...this.halls.values(),...this.units.values()].flatMap(i=>i.crew?[i.root,i.crew]:[i.root]),true);
    for(const hit of hits) { for(let node=hit.object;node;node=node.parent) if(node.userData.entity)return node.userData.entity; }
    return null;
  }
  // Runs every frame while anyone walks, so it reads every label's size
  // before writing any position: one layout, not one per label.
  positionLabels() {
    const w=this.host.clientWidth,h=this.host.clientHeight,placed=[];
    const items=[...this.halls.values(),...this.units.values()];
    const sizes=items.map(item=>[item.label.offsetWidth||120,item.label.offsetHeight||28]);
    for(const [i,item] of items.entries()) {
      const hall=item.label.dataset.kind==='provider';
      vector.copy(item.root.position);vector.y+=hall?.5:2.4;
      if(hall)vector.z+=2.1;
      vector.project(this.camera);
      const hidden=vector.z<-1||vector.z>1||Math.abs(vector.x)>1.1||Math.abs(vector.y)>1.1;
      if(item.label.hidden!==hidden)item.label.hidden=hidden;
      if(hidden)continue;
      const [lw,lh]=sizes[i];
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
    if(value)for(const unit of this.units.values()){this.unlook(unit);unit.lookYaw=0;unit.lookPitch=0;}
    if(value)for(const unit of this.units.values())if(unit.moving&&unit.target){this.arrive(unit);this.play(unit);}
    // Reduced motion shows each hall's glow as it stands, and no effects.
    if(value){for(const item of this.halls.values())item.level=item.target;this.glow();this.stillEffects();}
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
    if(!this.reduced)this.step(dt);
    if(this.dirty)this.positionLabels();
    if(!this.reduced||this.dirty){this.renderer.render(this.scene,this.camera);this.dirty=false;}
    if(!this.reduced)this.schedule();
  }
  // Advances walks, turns, helpers, clips, glances, sparks and the halls'
  // glow and effects by dt seconds, without drawing.
  step(dt) {
    for(const unit of this.units.values()) {
      this.advance(unit,dt);
      // Characters out of view animate five times a second, enough to stay
      // in step for when the camera comes back to them.
      let step=dt;
      if(unit.label.hidden){unit.lag=(unit.lag||0)+dt;if(unit.lag<.2)continue;step=unit.lag;}
      unit.lag=0;
      this.unlook(unit);
      for(const mixer of unit.mixers)mixer.update(step);
      for(const helper of unit.helpers)helper.mixer.update(step);
      this.look(unit,step);
    }
    this.updateSparks(dt);
    this.updateHalls(dt);
  }
  drawOnce() { if(this.active)this.schedule(); }
  removeUnit(unit) {
    unit.revision++;
    for(const mixer of unit.mixers){mixer.stopAllAction();mixer.uncacheRoot(mixer.getRoot());}
    for(const helper of unit.helpers){helper.mixer.stopAllAction();helper.mixer.uncacheRoot(helper.model);}
    disposeSkeletons(unit.root);disposeSkeletons(unit.crew);
    this.scene.remove(unit.root);this.scene.remove(unit.crew);unit.label.remove();unit.ring.geometry.dispose();unit.ring.material.dispose();
  }
  clearUnits() { for(const unit of this.units.values())this.removeUnit(unit);this.units.clear(); }
  dispose() {
    if(this.disposed)return;
    this.disposed=true;this.request++;this.worldRequest++;cancelAnimationFrame(this.frame);clearTimeout(this.stageTimer);
    for(const spark of this.sparks){spark.points.geometry.dispose();spark.points.material.dispose();}this.sparks=[];
    this.releaseEffects();this.clearProps();
    this.loadingManager.abort();this.pending?.close();this.pending=null;
    this.resizeObserver.disconnect();this.controls.dispose();this.clearUnits();
    for(const item of this.halls.values())item.label.remove();this.halls.clear();
    disposeWorld(this.world);
    for(const entry of this.cache.values())entry.then(a=>disposeTree(a.scene)).catch(noop);this.cache.clear();
    this.sun.shadow.map?.dispose();
    this.canvas.removeEventListener('webglcontextlost',this.contextLost);
    this.canvas.removeEventListener('pointerdown',this.onPointerDown);
    this.canvas.removeEventListener('click',this.onClick);this.canvas.removeEventListener('dblclick',this.onDouble);
    this.renderer.dispose();this.renderer.forceContextLoss();this.canvas.remove();
  }
}
