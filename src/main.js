import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SHAPES } from './shapes.js';
import { PALETTES, samplePalette } from './palettes.js';
import { startCamera, createHandTracker, analyzeHand, HAND_CONNECTIONS } from './hands.js';

const $ = (sel) => document.querySelector(sel);
const clamp = THREE.MathUtils.clamp;

/* ------------------------------------------------------------------ settings */

const settings = {
  count: innerWidth < 760 ? 8000 : 16000,
  size: 1,
  glow: 1.1,
  shape: 0,
  palette: 0,
  text: 'HELLO',
  skeleton: true,
  preview: true,
};

const BASE_SIZE = 0.26;   // particle size in world units before the size slider
const HOLD_MS = 650;      // how long ✌️ 👍 🤘 must be held before they fire
const CAM_MARGIN = 0.12;  // camera border that's awkward to reach; the inner area maps to the whole screen
const AUTO_SPIN = 0.0025; // idle rotation, radians per frame

// Physics, per frame at 60 fps.
const SPRING = 0.014;      // pull back towards the shape; lower is floatier
const DAMPING = 0.935;     // share of velocity kept each frame while the shape holds together
const SPACE_DRAG = 0.993;  // ...and after a supernova, when nothing pulls particles back
const MAX_SPEED = 7;
const REFORM_MS = 1800;    // after a rebuild the pull fades back in over this long
const COLLAPSE_MS = 450;   // a supernova's core falls inward for this long before it blows
const SHOCK_MS = 1800;     // lifetime of the shockwave ring

const GESTURES = {
  open: { icon: '✋', label: 'Push', color: '#7df9ff' },
  point: { icon: '☝️', label: 'Poke', color: '#9dffb0' },
  fist: { icon: '✊', label: 'Gather', color: '#ff7a7a' },
  pinch: { icon: '🤏', label: 'Rotate', color: '#ffd166' },
  peace: { icon: '✌️', label: 'Next shape', color: '#c99bff' },
  thumbsUp: { icon: '👍', label: 'Next color', color: '#ffb703' },
  rock: { icon: '🤘', label: 'Supernova', color: '#ff5fa2' },
  relaxed: { icon: '🖐️', label: '', color: '#ffffff' },
};

const HOLD_ACTIONS = {
  peace: () => setShape(settings.shape + 1),
  thumbsUp: () => setPalette(settings.palette + 1),
  rock: () => supernova(),
};

/* ------------------------------------------------------------------ renderer */

const canvas = $('#scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
renderer.setPixelRatio(pixelRatio);
renderer.setClearColor(0x05040a, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 800);
camera.position.z = 50;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), settings.glow, 0.4, 0.1);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const vertexShader = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aSeed;
  uniform float uTime;
  uniform float uSize;
  uniform float uScale;
  uniform vec3 uHands[2];
  uniform float uHandR[2];
  uniform float uHeat;
  varying vec3 vColor;
  varying float vFade;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vFade = smoothstep(4.0, 16.0, -mv.z); // fade out particles that fly right up to the camera

    // Particles near a hand swell and brighten.
    float glow = 0.0;
    for (int i = 0; i < 2; i++) {
      if (uHandR[i] > 0.0) glow += 1.0 - smoothstep(0.0, uHandR[i], distance(position.xy, uHands[i].xy));
    }
    glow = min(glow, 1.0);

    float twinkle = 0.75 + 0.25 * sin(uTime * (1.2 + aSeed * 3.0) + aSeed * 40.0);
    gl_PointSize = min(uSize * aSize * twinkle * (1.0 + glow * 1.4 + uHeat * 0.5) * uScale / -mv.z, 64.0);
    gl_Position = projectionMatrix * mv;
    vColor = mix(aColor, vec3(1.0), glow * 0.5);
    // A supernova leaves everything white-hot for a moment, then it cools back to its colour.
    vColor = mix(vColor, vec3(1.0, 0.85, 0.65), uHeat * (0.3 + 0.7 * aSeed));
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vFade;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    gl_FragColor = vec4(vColor, pow(1.0 - d * 2.0, 1.7) * uOpacity * vFade);
  }
`;

const material = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uSize: { value: BASE_SIZE * settings.size },
    uScale: { value: 1 },
    uOpacity: { value: 0.9 },
    uHeat: { value: 0 },
    uHands: { value: [new THREE.Vector3(), new THREE.Vector3()] },
    uHandR: { value: [0, 0] },
  },
  vertexShader,
  fragmentShader,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});

// Same look for the background stars, but they never react to hands.
const starMaterial = material.clone();
starMaterial.uniforms.uSize.value = 0.7;
starMaterial.uniforms.uOpacity.value = 0.8;

const overlay = $('#overlay');
const octx = overlay.getContext('2d');
const view = { w: 1, h: 1, halfW: 1, halfH: 1 };

function resize() {
  const w = innerWidth, h = innerHeight, dpr = window.devicePixelRatio || 1;
  renderer.setSize(w, h);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  // Size of the visible area on the z = 0 plane, where hands are mapped.
  view.halfH = camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  view.halfW = view.halfH * camera.aspect;
  view.w = w;
  view.h = h;
  material.uniforms.uScale.value = starMaterial.uniforms.uScale.value = h * pixelRatio * 0.5;
  overlay.width = w * dpr;
  overlay.height = h * dpr;
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
resize();
addEventListener('resize', resize);

function makeStars(count) {
  const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
  const size = new Float32Array(count), seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 1100;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 650;
    pos[i * 3 + 2] = -80 - Math.random() * 280;
    const b = 0.2 + Math.random() * 0.35;
    col[i * 3] = b * 0.85;
    col[i * 3 + 1] = b * 0.9;
    col[i * 3 + 2] = b;
    size[i] = 0.6 + Math.random() * 1.2;
    seed[i] = Math.random();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  return new THREE.Points(g, starMaterial);
}
const stars = makeStars(2500);
scene.add(stars);

// Supernova shockwave: an expanding ring around a fading central flash, on a camera-facing plane.
const shockMaterial = new THREE.ShaderMaterial({
  uniforms: { uProgress: { value: 0 }, uColor: { value: new THREE.Color() } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uProgress;
    uniform vec3 uColor;
    varying vec2 vUv;
    void main() {
      float d = length(vUv - 0.5) * 2.0;
      float p = uProgress;
      float ring = exp(-pow((d - p) / (0.015 + 0.06 * p), 2.0)) * 0.45 * pow(1.0 - p, 1.5);
      float core = exp(-d * d / (0.002 + 0.02 * p)) * pow(1.0 - p, 3.0);
      float a = ring + core;
      gl_FragColor = vec4(uColor * a, a);
    }
  `,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});
const shock = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shockMaterial);
shock.scale.setScalar(150);
shock.visible = false;
scene.add(shock);

/* ------------------------------------------------------------------ particles */

let N = 0, geometry = null, points = null;
let P, V, T, tParam, seeds, ball, colorCur, colorTgt;
let shapeCache = new Map();
let colorFrames = 0;

function build(count) {
  N = count;
  state.scattered = false;
  state.nova = null;
  state.heat = 0;
  shock.visible = false;
  if (points) {
    scene.remove(points);
    geometry.dispose();
  }
  P = new Float32Array(N * 3);        // positions
  V = new Float32Array(N * 3);        // velocities
  colorCur = new Float32Array(N * 3);
  colorTgt = new Float32Array(N * 3);
  ball = new Float32Array(N * 3);     // each particle's spot inside the ✊ energy ball
  seeds = new Float32Array(N);
  const sizes = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    seeds[i] = Math.random();
    sizes[i] = 0.6 + Math.pow(Math.random(), 5) * 2.4;
    const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    const r = Math.cbrt(Math.random());
    ball[i * 3] = s * Math.cos(a) * r;
    ball[i * 3 + 1] = u * r;
    ball[i * 3 + 2] = s * Math.sin(a) * r;
    // Start scattered far away so the first shape assembles itself.
    const R = 45 + Math.random() * 60;
    P[i * 3] = s * Math.cos(a) * R;
    P[i * 3 + 1] = u * R;
    P[i * 3 + 2] = s * Math.sin(a) * R;
  }

  geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(P, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colorCur, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);

  shapeCache = new Map();
  setShape(settings.shape, true);
}

function getShape(index) {
  const def = SHAPES[index];
  const key = def.id === 'text' ? `text:${settings.text}` : def.id;
  if (!shapeCache.has(key)) {
    shapeCache.set(key, def.make(N, { text: settings.text, maxWidth: Math.min(40, view.halfW * 1.8) }));
  }
  return shapeCache.get(key);
}

function setShape(index, quiet = false) {
  settings.shape = (index + SHAPES.length) % SHAPES.length;
  if (state.scattered) rebuild();
  const shape = getShape(settings.shape);
  T = shape.pos;
  tParam = shape.t;
  refreshColors();
  shapeButtons.forEach((b, i) => b.classList.toggle('active', i === settings.shape));
  if (!quiet) toast(`${SHAPES[settings.shape].icon} ${SHAPES[settings.shape].name}`);
}

function setPalette(index, quiet = false) {
  settings.palette = (index + PALETTES.length) % PALETTES.length;
  refreshColors();
  paletteButtons.forEach((b, i) => b.classList.toggle('active', i === settings.palette));
  if (!quiet) toast(`🎨 ${PALETTES[settings.palette].name}`);
}

function refreshColors() {
  const pal = PALETTES[settings.palette];
  const c = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    samplePalette(pal, tParam[i], c);
    const b = 0.7 + seeds[i] * 0.5;
    colorTgt[i * 3] = c[0] * b;
    colorTgt[i * 3 + 1] = c[1] * b;
    colorTgt[i * 3 + 2] = c[2] * b;
  }
  colorFrames = 140;
}

// Colours fade towards their targets for a couple of seconds after a change, then stop costing anything.
function updateColors(dt) {
  if (colorFrames <= 0) return;
  colorFrames -= dt;
  if (colorFrames <= 0) {
    colorCur.set(colorTgt);
  } else {
    const k = 1 - Math.pow(0.94, dt);
    for (let j = 0; j < colorCur.length; j++) colorCur[j] += (colorTgt[j] - colorCur[j]) * k;
  }
  geometry.attributes.aColor.needsUpdate = true;
}

/* ------------------------------------------------------------------ interaction state */

const state = {
  quat: new THREE.Quaternion(),
  rotVel: new THREE.Vector2(AUTO_SPIN, 0), // x: yaw, y: pitch (radians per frame)
  scale: 1,
  scaleTarget: 1,
  stretch: null,                           // two-hand resize: distance and scale when it began
  gather: 0,
  gathering: false,
  gatherCenter: new THREE.Vector3(),
  looseUntil: 0,                           // springs go slack for a moment after an explosion
  looseMs: 1,
  flash: 0,
  lastActive: -1e9,
  nova: null,                              // supernova in progress: { start, blasted }
  scattered: false,                        // after a supernova nothing pulls particles back
  reformAt: -1e9,
  heat: 0,
};

const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _sway = new THREE.Quaternion();

function rotate(yaw, pitch) {
  state.quat.premultiply(_q.setFromAxisAngle(AXIS_Y, yaw));
  state.quat.premultiply(_q.setFromAxisAngle(AXIS_X, pitch));
  state.quat.normalize();
}

function explode(center, power, looseMs) {
  for (let i = 0, i3 = 0; i < N; i++, i3 += 3) {
    const dx = P[i3] - center.x, dy = P[i3 + 1] - center.y, dz = P[i3 + 2] - center.z;
    const d = Math.hypot(dx, dy, dz) + 0.001;
    const f = power * (0.4 + Math.random() * 1.1);
    V[i3] += (dx / d) * f + (Math.random() - 0.5) * power * 0.3;
    V[i3 + 1] += (dy / d) * f + (Math.random() - 0.5) * power * 0.3;
    V[i3 + 2] += ((dz / d) * f + (Math.random() - 0.5) * power * 0.3) * 0.45; // flatter burst, less flying into the camera
  }
  state.looseUntil = performance.now() + looseMs;
  state.looseMs = looseMs;
  state.flash = Math.max(state.flash, Math.min(0.15 + power * 0.1, 0.6));
}

/* ------------------------------------------------------------------ supernova */

const _rgb = [0, 0, 0];
const rebuildHint = () => (mode === 'camera' ? 'Hold ✌️ or make a ✊ to rebuild' : 'Pick a shape to rebuild');

function randomUnit(v) {
  const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
  return v.set(s * Math.cos(a), u, s * Math.sin(a));
}

function supernova() {
  if (state.nova) return;
  if (state.scattered) {
    toast(rebuildHint());
    return;
  }
  state.nova = { start: performance.now(), blasted: false };
  toast('🤘 Supernova');
}

// The core bounces: every particle gets thrown outwards and nothing pulls it back afterwards.
function blast() {
  // Real remnants are clumpy, so a share of the debris streams along a few dozen jets.
  const jets = Array.from({ length: 40 }, () => randomUnit(new THREE.Vector3()));
  const dir = new THREE.Vector3(), jitter = new THREE.Vector3();
  for (let i = 0, i3 = 0; i < N; i++, i3 += 3) {
    if (Math.random() < 0.4) {
      dir.copy(jets[(Math.random() * jets.length) | 0]).add(randomUnit(jitter).multiplyScalar(0.2));
    } else {
      dir.set(P[i3], P[i3 + 1], P[i3 + 2]).normalize().multiplyScalar(0.5).add(randomUnit(jitter));
    }
    dir.normalize();
    // Fast ejecta leave the scene, the middle group spreads wide, and the slowest linger as a nebula.
    const r = Math.random();
    const speed = r < 0.15 ? 2.6 + Math.random() * 2.6 : r < 0.65 ? 0.6 + Math.random() * 1.4 : 0.02 + Math.random() * 0.2;
    V[i3] = dir.x * speed;
    V[i3 + 1] = dir.y * speed;
    V[i3 + 2] = dir.z * speed;
  }
  state.scattered = true;
  state.heat = 1;
  state.flash = 0.35;
  samplePalette(PALETTES[settings.palette], 0.5, _rgb);
  shockMaterial.uniforms.uColor.value.setRGB(0.6 + _rgb[0] * 0.6, 0.6 + _rgb[1] * 0.6, 0.6 + _rgb[2] * 0.6);
  shockMaterial.uniforms.uProgress.value = 0;
  shock.visible = true;
  setTimeout(() => state.scattered && toast(rebuildHint()), 2600);
}

function updateNova(dt, now) {
  const nova = state.nova;
  if (nova && !nova.blasted) {
    // Core collapse: everything falls inwards and heats up, then it blows.
    const t = Math.min((now - nova.start) / COLLAPSE_MS, 1);
    const pull = 0.01 * t * dt;
    for (let j = 0; j < N * 3; j++) V[j] -= P[j] * pull;
    state.heat = Math.max(state.heat, 0.6 * t);
    if (t >= 1) {
      blast();
      nova.blasted = true;
      nova.start = now;
    }
  } else if (nova) {
    const t = Math.min((now - nova.start) / SHOCK_MS, 1);
    shockMaterial.uniforms.uProgress.value = 1 - (1 - t) * (1 - t);
    if (t >= 1) {
      state.nova = null;
      shock.visible = false;
    }
  }
  if (!nova || nova.blasted) state.heat *= Math.pow(0.965, dt);
}

function rebuild() {
  state.scattered = false;
  state.reformAt = performance.now();
}

/* ------------------------------------------------------------------ hands */

const video = $('#video');
const hands = new Map();
let tracker = null;
let mode = 'intro'; // intro | mouse | loading | camera

// Normalised camera coords -> normalised screen coords (mirrored, like a selfie).
function camToScreen(p) {
  const span = 1 - 2 * CAM_MARGIN;
  return [1 - (p.x - CAM_MARGIN) / span, (p.y - CAM_MARGIN) / span];
}
function screenToWorld(sx, sy, out) {
  return out.set((sx * 2 - 1) * view.halfW, (1 - sy * 2) * view.halfH, 0);
}
function worldToScreen(v) {
  return [((v.x / view.halfW + 1) / 2) * view.w, ((1 - v.y / view.halfH) / 2) * view.h];
}
const worldToPx = (r) => (r / view.halfH) * (view.h / 2);

function newHand(key) {
  const v3 = () => new THREE.Vector3();
  return {
    key, seen: 0, lm: null, fresh: true,
    gesture: 'none', cand: 'none', candN: 0, holdStart: 0, fired: false,
    palm: v3(), palmT: v3(), prevPalm: v3(), palmVel: new THREE.Vector2(),
    tip: v3(), tipT: v3(), prevTip: v3(), tipVel: new THREE.Vector2(),
    pinch: v3(), pinchT: v3(), pinchPrev: null,
  };
}

function setGesture(h, gesture, now) {
  h.gesture = gesture;
  h.holdStart = now;
  h.fired = false;
  h.pinchPrev = null;
}

function onHandResults(res, now) {
  const labels = res.handednesses ?? res.handedness ?? [];
  const used = new Set();
  res.landmarks.forEach((lm, i) => {
    let key = labels[i]?.[0]?.categoryName ?? `hand${i}`;
    if (used.has(key)) key += i;
    used.add(key);

    let h = hands.get(key);
    if (!h) hands.set(key, (h = newHand(key)));
    const info = analyzeHand(lm, res.worldLandmarks?.[i], h.gesture === 'pinch');
    h.lm = lm;
    h.seen = now;
    screenToWorld(...camToScreen(info.palm), h.palmT);
    screenToWorld(...camToScreen(info.tip), h.tipT);
    screenToWorld(...camToScreen(info.pinch), h.pinchT);
    if (h.fresh) {
      h.palm.copy(h.palmT);
      h.tip.copy(h.tipT);
      h.pinch.copy(h.pinchT);
      h.fresh = false;
    }

    // A pose has to show up for a few frames in a row before it counts.
    if (info.gesture === h.cand) h.candN++;
    else {
      h.cand = info.gesture;
      h.candN = 1;
    }
    const needed = h.cand === 'pinch' || h.gesture === 'pinch' ? 2 : 3;
    if (h.cand !== h.gesture && h.candN >= needed) setGesture(h, h.cand, now);
  });
}

function cursorAt(pos, r, strength, vel, wind) {
  const m = Math.hypot(vel.x, vel.y);
  const k = m > 2.5 ? 2.5 / m : 1;
  return { x: pos.x, y: pos.y, r, r2: r * r, strength, wind, vx: vel.x * k, vy: vel.y * k };
}

const mouse = {
  pos: new THREE.Vector3(9999, 9999, 0), prev: new THREE.Vector3(9999, 9999, 0),
  vel: new THREE.Vector2(), last: -1e9, down: false, sx: 0, sy: 0,
};

// Turns the current hands (or the mouse) into forces, rotation, scale and the ✊ gather.
function updateInteraction(dt, now) {
  const cursors = [];
  const list = [...hands.values()];
  const smooth = 1 - Math.pow(0.55, dt);
  let fist = null, pinchers = 0, dragging = false;

  for (const h of list) {
    h.prevPalm.copy(h.palm);
    h.prevTip.copy(h.tip);
    h.palm.lerp(h.palmT, smooth);
    h.tip.lerp(h.tipT, smooth);
    h.pinch.lerp(h.pinchT, smooth);
    h.palmVel.set(h.palm.x - h.prevPalm.x, h.palm.y - h.prevPalm.y).divideScalar(dt);
    h.tipVel.set(h.tip.x - h.prevTip.x, h.tip.y - h.prevTip.y).divideScalar(dt);

    switch (h.gesture) {
      case 'open': cursors.push(cursorAt(h.palm, 10, 0.9, h.palmVel, 0.08)); break;
      case 'point': cursors.push(cursorAt(h.tip, 5.5, 1.2, h.tipVel, 0.08)); break;
      case 'fist': fist ??= h; break;
      case 'pinch': pinchers++; break;
      case 'none': break;
      default: cursors.push(cursorAt(h.tip, 6, 0.7, h.tipVel, 0.06));
    }

    const action = HOLD_ACTIONS[h.gesture];
    if (action && !h.fired && now - h.holdStart >= HOLD_MS) {
      h.fired = true;
      action();
    }
  }
  if (list.length) state.lastActive = now;

  // ✊ pulls everything into a ball at the fist (even scattered supernova debris); letting go blows it apart.
  if (fist) {
    if (state.scattered) rebuild();
    state.gatherCenter.lerp(fist.palm, state.gathering ? smooth : 1);
    state.gathering = true;
  } else if (state.gathering) {
    state.gathering = false;
    if (state.gather > 0.3) explode(state.gatherCenter, 0.9 + state.gather * 1.8, 600);
  }
  state.gather += ((fist ? 1 : 0) - state.gather) * (1 - Math.pow(fist ? 0.93 : 0.7, dt));

  // 🙌 two hands (both open, or both pinching): the distance between them resizes the shape.
  const pair = list.length >= 2 && !fist && pinchers !== 1 && list[0].gesture !== 'none' && list[1].gesture !== 'none';
  if (pair) {
    const d = Math.max(list[0].palm.distanceTo(list[1].palm), 1);
    state.stretch ??= { d0: d, s0: state.scaleTarget };
    state.scaleTarget = clamp((state.stretch.s0 * d) / state.stretch.d0, 0.3, 2.8);
  } else {
    state.stretch = null;
  }

  // 🤏 one pinching hand drags the rotation.
  if (pinchers === 1) {
    const h = list.find((hand) => hand.gesture === 'pinch');
    if (h.pinchPrev) {
      const yaw = (h.pinch.x - h.pinchPrev.x) * 0.06;
      const pitch = -(h.pinch.y - h.pinchPrev.y) * 0.06;
      rotate(yaw, pitch);
      state.rotVel.set(yaw / dt, pitch / dt);
    }
    (h.pinchPrev ??= new THREE.Vector3()).copy(h.pinch);
    dragging = true;
  }

  // Mouse fallback.
  mouse.vel.set(mouse.pos.x - mouse.prev.x, mouse.pos.y - mouse.prev.y).divideScalar(dt);
  mouse.prev.copy(mouse.pos);
  if (mouse.down) dragging = true;
  else if (!list.length && now - mouse.last < 2500) {
    cursors.push(cursorAt(mouse.pos, 8, 0.9, mouse.vel, 0.07));
    state.lastActive = now;
  }

  // Spin keeps going after a drag, then settles back to a slow idle turn.
  if (!dragging) {
    const ease = 1 - Math.pow(0.96, dt);
    if (SHAPES[settings.shape].sway) {
      // Flat shapes rock gently and drift back to face you instead of spinning edge-on.
      state.rotVel.multiplyScalar(1 - ease);
      rotate(state.rotVel.x * dt, state.rotVel.y * dt);
      state.quat.slerp(_sway.setFromAxisAngle(AXIS_Y, Math.sin(now / 1600) * 0.4), ease * 0.6);
    } else {
      state.rotVel.x += (AUTO_SPIN - state.rotVel.x) * ease;
      state.rotVel.y -= state.rotVel.y * ease;
      rotate(state.rotVel.x * dt, state.rotVel.y * dt);
    }
  }

  state.scale += (state.scaleTarget - state.scale) * (1 - Math.pow(0.88, dt));
  state.flash *= Math.pow(0.93, dt);
  return cursors;
}

/* ------------------------------------------------------------------ simulation */

const _rot = new THREE.Matrix4();

function updateParticles(dt, now, cursors) {
  const e = _rot.makeRotationFromQuaternion(state.quat).elements;
  const time = now / 1000;
  const s = state.scale * (1 + 0.012 * Math.sin(time * 1.4));
  const g = state.gather;
  const gc = state.gatherCenter;
  const gr = 3.2 + Math.sin(time * 9) * 0.35 * g;
  // After a supernova (and while its core collapses) nothing pulls particles back to the shape.
  const free = state.scattered || (state.nova && !state.nova.blasted);
  const loose = clamp((state.looseUntil - now) / state.looseMs, 0, 1);
  const ramp = clamp((now - state.reformAt) / REFORM_MS, 0, 1);
  const spring = free ? 0 : SPRING * (1 - 0.9 * loose) * (0.12 + 0.88 * ramp * ramp) * (1 + 3 * g) * dt;
  const damp = Math.pow(free ? SPACE_DRAG : DAMPING, dt);
  const turb = state.scattered ? 0.00015 * dt : 0;
  const maxSpeed2 = MAX_SPEED * MAX_SPEED;
  const nc = cursors.length;

  for (let i = 0, i3 = 0; i < N; i++, i3 += 3) {
    const px = P[i3], py = P[i3 + 1], pz = P[i3 + 2];
    const sd = seeds[i];
    let vx = V[i3], vy = V[i3 + 1], vz = V[i3 + 2];

    if (spring > 0) {
      // Target: the shape point, rotated and scaled, with a gentle drift.
      const bx = T[i3], by = T[i3 + 1], bz = T[i3 + 2];
      let tx = (e[0] * bx + e[4] * by + e[8] * bz) * s + Math.sin(time * 0.9 + sd * 47) * 0.15;
      let ty = (e[1] * bx + e[5] * by + e[9] * bz) * s + Math.cos(time * 0.8 + sd * 31) * 0.15;
      let tz = (e[2] * bx + e[6] * by + e[10] * bz) * s;
      if (g > 0.001) {
        tx += (gc.x + ball[i3] * gr - tx) * g;
        ty += (gc.y + ball[i3 + 1] * gr - ty) * g;
        tz += (gc.z + ball[i3 + 2] * gr - tz) * g;
      }

      // Spring towards the target; each particle is a little stiffer or looser so morphs look organic.
      const k = spring * (0.55 + sd * 0.9);
      vx += (tx - px) * k;
      vy += (ty - py) * k;
      vz += (tz - pz) * k;
    }

    // Hands push particles out of a cylinder pointing into the screen, and drag them along.
    for (let c = 0; c < nc; c++) {
      const C = cursors[c];
      const dx = px - C.x, dy = py - C.y, d2 = dx * dx + dy * dy;
      if (d2 < C.r2) {
        const d = Math.sqrt(d2) + 1e-3;
        const f = 1 - d / C.r;
        const push = f * f * C.strength * dt;
        vx += (dx / d) * push + C.vx * f * C.wind * dt;
        vy += (dy / d) * push + C.vy * f * C.wind * dt;
        vz -= push * 0.35;
      }
    }

    if (turb) {
      // A slow swirl keeps the drifting remnant alive.
      vx += Math.sin(py * 0.2 + time * 0.4 + sd * 6) * turb;
      vy += Math.sin(pz * 0.2 + time * 0.35 + sd * 6) * turb;
      vz += Math.sin(px * 0.2 + time * 0.3 + sd * 6) * turb;
    }

    vx *= damp;
    vy *= damp;
    vz *= damp;
    const v2 = vx * vx + vy * vy + vz * vz;
    if (v2 > maxSpeed2) {
      const m = MAX_SPEED / Math.sqrt(v2);
      vx *= m;
      vy *= m;
      vz *= m;
    }
    V[i3] = vx;
    V[i3 + 1] = vy;
    V[i3 + 2] = vz;
    P[i3] = px + vx * dt;
    P[i3 + 1] = py + vy * dt;
    P[i3 + 2] = pz + vz * dt;
  }
  geometry.attributes.position.needsUpdate = true;
}

// The shader can light up particles around two points: the hands, a pinch, or the ✊ ball.
function updateGlow(cursors) {
  const glows = cursors.map((c) => [c.x, c.y, c.r * 1.15]);
  for (const h of hands.values()) if (h.gesture === 'pinch') glows.push([h.pinch.x, h.pinch.y, 4.5]);
  if (state.gather > 0.05) glows.unshift([state.gatherCenter.x, state.gatherCenter.y, 7 * state.gather]);
  const u = material.uniforms;
  for (let j = 0; j < 2; j++) {
    const gl = glows[j];
    u.uHandR.value[j] = gl ? gl[2] : 0;
    if (gl) u.uHands.value[j].set(gl[0], gl[1], 0);
  }
}

/* ------------------------------------------------------------------ 2D overlay */

const previewEl = $('#preview');
const previewCanvas = $('#previewSkel');
const pctx = previewCanvas.getContext('2d');

function drawSkeleton(ctx, lm, map, color, width) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    const [x1, y1] = map(lm[a]);
    const [x2, y2] = map(lm[b]);
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  ctx.stroke();
  for (const p of lm) {
    const [x, y] = map(p);
    ctx.fillRect(x - width, y - width, width * 2, width * 2);
  }
}

const toScreenPx = (p) => {
  const [sx, sy] = camToScreen(p);
  return [sx * view.w, sy * view.h];
};

function drawOverlay(now) {
  const ctx = octx;
  ctx.clearRect(0, 0, view.w, view.h);
  ctx.textAlign = 'center';
  ctx.lineCap = 'round';
  const list = [...hands.values()];

  for (const h of list) {
    if (!h.lm) continue;
    if (settings.skeleton) drawSkeleton(ctx, h.lm, toScreenPx, 'rgba(255,255,255,0.22)', 1.5);
    const meta = GESTURES[h.gesture];
    if (!meta) continue;

    const anchor = h.gesture === 'open' || h.gesture === 'fist' ? h.palm : h.gesture === 'pinch' ? h.pinch : h.tip;
    const [x, y] = worldToScreen(anchor);
    let r = 18;
    if (h.gesture === 'open') r = worldToPx(10) * 0.9;
    else if (h.gesture === 'point') r = worldToPx(5.5) * 0.8;
    else if (h.gesture === 'pinch') r = 12;
    else if (h.gesture === 'fist') r = 30 - 12 * state.gather + Math.sin(now / 80) * 3 * state.gather;

    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = meta.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();

    if (h.gesture === 'pinch') {
      const [ax, ay] = toScreenPx(h.lm[4]);
      const [bx, by] = toScreenPx(h.lm[8]);
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.fillStyle = meta.color;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Progress ring while holding a pose that triggers something.
    if (HOLD_ACTIONS[h.gesture] && !h.fired) {
      const p = Math.min((now - h.holdStart) / HOLD_MS, 1);
      ctx.globalAlpha = 1;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(x, y, r + 8, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
      ctx.stroke();
    }

    if (meta.label) {
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = '#fff';
      ctx.font = '600 13px "Space Grotesk", system-ui, sans-serif';
      ctx.fillText(`${meta.icon} ${meta.label}`, x, y - r - 16);
    }
  }

  if (state.stretch && list.length >= 2) {
    const [ax, ay] = worldToScreen(list[0].palm);
    const [bx, by] = worldToScreen(list[1].palm);
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff';
    ctx.font = '600 14px "Space Grotesk", system-ui, sans-serif';
    ctx.fillText(`🙌 ×${state.scale.toFixed(2)}`, (ax + bx) / 2, (ay + by) / 2 - 12);
  }
  ctx.globalAlpha = 1;

  if (settings.preview && tracker) {
    const pw = previewCanvas.width, ph = previewCanvas.height;
    pctx.clearRect(0, 0, pw, ph);
    for (const h of list) {
      if (h.lm) drawSkeleton(pctx, h.lm, (p) => [p.x * pw, p.y * ph], GESTURES[h.gesture]?.color ?? '#fff', 2);
    }
  }
}

function fitPreview() {
  if (video.videoWidth) previewEl.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  const dpr = window.devicePixelRatio || 1;
  previewCanvas.width = previewEl.clientWidth * dpr;
  previewCanvas.height = previewEl.clientHeight * dpr;
}

/* ------------------------------------------------------------------ HUD */

const statusText = $('#statusText');
const statusDot = $('#status .dot');
const guide = $('#guide');
const guideItems = [...guide.querySelectorAll('li')];
const camBtn = $('#camBtn');
const toastEl = $('#toast');
let toastTimer = 0;
let hudKey = '';

function setStatus(text, kind = '') {
  statusText.textContent = text;
  statusDot.className = `dot ${kind}`;
}

function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1400);
}

function updateHud() {
  const list = [...hands.values()];
  const active = new Set(list.map((h) => h.gesture));
  if (state.stretch) active.add('two');
  const key = `${mode}|${list.length}|${[...active].join()}`;
  if (key === hudKey) return;
  hudKey = key;
  guideItems.forEach((li) => li.classList.toggle('active', active.has(li.dataset.g)));
  if (mode === 'camera') {
    setStatus(
      list.length ? `Tracking ${list.length} hand${list.length > 1 ? 's' : ''}` : 'Show your hand to the camera',
      list.length ? 'live' : 'wait',
    );
  }
}

/* ------------------------------------------------------------------ panel */

const shapeButtons = SHAPES.map((s, i) => {
  const b = document.createElement('button');
  b.innerHTML = `<span>${s.icon}</span>${s.name}<kbd>${i + 1}</kbd>`;
  b.addEventListener('click', () => setShape(i));
  $('#shapes').append(b);
  return b;
});

const paletteButtons = PALETTES.map((p, i) => {
  const b = document.createElement('button');
  b.style.background = p.css;
  b.title = p.name;
  b.setAttribute('aria-label', `${p.name} colors`);
  b.addEventListener('click', () => setPalette(i));
  $('#palettes').append(b);
  return b;
});

let textTimer = 0;
$('#textInput').addEventListener('input', (e) => {
  clearTimeout(textTimer);
  textTimer = setTimeout(() => {
    settings.text = e.target.value.trim() || 'HELLO';
    setShape(SHAPES.findIndex((s) => s.id === 'text'), SHAPES[settings.shape].id === 'text');
  }, 250);
});

$('#size').addEventListener('input', (e) => {
  settings.size = Number(e.target.value);
  material.uniforms.uSize.value = BASE_SIZE * settings.size;
  $('#sizeOut').value = settings.size.toFixed(2);
});

$('#glow').addEventListener('input', (e) => {
  settings.glow = Number(e.target.value);
  $('#glowOut').value = settings.glow.toFixed(2);
});

const countSelect = $('#count');
countSelect.value = String(settings.count);
countSelect.addEventListener('change', () => {
  settings.count = Number(countSelect.value);
  build(settings.count);
});

$('#showCam').addEventListener('change', (e) => {
  settings.preview = e.target.checked;
  previewEl.classList.toggle('off', !(settings.preview && tracker));
});

$('#showSkel').addEventListener('change', (e) => {
  settings.skeleton = e.target.checked;
});

const panel = $('#panel');
const panelToggle = $('#panelToggle');
function setPanelOpen(open) {
  panel.classList.toggle('collapsed', !open);
  panelToggle.textContent = open ? '–' : '+';
  panelToggle.setAttribute('aria-label', open ? 'Collapse panel' : 'Expand panel');
}
panelToggle.addEventListener('click', () => setPanelOpen(panel.classList.contains('collapsed')));
$('#guideToggle').addEventListener('click', () => guide.classList.toggle('hidden'));

if (innerWidth < 760) {
  setPanelOpen(false);
  guide.classList.add('hidden');
}

/* ------------------------------------------------------------------ mouse + keyboard */

canvas.addEventListener('pointermove', (e) => {
  const sx = e.clientX / view.w, sy = e.clientY / view.h;
  if (mouse.down) {
    const yaw = (sx - mouse.sx) * 4.5, pitch = (sy - mouse.sy) * 4.5;
    rotate(yaw, pitch);
    state.rotVel.set(yaw, pitch);
  }
  mouse.sx = sx;
  mouse.sy = sy;
  if (mouse.last < 0) screenToWorld(sx, sy, mouse.prev);
  screenToWorld(sx, sy, mouse.pos);
  mouse.last = performance.now();
});

canvas.addEventListener('pointerdown', (e) => {
  mouse.down = true;
  mouse.sx = e.clientX / view.w;
  mouse.sy = e.clientY / view.h;
  canvas.setPointerCapture(e.pointerId);
});
const release = () => (mouse.down = false);
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('dblclick', supernova);
canvas.addEventListener(
  'wheel',
  (e) => (state.scaleTarget = clamp(state.scaleTarget * Math.exp(-e.deltaY * 0.0012), 0.3, 2.8)),
  { passive: true },
);

addEventListener('keydown', (e) => {
  if (e.target instanceof Element && e.target.closest('input, select, textarea')) return;
  const key = e.key.toLowerCase();
  const digit = Number(e.key);
  if (digit >= 1 && digit <= SHAPES.length) setShape(digit - 1);
  else if (key === 'arrowright') setShape(settings.shape + 1);
  else if (key === 'arrowleft') setShape(settings.shape - 1);
  else if (key === 'c') setPalette(settings.palette + 1);
  else if (key === ' ') {
    e.preventDefault();
    supernova();
  } else if (key === 'h') document.body.classList.toggle('hide-ui');
});

/* ------------------------------------------------------------------ start-up */

function cameraError(err) {
  switch (err?.name) {
    case 'NotAllowedError': return 'Camera permission was blocked. Allow it from the address bar and try again.';
    case 'NotFoundError': return 'No camera was found on this device.';
    case 'NotReadableError': return 'The camera is busy in another app. Close it and try again.';
    default: return err?.message || 'Could not start the camera.';
  }
}

function hideIntro() {
  $('#intro').classList.add('gone');
}

async function startCameraMode(fromIntro) {
  const startBtn = $('#startCam');
  const fail = (msg) => {
    if (fromIntro) $('#introError').textContent = msg;
    else setStatus(msg, 'error');
    startBtn.disabled = false;
    startBtn.textContent = 'Start camera';
  };

  startBtn.disabled = true;
  startBtn.textContent = 'Starting camera…';
  try {
    await startCamera(video);
  } catch (err) {
    fail(cameraError(err));
    return;
  }

  hideIntro();
  camBtn.hidden = true;
  mode = 'loading';
  setStatus('Loading hand tracking…', 'wait');
  try {
    tracker = await createHandTracker(video);
    mode = 'camera';
    hudKey = '';
    previewEl.classList.toggle('off', !settings.preview);
    fitPreview();
    toast('✋ Show your hand');
  } catch (err) {
    console.error(err);
    mode = 'mouse';
    setStatus('Hand tracking failed to load', 'error');
  }
}

$('#startCam').addEventListener('click', () => startCameraMode(true));
camBtn.addEventListener('click', () => startCameraMode(false));
$('#startMouse').addEventListener('click', () => {
  hideIntro();
  mode = 'mouse';
  camBtn.hidden = false;
  setStatus('Mouse mode · drag to rotate, scroll to zoom');
});
addEventListener('resize', () => tracker && fitPreview());

build(settings.count);
setPalette(settings.palette, true);

/* ------------------------------------------------------------------ main loop */

let lastTime = performance.now();
let detectFailed = false;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = clamp((now - lastTime) / (1000 / 60), 0.25, 3); // 1 = one frame at 60 fps
  lastTime = now;

  if (tracker) {
    try {
      const res = tracker.detect(now);
      if (res) onHandResults(res, now);
    } catch (err) {
      if (!detectFailed) console.error(err);
      detectFailed = true;
    }
  }
  for (const [key, h] of hands) if (now - h.seen > 220) hands.delete(key);

  const cursors = updateInteraction(dt, now);
  updateNova(dt, now);
  updateParticles(dt, now, cursors);
  updateColors(dt);
  updateGlow(cursors);

  stars.rotation.z += 0.00004 * dt;
  material.uniforms.uTime.value = starMaterial.uniforms.uTime.value = now / 1000;
  material.uniforms.uHeat.value = state.heat;
  bloom.strength = settings.glow + state.flash;
  composer.render();

  drawOverlay(now);
  updateHud();
}
requestAnimationFrame(frame);
