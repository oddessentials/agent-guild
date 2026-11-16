// Cuts the head wings out of the Winged Orbital Hacker (the Mount Olympus
// theme's Shell piece) into web/yard/assets/hermes_wings.glb, the wings the
// Yard fits to the head of Hermes Agent's character in every world:
//   node concept-art/hermes-yard/wings.mjs <winged-hacker/character.glb>
// The wings keep the positions they had on the hacker, in its bind pose, and
// the file records that head's bounds (extras.head) so the Yard can fit them
// to another head. The trim takes Hermes Agent's blue.
import { NodeIO, Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { fileURLToPath } from 'node:url';

const source = process.argv[2];
if (!source) throw new Error('Usage: node concept-art/hermes-yard/wings.mjs <winged-hacker/character.glb>');
const out = fileURLToPath(new URL('../../web/yard/assets/hermes_wings.glb', import.meta.url));
const COLORS = { hermes_white: [0.893, 0.873, 0.813], hermes_trim: [0, 0, 0.887] }; // #0000f2, linear
const HEAD_WEIGHT = 0.5;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(source);
const root = doc.getRoot();
const node = root.listNodes().find((n) => n.getMesh() && n.getSkin());
const skin = node.getSkin();
const head = skin.listJoints().findIndex((joint) => joint.getName() === 'Head');
if (head < 0) throw new Error('The character has no Head bone.');
const world = node.getWorldMatrix();
const apply = (m, [x, y, z], w = 1) => [
  m[0] * x + m[4] * y + m[8] * z + m[12] * w,
  m[1] * x + m[5] * y + m[9] * z + m[13] * w,
  m[2] * x + m[6] * y + m[10] * z + m[14] * w,
];
// The share of a vertex that follows the head.
const onHead = (prim, i) => {
  const joints = prim.getAttribute('JOINTS_0').getElement(i, []), weights = prim.getAttribute('WEIGHTS_0').getElement(i, []);
  return joints.reduce((sum, joint, k) => sum + (joint === head ? weights[k] : 0), 0);
};

const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
const wings = [];
for (const prim of node.getMesh().listPrimitives()) {
  const name = prim.getMaterial()?.getName();
  const position = prim.getAttribute('POSITION');
  if (name in COLORS) {
    // Only wings that ride on the head; the ankle wings stay behind.
    if (onHead(prim, 0) >= HEAD_WEIGHT) wings.push({ prim, name });
    continue;
  }
  for (let i = 0; i < position.getCount(); i++) {
    if (onHead(prim, i) < HEAD_WEIGHT) continue;
    const p = apply(world, position.getElement(i, []));
    for (let k = 0; k < 3; k++) { box.min[k] = Math.min(box.min[k], p[k]); box.max[k] = Math.max(box.max[k], p[k]); }
  }
}
if (!wings.length) throw new Error('No head wings found.');

const outDoc = new Document();
const buffer = outDoc.createBuffer();
const materials = {};
for (const [name, color] of Object.entries(COLORS)) {
  materials[name] = outDoc.createMaterial(name).setBaseColorFactor([...color, 1]).setMetallicFactor(0)
    .setRoughnessFactor(name === 'hermes_trim' ? 0.5 : 0.75).setDoubleSided(true);
}
// One anchor for each side, an empty node placed at the wing's root (its point
// nearest the head's middle, at its own height and depth) so the Yard and the
// Professional render can move the root and scale the wing about it. The
// geometry hangs from the anchor on a child node, as each hall's does: the
// Yard optimizer rewrites a mesh node's transform when it quantizes it, and
// leaves the anchor as it is.
const wingRoot = outDoc.createNode('hermes_wings').setExtras({ head: box });
const mid = box.min.map((v, k) => (v + box.max[k]) / 2);
for (const side of [1, -1]) {
  const parts = wings.filter(({ prim }) => Math.sign(apply(world, prim.getAttribute('POSITION').getElement(0, []))[0] - mid[0]) === side);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const { prim } of parts) {
    const position = prim.getAttribute('POSITION');
    for (let i = 0; i < position.getCount(); i++) apply(world, position.getElement(i, [])).forEach((v, k) => { lo[k] = Math.min(lo[k], v); hi[k] = Math.max(hi[k], v); });
  }
  const anchor = [side > 0 ? lo[0] : hi[0], (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const mesh = outDoc.createMesh(side > 0 ? 'wing_left' : 'wing_right');
  for (const { prim, name } of parts) {
    const copy = (attribute, map) => {
      const array = new Float32Array(attribute.getCount() * 3);
      for (let i = 0; i < attribute.getCount(); i++) array.set(map(attribute.getElement(i, [])), i * 3);
      return outDoc.createAccessor().setType('VEC3').setArray(array).setBuffer(buffer);
    };
    const out = outDoc.createPrimitive().setMaterial(materials[name])
      .setAttribute('POSITION', copy(prim.getAttribute('POSITION'), (p) => apply(world, p).map((v, k) => v - anchor[k])));
    const normal = prim.getAttribute('NORMAL');
    if (normal) out.setAttribute('NORMAL', copy(normal, (n) => { const v = apply(world, n, 0), l = Math.hypot(...v) || 1; return v.map((c) => c / l); }));
    const indices = prim.getIndices();
    if (indices) out.setIndices(outDoc.createAccessor().setType('SCALAR').setArray(new Uint32Array(indices.getArray())).setBuffer(buffer));
    mesh.addPrimitive(out);
  }
  wingRoot.addChild(outDoc.createNode(mesh.getName()).setTranslation(anchor).addChild(outDoc.createNode(mesh.getName() + '_mesh').setMesh(mesh)));
}
outDoc.createScene('hermes_wings').addChild(wingRoot);
await io.write(out, outDoc);
console.log(`${wings.length} wing parts; head ${box.min.map((v) => v.toFixed(3))} to ${box.max.map((v) => v.toFixed(3))}; wrote ${out}`);
