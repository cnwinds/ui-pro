import type { Rect } from '@ui-pro/core';

export function area([, , w, h]: Rect): number {
  return w * h;
}

export function intersectionArea(a: Rect, b: Rect): number {
  const width = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const height = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return width > 0 && height > 0 ? width * height : 0;
}

export function iou(a: Rect, b: Rect): number {
  const shared = intersectionArea(a, b);
  const total = area(a) + area(b) - shared;
  return total > 0 ? shared / total : 0;
}

/** The share of `inner`'s area that lies inside `outer`. */
export function coverage(inner: Rect, outer: Rect): number {
  const size = area(inner);
  return size > 0 ? intersectionArea(inner, outer) / size : 0;
}

export function unionBox(boxes: readonly Rect[]): Rect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y, w, h] of boxes) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }
  return [minX, minY, maxX - minX, maxY - minY];
}

export function expandBox([x, y, w, h]: Rect, margin: number): Rect {
  return [x - margin, y - margin, w + 2 * margin, h + 2 * margin];
}

/** Clips to the image and rounds outwards to whole pixels. */
export function clipToImage(box: Rect, width: number, height: number): Rect {
  const left = Math.max(0, Math.floor(box[0]));
  const top = Math.max(0, Math.floor(box[1]));
  const right = Math.min(width, Math.ceil(box[0] + box[2]));
  const bottom = Math.min(height, Math.ceil(box[1] + box[3]));
  return [left, top, Math.max(0, right - left), Math.max(0, bottom - top)];
}

export function roundBox(box: Rect): Rect {
  return [Math.round(box[0]), Math.round(box[1]), Math.round(box[2]), Math.round(box[3])];
}
