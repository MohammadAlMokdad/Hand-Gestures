import * as THREE from 'three';

// Colour stops run from a shape's "inside" (t = 0) to its "outside" (t = 1).
const DEFS = [
  { name: 'Nebula', stops: ['#7df9ff', '#4361ee', '#7209b7', '#f72585'] },
  { name: 'Inferno', stops: ['#fff3b0', '#ffba08', '#f48c06', '#dc2f02', '#9d0208'] },
  { name: 'Ocean', stops: ['#e0fbfc', '#90e0ef', '#00b4d8', '#0077b6', '#0353a4'] },
  { name: 'Aurora', stops: ['#b9fbc0', '#2de2a6', '#00bbf9', '#7b2ff7', '#c77dff'] },
  { name: 'Gold', stops: ['#fffbe6', '#ffe08a', '#f4b942', '#d98a1a', '#a8650a'] },
  { name: 'Sakura', stops: ['#ffffff', '#ffd6e8', '#ff8fab', '#fb6f92', '#c9184a'] },
  { name: 'Rainbow', hues: 7 },
];

export const PALETTES = DEFS.map(({ name, stops, hues }) => {
  const colors = stops
    ? stops.map((hex) => new THREE.Color(hex))
    : Array.from({ length: hues }, (_, i) =>
        new THREE.Color().setHSL((i / (hues - 1)) * 0.83, 0.95, 0.6, THREE.SRGBColorSpace));
  const css = `linear-gradient(135deg, ${colors.map((c) => '#' + c.getHexString()).join(', ')})`;
  return { name, colors, css };
});

// Writes the palette colour at t (0..1) into out[0..2], in linear RGB.
export function samplePalette({ colors }, t, out) {
  const x = Math.min(Math.max(t, 0), 1) * (colors.length - 1);
  const i = Math.min(Math.floor(x), colors.length - 2);
  const f = x - i;
  const a = colors[i];
  const b = colors[i + 1];
  out[0] = a.r + (b.r - a.r) * f;
  out[1] = a.g + (b.g - a.g) * f;
  out[2] = a.b + (b.b - a.b) * f;
  return out;
}
