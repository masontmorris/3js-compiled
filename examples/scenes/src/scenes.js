import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import CubeRenderTarget from 'three/src/renderers/common/CubeRenderTarget.js';
import { cheapDOF } from './cheapDOF.js';
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
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.RenderTarget(size.x, size.y, { samples: 4 });
    const display = new THREE.Scene();
    const displayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    display.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: target.texture, toneMapped: false })));
    result.render = () => {
      renderer.getDrawingBufferSize(size);
      if (target.width !== size.x || target.height !== size.y) target.setSize(size.x, size.y);
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
  } else if (name === 'compute') {
    // 100,000 particles fall and bounce for 60 frames. The compute pass runs every frame, and from frame 60 its
    // time step is 0, so every later frame shows the same particles.
    const count = 100000;
    const positions = TSL.instancedArray(count, 'vec3');
    const velocities = TSL.instancedArray(count, 'vec3');
    const seed = offset => TSL.hash(TSL.instanceIndex.add(offset));
    const init = TSL.Fn(() => {
      positions.element(TSL.instanceIndex).assign(TSL.vec3(seed(0).sub(0.5).mul(8), seed(1).mul(4).add(0.5), seed(2).sub(0.5).mul(8)));
      velocities.element(TSL.instanceIndex).assign(TSL.vec3(seed(3).sub(0.5).mul(2), seed(4).mul(3), seed(5).sub(0.5).mul(2)));
    })().compute(count);
    const step = TSL.uniform(1 / 60);
    const update = TSL.Fn(() => {
      const position = positions.element(TSL.instanceIndex);
      const velocity = velocities.element(TSL.instanceIndex);
      velocity.y.subAssign(step.mul(9.8));
      position.addAssign(velocity.mul(step));
      TSL.If(position.y.lessThan(0), () => {
        position.y.assign(position.y.negate());
        velocity.y.assign(velocity.y.negate().mul(0.7));
      });
    })().compute(count);
    await renderer.computeAsync(init);
    const material = new THREE.SpriteNodeMaterial();
    material.positionNode = positions.toAttribute();
    material.colorNode = TSL.mix(TSL.color(0xffb347), TSL.color(0x4fc3f7), seed(6));
    material.scaleNode = TSL.float(0.035);
    const particles = new THREE.Sprite(material);
    particles.count = count;
    particles.frustumCulled = false;
    scene.add(particles);
    addFloor(scene);
    let frame = 0;
    result.readyFrame = 62;
    result.render = () => {
      step.value = frame++ < 60 ? 1 / 60 : 0;
      renderer.compute(update);
      renderer.render(scene, camera);
    };
  } else if (name === 'copy') {
    // A sphere refracts what the frame drew before it, which three copies from the canvas mid-pass.
    box(scene, new THREE.MeshStandardMaterial({ color: 0xe68045 }), -1.6);
    box(scene, new THREE.MeshStandardMaterial({ color: 0x66b4db }), 1.6);
    addFloor(scene);
    const glass = new THREE.MeshBasicNodeMaterial();
    glass.colorNode = TSL.viewportSharedTexture(TSL.screenUV.add(TSL.normalView.xy.mul(0.12))).rgb.mul(TSL.vec3(0.85, 0.95, 1));
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1.3, 48, 24), glass);
    sphere.position.set(0, 1.4, 1.2);
    sphere.renderOrder = 1;
    scene.add(sphere);
  } else if (['bloom', 'post', 'rebuild'].includes(name)) {
    // folio-2025's post chain (sources/Game/Rendering.js): bloom over the scene pass, with cheapDOF on high quality.
    [0xff5533, 0x33ddff, 0xffdd33, 0x66ff66].forEach((value, index) => {
      const material = new THREE.MeshBasicNodeMaterial();
      material.colorNode = TSL.color(value).mul(3);
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.45, 32, 16), material);
      mesh.position.set(index * 1.6 - 2.4, 0.6, index % 2 === 0 ? -1.5 : 1.5);
      scene.add(mesh);
    });
    box(scene, new THREE.MeshStandardMaterial({ color: 0x8899aa, roughness: 0.4 }));
    // cheapDOF blurs the top and bottom of the frame, so a checker floor and a row of boxes give it edges there.
    const map = checker();
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(8, 8);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.MeshStandardMaterial({ map, roughness: 0.8 }));
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
    for (let i = 0; i < 9; i++) {
      const block = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshStandardMaterial({ color: i % 2 ? 0xf0f0f0 : 0x202020 }));
      block.position.set(i * 1.1 - 6, 2.8, -5);
      scene.add(block);
    }
    const pipeline = new THREE.RenderPipeline(renderer);
    const scenePass = TSL.pass(scene, camera);
    const scenePassColor = scenePass.getTextureNode('output');
    const bloomPass = bloom(scenePassColor);
    bloomPass._nMips = 5;
    bloomPass.threshold.value = 1;
    bloomPass.strength.value = 0.25;
    bloomPass.smoothWidth.value = 1;
    const dofPass = cheapDOF(TSL.renderOutput(scenePass));
    const quality = level => {
      pipeline.outputNode = level === 0 ? dofPass.add(bloomPass) : scenePassColor.add(bloomPass);
      pipeline.needsUpdate = true;
    };
    quality(name === 'bloom' ? 1 : 0);
    let frame = 0;
    // The rebuild scene toggles quality 20 times, every 60 frames from frame 1200, as folio's quality option does.
    if (name === 'rebuild') result.readyFrame = 3600;
    result.render = () => {
      if (name === 'rebuild' && frame >= 1200 && frame < 2400 && (frame - 1200) % 60 === 0) {
        quality((frame - 1200) / 60 % 2 === 0 ? 1 : 0);
        console.log(`rebuild ${(frame - 1200) / 60 + 1} at frame ${frame}, ${Date.now()}`);
      }
      frame++;
      pipeline.render();
    };
  } else if (name === 'mrt') {
    // The scene pass writes color and emissive to two targets. The left half shows color, the right half emissive.
    box(scene, new THREE.MeshStandardMaterial({ color: 0x66b4db, emissive: 0xff3300, emissiveIntensity: 0.6 }), -1.1);
    box(scene, new THREE.MeshStandardMaterial({ color: 0xe68045, emissive: 0x2255ff, emissiveIntensity: 0.9 }), 1.1);
    addFloor(scene);
    const pipeline = new THREE.RenderPipeline(renderer);
    const scenePass = TSL.pass(scene, camera);
    scenePass.setMRT(TSL.mrt({ output: TSL.output, emissive: TSL.emissive }));
    pipeline.outputNode = TSL.mix(scenePass.getTextureNode('output'), scenePass.getTextureNode('emissive'), TSL.step(0.5, TSL.screenUV.x));
    result.render = () => pipeline.render();
  } else if (name === 'pmrem') {
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    [0, 0.25, 0.5, 1].forEach((roughness, index) => {
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.6, 48, 24), new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness }));
      sphere.position.set(index * 1.5 - 2.25, 0.7, 0);
      scene.add(sphere);
    });
    addFloor(scene);
  } else if (name === 'targets') {
    // Two render targets drawn every frame, as folio-2025 draws its tyre tracks and snow elevation, shown on two planes.
    const tracks = new THREE.RenderTarget(256, 256);
    const snow = new THREE.RenderTarget(256, 256, { type: THREE.HalfFloatType });
    const top = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2);
    top.position.z = 1;
    const tracksScene = new THREE.Scene();
    tracksScene.background = new THREE.Color(0x101010);
    const marks = Array.from({ length: 12 }, () => {
      const mark = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.5), new THREE.MeshBasicMaterial({ color: 0xd0d0d0 }));
      tracksScene.add(mark);
      return mark;
    });
    const snowScene = new THREE.Scene();
    snowScene.background = new THREE.Color(0x203040);
    const drift = new THREE.Mesh(new THREE.CircleGeometry(0.6, 48), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    snowScene.add(drift);
    const tracksPlane = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.MeshBasicMaterial({ map: tracks.texture }));
    tracksPlane.position.set(-1.7, 1.6, 0);
    const snowPlane = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.MeshStandardMaterial({ map: snow.texture }));
    snowPlane.position.set(1.7, 1.6, 0);
    scene.add(tracksPlane, snowPlane);
    addFloor(scene);
    let frame = 0;
    result.readyFrame = 62;
    result.render = () => {
      const t = Math.min(frame++, 60) / 60;
      marks.forEach((mark, i) => {
        const angle = i / marks.length * Math.PI * 2 + t * Math.PI;
        mark.position.set(Math.cos(angle) * 0.6, Math.sin(angle) * 0.6, 0);
        mark.rotation.z = angle;
      });
      drift.position.x = Math.sin(t * Math.PI) * 0.3;
      drift.scale.setScalar(0.6 + t * 0.4);
      renderer.setRenderTarget(tracks);
      renderer.render(tracksScene, top);
      renderer.setRenderTarget(snow);
      renderer.render(snowScene, top);
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    };
  } else if (name === 'warmup') {
    // folio-2025's PreRenderer: a CubeCamera draws the whole scene, hidden objects too, into a 32-pixel cube target
    // before the first frame, so the first visible frame finds its shaders compiled. The hidden objects appear then.
    const materials = [
      new THREE.MeshStandardMaterial({ color: 0xe68045, roughness: 0.4 }),
      new THREE.MeshPhysicalMaterial({ color: 0x58a4d8, clearcoat: 1 }),
      new THREE.MeshLambertMaterial({ color: 0x66cc88 }),
      new THREE.MeshToonMaterial({ color: 0xcc66cc }),
      new THREE.MeshPhongMaterial({ color: 0xdddd55, shininess: 60 }),
      new THREE.MeshBasicMaterial({ color: 0x44aadd }),
    ];
    const meshes = materials.map((material, index) => {
      const mesh = box(scene, material, index * 1.6 - 4);
      mesh.scale.setScalar(0.7);
      mesh.visible = index % 2 === 0;
      return mesh;
    });
    addFloor(scene);
    const cubeCamera = new THREE.CubeCamera(1, 100, new CubeRenderTarget(32));
    scene.add(cubeCamera);
    const invisible = meshes.filter(mesh => !mesh.visible);
    for (const mesh of invisible) mesh.visible = true;
    cubeCamera.update(renderer, scene);
    for (const mesh of invisible) mesh.visible = false;
    let frame = 0;
    result.render = () => {
      if (frame++ === 0) for (const mesh of invisible) mesh.visible = true;
      renderer.render(scene, camera);
    };
  }
  result.render ??= () => renderer.render(scene, camera);
  result.readyFrame ??= 2;
  return result;
}
