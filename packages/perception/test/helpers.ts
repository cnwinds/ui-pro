import type { Rect } from '@ui-pro/core';
import sharp from 'sharp';
import { decodeImage, type RgbaImage } from '../src/image';

export const SVG_FONT = 'Arial, Helvetica, sans-serif';

export function svgDocument(width: number, height: number, body: string, background = '#f3e3c8') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${background}"/>${body}</svg>`;
}

export async function pngFromSvg(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export async function imageFromSvg(svg: string): Promise<RgbaImage> {
  return decodeImage(await pngFromSvg(svg));
}

/** Bounding box of the pixels inside `region` that are darker than `threshold` (0-255 luma). */
export function inkBounds(image: RgbaImage, region: Rect, threshold = 110): Rect | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = -1;
  let maxY = -1;
  for (let y = region[1]; y < region[1] + region[3]; y++) {
    for (let x = region[0]; x < region[0] + region[2]; x++) {
      const at = (y * image.width + x) * 4;
      const luma =
        0.299 * (image.data[at] ?? 0) +
        0.587 * (image.data[at + 1] ?? 0) +
        0.114 * (image.data[at + 2] ?? 0);
      if (luma >= threshold) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return maxX < 0 ? null : [minX, minY, maxX - minX + 1, maxY - minY + 1];
}

/** The largest distance between corresponding edges of two boxes, in pixels. */
export function edgeGap(a: Rect, b: Rect): number {
  return Math.max(
    Math.abs(a[0] - b[0]),
    Math.abs(a[1] - b[1]),
    Math.abs(a[0] + a[2] - (b[0] + b[2])),
    Math.abs(a[1] + a[3] - (b[1] + b[3])),
  );
}
