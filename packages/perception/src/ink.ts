import type { Rect } from '@ui-pro/core';
import { clipToImage, coverage, expandBox, unionBox } from './geometry';
import type { RgbaImage } from './image';

/** Sobel magnitude, as the largest steepness any colour channel has at that pixel. */
export function edgeStrength(image: RgbaImage): Uint8Array {
  const { data, width, height } = image;
  const strength = new Uint8Array(width * height);
  const at = (x: number, y: number, channel: number) => data[(y * width + x) * 4 + channel] ?? 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let best = 0;
      for (let channel = 0; channel < 3; channel++) {
        const gx =
          at(x + 1, y - 1, channel) +
          2 * at(x + 1, y, channel) +
          at(x + 1, y + 1, channel) -
          at(x - 1, y - 1, channel) -
          2 * at(x - 1, y, channel) -
          at(x - 1, y + 1, channel);
        const gy =
          at(x - 1, y + 1, channel) +
          2 * at(x, y + 1, channel) +
          at(x + 1, y + 1, channel) -
          at(x - 1, y - 1, channel) -
          2 * at(x, y - 1, channel) -
          at(x + 1, y - 1, channel);
        best = Math.max(best, Math.hypot(gx, gy) / 4);
      }
      strength[y * width + x] = Math.min(255, Math.round(best));
    }
  }
  return strength;
}

export interface EdgeMap {
  strength: Uint8Array;
  width: number;
  height: number;
}

export interface InkBlob {
  box: Rect;
  pixels: number;
}

export const INK_THRESHOLD = 26;

/**
 * Connected groups (8-neighbourhood) of strong-edge pixels inside `region`; each box covers
 * edge pixels only. Nothing is dilated, so touching strokes of neighbouring elements stay apart.
 */
export function inkBlobs(map: EdgeMap, region: Rect, threshold = INK_THRESHOLD): InkBlob[] {
  const [left, top, width, height] = clipToImage(region, map.width, map.height);
  if (width === 0 || height === 0) return [];
  const ink = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((map.strength[(top + y) * map.width + left + x] ?? 0) >= threshold) {
        ink[y * width + x] = 1;
      }
    }
  }
  const label = new Int32Array(width * height).fill(-1);
  const blobs: { minX: number; minY: number; maxX: number; maxY: number; pixels: number }[] = [];
  const stack: number[] = [];
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || label[start] !== -1) continue;
    const id = blobs.length;
    const blob = { minX: width, minY: height, maxX: -1, maxY: -1, pixels: 0 };
    blobs.push(blob);
    label[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const index = stack.pop() as number;
      const x = index % width;
      const y = (index - x) / width;
      if (ink[index]) {
        blob.minX = Math.min(blob.minX, x);
        blob.maxX = Math.max(blob.maxX, x);
        blob.minY = Math.min(blob.minY, y);
        blob.maxY = Math.max(blob.maxY, y);
        blob.pixels++;
      }
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (ink[next] && label[next] === -1) {
            label[next] = id;
            stack.push(next);
          }
        }
      }
    }
  }
  return blobs
    .filter((blob) => blob.pixels > 0)
    .map((blob) => ({
      box: [
        left + blob.minX,
        top + blob.minY,
        blob.maxX - blob.minX + 1,
        blob.maxY - blob.minY + 1,
      ] as Rect,
      pixels: blob.pixels,
    }));
}

const MAX_BLOB_ASPECT = 7;
const MIN_BLOB_HEIGHT = 0.25;
const MAX_BLOB_HEIGHT = 1.25;
const MIN_INSIDE = 0.8;
const FRAME_HEIGHT = 0.75;
const FRAME_WIDTH = 0.75;
const FRAME_HOLDS = 0.9;

/**
 * The blobs that look like glyphs of a text whose box is `box`: not taller than the text, not
 * long bars, and lying inside the box. Rings around the text (a badge's outline) stick out of it
 * and are left out.
 */
export function glyphBlobs(blobs: readonly InkBlob[], box: Rect, margin: number): InkBlob[] {
  const [, , textWidth, textHeight] = box;
  const outer = expandBox(box, margin);
  const plausible = blobs.filter(({ box: blob }) => {
    const [, , w, h] = blob;
    return (
      h >= MIN_BLOB_HEIGHT * textHeight &&
      h <= MAX_BLOB_HEIGHT * textHeight + margin &&
      w <= MAX_BLOB_ASPECT * Math.max(h, textHeight) &&
      coverage(blob, outer) >= MIN_INSIDE
    );
  });
  // A badge's outline spans the whole box and wraps the glyphs; the glyphs are the text.
  return plausible.filter(({ box: blob }) => {
    const spansBox = blob[3] >= FRAME_HEIGHT * textHeight && blob[2] >= FRAME_WIDTH * textWidth;
    return (
      !spansBox ||
      !plausible.some(({ box: inner }) => inner !== blob && coverage(inner, blob) >= FRAME_HOLDS)
    );
  });
}

/** The box tightened to the glyphs inside it, or `box` itself when no glyph can be made out. */
export function tightenToInk(map: EdgeMap, box: Rect, margin = 2): Rect {
  const threshold = inkThreshold(map, box);
  const reach = Math.max(RING_REACH, Math.round(box[3] * 0.5));
  const blobs = glyphBlobs(inkBlobs(map, expandBox(box, reach), threshold), box, margin);
  if (blobs.length === 0) return box;
  const tight = unionBox(blobs.map((blob) => blob.box));
  return tight[2] * tight[3] >= MIN_TIGHT_SHARE * box[2] * box[3] ? tight : box;
}

const MIN_TIGHT_SHARE = 0.25;
const RING_REACH = 6;
const MAX_INK_THRESHOLD = 120;
const PEAK_SHARE = 0.5;

/** Half of the steepness the box's sharpest edges have: weak shading around the text stays out. */
function inkThreshold(map: EdgeMap, box: Rect): number {
  const [left, top, width, height] = clipToImage(box, map.width, map.height);
  const values: number[] = [];
  for (let y = top; y < top + height; y++) {
    for (let x = left; x < left + width; x++) values.push(map.strength[y * map.width + x] ?? 0);
  }
  values.sort((a, b) => a - b);
  const peak = values[Math.floor(values.length * 0.95)] ?? 0;
  return Math.min(MAX_INK_THRESHOLD, Math.max(INK_THRESHOLD, Math.round(peak * PEAK_SHARE)));
}
