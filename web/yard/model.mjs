// Presentation only: never changes or infers manager state.
export const PROVIDER_ORDER = ['anthropic', 'openai', 'google', 'xai', 'shell'];
// Per world: its model, character and helper model prefixes, and the light colours each theme uses.
export const WORLDS = {
  guild: { title: 'The Guild Yard', subtitle: 'A place for every great endeavour', asset: 'guild',
    characters: 'hero_', helpers: { agent: 'familiar_', shell: 'drone_' },
    hemi: 0xc4dced, sun: { light: 0xffe0ad, dark: 0xff9a5c } },
  orbital: { title: 'Orbital Station', subtitle: 'Your crew, at the edge of possibility', asset: 'orbital',
    characters: 'robot_', helpers: { agent: 'drone_', shell: 'drone_' },
    hemi: 0xa7c9ff, sun: { light: 0xfff8f0, dark: 0xffa46e } },
  grove: { title: 'The Living Grove', subtitle: 'Good work takes root here', asset: 'grove',
    characters: 'spirit_', helpers: { agent: 'familiar_', shell: 'drone_' },
    hemi: 0xccebd6, sun: { light: 0xffe0ad, dark: 0xffe0ad } },
  professional: { title: 'Operations Campus', subtitle: 'A clear view of work in progress', asset: 'professional',
    characters: 'staff_', helpers: { agent: 'bot_', shell: 'bot_' },
    hemi: 0xc8d6e2, sun: { light: 0xfff0d8, dark: 0xff9a5c } },
  goblinville: { title: 'Goblinville Works', subtitle: 'Steam up, and mind the boardwalks', asset: 'goblinville',
    characters: 'goblin_', helpers: { agent: 'goblin_familiar_', shell: 'goblin_helper_' },
    hemi: 0xc9d6c8, sun: { light: 0xffe2b8, dark: 0xff8c50 } },
  gnomeland: { title: 'Gnomeland Village', subtitle: 'Measure twice, enchant once', asset: 'gnomeland',
    characters: 'gnome_', helpers: { agent: 'gnome_familiar_', shell: 'gnome_helper_' },
    hemi: 0xcbd9d6, sun: { light: 0xffe4bf, dark: 0xff8d52 } },
};
// One orthographic view shared by the live scene and the pre-rendered
// environment plates, which only line up while these values agree.
export const CAMERA = {
  offset: [19, 24, 31], target: [0, 1, 0], height: 30, near: .1, far: 400,
  zoom: { overview: 1.02, focus: 1.7, min: .6, max: 3.8 },
  // Wider stages zoom in rather than see past the plates.
  maxAspect: 4,
  pan: { minX: -20, maxX: 20, minZ: -16, maxZ: 30 },
};
// Sun positions (relative to the target) for each theme. Plated worlds are
// rendered with these, and the live scene lights its models to match:
// late morning for light, a low warm dusk sun from the same side for dark.
export const SUN = { light: [-12, 25, 15], dark: [-12, 3.4, 15] };
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export function minZoom(aspect) {
  return Math.max(CAMERA.zoom.min, CAMERA.zoom.min * aspect / CAMERA.maxAspect);
}
export function clampPan({ x, z }) {
  const { minX, maxX, minZ, maxZ } = CAMERA.pan;
  return { x: clamp(x, minX, maxX), z: clamp(z, minZ, maxZ) };
}
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const normalize = v => { const n = Math.hypot(...v); return v.map(x => x/n); };
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
// Screen right and up as world directions, matching camera.lookAt(target).
export function viewBasis() {
  const forward = normalize(CAMERA.offset.map(x => -x));
  const right = normalize(cross(forward, [0, 1, 0]));
  return { forward, right, up: cross(right, forward) };
}
// Every point any permitted view can show, in view-plane coordinates.
export function plateExtent() {
  const { right, up } = viewBasis(), { minX, maxX, minZ, maxZ } = CAMERA.pan, y = CAMERA.target[1];
  const corners = [[minX,y,minZ], [maxX,y,minZ], [minX,y,maxZ], [maxX,y,maxZ]];
  const halfHeight = CAMERA.height/2/CAMERA.zoom.min, halfWidth = halfHeight*CAMERA.maxAspect;
  const span = (axis, half) => {
    const values = corners.map(c => dot(c, axis));
    return [Math.min(...values)-half, Math.max(...values)+half];
  };
  return { right: span(right, halfWidth), up: span(up, halfHeight) };
}
export function sessionPose(s) {
  if (s.status === 'exited') return 'exited';
  return s.activity === 'active' ? 'working' : 'resting';
}
export function familiarPose(agent) {
  return ['working', 'waiting', 'idle', 'done'].includes(agent.status) ? agent.status : 'idle';
}
export function hash(value) {
  let n = 0;
  for (const char of String(value)) n = ((n << 5) - n + char.charCodeAt(0)) | 0;
  return Math.abs(n);
}
export function providerPositions(providers) {
  const slots = [[-7,-5], [0,-7], [7,-5], [-8,3], [8,3]];
  const result = new Map();
  const extra = providers.filter(p => !PROVIDER_ORDER.includes(p.id));
  for (const p of providers) {
    const i = PROVIDER_ORDER.indexOf(p.id);
    const [x,z] = i < 0 ? [((extra.indexOf(p)%5)-2)*5, 11+Math.floor(extra.indexOf(p)/5)*6] : slots[i];
    result.set(p.id,{x,z});
  }
  return result;
}
// Retain slots across unrelated removals. Every session has a selectable position.
export function layoutSessions(sessions, providers, previous = new Map()) {
  const anchors = providerPositions(providers), used = new Map(), result = new Map();
  const group = s => anchors.has(s.provider.id) ? s.provider.id : '__tasks';
  const sorted = [...sessions].sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const s of sorted) {
    const key = group(s);
    if (!used.has(key)) used.set(key,new Set());
    const old = previous.get(s.id);
    if (old?.group === key && !used.get(key).has(old.slot)) {
      used.get(key).add(old.slot); result.set(s.id,{group:key,slot:old.slot});
    }
  }
  for (const s of sorted) {
    const key = group(s);
    if (!result.has(s.id)) {
      let slot=0; while(used.get(key).has(slot)) slot++;
      used.get(key).add(slot); result.set(s.id,{group:key,slot});
    }
    const entry=result.get(s.id), origin=anchors.get(key)||{x:0,z:4};
    // Crews behind a front hall fill from the end the camera can see past it.
    const dir=key==='anthropic'||key==='google'?-1:1;
    entry.x=origin.x+dir*((entry.slot%4)-1.5)*1.25;
    entry.z=origin.z+3.25+Math.floor(entry.slot/4)*1.6;
  }
  return result;
}
