import fs from 'node:fs';
import { createRequire } from 'node:module';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { SKELETON, CLIPS, yardExtras, playableClip, unitQuaternion } from '../../web/yard/model.mjs';

export const LIMITS = {
  character: { faces: 210000, side: 4096, bytes: 128 * 1024 * 1024 },
  companion: { faces: 63000, side: 2048, bytes: 48 * 1024 * 1024 },
};
const COUNTS = { nodes: 256, meshes: 16, materials: 16, textures: 16, samplers: 16, images: 8, animations: 16, accessors: 2048, bufferViews: 2048, skins: 2, buffers: 1 };
const REQUIRED_OK = new Set(['EXT_texture_webp', 'KHR_texture_transform', 'KHR_materials_emissive_strength', 'KHR_mesh_quantization']);
const ELEMENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const MATERIAL_TEXTURES = {
  KHR_materials_clearcoat: ['clearcoatTexture', 'clearcoatRoughnessTexture', 'clearcoatNormalTexture'],
  KHR_materials_diffuse_roughness: ['diffuseRoughnessTexture'],
  KHR_materials_sheen: ['sheenColorTexture', 'sheenRoughnessTexture'],
  KHR_materials_specular: ['specularTexture', 'specularColorTexture'],
  KHR_materials_transmission: ['transmissionTexture'],
  KHR_materials_iridescence: ['iridescenceTexture', 'iridescenceThicknessTexture'],
  KHR_materials_anisotropy: ['anisotropyTexture'],
  KHR_materials_volume: ['thicknessTexture'],
  EXT_materials_bump: ['bumpTexture'],
};
const IN_PLACE = 0.1;
const FLOAT = [5126, false];
const SIGNED = { byte: [5120, false], normalByte: [5120, true], short: [5122, false], normalShort: [5122, true] };
const UNSIGNED = { byte: [5121, false], normalByte: [5121, true], short: [5123, false], normalShort: [5123, true], int: [5125, false] };
const ATTRIBUTE_FORMS = {
  POSITION: [['VEC3'], [FLOAT]],
  NORMAL: [['VEC3'], [FLOAT]],
  TANGENT: [['VEC4'], [FLOAT]],
  TEXCOORD: [['VEC2'], [FLOAT, UNSIGNED.normalByte, UNSIGNED.normalShort]],
  COLOR: [['VEC3', 'VEC4'], [FLOAT, UNSIGNED.normalByte, UNSIGNED.normalShort]],
  JOINTS: [['VEC4'], [UNSIGNED.byte, UNSIGNED.short]],
  WEIGHTS: [['VEC4'], [FLOAT, UNSIGNED.normalByte, UNSIGNED.normalShort]],
};
const QUANTIZED_FORMS = {
  POSITION: [SIGNED.byte, SIGNED.normalByte, UNSIGNED.byte, UNSIGNED.normalByte, SIGNED.short, SIGNED.normalShort, UNSIGNED.short, UNSIGNED.normalShort],
  NORMAL: [SIGNED.normalByte, SIGNED.normalShort],
  TANGENT: [SIGNED.normalByte, SIGNED.normalShort],
  TEXCOORD: [SIGNED.byte, SIGNED.normalByte, UNSIGNED.byte, SIGNED.short, SIGNED.normalShort, UNSIGNED.short],
};
const TRACKS ={ translation: 'VEC3', rotation: 'VEC4', scale: 'VEC3' };
const METADATA = ['name', 'extras'];
const PROPERTIES = {
  accessor: ['bufferView', 'byteOffset', 'componentType', 'normalized', 'count', 'type', 'max', 'min', 'sparse', ...METADATA],
  bufferView: ['buffer', 'byteOffset', 'byteLength', 'byteStride', 'target', ...METADATA],
  skin: ['inverseBindMatrices', 'skeleton', 'joints', ...METADATA],
  node: ['children', 'skin', 'matrix', 'mesh', 'rotation', 'scale', 'translation', 'extensions', ...METADATA],
  mesh: ['primitives', ...METADATA],
  primitive: ['attributes', 'indices', 'material', 'mode', 'targets', ...METADATA],
  attributes: /^(POSITION|NORMAL|TANGENT|(TEXCOORD|COLOR|JOINTS|WEIGHTS)_\d+)$/,
  animation: ['channels', 'samplers', ...METADATA],
  sampler: ['input', 'interpolation', 'output', ...METADATA],
  channel: ['sampler', 'target', ...METADATA],
  target: ['node', 'path', ...METADATA],
};
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_JSON = 1024 * 1024;
const TIMEOUT = 30000;

const require = createRequire(import.meta.url);
const DECODERS = {
  'image/png': ['@jsquash/png/decode.js', '@jsquash/png/codec/pkg/squoosh_png_bg.wasm'],
  'image/jpeg': ['@jsquash/jpeg/decode.js', '@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm'],
  'image/webp': ['@jsquash/webp/decode.js', '@jsquash/webp/codec/dec/webp_dec.wasm'],
};
const decoders = new Map();

function decoder(type) {
  if (!DECODERS[type]) return Promise.reject(new Error('unsupported image'));
  if (!decoders.has(type)) {
    decoders.set(type, (async () => {
      globalThis.ImageData ??= class ImageData { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
      const [entry, wasm] = DECODERS[type];
      const codec = await import(entry);
      await codec.init(await WebAssembly.compile(fs.readFileSync(require.resolve(wasm))));
      return codec.default;
    })());
  }
  return decoders.get(type);
}

const invalid = (message) =>Object.assign(new Error(message), { status: 400, code: 'piece_invalid' });

export function imageSize(b) {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('latin1', 12, 16) === 'IHDR') return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
    if (chunk === 'VP8L') { const v = b.readUInt32LE(21); return [(v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1]; }
    if (chunk === 'VP8X') return [b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1];
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

function readGlb(b, name) {
  if (b.length < 20 || b.toString('latin1', 0, 4) !== 'glTF' || b.readUInt32LE(4) !== 2 || b.readUInt32LE(8) !== b.length) throw invalid(`${name} isn’t a binary glTF model.`);
  const size = b.readUInt32LE(12);
  if (b.readUInt32LE(16) !== 0x4e4f534a || size > MAX_JSON || 20 + size > b.length) throw invalid(`${name} isn’t a binary glTF model.`);
  try { return JSON.parse(b.toString('utf8', 20, 20 + size)); } catch { throw invalid(`${name} isn’t a binary glTF model.`); }
}

function binLength(b, name) {
  const at = 20 + b.readUInt32LE(12);
  if (at + 8 > b.length) return 0;
  const size = b.readUInt32LE(at);
  if (b.readUInt32LE(at + 4) !== 0x004e4942 || at + 8 + size > b.length) throw invalid(`${name} isn’t a binary glTF model.`);
  return size;
}

function checkJson(json, name, limit, bin) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw invalid(`${name} isn’t a binary glTF model.`);
  for (const [key, most] of Object.entries(COUNTS)) {
    const list = json[key] ?? [];
    if (!Array.isArray(list) || list.length > most) throw invalid(`${name} has more ${key} than a piece may.`);
  }
  for (const extension of json.extensionsRequired ?? []) if (!REQUIRED_OK.has(extension)) throw invalid(`${name} needs ${extension}, which the Yard can’t draw.`);
  if ((json.buffers ?? []).some((buffer) => buffer.uri !== undefined)) throw invalid(`${name} refers to files outside itself.`);
  for (const image of json.images ?? []) {
    if (image.uri !== undefined || image.bufferView === undefined) throw invalid(`${name} refers to files outside itself.`);
    if (!IMAGE_TYPES.has(image.mimeType)) throw invalid(`${name} has an image the Yard can’t draw.`);
  }
  if ((json.accessors ?? []).some((accessor) => accessor?.sparse)) throw invalid(`${name} uses sparse data, which a piece may not.`);
  for (const material of json.materials ?? []) {
    const pbr = material?.pbrMetallicRoughness;
    const extensions = Object.entries(MATERIAL_TEXTURES).flatMap(([extension, slots]) => slots.map((slot) => material?.extensions?.[extension]?.[slot]));
    for (const info of [pbr?.baseColorTexture, pbr?.metallicRoughnessTexture, material?.normalTexture, material?.occlusionTexture, material?.emissiveTexture, ...extensions]) {
      if (!info) continue;
      for (const channel of [info.texCoord ?? 0, info.extensions?.KHR_texture_transform?.texCoord ?? 0]) {
        if (!(Number.isInteger(channel) && channel >= 0 && channel <= 3)) throw invalid(`${name} uses texture channel ${channel}, which the Yard can’t draw.`);
      }
    }
  }
  const allowed = (kind, object) => {
    if (!object || typeof object !== 'object' || Array.isArray(object)) throw invalid(`${name} has a ${kind} that can’t be read.`);
    const extra = Object.keys(object).find((key) => !(PROPERTIES[kind] instanceof RegExp ? PROPERTIES[kind].test(key) : PROPERTIES[kind].includes(key)));
    if (extra !== undefined) throw invalid(`${name} uses a glTF property the Yard doesn’t read (${kind}.${extra}).`);
  };
  for (const accessor of json.accessors ?? []) allowed('accessor', accessor);
  for (const view of json.bufferViews ?? []) allowed('bufferView', view);
  for (const skin of json.skins ?? []) allowed('skin', skin);
  for (const node of json.nodes ?? []) allowed('node', node);
  for (const mesh of json.meshes ?? []) {
    allowed('mesh', mesh);
    if (!Array.isArray(mesh.primitives)) throw invalid(`${name} has a mesh that can’t be read.`);
    for (const primitive of mesh.primitives) {
      allowed('primitive', primitive);
      allowed('attributes', primitive.attributes);
      if (primitive.attributes.POSITION === undefined) throw invalid(`${name} has a mesh without positions.`);
    }
  }
  for (const animation of json.animations ?? []) {
    allowed('animation', animation);
    for (const sampler of Array.isArray(animation.samplers) ? animation.samplers : []) allowed('sampler', sampler);
    for (const channel of Array.isArray(animation.channels) ? animation.channels : []) { allowed('channel', channel); allowed('target', channel.target); }
  }
  const missing =() => invalid(`${name} refers to data it doesn’t contain.`);
  const multiplied = () => invalid(`${name} reuses its data in a way that would multiply its size.`);
  const index = (value, list) => Number.isInteger(value) && value >= 0 && value < (Array.isArray(list) ? list.length : 0);
  const length = (value) => Number.isSafeInteger(value) && value >= 0;
  let viewBytes = 0;
  for (const view of json.bufferViews ?? []) {
    const offset = view?.byteOffset ?? 0;
    if (view?.buffer !== 0 || !length(view.byteLength) || !length(offset) || offset + view.byteLength > bin) throw missing();
    viewBytes += view.byteLength;
  }
  if (viewBytes > bin) throw multiplied();
  let accessorBytes = 0;
  for (const accessor of json.accessors ?? []) {
    const width = (ELEMENTS[accessor?.type] ?? 0) * (COMPONENT_BYTES[accessor?.componentType] ?? 0);
    if (!width || !length(accessor.count) || !index(accessor.bufferView, json.bufferViews) || !length(accessor.byteOffset ?? 0)) throw missing();
    const stride = json.bufferViews[accessor.bufferView].byteStride;
    if (stride !== undefined && stride !== width) throw invalid(`${name} interleaves its data, which a piece may not.`);
    accessorBytes += accessor.count * width;
  }
  if (accessorBytes > bin) throw multiplied();
  const quantized = (json.extensionsUsed ?? []).includes('KHR_mesh_quantization');
  const drawable = (at, types, forms) => types.includes(json.accessors[at].type) && forms.some(([type, normalized]) => json.accessors[at].componentType === type && Boolean(json.accessors[at].normalized) === normalized);
  for (const mesh of json.meshes ?? []) for (const primitive of mesh.primitives) {
    for (const [attribute, at] of Object.entries(primitive.attributes)) {
      const semantic = attribute.replace(/_\d+$/, ''), [types, forms] = ATTRIBUTE_FORMS[semantic];
      if (index(at, json.accessors) && !drawable(at, types, [...forms, ...(quantized ? QUANTIZED_FORMS[semantic] ?? [] : [])])) throw invalid(`${name} has a ${attribute} attribute of a type the Yard can’t draw.`);
    }
    if (index(primitive.indices, json.accessors) && !drawable(primitive.indices, ['SCALAR'], [UNSIGNED.byte, UNSIGNED.short, UNSIGNED.int])) throw invalid(`${name} has triangle indices of a type the Yard can’t draw.`);
    const vertices = json.accessors[primitive.attributes.POSITION]?.count;
    if (!Object.values(primitive.attributes).every((at) => index(at, json.accessors) && json.accessors[at].count === vertices)) throw invalid(`${name} has a mesh whose attributes don’t share one vertex count.`);
    if (primitive.indices !== undefined && (!index(primitive.indices, json.accessors) || json.accessors[primitive.indices].count % 3 !== 0)) throw invalid(`${name} has a mesh whose triangles can’t be read.`);
  }
  if ((json.meshes ?? []).some((mesh) => (mesh?.primitives ?? []).some((primitive) => primitive?.targets !== undefined))) throw invalid(`${name} has shape keys, which the Yard doesn’t use.`);
  let channels = 0;
  for (const animation of json.animations ?? []) {
    if (!Array.isArray(animation?.channels) || !Array.isArray(animation.samplers)) throw invalid(`${name} has an animation that can’t be read.`);
    if (animation.channels.length > 256) throw invalid(`${name} has an animation with more than 256 channels.`);
    channels += animation.channels.length;
    for (const channel of animation.channels) {
      const sampler = index(channel?.sampler, animation.samplers) ? animation.samplers[channel.sampler] : null;
      if (!sampler || ![sampler.input, sampler.output].every((at) => index(at, json.accessors))) throw invalid(`${name} has an animation that can’t be read.`);
      if (![sampler.input, sampler.output].every((at) => json.accessors[at].componentType === 5126 && !json.accessors[at].normalized)) throw invalid(`${name} has animation data that isn’t plain 32-bit floats.`);
      const input = json.accessors[sampler.input], output = json.accessors[sampler.output], path = TRACKS[channel.target.path];
      if (!['LINEAR', 'STEP'].includes(sampler.interpolation ?? 'LINEAR')) throw invalid(`${name} uses ${sampler.interpolation} animation, which the Yard doesn’t play.`);
      if (!path || !index(channel.target.node, json.nodes)) throw invalid(`${name} animates something the Yard doesn’t move.`);
      if (input.type !== 'SCALAR' || output.type !== path || input.count < 1 || output.count !== input.count) throw invalid(`${name} has animation keyframes that don’t match their times.`);
    }
  }
  if (channels > 2048) throw invalid(`${name} has more than 2,048 animation channels.`);
  const nodes = json.nodes ?? [];
  if (!Array.isArray(json.scenes) || json.scenes.length !== 1 || (json.scene ?? 0) !== 0 || !Array.isArray(json.scenes[0]?.nodes ?? [])) throw invalid(`${name} needs exactly one scene.`);
  const parent = new Array(nodes.length).fill(null);
  const place = (child, from) => {
    if (!index(child, nodes)) throw invalid(`${name} refers to a node it doesn’t have.`);
    if (parent[child] !== null) throw invalid(`${name} has a node used in two places.`);
    parent[child] = from;
  };
  for (const root of json.scenes[0].nodes ?? []) place(root, -1);
  nodes.forEach((node, at) => {
    if (!node || typeof node !== 'object' || !Array.isArray(node.children ?? [])) throw invalid(`${name} has a node that can’t be read.`);
    for (const child of node.children ?? []) place(child, at);
    if (node.rotation !== undefined && !(Array.isArray(node.rotation) && node.rotation.length === 4 && unitQuaternion(...node.rotation))) throw invalid(`${name} has a node rotation that isn’t a unit quaternion (${node.name ?? at}).`);
  });
  const shown = new Set();
  for (let at = 0; at < nodes.length; at++) {
    let up = at;
    for (let steps = 0; up !== null && up >= 0; steps++) {
      if (steps > nodes.length) throw invalid(`${name} has nodes that loop.`);
      up = parent[up];
    }
    if (up === -1) shown.add(at);
  }
  for (const skin of json.skins ?? []) {
    if (!Array.isArray(skin?.joints) || skin.joints.length > 128 || !skin.joints.every((joint) => index(joint, nodes))) throw invalid(`${name} needs at most 128 joints per skin.`);
    if (skin.inverseBindMatrices !== undefined && (!index(skin.inverseBindMatrices, json.accessors) || !drawable(skin.inverseBindMatrices, ['MAT4'], [FLOAT]))) throw invalid(`${name} has inverse bind matrices of a type the Yard can’t use.`);
    for (const joint of skin.joints) shown.add(joint);
  }
  for (const node of nodes) {
    if ((node.mesh !== undefined && !index(node.mesh, json.meshes)) || (node.skin !== undefined && !index(node.skin, json.skins))) throw invalid(`${name} refers to a part it doesn’t have.`);
  }
  const extensions = [...(json.extensionsUsed ?? []), ...Object.keys(json.extensions ?? {}), ...nodes.flatMap((node) => Object.keys(node?.extensions ?? {}))];
  if (extensions.includes('KHR_lights_punctual')) throw invalid(`${name} uses lights, which a piece may not.`);
  if (extensions.includes('EXT_mesh_gpu_instancing')) throw invalid(`${name} uses instancing, which a piece may not.`);
  const meshFaces = (json.meshes ?? []).map((mesh) => (mesh?.primitives ?? []).reduce((sum, primitive) => {
    if ((primitive.mode ?? 4) !== 4) throw invalid(`${name} has geometry that isn’t triangles.`);
    return sum + Math.floor((json.accessors?.[primitive.indices ?? primitive.attributes?.POSITION]?.count ?? 0) / 3);
  }, 0));
  let faces = 0;
  for (const [at, node] of nodes.entries()) {
    if (node.mesh === undefined || !shown.has(at)) continue;
    faces += meshFaces[node.mesh] ?? 0;
    if (node.skin !== undefined && (json.meshes?.[node.mesh]?.primitives ?? []).some((primitive) => primitive.attributes?.JOINTS_0 === undefined || primitive.attributes?.WEIGHTS_0 === undefined)) {
      throw invalid(`${name} has a rigged mesh without weights.`);
    }
  }
  if (faces > limit.faces) throw invalid(`${name} has more than ${limit.faces.toLocaleString('en-US')} faces.`);
}

const IMAGE_ENDS = {
  'image/png': (data) => data.length - data.lastIndexOf('IEND', data.length - 1, 'latin1') - 8,
  'image/jpeg': (data) => { const end = data.lastIndexOf(Buffer.from([0xff, 0xd9])); return end < 0 ? Infinity : data.length - end - 2; },
  'image/webp': (data) => (data.length >= 8 ? data.length - data.readUInt32LE(4) - 8 : Infinity),
};

function checkImages(json, b, name) {
  const start = 20 + b.readUInt32LE(12) + 8;
  for (const image of json.images ?? []) {
    const view = json.bufferViews?.[image.bufferView];
    const from = start + (view?.byteOffset ?? 0), to = from + (view?.byteLength ?? 0);
    if (!view || to > b.length) throw invalid(`${name} has an image that is incomplete or damaged.`);
    const spare = IMAGE_ENDS[image.mimeType](b.subarray(from, to));
    if (!(spare >= 0 && spare <= 3)) throw invalid(`${name} has an image that is incomplete or damaged.`);
  }
}

async function inspect(file, name, kind) {
  globalThis.self ??= globalThis;
  for (const method of ['log', 'info', 'warn', 'error']) console[method] = () => {};
  const T = await import('../../web/yard/vendor/engine.js');
  const limit = LIMITS[kind];
  const b = fs.readFileSync(file);
  const json = readGlb(b, name);
  checkJson(json, name, limit, binLength(b, name));
  checkImages(json, b, name);
  const problems = [];
  let pixels = 0, decoding = Promise.resolve();
  globalThis.createImageBitmap = (blob) => {
    const turn = decoding.then(async () => {
      const bytes = Buffer.from(await blob.arrayBuffer()), size = imageSize(bytes);
      if (!size || size.some((side) => side <= 0 || side > limit.side)) {
        problems.push(size ? `${name} has a texture larger than ${limit.side} pixels.` : `${name} has an image that can’t be read.`);
        throw new Error('refused');
      }
      pixels += size[0] * size[1];
      if (pixels > 4 * limit.side * limit.side) {
        problems.push(`${name}’s textures need more memory than a piece may.`);
        throw new Error('refused');
      }
      let image;
      try { image = await (await decoder(blob.type))(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)); } catch { image = null; }
      if (image?.width !== size[0] || image?.height !== size[1]) {
        problems.push(`${name} has an image that is incomplete or damaged.`);
        throw new Error('refused');
      }
      return { width: size[0], height: size[1], close() {} };
    });
    decoding = turn.catch(() => {});
    return turn;
  };
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
  let gltf;
  try { gltf = await new T.GLTFLoader().parseAsync(ab, ''); } catch { throw invalid(`${name} is damaged and can’t be drawn.`); }
  if (problems.length) throw invalid(problems[0]);
  const bones = new Set(), skinned = [];
  let yard = null;
  gltf.scene.traverse((node) => {
    if (node.isBone) bones.add(node.name);
    if (node.isSkinnedMesh) skinned.push(node);
    if (node.userData?.yard) yard = node.userData.yard;
  });
  if (!skinned.length) throw invalid(`${name} has no rigged mesh.`);
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((node) => {
    const vertices = node.geometry?.attributes.position?.count, triangles = node.isMesh ? node.geometry.index?.array : null;
    if (triangles && !triangles.every((at) => at < vertices)) throw invalid(`${name} has a triangle that refers to a vertex it doesn’t have.`);
  });
  const picked = (mesh) => {
    const order = mesh.geometry.index?.array, corners = order ? order.length : mesh.geometry.attributes.position.count;
    const points = [new T.Vector3(), new T.Vector3(), new T.Vector3()], normal = new T.Vector3(), edge = new T.Vector3(), scale = new T.Vector3();
    for (const material of [mesh.material].flat()) material.side = T.DoubleSide;
    mesh.getWorldScale(scale);
    const reach = mesh.boundingSphere.radius * Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z)) * 2 + 1;
    for (let at = 0; at + 2 < corners; at += 3) {
      points.forEach((point, k) => mesh.localToWorld(mesh.getVertexPosition(order ? order[at + k] : at + k, point)));
      normal.subVectors(points[2], points[1]).cross(edge.subVectors(points[0], points[1]));
      if (!(normal.lengthSq() > 1e-12)) continue;
      normal.normalize();
      const centre = points[0].clone().add(points[1]).add(points[2]).divideScalar(3);
      try { return new T.Raycaster(centre.clone().addScaledVector(normal, reach), normal.clone().negate()).intersectObject(mesh).length > 0; } catch { return false; }
    }
    return false;
  };
  let low = Infinity, high = -Infinity;
  for (const mesh of skinned) {
    const position = mesh.geometry.attributes.position, joints = mesh.geometry.attributes.skinIndex, weights = mesh.geometry.attributes.skinWeight;
    if (!position || !joints || !weights) throw invalid(`${name} has a rigged mesh without positions or weights.`);
    for (let i = 0; i < joints.count; i++) for (let k = 0; k < joints.itemSize; k++) {
      if (weights.getComponent(i, k) > 0 && !(joints.getComponent(i, k) < mesh.skeleton.bones.length)) throw invalid(`${name} weights a vertex to a joint it doesn’t have.`);
    }
    try {
      mesh.skeleton.update();
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
    } catch { throw invalid(`${name} has a rigged mesh the Yard can’t draw.`); }
    if (!Number.isFinite(mesh.boundingSphere?.radius)) throw invalid(`${name} has a rigged mesh the Yard can’t draw.`);
    const { min, max } = mesh.boundingBox, corner = new T.Vector3();
    for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
      corner.set(x, y, z).applyMatrix4(mesh.matrixWorld);
      low = Math.min(low, corner.y);
      high = Math.max(high, corner.y);
    }
    if (!picked(mesh)) throw invalid(`${name} has a rigged mesh the Yard can’t pick.`);
  }
  const missingBone = SKELETON[kind === 'character' ? 'character' : 'helper'].find((bone) => !bones.has(bone));
  if (missingBone) throw invalid(`${name} has no ${missingBone} bone.`);
  const clips = new Set(gltf.animations.map((clip) => clip.name));
  const wanted = kind === 'character' ? Object.values(CLIPS.character).flat() : CLIPS.helper;
  const missingClip = wanted.find((clip) => !clips.has(clip));
  if (missingClip) throw invalid(`${name} has no ${missingClip} animation.`);
  for (const clip of gltf.animations) {
    if (!Number.isFinite(clip.duration) || clip.duration <= 0 || clip.duration > 60) throw invalid(`${name} has an animation ${clip.name} that must last more than 0 and at most 60 seconds.`);
  }
  for (const clip of gltf.animations) if (!playableClip(clip)) throw invalid(`${name} has an animation with values the Yard can’t play (${clip.name}).`);
  const height = high - low;
  const anchors = ['Root', 'Hips'].map((bone) => gltf.scene.getObjectByName(bone));
  const rest = anchors.map((bone) => bone.getWorldPosition(new T.Vector3()));
  const mixer = new T.AnimationMixer(gltf.scene), at = new T.Vector3();
  for (const clip of gltf.animations) for (let step = 0; step <= 16; step++) {
    mixer.stopAllAction();
    mixer.clipAction(clip).reset().play();
    mixer.setTime(clip.duration * step / 16);
    gltf.scene.updateMatrixWorld(true);
    anchors.forEach((bone, i) => {
      bone.getWorldPosition(at);
      if (!(Math.hypot(at.x - rest[i].x, at.z - rest[i].z) <= IN_PLACE * height)) throw invalid(`${name} has a clip that moves the character instead of playing in place (${clip.name}).`);
    });
  }
  const { problem } = yardExtras(yard, kind);
  if (problem) throw invalid(`${name} ${problem}`);
}

export function checkModels(files, kind, { timeout = TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { files, kind }, resourceLimits: { maxOldGenerationSizeMb: 1024, maxYoungGenerationSizeMb: 64 } });
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(() => finish(invalid('This piece took too long to check.')), timeout);
    worker.once('message', (result) => finish(result.error ? invalid(result.error) : null));
    worker.once('error', (err) => finish(invalid(err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'This piece needs more memory than a piece may.' : 'This piece couldn’t be checked.')));
    worker.once('exit', () => finish(invalid('This piece couldn’t be checked.')));
  });
}

if (!isMainThread && workerData?.files) {
  (async () => {
    for (const { path: file, name } of workerData.files) await inspect(file, name, workerData.kind);
  })().then(() => parentPort.postMessage({}), (err) => parentPort.postMessage({ error: err.status ? err.message : 'This piece is damaged and can’t be drawn.' }));
}
