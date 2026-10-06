import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root=new URL('../',import.meta.url);
await mkdir(new URL('../web/yard/vendor/',import.meta.url),{recursive:true});
await build({
  absWorkingDir:fileURLToPath(root),
  // Export the renderer's surface so unused Three.js APIs can be removed.
  stdin: { contents: `export {
  ACESFilmicToneMapping, AgXToneMapping, AnimationMixer, CapsuleGeometry, Color, CylinderGeometry, DirectionalLight,
  DoubleSide, Group, HemisphereLight, LoadingManager, MOUSE, MathUtils,
  Matrix4, Mesh, MeshBasicMaterial, NoColorSpace, MeshStandardMaterial, OrthographicCamera,
  EquirectangularReflectionMapping, PCFSoftShadowMap, PMREMGenerator, PlaneGeometry, Raycaster, RepeatWrapping, RingGeometry, SRGBColorSpace, ShadowMaterial,
  Scene, TOUCH, TextureLoader, Vector2, Vector3, WebGLRenderer,
} from 'three';
export { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
export { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
export { OrbitControls } from 'three/addons/controls/OrbitControls.js';
export { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';`, resolveDir:fileURLToPath(root), sourcefile: 'yard-engine.js' },
  outfile: 'web/yard/vendor/engine.js', bundle:true, format:'esm', minify:true,
  legalComments:'inline', target:['es2022'],
});
await copyFile(new URL('node_modules/three/LICENSE',root),new URL('web/yard/vendor/LICENSE.three',root));
console.log('Built the local Yard engine.');
