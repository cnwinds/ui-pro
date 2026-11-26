import { luma } from './color';
import type { RgbaImage } from './types';

const WINDOW = 7;
const K1 = 0.01;
const K2 = 0.03;
const RANGE = 255;
/** Pixels at least this opaque in the reference take part. */
const OPAQUE = 128;

function integral(values: Float64Array, width: number, height: number): Float64Array {
  const stride = width + 1;
  const sums = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += values[y * width + x] as number;
      sums[(y + 1) * stride + x + 1] = (sums[y * stride + x + 1] as number) + row;
    }
  }
  return sums;
}

function windowSum(
  sums: Float64Array,
  stride: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) {
  return (
    (sums[y1 * stride + x1] as number) -
    (sums[y0 * stride + x1] as number) -
    (sums[y1 * stride + x0] as number) +
    (sums[y0 * stride + x0] as number)
  );
}

/**
 * Structural similarity of two same-size images over their luma, on a 7x7 uniform window,
 * averaged over the pixels that are opaque in `reference`. 1 means identical.
 */
export function ssim(reference: RgbaImage, other: RgbaImage): number {
  if (reference.width !== other.width || reference.height !== other.height) {
    throw new Error('ssim：两张图的尺寸必须相同');
  }
  const { width, height } = reference;
  const n = width * height;
  const a = new Float64Array(n);
  const b = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = luma(
      reference.data[i * 4] ?? 0,
      reference.data[i * 4 + 1] ?? 0,
      reference.data[i * 4 + 2] ?? 0,
    );
    b[i] = luma(other.data[i * 4] ?? 0, other.data[i * 4 + 1] ?? 0, other.data[i * 4 + 2] ?? 0);
  }
  const aa = a.map((v) => v * v);
  const bb = b.map((v) => v * v);
  const ab = a.map((v, i) => v * (b[i] as number));
  const sumA = integral(a, width, height);
  const sumB = integral(b, width, height);
  const sumAA = integral(aa, width, height);
  const sumBB = integral(bb, width, height);
  const sumAB = integral(ab, width, height);
  const stride = width + 1;
  const half = WINDOW >> 1;
  const c1 = (K1 * RANGE) ** 2;
  const c2 = (K2 * RANGE) ** 2;
  let total = 0;
  let counted = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((reference.data[(y * width + x) * 4 + 3] ?? 0) < OPAQUE) continue;
      const x0 = Math.max(0, x - half);
      const y0 = Math.max(0, y - half);
      const x1 = Math.min(width, x + half + 1);
      const y1 = Math.min(height, y + half + 1);
      const area = (x1 - x0) * (y1 - y0);
      const meanA = windowSum(sumA, stride, x0, y0, x1, y1) / area;
      const meanB = windowSum(sumB, stride, x0, y0, x1, y1) / area;
      const varA = windowSum(sumAA, stride, x0, y0, x1, y1) / area - meanA * meanA;
      const varB = windowSum(sumBB, stride, x0, y0, x1, y1) / area - meanB * meanB;
      const cov = windowSum(sumAB, stride, x0, y0, x1, y1) / area - meanA * meanB;
      total +=
        ((2 * meanA * meanB + c1) * (2 * cov + c2)) /
        ((meanA * meanA + meanB * meanB + c1) * (varA + varB + c2));
      counted++;
    }
  }
  return counted === 0 ? 1 : total / counted;
}
