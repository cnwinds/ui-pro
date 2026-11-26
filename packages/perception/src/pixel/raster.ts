import { createHash } from 'node:crypto';
import type { Rect } from '@ui-pro/core';
import sharp from 'sharp';
import type { GrayMask, RgbaImage } from './types';

export type Kernel = 'nearest' | 'cubic' | 'lanczos3';

export function sha256Hex(...parts: Uint8Array[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}

/** Decodes any image format sharp reads into straight RGBA, keeping the alpha channel. */
export async function decodeBytes(bytes: Uint8Array): Promise<RgbaImage> {
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

export async function encodePng(image: RgbaImage): Promise<Uint8Array> {
  const buffer = await sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .png({ compressionLevel: 6 })
    .toBuffer();
  return new Uint8Array(buffer);
}

/** A 3-channel PNG without alpha, what the cloud service takes for pictures. */
export async function encodeRgbPng(image: RgbaImage): Promise<Uint8Array> {
  const buffer = await sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .removeAlpha()
    .png({ compressionLevel: 6 })
    .toBuffer();
  return new Uint8Array(buffer);
}

/** A 3-channel PNG with only pure white and pure black, as the service's mask input needs. */
export async function encodeMaskPng(mask: GrayMask): Promise<Uint8Array> {
  const rgb = new Uint8Array(mask.width * mask.height * 3);
  for (let i = 0; i < mask.width * mask.height; i++) {
    const value = (mask.data[i] ?? 0) >= 128 ? 255 : 0;
    rgb[i * 3] = value;
    rgb[i * 3 + 1] = value;
    rgb[i * 3 + 2] = value;
  }
  const buffer = await sharp(rgb, {
    raw: { width: mask.width, height: mask.height, channels: 3 },
  })
    .png({ compressionLevel: 6 })
    .toBuffer();
  return new Uint8Array(buffer);
}

export function newImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

export function newMask(width: number, height: number, value = 0): GrayMask {
  return { width, height, data: new Uint8Array(width * height).fill(value) };
}

export function cloneImage(image: RgbaImage): RgbaImage {
  return { width: image.width, height: image.height, data: new Uint8Array(image.data) };
}

/** `rect` clipped to the image and rounded outwards to whole pixels. */
export function clipRect([x, y, w, h]: Rect, width: number, height: number): Rect {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(width, Math.ceil(x + w));
  const bottom = Math.min(height, Math.ceil(y + h));
  return [left, top, Math.max(0, right - left), Math.max(0, bottom - top)];
}

export function cropImage(image: RgbaImage, [x, y, w, h]: Rect): RgbaImage {
  const out = newImage(w, h);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * image.width + x) * 4;
    out.data.set(image.data.subarray(from, from + w * 4), row * w * 4);
  }
  return out;
}

export function cropMask(mask: GrayMask, [x, y, w, h]: Rect): GrayMask {
  const out = newMask(w, h);
  for (let row = 0; row < h; row++) {
    const from = (y + row) * mask.width + x;
    out.data.set(mask.data.subarray(from, from + w), row * w);
  }
  return out;
}

/** Copies `source` into `target` with its top-left corner at (x, y); parts outside are dropped. */
export function pasteImage(target: RgbaImage, source: RgbaImage, x: number, y: number): void {
  for (let row = 0; row < source.height; row++) {
    const ty = y + row;
    if (ty < 0 || ty >= target.height) continue;
    const left = Math.max(0, -x);
    const right = Math.min(source.width, target.width - x);
    if (right <= left) continue;
    const from = (row * source.width + left) * 4;
    target.data.set(
      source.data.subarray(from, from + (right - left) * 4),
      (ty * target.width + x + left) * 4,
    );
  }
}

export function pasteMask(target: GrayMask, source: GrayMask, x: number, y: number): void {
  for (let row = 0; row < source.height; row++) {
    const ty = y + row;
    if (ty < 0 || ty >= target.height) continue;
    const left = Math.max(0, -x);
    const right = Math.min(source.width, target.width - x);
    if (right <= left) continue;
    const from = row * source.width + left;
    target.data.set(
      source.data.subarray(from, from + (right - left)),
      ty * target.width + x + left,
    );
  }
}

export async function resizeImage(
  image: RgbaImage,
  width: number,
  height: number,
  kernel: Kernel = 'lanczos3',
): Promise<RgbaImage> {
  if (image.width === width && image.height === height) return cloneImage(image);
  const { data, info } = await sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .resize({ width, height, fit: 'fill', kernel })
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

export async function resizeMask(
  mask: GrayMask,
  width: number,
  height: number,
  kernel: Kernel = 'cubic',
): Promise<GrayMask> {
  if (mask.width === width && mask.height === height)
    return { ...mask, data: new Uint8Array(mask.data) };
  const { data, info } = await sharp(mask.data, {
    raw: { width: mask.width, height: mask.height, channels: 1 },
  })
    .resize({ width, height, fit: 'fill', kernel })
    .toColourspace('b-w')
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  // sharp may still hand back the grey value in every channel; the first is the mask.
  const stride = info.channels;
  const out = new Uint8Array(info.width * info.height);
  for (let i = 0; i < out.length; i++) out[i] = data[i * stride] ?? 0;
  return { width: info.width, height: info.height, data: out };
}

/** Extends the image on the right and bottom by mirroring its edges (what tiles and context need). */
export async function extendMirrored(
  image: RgbaImage,
  edges: { left?: number; top?: number; right?: number; bottom?: number },
): Promise<RgbaImage> {
  const { data, info } = await sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .extend({
      left: edges.left ?? 0,
      top: edges.top ?? 0,
      right: edges.right ?? 0,
      bottom: edges.bottom ?? 0,
      extendWith: 'mirror',
    })
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

/** Index into `0..size-1` with the coordinate reflected at both edges (period `2 * size - 2`). */
export function reflect(index: number, size: number): number {
  if (size <= 1) return 0;
  const period = 2 * size - 2;
  const wrapped = ((index % period) + period) % period;
  return wrapped < size ? wrapped : period - wrapped;
}

export function alphaOf(image: RgbaImage): GrayMask {
  const out = newMask(image.width, image.height);
  for (let i = 0; i < out.data.length; i++) out.data[i] = image.data[i * 4 + 3] ?? 0;
  return out;
}

/** Replaces the alpha channel of `image` (in place) with `alpha`. */
export function setAlpha(image: RgbaImage, alpha: GrayMask): void {
  for (let i = 0; i < alpha.data.length; i++) image.data[i * 4 + 3] = alpha.data[i] ?? 0;
}

/**
 * Gives pixels that are (nearly) transparent the colour of the opaque pixels next to them, so
 * that resampling the colour channels does not drag the colour of what lies beneath into edges.
 * Colour spreads at most `reach` pixels; the rest keeps the mean colour of the opaque pixels.
 */
export function bleedColors(image: RgbaImage, reach = 24, opaque = 128): RgbaImage {
  const { width, height } = image;
  const out = cloneImage(image);
  const known = new Uint8Array(width * height);
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;
  for (let i = 0; i < width * height; i++) {
    if ((image.data[i * 4 + 3] ?? 0) >= opaque) {
      known[i] = 1;
      sumR += image.data[i * 4] ?? 0;
      sumG += image.data[i * 4 + 1] ?? 0;
      sumB += image.data[i * 4 + 2] ?? 0;
      count++;
    }
  }
  if (count === 0 || count === width * height) return out;
  let frontier = known;
  for (let step = 0; step < reach; step++) {
    const next = new Uint8Array(frontier);
    let changed = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const at = y * width + x;
        if (frontier[at]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const neighbour = ny * width + nx;
            if (!frontier[neighbour]) continue;
            r += out.data[neighbour * 4] ?? 0;
            g += out.data[neighbour * 4 + 1] ?? 0;
            b += out.data[neighbour * 4 + 2] ?? 0;
            n++;
          }
        }
        if (n > 0) {
          out.data[at * 4] = Math.round(r / n);
          out.data[at * 4 + 1] = Math.round(g / n);
          out.data[at * 4 + 2] = Math.round(b / n);
          next[at] = 1;
          changed = true;
        }
      }
    }
    frontier = next;
    if (!changed) break;
  }
  const mean = [sumR, sumG, sumB].map((value) => Math.round(value / count));
  for (let i = 0; i < width * height; i++) {
    if (frontier[i]) continue;
    out.data[i * 4] = mean[0] ?? 0;
    out.data[i * 4 + 1] = mean[1] ?? 0;
    out.data[i * 4 + 2] = mean[2] ?? 0;
  }
  return out;
}
