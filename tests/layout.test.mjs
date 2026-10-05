import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topbarInline, dockMode, clampDockWidth, stageBesideDock, splitMode, clampRatio, bindSplitter, bindVisibleViewport, DOCK_DEFAULT, DOCK_MIN, DOCK_MAX, WORKSPACE_MIN } from '../web/layout.js';
import { bindTerminalViewport } from '../web/terminal-controls.js';

test('the top bar keeps its controls inline only where they fit on one row', () => {
  assert.equal(topbarInline(1440), true);
  assert.equal(topbarInline(900), true);
  assert.equal(topbarInline(899), false);
  assert.equal(topbarInline(390), false);
});

test('the dock takes room only on wide windows, lies over the workspace on mid-size ones and covers phones', () => {
  assert.equal(dockMode(1920), 'push');
  assert.equal(dockMode(1280), 'push');
  assert.equal(dockMode(1279), 'over');
  assert.equal(dockMode(640), 'over');
  assert.equal(dockMode(639), 'full');
  assert.equal(dockMode(360), 'full');
});

test('the dock width stays usable and always leaves the workspace its share', () => {
  assert.equal(clampDockWidth(Number.NaN, 1920), DOCK_DEFAULT, 'no saved width');
  assert.equal(clampDockWidth(100, 1920), DOCK_MIN);
  assert.equal(clampDockWidth(5000, 1920), DOCK_MAX);
  assert.equal(clampDockWidth(700, 1100), 1100 - WORKSPACE_MIN);
  assert.equal(clampDockWidth(700, 700), DOCK_MIN, 'never narrower than its minimum, even when the window is');
  assert.equal(clampDockWidth(Infinity, 1920), DOCK_MAX);
});

test('the terminals make room for the dock while they keep a usable width', () => {
  assert.equal(stageBesideDock(1440, 420), true);
  assert.equal(stageBesideDock(1100, 420), true, 'mid-size: the cards stay under the dock, the terminals move aside');
  assert.equal(stageBesideDock(960, 420), false);
  assert.equal(stageBesideDock(960, 320), true);
  assert.equal(stageBesideDock(600, 320), false, 'a phone dock covers everything');
});

test('two terminals sit side by side on a wide stage, stacked on a tall one, and not at all on a small one', () => {
  assert.equal(splitMode(1400, 700), 'columns');
  assert.equal(splitMode(1000, 400), 'columns');
  assert.equal(splitMode(900, 800), 'rows');
  assert.equal(splitMode(560, 620), 'rows');
  assert.equal(splitMode(900, 600), null);
  assert.equal(splitMode(390, 780), null);
});

test('neither terminal of a split shrinks below a quarter of the stage', () => {
  assert.equal(clampRatio(Number.NaN), 0.5);
  assert.equal(clampRatio(0.1), 0.25);
  assert.equal(clampRatio(0.9), 0.75);
  assert.equal(clampRatio(0.6), 0.6);
});

function fakeHandle() {
  const listeners = new Map();
  const classes = new Set();
  return {
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
    classes,
    setPointerCapture() {},
    addEventListener: (type, fn) => listeners.set(type, fn),
    fire: (type, event) => listeners.get(type)({ preventDefault() {}, ...event }),
  };
}

test('a splitter reports pointer travel from where the drag began and ends once', () => {
  const handle = fakeHandle();
  const moves = [];
  let ends = 0;
  bindSplitter(handle, { start: () => 400, move: (delta, from) => moves.push([delta, from]), end: () => ends++ });
  handle.fire('pointerdown', { button: 0, pointerId: 1, clientX: 100 });
  assert.ok(handle.classes.has('dragging'));
  handle.fire('pointermove', { pointerId: 1, clientX: 80 });
  handle.fire('pointermove', { pointerId: 2, clientX: 0 });
  handle.fire('pointermove', { pointerId: 1, clientX: 60 });
  handle.fire('pointerup', { pointerId: 1 });
  handle.fire('lostpointercapture', { pointerId: 1 });
  assert.deepEqual(moves, [[-20, 400], [-40, 400]], 'another pointer does not move it');
  assert.equal(ends, 1);
  assert.equal(handle.classes.has('dragging'), false);
  handle.fire('pointerdown', { button: 2, pointerId: 3, clientX: 0 });
  handle.fire('pointermove', { pointerId: 3, clientX: 50 });
  assert.equal(moves.length, 2, 'a right-button press does not start a drag');
});

test('a splitter moves with the arrow keys along its axis and jumps with Home and End', () => {
  const handle = fakeHandle();
  const moves = [];
  const jumps = [];
  let axis = 'x';
  let ends = 0;
  bindSplitter(handle, { axis: () => axis, start: () => 0.5, move: (delta) => moves.push(delta), end: () => ends++, step: 10, home: () => jumps.push('home'), endKey: () => jumps.push('end') });
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Home', 'End', 'a']) handle.fire('keydown', { key });
  axis = 'y';
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft']) handle.fire('keydown', { key });
  assert.deepEqual(moves, [-10, 10, -10, 10]);
  assert.deepEqual(jumps, ['home', 'end']);
  assert.equal(ends, 6);
});

// A phone page: an 800px window whose keyboard, page panning and zoom the test controls, frame by frame.
function fakePage(t) {
  const listeners = { window: {}, viewport: {} };
  const on = (target) => (type, fn) => { (listeners[target][type] ||= []).push(fn); };
  const viewport = { height: 800, offsetTop: 0, scale: 1, addEventListener: on('viewport') };
  const frames = new Map();
  let nextFrame = 0;
  const observers = [];
  const saved = Object.fromEntries(['window', 'innerHeight', 'addEventListener', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, {
    window: { visualViewport: viewport },
    innerHeight: 800,
    addEventListener: on('window'),
    requestAnimationFrame: (fn) => { frames.set(++nextFrame, fn); return nextFrame; },
    cancelAnimationFrame: (id) => frames.delete(id),
    MutationObserver: class {
      constructor(fn) { this.fn = fn; observers.push(this); }
      observe(target) { (this.targets ||= []).push(target); }
    },
  });
  t.after(() => {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const element = () => {
    const props = new Map();
    const attributes = new Set();
    // As in the DOM, dataset.name is the data-name attribute.
    const dataset = new Proxy({}, {
      get: (_, key) => (attributes.has(`data-${String(key)}`) ? '' : undefined),
      deleteProperty: (_, key) => attributes.delete(`data-${String(key)}`) || true,
    });
    return {
      hidden: false, props, attributes, dataset,
      style: { setProperty: (name, value) => props.set(name, value), removeProperty: (name) => props.delete(name) },
      toggleAttribute: (name, on) => (on ? attributes.add(name) : attributes.delete(name)),
    };
  };
  return {
    viewport, element,
    fire: (target, type) => { for (const fn of listeners[target][type] || []) fn(); },
    hide: (el, hidden) => {
      el.hidden = hidden;
      for (const observer of observers) if (observer.targets.includes(el)) observer.fn();
    },
    // Runs the frames requested so far; returns how many ran.
    frame: () => {
      const queued = [...frames.values()];
      frames.clear();
      for (const fn of queued) fn();
      return queued.length;
    },
  };
}

const edges = (el, name) => ['top', 'bottom', 'height'].map((edge) => el.props.get(`--${name}-viewport-${edge}`) ?? null);

test('a fixed panel follows the part of the page an on-screen keyboard leaves visible', (t) => {
  const page = fakePage(t);
  const dock = page.element();
  const fitted = [];
  bindVisibleViewport(dock, 'dock', { fitted: (height) => fitted.push(height) });
  assert.equal(page.frame(), 1);
  assert.deepEqual(edges(dock, 'dock'), ['0px', '0px', '800px'], 'no keyboard: the whole window');

  // The keyboard opens: Safari shrinks the visual viewport and keeps the layout viewport.
  page.viewport.height = 367;
  page.fire('viewport', 'resize');
  page.fire('viewport', 'resize');
  assert.equal(page.frame(), 1, 'one update per frame however many events arrive');
  assert.deepEqual(edges(dock, 'dock'), ['0px', '433px', '367px'], 'the panel ends where the keyboard starts');

  // Safari pans the page to show the focused field.
  page.viewport.offsetTop = 120;
  page.fire('viewport', 'scroll');
  page.frame();
  assert.deepEqual(edges(dock, 'dock'), ['120px', '313px', '367px'], 'the panel moves with the panned page');

  // Pinch zoom belongs to the browser and leaves the panel as it was.
  page.viewport.scale = 2;
  page.viewport.height = 200;
  page.fire('viewport', 'resize');
  page.frame();
  assert.deepEqual(edges(dock, 'dock'), ['120px', '313px', '367px']);
  assert.deepEqual(fitted, [800, 367, 367]);

  // The keyboard closes.
  Object.assign(page.viewport, { scale: 1, height: 800, offsetTop: 0 });
  page.fire('window', 'resize');
  page.frame();
  assert.deepEqual(edges(dock, 'dock'), ['0px', '0px', '800px']);

  page.hide(dock, true);
  page.frame();
  assert.deepEqual(edges(dock, 'dock'), [null, null, null], 'a hidden panel leaves the page layout alone');
  assert.equal(fitted.at(-1), null);
});

test('the terminal panel turns compact above a keyboard and back when it closes', (t) => {
  const page = fakePage(t);
  const panel = page.element();
  const controls = page.element();
  bindTerminalViewport(panel, controls);
  page.frame();
  assert.equal(panel.props.get('--terminal-viewport-bottom'), '0px');
  assert.equal(panel.attributes.has('data-compact'), false);

  page.viewport.height = 367;
  page.fire('viewport', 'resize');
  page.frame();
  assert.equal(panel.attributes.has('data-compact'), true);
  assert.equal(panel.props.get('--terminal-viewport-bottom'), '433px');

  page.hide(controls, true);
  page.frame();
  assert.deepEqual(edges(panel, 'terminal').slice(0, 2), [null, null], 'without touch keys the panel keeps its usual place');
  assert.equal(panel.attributes.has('data-compact'), false);
});
