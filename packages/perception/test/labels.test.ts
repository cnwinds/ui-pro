import type { Rect } from '@ui-pro/core';
import { describe, expect, it } from 'vitest';
import { intersectionArea } from '../src/geometry';
import { LABEL_HEIGHT, type LabelPlacement, labelWidth, placeLabels } from '../src/labels';
import { labelFor } from '../src/look';

describe('labelFor', () => {
  it('writes candidates as bare numbers and keeps node ids', () => {
    expect(labelFor('cand#47')).toBe('47');
    expect(labelFor('layer#12')).toBe('L12');
    expect(labelFor('container_3')).toBe('container_3');
  });
});

describe('placeLabels', () => {
  it('puts a label beside its box, inside the picture, when there is room', () => {
    const [placed] = placeLabels([{ label: '12', box: [100, 100, 60, 40] }], [400, 300]) as [
      LabelPlacement,
    ];

    expect(placed.detached).toBe(false);
    const [x, y, w, h] = placed.rect;
    expect([w, h]).toEqual([labelWidth('12'), LABEL_HEIGHT]);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x + w).toBeLessThanOrEqual(400);
    expect(y + h).toBeLessThanOrEqual(300);
  });

  it('keeps labels of neighbouring boxes from covering each other', () => {
    const requests = Array.from({ length: 12 }, (_, index) => ({
      label: String(100 + index),
      box: [40 + (index % 4) * 44, 40 + Math.floor(index / 4) * 30, 40, 26] as Rect,
    }));

    const placements = placeLabels(requests, [400, 300]);

    for (let a = 0; a < placements.length; a++) {
      for (let b = a + 1; b < placements.length; b++) {
        expect(
          intersectionArea(placements[a]?.rect as Rect, placements[b]?.rect as Rect),
          `labels ${a} and ${b}`,
        ).toBe(0);
      }
    }
  });

  it('answers in the order of the requests', () => {
    const requests = [
      { label: 'big', box: [10, 10, 200, 200] as Rect },
      { label: 'small', box: [300, 10, 10, 10] as Rect },
    ];

    const placements = placeLabels(requests, [400, 300]);

    expect(placements).toHaveLength(2);
    expect((placements[1]?.rect[0] ?? 0) >= 280).toBe(true);
  });
});
