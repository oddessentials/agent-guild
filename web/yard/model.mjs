// Presentation only: never changes or infers manager state.
export const PROVIDER_ORDER = ['anthropic', 'openai', 'google', 'xai', 'shell', 'docker'];
// Character model index for a provider; custom providers wear the shell's, as they get its hall.
export const characterIndex = id => PROVIDER_ORDER.includes(id) ? PROVIDER_ORDER.indexOf(id) : PROVIDER_ORDER.indexOf('shell');
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
  const slots = [[-7,-5], [0,-7], [7,-5], [-8,3], [8,3], [-10,11]];
  const result = new Map();
  const extra = providers.filter(p => !PROVIDER_ORDER.includes(p.id));
  for (const p of providers) {
    const i = PROVIDER_ORDER.indexOf(p.id);
    // Custom providers fill the front rows, starting past Docker Agent's place.
    const n = extra.indexOf(p) + 1;
    const [x,z] = i < 0 ? [((n%5)-2)*5, 11+Math.floor(n/5)*6] : slots[i];
    result.set(p.id,{x,z});
  }
  return result;
}
// Each session's station: its slot in front of its hall, where it works.
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
    const dir=key==='anthropic'||key==='google'||key==='xai'?-1:1;
    // Docker Agent's hall and crew are oversized, so its crew stands further out and further apart.
    const size=key==='docker'?1.3:1;
    entry.x=origin.x+dir*((entry.slot%4)-1.5)*1.25*size;
    entry.z=origin.z+(3.25+Math.floor(entry.slot/4)*1.6)*size;
  }
  return result;
}

// Staging (docs/yard/CONTRACT.md). Every move follows a state the manager
// reports: a running session with output works at its station; quiet, it
// pauses there, and after restAfter of quiet it walks to the plaza to rest;
// an exited session winds down at its station. New sessions step out of
// their hall's door.
export const STAGING = {
  restAfter: 20000,
  // A session created this recently steps out of its hall's door when it appears.
  arrival: 15000,
  // Where characters face while they work: towards the camera, as the cast always has.
  stationFace: -.3,
  door: 2.9,
  // Every world has a centrepiece (a pool, well, hatch or gear) that walkers go round.
  plaza: { x: 0, z: 0, half: 2.2, rings: [[3.2, 10], [4.4, 14], [5.6, 18]] },
  // Hall footprints, as half widths about each anchor, and the clearance walkers keep.
  hall: { half: 2.65, docker: 3.4, margin: .55 },
};
// The clips every character and helper model carries. Characters play one
// walk at the speed their model's `yard.stride` and `yard.cycle` extras give.
export const CLIPS = {
  character: { walk: 'walk', work: ['work_0', 'work_1'], pause: ['pause'], rest: ['idle_0', 'idle_1', 'idle_2'], done: ['done'] },
  helper: ['idle', 'working', 'waiting', 'done', 'move'],
};
// The shared skeleton, named after Godot's humanoid profile. Helpers carry
// the trunk only; characters add limbs and a prop socket in each hand.
const LIMBS = ['Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot', 'Toes'];
export const SKELETON = {
  helper: ['Root', 'Hips', 'Spine', 'Chest', 'UpperChest', 'Neck', 'Head'],
  character: ['Root', 'Hips', 'Spine', 'Chest', 'UpperChest', 'Neck', 'Head',
    ...['Left', 'Right'].flatMap(side => [...LIMBS.map(limb => side + limb), 'Prop' + side])],
};
const time = value => { const t = Date.parse(value); return Number.isFinite(t) ? t : null; };
export function stagingMode(s, now) {
  if (s.status === 'exited') return 'done';
  if (s.activity === 'active') return 'work';
  const quiet = time(s.lastOutputAt) ?? time(s.startedAt) ?? time(s.createdAt);
  return quiet !== null && now - quiet >= STAGING.restAfter ? 'rest' : 'pause';
}
// When the next quiet session will leave for the plaza, or null.
export function nextStagingChange(sessions, now) {
  let next = null;
  for (const s of sessions) {
    if (stagingMode(s, now) !== 'pause') continue;
    const at = (time(s.lastOutputAt) ?? time(s.startedAt) ?? time(s.createdAt)) + STAGING.restAfter;
    if (next === null || at < next) next = at;
  }
  return next;
}
const hallHalf = id => id === 'docker' ? STAGING.hall.docker : STAGING.hall.half;
function hallBoxes(providers) {
  return [...providerPositions(providers)].map(([id, p]) => ({ id, x: p.x, z: p.z, half: hallHalf(id) }));
}
const obstacles = providers => [...hallBoxes(providers), { id: '', x: STAGING.plaza.x, z: STAGING.plaza.z, half: STAGING.plaza.half }];
// Rest spots ring the plaza's centrepiece, nearest ring first, each facing
// its middle. Each ring starts on the far side, where resting characters face
// the camera, and alternates outwards. A spot is left out where it would
// stand in a hall or among the first two crew rows in front of one.
export function restSpots(providers) {
  const { x: cx, z: cz, rings } = STAGING.plaza, boxes = hallBoxes(providers), spots = [];
  const crews = [...layoutSessions(providers.flatMap(p => Array.from({ length: 8 }, (_, i) =>
    ({ id: p.id + ':' + i, provider: { id: p.id }, createdAt: String(i) }))), providers).values()];
  const far = Math.atan2(CAMERA.offset[0], CAMERA.offset[2]) + Math.PI;
  for (const [radius, count] of rings) {
    for (let i = 0; i < count; i++) {
      const k = i % 2 ? -(i + 1) >> 1 : i >> 1, angle = far + k * 2 * Math.PI / count;
      const x = cx + Math.sin(angle) * radius, z = cz + Math.cos(angle) * radius;
      if (boxes.some(b => Math.abs(x - b.x) < b.half + 1 && Math.abs(z - b.z) < b.half + 1)) continue;
      if (crews.some(c => Math.hypot(x - c.x, z - c.z) < 1.1)) continue;
      spots.push({ x: round(x), z: round(z), face: round(Math.atan2(cx - x, cz - z)) });
    }
  }
  return spots;
}
const round = v => Math.round(v * 1000) / 1000;
// Where each session goes and what it does there. previous carries the last
// result, so rest spots, like stations, stay put across unrelated changes.
export function stage(sessions, providers, now, previous = null) {
  const slots = layoutSessions(sessions, providers, previous?.slots), spots = restSpots(providers);
  const sorted = [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const resting = sorted.filter(s => stagingMode(s, now) === 'rest'), rest = new Map(), taken = new Set();
  for (const s of resting) {
    const old = previous?.rest?.get(s.id);
    if (old !== undefined && old < spots.length && !taken.has(old)) { taken.add(old); rest.set(s.id, old); }
  }
  for (const s of resting) {
    if (rest.has(s.id)) continue;
    let i = 0; while (taken.has(i)) i++;
    taken.add(i); rest.set(s.id, i);
  }
  const places = new Map();
  for (const s of sessions) {
    const mode = stagingMode(s, now), slot = slots.get(s.id);
    // More resting sessions than spots: the rest stay at their stations.
    const spot = mode === 'rest' && rest.get(s.id) < spots.length ? spots[rest.get(s.id)] : null;
    places.set(s.id, spot ? { x: spot.x, z: spot.z, face: spot.face, mode } :
      { x: round(slot.x), z: round(slot.z), face: STAGING.stationFace, mode: mode === 'rest' ? 'pause' : mode });
  }
  return { slots, rest, places };
}
// Whether a session that has just appeared should walk out of its door.
export function arrives(session, now) {
  const created = time(session.createdAt);
  return created !== null && now - created < STAGING.arrival;
}
// The door a new session steps out of: in front of its hall, or the plaza.
export function doorFor(session, providers) {
  const anchor = providerPositions(providers).get(session.provider.id);
  return anchor ? { x: anchor.x, z: round(anchor.z + (session.provider.id === 'docker' ? STAGING.hall.docker : STAGING.door)) }
    : { x: STAGING.plaza.x, z: STAGING.plaza.z };
}
// Segment against an axis-aligned square (Liang-Barsky), for points strictly inside.
function crosses(a, b, box, half) {
  const dx = b.x - a.x, dz = b.z - a.z;
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, a.x - (box.x - half)], [dx, box.x + half - a.x], [-dz, a.z - (box.z - half)], [dz, box.z + half - a.z]]) {
    if (p === 0) { if (q <= 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return t1 - t0 > 1e-6;
}
// The shortest way from a to b that keeps out of every hall and the
// centrepiece: straight when clear, otherwise by the corners of what is in the way. Returns the
// waypoints after a, ending at b.
export function route(a, b, providers) {
  const boxes = obstacles(providers), m = STAGING.hall.margin;
  const blocked = (p, q) => boxes.some(box => crosses(p, q, box, box.half - .05));
  if (!blocked(a, b)) return [{ x: b.x, z: b.z }];
  const nodes = [a, b];
  for (const box of boxes) for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const p = { x: box.x + sx * (box.half + m), z: box.z + sz * (box.half + m) };
    if (!boxes.some(other => Math.abs(p.x - other.x) < other.half && Math.abs(p.z - other.z) < other.half)) nodes.push(p);
  }
  const dist = nodes.map(() => Infinity), from = nodes.map(() => -1), done = nodes.map(() => false);
  dist[0] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || u === 1) break;
    done[u] = true;
    for (let v = 0; v < nodes.length; v++) {
      if (done[v] || blocked(nodes[u], nodes[v])) continue;
      const d = dist[u] + Math.hypot(nodes[v].x - nodes[u].x, nodes[v].z - nodes[u].z);
      if (d < dist[v] - 1e-9) { dist[v] = d; from[v] = u; }
    }
  }
  if (dist[1] === Infinity) return [{ x: b.x, z: b.z }];
  const path = [];
  for (let i = 1; i > 0; i = from[i]) path.unshift({ x: round(nodes[i].x), z: round(nodes[i].z) });
  path[path.length - 1] = { x: b.x, z: b.z };
  return path;
}
// The nth clip a session plays in a mode. Mostly the first, with seeded
// turns at the others, so a crew never moves in step.
export function clipFor(id, mode, n) {
  const set = CLIPS.character[mode] || CLIPS.character.pause;
  if (set.length === 1) return set[0];
  const h = hash(id + ':' + mode + ':' + Math.floor(n / 3));
  if (mode === 'work') return n % 3 === 2 && h % 2 ? set[1] : set[0];
  return n % 3 === 2 ? set[1 + (h % (set.length - 1))] : set[0];
}
// Where a session's helpers stand, around it, as the renderer has always placed them.
export function helperOffset(i, count) {
  const angle = (i / Math.min(count, 6)) * Math.PI * 2;
  return { x: round(Math.cos(angle) * .82), z: round(Math.sin(angle) * .72) };
}
