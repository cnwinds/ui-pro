import { featherWeights } from './mask';
import { cloneImage } from './raster';
import type { RgbaImage } from './types';

/** The pixel outside the hole nearest to (x, y) within `radius`, as an index; -1 when there is none. */
function nearestOutside(
  hole: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let dy = -radius; dy <= radius; dy++) {
    const py = y + dy;
    if (py < 0 || py >= height) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const px = x + dx;
      if (px < 0 || px >= width || hole[py * width + px]) continue;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = py * width + px;
      }
    }
  }
  return best;
}

/**
 * `generated` inside the hole, over a copy of `original`. Over the `feather` pixels inside the
 * hole's edge (constraint 1: 2-4 pixels of transition) the generated pixels fade in from the
 * colour of the nearest pixel outside the hole, not from what the hole held (that is what was
 * being removed). Outside the hole every pixel is the original's, byte for byte.
 */
export function blendIntoHole(
  original: RgbaImage,
  generated: RgbaImage,
  hole: Uint8Array,
  feather: number,
): RgbaImage {
  const { width, height } = original;
  const out = cloneImage(original);
  const weights = featherWeights(hole, width, height, feather);
  const radius = Math.max(1, Math.ceil(feather));
  for (let i = 0; i < hole.length; i++) {
    if (!hole[i]) continue;
    const weight = weights[i] as number;
    const near =
      weight < 1
        ? nearestOutside(hole, width, height, i % width, Math.floor(i / width), radius)
        : -1;
    for (let channel = 0; channel < 3; channel++) {
      const now = generated.data[i * 4 + channel] ?? 0;
      const was = near >= 0 ? (original.data[near * 4 + channel] ?? 0) : now;
      out.data[i * 4 + channel] = Math.round(was + (now - was) * (near >= 0 ? weight : 1));
    }
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

/** Pixels of `generated` where `region` is set, over a copy of `original`; exactly `original` elsewhere. */
export function takeInside(
  original: RgbaImage,
  generated: RgbaImage,
  region: Uint8Array,
): RgbaImage {
  const out = cloneImage(original);
  for (let i = 0; i < region.length; i++) {
    if (!region[i]) continue;
    out.data.set(generated.data.subarray(i * 4, i * 4 + 4), i * 4);
  }
  return out;
}
