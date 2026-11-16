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
const FLIP_MS = 860;
const BURST_MS = 780;
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
renderer.toneMappingExposure = 1;
// Default clear is white. Any stray clear during the flip must stay midnight, not flash.
renderer.setClearColor(0x05060a, 1);

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

const hemi = new THREE.HemisphereLight(0xe4e9ff, 0x141824, 1.05);
scene.add(hemi);

// Warm key from the upper left. Intensities stay constant through the flip.
const key = new THREE.DirectionalLight(0xfff4e8, 2.85);
key.position.set(-6.2, 8.2, 7.4);
scene.add(key);

const fill = new THREE.DirectionalLight(0xcfd8ff, 1.05);
fill.position.set(6.4, 2.4, 5.6);
scene.add(fill);

const rim = new THREE.DirectionalLight(0xfff1dc, 0.95);
rim.position.set(1.2, 4.6, -7.6);
scene.add(rim);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;
pmrem.dispose();

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// Threshold stays above 1 so the unlit photo and QR never enter the bloom buffer.
const bloomStrength = coarseQuery.matches ? 0.28 : 0.34;
const bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), bloomStrength, 0.36, 1.4);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

const pivot = new THREE.Group();
scene.add(pivot);

const burstScene = new THREE.Scene();
const burst = createBurst();
burstScene.add(burst.group);

const state = {
  ready: false,
  face: 'front',
  flipping: false,
  flipFrom: 0,
  flipTo: 0,
  flipStart: 0,
  frames: 0,
  scrub: null,
  burst: 0,
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
  startBurst();
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
  const now = performance.now();
  if (state.scrub !== null) {
    poseAt(state.scrub, false);
  } else if (state.flipping) {
    const duration = reduceMotion ? 1 : FLIP_MS;
    const t = Math.min(1, (now - state.flipStart) / duration);
    const k = reduceMotion ? 1 : easeInOut(t);
    pivot.rotation.y = state.flipFrom + (state.flipTo - state.flipFrom) * k;
    if (t >= 1) {
      pivot.rotation.y = state.flipTo;
      state.flipping = false;
      scheduleAutoRotate();
    }
  }
  updateBurst(now);
  controls.update();
  composer.render();
  if (burst.group.visible) {
    // Draw the star after bloom so it cannot blow the whole frame through the bloom buffer.
    renderer.setRenderTarget(null);
    const previousClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(burstScene, camera);
    renderer.autoClear = previousClear;
  }
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
  get burst() {
    return state.burst;
  },
  get yaw() {
    return pivot.rotation.y;
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
  /**
   * Hold the flip at progress u (0 front, 1 back) for screenshots.
   * Pass null to release the scrub.
   */
  previewFlip(u) {
    if (u === null || u === undefined) {
      state.scrub = null;
      hideBurst();
      return;
    }
    state.scrub = Math.min(1, Math.max(0, u));
    controls.autoRotate = false;
  },
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
  g.fillStyle = '#05060a';
  g.fillRect(0, 0, 1024, 1024);
  const navy = g.createRadialGradient(512, 460, 80, 512, 512, 720);
  navy.addColorStop(0, 'rgba(18, 28, 52, 0.55)');
  navy.addColorStop(0.45, 'rgba(8, 12, 24, 0.2)');
  navy.addColorStop(1, 'rgba(0, 0, 0, 0)');
  g.fillStyle = navy;
  g.fillRect(0, 0, 1024, 1024);
  const vignette = g.createRadialGradient(512, 512, 260, 512, 512, 760);
  vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
  vignette.addColorStop(1, 'rgba(0, 0, 0, 0.72)');
  g.fillStyle = vignette;
  g.fillRect(0, 0, 1024, 1024);
  for (let i = 0; i < 70; i += 1) {
    const x = Math.random() * 1024;
    const y = Math.random() * 1024;
    const alpha = 0.12 + Math.random() * 0.38;
    const radius = Math.random() < 0.88 ? 0.7 : 1.15;
    g.fillStyle = `rgba(214, 222, 242, ${alpha})`;
    g.beginPath();
    g.arc(x, y, radius, 0, Math.PI * 2);
    g.fill();
  }
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createBurst() {
  const hexMaterial = new THREE.SpriteMaterial({
    map: makeHexagramTexture(),
    color: 0xd7e4ff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
  });
  const hex = new THREE.Sprite(hexMaterial);
  hex.center.set(0.5, 0.5);
  hex.scale.set(0.01, 0.01, 1);
  hex.visible = false;
  hex.renderOrder = 10;

  const sparkleMap = makeSparkleTexture();
  const sparkles = [];
  const group = new THREE.Group();
  group.visible = false;
  group.add(hex);
  for (let i = 0; i < 16; i += 1) {
    const material = new THREE.SpriteMaterial({
      map: sparkleMap,
      color: i % 3 === 0 ? 0xffe1f2 : 0xe7f0ff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.visible = false;
    sprite.renderOrder = 11;
    group.add(sprite);
    sparkles.push({
      sprite,
      angle: (i / 16) * Math.PI * 2 + (i % 2) * 0.18,
      speed: 2.4 + (i % 5) * 0.55,
      size: 0.16 + (i % 4) * 0.07,
      spin: (i % 2 === 0 ? 1 : -1) * (1.2 + (i % 3) * 0.4),
    });
  }
  return { group, hex, sparkles, playing: false, start: 0, reduced: false };
}

function makeHexagramTexture() {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.3;
  const draw = (offset, width, color, blur) => {
    g.save();
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.strokeStyle = color;
    g.lineWidth = width;
    g.shadowColor = color;
    g.shadowBlur = blur;
    for (const turn of [0, Math.PI]) {
      g.beginPath();
      for (let i = 0; i < 3; i += 1) {
        const angle = offset + turn + (i * 2 * Math.PI) / 3;
        const x = cx + radius * Math.cos(angle);
        const y = cy + radius * Math.sin(angle);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
      g.stroke();
    }
    g.restore();
  };
  draw(-Math.PI / 2, 34, 'rgba(150, 186, 255, 0.28)', 48);
  draw(-Math.PI / 2, 14, 'rgba(214, 228, 255, 0.7)', 18);
  draw(-Math.PI / 2, 4, 'rgba(255, 255, 255, 0.95)', 0);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeSparkleTexture() {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  const glow = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  glow.addColorStop(0, 'rgba(255, 255, 255, 1)');
  glow.addColorStop(0.35, 'rgba(214, 228, 255, 0.7)');
  glow.addColorStop(1, 'rgba(214, 228, 255, 0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function startBurst() {
  burst.playing = true;
  burst.start = performance.now();
  burst.reduced = reduceMotion;
  burst.group.visible = true;
}

function hideBurst() {
  burst.playing = false;
  burst.group.visible = false;
  burst.hex.visible = false;
  burst.hex.material.opacity = 0;
  for (const spark of burst.sparkles) {
    spark.sprite.visible = false;
    spark.sprite.material.opacity = 0;
  }
  state.burst = 0;
}

function layoutBurst(t, reduced) {
  const clamped = Math.min(1, Math.max(0, t));
  burst.group.visible = true;
  burst.hex.visible = true;
  if (reduced) {
    burst.hex.material.blending = THREE.NormalBlending;
    burst.hex.material.rotation = 0;
    burst.hex.scale.set(2.2, 2.2, 1);
    burst.hex.material.opacity = Math.sin(Math.PI * clamped) * 0.45;
    for (const spark of burst.sparkles) spark.sprite.visible = false;
    state.burst = clamped;
    return;
  }
  burst.hex.material.blending = THREE.AdditiveBlending;
  const grow = 1 - Math.pow(1 - Math.min(1, clamped / 0.68), 3);
  const scale = 0.8 + grow * 6.6;
  burst.hex.scale.set(scale, scale, 1);
  burst.hex.material.rotation = clamped * Math.PI * 1.15;
  const fadeIn = Math.min(1, clamped / 0.14);
  const fadeOut = clamped < 0.46 ? 1 : 1 - (clamped - 0.46) / 0.54;
  burst.hex.material.opacity = Math.max(0, fadeIn * fadeOut) * 0.72;
  for (const spark of burst.sparkles) {
    const dist = clamped * spark.speed;
    spark.sprite.visible = true;
    spark.sprite.position.set(Math.cos(spark.angle) * dist, Math.sin(spark.angle) * dist, 0.15);
    const sparkScale = spark.size * (1.15 - clamped * 0.45);
    spark.sprite.scale.set(sparkScale, sparkScale, 1);
    spark.sprite.material.opacity = Math.max(0, fadeIn * fadeOut) * 0.7;
    spark.sprite.material.rotation = clamped * spark.spin;
  }
  state.burst = clamped;
}

function poseAt(u, reduced) {
  const clamped = Math.min(1, Math.max(0, u));
  const k = reduced ? clamped : easeInOut(clamped);
  pivot.rotation.y = k * Math.PI;
  const burstT = reduced ? clamped : clamped * (FLIP_MS / BURST_MS);
  if (clamped <= 0 || clamped >= 1 || burstT >= 1) hideBurst();
  else layoutBurst(burstT, reduced);
}

function updateBurst(now) {
  if (state.scrub !== null || !burst.playing) return;
  const duration = burst.reduced ? 280 : BURST_MS;
  const t = Math.min(1, (now - burst.start) / duration);
  if (t >= 1) {
    hideBurst();
    return;
  }
  layoutBurst(t, burst.reduced);
}

function clampByte(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}
