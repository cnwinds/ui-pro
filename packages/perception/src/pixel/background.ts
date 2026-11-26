import type { Rect } from '@ui-pro/core';
import { dilate } from './mask';
import type { RgbaImage } from './types';

/** A colour that varies linearly over the image: `value = a + b * x + c * y` per channel. */
export interface PlaneFit {
  /** Colour of the plane at a pixel, unrounded. */
  at(x: number, y: number): [number, number, number];
  /** Root mean square of the residuals of the samples that fit (all channels together). */
  rms: number;
  /** Share of samples more than `OUTLIER` levels off in some channel. */
  outlierShare: number;
  samples: number;
}

const OUTLIER = 10;
const ITERATIONS = 3;
const MIN_SPREAD = 1e-6;

interface Coefficients {
  a: number;
  b: number;
  c: number;
}

function solve(
  xs: Float64Array,
  ys: Float64Array,
  values: Float64Array,
  use: Uint8Array,
  count: number,
): Coefficients {
  let mx = 0;
  let my = 0;
  let mv = 0;
  for (let i = 0; i < count; i++) {
    if (!use[i]) continue;
    mx += xs[i] as number;
    my += ys[i] as number;
    mv += values[i] as number;
  }
  let n = 0;
  for (let i = 0; i < count; i++) if (use[i]) n++;
  mx /= n;
  my /= n;
  mv /= n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sxv = 0;
  let syv = 0;
  for (let i = 0; i < count; i++) {
    if (!use[i]) continue;
    const dx = (xs[i] as number) - mx;
    const dy = (ys[i] as number) - my;
    const dv = (values[i] as number) - mv;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
    sxv += dx * dv;
    syv += dy * dv;
  }
  const det = sxx * syy - sxy * sxy;
  if (Math.abs(det) < MIN_SPREAD * Math.max(1, sxx * syy)) {
    return { a: mv, b: 0, c: 0 };
  }
  const b = (sxv * syy - syv * sxy) / det;
  const c = (syv * sxx - sxv * sxy) / det;
  return { a: mv - b * mx - c * my, b, c };
}

/**
 * Least-squares plane through the RGB colours of the pixels flagged in `samples`, refit a few
 * times without the pixels that do not belong (another element reaching into the ring). Null
 * when too few pixels are flagged.
 */
export function fitPlane(image: RgbaImage, samples: Uint8Array, minSamples = 16): PlaneFit | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (!samples[i]) continue;
    xs.push(i % image.width);
    ys.push(Math.floor(i / image.width));
  }
  const count = xs.length;
  if (count < minSamples) return null;
  const x = Float64Array.from(xs);
  const y = Float64Array.from(ys);
  const channels = [0, 1, 2].map((channel) => {
    const values = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      values[i] =
        image.data[((y[i] as number) * image.width + (x[i] as number)) * 4 + channel] ?? 0;
    }
    return values;
  });
  const use = new Uint8Array(count).fill(1);
  let planes: Coefficients[] = [];
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    planes = channels.map((values) => solve(x, y, values, use, count));
    let squares = 0;
    let inliers = 0;
    const worst = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      let largest = 0;
      for (let channel = 0; channel < 3; channel++) {
        const p = planes[channel] as Coefficients;
        const residual =
          (channels[channel]?.[i] as number) -
          (p.a + p.b * (x[i] as number) + p.c * (y[i] as number));
        largest = Math.max(largest, Math.abs(residual));
      }
      worst[i] = largest;
      if (use[i]) {
        squares += largest * largest;
        inliers++;
      }
    }
    const sigma = Math.sqrt(squares / Math.max(1, inliers));
    const limit = Math.max(2.5 * sigma, 4);
    let changed = false;
    for (let i = 0; i < count; i++) {
      const keep = (worst[i] as number) <= limit ? 1 : 0;
      if (keep !== use[i]) changed = true;
      use[i] = keep;
    }
    if (!changed || use.reduce((sum, flag) => sum + flag, 0) < minSamples) break;
  }
  let squares = 0;
  let inliers = 0;
  let outliers = 0;
  for (let i = 0; i < count; i++) {
    let largest = 0;
    let sum = 0;
    for (let channel = 0; channel < 3; channel++) {
      const p = planes[channel] as Coefficients;
      const residual =
        (channels[channel]?.[i] as number) -
        (p.a + p.b * (x[i] as number) + p.c * (y[i] as number));
      largest = Math.max(largest, Math.abs(residual));
      sum += residual * residual;
    }
    if (largest > OUTLIER) outliers++;
    if (use[i]) {
      squares += sum / 3;
      inliers++;
    }
  }
  const [pr, pg, pb] = planes as [Coefficients, Coefficients, Coefficients];
  return {
    at: (px, py) => [
      pr.a + pr.b * px + pr.c * py,
      pg.a + pg.b * px + pg.c * py,
      pb.a + pb.b * px + pb.c * py,
    ],
    rms: Math.sqrt(squares / Math.max(1, inliers)),
    outlierShare: outliers / count,
    samples: count,
  };
}

/** Pixels of a ring `width` wide around `box` (outside it, inside the image) as 0/1 flags. */
export function ringAround(image: RgbaImage, box: Rect, width: number, opaque = 128): Uint8Array {
  const flags = new Uint8Array(image.width * image.height);
  const [bx, by, bw, bh] = box;
  const x0 = Math.max(0, Math.floor(bx - width));
  const y0 = Math.max(0, Math.floor(by - width));
  const x1 = Math.min(image.width, Math.ceil(bx + bw + width));
  const y1 = Math.min(image.height, Math.ceil(by + bh + width));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const inside = x >= bx && x < bx + bw && y >= by && y < by + bh;
      if (!inside && (image.data[(y * image.width + x) * 4 + 3] ?? 0) >= opaque) {
        flags[y * image.width + x] = 1;
      }
    }
  }
  return flags;
}

/** Pixels of the `width` outermost rows and columns inside `box` (clipped to the image) as 0/1 flags. */
export function ringInside(image: RgbaImage, box: Rect, width: number, opaque = 128): Uint8Array {
  const flags = new Uint8Array(image.width * image.height);
  const x0 = Math.max(0, Math.floor(box[0]));
  const y0 = Math.max(0, Math.floor(box[1]));
  const x1 = Math.min(image.width, Math.ceil(box[0] + box[2]));
  const y1 = Math.min(image.height, Math.ceil(box[1] + box[3]));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const edge = x < x0 + width || x >= x1 - width || y < y0 + width || y >= y1 - width;
      if (edge && (image.data[(y * image.width + x) * 4 + 3] ?? 0) >= opaque) {
        flags[y * image.width + x] = 1;
      }
    }
  }
  return flags;
}

/** Pixels within `width` of the hole but not in or next to it, as 0/1 flags. */
export function ringAroundHole(
  image: RgbaImage,
  hole: Uint8Array,
  width: number,
  gap = 1,
  opaque = 128,
): Uint8Array {
  const outer = dilate(hole, image.width, image.height, gap + width);
  const inner = dilate(hole, image.width, image.height, gap);
  const flags = new Uint8Array(hole.length);
  for (let i = 0; i < flags.length; i++) {
    if (outer[i] && !inner[i] && (image.data[i * 4 + 3] ?? 0) >= opaque) flags[i] = 1;
  }
  return flags;
}
