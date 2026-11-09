import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { YardPieces } from '../src/manager/yard-pieces.mjs';
import { createFolderBrowser } from '../src/manager/folder-browser.mjs';
import { createManagerServer } from '../src/manager/server.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/pieces/', import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, `${name}.glb`));

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-pieces-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let made = 0;
  const folder = ({ kind = 'character', title = 'Patchwork', models, manifest, name = `piece-${++made}` } = {}) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'piece.json'), manifest ?? JSON.stringify({ format: 1, kind, world: 'guild', crew: 'anthropic', title }));
    const files = models ?? (kind === 'character' ? { 'character.glb': fixture('character') } : Object.fromEntries([0, 1, 2, 3].map((n) => [`companion_${n}.glb`, fixture('companion')])));
    for (const [file, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), bytes);
    return dir;
  };
  return { root, folder, dir: path.join(root, 'pieces') };
}

const refused = (reason) => ({ status: 400, code: 'piece_invalid', message: reason });

test('a character and a companion replace one Yard’s slots, survive a restart and restore', async (t) => {
  const { folder, dir } = setup(t);
  const pieces = new YardPieces({ dir });
  const events = [];
  pieces.on('updated', (state) => events.push(JSON.stringify(state)));
  const source = folder();
  const after = await pieces.replace('guild', 'anthropic', source);
  assert.equal(after.guild.anthropic.title, 'Patchwork');
  assert.match(after.guild.anthropic.revision, /^[0-9a-f]{16}$/);
  await pieces.replace('guild', 'companion', folder({ kind: 'companion', title: 'Moths' }));
  assert.deepEqual(Object.keys(pieces.snapshot()), ['guild'], 'other Yards keep their originals');
  assert.equal(pieces.file('guild', 'anthropic', 'character.glb'), path.join(dir, 'guild', 'anthropic', 'character.glb'));
  assert.equal(pieces.file('guild', 'companion', 'companion_3.glb'), path.join(dir, 'guild', 'companion', 'companion_3.glb'));
  for (const [skin, slot, name] of [['grove', 'anthropic', 'character.glb'], ['guild', 'openai', 'character.glb'], ['guild', 'anthropic', 'piece.json'], ['guild', 'anthropic', 'install.json'], ['guild', 'anthropic', 'companion_0.glb'], ['guild', 'companion', 'character.glb'], ['guild', 'constructor', 'character.glb']]) {
    assert.equal(pieces.file(skin, slot, name), null, `${skin}/${slot}/${name}`);
  }
  fs.rmSync(source, { recursive: true });
  const reopened = new YardPieces({ dir });
  assert.deepEqual(reopened.snapshot(), pieces.snapshot(), 'a piece no longer needs the folder it came from');
  await reopened.restore('guild', 'anthropic');
  assert.deepEqual(Object.keys(reopened.snapshot().guild), ['companion']);
  await reopened.restore('guild', 'companion');
  assert.deepEqual(reopened.snapshot(), {});
  assert.equal(events.length, 2);
  await assert.rejects(pieces.replace('nowhere', 'anthropic', folder()), { status: 404, code: 'unknown_yard' });
  await assert.rejects(pieces.replace('guild', 'toString', folder()), { status: 404, code: 'unknown_slot' });
});

test('a bad piece is refused with the reason and the slot keeps its working piece', async (t) => {
  const { root, folder, dir } = setup(t);
  const pieces = new YardPieces({ dir });
  const before = await pieces.replace('guild', 'shell', folder({ title: 'Before' }));
  const three = Object.fromEntries([0, 1, 2].map((n) => [`companion_${n}.glb`, fixture('companion')]));
  const cases = [
    ['a relative path', 'piece', /Choose a piece folder/],
    ['a file instead of a folder', path.join(folder(), 'piece.json'), /Choose a piece folder/],
    ['a missing folder', path.join(root, 'none'), /can’t be read/],
    ['no manifest', (() => { const dir = folder(); fs.rmSync(path.join(dir, 'piece.json')); return dir; })(), /piece\.json is missing/],
    ['unreadable details', folder({ manifest: '{' }), /details can’t be read/],
    ['a newer format', folder({ manifest: JSON.stringify({ format: 2, kind: 'character' }) }), /newer Agent Guild/],
    ['a companion for a character', folder({ kind: 'companion' }), /companion piece, not a character/],
    ['a long title', folder({ title: 'x'.repeat(129) }), /title/],
    ['a missing model', folder({ models: {} }), /character\.glb is missing/],
    ['a model that refers outside itself', folder({ models: { 'character.glb': fixture('external_uri') } }), /refers to files outside itself/],
    ['a missing bone', folder({ models: { 'character.glb': fixture('missing_bone') } }), /has no LeftFoot bone/],
    ['a missing animation', folder({ models: { 'character.glb': fixture('missing_clip') } }), /has no done animation/],
    ['a truncated model', folder({ models: { 'character.glb': fixture('truncated') } }), /isn’t a binary glTF model/],
    ['an oversized texture', folder({ models: { 'character.glb': fixture('texture_over') } }), /texture larger than 4096/],
    ['a model that needs KTX2', folder({ models: { 'character.glb': requiring(fixture('character'), 'KHR_texture_basisu') } }), /needs KHR_texture_basisu/],
  ];
  for (const [label, source, reason] of cases) {
    await assert.rejects(pieces.replace('guild', 'shell', source), refused(reason), label);
    assert.deepEqual(pieces.snapshot(), before, label);
  }
  await assert.rejects(pieces.replace('guild', 'companion', folder({ kind: 'companion', models: three })), refused(/companion_3\.glb is missing/));
  await assert.rejects(pieces.replace('guild', 'companion', folder({ kind: 'companion', models: { ...three, 'companion_3.glb': fixture('character') } })), refused(/companion_3\.glb has no idle animation/), 'one bad helper refuses the whole companion');
  assert.equal(pieces.snapshot().guild.companion, undefined);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('.')), [], 'nothing is left staged');
});

function requiring(glb, extension) {
  return variant(glb, json => { json.extensionsRequired = [...(json.extensionsRequired ?? []), extension]; });
}

function variant(glb, change) {
  const size = glb.readUInt32LE(12);
  const json = JSON.parse(glb.toString('utf8', 20, 20 + size));
  const rest = Buffer.from(glb.subarray(20 + size));
  change(json, rest.subarray(8));
  const text = Buffer.from(JSON.stringify(json));
  const padded = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const out = Buffer.concat([glb.subarray(0, 20), padded, rest]);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(padded.length, 12);
  return out;
}

test('unsafe extras, clip lengths and joint counts are refused before replacing a piece', async t => {
  const { folder, dir } = setup(t);
  const pieces = new YardPieces({ dir });
  await pieces.replace('guild', 'anthropic', folder());
  const before = JSON.stringify(pieces.snapshot());
  const extras = changes => json => Object.assign(json.nodes.find(n => n.extras?.yard).extras.yard, changes);
  const duration = seconds => (json, binary) => {
    for (const sampler of json.animations[0].samplers) {
      const accessor = json.accessors[sampler.input], view = json.bufferViews[accessor.bufferView];
      for (let i = 0; i < accessor.count; i++) binary.writeFloatLE(seconds * i / (accessor.count - 1), (view.byteOffset || 0) + (accessor.byteOffset || 0) + i * (view.byteStride || 4));
      accessor.min = [0]; accessor.max = [seconds];
    }
  };
  for (const [change, reason] of [
    [extras({ events: [null] }), /animation event/],
    [extras({ events: [{ clip: 'work_0', time: .2, at: [0, 'bad', 0] }] }), /animation event/],
    [extras({ events: {} }), /animation event array/],
    [extras({ look: { yaw: 'bad' } }), /yard look/],
    [extras({ stride: 1e300 }), /yard stride/],
    [extras({ cycle: .01 }), /yard cycle/],
    [extras({ height: 1e300 }), /yard height/],
    [extras({ surface: 1e300 }), /yard surface/],
    [duration(0), /animation .*more than 0/],
    [duration(61), /animation .*at most 60/],
    [json => { json.skins[0].joints = Array(129).fill(json.skins[0].joints[0]); }, /at most 128 joints/],
  ]) {
    const source = folder({ models: { 'character.glb': variant(fixture('character'), change) } });
    await assert.rejects(pieces.replace('guild', 'anthropic', source), refused(reason));
    assert.equal(JSON.stringify(pieces.snapshot()), before);
  }
  const models = Object.fromEntries([0, 1, 2, 3].map(n => [`companion_${n}.glb`, variant(fixture('companion'), extras({ height: 'bad' }))]));
  await assert.rejects(pieces.replace('guild', 'companion', folder({ kind: 'companion', models })), refused(/companion_0.glb.*yard height/));
});

function extended(glb, build) {
  const size = glb.readUInt32LE(12);
  const json = JSON.parse(glb.toString('utf8', 20, 20 + size));
  const binary = glb.subarray(20 + size + 8, 20 + size + 8 + glb.readUInt32LE(20 + size));
  const view = json.bufferViews.length;
  const [bytes, change] = build(json, binary, view);
  json.bufferViews.push({ buffer: 0, byteOffset: binary.length, byteLength: bytes.length });
  change();
  const data = Buffer.concat([binary, bytes, Buffer.alloc((4 - ((binary.length + bytes.length) % 4)) % 4)]);
  json.buffers[0].byteLength = data.length;
  const text = Buffer.from(JSON.stringify(json));
  const padded = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12), chunk = Buffer.alloc(8);
  head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + padded.length + 8 + data.length, 8);
  chunk.writeUInt32LE(data.length, 0); chunk.write('BIN\0', 4, 'latin1');
  const jsonChunk = Buffer.alloc(8); jsonChunk.writeUInt32LE(padded.length, 0); jsonChunk.write('JSON', 4, 'latin1');
  return Buffer.concat([head, jsonChunk, padded, chunk, data]);
}

test('data the loader would allocate or draw without bound, and damaged images, are refused before parsing', async t => {
  const { folder, dir } = setup(t);
  const pieces = new YardPieces({ dir });
  await pieces.replace('guild', 'anthropic', folder());
  const before = JSON.stringify(pieces.snapshot());
  const image = (json, binary, change) => { const view = json.bufferViews[json.images[0].bufferView]; change(view, binary.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength)); };
  for (const [label, change, reason] of [
    ['a bufferless accessor', json => { json.meshes[0].primitives[0].attributes.COLOR_0 = json.accessors.push({ componentType: 5126, count: 1e9, type: 'VEC4' }) - 1; }, /refers to data it doesn’t contain/],

    ['lights', json => { json.extensionsUsed = [...(json.extensionsUsed ?? []), 'KHR_lights_punctual']; }, /uses lights/],
    ['instancing', json => { json.nodes.at(-1).extensions = { EXT_mesh_gpu_instancing: { attributes: {} } }; }, /uses instancing/],
    ['a rigged mesh without weights', json => { delete json.meshes[0].primitives[0].attributes.WEIGHTS_0; }, /rigged mesh without weights/],
    ['an image cut short', (json, binary) => image(json, binary, (view, data) => data.fill(0, 24)), /image that is incomplete or damaged/],
    ['many views over the same bytes', json => { for (let i = 0; i < 3; i++) json.bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: json.buffers[0].byteLength }); }, /reuses its data in a way that would multiply its size/],
    ['many accessors over the same view', json => { for (let i = 0; i < 3; i++) json.accessors.push({ ...json.accessors[0] }); }, /reuses its data in a way that would multiply its size/],
    ['a negative view length', json => { json.bufferViews[0].byteLength = -1; }, /refers to data it doesn’t contain/],
    ['a view length past safe integers', json => { json.bufferViews[0].byteLength = 2 ** 60; }, /refers to data it doesn’t contain/],
    ['a view past the end of the data', json => { json.bufferViews[0].byteOffset = json.buffers[0].byteLength; }, /refers to data it doesn’t contain/],
    ['an accessor with an unknown view', json => { json.accessors[0].bufferView = 999; }, /refers to data it doesn’t contain/],
    ['a scene root listed twice', json => { json.scenes[0].nodes.push(json.scenes[0].nodes[0]); }, /node used in two places/],
    ['a second scene', json => { json.scenes.push({ nodes: [...json.scenes[0].nodes] }); }, /exactly one scene/],
    ['a node under two parents', json => { const child = json.nodes[0].children[0]; json.nodes.find((node, at) => at !== 0 && node.children).children.push(child); }, /node used in two places/],
    ['nodes that loop', json => { const at = json.nodes.length; json.nodes.push({ name: 'a', children: [at + 1] }, { name: 'b', children: [at] }); }, /nodes that loop/],
    ['a node index it doesn’t have', json => { json.scenes[0].nodes.push(999); }, /refers to a node it doesn’t have/],
    ['one mesh repeating its part 17 times', json => { json.meshes[0].primitives = Array(17).fill(json.meshes[0].primitives[0]); }, /draws more than 16 mesh parts/],
    ['nine parts drawn by two nodes', json => { json.meshes[0].primitives = Array(9).fill(json.meshes[0].primitives[0]); json.nodes.push({ name: 'again', mesh: 0, skin: 0 }); json.nodes[0].children.push(json.nodes.length - 1); }, /draws more than 16 mesh parts/],
    ['repeated shape keys', json => { const position = json.meshes[0].primitives[0].attributes.POSITION; json.meshes[0].primitives[0].targets = Array(64).fill({ POSITION: position }); }, /shape keys/],
    ['128 channels sharing one normalized output', json => {
      const animation = json.animations[0], output = json.accessors[animation.samplers[animation.channels[0].sampler].output];
      Object.assign(output, { componentType: 5122, normalized: true });
      animation.channels = Array(128).fill(animation.channels[0]);
    }, /animation data that isn’t plain 32-bit floats/],
    ['integer animation times', json => { const animation = json.animations[0]; json.accessors[animation.samplers[0].input].componentType = 5125; }, /animation data that isn’t plain 32-bit floats/],
    ['legacy animation parameters', json => {
      const animation = json.animations[0], sampler = animation.samplers[0], output = json.accessors[sampler.output];
      const remapped = json.accessors.push({ ...output, componentType: 5122, normalized: true, count: Math.floor(output.count / 2) }) - 1;
      animation.parameters = { [sampler.input]: sampler.input, [sampler.output]: remapped };
    }, /glTF property the Yard doesn’t read \(animation\.parameters\)/],
    ['cubic spline animation', json => { json.animations[0].samplers[0].interpolation = 'CUBICSPLINE'; }, /CUBICSPLINE animation, which the Yard doesn’t play/],
    ['an animated weights path', json => { json.animations[0].channels[0].target.path = 'weights'; }, /animates something the Yard doesn’t move/],
    ['an animation aimed at a missing node', json => { json.animations[0].channels[0].target.node = 999; }, /animates something the Yard doesn’t move/],
    ['more than 256 channels in a clip', json => { json.animations[0].channels = Array(257).fill(json.animations[0].channels[0]); }, /more than 256 channels/],
    ['more than 2,048 channels in a file', json => { json.animations = json.animations.map(clip => ({ ...clip, channels: Array(256).fill(clip.channels[0]) })); json.animations.push({ ...json.animations[0], name: 'extra', channels: [json.animations[0].channels[0]] }); }, /more than 2,048 animation channels/],  ]) {
    const source = folder({ models: { 'character.glb': variant(fixture('character'), change) } });
    await assert.rejects(pieces.replace('guild', 'anthropic', source), refused(reason), label);
    assert.equal(JSON.stringify(pieces.snapshot()), before, label);
  }
  const sixteen = variant(fixture('character'), json => { json.meshes[0].primitives = Array(16).fill(json.meshes[0].primitives[0]); });
  assert.equal((await pieces.replace('guild', 'anthropic', folder({ title: 'Sixteen', models: { 'character.glb': sixteen } }))).guild.anthropic.title, 'Sixteen', '16 mesh parts fit');
  const picture = (json, binary) => { const view = json.bufferViews[json.images[0].bufferView]; return Buffer.from(binary.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength)); };
  const tail = text => (json, binary, view) => [Buffer.concat([picture(json, binary), Buffer.from(text, 'latin1')]), () => { json.images[0].bufferView = view; }];
  const junk = extended(fixture('character'), tail('\0\0\0\0'));
  await assert.rejects(pieces.replace('guild', 'anthropic', folder({ models: { 'character.glb': junk } })), refused(/image that is incomplete or damaged/), 'an image with trailing junk');
  const padded = extended(fixture('character'), tail('  '));
  assert.equal((await pieces.replace('guild', 'anthropic', folder({ title: 'Padded', models: { 'character.glb': padded } }))).guild.anthropic.title, 'Padded', 'exporters pad an image to four bytes');
  const keyframes = extended(fixture('character'), (json, binary, view) => [Buffer.alloc(4096 * 16), () => {
    const animation = json.animations[0], channel = animation.channels.find(c => c.target.path === 'rotation') ?? animation.channels[0];
    channel.target.path = 'rotation';
    animation.samplers[channel.sampler].output = json.accessors.push({ bufferView: view, componentType: 5126, count: 4096, type: 'VEC4' }) - 1;
  }]);
  await assert.rejects(pieces.replace('guild', 'anthropic', folder({ models: { 'character.glb': keyframes } })), refused(/keyframes that don’t match their times/), '4,096 rotations for two times');
  const interleaved = extended(fixture('character'), (json, binary, view) => [Buffer.alloc(8 * 32), () => {
    json.bufferViews.at(-1).byteStride = 32;
    json.meshes[0].primitives[0].attributes.COLOR_0 = json.accessors.push({ bufferView: view, componentType: 5126, count: 8, type: 'VEC3' }) - 1;
  }]);
  await assert.rejects(pieces.replace('guild', 'anthropic', folder({ models: { 'character.glb': interleaved } })), refused(/interleaves its data/), 'an interleaved attribute');
  const triangles = (twice) => extended(fixture('character'), (json, binary, view) => [(() => {
    const indices = json.accessors[json.meshes[0].primitives[0].indices], start = (json.bufferViews[indices.bufferView].byteOffset || 0) + (indices.byteOffset || 0), many = Buffer.alloc(330000 * 2);
    for (let i = 0; i < 330000; i++) many.writeUInt16LE(binary.readUInt16LE(start + (i % indices.count) * 2), i * 2);
    return many;
  })(), () => {
    json.meshes[0].primitives[0].indices = json.accessors.push({ bufferView: view, componentType: 5123, count: 330000, type: 'SCALAR' }) - 1;
    if (twice) { json.nodes.push({ name: 'again', mesh: 0, skin: 0 }); json.nodes[0].children.push(json.nodes.length - 1); }
  }]);
  assert.equal((await pieces.replace('guild', 'anthropic', folder({ title: 'Once', models: { 'character.glb': triangles(false) } }))).guild.anthropic.title, 'Once', '110,000 faces drawn once fit');
  await assert.rejects(pieces.replace('guild', 'anthropic', folder({ models: { 'character.glb': triangles(true) } })), refused(/more than 210,000 faces/), 'the same mesh drawn by two nodes counts twice');
});

test('malformed rigged meshes and images that fail to decode are refused, and the working piece stays', async t => {
  const { folder, dir } = setup(t);
  const pieces = new YardPieces({ dir });
  await pieces.replace('guild', 'anthropic', folder({ title: 'Working' }));
  const before = JSON.stringify(pieces.snapshot());
  const require = createRequire(import.meta.url);
  globalThis.ImageData ??= class ImageData { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  const encoder = async (entry, wasm) => { const codec = await import(entry); await codec.init(await WebAssembly.compile(fs.readFileSync(require.resolve(wasm)))); return codec.default; };
  const square = new ImageData(new Uint8ClampedArray(16 * 16 * 4).map((_, i) => (i * 37) % 256), 16, 16);
  const webp = Buffer.from(await (await encoder('@jsquash/webp/encode.js', '@jsquash/webp/codec/enc/webp_enc.wasm'))(square));
  const jpeg = Buffer.from(await (await encoder('@jsquash/jpeg/encode.js', '@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm'))(square));
  const picture = (bytes, mimeType) => extended(fixture('character'), (json, binary, view) => [bytes, () => { json.images[0] = { bufferView: view, mimeType }; }]);
  const damaged = (bytes, change) => { const copy = Buffer.from(bytes); change(copy); return copy; };
  for (const [label, model] of [['a WebP', picture(webp, 'image/webp')], ['a JPEG', picture(jpeg, 'image/jpeg')]]) {
    assert.equal((await pieces.replace('guild', 'shell', folder({ title: label, models: { 'character.glb': model } }))).guild.shell.title, label, `${label} that decodes is accepted`);
  }
  const zeroedIdat = variant(fixture('character'), (json, binary) => {
    const view = json.bufferViews[json.images[0].bufferView], png = binary.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
    for (let at = 8; at < png.length; at += 12 + png.readUInt32BE(at)) if (png.toString('latin1', at + 4, at + 8) === 'IDAT') png.fill(0, at + 8, at + 8 + png.readUInt32BE(at));
  });
  for (const [label, model, reason] of [
    ['a mesh without positions', variant(fixture('character'), json => { delete json.meshes[0].primitives[0].attributes.POSITION; }), /mesh without positions/],
    ['a vertex weighted to joint 250', variant(fixture('character'), (json, binary) => { const joints = json.accessors[json.meshes[0].primitives[0].attributes.JOINTS_0]; binary[(json.bufferViews[joints.bufferView].byteOffset || 0) + (joints.byteOffset || 0)] = 250; }), /weights a vertex to a joint it doesn’t have/],
    ['a PNG whose pixel data is zeroed', zeroedIdat, /image that is incomplete or damaged/],
    ['a WebP whose pixel data is zeroed', picture(damaged(webp, copy => copy.fill(0, 30)), 'image/webp'), /image that is incomplete or damaged/],
    ['a JPEG with a bogus Huffman table', picture(damaged(jpeg, copy => { const table = copy.indexOf(Buffer.from([0xff, 0xc4])); copy.fill(0xff, table + 5, table + 21); }), 'image/jpeg'), /image that is incomplete or damaged/],
  ]) {
    await assert.rejects(pieces.replace('guild', 'anthropic', folder({ models: { 'character.glb': model } })), refused(reason), label);
    assert.equal(JSON.stringify(pieces.snapshot().guild.anthropic), JSON.stringify(JSON.parse(before).guild.anthropic), label);
  }
});

test('triangles that miss their vertices, split vertex counts and clips that leave their place are refused', async t => {
  const { folder, dir } = setup(t);
  const pieces = new YardPieces({ dir });
  await pieces.replace('guild', 'anthropic', folder({ title: 'Working' }));
  const before = JSON.stringify(pieces.snapshot().guild.anthropic);
  const wanders = extended(fixture('character'), (json, binary, view) => {
    const times = json.accessors[json.animations[0].samplers[0].input], values = Buffer.alloc(times.count * 12);
    values.writeFloatLE(0.5, (times.count - 1) * 12);
    return [values, () => {
      const animation = json.animations[0], output = json.accessors.push({ bufferView: view, componentType: 5126, count: times.count, type: 'VEC3' }) - 1;
      const sampler = animation.samplers.push({ input: animation.samplers[0].input, output }) - 1;
      animation.channels.push({ sampler, target: { node: json.nodes.findIndex((node) => node.name === 'Root'), path: 'translation' } });
    }];
  });
  for (const [label, model, reason] of [
    ['a triangle aimed at vertex 250', variant(fixture('character'), (json, binary) => { const indices = json.accessors[json.meshes[0].primitives[0].indices]; binary.writeUInt16LE(250, (json.bufferViews[indices.bufferView].byteOffset || 0) + (indices.byteOffset || 0)); }), /triangle that refers to a vertex it doesn’t have/],
    ['texture coordinates for fewer vertices', variant(fixture('character'), json => { json.accessors[json.meshes[0].primitives[0].attributes.TEXCOORD_0].count -= 1; }), /attributes don’t share one vertex count/],
    ['a clip that walks the root half a metre', wanders, /moves the character instead of playing in place \(walk\)/],
    ...[
      ['a Hips rotation of NaN', (out, write) => { for (let i = 0; i < out.count * 4; i++) write(i, NaN); }],
      ['times that run backwards', (out, write, times) => { times(0, 1); times(1, 0.5); }],
      ['a zero-length rotation', (out, write) => { for (let i = 0; i < 4; i++) write(i, 0); }],
      ['rotation samples of [0.5, 0.5, 0, 0]', (out, write) => { for (let i = 0; i < out.count; i++) [0.5, 0.5, 0, 0].forEach((value, k) => write(i * 4 + k, value)); }],
    ].map(([label, change]) => [label, variant(fixture('character'), (json, binary) => {
      const sampler = json.animations[0].samplers[json.animations[0].channels[0].sampler], at = (accessor) => (json.bufferViews[accessor.bufferView].byteOffset || 0) + (accessor.byteOffset || 0);
      const output = json.accessors[sampler.output], input = json.accessors[sampler.input];
      change(output, (i, value) => binary.writeFloatLE(value, at(output) + i * 4), (i, value) => binary.writeFloatLE(value, at(input) + i * 4));
    }), /animation with values the Yard can’t play \(walk\)/]),
    ['a Hips rotation that isn’t a unit quaternion', variant(fixture('character'), json => { json.nodes.find((node) => node.name === 'Hips').rotation = [0.5, 0.5, 0, 0]; }), /node rotation that isn’t a unit quaternion \(Hips\)/],
    ['a base colour from texture channel 4', variant(fixture('character'), json => { const primitive = json.meshes[0].primitives[0]; primitive.attributes.TEXCOORD_4 = primitive.attributes.TEXCOORD_0; json.materials[primitive.material].pbrMetallicRoughness.baseColorTexture.texCoord = 4; }), /uses texture channel 4, which the Yard can’t draw/],
    ['a clearcoat texture from channel 4', variant(fixture('character'), json => { const primitive = json.meshes[0].primitives[0]; primitive.attributes.TEXCOORD_4 = primitive.attributes.TEXCOORD_0; json.extensionsUsed = [...(json.extensionsUsed ?? []), 'KHR_materials_clearcoat']; json.materials[primitive.material].extensions = { KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatTexture: { index: 0, texCoord: 4 } } }; }), /uses texture channel 4, which the Yard can’t draw/],
    ['signed triangle indices', variant(fixture('character'), json => { json.accessors[json.meshes[0].primitives[0].indices].componentType = 5122; }), /triangle indices of a type the Yard can’t draw/],
    ['raw unsigned-short texture coordinates without quantization', variant(fixture('character'), json => { Object.assign(json.accessors[json.meshes[0].primitives[0].attributes.TEXCOORD_0], { componentType: 5123, normalized: false }); }), /TEXCOORD_0 attribute of a type the Yard can’t draw/],
  ]) {
    await assert.rejects(pieces.replace('guild', 'anthropic', folder({ models: { 'character.glb': model } })), refused(reason), label);
    assert.equal(JSON.stringify(pieces.snapshot().guild.anthropic), before, label);
  }
  const nearUnit = variant(fixture('character'), (json, binary) => {
    const output = json.accessors[json.animations[0].samplers[json.animations[0].channels[0].sampler].output], start = (json.bufferViews[output.bufferView].byteOffset || 0) + (output.byteOffset || 0);
    for (let i = 0; i < output.count * 4; i++) binary.writeFloatLE(binary.readFloatLE(start + i * 4) * 1.0005, start + i * 4);
  });
  assert.equal((await pieces.replace('guild', 'anthropic', folder({ title: 'Near unit', models: { 'character.glb': nearUnit } }))).guild.anthropic.title, 'Near unit', 'rotations within 0.001 of unit length are accepted');
});

test('the in-place rule judges a scaled export exactly like the same model unscaled', async t => {
  const { folder, dir } = setup(t);
  const pieces = new YardPieces({ dir });
  const exportAt = (scale, sway) => extended(fixture('character'), (json, binary, view) => {
    const floats = (at, change) => { const accessor = json.accessors[at], start = (json.bufferViews[accessor.bufferView].byteOffset || 0) + (accessor.byteOffset || 0), width = { VEC3: 3, MAT4: 16 }[accessor.type]; for (let i = 0; i < accessor.count * width; i++) { const value = change(i % width); if (value) binary.writeFloatLE(binary.readFloatLE(start + i * 4) * value, start + i * 4); } };
    const position = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
    floats(json.meshes[0].primitives[0].attributes.POSITION, () => scale);
    position.min = position.min.map((value) => value * scale); position.max = position.max.map((value) => value * scale);
    floats(json.skins[0].inverseBindMatrices, (k) => (k >= 12 && k <= 14 ? scale : 0));
    for (const node of json.nodes) if (node.translation) node.translation = node.translation.map((value) => value * scale);
    const times = json.accessors[json.animations[0].samplers[0].input], values = Buffer.alloc(times.count * 12);
    values.writeFloatLE(sway * scale, (times.count - 1) * 12);
    return [values, () => {
      const animation = json.animations[0], output = json.accessors.push({ bufferView: view, componentType: 5126, count: times.count, type: 'VEC3' }) - 1;
      animation.channels.push({ sampler: animation.samplers.push({ input: animation.samplers[0].input, output }) - 1, target: { node: json.nodes.findIndex((node) => node.name === 'Root'), path: 'translation' } });
      const wrapper = json.nodes.push({ name: 'Export', scale: [1 / scale, 1 / scale, 1 / scale], children: [...json.scenes[0].nodes] }) - 1;
      json.scenes[0].nodes = [wrapper];
    }];
  });
  for (const scale of [1, 0.01]) {
    assert.equal((await pieces.replace('guild', 'anthropic', folder({ title: `Sways at ${scale}`, models: { 'character.glb': exportAt(scale, 0.05) } }))).guild.anthropic.title, `Sways at ${scale}`, `a 5 cm sway plays in place at export scale ${scale}`);
    await assert.rejects(pieces.replace('guild', 'anthropic', folder({ models: { 'character.glb': exportAt(scale, 0.5) } })), refused(/moves the character instead of playing in place \(walk\)/), `a 50 cm walk leaves its place at export scale ${scale}`);
    assert.equal(pieces.snapshot().guild.anthropic.title, `Sways at ${scale}`, 'the refusal keeps the working piece');
  }
});

test('a model link is refused rather than followed', async (t) => {
  const { folder, dir } = setup(t);
  const source = folder({ models: {} });
  const target = path.join(path.dirname(source), 'outside.glb');
  fs.writeFileSync(target, fixture('character'));
  try { fs.symlinkSync(target, path.join(source, 'character.glb'), 'file'); } catch (err) {
    if (err.code === 'EPERM') return t.skip('this account cannot create links');
    throw err;
  }
  await assert.rejects(new YardPieces({ dir }).replace('guild', 'anthropic', source), refused(/isn’t a plain file/));
});

test('only one change runs at a time, and the second is told to wait', async (t) => {
  const { folder, dir } = setup(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pieces = new YardPieces({ dir, check: () => gate });
  const first = pieces.replace('guild', 'anthropic', folder({ title: 'First' }));
  await assert.rejects(pieces.replace('grove', 'openai', folder()), { status: 409, code: 'piece_busy' });
  await assert.rejects(pieces.restore('guild', 'anthropic'), { status: 409, code: 'piece_busy' });
  release();
  assert.equal((await first).guild.anthropic.title, 'First');
});

test('damage, an interrupted install and a crash between the two renames all recover', async (t) => {
  const { folder, dir } = setup(t);
  const pieces = new YardPieces({ dir });
  await pieces.replace('guild', 'anthropic', folder({ title: 'Kept' }));
  await pieces.replace('orbital', 'docker', folder({ title: 'Bent' }));
  fs.appendFileSync(path.join(dir, 'orbital', 'docker', 'character.glb'), 'x');
  fs.mkdirSync(path.join(dir, '.guild.openai.0.staging'));
  fs.renameSync(path.join(dir, 'guild', 'anthropic'), path.join(dir, '.guild.anthropic.1.old'));
  fs.mkdirSync(path.join(dir, 'grove', 'xai'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.grove.xai.2.old'));
  const reopened = new YardPieces({ dir });
  await reopened.swept;
  assert.equal(reopened.snapshot().guild.anthropic.title, 'Kept', 'the working piece comes back');
  assert.match(reopened.snapshot().orbital.docker.problem, /Bent is damaged: character\.glb/);
  assert.equal(reopened.snapshot().orbital.docker.revision, undefined);
  assert.equal(reopened.file('orbital', 'docker', 'character.glb'), null, 'a damaged piece is not served');
  assert.equal(reopened.snapshot().grove.xai.problem, 'This piece is damaged.');
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('.')), []);
  await reopened.restore('orbital', 'docker');
  assert.equal(reopened.snapshot().orbital, undefined);
  const unusable = path.join(dir, 'guild', 'anthropic', 'install.json');
  fs.rmSync(unusable);
  assert.match(new YardPieces({ dir }).snapshot().guild.anthropic.problem, /damaged/);
});

test('a restored piece stays gone after a restart, even when its files could not be deleted', async (t) => {
  const { folder, dir } = setup(t);
  const stuck = async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
  const pieces = new YardPieces({ dir, remove: stuck });
  await pieces.replace('guild', 'anthropic', folder({ title: 'A' }));
  await pieces.replace('guild', 'anthropic', folder({ title: 'B' }));
  assert.equal(pieces.snapshot().guild.anthropic.title, 'B');
  await pieces.restore('guild', 'anthropic');
  assert.deepEqual(pieces.snapshot(), {});
  const reopened = new YardPieces({ dir, remove: stuck });
  await reopened.swept;
  assert.deepEqual(reopened.snapshot(), {});
});

test('a change waits for startup recovery and Restore retires legacy backups', async t => {
  const { folder, dir } = setup(t);
  const pieces = new YardPieces({ dir });
  await pieces.replace('guild', 'anthropic', folder({ title: 'A' }));
  const legacy = path.join(dir, '.guild.anthropic.legacy.old');
  fs.cpSync(path.join(dir, 'guild', 'anthropic'), legacy, { recursive: true });
  let release, checked = false;
  pieces.swept = new Promise(resolve => { release = resolve; });
  pieces.check = async () => { checked = true; };
  const pending = pieces.replace('guild', 'anthropic', folder({ title: 'B' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checked, false);
  assert.equal(pieces.snapshot().guild.anthropic.title, 'A');
  release();await pending;
  fs.cpSync(path.join(dir, 'guild', 'anthropic'), legacy, { recursive: true });
  pieces.remove = async () => { throw new Error('denied'); };
  await pieces.restore('guild', 'anthropic');
  assert.deepEqual(pieces.snapshot(), {});
  assert.ok(!fs.existsSync(legacy));
});

test('a replace that cannot retire the old copy still succeeds, and Restore retires it later', async t => {
  const { folder, dir } = setup(t);
  const pieces = new YardPieces({ dir, remove: async () => { throw new Error('denied'); } });
  await pieces.replace('guild', 'anthropic', folder({ title: 'A' }));
  const rename = fs.promises.rename;
  const mock = t.mock.method(fs.promises, 'rename', async (from, to) => {
    if (from.endsWith('.old')) throw Object.assign(new Error('busy'), { code: 'EIO' });
    return rename(from, to);
  });
  assert.equal((await pieces.replace('guild', 'anthropic', folder({ title: 'B' }))).guild.anthropic.title, 'B');
  mock.mock.restore();
  await pieces.restore('guild', 'anthropic');
  assert.deepEqual(pieces.snapshot(), {});
  assert.deepEqual(new YardPieces({ dir }).snapshot(), {});
});

test('a companion without yard extras is accepted, as World accepts it', async t => {
  const { folder, dir } = setup(t);
  const bare = variant(fixture('companion'), json => { for (const node of json.nodes) delete node.extras; });
  const models = Object.fromEntries([0, 1, 2, 3].map(n => [`companion_${n}.glb`, bare]));
  assert.equal((await new YardPieces({ dir }).replace('guild', 'companion', folder({ kind: 'companion', title: 'Bare', models }))).guild.companion.title, 'Bare');
});

test('Restore leaves the active piece unchanged if a legacy backup cannot be retired', async t => {
  const { folder, dir } = setup(t);
  const pieces = new YardPieces({ dir });
  await pieces.replace('guild', 'anthropic', folder({ title: 'Kept' }));
  const before = JSON.stringify(pieces.snapshot());
  const legacy = path.join(dir, '.guild.anthropic.legacy.old');
  fs.cpSync(path.join(dir, 'guild', 'anthropic'), legacy, { recursive: true });
  const rename = fs.promises.rename;
  t.mock.method(fs.promises, 'rename', async (from, to) => {
    if (from === legacy) throw Object.assign(new Error('backup cannot be renamed'), { code: 'EIO' });
    return rename(from, to);
  });
  await assert.rejects(pieces.restore('guild', 'anthropic'), { code: 'piece_unwritable', message: /backup cannot be renamed/ });
  assert.equal(JSON.stringify(pieces.snapshot()), before);
  assert.ok(fs.existsSync(pieces.file('guild', 'anthropic', 'character.glb')));
});

test('the folder dialog lists matching pieces here and one level down, by title', async (t) => {
  const { root, folder } = setup(t);
  const library = path.join(root, 'workshop');
  folder({ name: 'workshop/3002', title: 'Giant' });
  folder({ name: 'workshop/3001', title: 'giant' });
  folder({ name: 'workshop/3003', title: '' });
  folder({ name: 'workshop/3004', kind: 'companion', title: 'Moths' });
  folder({ name: 'workshop/3005/deeper', title: 'Too deep' });
  folder({ name: 'workshop/3006', manifest: JSON.stringify({ format: 2, kind: 'character', title: 'Future' }) });
  folder({ name: 'workshop/3007', manifest: JSON.stringify({ format: 2, kind: 'companion', title: 'Future moths' }) });
  fs.writeFileSync(path.join(root, 'workshop', 'piece.json'), '{');
  const browser = createFolderBrowser({ home: root, workshop: async () => library });
  const listing = await browser.list(library, { pieces: 'character' });
  assert.equal(listing.workshop, library);
  assert.deepEqual(listing.pieces.map(({ title, folder: name, problem }) => [title, name, problem]), [['3003', '3003', undefined], ['Future', '3006', 'This piece needs a newer Agent Guild.'], ['giant', '3001', undefined], ['Giant', '3002', undefined]]);
  assert.deepEqual((await browser.list(library, { pieces: 'companion' })).pieces.map((piece) => piece.title), ['Future moths', 'Moths']);
  assert.deepEqual((await browser.list(path.join(library, '3004'), { pieces: 'companion' })).pieces.map((piece) => piece.path), [path.join(library, '3004')]);
  assert.equal((await browser.list(library)).pieces, undefined);
});

test('the API needs the token, serves only installed models, and allows blob images under remote access', async (t) => {
  const { root, folder, dir } = setup(t);
  const source = folder({ name: 'mine' });
  const manager = Object.assign(new EventEmitter(), { list: () => [], listExiting: () => [], resolveCwd: (cwd) => cwd });
  const registry = Object.assign(new EventEmitter(), { list: () => [], warnings: [], platform: process.platform, get: () => null });
  const api = createManagerServer({ manager, registry, folderBrowser: createFolderBrowser({ home: root }), yardPieces: new YardPieces({ dir }), extraHosts: ['guild.example.ts.net:8443'],
    token: 'test-manager-token', webDir: fileURLToPath(new URL('../web', import.meta.url)) });
  await api.listen();
  t.after(() => api.close());
  const call = (method, route, body) => fetch(`${api.url}${route}`, { method, headers: { Authorization: 'Bearer test-manager-token', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const unauthenticated = await fetch(`${api.url}/api/v1/yard-pieces/guild/anthropic`, { method: 'PUT', body: JSON.stringify({ path: source }) });
  assert.equal(unauthenticated.status, 401);
  assert.equal((await fetch(`${api.url}/api/v1/yard-pieces`)).status, 401);
  assert.equal((await call('GET', `/api/v1/folders?path=${encodeURIComponent(root)}&pieces=character`).then((r) => r.json())).pieces[0].path, source);
  const { yardPieces } = await (await call('PUT', '/api/v1/yard-pieces/guild/anthropic', { path: source })).json();
  assert.equal(yardPieces.guild.anthropic.title, 'Patchwork');
  const model = await fetch(`${api.url}/yard/pieces/guild/anthropic/character.glb?v=${yardPieces.guild.anthropic.revision}`);
  assert.equal(model.status, 200);
  assert.equal(model.headers.get('content-type'), 'model/gltf-binary');
  assert.deepEqual(Buffer.from(await model.arrayBuffer()), fixture('character'));
  const policy = Object.fromEntries(model.headers.get('content-security-policy').split(';').map((part) => part.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources]));
  assert.ok(policy['img-src'].includes('blob:') && policy['connect-src'].includes('blob:'), 'embedded textures decode from blob: URLs');
  assert.ok(policy['connect-src'].includes('wss://guild.example.ts.net:8443'));
  assert.ok(!policy['script-src'].includes('blob:') && !policy['default-src'].includes('blob:'));
  for (const route of ['/yard/pieces/guild/anthropic/piece.json', '/yard/pieces/guild/anthropic/install.json', '/yard/pieces/guild/openai/character.glb', '/yard/pieces/guild/anthropic/..%2Fanthropic%2Fcharacter.glb', '/yard/pieces/guild/anthropic/x/character.glb']) {
    const response = await fetch(`${api.url}${route}`);
    assert.equal(response.status, 404, route);
    await response.arrayBuffer();
  }
  const bad = await call('PUT', '/api/v1/yard-pieces/guild/anthropic', { path: 'relative' });
  assert.equal((await bad.json()).error.code, 'piece_invalid');
  assert.deepEqual((await (await call('DELETE', '/api/v1/yard-pieces/guild/anthropic')).json()).yardPieces, {});
  assert.equal((await fetch(`${api.url}/yard/pieces/guild/anthropic/character.glb`)).status, 404);
});
