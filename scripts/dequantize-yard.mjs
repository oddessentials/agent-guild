// Copies Yard models without KHR_mesh_quantization, which Godot 4 cannot
// import, for a client built on it (docs/yard/CONTRACT.md).
//   node scripts/dequantize-yard.mjs OUT_DIR model.glb ...
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize } from '@gltf-transform/functions';
import path from 'node:path';

const [out, ...files] = process.argv.slice(2);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
for (const file of files) {
  const document = await io.read(file);
  await document.transform(dequantize());
  for (const extension of document.getRoot().listExtensionsUsed())
    if (extension.extensionName === 'KHR_mesh_quantization') extension.dispose();
  await io.write(path.join(out, path.basename(file)), document);
}
