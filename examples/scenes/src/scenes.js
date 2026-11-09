import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import tetrahedron from '../assets/tetrahedron.glb';
import { names } from './names.js';


function setup() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x28313c);
  const camera = new THREE.PerspectiveCamera(40, 1280 / 720, 0.1, 100);
  camera.position.set(5, 4, 7);
  camera.lookAt(0, 0.5, 0);
  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(4, 7, 5);
  scene.add(light);
  return { scene, camera, light };
}

function addFloor(scene) {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.MeshStandardMaterial({ color: 0x8c938d, roughness: 0.8 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
}

function checker(normal = false, alpha = false) {
  const size = 64;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const bright = ((x >> 3) + (y >> 3)) % 2 === 0;
    pixels[i] = normal ? (bright ? 160 : 96) : (bright ? 230 : 40);
    pixels[i + 1] = normal ? (bright ? 96 : 160) : (bright ? 170 : 90);
    pixels[i + 2] = normal ? 245 : (bright ? 80 : 180);
    pixels[i + 3] = alpha && !bright ? 0 : 255;
  }
  const texture = new THREE.DataTexture(pixels, size, size);
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

function box(scene, material, x = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), material);
  mesh.position.set(x, 0.8, 0);
  mesh.rotation.set(0.15, 0.35, 0);
  mesh.castShadow = true;
  scene.add(mesh);
  return mesh;
}

export async function buildScene(name, renderer) {
  if (!names.includes(name)) throw new Error(`Unknown scene: ${name}`);
  const result = setup();
  const { scene, camera, light } = result;
  if (name === 'basic-cube') {
    box(scene, new THREE.MeshBasicMaterial({ color: 0x44aadd }));
  } else if (name === 'materials') {
    box(scene, new THREE.MeshStandardMaterial({ color: 0xc26a38, roughness: 0.7 }), -1.1);
    box(scene, new THREE.MeshPhysicalMaterial({ color: 0x58a4d8, metalness: 0.4, roughness: 0.2, clearcoat: 1 }), 1.1);
    addFloor(scene);
  } else if (name === 'textures') {
    box(scene, new THREE.MeshStandardMaterial({ map: checker(), normalMap: checker(true), roughness: 0.5 }));
    addFloor(scene);
  } else if (name === 'standard-shadow') {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    light.position.set(-5, 8, 2);
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.camera.left = -5;
    light.shadow.camera.right = 5;
    light.shadow.camera.top = 5;
    light.shadow.camera.bottom = -5;
    box(scene, new THREE.MeshStandardMaterial({ color: 0xe68045, roughness: 0.5 }));
    addFloor(scene);
  } else if (name === 'instancing') {
    camera.position.set(0, 22, 28);
    camera.lookAt(0, 0, 0);
    const geometry = new THREE.BoxGeometry(0.28, 0.28, 0.28);
    const material = new THREE.MeshStandardMaterial({ color: 0x66b4db });
    const instanced = new THREE.InstancedMesh(geometry, material, 1000);
    const batched = new THREE.BatchedMesh(1000, 1000, 2000, material);
    const geometryId = batched.addGeometry(geometry);
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < 2000; i++) {
      const x = (i % 50 - 24.5) * 0.42;
      const z = (Math.floor(i / 50) - 19.5) * 0.42;
      matrix.makeTranslation(x, 0.2, z);
      if (i < 1000) instanced.setMatrixAt(i, matrix);
      else batched.setMatrixAt(batched.addInstance(geometryId), matrix);
    }
    instanced.instanceMatrix.needsUpdate = true;
    scene.add(instanced, batched);
  } else if (name === 'gltf') {
    const bytes = tetrahedron.buffer.slice(tetrahedron.byteOffset, tetrahedron.byteOffset + tetrahedron.byteLength);
    const gltf = await new GLTFLoader().parseAsync(bytes, '');
    gltf.scene.position.y = 1;
    scene.add(gltf.scene);
    addFloor(scene);
  } else if (name === 'msaa') {
    box(scene, new THREE.MeshStandardMaterial({ color: 0xe68045 }));
    addFloor(scene);
    const target = new THREE.RenderTarget(1280, 720, { samples: 4 });
    const display = new THREE.Scene();
    const displayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    display.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: target.texture, toneMapped: false })));
    result.render = () => {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.render(display, displayCamera);
    };
  } else if (name === 'alpha') {
    box(scene, new THREE.MeshStandardMaterial({ map: checker(false, true), alphaTest: 0.5, side: THREE.DoubleSide }), -1.1);
    box(scene, new THREE.MeshStandardMaterial({ color: 0x66b4db, opacity: 0.5, alphaHash: true }), 1.1);
    addFloor(scene);
  } else if (name === 'invalid-wgsl') {
    const material = new THREE.MeshBasicNodeMaterial();
    material.name = 'invalid-wgsl-material';
    material.colorNode = TSL.wgslFn('fn invalidColor() -> vec3<f32> { return vec3<f32>(; }')();
    box(scene, material, -1.1);
    box(scene, new THREE.MeshBasicMaterial({ color: 0x44cc66 }), 1.1);
  }
  result.render ??= () => renderer.render(scene, camera);
  return result;
}
