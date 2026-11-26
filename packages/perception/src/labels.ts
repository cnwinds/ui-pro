import type { Rect } from '@ui-pro/core';
import { intersectionArea } from './geometry';

export const LABEL_HEIGHT = 15;
const CHAR_WIDTH = 7.6;
const LABEL_PADDING = 6;
const GAP = 1;
const RING_STEP = 10;
const RING_TURNS = 8;
const EDGE_STEPS = 8;

export interface LabelRequest {
  label: string;
  /** The box the label belongs to, in output pixels. */
  box: Rect;
}

export interface LabelPlacement {
  /** Output-pixel rectangle of the label. */
  rect: Rect;
  /** True when the label had to move away from its box and wants a line back to it. */
  detached: boolean;
}

export function labelWidth(label: string): number {
  return Math.ceil(label.length * CHAR_WIDTH + LABEL_PADDING);
}

function overlap(a: Rect, b: Rect): number {
  return intersectionArea([a[0] - GAP, a[1] - GAP, a[2] + 2 * GAP, a[3] + 2 * GAP], b);
}

/** Pushes a label back inside the picture. */
function keepInside(rect: Rect, size: readonly [number, number]): Rect {
  const x = Math.min(Math.max(0, rect[0]), Math.max(0, size[0] - rect[2]));
  const y = Math.min(Math.max(0, rect[1]), Math.max(0, size[1] - rect[3]));
  return [x, y, rect[2], rect[3]];
}

function positions(box: Rect, width: number): { rect: Rect; detached: boolean }[] {
  const [x, y, w, h] = box;
  const lh = LABEL_HEIGHT;
  const near: Rect[] = [
    [x, y - lh, width, lh],
    [x + w - width, y - lh, width, lh],
    [x, y + h, width, lh],
    [x + w - width, y + h, width, lh],
    [x - width, y, width, lh],
    [x + w, y, width, lh],
  ];
  if (w >= width + 6 && h >= lh + 6) near.splice(1, 0, [x + 2, y + 2, width, lh]);
  const found = near.map((rect) => ({ rect, detached: false }));
  // Big frames have room along their own edges, which beats a label floating in the middle.
  if (w >= width + 6 && h >= lh + 6) {
    for (let step = 1; step <= EDGE_STEPS; step++) {
      const along = step / (EDGE_STEPS + 1);
      for (const rect of [
        [x + (w - width) * along, y + 2, width, lh],
        [x + (w - width) * along, y + h - lh - 2, width, lh],
        [x + 2, y + (h - lh) * along, width, lh],
        [x + w - width - 2, y + (h - lh) * along, width, lh],
      ] as Rect[]) {
        found.push({ rect, detached: false });
      }
    }
  }
  const centerX = x + w / 2 - width / 2;
  const centerY = y + h / 2 - lh / 2;
  for (let ring = 1; ring <= RING_TURNS; ring++) {
    const distance = ring * RING_STEP;
    for (const [dx, dy] of [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      const reach = Math.max(w, h) / 2 + distance;
      found.push({
        rect: [centerX + dx * (reach + width / 2), centerY + dy * reach, width, lh],
        detached: true,
      });
    }
  }
  return found;
}

/**
 * Puts each label next to its box without covering other labels: small boxes choose first, so
 * that they keep the places closest to them. A label that finds no free place near its box
 * moves out and is marked as detached; if the picture is too crowded, it takes the place with
 * the least overlap.
 */
export function placeLabels(
  requests: readonly LabelRequest[],
  size: readonly [number, number],
): LabelPlacement[] {
  const order = requests
    .map((request, index) => ({ request, index }))
    .sort(
      (a, b) =>
        a.request.box[2] * a.request.box[3] - b.request.box[2] * b.request.box[3] ||
        a.index - b.index,
    );
  const placed: Rect[] = [];
  const result: LabelPlacement[] = new Array(requests.length);
  for (const { request, index } of order) {
    const width = labelWidth(request.label);
    let best: LabelPlacement | undefined;
    let bestOverlap = Number.POSITIVE_INFINITY;
    for (const option of positions(request.box, width)) {
      const rect = keepInside(option.rect, size);
      const cost = placed.reduce((sum, other) => sum + overlap(rect, other), 0);
      if (cost < bestOverlap) {
        best = { rect, detached: option.detached };
        bestOverlap = cost;
        if (cost === 0) break;
      }
    }
    const chosen = best as LabelPlacement;
    placed.push(chosen.rect);
    result[index] = chosen;
  }
  return result;
}
