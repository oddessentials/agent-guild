import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityFavicon, isSessionWorking } from '../web/activity-favicon.js';

function fixture({ reduced = false, canvasFails = false, missingLink = false } = {}) {
  const timers = new Map(), listeners = new Map();
  let time = 0, sequence = 0, image, encodings = 0;
  const link = { href: 'https://example.test/agent-guild/brand/favicon.png' };
  const original = link.href;
  const reducedMotion = { matches: reduced, addEventListener: (type, fn) => listeners.set(type, fn) };
  const context = { clearRect() {}, drawImage() {}, beginPath() {}, arc() {}, stroke() {} };
  const controller = createActivityFavicon({
    link: missingLink ? null : link, reducedMotion,
    Image: class { constructor() { image = this; } },
    document: { createElement: () => ({
      getContext: () => canvasFails ? null : context,
      toDataURL: () => `data:image/png;base64,frame${encodings++}`,
    }) },
    setTimer: (fn) => { const id = ++sequence; timers.set(id, fn); return id; },
    clearTimer: (id) => timers.delete(id), now: () => time,
  });
  return {
    controller, link, original, timers, image,
    encodings: () => encodings,
    load: () => image.onload(),
    motion(value) { reducedMotion.matches = value; listeners.get('change')(); },
    tick(ms = 200) {
      time += ms;
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach((fn) => fn());
    },
  };
}

test('working has exactly the card meaning for every provider and task, independent of subagents', () => {
  for (const provider of ['anthropic', 'openai', 'google', 'xai', 'shell', 'github', 'agent-guild', 'custom']) {
    for (const task of [null, 'install', 'upgrade', 'clone']) {
      for (const status of ['running', 'exited']) {
        for (const activity of ['active', 'quiet']) {
          const session = { provider: { id: provider }, task, status, activity, agents: [{ status: 'working' }], shells: [{}] };
          assert.equal(isSessionWorking(session), status === 'running' && activity === 'active');
        }
      }
    }
  }
});

test('animation uses one timer, cached frames, and restores the original path immediately', () => {
  const f = fixture();
  assert.equal(f.image.src, f.original, 'the existing icon URL works below a project subpath');
  f.load();
  assert.equal(f.link.href, f.original);
  assert.equal(f.timers.size, 0);
  f.controller.setWorking(true);
  const first = f.link.href;
  assert.notEqual(first, f.original);
  for (let n = 0; n < 20; n++) f.controller.setWorking(true);
  assert.equal(f.timers.size, 1, 'repeated session updates never multiply animation loops');
  f.tick();
  assert.notEqual(f.link.href, first);
  const encodings = f.encodings();
  f.tick(120000);
  assert.equal(f.encodings(), encodings, 'no image encoding on animation ticks, including after throttling');
  assert.equal(f.timers.size, 1);
  f.controller.setWorking(false);
  assert.equal(f.link.href, f.original);
  assert.equal(f.timers.size, 0);
  f.tick();
  assert.equal(f.link.href, f.original);
});

test('loading the image late uses the latest state and cannot resurrect completed work', () => {
  const f = fixture();
  f.controller.setWorking(true);
  f.controller.setWorking(false);
  f.load();
  assert.equal(f.link.href, f.original);
  assert.equal(f.timers.size, 0);
  const active = fixture();
  active.controller.setWorking(true);
  active.load();
  assert.notEqual(active.link.href, active.original);
  assert.equal(active.timers.size, 1);
});

test('reduced motion stays visibly working and updates immediately when the preference changes', () => {
  const f = fixture({ reduced: true });
  f.controller.setWorking(true);
  f.load();
  const still = f.link.href;
  assert.notEqual(still, f.original);
  assert.equal(f.timers.size, 0);
  f.motion(false);
  assert.equal(f.timers.size, 1);
  f.tick();
  assert.notEqual(f.link.href, still);
  f.motion(true);
  assert.equal(f.link.href, still);
  assert.equal(f.timers.size, 0);
  f.controller.setWorking(false);
  assert.equal(f.link.href, f.original);
});

test('page departure pauses animation, restoration resumes, and stopped work stays stopped', () => {
  const f = fixture();
  f.load();
  f.controller.setWorking(true);
  f.controller.setPaused(true);
  assert.equal(f.timers.size, 0);
  assert.notEqual(f.link.href, f.original, 'a paused frame still communicates working');
  f.controller.setPaused(false);
  assert.equal(f.timers.size, 1);
  f.controller.setPaused(true);
  f.controller.setWorking(false);
  f.controller.setPaused(false);
  assert.equal(f.link.href, f.original);
  assert.equal(f.timers.size, 0);
});

test('unavailable image or canvas leaves the original icon and no animation timer', () => {
  for (const options of [{}, { canvasFails: true }, { missingLink: true }]) {
    const f = fixture(options);
    f.controller.setWorking(true);
    if (options.canvasFails) f.load();
    else f.image?.onerror();
    f.motion(true);
    f.controller.setPaused(true);
    assert.equal(f.link.href, f.original);
    assert.equal(f.timers.size, 0);
  }
});
