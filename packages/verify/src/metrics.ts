import { deltaE2000, rgbToLab } from './color';
import { grayscale, type PixelBox, type Raster } from './raster';
import { ssimMap } from './ssim';

/** Per-pixel differences of a frame against the reference, both the same size. */
export interface ErrorMaps {
  /** Structural similarity of the grey images, 1 = same. */
  ssim: Float32Array;
  /** CIEDE2000 between the pixels' colours (alpha ignored; frames are rendered opaque). */
  deltaE: Float32Array;
}

export function errorMaps(reference: Raster, frame: Raster): ErrorMaps {
  const deltaE = new Float32Array(reference.width * reference.height);
  const a = reference.data;
  const b = frame.data;
  const labA = [0, 0, 0];
  const labB = [0, 0, 0];
  for (let i = 0; i < deltaE.length; i++) {
    const at = i * 4;
    const r1 = a[at] ?? 0;
    const g1 = a[at + 1] ?? 0;
    const b1 = a[at + 2] ?? 0;
    const r2 = b[at] ?? 0;
    const g2 = b[at + 1] ?? 0;
    const b2 = b[at + 2] ?? 0;
    if (r1 === r2 && g1 === g2 && b1 === b2) continue;
    rgbToLab(r1, g1, b1, labA);
    rgbToLab(r2, g2, b2, labB);
    deltaE[i] = deltaE2000(
      labA[0] ?? 0,
      labA[1] ?? 0,
      labA[2] ?? 0,
      labB[0] ?? 0,
      labB[1] ?? 0,
      labB[2] ?? 0,
    );
  }
  return {
    ssim: ssimMap(grayscale(reference), grayscale(frame), reference.width, reference.height),
    deltaE,
  };
}

/** Mean of a per-pixel map over the pixels of `box` the mask counts. */
export function maskedMean(
  map: Float32Array,
  width: number,
  box: PixelBox,
  mask: Uint8Array,
): { mean: number; count: number } {
  let sum = 0;
  let count = 0;
  for (let y = box[1]; y < box[3]; y++) {
    for (let x = box[0]; x < box[2]; x++) {
      const at = y * width + x;
      if (mask[at]) {
        sum += map[at] ?? 0;
        count++;
      }
    }
  }
  return { mean: count === 0 ? 0 : sum / count, count };
}
