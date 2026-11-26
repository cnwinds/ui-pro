import type { RgbaImage } from '@ui-pro/perception';
import { TINT_MAX_ERROR, TINT_MIN_FACTOR } from './constants';
import { toHex } from './raster';

export interface TintFit {
  /** `#rrggbb`: what the engine multiplies the master's RGB by. */
  color: string;
  factors: [number, number, number];
  /** Mean absolute error per channel (0–255) of `master × factors` against the instance. */
  error: number;
}

/** Mean alpha difference above which two pictures are different shapes, not different colours. */
const MAX_ALPHA_DIFF = 8;
/** Pixels at or above this alpha in both pictures take part in the fit. */
const FIT_ALPHA = 128;

/**
 * The least-squares multiply colour that turns `master` into `instance`, channel by channel
 * (`k = Σ master·instance / Σ master²`), kept within 0–1 because a multiply cannot brighten.
 * `undefined` when the pictures differ in size or silhouette.
 */
export function fitTint(master: RgbaImage, instance: RgbaImage): TintFit | undefined {
  if (master.width !== instance.width || master.height !== instance.height) return undefined;
  const count = master.width * master.height;
  let alphaDiff = 0;
  const cross = [0, 0, 0];
  const square = [0, 0, 0];
  const used: number[] = [];
  for (let i = 0; i < count; i++) {
    const ma = master.data[i * 4 + 3] ?? 0;
    const ia = instance.data[i * 4 + 3] ?? 0;
    alphaDiff += Math.abs(ma - ia);
    if (ma < FIT_ALPHA || ia < FIT_ALPHA) continue;
    used.push(i);
    for (let c = 0; c < 3; c++) {
      const m = master.data[i * 4 + c] ?? 0;
      const v = instance.data[i * 4 + c] ?? 0;
      cross[c] = (cross[c] ?? 0) + m * v;
      square[c] = (square[c] ?? 0) + m * m;
    }
  }
  if (alphaDiff / count > MAX_ALPHA_DIFF || used.length === 0) return undefined;
  const factors = [0, 1, 2].map((c) => {
    const denominator = square[c] ?? 0;
    const fitted = denominator === 0 ? 1 : Math.max(0, Math.min(1, (cross[c] ?? 0) / denominator));
    // The colour is written as a byte per channel; judge the fit by what will actually be used.
    return Math.round(fitted * 255) / 255;
  }) as [number, number, number];
  let error = 0;
  for (const i of used) {
    for (let c = 0; c < 3; c++) {
      const predicted = (master.data[i * 4 + c] ?? 0) * (factors[c] ?? 1);
      error += Math.abs((instance.data[i * 4 + c] ?? 0) - predicted);
    }
  }
  error /= used.length * 3;
  return { color: toHex(factors[0] * 255, factors[1] * 255, factors[2] * 255), factors, error };
}

/** Whether a fit is close enough, and bright enough, to use instead of a picture of its own. */
export function tintAcceptable(fit: TintFit): boolean {
  return fit.error <= TINT_MAX_ERROR && fit.factors.every((factor) => factor >= TINT_MIN_FACTOR);
}

/** Multiplies the RGB of every pixel by `factors`; alpha stays. */
export function applyTint(image: RgbaImage, factors: readonly [number, number, number]): RgbaImage {
  const data = image.data.slice();
  for (let i = 0; i < image.width * image.height; i++) {
    for (let c = 0; c < 3; c++) {
      data[i * 4 + c] = Math.round((data[i * 4 + c] ?? 0) * (factors[c] ?? 1));
    }
  }
  return { width: image.width, height: image.height, data };
}
