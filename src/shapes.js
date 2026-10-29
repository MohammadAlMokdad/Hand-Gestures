// Shape generators for the particle cloud.
// Each returns { pos, t }: pos is a Float32Array of N xyz targets that fit roughly inside a
// radius-15 ball around the origin, and t (0..1 per particle) picks that particle's palette colour.

const TAU = Math.PI * 2;
const rnd = Math.random;

function gauss() {
  let u = 0;
  while (u === 0) u = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * rnd());
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Rotates every point about the X axis, then about the Z axis.
function tilt(pos, ax, az = 0) {
  const cx = Math.cos(ax), sx = Math.sin(ax), cz = Math.cos(az), sz = Math.sin(az);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i];
    const y = pos[i + 1] * cx - pos[i + 2] * sx;
    const z = pos[i + 1] * sx + pos[i + 2] * cx;
    pos[i] = x * cz - y * sz;
    pos[i + 1] = x * sz + y * cz;
    pos[i + 2] = z;
  }
}

function sphere(N) {
  const pos = new Float32Array(N * 3), t = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const u = rnd() * 2 - 1, a = rnd() * TAU, s = Math.sqrt(1 - u * u);
    // Most particles sit on the shell; the rest fill the core with a soft glow.
    const r = rnd() < 0.85 ? 13 + gauss() * 0.3 : 11.5 * Math.cbrt(rnd());
    pos[i * 3] = s * Math.cos(a) * r;
    pos[i * 3 + 1] = u * r;
    pos[i * 3 + 2] = s * Math.sin(a) * r;
    t[i] = clamp01((u + 1) * 0.45 + rnd() * 0.1);
  }
  return { pos, t };
}

// Outline of the classic parametric heart as a closed polygon, plus running arc length for even sampling.
const HEART = (() => {
  const pts = [];
  for (let k = 0; k < 240; k++) {
    const a = (k / 240) * TAU;
    const x = 16 * Math.sin(a) ** 3;
    const y = 13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a);
    pts.push([x * 0.78, (y + 2.5) * 0.78]);
  }
  const cum = [0];
  for (let k = 0; k < pts.length; k++) {
    const [ax, ay] = pts[k], [bx, by] = pts[(k + 1) % pts.length];
    cum.push(cum[k] + Math.hypot(bx - ax, by - ay));
  }
  return { pts, cum };
})();

// Distance from (x, y) to the heart outline, or -1 if the point is outside.
function heartDepth(x, y) {
  const P = HEART.pts;
  let inside = false, best = Infinity;
  for (let k = 0, j = P.length - 1; k < P.length; j = k++) {
    const [ax, ay] = P[j], [bx, by] = P[k];
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
    const ex = bx - ax, ey = by - ay;
    const h = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
    best = Math.min(best, Math.hypot(x - ax - ex * h, y - ay - ey * h));
  }
  return inside ? best : -1;
}

function heart(N) {
  const pos = new Float32Array(N * 3), t = new Float32Array(N);
  const { pts, cum } = HEART;
  const total = cum[cum.length - 1];
  for (let i = 0; i < N; i++) {
    let x, y, puff;
    if (rnd() < 0.25) {
      // A quarter of the particles trace the outline, spread evenly along it.
      const u = rnd() * total;
      let k = 0;
      while (cum[k + 1] < u) k++;
      const f = (u - cum[k]) / (cum[k + 1] - cum[k]);
      const [ax, ay] = pts[k], [bx, by] = pts[(k + 1) % pts.length];
      x = ax + (bx - ax) * f + gauss() * 0.12;
      y = ay + (by - ay) * f + gauss() * 0.12;
      puff = 0;
    } else {
      // The rest fill a pillow: thickest in the middle, thin at the rim.
      let d;
      do {
        x = (rnd() * 2 - 1) * 12.6;
        y = (rnd() * 2 - 1) * 11.4;
        d = heartDepth(x, y);
      } while (d < 0);
      puff = Math.sqrt(Math.min(d / 6.5, 1));
    }
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = puff * 6 * (rnd() < 0.5 ? 1 : -1);
    t[i] = clamp01(1 - puff * 0.8 + rnd() * 0.12);
  }
  return { pos, t };
}

function saturn(N) {
  const pos = new Float32Array(N * 3), t = new Float32Array(N);
  const planet = Math.floor(N * 0.42);
  for (let i = 0; i < N; i++) {
    let x, y, z;
    if (i < planet) {
      const u = rnd() * 2 - 1, a = rnd() * TAU, s = Math.sqrt(1 - u * u);
      const r = rnd() < 0.9 ? 7.2 : 7 * Math.cbrt(rnd());
      x = s * Math.cos(a) * r;
      y = u * r;
      z = s * Math.sin(a) * r;
      t[i] = clamp01(0.08 + (u + 1) * 0.12 + Math.sin(u * 9) * 0.06);
    } else {
      let r;
      do r = 9.8 + rnd() * 7.5;
      while (r > 13.4 && r < 14.1 && rnd() < 0.85); // the Cassini gap
      const a = rnd() * TAU;
      x = Math.cos(a) * r;
      y = gauss() * 0.12;
      z = Math.sin(a) * r;
      t[i] = clamp01(0.55 + ((r - 9.8) / 7.5) * 0.45);
    }
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = z;
  }
  tilt(pos, 0.42, -0.32);
  return { pos, t };
}

function galaxy(N) {
  const pos = new Float32Array(N * 3), t = new Float32Array(N);
  const arms = 3, R = 17;
  for (let i = 0; i < N; i++) {
    let x, y, z;
    if (rnd() < 0.14) {
      x = gauss() * 1.8;
      y = gauss() * 1.2;
      z = gauss() * 1.8;
      t[i] = rnd() * 0.12;
    } else {
      const r = Math.pow(rnd(), 0.75) * R + 0.8;
      const a = ((i % arms) / arms) * TAU + r * 0.32 + gauss() * (0.22 + 0.12 * (1 - r / R));
      x = Math.cos(a) * r + gauss() * 0.35;
      y = gauss() * 0.45 * (1.2 - r / R);
      z = Math.sin(a) * r + gauss() * 0.35;
      t[i] = clamp01((r / R) * 0.9 + rnd() * 0.1);
    }
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = z;
  }
  tilt(pos, 1.05); // lean the disc towards the viewer
  return { pos, t };
}

function knot(N) {
  const pos = new Float32Array(N * 3), t = new Float32Array(N);
  const p = 2, q = 3, S = 4.4;
  for (let i = 0; i < N; i++) {
    const u = rnd() * TAU;
    const r = 2 + Math.cos(q * u);
    // Scatter around the curve to give it a glowing tube.
    const du = rnd() * 2 - 1, da = rnd() * TAU, ds = Math.sqrt(1 - du * du);
    const tube = 1.1 + gauss() * 0.18;
    pos[i * 3] = r * Math.cos(p * u) * S + ds * Math.cos(da) * tube;
    pos[i * 3 + 1] = r * Math.sin(p * u) * S + du * tube;
    pos[i * 3 + 2] = -Math.sin(q * u) * S + ds * Math.sin(da) * tube;
    t[i] = u / TAU;
  }
  return { pos, t };
}

function dna(N) {
  const pos = new Float32Array(N * 3), t = new Float32Array(N);
  const H = 30, R = 5.5, turns = 2.2, rungs = 22;
  for (let i = 0; i < N; i++) {
    let x, y, z;
    if (rnd() < 0.62) {
      const strand = i & 1;
      const s = rnd();
      const a = s * turns * TAU + strand * Math.PI;
      x = Math.cos(a) * R + gauss() * 0.28;
      y = (s - 0.5) * H + gauss() * 0.28;
      z = Math.sin(a) * R + gauss() * 0.28;
      t[i] = strand ? 0.85 + rnd() * 0.15 : rnd() * 0.15;
    } else {
      const s = (Math.floor(rnd() * rungs) + 0.5) / rungs;
      const a = s * turns * TAU;
      const f = rnd() * 2 - 1; // position across the rung
      x = Math.cos(a) * R * f + gauss() * 0.12;
      y = (s - 0.5) * H + gauss() * 0.12;
      z = Math.sin(a) * R * f + gauss() * 0.12;
      t[i] = 0.3 + ((f + 1) / 2) * 0.4;
    }
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = z;
  }
  tilt(pos, 0, 0.5);
  return { pos, t };
}

// Draws the word on a hidden canvas and scatters particles over the lit pixels.
function text(N, { text: word = 'HELLO', maxWidth = 40 } = {}) {
  word = word.trim() || 'HELLO';
  const fontPx = 160;
  const font = `900 ${fontPx}px "Segoe UI", "Arial Black", Arial, sans-serif`;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(word).width) + 40;
  const h = Math.ceil(fontPx * 1.3);
  canvas.width = w;
  canvas.height = h;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText(word, w / 2, h / 2);

  const data = ctx.getImageData(0, 0, w, h).data;
  const lit = [];
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) if (data[(y * w + x) * 4 + 3] > 128) lit.push(x, y);
  }
  if (!lit.length) return sphere(N);

  const pos = new Float32Array(N * 3), t = new Float32Array(N);
  const unit = Math.min(maxWidth / w, 14 / h);
  for (let i = 0; i < N; i++) {
    const j = Math.floor(rnd() * (lit.length / 2)) * 2;
    const px = lit[j] + rnd() * 2, py = lit[j + 1] + rnd() * 2;
    pos[i * 3] = (px - w / 2) * unit;
    pos[i * 3 + 1] = -(py - h / 2) * unit;
    pos[i * 3 + 2] = gauss() * 0.6;
    t[i] = px / w;
  }
  return { pos, t };
}

export const SHAPES = [
  { id: 'sphere', name: 'Sphere', icon: '🔮', make: sphere },
  { id: 'heart', name: 'Heart', icon: '❤️', make: heart, sway: true },
  { id: 'saturn', name: 'Saturn', icon: '🪐', make: saturn },
  { id: 'galaxy', name: 'Galaxy', icon: '🌌', make: galaxy },
  { id: 'knot', name: 'Knot', icon: '➰', make: knot },
  { id: 'dna', name: 'DNA', icon: '🧬', make: dna },
  { id: 'text', name: 'Text', icon: '🔤', make: text, sway: true },
];
