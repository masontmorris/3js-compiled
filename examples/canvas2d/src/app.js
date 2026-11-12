// The canvas 2D example. Each scene draws 2D canvases and shows them through THREE.Texture, as folio does, on
// quads at one texel per pixel over a gray background, so a screenshot in Edge and one from the host compare the
// canvas pixels and the upload together. The scene comes from `?scene=` in a browser or `--scene` in the host, and
// `#pally=<folder URL>` names where Pally's font files are, since Pally's license keeps them out of the repo.
// Each scene logs `R` lines, such as measureText results, for the two runs to compare.
import * as THREE from 'three/webgpu';
import { NativeBackend } from '../../../packages/three-native/src/NativeBackend.js';
import { SCENES } from './scenes.js';

const native = typeof globalThis.submitGpuCommands === 'function';
const scene = native ? (globalThis.__sceneName ?? 'folio') : (new URL(location.href).searchParams.get('scene') ?? 'folio');
const pallyBase = new URLSearchParams(location.hash.slice(1)).get('pally');
const log = line => console.log(`R ${line}`);

function fontURL(file) {
  return new URL(`fonts/${file}`, location.href).href;
}
const fonts = [];
fonts.push(new FontFace('Amatic SC', `url(${fontURL('AmaticSC-Bold.ttf')})`, { weight: '700' }));
fonts.push(new FontFace('Nunito', `url(${fontURL('Nunito-wght.ttf')})`, { weight: '200 1000' }));
if (pallyBase) {
  for (const [file, weight] of [['Pally-Regular.ttf', '400'], ['Pally-Medium.ttf', '500'], ['Pally-Bold.ttf', '700']]) {
    fonts.push(new FontFace('Pally', `url(${new URL(file, pallyBase).href})`, { weight }));
  }
}
for (const font of fonts) document.fonts.add(font);
await Promise.all(fonts.map(font => font.load().catch(error => log(`font ${font.family} ${font.weight} failed: ${error.message}`))));

const canvas = document.createElement('canvas');
canvas.width = innerWidth;
canvas.height = innerHeight;
document.body.append(canvas);
const backend = native ? new NativeBackend({ canvas }, { features: ['core-features-and-limits'] }) : undefined;
const renderer = new THREE.WebGPURenderer({ canvas, backend, antialias: false });
renderer.setSize(innerWidth, innerHeight, false);
await renderer.init();
const world = new THREE.Scene();
world.background = new THREE.Color(0x404040);
const camera = new THREE.OrthographicCamera(0, innerWidth, 0, -innerHeight, -1, 1);

// Shows a 2D canvas with its top-left corner at (x, y) in window pixels, a texel to a pixel.
function show(source, x, y) {
  const texture = new THREE.Texture(source);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  const material = new THREE.MeshBasicNodeMaterial({ map: texture, transparent: true });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  const place = () => {
    quad.scale.set(source.width, source.height, 1);
    quad.position.set(x + source.width / 2, -(y + source.height / 2), 0);
  };
  place();
  world.add(quad);
  return { texture, place };
}

if (!SCENES[scene]) throw new Error(`no scene ${scene}`);
const update = (await SCENES[scene]({ show, log })) ?? (() => {});
log(`scene ${scene} ready`);

let frame = 0;
function draw() {
  try {
    frame++;
    update();
    renderer.render(world, camera);
    if (native) globalThis.submitGpuCommands(backend.takeFrame());
    if (frame === 3) globalThis.__sceneReady = true;
    requestAnimationFrame(draw);
  } catch (error) {
    globalThis.__sceneError = String(error?.stack ?? error);
    console.error(globalThis.__sceneError);
  }
}
requestAnimationFrame(draw);
