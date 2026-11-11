// Presentation only: never changes or infers manager state.
export const PROVIDER_ORDER = ['anthropic', 'openai', 'google', 'xai', 'shell', 'docker'];
// Character model index for a provider; custom providers wear the shell's, as they get its hall.
export const characterIndex = id => PROVIDER_ORDER.includes(id) ? PROVIDER_ORDER.indexOf(id) : PROVIDER_ORDER.indexOf('shell');
export const GILDED = ['terminal-ai-chat'];
// Hall effects, one pooled particle system for every hall: how many
// particles a second a hall gives off at low and high activity, how long each
// lives, how fast it rises and drifts (metres a second), how widely it starts
// round the hall's smoke anchor, its size as it starts and ends (metres), its
// colour and opacity, whether it adds light (glow), and whether it wanders
// and blinks instead of rising in a plume.
export const EFFECTS = {
  smoke: { rate: [5, 12], life: 4.5, rise: .55, drift: [.28, -.12], spread: .12, size: [.35, 1.3], color: 0x9a948c, opacity: .5, glow: false },
  vent: { rate: [8, 18], life: 1.8, rise: .9, drift: [.08, .05], spread: .18, size: [.25, .9], color: 0xeef4ff, opacity: .45, glow: false },
  rooftop: { rate: [6, 14], life: 2.6, rise: .7, drift: [.2, -.08], spread: .3, size: [.3, 1.1], color: 0xf2f2ee, opacity: .38, glow: false },
  fireflies: { rate: [4, 10], life: 6, rise: .05, drift: [0, 0], spread: 1.4, size: [.22, .22], color: 0xe4ff6e, opacity: 1, glow: true, wander: true },
};
// Per world: its model, character and helper model prefixes, the light
// colours each theme uses, its station prop (`station`: the model, and the
// height of its working surface for a 2 m character, which a client scales to
// each character's own `yard.surface`), and the effect its halls give off
// while their crews work (`effect`, one of EFFECTS).
export const WORLDS = {
  guild: { title: 'The Guild Yard', subtitle: 'A place for every great endeavour', asset: 'guild',
    characters: 'hero_', helpers: { agent: 'familiar_', shell: 'drone_' },
    hemi: 0xc4dced, sun: { light: 0xffe0ad, dark: 0xff9a5c },
    station: { asset: 'guild_station', surface: 1 }, effect: EFFECTS.smoke },
  orbital: { title: 'Orbital Station', subtitle: 'Your crew, at the edge of possibility', asset: 'orbital',
    characters: 'robot_', helpers: { agent: 'drone_', shell: 'drone_' },
    hemi: 0xa7c9ff, sun: { light: 0xfff8f0, dark: 0xffa46e },
    station: { asset: 'orbital_station', surface: 1 }, effect: EFFECTS.vent },
  grove: { title: 'The Living Grove', subtitle: 'Good work takes root here', asset: 'grove',
    characters: 'spirit_', helpers: { agent: 'familiar_', shell: 'drone_' },
    hemi: 0xccebd6, sun: { light: 0xffe0ad, dark: 0xffe0ad },
    station: { asset: 'grove_station', surface: .67 }, effect: EFFECTS.fireflies },
  professional: { title: 'Operations Campus', subtitle: 'A clear view of work in progress', asset: 'professional',
    characters: 'staff_', helpers: { agent: 'bot_', shell: 'bot_' },
    hemi: 0xc8d6e2, sun: { light: 0xfff0d8, dark: 0xff9a5c },
    station: { asset: 'professional_station', surface: 1 }, effect: EFFECTS.rooftop },
  goblinville: { title: 'Goblinville Works', subtitle: 'Steam up, and mind the boardwalks', asset: 'goblinville',
    characters: 'goblin_', helpers: { agent: 'goblin_familiar_', shell: 'goblin_helper_' },
    hemi: 0xc9d6c8, sun: { light: 0xffe2b8, dark: 0xff8c50 },
    station: { asset: 'goblinville_station', surface: 1 }, effect: EFFECTS.smoke },
  gnomeland: { title: 'Gnomeland Village', subtitle: 'Measure twice, enchant once', asset: 'gnomeland',
    characters: 'gnome_', helpers: { agent: 'gnome_familiar_', shell: 'gnome_helper_' },
    hemi: 0xcbd9d6, sun: { light: 0xffe4bf, dark: 0xff8d52 },
    station: { asset: 'gnomeland_station', surface: .75 }, effect: EFFECTS.smoke },
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
// Zooms out no further than minZoom, so a narrow stage may still crop the outer halls.
export function overviewFor(aspect) {
  const { right, up } = viewBasis(), { half, docker, height, dockerHeight } = STAGING.hall, t = CAMERA.target;
  const across = [], high = [];
  for (const [id, { x, z }] of providerPositions(PROVIDER_ORDER.map(id => ({ id })))) {
    const [h, tall, front] = id === 'docker' ? [docker, dockerHeight, 6.5] : [half, height, 5];
    for (const [dx, y, dz] of [[-h, tall, -h], [h, tall, -h], [-h, 0, front], [h, 0, front]]) {
      const p = [x + dx - t[0], y - t[1], z + dz - t[2]];
      across.push(dot(p, right)); high.push(dot(p, up));
    }
  }
  const [left, far] = [Math.min(...across), Math.max(...across)], reach = Math.max(-Math.min(...high), ...high);
  const view = CAMERA.height / 2;
  const zoom = Math.max(minZoom(aspect), Math.min(CAMERA.zoom.overview, 2 * view * aspect / (far - left), view / reach));
  const width = view * aspect / zoom;
  const shift = 2 * width >= far - left ? clamp(0, far - width, left + width) : (left + far) / 2;
  const { x, z } = clampPan({ x: t[0] + right[0] * shift, z: t[2] + right[2] * shift });
  return { target: [x, t[1], z], zoom };
}
export function sessionPose(s) {
  if (s.status === 'exited') return 'exited';
  return s.activity === 'active' ? 'working' : 'resting';
}
export function familiarPose(agent) {
  return ['working', 'waiting', 'idle', 'done'].includes(agent.status) ? agent.status : 'idle';
}
export const SHOWN_HELPERS = 6;
export function marksFor(s, mode) {
  if (s.status === 'exited') return { crew: s.multiplexer ? null : s.signal || (s.exitCode ?? 0) !== 0 ? 'failed' : 'exited', helpers: [] };
  const agents = s.agents || [], waiting = agents.filter(a => familiarPose(a) === 'waiting');
  const shown = waiting.filter(a => agents.indexOf(a) < SHOWN_HELPERS);
  const crew = waiting.length > shown.length ? 'waiting' : mode === 'rest' && !agents.length && !s.shells?.length ? 'asleep' : null;
  return { crew, helpers: shown.map(a => a.id) };
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
    entry.x=origin.x+dir*((entry.slot%4)-1.5)*STAGING.station.spacing*size;
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
  // Hall footprints, as half widths about each anchor, the clearance walkers keep, and hall heights.
  hall: { half: 2.65, docker: 3.4, margin: .55, height: 5.7, dockerHeight: 7.7 },
  // Each station's prop stands gap metres from its character, straight ahead
  // or turned to one side; walkers keep clear of a square of half width half
  // round it. Stations in a row stand spacing metres apart, room for a prop
  // between neighbours.
  station: { spacing: 2, gap: .75, turn: .7, half: .55 },
  // A resting or pausing character looks at the nearest other within range
  // metres, turning its head at most yaw either way and pitch up or down;
  // the neck takes neck of the turn and the head the rest.
  look: { range: 2.5, yaw: .7, pitch: .3, neck: .4 },
};
// The clips every character and helper model carries. Characters play one
// walk at the speed their model's `yard.stride` and `yard.cycle` extras give.
export const CLIPS = {
  character: { walk: 'walk', work: ['work_0', 'work_1'], pause: ['pause'], rest: ['idle_0', 'idle_1', 'idle_2'], done: ['done'] },
  helper: ['idle', 'working', 'waiting', 'done', 'move'],
};
export function yardExtras(raw, kind) {
  const yard = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const character = kind === 'character';
  const clean = { events: [], look: undefined, problem: null };
  const problem = message => { clean.problem ??= message; };
  const within = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
  const fields = character
    ? { height: [.5, 5, 2], stride: [.1, 5, 1], cycle: [.25, 10, 1], surface: [.1, 4, undefined] }
    : { height: [.1, 5, 1] };
  for (const [key, [min, max, fallback]] of Object.entries(fields)) {
    clean[key] = within(yard[key], min, max) ? yard[key] : fallback;
    if (!within(yard[key], min, max) && (character || yard[key] !== undefined)) problem(`needs a yard ${key} from ${min} to ${max}.`);
  }
  if (yard.events !== undefined) {
    if (!Array.isArray(yard.events) || yard.events.length > 32) problem('needs an animation event array with at most 32 entries.');
    if (Array.isArray(yard.events)) {
      const clips = character ? Object.values(CLIPS.character).flat() : CLIPS.helper;
      for (const event of yard.events.slice(0, 32)) {
        if (!event || !clips.includes(event.clip) || !within(event.time, 0, 60) || !Array.isArray(event.at) || event.at.length !== 3 || !event.at.every(value => within(value, -5, 5))) {
          problem('has an animation event without a valid clip, time and position.');
        } else clean.events.push({ clip: event.clip, time: event.time, at: [...event.at] });
      }
    }
  }
  if (yard.look !== undefined) {
    const look = yard.look;
    if (!look || typeof look !== 'object' || Array.isArray(look) || !['yaw', 'pitch'].every(key => look[key] === undefined || within(look[key], 0, Math.PI))) {
      problem('needs yard look yaw and pitch from 0 to π.');
    } else clean.look = { yaw: look.yaw, pitch: look.pitch };
  }
  return clean;
}
export const unitQuaternion = (x, y, z, w) => Math.abs(Math.hypot(x, y, z, w) - 1) <= 0.001;
export function playableClip(clip) {
  return clip.tracks.every(({ times, values, ValueTypeName }) => {
    if (!times.length || !(times[0] >= 0)) return false;
    for (let i = 0; i < times.length; i++) if (!Number.isFinite(times[i]) || (i > 0 && !(times[i] > times[i - 1]))) return false;
    for (const value of values) if (!Number.isFinite(value)) return false;
    if (ValueTypeName === 'quaternion') for (let i = 0; i < values.length; i += 4) if (!unitQuaternion(values[i], values[i + 1], values[i + 2], values[i + 3])) return false;
    return true;
  });
}
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
// stand in a hall or among the first two crew rows in front of one, or by
// any prop those rows could have.
export function restSpots(providers) {
  const { x: cx, z: cz, rings } = STAGING.plaza, boxes = hallBoxes(providers), spots = [];
  const crews = [...layoutSessions(providers.flatMap(p => Array.from({ length: 8 }, (_, i) =>
    ({ id: p.id + ':' + i, provider: { id: p.id }, createdAt: String(i) }))), providers).values()];
  const props = crews.flatMap(c => ARRANGEMENTS.map(a => propAt(c, a)));
  const far = Math.atan2(CAMERA.offset[0], CAMERA.offset[2]) + Math.PI;
  for (const [radius, count] of rings) {
    for (let i = 0; i < count; i++) {
      const k = i % 2 ? -(i + 1) >> 1 : i >> 1, angle = far + k * 2 * Math.PI / count;
      const x = cx + Math.sin(angle) * radius, z = cz + Math.cos(angle) * radius;
      if (boxes.some(b => Math.abs(x - b.x) < b.half + 1 && Math.abs(z - b.z) < b.half + 1)) continue;
      if (crews.some(c => Math.hypot(x - c.x, z - c.z) < 1.1)) continue;
      if (props.some(p => Math.hypot(x - p.x, z - p.z) < STAGING.station.half + .4)) continue;
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
    const station = { x: round(slot.x), z: round(slot.z) };
    places.set(s.id, spot ? { x: spot.x, z: spot.z, face: spot.face, mode } :
      { ...station, face: stationProp(station, s.id).characterFace, mode: mode === 'rest' ? 'pause' : mode });
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
// The shortest way from a to b that keeps out of every hall, the
// centrepiece and every station prop: straight when clear, otherwise by the
// corners of what is in the way. A prop that a or b stands in is no
// obstacle. Returns the waypoints after a, ending at b.
export function route(a, b, providers, props = []) {
  const inside = (p, box) => Math.abs(p.x - box.x) < box.half - .05 && Math.abs(p.z - box.z) < box.half - .05;
  const boxes = [...obstacles(providers), ...props.map(p => ({ x: p.x, z: p.z, half: STAGING.station.half }))
    .filter(box => !inside(a, box) && !inside(b, box))], m = STAGING.hall.margin;
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
// A station's prop: on the camera side of its character (`counter`), who
// faces it and the camera across it, or turned to one side (`left` or
// `right`, as the camera sees it), the character three-quarters toward it.
// The arrangement is the session's own, from its id. Returns where the prop
// stands, which way its front faces (towards the character), the
// arrangement, and which way the character faces.
const ARRANGEMENTS = ['counter', 'left', 'right'];
function propAt(place, arrangement) {
  const { turn, gap } = STAGING.station;
  const face = STAGING.stationFace + (arrangement === 'right' ? turn : arrangement === 'left' ? -turn : 0);
  return { x: round(place.x + Math.sin(face) * gap), z: round(place.z + Math.cos(face) * gap),
    face: round(face + Math.PI), arrangement, characterFace: round(face) };
}
export function stationProp(place, id) {
  return propAt(place, ARRANGEMENTS[hash(id + ':station') % ARRANGEMENTS.length]);
}
// How busy a provider's hall looks: off with none of its sessions working,
// low with one, high with more.
export function hallActivity(sessions, providerId) {
  const working = sessions.filter(s => s.provider.id === providerId && s.status !== 'exited' && s.activity === 'active').length;
  return working === 0 ? 'off' : working === 1 ? 'low' : 'high';
}
// How far a character's head may turn to look: STAGING.look, or less where
// the model's own `yard.look` extras (rig.py's --look) narrow it.
export function lookLimits(look) {
  const own = look || {};
  return { yaw: Math.min(STAGING.look.yaw, own.yaw ?? Infinity), pitch: Math.min(STAGING.look.pitch, own.pitch ?? Infinity), neck: STAGING.look.neck };
}
// Whom a resting or pausing character looks at: the selected session when
// it is within range, otherwise the nearest other within range (by id on a
// tie), or null. places is stage()'s.
export function lookTarget(sessionId, places, selected = null) {
  const me = places.get(sessionId);
  if (!me || (me.mode !== 'rest' && me.mode !== 'pause')) return null;
  let best = null, bestDistance = Infinity;
  for (const [id, p] of places) {
    if (id === sessionId) continue;
    const d = Math.hypot(p.x - me.x, p.z - me.z);
    if (d > STAGING.look.range) continue;
    if (id === selected) return id;
    if (d < bestDistance - 1e-9 || (Math.abs(d - bestDistance) <= 1e-9 && id < best)) { best = id; bestDistance = d; }
  }
  return best;
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
export const VIBE = {
  // Must stay inside the ground every world keeps clear (Clearance.live_distance in agent-guild-builders).
  roam: { radius: 13.2, half: 12.5, front: 30.5, split: 3, margin: .9, edge: 1.2, head: 2.4 },
  flight: { height: [8.5, 12], lap: [26, 44], reach: [.45, 1], scale: 1.3, top: 2 },
};
export function vibeFrame(aspect, top = 0, bottom = 0) {
  const { target, zoom } = overviewFor(aspect), height = CAMERA.height / zoom, width = height * aspect, { edge } = VIBE.roam;
  return { target, right: [edge - width / 2, width / 2 - edge], up: [(bottom - .5) * height + edge, (.5 - top) * height - edge] };
}
export function inVibeFrame(frame, x, y, z) {
  const { right, up } = viewBasis(), d = [x - frame.target[0], y - frame.target[1], z - frame.target[2]];
  const r = dot(d, right), u = dot(d, up);
  return r >= frame.right[0] && r <= frame.right[1] && u >= frame.up[0] && u <= frame.up[1];
}
function unit(value) {
  let h = hash(value);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b); h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// Clip the visible ground polygon to an axis-aligned interval. Destination
// geometry only: this neither builds nor checks a route.
function vibeClip(points, axis, low, high) {
  for (const [edge, sign] of [[low, 1], [high, -1]]) {
    const next = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length], da = sign * (a[axis] - edge), db = sign * (b[axis] - edge);
      if (da >= 0) next.push(a);
      if ((da < 0) !== (db < 0)) { const t = da / (da - db); next.push({ x: a.x + t * (b.x - a.x), z: a.z + t * (b.z - a.z) }); }
    }
    points = next;
  }
  return points;
}
// A missed sample is not an empty view. Obstacle x edges divide the ground
// into at most 2B+1 bands, each with at most B+1 free z intervals. Check those
// finite regions, not a grid whose spacing could miss a narrow opening.
function vibeGap(polygon, boxes, near, far, seed) {
  const { radius, half, front } = VIBE.roam;
  polygon = vibeClip(vibeClip(polygon, 'x', -radius, radius), 'z', near, far);
  const point = points => {
    if (points.length < 3) return null;
    const area = points.reduce((sum, a, i) => { const b = points[(i + 1) % points.length]; return sum + a.x * b.z - b.x * a.z; }, 0);
    if (Math.abs(area) < 1e-10) return null;
    const center = { x: 0, z: 0 };
    for (const p of points) { center.x += p.x / points.length; center.z += p.z / points.length; }
    const p = points[Math.floor(seed * points.length)], t = .25 + seed / 2;
    return { x: center.x + (p.x - center.x) * t, z: center.z + (p.z - center.z) * t };
  };
  const ground = points => {
    const p = point(points);
    if (!p) return null;
    if (Math.hypot(p.x, p.z) < radius || (Math.abs(p.x) <= half && p.z >= 0 && p.z <= front)) return p;
    const apron = point(vibeClip(vibeClip(points, 'x', -half, half), 'z', 0, front));
    if (apron) return apron;
    // The plaza's obstacle excludes the circle's centre from every free
    // region, so its nearest point is on an edge. Move from it into the
    // polygon, staying inside the circle even for a small circular sliver.
    let nearest = null, distance = Infinity;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length], dx = b.x - a.x, dz = b.z - a.z;
      const t = clamp(-(a.x * dx + a.z * dz) / (dx * dx + dz * dz || 1), 0, 1), q = { x: a.x + t * dx, z: a.z + t * dz }, d = Math.hypot(q.x, q.z);
      if (d < distance) { nearest = q; distance = d; }
    }
    if (distance >= radius) return null;
    const t = Math.min(.5, (radius - distance) / (2 * Math.hypot(p.x - nearest.x, p.z - nearest.z)));
    return { x: nearest.x + t * (p.x - nearest.x), z: nearest.z + t * (p.z - nearest.z) };
  };
  if (!point(polygon)) return null;
  const left = Math.min(...polygon.map(p => p.x)), right = Math.max(...polygon.map(p => p.x));
  const edges = [...new Set([left, right, ...boxes.flatMap(b => [b.x - b.half, b.x + b.half]).filter(x => x > left && x < right)])].sort((a, b) => a - b);
  const start = Math.floor(seed * (edges.length - 1));
  for (let i = 0; i < edges.length - 1; i++) {
    const k = (start + i) % (edges.length - 1), lo = edges[k], hi = edges[k + 1], x = (lo + hi) / 2;
    const blocked = boxes.filter(b => Math.abs(x - b.x) < b.half).map(b => [b.z - b.half, b.z + b.half]).sort((a, b) => a[0] - b[0]);
    let z = near;
    for (const [low, high] of [...blocked, [far, far]]) {
      if (low > z) {
        const p = ground(vibeClip(vibeClip(polygon, 'x', lo, hi), 'z', z, Math.min(low, far)));
        if (p) return p;
      }
      z = Math.max(z, high);
      if (z >= far) break;
    }
  }
  return null;
}
export function vibeStop(id, n, providers, props = [], frame = null) {
  const { radius, half, front, split, margin, head } = VIBE.roam;
  const [near, far] = (n + hash(id)) % 2 ? [split, front] : [-radius, split];
  const boxes = [...obstacles(providers).map(box => ({ ...box, half: box.half + margin })),
    ...props.map(p => ({ x: p.x, z: p.z, half: STAGING.station.half + margin }))];
  const clear = (x, z) => (Math.hypot(x - STAGING.plaza.x, z - STAGING.plaza.z) <= radius || (Math.abs(x) <= half && z >= 0 && z <= front))
    && !boxes.some(box => Math.abs(x - box.x) < box.half && Math.abs(z - box.z) < box.half);
  if (frame) {
    const { right, up, forward } = viewBasis(), [r0, r1] = frame.right, u0 = frame.up[0], u1 = frame.up[1] - head * up[1];
    const at = (r, u) => {
      const s = (-frame.target[1] - u * up[1]) / forward[1];
      return { x: frame.target[0] + r * right[0] + u * up[0] + s * forward[0], z: frame.target[2] + r * right[2] + u * up[2] + s * forward[2] };
    };
    if (r1 > r0 && u1 > u0) {
      const polygon = [at(r0, u0), at(r1, u0), at(r1, u1), at(r0, u1)];
      for (const [low, high] of [[near, far], near === split ? [-radius, split] : [split, front]]) {
        for (let k = 0; k < 48; k++) {
          const p = at(r0 + unit(id + ':vibe:x:' + n + ':' + k) * (r1 - r0), u0 + unit(id + ':vibe:z:' + n + ':' + k) * (u1 - u0));
          const x = round(p.x), z = round(p.z);
          if (z >= low && z <= high && clear(x, z) && inVibeFrame(frame, x, 0, z) && inVibeFrame(frame, x, head, z)) return { x, z };
        }
        const p = vibeGap(polygon, boxes, low, high, unit(id + ':vibe:gap:' + n));
        if (p) return p;
      }
    }
  }
  // No usable visible ground (or no frame): keep the original seeded walk.
  // Never turn a crowded/covered view into a stationary, repeatedly retried unit.
  for (let k = 0; k < 48; k++) {
    const x = round((unit(id + ':vibe:x:' + n + ':' + k) * 2 - 1) * radius), z = round(near + unit(id + ':vibe:z:' + n + ':' + k) * (far - near));
    if (clear(x, z)) return { x, z };
  }
  return { x: STAGING.plaza.x, z: round(STAGING.plaza.z + STAGING.plaza.half + margin + STAGING.station.half) };
}
export function vibeFlight(key, seconds, frame, companionHeight = 1) {
  const { height, lap, reach, top, scale } = VIBE.flight, { right, up, forward } = viewBasis();
  const pick = (name, [low, high]) => low + unit(key + ':vibe:' + name) * (high - low);
  const out = pick('reach', reach), turn = unit(key + ':vibe:turn') < .5 ? 1 : -1, lobes = 2 + Math.floor(unit(key + ':vibe:lobes') * 3);
  const angle = turn * 2 * Math.PI * (seconds / pick('lap', lap) + unit(key + ':vibe:start'));
  const wide = out * (1 + .12 * Math.sin(lobes * angle + pick('phase', [0, 2 * Math.PI]))) / 1.12;
  const y = (height[0] + height[1]) / 2 + (height[1] - height[0]) / 2 * Math.sin(2 * angle + pick('rise', [0, 2 * Math.PI]));
  const [r0, r1] = frame.right, u0 = frame.up[0], u1 = frame.up[1] - Math.max(top, companionHeight * scale * up[1]);
  const r = (r0 + r1) / 2 + Math.cos(angle) * Math.max(0, r1 - r0) / 2 * wide;
  const u = (u0 + u1) / 2 + Math.sin(angle) * Math.max(0, u1 - u0) / 2 * wide;
  const s = (y - frame.target[1] - u * up[1]) / forward[1];
  return { x: frame.target[0] + r * right[0] + u * up[0] + s * forward[0], y, z: frame.target[2] + r * right[2] + u * up[2] + s * forward[2] };
}
// Where a session's helpers stand, around it, as the renderer has always placed them.
export function helperOffset(i, count) {
  const angle = (i / Math.min(count, 6)) * Math.PI * 2;
  return { x: round(Math.cos(angle) * .82), z: round(Math.sin(angle) * .72) };
}
// A picture of the stage: twice its size, within what every browser can
// encode, drawn in tiles no larger than the live drawing buffer.
export const PHOTO = { scale: 2, edge: 4096, area: 16777216 };
export function photoSize(w, h, bufferW, bufferH) {
  const scale = Math.min(PHOTO.scale, PHOTO.edge / Math.max(w, h), Math.sqrt(PHOTO.area / (w * h)));
  const width = Math.floor(w * scale), height = Math.floor(h * scale), tiles = [];
  for (let y = 0; y < height; y += bufferH) for (let x = 0; x < width; x += bufferW) tiles.push({ x, y });
  return { width, height, scale: width / w, tiles };
}
export function photoName(title, date) {
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(n => String(n).padStart(2, '0')).join('-');
  return 'agent-guild-' + title.toLowerCase().replace(/^the /, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + day + '.png';
}
