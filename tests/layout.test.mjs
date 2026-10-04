import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topbarInline, dockMode, clampDockWidth, stageBesideDock, splitMode, clampRatio, bindSplitter, DOCK_DEFAULT, DOCK_MIN, DOCK_MAX, WORKSPACE_MIN } from '../web/layout.js';

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
