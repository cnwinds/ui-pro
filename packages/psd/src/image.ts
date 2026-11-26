import type { Rect } from '@ui-pro/core';
import sharp from 'sharp';

/** Straight-alpha RGBA, row-major, 4 bytes per pixel. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export async function decodePng(png: Uint8Array): Promise<RgbaImage> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

export function encodePng(image: RgbaImage): Promise<Buffer> {
  const pixels = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  return sharp(pixels, { raw: { width: image.width, height: image.height, channels: 4 } })
    .png()
    .toBuffer();
}

/** Smallest rectangle containing every pixel with alpha above zero; `null` when there is none. */
export function alphaExtent(image: RgbaImage): Rect | null {
  const { width, height, data } = image;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      maxY = y;
    }
  }
  return maxX < 0 ? null : [minX, minY, maxX - minX + 1, maxY - minY + 1];
}

export function cropImage(image: RgbaImage, [x, y, w, h]: Rect): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * image.width + x) * 4;
    data.set(image.data.subarray(from, from + w * 4), row * w * 4);
  }
  return { width: w, height: h, data };
}
