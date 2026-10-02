// Presentation only: never changes or infers manager state.
export const PROVIDER_ORDER = ['anthropic', 'openai', 'google', 'xai', 'shell'];
export const WORLDS = {
  guild: { title: 'The Guild Yard', subtitle: 'A place for every great endeavour', asset: 'guild', characters: true },
  orbital: { title: 'Orbital Station', subtitle: 'Your crew, at the edge of possibility', asset: 'orbital', characters: true },
  grove: { title: 'The Living Grove', subtitle: 'Good work takes root here', asset: 'grove', characters: true },
  professional: { title: 'Operations Campus', subtitle: 'A clear view of work in progress', asset: 'professional', characters: false },
};
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
    entry.x=origin.x+((entry.slot%4)-1.5)*1.25;
    entry.z=origin.z+3.25+Math.floor(entry.slot/4)*1.6;
  }
  return result;
}
