import type { Rect } from '@ui-pro/core';
import type { GrayMask } from './types';

const INF = 1e20;

/** Element `index` of a typed array whose index is known to be in range. */
const at = (values: ArrayLike<number>, index: number): number => values[index] as number;

/** 1 where the mask is at least `threshold`, else 0. */
export function binarize(mask: GrayMask, threshold = 128): Uint8Array {
  const out = new Uint8Array(mask.data.length);
  for (let i = 0; i < out.length; i++) out[i] = (mask.data[i] ?? 0) >= threshold ? 1 : 0;
  return out;
}

export function toMask(flags: Uint8Array, width: number, height: number): GrayMask {
  const data = new Uint8Array(flags.length);
  for (let i = 0; i < data.length; i++) data[i] = flags[i] ? 255 : 0;
  return { width, height, data };
}

export function countOn(flags: Uint8Array): number {
  let n = 0;
  for (const flag of flags) if (flag) n++;
  return n;
}

/** Bounding box `[x, y, w, h]` of the pixels that are on, or null when none is. */
export function boundsOf(flags: Uint8Array, width: number, height: number): Rect | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!flags[y * width + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : [minX, minY, maxX - minX + 1, maxY - minY + 1];
}

/** One scan of the exact Euclidean distance transform (Felzenszwalb and Huttenlocher). */
function scan(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  const parabola = (q: number, p: number) =>
    (at(f, q) + q * q - (at(f, p) + p * p)) / (2 * q - 2 * p);
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = parabola(q, at(v, k));
    while (s <= at(z, k)) {
      k--;
      s = parabola(q, at(v, k));
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (at(z, k + 1) < q) k++;
    const p = at(v, k);
    d[q] = (q - p) * (q - p) + at(f, p);
  }
}

/**
 * Distance in pixels from every pixel to the nearest pixel that is on (0 on those pixels);
 * infinite everywhere when nothing is on.
 */
export function distanceToOn(flags: Uint8Array, width: number, height: number): Float32Array {
  const size = Math.max(width, height);
  const f = new Float64Array(size);
  const d = new Float64Array(size);
  const v = new Int32Array(size);
  const z = new Float64Array(size + 1);
  const grid = new Float64Array(width * height);
  for (let i = 0; i < grid.length; i++) grid[i] = flags[i] ? 0 : INF;
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = at(grid, y * width + x);
    scan(f, height, d, v, z);
    for (let y = 0; y < height; y++) grid[y * width + x] = at(d, y);
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = at(grid, y * width + x);
    scan(f, width, d, v, z);
    for (let x = 0; x < width; x++) grid[y * width + x] = at(d, x);
  }
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(at(grid, i));
  return out;
}

function invert(flags: Uint8Array): Uint8Array {
  const out = new Uint8Array(flags.length);
  for (let i = 0; i < out.length; i++) out[i] = flags[i] ? 0 : 1;
  return out;
}

/** Pixels within `radius` of a pixel that is on (a disc, not a square). */
export function dilate(
  flags: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  if (radius <= 0) return new Uint8Array(flags);
  const distance = distanceToOn(flags, width, height);
  const out = new Uint8Array(flags.length);
  for (let i = 0; i < out.length; i++) out[i] = at(distance, i) <= radius ? 1 : 0;
  return out;
}

/** Pixels that are on and farther than `radius` from every pixel that is off. */
export function erode(
  flags: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  if (radius <= 0) return new Uint8Array(flags);
  const distance = distanceToOn(invert(flags), width, height);
  const out = new Uint8Array(flags.length);
  for (let i = 0; i < out.length; i++) out[i] = flags[i] && at(distance, i) > radius ? 1 : 0;
  return out;
}

/** For pixels that are on, the distance to the nearest pixel that is off (at least 1); 0 elsewhere. */
export function depthInside(flags: Uint8Array, width: number, height: number): Float32Array {
  const distance = distanceToOn(invert(flags), width, height);
  const out = new Float32Array(flags.length);
  for (let i = 0; i < out.length; i++) out[i] = flags[i] ? Math.min(at(distance, i), 1e6) : 0;
  return out;
}

/** Connected components (8-neighbourhood) of the pixels that are on, largest first. */
export function components(
  flags: Uint8Array,
  width: number,
  height: number,
): { pixels: number[]; box: Rect }[] {
  const seen = new Uint8Array(flags.length);
  const found: { pixels: number[]; box: Rect }[] = [];
  const stack: number[] = [];
  for (let start = 0; start < flags.length; start++) {
    if (!flags[start] || seen[start]) continue;
    const pixels: number[] = [];
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const index = stack.pop() as number;
      pixels.push(index);
      const x = index % width;
      const y = (index - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (flags[next] && !seen[next]) {
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
    }
    found.push({ pixels, box: [minX, minY, maxX - minX + 1, maxY - minY + 1] });
  }
  return found.sort((a, b) => b.pixels.length - a.pixels.length);
}

/** Turns on every pixel that is off and cannot be reached from the image border through off pixels. */
export function fillHoles(flags: Uint8Array, width: number, height: number): Uint8Array {
  const outside = new Uint8Array(flags.length);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    const index = y * width + x;
    if (!flags[index] && !outside[index]) {
      outside[index] = 1;
      stack.push(index);
    }
  };
  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    push(0, y);
    push(width - 1, y);
  }
  while (stack.length > 0) {
    const index = stack.pop() as number;
    const x = index % width;
    const y = (index - x) / width;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }
  const out = new Uint8Array(flags.length);
  for (let i = 0; i < out.length; i++) out[i] = outside[i] ? 0 : 1;
  return out;
}

/**
 * Weight of the generated pixels inside a hole: 0 outside it, and inside rising from
 * `1 / feather` at the first pixel to 1 `feather` pixels in, so the seam is not a hard line.
 */
export function featherWeights(
  hole: Uint8Array,
  width: number,
  height: number,
  feather: number,
): Float32Array {
  const depth = depthInside(hole, width, height);
  const out = new Float32Array(hole.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = hole[i] ? (feather <= 0 ? 1 : Math.min(1, at(depth, i) / feather)) : 0;
  }
  return out;
}
