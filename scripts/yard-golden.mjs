// Writes the golden vectors that pin the Yard's staging contract
// (docs/yard/CONTRACT.md). Every Yard client must reproduce them exactly.
//   node scripts/yard-golden.mjs          print them
//   node scripts/yard-golden.mjs --write  update tests/fixtures/yard-choreography.json
import { writeFileSync } from 'node:fs';
import { stage, restSpots, route, clipFor, doorFor, arrives, nextStagingChange, hash, PROVIDER_ORDER } from '../web/yard/model.mjs';

export function goldenVectors() {
  const providers = [...PROVIDER_ORDER, 'custom-1'].map(id => ({ id }));
  const now = Date.parse('2026-10-13T12:00:00.000Z');
  const at = seconds => new Date(now - seconds * 1000).toISOString();
  const kinds = [
    ['running', 'active', 2], ['running', 'quiet', 5], ['running', 'quiet', 25], ['exited', 'quiet', 600],
    ['running', 'quiet', 19.999], ['running', 'quiet', 20], ['running', 'active', 300],
  ];
  const sessions = [];
  for (const [p, provider] of [...PROVIDER_ORDER, 'custom-1', 'github'].entries())
    for (let i = 0; i < 4; i++) {
      const [status, activity, quiet] = kinds[(p + i) % kinds.length];
      sessions.push({ id: provider + '-' + i, provider: { id: provider }, status, activity,
        createdAt: new Date(Date.parse('2026-10-13T08:00:00.000Z') + (p * 4 + i) * 60000).toISOString(), lastOutputAt: at(quiet) });
    }
  const first = stage(sessions, providers, now);
  // A rested session goes back to work and another joins: the rest keep their spots.
  const later = sessions.map(s => s.id === 'anthropic-2' ? { ...s, activity: 'active', lastOutputAt: at(0) } : s);
  later.push({ id: 'late-0', provider: { id: 'shell' }, status: 'running', activity: 'quiet', createdAt: '2026-10-13T11:00:00.000Z', lastOutputAt: at(40) });
  const second = stage(later, providers, now + 1000, first);
  const places = result => Object.fromEntries([...result.places].map(([id, p]) => [id, p]));
  return {
    providers: providers.map(p => p.id),
    now: new Date(now).toISOString(),
    hash: Object.fromEntries(['', 'a', 'anthropic-0', 'Monitor', 'ünïcode', 'x'.repeat(40)].map(v => [v, hash(v)])),
    restSpots: restSpots(providers),
    sessions,
    places: places(first),
    nextChange: new Date(nextStagingChange(sessions, now)).toISOString(),
    after: { sessions: later, now: new Date(now + 1000).toISOString(), places: places(second) },
    arrives: [0, 14999, 15000, 600000].map(ms => arrives({ createdAt: new Date(now - ms).toISOString() }, now)),
    doors: Object.fromEntries(['anthropic', 'docker', 'custom-1', 'github'].map(id => [id, doorFor({ provider: { id } }, providers)])),
    routes: [
      [{ x: -7, z: -1.75 }, { x: 7, z: -1.75 }],
      [{ x: 0, z: -3.75 }, { x: 0, z: 4.8 }],
      [{ x: -10, z: 14.4 }, { x: 8, z: 6.25 }],
      [{ x: -7, z: -2.1 }, { x: 4, z: -9 }],
      [{ x: 0, z: -10.5 }, { x: 0, z: 3 }],
    ].map(([a, b]) => ({ from: a, to: b, path: route(a, b, providers) })),
    clips: Object.fromEntries(['anthropic-0', 'openai-3'].flatMap(id => ['work', 'pause', 'rest', 'done']
      .map(mode => [id + ':' + mode, Array.from({ length: 12 }, (_, n) => clipFor(id, mode, n))]))),
  };
}
if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const text = JSON.stringify(goldenVectors(), null, 1) + '\n';
  if (process.argv.includes('--write')) writeFileSync(new URL('../tests/fixtures/yard-choreography.json', import.meta.url), text);
  else process.stdout.write(text);
}
