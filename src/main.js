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
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

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
controls.dampingFactor = 0.055;
controls.enablePan = false;
controls.zoomToCursor = true;
controls.rotateSpeed = 1.05;
controls.zoomSpeed = 0.9;
controls.autoRotateSpeed = AUTO_ROTATE_SPEED;
// Yaw is unlimited in both directions. Polar only tilts enough for a three-quarter view.
controls.minAzimuthAngle = -Infinity;
controls.maxAzimuthAngle = Infinity;
controls.minPolarAngle = Math.PI / 2 - 0.62;
controls.maxPolarAngle = Math.PI / 2 + 0.48;
controls.target.set(0, 0, 0);

const hemi = new THREE.HemisphereLight(0xe4e9ff, 0x141824, 0.2);
scene.add(hemi);

// Low raking key from the upper left. Intensities stay constant through the flip.
const key = new THREE.DirectionalLight(0xfff1e0, 3.5);
key.position.set(-10.4, 8.2, 2.35);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 2;
key.shadow.camera.far = 32;
key.shadow.camera.left = -9;
key.shadow.camera.right = 9;
key.shadow.camera.top = 7;
key.shadow.camera.bottom = -7;
key.shadow.bias = -0.0011;
key.shadow.normalBias = 0.045;
scene.add(key);
scene.add(key.target);

const fill = new THREE.DirectionalLight(0xd5dcf0, 0.22);
fill.position.set(2.4, -0.4, 12);
scene.add(fill);

const rim = new THREE.DirectionalLight(0xfff1dc, 0.62);
rim.position.set(1.2, 4.6, -7.6);
scene.add(rim);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.42;
pmrem.dispose();

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// Threshold stays above 1 so the unlit photo and QR never enter the bloom buffer.
const bloomStrength = coarseQuery.matches ? 0.36 : 0.48;
const bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), bloomStrength, 0.32, 1.4);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

const pivot = new THREE.Group();
scene.add(pivot);

const burstScene = new THREE.Scene();
const burst = createBurst();
burstScene.add(burst.group);
const stars = buildStarfield();
scene.add(stars.points);

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

let decor = null;
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

function wrapAngle(angle) {
  const full = Math.PI * 2;
  return ((angle + Math.PI) % full + full) % full - Math.PI;
}

function flip() {
  if (!state.ready || state.flipping) return;
  const cam = new THREE.Vector3();
  camera.getWorldPosition(cam).sub(controls.target);
  const camAngle = Math.atan2(cam.x, cam.z);
  const yaw = pivot.rotation.y;
  const seeingFront = Math.cos(wrapAngle(camAngle - yaw)) > 0;
  const desired = seeingFront ? camAngle + Math.PI : camAngle;
  const delta = wrapAngle(desired - yaw);
  state.face = seeingFront ? 'back' : 'front';
  state.flipFrom = yaw;
  state.flipTo = yaw + (Math.abs(delta) < 1e-4 ? Math.PI : delta);
  state.flipStart = performance.now();
  state.flipping = true;
  controls.autoRotate = false;
  controls.enabled = false;
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

function hideFrontDecor(name) {
  if (!name || name === 'alien-grass') return false;
  return (
    name.startsWith('alien-grass') ||
    name.startsWith('alien-flora') ||
    name.startsWith('mushroom') ||
    name.startsWith('moon') ||
    name.startsWith('rock-pillar') ||
    name.startsWith('planet') ||
    name.startsWith('asteroid') ||
    name.startsWith('pond') ||
    name.startsWith('spore') ||
    name.startsWith('glow') ||
    name.startsWith('crystal') ||
    name.startsWith('grass-glow')
  );
}

function isSealScript(name) {
  return name.startsWith('text-乐');
}

function isLettering(name) {
  return name.startsWith('text-') || name.startsWith('txt') || name.startsWith('name-flower');
}

async function dressCard(root) {
  const paper = new THREE.MeshStandardMaterial({
    color: 0xf4f2ec,
    metalness: 0,
    roughness: 0.58,
    emissive: 0x000000,
    emissiveIntensity: 0,
    envMapIntensity: 0.18,
    side: THREE.DoubleSide,
  });
  root.traverse((object) => {
    const name = object.name || '';
    if (hideFrontDecor(name)) object.visible = false;
    if (!object.isMesh) return;
    if (isSealScript(name)) {
      recolorTrim(object, 0xf3ead8, 0.02, 0.58, 0.12);
      object.visible = true;
      object.renderOrder = 3;
    } else if (isLettering(name)) {
      object.material = paper;
      object.visible = true;
      object.renderOrder = 2;
    }
    if (name === 'seal') {
      recolorTrim(object, 0x6b0d08, 0.08, 0.5, 0.16);
      object.renderOrder = 2;
    }
    if (name === 'photo-gold-lip' || name === 'photo-bezel') {
      object.visible = false;
    } else if (name === 'slab' || name.startsWith('slab')) {
      recolorTrim(object, 0x2a2927, 0.22, 0.68);
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material) continue;
        material.polygonOffset = true;
        material.polygonOffsetFactor = 4;
        material.polygonOffsetUnits = 4;
      }
    }
    if (name === 'meadow-grass' || name === 'meadow-grass-blades' || name === 'meadow-flora') {
      // The lawn was coplanar with the card, so the whole green field strobed.
      object.castShadow = false;
      object.receiveShadow = false;
      object.renderOrder = name === 'meadow-grass' ? 0 : 1;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material) continue;
        material.polygonOffset = true;
        material.polygonOffsetFactor = name === 'meadow-grass' ? 1 : -2;
        material.polygonOffsetUnits = name === 'meadow-grass' ? 1 : -2;
        material.depthWrite = true;
        material.needsUpdate = true;
      }
      if (name === 'meadow-grass') object.position.y = 0.03;
      else object.position.y += 0.018;
    }
  });
  const grass = root.getObjectByName('alien-grass');
  if (grass) grass.visible = false;
  const faceA = root.getObjectByName('faceA-alien');
  const faceB = root.getObjectByName('faceB-forest');
  const terrain = await buildLunarTerrain(faceA);
  addBackPlates(faceB);
  addTypeShadows(root);
  const glass = buildGlassPanel(faceA);
  const skyMaps = await loadSkyMaps();
  const front = buildFrontSky(faceA, skyMaps, terrain);
  const forest = buildForestLife(faceB);
  void terrain;
  return {
    update(now, reduced) {
      const t = now * 0.001;
      front.update(t, reduced);
      forest.update(t, reduced);
      glass.update(t, reduced);
    },
  };
}

function recolorTrim(object, color, metalness, roughness, envMapIntensity = 0.4) {
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  for (const material of materials) {
    if (!material || !material.color) continue;
    material.map = null;
    material.emissiveMap = null;
    material.color.set(color);
    if (material.emissive) material.emissive.set(0x000000);
    material.emissiveIntensity = 0;
    material.metalness = metalness;
    material.roughness = roughness;
    material.envMapIntensity = envMapIntensity;
    material.needsUpdate = true;
  }
}

function addTypeShadows(root) {
  const ink = new THREE.MeshBasicMaterial({
    color: 0x140e0a,
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 2,
  });
  const meshes = [];
  root.traverse((object) => {
    if (!object.isMesh) return;
    const name = object.name || '';
    if (name.startsWith('shadow-') || isSealScript(name) || !isLettering(name)) return;
    meshes.push(object);
  });
  for (const mesh of meshes) {
    const shadow = new THREE.Mesh(mesh.geometry, ink);
    shadow.name = `shadow-${mesh.name}`;
    shadow.position.copy(mesh.position);
    shadow.quaternion.copy(mesh.quaternion);
    shadow.scale.copy(mesh.scale);
    shadow.position.x += 0.007;
    shadow.position.z += 0.006;
    shadow.position.y -= 0.008;
    shadow.castShadow = false;
    shadow.receiveShadow = false;
    shadow.renderOrder = -1;
    mesh.parent.add(shadow);
  }
}

const PLATE_RADIUS = 0.12;
const PLATE_HAIRLINE = 0.01;

function addBackPlates(faceB) {
  if (!faceB) return;
  const texts = [];
  faceB.updateWorldMatrix(true, true);
  faceB.traverse((object) => {
    if (!object.isMesh) return;
    const name = object.name || '';
    if (name.startsWith('shadow-') || !isLettering(name)) return;
    const box = new THREE.Box3().setFromObject(object);
    const corners = [
      new THREE.Vector3(box.min.x, box.min.y, box.min.z),
      new THREE.Vector3(box.max.x, box.max.y, box.max.z),
    ];
    for (const corner of corners) faceB.worldToLocal(corner);
    texts.push({
      name,
      minX: Math.min(corners[0].x, corners[1].x),
      maxX: Math.max(corners[0].x, corners[1].x),
      minZ: Math.min(corners[0].z, corners[1].z),
      maxZ: Math.max(corners[0].z, corners[1].z),
    });
  });
  const column = texts.filter((item) => !/whatsapp/i.test(item.name) && item.maxX < -0.4);
  if (column.length) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const item of column) {
      minX = Math.min(minX, item.minX);
      maxX = Math.max(maxX, item.maxX);
      minZ = Math.min(minZ, item.minZ);
      maxZ = Math.max(maxZ, item.maxZ);
    }
    addFrostedPlate(faceB, minX - 0.18, maxX + 0.16, minZ - 0.16, maxZ + 0.16);
  }
  const whats = texts.find((item) => /whatsapp/i.test(item.name));
  if (whats) {
    addFrostedPlate(faceB, whats.minX - 0.14, whats.maxX + 0.14, whats.minZ - 0.07, whats.maxZ + 0.07);
  }
}

function addFrostedPlate(parent, minX, maxX, minZ, maxZ) {
  const width = maxX - minX;
  const height = maxZ - minZ;
  const radius = Math.min(PLATE_RADIUS, width / 2, height / 2);
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;

  const shadow = makePlateShadow(width, height, radius);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(centerX + 0.02, 0.004, centerZ + 0.016);
  shadow.renderOrder = -4;
  parent.add(shadow);

  const hairline = new THREE.Mesh(
    new THREE.ShapeGeometry(roundedRectRing(width, height, radius, PLATE_HAIRLINE), 10),
    new THREE.MeshBasicMaterial({
      color: 0xf4f2ec,
      transparent: true,
      opacity: 0.15,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    }),
  );
  hairline.name = 'contact-plate-hairline';
  hairline.rotation.x = -Math.PI / 2;
  hairline.position.set(centerX, 0.008, centerZ);
  hairline.renderOrder = -3;
  parent.add(hairline);

  const plate = new THREE.Mesh(
    new THREE.ShapeGeometry(roundedRectShape(width, height, radius), 10),
    new THREE.MeshBasicMaterial({
      color: 0x0c100c,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    }),
  );
  plate.name = 'contact-plate';
  plate.rotation.x = -Math.PI / 2;
  plate.position.set(centerX, 0.012, centerZ);
  plate.renderOrder = -2;
  parent.add(plate);
}

function roundedRectShape(width, height, radius) {
  const shape = new THREE.Shape();
  traceRoundedRect(shape, width, height, radius, false);
  return shape;
}

function roundedRectRing(width, height, radius, stroke) {
  const outer = roundedRectShape(width + stroke * 2, height + stroke * 2, radius + stroke);
  const hole = new THREE.Path();
  traceRoundedRect(hole, width, height, radius, true);
  outer.holes.push(hole);
  return outer;
}

function traceRoundedRect(path, width, height, radius, reversed) {
  const x = -width / 2;
  const y = -height / 2;
  const r = Math.max(0.001, Math.min(radius, width / 2, height / 2));
  if (!reversed) {
    path.moveTo(x + r, y);
    path.lineTo(x + width - r, y);
    path.absarc(x + width - r, y + r, r, -Math.PI / 2, 0, false);
    path.lineTo(x + width, y + height - r);
    path.absarc(x + width - r, y + height - r, r, 0, Math.PI / 2, false);
    path.lineTo(x + r, y + height);
    path.absarc(x + r, y + height - r, r, Math.PI / 2, Math.PI, false);
    path.lineTo(x, y + r);
    path.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
    return;
  }
  path.moveTo(x + r, y);
  path.absarc(x + r, y + r, r, Math.PI * 1.5, Math.PI, true);
  path.lineTo(x, y + height - r);
  path.absarc(x + r, y + height - r, r, Math.PI, Math.PI / 2, true);
  path.lineTo(x + width - r, y + height);
  path.absarc(x + width - r, y + height - r, r, Math.PI / 2, 0, true);
  path.lineTo(x + width, y + r);
  path.absarc(x + width - r, y + r, r, 0, -Math.PI / 2, true);
}

function makePlateShadow(width, height, radius) {
  const ppm = 96;
  const blur = 0.055;
  const pad = blur * 2.6;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(8, Math.ceil((width + pad * 2) * ppm));
  canvas.height = Math.max(8, Math.ceil((height + pad * 2) * ppm));
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.filter = `blur(${Math.max(1, blur * ppm)}px)`;
  g.fillStyle = 'rgba(0, 0, 0, 0.32)';
  traceRoundRect(g, pad * ppm, pad * ppm, width * ppm, height * ppm, radius * ppm);
  g.fill();
  g.filter = 'none';
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width + pad * 2, height + pad * 2),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
  );
  mesh.name = 'contact-plate-shadow';
  return mesh;
}

function traceRoundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

async function buildLunarTerrain(faceA) {
  const base = import.meta.env.BASE_URL;
  const [albedoImg, heightImg, normalImg, detailImg] = await Promise.all([
    loadImage(`${base}moon/albedo.jpg`),
    loadImage(`${base}moon/height.png`),
    loadImage(`${base}moon/normal.jpg`),
    loadImage(`${base}moon/detail-normal.jpg`),
  ]);
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const albedo = new THREE.CanvasTexture(shadeTextPlateau(albedoImg));
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.anisotropy = aniso;
  albedo.generateMipmaps = true;
  const normal = new THREE.Texture(normalImg);
  normal.colorSpace = THREE.LinearSRGBColorSpace;
  normal.anisotropy = aniso;
  normal.needsUpdate = true;
  const detail = new THREE.Texture(detailImg);
  detail.colorSpace = THREE.LinearSRGBColorSpace;
  detail.wrapS = detail.wrapT = THREE.RepeatWrapping;
  detail.repeat.set(5, 3);
  detail.anisotropy = aniso;
  detail.needsUpdate = true;

  const sample = document.createElement('canvas');
  sample.width = heightImg.width;
  sample.height = heightImg.height;
  const sg = sample.getContext('2d', { willReadFrequently: true });
  sg.drawImage(heightImg, 0, 0);
  const pixels = sg.getImageData(0, 0, sample.width, sample.height).data;
  const segX = 200;
  const segZ = 120;
  const geo = new THREE.PlaneGeometry(9.05, 5.42, segX, segZ);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const width = sample.width;
  const height = sample.height;
  const sampleRaw = (u, v) => {
    const x = Math.min(width - 1, Math.max(0, u * (width - 1)));
    const y = Math.min(height - 1, Math.max(0, (1 - v) * (height - 1)));
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const tx = x - x0;
    const ty = y - y0;
    const at = (ix, iy) => pixels[(iy * width + ix) * 4] / 255;
    const row0 = at(x0, y0) * (1 - tx) + at(x1, y0) * tx;
    const row1 = at(x0, y1) * (1 - tx) + at(x1, y1) * tx;
    return row0 * (1 - ty) + row1 * ty;
  };
  const du = 4 / width;
  const dv = 4 / height;
  const shaped = (raw) => {
    const n = Math.min(1, Math.max(0, (raw - 0.1) / 0.74));
    return n ** 0.72;
  };
  const heightAt = (x, z, ignoreCraters) => {
    const u = (x + CARD_HALF_W) / CARD_W;
    const v = (-z + CARD_HALF_H) / CARD_H;
    const mask = contentMask(u, v);
    const raw = sampleRaw(u, v);
    const ridge = raw - (
      sampleRaw(u + du, v) + sampleRaw(u - du, v) + sampleRaw(u, v + dv) + sampleRaw(u, v - dv)
    ) / 4;
    let h = (shaped(raw) * (1 - mask) + PLATEAU_LEVEL * mask) * RELIEF_AMP;
    h += ridge * 2.4 * (1 - mask);
    if (!ignoreCraters) h += embedDelta(x, z) * (1 - mask);
    return Math.max(0, h);
  };
  for (let i = 0; i < pos.count; i += 1) {
    pos.setY(i, heightAt(pos.getX(i), pos.getZ(i), false));
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    map: albedo,
    normalMap: normal,
    normalScale: new THREE.Vector2(0.95, 0.95),
    bumpMap: detail,
    bumpScale: 0.008,
    roughness: 0.96,
    metalness: 0,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.position.y = 0.0;
  mesh.name = 'lunar-terrain';
  faceA.add(mesh);
  liftFrontContent(faceA, PLATEAU_LEVEL * RELIEF_AMP + 0.05);
  return { mesh, heightAt };
}

const CARD_W = 9.05;
const CARD_H = 5.42;
const CARD_HALF_W = CARD_W / 2;
const CARD_HALF_H = CARD_H / 2;
const RELIEF_AMP = 0.82;
const PLATEAU_LEVEL = 0.56;
const EMBEDDED = [
  { key: 'earth', x: 0.55, z: 2.46, radius: 0.32, bury: 0.3, crater: 0.56, depth: 0.44, rim: 0.1 },
  { key: 'mars', x: 4.18, z: 0.55, radius: 0.26, bury: 0.24, crater: 0.48, depth: 0.34, rim: 0.09 },
  { key: 'moon', x: 3.22, z: -2.36, radius: 0.2, bury: 0.16, crater: 0.38, depth: 0.24, rim: 0.07 },
];

function embedDelta(x, z) {
  let lift = 0;
  for (const site of EMBEDDED) {
    const n = Math.hypot(x - site.x, z - site.z) / site.crater;
    if (n > 1.85) continue;
    const bowl = n < 1 ? (1 - n * n) * (1 - 0.22 * n * n) : 0;
    const rim = Math.exp(-(((n - 1.02) / 0.16) ** 2));
    lift += -site.depth * bowl + site.rim * rim;
  }
  return lift;
}

function liftFrontContent(faceA, surface) {
  const sealBase = surface + 0.02;
  faceA.traverse((object) => {
    if (!object.isMesh || object.name === 'lunar-terrain') return;
    const name = object.name || '';
    if (name === 'seal') object.position.y = sealBase;
    else if (isSealScript(name)) object.position.y = sealBase + 0.065;
    else if (name.startsWith('portrait')) object.position.y = surface + 0.085;
    else if (name.startsWith('photo-gold')) object.position.y = surface + 0.062;
    else if (name.startsWith('photo-')) object.position.y = surface + 0.018;
    else if (isLettering(name)) object.position.y = surface + 0.06;
  });
}

function contentMask(u, v) {
  return Math.max(
    plateauMask(u, 0, 0.5, v, 0, 1, 0.07),
    plateauMask(u, 0.56, 0.955, v, 0.14, 0.86, 0.035),
  );
}

function plateauMask(u, u0, u1, v, v0, v1, feather) {
  const sx = (u0 <= 0 ? 1 : smoothstep(u0, u0 + feather, u))
    * (u1 >= 1 ? 1 : 1 - smoothstep(u1 - feather, u1, u));
  const sy = (v0 <= 0 ? 1 : smoothstep(v0, v0 + feather, v))
    * (v1 >= 1 ? 1 : 1 - smoothstep(v1 - feather, v1, v));
  return sx * sy;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0 || 1)));
  return t * t * (3 - 2 * t);
}

function shadeTextPlateau(image) {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const g = canvas.getContext('2d');
  g.drawImage(image, 0, 0);
  g.globalCompositeOperation = 'multiply';
  const fade = g.createLinearGradient(canvas.width * 0.02, 0, canvas.width * 0.55, 0);
  fade.addColorStop(0, 'rgba(28, 26, 24, 0.46)');
  fade.addColorStop(0.72, 'rgba(28, 26, 24, 0.28)');
  fade.addColorStop(1, 'rgba(255, 255, 255, 1)');
  g.fillStyle = fade;
  g.fillRect(0, canvas.height * 0.05, canvas.width * 0.56, canvas.height * 0.9);
  return canvas;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${url}`));
    image.src = url;
  });
}

const SUN_RADIUS = 1.38;

function loadSkyMaps() {
  const base = `${import.meta.env.BASE_URL}planets/`;
  const files = ['earth.jpg', 'moon.jpg', 'mars.jpg', 'jupiter.jpg', 'saturn.jpg', 'saturn-ring.png'];
  return Promise.all(files.map((file) => loadTexture(`${base}${file}`))).then((loaded) => ({
    earth: loaded[0],
    moon: loaded[1],
    mars: loaded[2],
    jupiter: loaded[3],
    saturn: loaded[4],
    ring: loaded[5],
  }));
}

function loadTexture(url) {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      resolve(texture);
    }, undefined, () => reject(new Error(`Could not load ${url}`)));
  });
}

function buildGlassPanel(faceA) {
  const photo = faceA.getObjectByName('portrait-photo');
  const bezel = faceA.getObjectByName('photo-bezel');
  const lip = faceA.getObjectByName('photo-gold-lip');
  if (bezel) bezel.visible = false;
  if (lip) lip.visible = false;
  if (!photo) return { update() {} };
  faceA.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(photo);
  const min = box.min.clone();
  const max = box.max.clone();
  faceA.worldToLocal(min);
  faceA.worldToLocal(max);
  const width = Math.abs(max.x - min.x);
  const height = Math.abs(max.z - min.z);
  const centerX = (min.x + max.x) / 2;
  const centerZ = (min.z + max.z) / 2;
  const surface = Math.max(min.y, max.y);
  const group = new THREE.Group();
  group.position.set(centerX, surface, centerZ);
  faceA.add(group);

  const rimShape = roundedRectShape(width + 0.11, height + 0.11, 0.07);
  const hole = new THREE.Path();
  traceRoundedRect(hole, width - 0.012, height - 0.012, 0.045, true);
  rimShape.holes.push(hole);
  const rimGeo = new THREE.ExtrudeGeometry(rimShape, {
    depth: 0.028,
    bevelEnabled: true,
    bevelThickness: 0.007,
    bevelSize: 0.014,
    bevelSegments: 2,
    curveSegments: 10,
  });
  rimGeo.rotateX(-Math.PI / 2);
  rimGeo.translate(0, -0.01, 0);
  const rim = new THREE.Mesh(rimGeo, new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0.06,
    transmission: 1,
    thickness: 0.18,
    ior: 1.52,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    envMapIntensity: 1.6,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  }));
  rim.name = 'photo-glass-rim';
  rim.renderOrder = 3;
  group.add(rim);

  const sheen = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 0.992, height * 0.992),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        varying vec3 vWorldNormal;
        varying vec3 vWorld;
        void main() {
          vWorldNormal = normalize(mat3(modelMatrix) * normal);
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: `
        varying vec3 vWorldNormal;
        varying vec3 vWorld;
        void main() {
          vec3 viewDir = normalize(cameraPosition - vWorld);
          vec3 normal = normalize(vWorldNormal);
          vec3 lightDir = normalize(vec3(-4.0, 6.0, 3.0));
          vec3 halfDir = normalize(lightDir + viewDir);
          float spec = pow(max(dot(normal, halfDir), 0.0), 28.0);
          float broad = pow(max(dot(normal, halfDir), 0.0), 4.0);
          float fres = pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0);
          float glow = spec * 0.42 + broad * 0.06 + fres * 0.1;
          gl_FragColor = vec4(1.0, 0.97, 0.9, 1.0) * glow;
        }
      `,
    }),
  );
  sheen.rotation.x = -Math.PI / 2;
  sheen.position.y = 0.02;
  sheen.name = 'photo-glass-sheen';
  sheen.renderOrder = 4;
  group.add(sheen);
  return {
    update() {},
  };
}

function buildFrontSky(faceA, maps, terrain) {
  const group = new THREE.Group();
  faceA.add(group);
  const sun = buildSun();
  sun.group.position.set(5.15, -0.12, -3.05);
  group.add(sun.group);
  const jupiter = makePlanet(maps.jupiter, 0.7, 0xcbb892, 0.22, 0.12, 1.05);
  const saturn = makeSaturn(maps.saturn, maps.ring);
  jupiter.group.position.set(-6.2, 1.35, -1.45);
  saturn.group.position.set(6.85, 1.55, 0.05);
  group.add(jupiter.group, saturn.group);
  const embedded = EMBEDDED.map((site) => {
    const planet = makePlanet(
      maps[site.key],
      site.radius,
      site.key === 'earth' ? 0x8ec8ff : site.key === 'mars' ? 0xffb090 : 0xd5dbe6,
      site.key === 'earth' ? 0.15 : site.key === 'mars' ? 0.12 : 0.05,
      site.key === 'earth' ? 0.4 : 0.2,
      site.key === 'earth' ? 1.15 : site.key === 'mars' ? 0.85 : 0.55,
      true,
    );
    const ground = terrain.heightAt(site.x, site.z, true);
    planet.group.position.set(site.x, ground - site.radius * site.bury, site.z);
    const shade = new THREE.Mesh(
      new THREE.CircleGeometry(site.radius * 0.92, 28),
      new THREE.MeshBasicMaterial({
        color: 0x050403,
        transparent: true,
        opacity: 0.38,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    );
    shade.rotation.x = -Math.PI / 2;
    shade.position.y = site.radius * site.bury + 0.012;
    shade.renderOrder = 1;
    planet.group.add(shade);
    group.add(planet.group);
    return planet;
  });
  const planets = [jupiter, saturn, ...embedded];
  const lamp = new THREE.PointLight(0xffc48a, 110, 0, 2);
  sun.group.add(lamp);
  return {
    update(t, reduced) {
      const flick = reduced ? 0 : Math.sin(t * 1.6) * 0.02 + Math.sin(t * 3.8) * 0.01;
      sun.material.emissiveIntensity = 2.45 + flick;
      sun.corona.material.opacity = 0.7 + flick;
      sun.inner.material.opacity = 0.46 + flick * 0.25;
      if (!reduced) sun.paint(t);
      const time = reduced ? 0.6 : t;
      for (const planet of planets) planet.spin.rotation.y = time * planet.rate;
    },
  };
}

function buildSun() {
  const painted = makeSunTexture();
  const material = new THREE.MeshStandardMaterial({
    color: 0x2a1206,
    emissive: 0xfff3d4,
    emissiveMap: painted.tex,
    emissiveIntensity: 2.45,
    roughness: 1,
    metalness: 0,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(SUN_RADIUS, 48, 32), material);
  const corona = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeCoronaTexture(),
    color: 0xffc56a,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  corona.scale.set(SUN_RADIUS * 2.85, SUN_RADIUS * 2.85, 1);
  const inner = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeCoronaTexture(),
    color: 0xffe7b0,
    transparent: true,
    opacity: 0.36,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  inner.scale.set(SUN_RADIUS * 1.55, SUN_RADIUS * 1.55, 1);
  const group = new THREE.Group();
  group.add(mesh, corona, inner);
  return { group, material, corona, inner, paint: painted.paint };
}

function makePlanet(map, radius, glow, rate, tilt, atmoStrength, embedded = false) {
  const material = new THREE.MeshStandardMaterial({
    map,
    roughness: embedded ? 0.78 : 0.62,
    metalness: 0.03,
    envMapIntensity: 0.4,
  });
  const body = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), material);
  body.castShadow = embedded;
  body.receiveShadow = embedded;
  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.06, 40, 28),
    atmosphereMaterial(glow, atmoStrength),
  );
  const spin = new THREE.Group();
  spin.add(body);
  spin.rotation.z = tilt;
  const group = new THREE.Group();
  group.add(spin, atmo);
  return { group, spin, rate };
}

function makeSaturn(map, ringMap) {
  const radius = 0.58;
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 48, 32),
    new THREE.MeshStandardMaterial({
      map,
      roughness: 0.55,
      metalness: 0.04,
      envMapIntensity: 0.45,
    }),
  );
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(radius * 1.35, radius * 2.15, 96),
    new THREE.MeshStandardMaterial({
      map: ringMap,
      transparent: true,
      side: THREE.DoubleSide,
      roughness: 0.5,
      metalness: 0.04,
      depthWrite: false,
      alphaTest: 0.04,
    }),
  );
  ring.rotation.x = Math.PI / 2;
  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.07, 40, 28),
    atmosphereMaterial(0xffe3b8, 0.95),
  );
  const spin = new THREE.Group();
  spin.add(body, ring);
  const tilt = new THREE.Group();
  // Opening of about 27 degrees, so the rings read as an ellipse, not a face-on disc.
  tilt.rotation.x = 1.1;
  tilt.add(spin);
  const group = new THREE.Group();
  group.add(tilt, atmo);
  return { group, spin, rate: 0.2 };
}

function atmosphereMaterial(color, strength) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    toneMapped: false,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uStrength: { value: strength },
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vWorld;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uStrength;
      varying vec3 vNormal;
      varying vec3 vWorld;
      void main() {
        vec3 viewDir = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - abs(dot(normalize(vNormal), viewDir)), 2.4);
        float glow = fres * uStrength;
        gl_FragColor = vec4(uColor * glow * 1.8, glow);
      }
    `,
  });
}



function buildForestLife(faceB) {
  const group = new THREE.Group();
  faceB.add(group);
  const clouds = buildClouds();
  const butterflies = buildButterflies();
  const fireflies = buildFireflies();
  group.add(clouds.group, butterflies.group, fireflies.points);
  return {
    update(t, reduced) {
      const time = reduced ? 0 : t;
      clouds.update(time);
      butterflies.update(time, reduced);
      fireflies.update(time, reduced);
    },
  };
}

function buildClouds() {
  const map = makeGlowTexture('#ffffff');
  const group = new THREE.Group();
  const clouds = [];
    const spots = [
    [2.6, 1.35, -0.2, 1.15],
    [3.5, 1.7, 0.55, 1.35],
    [1.9, 1.15, 1.05, 0.95],
    [4.0, 1.45, -1.15, 1.05],
  ];
  for (let i = 0; i < spots.length; i += 1) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map,
      color: 0xf4f1ea,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
    }));
    sprite.renderOrder = 4;
    const [x, y, z, scale] = spots[i];
    sprite.position.set(x, y, z);
    sprite.scale.set(scale, scale * 0.62, 1);
    group.add(sprite);
    clouds.push({ sprite, x, y, z, scale, phase: i * 1.7 });
  }
  return {
    group,
    update(t) {
      for (const cloud of clouds) {
        cloud.sprite.position.x = cloud.x + Math.sin(t * 0.08 + cloud.phase) * 0.35;
        cloud.sprite.position.z = cloud.z + Math.cos(t * 0.06 + cloud.phase) * 0.22;
        cloud.sprite.position.y = cloud.y + Math.sin(t * 0.12 + cloud.phase) * 0.06;
      }
    },
  };
}

function buildButterflies() {
  const group = new THREE.Group();
  const items = [];
  const spots = [
    [-2.6, 0.42, 0.4],
    [-1.4, 0.55, -1.3],
    [-3.1, 0.36, 1.4],
    [0.8, 0.48, 1.8],
  ];
  for (let i = 0; i < spots.length; i += 1) {
    const wing = new THREE.MeshStandardMaterial({
      color: i % 2 ? 0xf4efe2 : 0xe7d7b0,
      roughness: 0.55,
      metalness: 0.04,
      side: THREE.DoubleSide,
      emissive: 0x2a2112,
      emissiveIntensity: 0.12,
    });
    const geo = new THREE.PlaneGeometry(0.14, 0.09);
    const left = new THREE.Mesh(geo, wing);
    const right = new THREE.Mesh(geo, wing);
    left.position.x = -0.06;
    right.position.x = 0.06;
    const bug = new THREE.Group();
    bug.add(left, right);
    bug.position.set(spots[i][0], spots[i][1], spots[i][2]);
    group.add(bug);
    items.push({ bug, left, right, home: spots[i], phase: i * 1.4 });
  }
  return {
    group,
    update(t, reduced) {
      for (const item of items) {
        const flap = reduced ? 0.4 : Math.sin(t * 9 + item.phase);
        item.left.rotation.y = 0.4 + flap * 0.7;
        item.right.rotation.y = -0.4 - flap * 0.7;
        const [x, y, z] = item.home;
        item.bug.position.set(
          x + Math.sin(t * 0.45 + item.phase) * 0.28,
          y + Math.sin(t * 0.9 + item.phase) * 0.08,
          z + Math.cos(t * 0.38 + item.phase) * 0.22,
        );
        item.bug.rotation.y = t * 0.4 + item.phase;
      }
    },
  };
}

function buildFireflies() {
  const count = 22;
  const positions = new Float32Array(count * 3);
  const phases = new Float32Array(count);
  const homes = [];
  for (let i = 0; i < count; i += 1) {
    const left = i < 12;
    const x = left ? -3.6 + (i % 4) * 0.55 : 1.6 + (i % 4) * 0.55;
    const z = left ? -1.8 + Math.floor(i / 4) * 0.85 : -1.6 + Math.floor((i - 12) / 4) * 0.9;
    const y = 0.2 + (i % 4) * 0.08;
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    phases[i] = i * 0.7;
    homes.push({ x, y, z, phase: phases[i] });
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('phase', new THREE.BufferAttribute(phases, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      attribute float phase;
      varying float vBlink;
      uniform float uTime;
      void main() {
        float blink = 0.25 + 0.75 * pow(max(sin(uTime * 1.5 + phase), 0.0), 2.0);
        vBlink = blink;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = (5.5 + 6.0 * blink) * (7.0 / max(0.001, -mv.z));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      varying float vBlink;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float d = dot(p, p);
        if (d > 1.0) discard;
        float a = smoothstep(1.0, 0.15, d) * vBlink;
        gl_FragColor = vec4(1.05, 0.92, 0.38, 1.0) * a;
      }
    `,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = 5;
  const position = geometry.getAttribute('position');
  return {
    points,
    update(t, reduced) {
      material.uniforms.uTime.value = reduced ? 1.2 : t;
      if (reduced) return;
      for (let i = 0; i < homes.length; i += 1) {
        const home = homes[i];
        position.setXYZ(
          i,
          home.x + Math.sin(t * 0.33 + home.phase) * 0.12,
          home.y + Math.sin(t * 0.5 + home.phase) * 0.05,
          home.z + Math.cos(t * 0.27 + home.phase) * 0.1,
        );
      }
      position.needsUpdate = true;
    },
  };
}

function makeSunTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const paint = (time) => {
    const image = ctx.createImageData(size, size);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const n = hashNoise(x * 0.11 + time * 0.85, y * 0.11 - time * 0.55);
        const grain = hashNoise(x * 0.23 - time * 0.4, y * 0.19 + time * 0.3);
        const heat = Math.min(1, n * 0.72 + grain * 0.45);
        const i = (y * size + x) * 4;
        image.data[i] = 255;
        image.data[i + 1] = 148 + heat * 90;
        image.data[i + 2] = 42 + heat * 70;
        image.data[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    texture.needsUpdate = true;
  };
  paint(0);
  return { tex: texture, paint };
}

function makeSaturnTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const bands = ['#e6d3a1', '#c9ae78', '#efe2c2', '#b99662', '#dfc99a', '#a88455', '#f3e6c8'];
  bands.forEach((color, i) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, (i * canvas.height) / bands.length, canvas.width, canvas.height / bands.length + 1);
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeRingTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 256, 32);
  const bands = [0.15, 0.55, 0.28, 0.72, 0.2, 0.48, 0.12];
  bands.forEach((alpha, i) => {
    ctx.fillStyle = `rgba(226, 210, 176, ${alpha})`;
    const y = (i * 32) / bands.length;
    ctx.fillRect(0, y, 256, 32 / bands.length);
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeCoronaTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const glow = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  glow.addColorStop(0, 'rgba(255, 236, 196, 0.95)');
  glow.addColorStop(0.16, 'rgba(255, 196, 96, 0.55)');
  glow.addColorStop(0.38, 'rgba(255, 156, 48, 0.18)');
  glow.addColorStop(0.68, 'rgba(255, 140, 40, 0.05)');
  glow.addColorStop(1, 'rgba(255, 140, 40, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeGlowTexture(hex) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const glow = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  glow.addColorStop(0, hex);
  glow.addColorStop(0.22, hex);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function hashNoise(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  const a = s - Math.floor(s);
  const t = Math.sin((x + 4.2) * 91.3 + (y - 2.1) * 157.7) * 23421.631;
  const b = t - Math.floor(t);
  return a * 0.65 + b * 0.35;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function onLoaded(gltf) {
  const model = gltf.scene;
  pivot.add(model);
  tuneTextures(model);
  decor = await dressCard(model);
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
      controls.enabled = true;
      scheduleAutoRotate();
    }
  }
  updateBurst(now);
  if (decor) decor.update(now, reduceMotion);
  stars.update(now * 0.001, reduceMotion);
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
  look(azimuth, polar, focus) {
    if (focus) controls.target.set(focus[0], focus[1], focus[2]);
    const dist = Math.max(camera.position.distanceTo(controls.target), 8);
    const safePolar = THREE.MathUtils.clamp(polar, controls.minPolarAngle, controls.maxPolarAngle);
    camera.position.set(
      controls.target.x + dist * Math.sin(safePolar) * Math.sin(azimuth),
      controls.target.y + dist * Math.cos(safePolar),
      controls.target.z + dist * Math.sin(safePolar) * Math.cos(azimuth),
    );
    camera.lookAt(controls.target);
    controls.update();
  },
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

function buildStarfield() {
  const count = 420;
  const positions = new Float32Array(count * 3);
  const phases = new Float32Array(count);
  const sizes = new Float32Array(count);
  const rand = mulberry32(91);
  for (let i = 0; i < count; i += 1) {
    const radius = 22 + rand() * 26;
    const theta = rand() * Math.PI * 2;
    const phi = Math.acos(2 * rand() - 1);
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = radius * Math.cos(phi);
    phases[i] = rand() * Math.PI * 2;
    sizes[i] = rand() > 0.88 ? 2.8 : 1.15;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('phase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      attribute float phase;
      attribute float size;
      uniform float uTime;
      varying float vTwinkle;
      void main() {
        float twinkle = 0.72 + 0.28 * sin(uTime * 1.3 + phase);
        vTwinkle = twinkle;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * twinkle * (42.0 / max(0.001, -mv.z));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      varying float vTwinkle;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float d = dot(p, p);
        if (d > 1.0) discard;
        float a = smoothstep(1.0, 0.2, d) * vTwinkle;
        gl_FragColor = vec4(0.93, 0.95, 1.0, 1.0) * a;
      }
    `,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return {
    points,
    update(t, reduced) {
      material.uniforms.uTime.value = reduced ? 0.8 : t;
    },
  };
}

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
  const starRand = mulberry32(17);
  for (let i = 0; i < 240; i += 1) {
    const x = starRand() * 1024;
    const y = starRand() * 1024;
    const bright = starRand() > 0.9;
    const alpha = bright ? 0.72 + starRand() * 0.28 : 0.22 + starRand() * 0.4;
    const radius = bright ? 1.35 + starRand() * 0.7 : 0.55 + starRand() * 0.45;
    g.fillStyle = `rgba(232, 238, 255, ${alpha})`;
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
