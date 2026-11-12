// The platform example. It draws a quad with a PNG texture over a blue background and logs every input event it
// sees as one `E` line, so a run in Edge and a run in the host compare line by line. The scene, from `?scene=` in
// a browser or `--scene` in the host, picks how the texture loads and what else the page checks:
// `texture` loads it with TextureLoader, `blob` with fetch, a blob URL and createImageBitmap, `storage` counts runs
// in localStorage, `missing` calls a DOM method the stand-in lacks on every frame, and `gltf` also loads a glTF
// file through GLTFLoader, which fetches it with an AbortSignal.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { NativeBackend } from '../../../packages/three-native/src/NativeBackend.js';

const native = typeof globalThis.submitGpuCommands === 'function';
const scene = native ? (globalThis.__sceneName ?? 'texture') : (new URL(location.href).searchParams.get('scene') ?? 'texture');
const textureURL = new URL('assets/alpha.png', location.href).href;

const canvas = document.createElement('canvas');
canvas.width = innerWidth;
canvas.height = innerHeight;
document.body.append(canvas);

let frame = 0;
const fields = {
  KeyboardEvent: ['key', 'code', 'keyCode', 'charCode', 'location', 'repeat', 'shiftKey', 'ctrlKey', 'altKey', 'metaKey'],
  MouseEvent: ['button', 'buttons', 'clientX', 'clientY', 'offsetX', 'offsetY', 'movementX', 'movementY', 'detail', 'shiftKey'],
  PointerEvent: ['pointerId', 'pointerType', 'isPrimary', 'pressure', 'button', 'buttons', 'clientX', 'clientY', 'offsetX', 'offsetY', 'movementX', 'movementY', 'detail'],
  WheelEvent: ['deltaX', 'deltaY', 'deltaZ', 'deltaMode', 'wheelDeltaY', 'clientX', 'clientY', 'buttons'],
  FocusEvent: [],
  GamepadEvent: [],
  Event: [],
};
const name = target => target === globalThis ? 'window' : target === document ? 'document' : target?.localName ?? String(target);
function describe(event) {
  const kind = event instanceof PointerEvent ? 'PointerEvent' : event instanceof WheelEvent ? 'WheelEvent' : event instanceof MouseEvent ? 'MouseEvent'
    : event instanceof KeyboardEvent ? 'KeyboardEvent' : event instanceof FocusEvent ? 'FocusEvent' : globalThis.GamepadEvent && event instanceof GamepadEvent ? 'GamepadEvent' : 'Event';
  const values = fields[kind].map(field => `${field}=${JSON.stringify(event[field])}`);
  if (event.gamepad) values.push(`gamepad=${JSON.stringify(event.gamepad.id)}`, `index=${event.gamepad.index}`, `mapping=${event.gamepad.mapping}`);
  return `E f=${frame} ${event.type} ${kind} target=${name(event.target)} phase=${event.eventPhase} bubbles=${event.bubbles} cancelable=${event.cancelable} trusted=${event.isTrusted} ${values.join(' ')}`;
}
const logged = ['keydown', 'keypress', 'keyup', 'pointerover', 'pointerenter', 'pointerdown', 'pointermove', 'pointerup', 'pointerout',
  'pointerleave', 'gotpointercapture', 'lostpointercapture', 'mouseover', 'mouseenter', 'mousedown', 'mousemove', 'mouseup', 'mouseout',
  'mouseleave', 'click', 'auxclick', 'dblclick', 'contextmenu', 'wheel', 'focus', 'blur', 'focusin', 'focusout', 'resize',
  'gamepadconnected', 'gamepaddisconnected'];
for (const type of logged) addEventListener(type, event => console.log(describe(event)), { capture: true });
addEventListener('contextmenu', event => event.preventDefault());
// A wheel listener on an element is not passive, so wheel events become cancelable; Shift+wheel is canceled.
canvas.addEventListener('wheel', event => { if (event.shiftKey) event.preventDefault(); }, { passive: false });
canvas.addEventListener('wheel', event => console.log(`E f=${frame} wheel-canceled ${event.defaultPrevented}`));
const wide = matchMedia('(min-width: 1100px)');
console.log(`E f=${frame} media (min-width: 1100px) ${wide.matches}`);
wide.addEventListener('change', event => console.log(`E f=${frame} media-change ${event.media} ${event.matches}`));
addEventListener('resize', () => console.log(`E f=${frame} resize-state innerWidth=${innerWidth} innerHeight=${innerHeight} devicePixelRatio=${devicePixelRatio}`));
canvas.addEventListener('pointerdown', event => { if (event.button === 2) canvas.setPointerCapture(event.pointerId); });
// KeyF focuses a text field and KeyG blurs it, so focus moves the same way in Edge and in the host.
const field = document.createElement('input');
field.style.position = 'absolute';
field.style.left = '-1000px';
document.body.append(field);
addEventListener('keydown', event => {
  if (event.code === 'KeyF') field.focus();
  if (event.code === 'KeyG') field.blur();
  if (event.code === 'KeyF' || event.code === 'KeyG') console.log(`E f=${frame} active=${name(document.activeElement)} typing=${document.activeElement.matches('input, textarea, [contenteditable]')}`);
});

let pads = '';
function logGamepads() {
  const state = JSON.stringify(navigator.getGamepads().map(pad => pad && { index: pad.index, id: pad.id, mapping: pad.mapping, buttons: pad.buttons.map(button => +button.pressed), values: pad.buttons.map(button => +button.value.toFixed(3)), axes: pad.axes.map(axis => +axis.toFixed(3)) }));
  if (state !== pads) console.log(`E f=${frame} gamepads ${state}`);
  pads = state;
}

const backend = native ? new NativeBackend({ canvas }, { features: ['core-features-and-limits'] }) : undefined;
const renderer = new THREE.WebGPURenderer({ canvas, backend, antialias: false });
renderer.setSize(innerWidth, innerHeight, false);
await renderer.init();
const world = new THREE.Scene();
world.background = new THREE.Color(0x2a4d78);
const camera = new THREE.OrthographicCamera(-innerWidth / 2, innerWidth / 2, innerHeight / 2, -innerHeight / 2, -1, 1);
const material = new THREE.MeshBasicNodeMaterial({ transparent: true, color: 0xffffff });
const quad = new THREE.Mesh(new THREE.PlaneGeometry(512, 512), material);
world.add(quad);
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  Object.assign(camera, { left: -innerWidth / 2, right: innerWidth / 2, top: innerHeight / 2, bottom: -innerHeight / 2 });
  camera.updateProjectionMatrix();
});

// The Display P3 fixture: TextureLoader converts it to sRGB as an image element does, and ImageBitmapLoader keeps
// its stored values, as colorSpaceConversion 'none' does.
const P3 = new URL('../../crates/host/tests/fixtures/color/iccp-p3.png', location.href).href;
async function loadTexture() {
  if (scene === 'p3') return new THREE.TextureLoader().loadAsync(P3);
  if (scene === 'p3-bitmap') {
    const texture = new THREE.Texture(await new THREE.ImageBitmapLoader().setOptions({ imageOrientation: 'flipY' }).loadAsync(P3));
    texture.flipY = false;
    texture.needsUpdate = true;
    return texture;
  }
  if (scene === 'blob') {
    const blob = await (await fetch(textureURL)).blob();
    const url = URL.createObjectURL(blob);
    const bitmap = await createImageBitmap(await (await fetch(url)).blob(), { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    URL.revokeObjectURL(url);
    const texture = new THREE.Texture(bitmap);
    texture.flipY = false;
    texture.needsUpdate = true;
    return texture;
  }
  return new THREE.TextureLoader().loadAsync(textureURL);
}
const texture = await loadTexture();
texture.colorSpace = THREE.SRGBColorSpace;
if (scene.startsWith('p3')) {
  texture.magFilter = texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
}
material.map = texture;
material.needsUpdate = true;
console.log(`E texture ${scene} ${texture.image.width}x${texture.image.height}`);

if (scene === 'gltf') {
  const gltf = await new GLTFLoader().loadAsync(new URL('../scenes/assets/tetrahedron.glb', location.href).href);
  gltf.scene.scale.setScalar(180);
  gltf.scene.rotation.set(0.6, 0.8, 0);
  gltf.scene.position.z = -0.5;
  world.add(gltf.scene, new THREE.AmbientLight(0xffffff, 1.5));
  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(1, 2, 3);
  world.add(light);
  camera.near = -1000;
  camera.far = 1000;
  camera.updateProjectionMatrix();
  let meshes = 0;
  gltf.scene.traverse(object => { if (object.isMesh) meshes++; });
  console.log(`E gltf meshes=${meshes}`);
}

if (scene === 'storage') {
  const runs = Number(localStorage.getItem('e5-runs') ?? 0) + 1;
  const big = localStorage.getItem('e5-big');
  console.log(`E storage runs=${runs} keys=${localStorage.length} big=${big?.length ?? 0} text=${localStorage.getItem('e5-text')}`);
  localStorage.setItem('e5-runs', String(runs));
  localStorage.setItem('e5-big', 'x'.repeat(1 << 20));
  localStorage.setItem('e5-text', 'héllo, 世界 🚗');
  world.background = new THREE.Color(runs > 1 ? 0x2f8f3a : 0x8f2f2f);
}

function draw() {
  try {
    frame++;
    logGamepads();
    if (scene === 'missing' && native) canvas.requestFullscreen();
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
