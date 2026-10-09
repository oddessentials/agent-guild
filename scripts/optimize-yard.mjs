// Build-time optimization only; the shipped models need no decoder or WASM.
import { readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { NodeIO, Logger } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, weld, quantize } from '@gltf-transform/functions';
import { PROVIDER_ORDER } from '../web/yard/model.mjs';

const directory=new URL('../web/yard/assets/',import.meta.url);
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS);
let before=0,after=0;
// GLB embeds images, which the browser decodes from blob: URLs that the
// manager's content security policy does not allow. Move each one to
// maps/<model>-<n>.<ext> beside the models, referenced by relative URI, and
// drop its bytes from the binary chunk.
async function externalizeImages(file,model) {
  const glb=await readFile(file);
  const jsonLength=glb.readUInt32LE(12);
  const json=JSON.parse(glb.toString('utf8',20,20+jsonLength));
  if(!json.images?.some(image=>image.bufferView!==undefined))return;
  const binStart=20+jsonLength+8,bin=glb.subarray(binStart,binStart+glb.readUInt32LE(20+jsonLength));
  const views=json.bufferViews,imageViews=new Set();
  await mkdir(new URL('maps/',directory),{recursive:true});
  for(const [i,image] of json.images.entries()) {
    if(image.bufferView===undefined)continue;
    const view=views[image.bufferView];imageViews.add(image.bufferView);
    const uri=`maps/${model}-${i}.${image.mimeType.split('/')[1]}`;
    await writeFile(new URL(uri,directory),bin.subarray(view.byteOffset||0,(view.byteOffset||0)+view.byteLength));
    delete image.bufferView;image.uri=uri;
  }
  const remap=new Map(),kept=[],chunks=[];let offset=0;
  for(const [i,view] of views.entries()) {
    if(imageViews.has(i))continue;
    const bytes=bin.subarray(view.byteOffset||0,(view.byteOffset||0)+view.byteLength);
    const pad=(4-offset%4)%4;if(pad)chunks.push(Buffer.alloc(pad));offset+=pad;
    remap.set(i,kept.length);kept.push({...view,byteOffset:offset});chunks.push(bytes);offset+=bytes.length;
  }
  json.bufferViews=kept;
  for(const accessor of json.accessors||[])if(accessor.bufferView!==undefined)accessor.bufferView=remap.get(accessor.bufferView);
  const body=Buffer.concat(chunks),binPad=Buffer.alloc((4-body.length%4)%4);
  json.buffers[0].byteLength=body.length;
  const text=Buffer.from(JSON.stringify(json)),jsonPad=Buffer.alloc((4-text.length%4)%4,0x20);
  const header=Buffer.alloc(12),jsonHead=Buffer.alloc(8),binHead=Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);
  jsonHead.writeUInt32LE(text.length+jsonPad.length,0);jsonHead.writeUInt32LE(0x4e4f534a,4);
  binHead.writeUInt32LE(body.length+binPad.length,0);binHead.writeUInt32LE(0x004e4942,4);
  header.writeUInt32LE(12+8+text.length+jsonPad.length+8+body.length+binPad.length,8);
  await writeFile(file,Buffer.concat([header,jsonHead,text,jsonPad,binHead,body,binPad]));
}
// Optional names (e.g. `guild`) limit the pass to those models.
const only=process.argv.slice(2).map(name=>name+'.glb');
for(const name of (await readdir(directory)).filter(name=>name.endsWith('.glb')&&(!only.length||only.includes(name))).sort()) {
  const file=fileURLToPath(new URL(name,directory));
  before+=(await stat(file)).size;
  const document=await io.read(file);
  document.setLogger(new Logger(Logger.Verbosity.WARN));
  // Quantization adjusts mesh transforms. Keep the public hall anchor on an
  // unchanged parent so the renderer can still position provider buildings.
  for(const node of document.getRoot().listNodes()) {
    if(!PROVIDER_ORDER.some(id=>node.getName()==='hall_'+id) || !node.getMesh())continue;
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
  await externalizeImages(file,name.slice(0,-4));
  after+=(await stat(file)).size;
}
console.log(`Yard models: ${(before/1048576).toFixed(2)} → ${(after/1048576).toFixed(2)} MiB`);
