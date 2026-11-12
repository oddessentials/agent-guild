import * as T from './vendor/engine.js';
import { hash, fireTint } from './model.mjs';

const RISE = .35, FALL = .6, LIFE = 1.25, EMBERS = 24, STILL = .35;
export const EMBER_SIZE = .072;
const GAIN = { flame: 2, glow: .8, ring: .8, ember: 2 };
const NOISE = `
  uvec2 pcg2d(uvec2 v){v=v*1664525u+1013904223u;v.x+=v.y*1664525u;v.y+=v.x*1664525u;v^=v>>16u;v.x+=v.y*1664525u;v.y+=v.x*1664525u;v^=v>>16u;return v;}
  vec2 gradient(vec2 cell){float a=float(pcg2d(uvec2(ivec2(cell)+65536)).x)*(6.2831853/4294967296.);return vec2(cos(a),sin(a));}
  float noise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*f*(f*(f*6.-15.)+10.);
    float va=dot(gradient(i),f),vb=dot(gradient(i+vec2(1,0)),f-vec2(1,0)),vc=dot(gradient(i+vec2(0,1)),f-vec2(0,1)),vd=dot(gradient(i+vec2(1,1)),f-vec2(1,1));
    return va+u.x*(vb-va)+u.y*(vc-va)+u.x*u.y*(va-vb-vc+vd);}`;
const FLAME = {
  vertexShader: `uniform float clock;varying float vHeight;varying vec2 vUv;varying vec3 vNormal;
    void main(){vHeight=position.y+.5;vUv=uv;float bend=sin(uv.x*6.2831853*5.+clock*1.7+vHeight*4.);
      vec3 p=position;p.xz*=1.+bend*vHeight*vHeight*.12;vNormal=normalMatrix*normal;gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}`,
  fragmentShader: `uniform vec3 tint;uniform float strength;uniform float clock;varying float vHeight;varying vec2 vUv;varying vec3 vNormal;
    ${NOISE}
    void main(){float h=clamp(vHeight,0.,1.),a=vUv.x*6.2831853,drift=clock*1.4;vec2 around=vec2(cos(a),sin(a));
      float coarse=noise(around*3.+vec2(h*1.4,-drift)),fine=noise(around*7.+vec2(h*3.,-drift*1.8));
      float tip=.68+.24*sin(a*7.+coarse*3.+clock*.7)+coarse*.2;
      float flame=smoothstep(0.,.065,tip-h+fine*.17),foot=smoothstep(0.,.07,h);
      float wave=sin(a*9.+coarse*6.+sin(h*6.-clock*2.+a)*1.4)*.5+.5,strands=pow(clamp(wave,0.,1.),1.2+h*2.);
      float edge=pow(clamp(1.-abs(normalize(vNormal).z),0.,1.),1.5);
      float alpha=flame*foot*strands*(.12+.55*edge)*strength;
      gl_FragColor=vec4(mix(tint,vec3(1.),pow(1.-h,6.)*.16)*${GAIN.flame.toFixed(2)}*alpha,1.);
      #include <colorspace_fragment>
    }`,
};
const GLOW = {
  vertexShader: `#include <common>
    #include <skinning_pars_vertex>
    varying vec3 vNormal;
    void main(){
      #include <beginnormal_vertex>
      #include <skinbase_vertex>
      #include <skinnormal_vertex>
      #include <defaultnormal_vertex>
      #include <begin_vertex>
      #include <skinning_vertex>
      #include <project_vertex>
      vNormal=transformedNormal;
    }`,
  fragmentShader: `uniform vec3 tint;uniform float strength;varying vec3 vNormal;
    void main(){float rim=pow(clamp(1.-normalize(vNormal).z,0.,1.),3.);
      gl_FragColor=vec4(mix(tint,vec3(1.),rim*.25)*strength*${GAIN.glow.toFixed(2)}*(.025+rim*1.5),1.);
      #include <colorspace_fragment>
    }`,
};
const EMBER = {
  vertexShader: `attribute float size;attribute float alpha;varying float vAlpha;uniform float scale;
    void main(){vAlpha=alpha;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);gl_PointSize=size*scale*projectionMatrix[1][1];}`,
  fragmentShader: `uniform vec3 tint;varying float vAlpha;
    void main(){vec2 c=gl_PointCoord-.5;c.x*=2.667;float a=vAlpha*smoothstep(.5,.1,length(c));if(a<.004)discard;
      gl_FragColor=vec4(mix(tint,vec3(1.),.2)*${GAIN.ember.toFixed(2)}*a,1.);
      #include <colorspace_fragment>
    }`,
};
const additive = { transparent: true, depthWrite: false, blending: T.AdditiveBlending };
const inert = node => { node.raycast = () => {}; node.frustumCulled = false; node.userData.aura = true; return node; };
const seeThrough = mesh => [mesh.material].flat().some(m => m.transparent || m.alphaTest > 0);

export const auraShapes = () => ({ shell: new T.CylinderGeometry(.78, 1, 1, 48, 16, true), ring: new T.RingGeometry(.96, 1, 64) });

export class Aura {
  constructor(seed, shapes, pointScale) {
    this.active = false; this.reduced = false; this.color = null; this.strength = 0;
    this.elapsed = hash(seed) % 1000 / 100;
    this.tint = new T.Color();
    this.overlays = [];
    this.radius = .55; this.tall = 2;
    this.group = new T.Group();
    const uniforms = extra => ({ tint: { value: this.tint }, strength: { value: 0 }, ...extra });
    this.flames = inert(new T.Mesh(shapes.shell, new T.ShaderMaterial({ ...FLAME, ...additive, side: T.DoubleSide, uniforms: uniforms({ clock: { value: this.elapsed } }) })));
    this.glow = new T.ShaderMaterial({ ...GLOW, ...additive, uniforms: uniforms(), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    this.ring = inert(new T.Mesh(shapes.ring, new T.MeshBasicMaterial({ ...additive, opacity: 0, side: T.DoubleSide, toneMapped: false })));
    this.ring.rotation.x = -Math.PI / 2; this.ring.position.y = .2;
    const geometry = new T.BufferGeometry();
    geometry.setAttribute('position', new T.BufferAttribute(new Float32Array(EMBERS * 3), 3));
    geometry.setAttribute('size', new T.BufferAttribute(new Float32Array(EMBERS), 1));
    geometry.setAttribute('alpha', new T.BufferAttribute(new Float32Array(EMBERS), 1));
    this.embers = inert(new T.Points(geometry, new T.ShaderMaterial({ ...EMBER, ...additive, uniforms: { tint: { value: this.tint }, scale: pointScale } })));
    this.embers.renderOrder = 20;
    this.sparks = Array.from({ length: EMBERS }, (_, i) => ({ age: -i * LIFE / EMBERS, live: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size: 0 }));
    let state = hash(seed);
    this.random = () => {
      state = state + 0x6D2B79F5 | 0;
      let t = Math.imul(state ^ state >>> 15, 1 | state);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
    this.group.add(this.flames, this.ring, this.embers);
    this.sync();
  }
  bind(model, girth = 0, height = 2) {
    for (const overlay of this.overlays) overlay.removeFromParent();
    this.overlays = [];
    if (!model) return;
    const meshes = [];
    model.traverse(node => { if (node.isSkinnedMesh && !seeThrough(node)) meshes.push(node); });
    for (const mesh of meshes) {
      const overlay = inert(mesh.clone(false));
      overlay.material = this.glow; overlay.castShadow = false; overlay.receiveShadow = false;
      mesh.parent.add(overlay); this.overlays.push(overlay);
    }
    this.radius = Math.min(.9, Math.max(.55, girth * .42)); this.tall = Math.max(height, .5);
    this.flames.scale.set(this.radius + .12, this.tall * 1.22, this.radius + .12);
    this.flames.position.y = this.tall * .61 + .04;
    const ring = Math.max(.74, this.radius + .12);
    this.ring.scale.set(ring, ring, 1);
    this.sync();
  }
  set(on, color, reduced) {
    this.active = on; this.reduced = reduced;
    if (color !== this.color) {
      this.color = color;
      const { r, g, b } = new T.Color(color).getRGB({}, T.SRGBColorSpace);
      this.tint.setRGB(...fireTint(r, g, b), T.SRGBColorSpace);
      this.ring.material.color.copy(this.tint);
    }
    if (reduced) this.strength = on ? 1 : 0;
    this.sync();
  }
  advance(dt) {
    if (this.reduced || (!this.active && !this.strength)) return false;
    this.strength = Math.max(0, Math.min(1, this.strength + (this.active ? dt / RISE : -dt / FALL)));
    if (this.strength) { this.elapsed += dt; this.fly(dt); }
    this.sync();
    return true;
  }
  fly(dt) {
    const { position, size, alpha } = this.embers.geometry.attributes, random = this.random;
    this.sparks.forEach((p, i) => {
      p.age += dt;
      if (p.age >= LIFE || (p.age >= 0 && !p.live)) {
        p.live = this.active;
        if (p.live) {
          const a = random() * Math.PI * 2, r = this.radius * (.65 + .35 * Math.sqrt(random())), tilt = random() * .21, turn = random() * Math.PI * 2, speed = this.tall * (.4 + .4 * random());
          Object.assign(p, { age: 0, x: Math.cos(a) * r, y: random() * .1, z: Math.sin(a) * r, vx: Math.sin(tilt) * Math.cos(turn) * speed, vy: Math.cos(tilt) * speed, vz: Math.sin(tilt) * Math.sin(turn) * speed, size: EMBER_SIZE * (.55 + .45 * random()) });
        }
      }
      if (!p.live) { alpha.setX(i, 0); return; }
      p.vy += .25 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const u = p.age / LIFE;
      position.setXYZ(i, p.x, p.y, p.z); size.setX(i, p.size); alpha.setX(i, this.strength * Math.min(1, u / .15, (1 - u) / .3));
    });
    position.needsUpdate = size.needsUpdate = alpha.needsUpdate = true;
  }
  sync() {
    const shown = this.strength > 0;
    this.group.visible = shown;
    this.flames.visible = this.embers.visible = !this.reduced;
    this.flames.material.uniforms.strength.value = this.strength;
    this.flames.material.uniforms.clock.value = this.elapsed;
    this.glow.uniforms.strength.value = this.strength * (this.reduced ? STILL : 1);
    this.ring.material.opacity = this.strength * (this.reduced ? STILL : GAIN.ring);
    for (const overlay of this.overlays) overlay.visible = shown;
  }
  dispose() {
    this.bind(null);
    this.group.removeFromParent();
    for (const material of [this.flames.material, this.glow, this.ring.material, this.embers.material]) material.dispose();
    this.embers.geometry.dispose();
  }
}
