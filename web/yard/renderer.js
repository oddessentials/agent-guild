import * as T from './vendor/engine.js';
import { WORLDS, PROVIDER_ORDER, CAMERA, SUN, minZoom, clampPan, viewBasis, providerPositions, layoutSessions, sessionPose, familiarPose, hash } from './model.mjs';

const ASSETS = new URL('./assets/', import.meta.url);
const vector = new T.Vector3();
const noop = () => {};
function helpersFor(session) {
  return [
    ...(session.agents||[]).map(a=>({id:a.id,name:a.name,pose:familiarPose(a),shell:false})),
    ...(session.shells||[]).map(s=>({id:s.id,name:'Shell command',pose:'working',shell:true})),
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
function disposeWorld(root) {
  if(root)root.userData.disposed=true;
  disposeTree(root);
  for(const environment of Object.values(root?.userData.environments||{}))environment.dispose();
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
  async setWorld(skin,theme) {
    if(this.disposed)return;
    if(!WORLDS[skin])throw new Error('This skin has no yard.');
    const request=++this.worldRequest;
    this.light(skin,theme);
    if(this.skin===skin&&this.world){this.drawOnce();return;}
    let loaded;
    try {
      loaded=await new T.GLTFLoader(this.loadingManager).loadAsync(new URL(skin+'.glb',ASSETS).href);
      if(this.disposed||request!==this.worldRequest){disposeWorld(loaded.scene);return;}
      if(WORLDS[skin].plates)await Promise.all([this.surfaceWorld(loaded.scene,skin),this.plateWorld(loaded.scene,skin)]);
      else await this.textureWorld(loaded.scene, skin);
    } catch(err) {
      disposeWorld(loaded?.scene);
      if(!this.disposed&&request===this.worldRequest)throw err;
      return;
    }
    if(this.disposed||request!==this.worldRequest){disposeWorld(loaded.scene);return;}
    this.request++;
    this.clearUnits();
    for(const item of this.halls.values())item.label.remove();
    this.halls.clear();
    if(this.world){this.scene.remove(this.world);disposeWorld(this.world);}
    this.world=loaded.scene;this.skin=skin;this.scene.add(this.world);
    // Plated worlds match the AgX curve their plates were rendered with.
    this.renderer.toneMapping=WORLDS[skin].plates?T.AgXToneMapping:T.ACESFilmicToneMapping;
    this.light(skin,this.theme);
    this.host.dataset.world=skin;
    this.world.traverse(node=>{if(node.isMesh&&!node.userData.plate&&!node.material.isShadowMaterial){node.castShadow=true;node.receiveShadow=true;}});
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
  // Pre-rendered surroundings drawn behind everything, from the same view
  // direction as the camera, so they line up at any pan or zoom. Each theme
  // has its own set: the current theme's base layer gates the load, and its
  // sharper layers and the other theme follow without blocking it.
  async plateWorld(world,skin) {
    const response=await fetch(new URL(skin+'/plates.json',ASSETS));
    if(!response.ok)throw new Error('The Yard plates could not be loaded.');
    world.userData.plates={themes:(await response.json()).themes,groups:{}};
    await this.plateTheme(world,themeKey(this.theme));
    // Live halls and characters cast onto the plate's ground.
    const catcher=new T.Mesh(new T.PlaneGeometry(400,400),new T.ShadowMaterial({opacity:.3,depthWrite:false}));
    catcher.rotation.x=-Math.PI/2;catcher.position.y=.01;catcher.receiveShadow=true;catcher.renderOrder=-50;
    world.add(catcher);
  }
  plateTheme(world,theme) {
    const plates=world.userData.plates;
    if(plates.groups[theme])return plates.groups[theme].ready;
    const group=new T.Group();group.visible=false;world.add(group);
    const [base,...sharper]=plates.themes[theme];
    // Layers that arrive after their world is gone are released, not added.
    const keep=meshes=>{
      if(this.disposed||world.userData.disposed){for(const mesh of meshes)disposeTree(mesh);return false;}
      group.add(...meshes);return true;
    };
    const ready=this.plateLayer(base,0).then(meshes=>{
      if(!keep(meshes))return;
      sharper.forEach((entry,i)=>this.plateLayer(entry,i+1).then(meshes=>{
        if(keep(meshes)){this.dirty=true;this.drawOnce();}
      }).catch(noop));
    });
    plates.groups[theme]={group,ready};
    return ready;
  }
  async plateLayer(entry,order) {
    const {right,up,forward}=viewBasis(),axes=[right,up,forward].map(v=>new T.Vector3(...v));
    const rotation=new T.Matrix4().makeBasis(axes[0],axes[1],axes[2].clone().negate());
    const depth=CAMERA.far*.75+axes[2].dot(new T.Vector3(...CAMERA.offset));
    const loader=new T.TextureLoader(this.loadingManager);
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
  // Live halls in plated worlds take scanned material sets by material name,
  // and light from a small copy of the plates' sky.
  async surfaceWorld(world,skin) {
    const response=await fetch(new URL(skin+'/surfaces.json',ASSETS));
    if(!response.ok)throw new Error('The Yard surfaces could not be loaded.');
    const {sky,surfaces}=await response.json();
    const loader=new T.TextureLoader(this.loadingManager),textures=[];
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
          const equirect=await new T.HDRLoader(this.loadingManager).loadAsync(new URL(file,ASSETS).href);
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
    const plated=Boolean(WORLDS[skin]?.plates),key=themeKey(theme);
    this.world?.traverse(node=>{
      // Lit windows and magic read as glow at night, not as paint by day.
      for(const m of (Array.isArray(node.material)?node.material:node.material?[node.material]:[]))
        if(m.name==='window'||m.name==='magic')m.emissiveIntensity=light?.35:1.4;
    });
    // Plated worlds use the sun, sky and plates their theme was rendered with.
    this.sun.position.set(...(plated?SUN[key]:SUN.light));
    this.scene.environment=this.world?.userData.environments?.[key]||null;
    if(this.world&&this.skin===skin)this.showPlates(key);
    this.renderer.toneMappingExposure=light?1.65:1.12;
    this.hemi.color.set(skin==='grove'?0xccebd6:skin==='orbital'?0xa7c9ff:0xc4dced);
    this.hemi.intensity=(light?3.2:1.8)*(WORLDS[skin]?.plates?.35:1);
    // Blender and three.js place an equirectangular sky half a turn apart.
    this.scene.environmentRotation.y=Math.PI;this.scene.environmentIntensity=light?1.25:.7;
    this.sun.color.set(plated&&!light?0xff9a5c:skin==='orbital'?0xc5d8ff:0xffe0ad);
    this.sun.intensity=light?4.0:plated?3.2:2.7;
    this.dirty=true;
  }
  resize() {
    if(this.disposed)return;
    const w=this.host.clientWidth,h=this.host.clientHeight;
    if(!w||!h)return;
    this.renderer.setSize(w,h,false);
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
      }
      const slot=this.slots.get(session.id);unit.root.position.set(slot.x,.17,slot.z);
      unit.session=session;
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
      if(unit.loaded)this.pose(unit,sessionPose(session));
    }
    this.select(this.selected);this.dirty=true;this.drawOnce();
  }
  async loadUnit(unit,session) {
    if(unit.loaded||unit.loading)return;
    const generation=this.request;
    if(this.skin==='professional') {
      const material=new T.MeshStandardMaterial({color:session.provider.color||0x70868e,roughness:.5});
      const mesh=new T.Mesh(new T.BoxGeometry(.45,.65,.45),material);mesh.position.y=.33;mesh.castShadow=true;unit.root.add(mesh);unit.token=mesh;unit.loaded=true;return;
    }
    const prefix=this.skin==='orbital'?'robot_':this.skin==='grove'?'spirit_':'hero_';
    const index=Math.max(0,PROVIDER_ORDER.indexOf(session.provider.id));
    unit.loading=true;
    try {
      const asset=await this.asset(prefix+index);
      if(this.disposed||generation!==this.request||!unit.root.parent)return;
      const model=T.cloneSkeleton(asset.scene);
      model.rotation.y=-.3;
      model.traverse(n=>{if(n.isMesh){n.castShadow=true;n.receiveShadow=true;}});
      unit.root.add(model);unit.model=model;unit.loaded=true;
      unit.label.title='';
      const mixer=new T.AnimationMixer(model);unit.mixers.push(mixer);
      unit.animations=new Map(asset.animations.map(clip=>[clip.name,mixer.clipAction(clip)]));
      this.pose(unit,sessionPose(unit.session||session));
      this.helpers(unit,unit.session||session);this.dirty=true;this.drawOnce();
    } catch(err){
      if(!this.disposed&&generation===this.request&&unit.root.parent){console.warn('Yard character unavailable:',err.message);unit.label.title='Character art unavailable. Session controls remain available.';}
    } finally {unit.loading=false;}
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
    const agents=helpersFor(session);
    const signature=JSON.stringify(agents);
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
    disposeWorld(this.world);
    for(const entry of this.cache.values())entry.then(a=>disposeTree(a.scene)).catch(noop);this.cache.clear();
    this.sun.shadow.map?.dispose();
    this.canvas.removeEventListener('webglcontextlost',this.contextLost);
    this.canvas.removeEventListener('pointerdown',this.onPointerDown);
    this.canvas.removeEventListener('click',this.onClick);this.canvas.removeEventListener('dblclick',this.onDouble);
    this.renderer.dispose();this.renderer.forceContextLoss();this.canvas.remove();
  }
}
