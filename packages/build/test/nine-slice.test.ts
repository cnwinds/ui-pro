import { describe, expect, it } from 'vitest';
import {
  cutNineSlice,
  cutWithMargins,
  mapThroughCut,
  showRatio,
  stretchTexture,
} from '../src/nine-slice';
import { sameImage, ssim } from '../src/raster';
import { type Color, makeImage } from './support';

const EDGE: Color = [20, 30, 80];
const FACE: Color = [220, 200, 150];

/** A framed box: an `edge` border of `border` pixels around a flat face. */
const frame = (width: number, height: number, border: number) =>
  makeImage(width, height, (x, y) =>
    x < border || y < border || x >= width - border || y >= height - border ? EDGE : FACE,
  );

describe('cutNineSlice', () => {
  it('cuts a framed box down to its corners and stretches it back to the same picture', () => {
    const image = frame(40, 30, 5);

    const outcome = cutNineSlice(image, 'nine-slice');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.cut.margins).toEqual([5, 5, 5, 5]);
    expect(outcome.cut.axes).toBe('both');
    expect([outcome.cut.texture.width, outcome.cut.texture.height]).toEqual([12, 12]);
    expect(outcome.cut.ssim).toBeGreaterThanOrEqual(0.95);
    const restored = stretchTexture(outcome.cut.texture, outcome.cut.margins, 40, 30);
    expect(sameImage(restored, image)).toBe(true);
  });

  it('cuts a bar along its long side only when it is a three-slice', () => {
    const caps = (x: number) => (x < 6 ? 40 + x * 30 : x >= 54 ? 40 + (59 - x) * 30 : 200);
    const bar = makeImage(60, 20, (x) => [caps(x), 120, 60]);

    const outcome = cutNineSlice(bar, 'three-slice');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.cut.axes).toBe('x');
    expect(outcome.cut.margins).toEqual([6, 0, 6, 0]);
    expect(outcome.cut.texture.width).toBe(14);
    expect(outcome.cut.texture.height).toBe(20);
    expect(sameImage(stretchTexture(outcome.cut.texture, outcome.cut.margins, 60, 20), bar)).toBe(
      true,
    );
  });

  it('explains why a picture with no uniform band is left at its fixed size', () => {
    const stripes = makeImage(40, 30, (x, y) => {
      const v = ((x + y) * 37) % 256;
      return [v, 255 - v, (v * 3) % 256];
    });

    const outcome = cutNineSlice(stripes, 'nine-slice');

    expect(outcome).toEqual({
      ok: false,
      reason: expect.stringContaining('没有找到至少 4 像素宽'),
    });
  });

  it('keeps a feature in the middle of the face where it was', () => {
    // A dark block in the middle: only the uniform columns and rows beside it may collapse.
    const image = makeImage(60, 40, (x, y) => {
      if (x < 4 || y < 4 || x >= 56 || y >= 36) return EDGE;
      if (x >= 28 && x < 34 && y >= 16 && y < 24) return [10, 10, 10];
      return FACE;
    });

    const outcome = cutNineSlice(image, 'nine-slice');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const [left, top, right, bottom] = outcome.cut.margins;
    expect(left).toBeGreaterThanOrEqual(4);
    expect(top).toBeGreaterThanOrEqual(4);
    expect(outcome.cut.texture.width).toBeLessThan(60);
    expect(outcome.cut.texture.height).toBeLessThan(40);
    const restored = stretchTexture(outcome.cut.texture, [left, top, right, bottom], 60, 40);
    expect(ssim(restored, image)).toBeGreaterThanOrEqual(0.95);
    expect(outcome.cut.ssim).toBeGreaterThanOrEqual(0.95);
  });
});

describe('cutWithMargins', () => {
  it('cuts a state picture with the margins of the normal look', () => {
    const outcome = cutWithMargins(frame(40, 30, 5), [5, 5, 5, 5]);

    expect(outcome.ok).toBe(true);
    if (outcome.ok)
      expect([outcome.cut.texture.width, outcome.cut.texture.height]).toEqual([12, 12]);
  });

  it('leaves an axis alone when both of its margins are zero', () => {
    const bar = makeImage(60, 20, (x) => [x < 6 ? 40 + x * 30 : 200, 120, 60]);

    const outcome = cutWithMargins(bar, [6, 0, 0, 0]);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.cut.texture.height).toBe(20);
  });
});

describe('mapThroughCut', () => {
  const full = { width: 40, height: 30 };
  const texture = { width: 12, height: 12 };

  it('keeps what lies inside a margin where it was', () => {
    expect(mapThroughCut([0, 0, 5, 5], [5, 5, 5, 5], full, texture)).toEqual([0, 0, 5, 5]);
  });

  it('keeps distances to the far margin', () => {
    expect(mapThroughCut([35, 25, 5, 5], [5, 5, 5, 5], full, texture)).toEqual([7, 7, 5, 5]);
  });

  it('gives a rectangle inside the collapsed band at least one kept pixel', () => {
    const [x, y, w, h] = mapThroughCut([15, 10, 8, 8], [5, 5, 5, 5], full, texture);

    expect(x).toBeGreaterThanOrEqual(5);
    expect(y).toBeGreaterThanOrEqual(5);
    expect(w).toBeGreaterThanOrEqual(1);
    expect(h).toBeGreaterThanOrEqual(1);
    expect(x + w).toBeLessThanOrEqual(texture.width);
    expect(y + h).toBeLessThanOrEqual(texture.height);
  });
});

describe('showRatio', () => {
  it('floors to two decimals so 0.999 never reads as 1.00', () => {
    expect(showRatio(0.999)).toBe('0.99');
    expect(showRatio(1)).toBe('1.00');
    expect(showRatio(0.9512)).toBe('0.95');
  });
});
