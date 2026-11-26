import type { Rect } from '@ui-pro/core';
import sharp from 'sharp';

/** Straight (not premultiplied) 8-bit RGBA pixels, row by row. */
export interface Raster {
  width: number;
  height: number;
  data: Uint8Array;
}

/** `[x0, y0, x1, y1]` in pixels, the end exclusive. */
export type PixelBox = [number, number, number, number];

export async function decodeRaster(bytes: Uint8Array): Promise<Raster> {
  const { data, info } = await sharp(Buffer.from(bytes))
    .ensureAlpha()
    .toColourspace('srgb')
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

export function encodePng(raster: Raster): Promise<Buffer> {
  return sharp(Buffer.from(raster.data), {
    raw: { width: raster.width, height: raster.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

/** Resamples to another size; used only to line a reference up with a frame a pixel off. */
export async function resizeRaster(raster: Raster, width: number, height: number): Promise<Raster> {
  const { data, info } = await sharp(Buffer.from(raster.data), {
    raw: { width: raster.width, height: raster.height, channels: 4 },
  })
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

export function cropRaster(raster: Raster, [x0, y0, x1, y1]: PixelBox): Raster {
  const width = Math.max(0, x1 - x0);
  const height = Math.max(0, y1 - y0);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = ((y0 + y) * raster.width + x0) * 4;
    data.set(raster.data.subarray(from, from + width * 4), y * width * 4);
  }
  return { width, height, data };
}

/** The raster over an opaque ground, for looking at transparent assets on dark or light. */
export function compositeOver(raster: Raster, [r, g, b]: [number, number, number]): Raster {
  const out = new Uint8Array(raster.data.length);
  for (let i = 0; i < raster.data.length; i += 4) {
    const a = (raster.data[i + 3] ?? 0) / 255;
    out[i] = Math.round((raster.data[i] ?? 0) * a + r * (1 - a));
    out[i + 1] = Math.round((raster.data[i + 1] ?? 0) * a + g * (1 - a));
    out[i + 2] = Math.round((raster.data[i + 2] ?? 0) * a + b * (1 - a));
    out[i + 3] = 255;
  }
  return { width: raster.width, height: raster.height, data: out };
}

/** Rec. 601 luma of each pixel, 0–255, on the sRGB values as they are. */
export function grayscale(raster: Raster): Float32Array {
  const gray = new Float32Array(raster.width * raster.height);
  for (let i = 0; i < gray.length; i++) {
    const at = i * 4;
    gray[i] =
      0.299 * (raster.data[at] ?? 0) +
      0.587 * (raster.data[at + 1] ?? 0) +
      0.114 * (raster.data[at + 2] ?? 0);
  }
  return gray;
}

/** The pixels a design-space rectangle covers at `scale`, clipped to the image; `undefined` if none. */
export function pixelBox(
  rect: Rect,
  scale: number,
  width: number,
  height: number,
): PixelBox | undefined {
  const x0 = Math.max(0, Math.floor(rect[0] * scale));
  const y0 = Math.max(0, Math.floor(rect[1] * scale));
  const x1 = Math.min(width, Math.ceil((rect[0] + rect[2]) * scale));
  const y1 = Math.min(height, Math.ceil((rect[1] + rect[3]) * scale));
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : undefined;
}

export function growBox(
  [x0, y0, x1, y1]: PixelBox,
  by: number,
  width: number,
  height: number,
): PixelBox {
  return [
    Math.max(0, x0 - by),
    Math.max(0, y0 - by),
    Math.min(width, x1 + by),
    Math.min(height, y1 + by),
  ];
}

export const boxArea = ([x0, y0, x1, y1]: PixelBox): number => (x1 - x0) * (y1 - y0);

/** Clears (`0`) or sets (`1`) a mask over a box. */
export function fillMask(mask: Uint8Array, width: number, box: PixelBox, value: 0 | 1): void {
  for (let y = box[1]; y < box[3]; y++) mask.fill(value, y * width + box[0], y * width + box[2]);
}

/**
 * Grows the set pixels of a `width` x `height` mask by `radius` pixels in every direction (a
 * square window). Runs in time linear in the mask's size, whatever the radius.
 */
export function dilateMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  if (radius <= 0) return mask.slice();
  const across = new Uint8Array(width * height);
  const sums = new Int32Array(Math.max(width, height) + 1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) sums[x + 1] = (sums[x] ?? 0) + (mask[y * width + x] ? 1 : 0);
    for (let x = 0; x < width; x++) {
      const near =
        (sums[Math.min(width, x + radius + 1)] ?? 0) - (sums[Math.max(0, x - radius)] ?? 0);
      across[y * width + x] = near > 0 ? 1 : 0;
    }
  }
  const out = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) sums[y + 1] = (sums[y] ?? 0) + (across[y * width + x] ?? 0);
    for (let y = 0; y < height; y++) {
      const near =
        (sums[Math.min(height, y + radius + 1)] ?? 0) - (sums[Math.max(0, y - radius)] ?? 0);
      out[y * width + x] = near > 0 ? 1 : 0;
    }
  }
  return out;
}

/** Shrinks the set pixels by `radius`; the mask's border counts as unset. */
export function erodeMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const inverse = new Uint8Array(width * height);
  for (let i = 0; i < inverse.length; i++) inverse[i] = mask[i] ? 0 : 1;
  const grown = dilateMask(inverse, width, height, radius);
  const out = new Uint8Array(width * height);
  for (let y = radius; y < height - radius; y++) {
    for (let x = radius; x < width - radius; x++) {
      const at = y * width + x;
      out[at] = grown[at] ? 0 : 1;
    }
  }
  return out;
}

/** Intersection of two boxes, or `undefined`. */
export function intersectBox(a: PixelBox, b: PixelBox): PixelBox | undefined {
  const box: PixelBox = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
  return box[2] > box[0] && box[3] > box[1] ? box : undefined;
}

/** Draws 2-pixel outlines over a copy of the raster (the marks need no fonts, so no text). */
export async function outlineBoxes(
  raster: Raster,
  boxes: readonly PixelBox[],
  color = '#ff2d2d',
): Promise<Raster> {
  const rects = boxes
    .map(
      ([x0, y0, x1, y1]) =>
        `<rect x="${x0 + 1}" y="${y0 + 1}" width="${Math.max(1, x1 - x0 - 2)}" height="${Math.max(1, y1 - y0 - 2)}" fill="none" stroke="${color}" stroke-width="2"/>`,
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${raster.width}" height="${raster.height}">${rects}</svg>`;
  const { data, info } = await sharp(Buffer.from(raster.data), {
    raw: { width: raster.width, height: raster.height, channels: 4 },
  })
    .composite([{ input: Buffer.from(svg) }])
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}
