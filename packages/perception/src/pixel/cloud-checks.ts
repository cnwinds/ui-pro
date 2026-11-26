import { deltaE, luma, rgbToLab } from './color';
import { dilate, erode } from './mask';
import type { RgbaImage } from './types';

/** Mean absolute difference (0-255, over RGB) outside the mask above which a result is thrown out. */
export const ALIGN_MAX_DIFFERENCE = 6;
/** Colour difference (CIE76) of the ring around the mask above which a result is thrown out. */
export const COLOR_MAX_DELTA_E = 6;
/** Pixels around the mask left out of the alignment check: the transition band lives there. */
export const ALIGN_GAP = 4;
/** The ring around the mask whose mean colour is compared, in pixels from the mask. */
export const COLOR_RING = [3, 16] as const;
const SHIFT_RANGE = 12;
const SHIFT_SAMPLES = 20_000;
/** The best shift must be this much better than no shift to be called a shift. */
const SHIFT_GAIN = 0.5;

/** 1 where the pixel is outside the mask by more than `gap` pixels. */
export function outsideZone(
  hole: Uint8Array,
  width: number,
  height: number,
  gap = ALIGN_GAP,
): Uint8Array {
  const near = dilate(hole, width, height, gap);
  const out = new Uint8Array(hole.length);
  for (let i = 0; i < out.length; i++) out[i] = near[i] ? 0 : 1;
  return out;
}

/** 1 in the ring between `inner` and `outer` pixels from the mask. */
export function ringZone(
  hole: Uint8Array,
  width: number,
  height: number,
  [inner, outer]: readonly [number, number] = COLOR_RING,
): Uint8Array {
  const far = dilate(hole, width, height, outer);
  const near = dilate(hole, width, height, inner);
  const out = new Uint8Array(hole.length);
  for (let i = 0; i < out.length; i++) out[i] = far[i] && !near[i] ? 1 : 0;
  return out;
}

/** Mean absolute RGB difference between the two images over the flagged pixels. */
export function meanDifference(a: RgbaImage, b: RgbaImage, zone: Uint8Array): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < zone.length; i++) {
    if (!zone[i]) continue;
    sum +=
      Math.abs((a.data[i * 4] ?? 0) - (b.data[i * 4] ?? 0)) +
      Math.abs((a.data[i * 4 + 1] ?? 0) - (b.data[i * 4 + 1] ?? 0)) +
      Math.abs((a.data[i * 4 + 2] ?? 0) - (b.data[i * 4 + 2] ?? 0));
    count++;
  }
  return count === 0 ? 0 : sum / (3 * count);
}

/**
 * Whether `candidate` is `sent` moved by a few pixels: the shift (candidate = sent at +dx, +dy)
 * that explains the zone far better than no shift. Null when no shift does.
 */
export function detectShift(
  sent: RgbaImage,
  candidate: RgbaImage,
  zone: Uint8Array,
): { dx: number; dy: number } | null {
  const picks: number[] = [];
  let seen = 0;
  const step = Math.max(1, Math.floor(zone.reduce((n, flag) => n + flag, 0) / SHIFT_SAMPLES));
  for (let i = 0; i < zone.length; i++) {
    if (!zone[i]) continue;
    if (seen++ % step === 0) picks.push(i);
  }
  const { width, height } = sent;
  const cost = (dx: number, dy: number) => {
    let sum = 0;
    let count = 0;
    for (const at of picks) {
      const x = (at % width) + dx;
      const y = Math.floor(at / width) + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const other = (y * width + x) * 4;
      sum += Math.abs(
        luma(sent.data[at * 4] ?? 0, sent.data[at * 4 + 1] ?? 0, sent.data[at * 4 + 2] ?? 0) -
          luma(
            candidate.data[other] ?? 0,
            candidate.data[other + 1] ?? 0,
            candidate.data[other + 2] ?? 0,
          ),
      );
      count++;
    }
    return count === 0 ? Number.POSITIVE_INFINITY : sum / count;
  };
  const none = cost(0, 0);
  let best = { dx: 0, dy: 0, cost: none };
  for (let dy = -SHIFT_RANGE; dy <= SHIFT_RANGE; dy++) {
    for (let dx = -SHIFT_RANGE; dx <= SHIFT_RANGE; dx++) {
      if (dx === 0 && dy === 0) continue;
      const value = cost(dx, dy);
      if (value < best.cost) best = { dx, dy, cost: value };
    }
  }
  return best.cost < none * SHIFT_GAIN && none > 1 ? { dx: best.dx, dy: best.dy } : null;
}

function meanLab(image: RgbaImage, zone: Uint8Array): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let i = 0; i < zone.length; i++) {
    if (!zone[i]) continue;
    r += image.data[i * 4] ?? 0;
    g += image.data[i * 4 + 1] ?? 0;
    b += image.data[i * 4 + 2] ?? 0;
    count++;
  }
  return count === 0 ? [0, 0, 0] : rgbToLab(r / count, g / count, b / count);
}

/** Colour difference (CIE76) between the mean colours of the flagged pixels of two images. */
export function ringColorDelta(a: RgbaImage, b: RgbaImage, zone: Uint8Array): number {
  return deltaE(meanLab(a, zone), meanLab(b, zone));
}

const distance = (a: RgbaImage, i: number, b: RgbaImage, j: number) =>
  Math.hypot(
    (a.data[i * 4] ?? 0) - (b.data[j * 4] ?? 0),
    (a.data[i * 4 + 1] ?? 0) - (b.data[j * 4 + 1] ?? 0),
    (a.data[i * 4 + 2] ?? 0) - (b.data[j * 4 + 2] ?? 0),
  );

/**
 * Continuity of the seam: for every pair of neighbouring pixels across the hole's boundary, how
 * much the step from the original to the candidate exceeds the step the original itself has
 * there. Zero when the candidate continues the picture as smoothly as the picture does.
 */
export function seamCost(sent: RgbaImage, candidate: RgbaImage, hole: Uint8Array): number {
  const { width, height } = sent;
  let sum = 0;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      if (!hole[at]) continue;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const outside = ny * width + nx;
        if (hole[outside]) continue;
        const fx = nx + dx;
        const fy = ny + dy;
        const further =
          fx >= 0 && fy >= 0 && fx < width && fy < height && !hole[fy * width + fx]
            ? fy * width + fx
            : outside;
        const step = distance(candidate, at, sent, outside);
        const baseline = distance(sent, outside, sent, further);
        sum += Math.max(0, step - baseline);
        count++;
      }
    }
  }
  return count === 0 ? 0 : sum / count;
}

interface Statistics {
  mean: number;
  deviation: number;
  gradient: number;
}

function statistics(image: RgbaImage, zone: Uint8Array): Statistics {
  const { width, height } = image;
  const lumaAt = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return luma(image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0);
  };
  let sum = 0;
  let squares = 0;
  let gradient = 0;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!zone[y * width + x]) continue;
      const value = lumaAt(x, y);
      sum += value;
      squares += value * value;
      gradient +=
        Math.abs(value - lumaAt(Math.min(width - 1, x + 1), y)) +
        Math.abs(value - lumaAt(x, Math.min(height - 1, y + 1)));
      count++;
    }
  }
  if (count === 0) return { mean: 0, deviation: 0, gradient: 0 };
  const mean = sum / count;
  return {
    mean,
    deviation: Math.sqrt(Math.max(0, squares / count - mean * mean)),
    gradient: gradient / count,
  };
}

/**
 * Texture consistency: how far the statistics of luma inside the hole (mean, spread, gradient
 * energy) are from those of the ring around it in the original. Lower is better.
 */
export function textureCost(sent: RgbaImage, candidate: RgbaImage, hole: Uint8Array): number {
  const { width, height } = sent;
  let inside = erode(hole, width, height, 2);
  if (inside.every((flag) => !flag)) inside = hole;
  const ring = ringZone(hole, width, height, [2, 12]);
  const within = statistics(candidate, inside);
  const around = statistics(sent, ring);
  return (
    Math.abs(within.mean - around.mean) / 32 +
    Math.abs(within.deviation - around.deviation) / 16 +
    Math.abs(within.gradient - around.gradient) / 8
  );
}

/** Lower is better: seam continuity plus texture consistency. */
export function candidateCost(sent: RgbaImage, candidate: RgbaImage, hole: Uint8Array): number {
  return seamCost(sent, candidate, hole) / 16 + textureCost(sent, candidate, hole);
}
