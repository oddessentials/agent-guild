import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir(new URL('../web/yard/vendor/',import.meta.url),{recursive:true});
await build({
  stdin: { contents: `export * from 'three';
export { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
export { OrbitControls } from 'three/addons/controls/OrbitControls.js';
export { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';`, resolveDir: process.cwd(), sourcefile: 'yard-engine.js' },
  outfile: 'web/yard/vendor/engine.js', bundle:true, format:'esm', minify:true,
  legalComments:'inline', target:['es2022'],
});
await copyFile('node_modules/three/LICENSE','web/yard/vendor/LICENSE.three');
console.log('Built the local Yard engine.');
