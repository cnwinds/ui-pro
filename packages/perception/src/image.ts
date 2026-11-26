import { readFile } from 'node:fs/promises';
import type { Rect } from '@ui-pro/core';
import sharp from 'sharp';
import { clipToImage } from './geometry';

/** Decoded pixels, 4 channels per pixel (alpha flattened onto white), row-major. */
export interface RgbaImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export async function decodeImage(source: string | Uint8Array): Promise<RgbaImage> {
  const bytes = typeof source === 'string' ? await readFile(source) : source;
  const { data, info } = await sharp(bytes)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** The image enlarged by `factor` (Lanczos) with its right and bottom edges extended to a multiple of `multiple`. */
export async function scaleAndPad(
  image: RgbaImage,
  factor: number,
  multiple: number,
): Promise<RgbaImage> {
  const width = Math.max(1, Math.round(image.width * factor));
  const height = Math.max(1, Math.round(image.height * factor));
  const paddedWidth = Math.ceil(width / multiple) * multiple;
  const paddedHeight = Math.ceil(height / multiple) * multiple;
  let pipeline = sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 4 },
  });
  if (width !== image.width || height !== image.height) {
    pipeline = pipeline.resize({ width, height, kernel: 'lanczos3' });
  }
  const { data, info } = await pipeline
    .extend({ right: paddedWidth - width, bottom: paddedHeight - height, extendWith: 'copy' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export interface RotatedCrop {
  /** The enlarged, rotated crop, extended to a multiple of 32 on the right and bottom. */
  image: RgbaImage;
  /** Maps a point of `image` back to pixels of the source image. */
  toSource(point: readonly [number, number]): [number, number];
}

function borderColor(image: RgbaImage, [left, top, width, height]: Rect) {
  const samples: number[][] = [[], [], []];
  const take = (x: number, y: number) => {
    const offset = (y * image.width + x) * 4;
    for (let channel = 0; channel < 3; channel++)
      samples[channel]?.push(image.data[offset + channel] ?? 0);
  };
  for (let x = left; x < left + width; x++) {
    take(x, top);
    take(x, top + height - 1);
  }
  for (let y = top; y < top + height; y++) {
    take(left, y);
    take(left + width - 1, y);
  }
  const median = (values: number[] | undefined) =>
    [...(values ?? [])].sort((a, b) => a - b)[Math.floor((values?.length ?? 0) / 2)] ?? 128;
  return { r: median(samples[0]), g: median(samples[1]), b: median(samples[2]), alpha: 1 };
}

/**
 * A crop of `region` enlarged by `factor` and rotated by `degrees` (clockwise). Texts that share
 * a row sit at different heights once the row is rotated, which keeps the recogniser from
 * joining them into one line.
 */
export async function rotatedCrop(
  image: RgbaImage,
  region: Rect,
  factor: number,
  degrees: number,
): Promise<RotatedCrop | null> {
  const [left, top, width, height] = clipToImage(region, image.width, image.height);
  if (width === 0 || height === 0) return null;
  const enlarged = await sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .extract({ left, top, width, height })
    .resize({
      width: Math.max(1, Math.round(width * factor)),
      height: Math.max(1, Math.round(height * factor)),
      kernel: 'lanczos3',
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rotated = await sharp(enlarged.data, {
    raw: { width: enlarged.info.width, height: enlarged.info.height, channels: 4 },
  })
    .rotate(degrees, { background: borderColor(image, [left, top, width, height]) })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    image: await scaleAndPad(
      { data: rotated.data, width: rotated.info.width, height: rotated.info.height },
      1,
      32,
    ),
    toSource([x, y]) {
      const dx = x - rotated.info.width / 2;
      const dy = y - rotated.info.height / 2;
      return [
        left + (dx * cos + dy * sin + enlarged.info.width / 2) / factor,
        top + (-dx * sin + dy * cos + enlarged.info.height / 2) / factor,
      ];
    },
  };
}
