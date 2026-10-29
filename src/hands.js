// Webcam + MediaPipe hand tracking, and turning 21 hand landmarks into a named gesture.

const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// Landmark 0 is the wrist; each finger has 4 points from knuckle to tip.
const FINGERS = {
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
};

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

// Gesture thresholds. Tweak these if a pose isn't recognised reliably for your hand or camera.
export const TUNING = {
  straight: 0.95,    // a finger counts as extended when it bends less than this (radians, ~55°)
  pinchOn: 0.32,     // thumb–index tip gap (relative to palm length) that starts a pinch
  pinchOff: 0.48,    // gap that ends it; larger than pinchOn so a pinch doesn't flicker
  pinchMaxBend: 2.3, // an index finger bent more than this is part of a fist, not a pinch
};

export async function startCamera(video) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera access needs https:// or http://localhost. Run "npm start" and open http://localhost:5173');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}

export async function createHandTracker(video) {
  const { FilesetResolver, HandLandmarker } = await import(`${VISION}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
  const create = (delegate) =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.5,
    });

  let landmarker;
  try {
    landmarker = await create('GPU');
  } catch (err) {
    console.warn('GPU hand tracking unavailable, falling back to CPU.', err);
    landmarker = await create('CPU');
  }

  let lastVideoTime = -1;
  return {
    // Returns fresh results when the camera has produced a new frame, otherwise null.
    detect(now) {
      if (video.readyState < 2 || video.currentTime === lastVideoTime) return null;
      lastVideoTime = video.currentTime;
      return landmarker.detectForVideo(video, now);
    },
  };
}

const vec = (a, b) => [b.x - a.x, b.y - a.y, b.z - a.z];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function angle(u, v) {
  const dot = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const len = Math.hypot(u[0], u[1], u[2]) * Math.hypot(v[0], v[1], v[2]) || 1;
  return Math.acos(Math.min(1, Math.max(-1, dot / len)));
}

// Angle between a finger's first and last bone: ~0 when straight, ~π when curled into the palm.
const bend = (w, [knuckle, mid, end, tip]) => angle(vec(w[knuckle], w[mid]), vec(w[end], w[tip]));

function centroid(lm, ids) {
  let x = 0, y = 0;
  for (const i of ids) {
    x += lm[i].x;
    y += lm[i].y;
  }
  return { x: x / ids.length, y: y / ids.length };
}

// Thumb straight and clearly the highest point of an otherwise closed hand.
function isThumbUp(lm, w) {
  const straight = angle(vec(w[2], w[3]), vec(w[3], w[4])) < 0.8;
  const span = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y);
  const highest = lm.every((p, i) => i === 4 || p.y > lm[4].y);
  return straight && highest && lm[5].y - lm[4].y > span * 0.35;
}

// lm: normalised image landmarks (x, y in 0..1). world: the same points in metres, which keep
// their true 3D shape whichever way the hand faces, so finger bends are measured on those.
export function analyzeHand(lm, world, wasPinching) {
  const w = world?.length === 21 ? world : lm;
  const palmLength = dist(w[0], w[9]) || 1;

  const bends = {};
  let extended = 0;
  for (const [name, ids] of Object.entries(FINGERS)) {
    bends[name] = bend(w, ids);
    if (bends[name] < TUNING.straight) extended++;
  }
  const ext = (name) => bends[name] < TUNING.straight;

  const pinchGap = dist(w[4], w[8]) / palmLength;
  const pinching =
    pinchGap < (wasPinching ? TUNING.pinchOff : TUNING.pinchOn) && bends.index < TUNING.pinchMaxBend;

  let gesture = 'relaxed';
  if (pinching) gesture = 'pinch';
  else if (extended === 0) gesture = isThumbUp(lm, w) ? 'thumbsUp' : 'fist';
  else if (extended === 4) gesture = 'open';
  else if (extended === 1 && ext('index')) gesture = 'point';
  else if (extended === 2 && ext('index') && ext('middle')) gesture = 'peace';
  else if (extended === 2 && ext('index') && ext('pinky')) gesture = 'rock';

  return {
    gesture,
    palm: centroid(lm, [0, 5, 9, 13, 17]),
    tip: { x: lm[8].x, y: lm[8].y },
    pinch: { x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 },
  };
}
