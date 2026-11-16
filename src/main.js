import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import './style.css';

const MODEL_URL = `${import.meta.env.BASE_URL}card-island.glb`;
const FOV = 27;
const FIT_MARGIN = 1.075;
const IDLE_MS = 2600;
const FLIP_MS = 900;
const AUTO_ROTATE_SPEED = 0.7;

const canvas = document.getElementById('view');
const loadingEl = document.getElementById('loading');
const loadingLabel = document.getElementById('loading-label');
const barEl = document.getElementById('bar');
const flipButton = document.getElementById('flip');

const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const coarseQuery = window.matchMedia('(pointer: coarse)');

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
});
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.02;

const gl = renderer.getContext();
const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
const rendererName = debugInfo
  ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
  : gl.getParameter(gl.RENDERER);
const softwareGL = /swiftshader|llvmpipe|softpipe|software/i.test(rendererName || '');
const pixelCap = softwareGL ? 1 : coarseQuery.matches ? 1.35 : 1.75;
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelCap));

const scene = new THREE.Scene();
scene.background = makeBackground();

const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 200);
camera.position.set(0, 0, 12);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.zoomToCursor = true;
controls.rotateSpeed = 0.85;
controls.zoomSpeed = 0.9;
controls.autoRotateSpeed = AUTO_ROTATE_SPEED;
controls.minPolarAngle = Math.PI * 0.22;
controls.maxPolarAngle = Math.PI * 0.78;
controls.target.set(0, 0, 0);

const hemi = new THREE.HemisphereLight(0xf4e9ff, 0xf3e2d4, 0.7);
scene.add(hemi);

// Warm key from the upper left. The card yaws, so this light stays on
// whichever face is turned toward the camera.
const key = new THREE.DirectionalLight(0xfff3e6, 2.05);
key.position.set(-6.2, 7.8, 7.2);
scene.add(key);

const fill = new THREE.DirectionalLight(0xe6dcff, 0.62);
fill.position.set(6.2, 2.1, 5.4);
scene.add(fill);

const rim = new THREE.DirectionalLight(0xfff6ec, 0.7);
rim.position.set(1.2, 4.4, -7.5);
scene.add(rim);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.4;
pmrem.dispose();

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// Threshold stays above 1 so unlit white (photo, QR) stays sharp.
// Emissive bulbs, crystals and name-dots sit above that and pick up the halo.
const bloomStrength = coarseQuery.matches ? 0.28 : 0.4;
const bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), bloomStrength, 0.48, 1.05);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

const pivot = new THREE.Group();
scene.add(pivot);

const state = {
  ready: false,
  face: 'front',
  flipping: false,
  flipFrom: 0,
  flipTo: 0,
  flipStart: 0,
  frames: 0,
  error: null,
  interacted: false,
  textures: { photo: null, qr: null },
  bounds: null,
};

let reduceMotion = motionQuery.matches;
let idleTimer = 0;

motionQuery.addEventListener('change', (event) => {
  reduceMotion = event.matches;
  if (reduceMotion) controls.autoRotate = false;
  else scheduleAutoRotate();
});

function scheduleAutoRotate() {
  window.clearTimeout(idleTimer);
  controls.autoRotate = false;
  if (reduceMotion || !state.ready) return;
  idleTimer = window.setTimeout(() => {
    if (!state.flipping) controls.autoRotate = true;
  }, IDLE_MS);
}

function poke() {
  state.interacted = true;
  scheduleAutoRotate();
}

controls.addEventListener('start', () => {
  canvas.classList.add('is-dragging');
  poke();
});
controls.addEventListener('end', () => {
  canvas.classList.remove('is-dragging');
  scheduleAutoRotate();
});
canvas.addEventListener('wheel', poke, { passive: true });

function flip() {
  if (!state.ready || state.flipping) return;
  state.face = state.face === 'front' ? 'back' : 'front';
  state.flipFrom = pivot.rotation.y;
  let target = state.face === 'back' ? Math.PI : 0;
  // Keep turning in the same direction so a second flip doesn't unwind awkwardly.
  if (target < state.flipFrom - Math.PI * 0.5) target += Math.PI * 2;
  state.flipTo = target;
  state.flipStart = performance.now();
  state.flipping = true;
  controls.autoRotate = false;
  flipButton.setAttribute('aria-pressed', state.face === 'back' ? 'true' : 'false');
}

function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

flipButton.addEventListener('click', flip);

let lastTap = 0;
let pointerDown = null;
canvas.addEventListener('pointerdown', (event) => {
  pointerDown = { x: event.clientX, y: event.clientY, id: event.pointerId };
});
canvas.addEventListener('pointerup', (event) => {
  if (!pointerDown || pointerDown.id !== event.pointerId) return;
  const moved = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y);
  pointerDown = null;
  if (moved > 12) {
    lastTap = 0;
    return;
  }
  const now = performance.now();
  if (now - lastTap < 320) {
    lastTap = 0;
    flip();
  } else {
    lastTap = now;
  }
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'f' || event.key === 'F') {
    event.preventDefault();
    flip();
  }
});

function setProgress(fraction) {
  const clamped = Math.max(0, Math.min(1, fraction));
  barEl.style.transform = `scaleX(${clamped})`;
}

function fail(message) {
  state.error = message;
  loadingLabel.textContent = message;
  loadingEl.classList.remove('hide');
}

function frameCamera() {
  const box = new THREE.Box3().setFromObject(pivot);
  state.bounds = {
    min: box.min.toArray(),
    max: box.max.toArray(),
  };
  // The slab centre is the origin. Decor is not symmetric, so fit the
  // extents around that origin instead of recentering the model.
  controls.target.set(0, 0, 0);
  const aspect = Math.max(0.3, camera.aspect);
  const halfY = Math.max(Math.abs(box.min.y), Math.abs(box.max.y), 0.001);
  const halfX = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), 0.001);
  const vFov = (camera.fov * Math.PI) / 180;
  const distY = halfY / Math.tan(vFov / 2);
  const distX = halfX / (Math.tan(vFov / 2) * aspect);
  const dist = Math.max(distX, distY) * FIT_MARGIN;
  camera.position.set(0, 0, dist);
  camera.near = 0.04;
  camera.far = dist * 14;
  camera.updateProjectionMatrix();
  camera.lookAt(0, 0, 0);
  controls.minDistance = 1.7;
  controls.maxDistance = dist * 2.5;
  controls.update();
}

function resize() {
  const width = window.innerWidth;
  const height = Math.max(1, window.innerHeight);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
  composer.setSize(width, height);
  if (state.ready && !state.interacted) frameCamera();
}

function tuneTextures(root) {
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  root.traverse((object) => {
    if (!object.isMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      for (const mapKey of ['map', 'emissiveMap']) {
        const texture = material[mapKey];
        if (!texture) continue;
        const width = texture.image && (texture.image.width || texture.image.videoWidth);
        const height = texture.image && (texture.image.height || texture.image.videoHeight);
        const isQr = object.name === 'whatsapp-qr' || (width === 984 && height === 984);
        const isPhoto = object.name === 'portrait-photo' || (width === 1023 && height === 1279);
        if (isQr) {
          texture.magFilter = THREE.NearestFilter;
          texture.minFilter = THREE.NearestFilter;
          texture.generateMipmaps = false;
          texture.anisotropy = 1;
          texture.needsUpdate = true;
          state.textures.qr = [width, height];
        } else {
          texture.anisotropy = maxAniso;
        }
        if (isPhoto) state.textures.photo = [width, height];
      }
    }
  });
}

function onLoaded(gltf) {
  const model = gltf.scene;
  pivot.add(model);
  tuneTextures(model);
  resize();
  frameCamera();
  state.ready = true;
  scheduleAutoRotate();
  requestAnimationFrame(() => {
    loadingEl.classList.add('hide');
  });
}

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
loader.load(
  MODEL_URL,
  onLoaded,
  (event) => {
    if (event.total) setProgress(event.loaded / event.total);
    else setProgress(0.35);
  },
  () => fail('加载失败'),
);

window.addEventListener('resize', resize);
resize();

function animate() {
  requestAnimationFrame(animate);
  if (state.flipping) {
    const duration = reduceMotion ? 1 : FLIP_MS;
    const t = Math.min(1, (performance.now() - state.flipStart) / duration);
    const k = reduceMotion ? 1 : easeInOut(t);
    pivot.rotation.y = state.flipFrom + (state.flipTo - state.flipFrom) * k;
    if (t >= 1) {
      pivot.rotation.y = state.flipTo;
      state.flipping = false;
      scheduleAutoRotate();
    }
  }
  controls.update();
  composer.render();
  state.frames += 1;
}

animate();

window.__card = {
  get ready() {
    return state.ready;
  },
  get face() {
    return state.face;
  },
  get flipping() {
    return state.flipping;
  },
  get autoRotate() {
    return controls.autoRotate;
  },
  get frames() {
    return state.frames;
  },
  get error() {
    return state.error;
  },
  get camera() {
    return camera.position.toArray();
  },
  get distance() {
    return camera.position.distanceTo(controls.target);
  },
  get textures() {
    return state.textures;
  },
  get bounds() {
    return state.bounds;
  },
  get renderer() {
    return rendererName;
  },
  flip,
  /** Move the camera along its current view ray. Used by the headless check. */
  zoomTo(distance) {
    const offset = camera.position.clone().sub(controls.target);
    if (offset.lengthSq() < 1e-6) offset.set(0, 0, 1);
    offset.setLength(THREE.MathUtils.clamp(distance, controls.minDistance, controls.maxDistance));
    camera.position.copy(controls.target).add(offset);
    controls.update();
  },
};

function makeBackground() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 1024;
  const g = c.getContext('2d');
  const gradient = g.createLinearGradient(0, 0, 900, 1024);
  gradient.addColorStop(0, '#e4cff8');
  gradient.addColorStop(0.34, '#f4e1f4');
  gradient.addColorStop(0.62, '#f8efe4');
  gradient.addColorStop(1, '#fff7ef');
  g.fillStyle = gradient;
  g.fillRect(0, 0, 1024, 1024);
  const wash = g.createRadialGradient(800, 160, 20, 800, 180, 520);
  wash.addColorStop(0, 'rgba(255, 226, 240, 0.7)');
  wash.addColorStop(1, 'rgba(255, 226, 240, 0)');
  g.fillStyle = wash;
  g.fillRect(0, 0, 1024, 1024);
  const image = g.getImageData(0, 0, 1024, 1024);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (Math.random() - 0.5) * 2.5;
    data[i] = clampByte(data[i] + n);
    data[i + 1] = clampByte(data[i + 1] + n);
    data[i + 2] = clampByte(data[i + 2] + n);
  }
  g.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function clampByte(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}
