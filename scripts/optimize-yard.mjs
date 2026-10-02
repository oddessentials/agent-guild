// Build-time optimization only; the shipped models need no decoder or WASM.
import { readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { NodeIO, Logger } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, weld, quantize } from '@gltf-transform/functions';

const directory=new URL('../web/yard/assets/',import.meta.url);
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS);
let before=0,after=0;
for(const name of (await readdir(directory)).filter(name=>name.endsWith('.glb')).sort()) {
  const file=fileURLToPath(new URL(name,directory));
  before+=(await stat(file)).size;
  const document=await io.read(file);
  document.setLogger(new Logger(Logger.Verbosity.WARN));
  // Quantization adjusts mesh transforms. Keep the public hall anchor on an
  // unchanged parent so the renderer can still position provider buildings.
  for(const node of document.getRoot().listNodes()) {
    if(!/^hall_(anthropic|openai|google|xai|shell)$/.test(node.getName()) || !node.getMesh())continue;
    const anchor=document.createNode(node.getName()).setMatrix(node.getMatrix());
    node.setName(node.getName()+'_mesh');
    const parents=node.listParents().filter(parent=>parent.propertyType==='Node'||parent.propertyType==='Scene');
    for(const parent of parents){parent.removeChild(node);parent.addChild(anchor);}
    node.setTranslation([0,0,0]).setRotation([0,0,0,1]).setScale([1,1,1]);
    anchor.addChild(node);
  }
  // Preserve named hall transforms, the renderer's anchors, and skeletal clips.
  // Rounding sub-millimetre position noise also makes the release archive smaller.
  for(const mesh of document.getRoot().listMeshes())for(const primitive of mesh.listPrimitives()) {
    const position=primitive.getAttribute('POSITION');
    if(position?.getComponentType()!==5126)continue;
    const array=position.getArray();
    for(let i=0;i<array.length;i++)array[i]=Math.round(array[i]*10000)/10000;
  }
  await document.transform(
    weld({cleanup:false}),
    dedup({keepUniqueNames:true}),
    quantize({pattern:/^(POSITION|NORMAL|TANGENT|WEIGHTS_\d+)$/,quantizePosition:14,quantizeNormal:10,quantizeWeight:8}),
  );
  await io.write(file,document);
  after+=(await stat(file)).size;
}
console.log(`Yard models: ${(before/1048576).toFixed(2)} → ${(after/1048576).toFixed(2)} MiB`);
