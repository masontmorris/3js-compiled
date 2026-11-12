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
const round = value => Math.round(value * 1000) / 1000;

// The load span starts before the FontFace work, so the parse is inside it, and ends at the last canvas upload.
const loadStart = scene === 'perf' ? performance.now() : null;

// Times a CanvasTexture upload: `copyExternalImageToTexture` returns after the canvas has been read.
let upload = null;
function measureUploads(queue) {
  const copy = queue.copyExternalImageToTexture;
  queue.copyExternalImageToTexture = function (source, ...rest) {
    if (source?.source?.getContext) {
      const start = performance.now();
      const result = copy.call(this, source, ...rest);
      upload = { start, end: performance.now() };
      return result;
    }
    return copy.call(this, source, ...rest);
  };
}
if (!native && globalThis.GPUQueue) measureUploads(GPUQueue.prototype);

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
if (native) {
  try { measureUploads(backend.recordingDevice.queue); } catch (error) { log(`upload timing unavailable: ${error.message}`); }
}
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

let update = () => {};
try {
  if (!SCENES[scene]) throw new Error(`no scene ${scene}`);
  update = (await SCENES[scene]({ show, log, assets: new URL('../platform/assets/', location.href) })) ?? update;
} catch (error) {
  globalThis.__sceneError = String(error?.stack ?? error);
  console.error(globalThis.__sceneError);
}
log(`scene ${scene} ready`);

let frame = 0;
let loadLogged = false;
let firstFrame = false;
const drawTimes = [];
const spanTimes = [];
function summary(values) {
  if (!values.length) return 'none';
  const sorted = [...values].sort((a, b) => a - b);
  return `median ms=${round(sorted[sorted.length >> 1])} p95 ms=${round(sorted[Math.floor(sorted.length * 0.95)])} max ms=${round(sorted.at(-1))}`;
}
function draw() {
  try {
    frame++;
    upload = null;
    const frameStart = performance.now();
    update();
    const drawEnd = performance.now();
    renderer.render(world, camera);
    if (native) globalThis.submitGpuCommands(backend.takeFrame());
    if (scene === 'dynamic') {
      if (upload) {
        drawTimes.push(drawEnd - frameStart);
        spanTimes.push(upload.end - frameStart);
      }
      if (frame % 300 === 0) {
        log(`dynamic frames=${frame} draw ${summary(drawTimes)} span ${summary(spanTimes)}`);
        drawTimes.length = 0;
        spanTimes.length = 0;
      }
    }
    if (scene === 'perf') {
      const now = performance.now();
      if (!firstFrame) { firstFrame = true; log(`perf frame1 ms=${round(now - frameStart)}`); }
      if (!loadLogged) { loadLogged = true; log(`perf loadspan ms=${round((upload?.end ?? now) - loadStart)}`); }
    }
    globalThis.__frameNumber = frame;
    if (frame === 3) globalThis.__sceneReady = true;
    requestAnimationFrame(draw);
  } catch (error) {
    globalThis.__sceneError = String(error?.stack ?? error);
    console.error(globalThis.__sceneError);
  }
}
requestAnimationFrame(draw);
