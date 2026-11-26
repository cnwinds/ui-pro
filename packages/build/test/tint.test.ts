import { describe, expect, it } from 'vitest';
import { applyTint, fitTint, tintAcceptable } from '../src/tint';
import { makeImage, pixelAt } from './support';

const master = makeImage(8, 8, (x, y) => [60 + x * 20, 90 + y * 15, 200 - x * 10 - y * 5]);

function times(factors: [number, number, number]) {
  return makeImage(8, 8, (x, y) => {
    const [r, g, b] = pixelAt(master, x, y);
    return [
      Math.round((r ?? 0) * factors[0]),
      Math.round((g ?? 0) * factors[1]),
      Math.round((b ?? 0) * factors[2]),
    ];
  });
}

describe('fitTint', () => {
  it('finds the multiply colour that darkens each channel by its own factor', () => {
    const fit = fitTint(master, times([0.5, 0.8, 1]));

    expect(fit).toBeDefined();
    expect(fit?.color).toBe('#80ccff');
    expect(fit?.error).toBeLessThan(1.5);
    expect(fit && tintAcceptable(fit)).toBe(true);
  });

  it('is exact for an unchanged picture', () => {
    const fit = fitTint(master, master);

    expect(fit?.color).toBe('#ffffff');
    expect(fit?.error).toBe(0);
  });

  it('cannot brighten: a lighter instance fits badly and is not acceptable', () => {
    const lighter = makeImage(8, 8, (x, y) => {
      const [r, g, b] = pixelAt(master, x, y);
      return [
        Math.min(255, (r ?? 0) * 1.6),
        Math.min(255, (g ?? 0) * 1.6),
        Math.min(255, (b ?? 0) * 1.6),
      ];
    });

    const fit = fitTint(master, lighter);

    expect(fit?.factors).toEqual([1, 1, 1]);
    expect(fit && tintAcceptable(fit)).toBe(false);
  });

  it('does not accept a factor so small that it is a different picture', () => {
    const fit = fitTint(master, times([0.08, 0.08, 0.08]));

    expect(fit && tintAcceptable(fit)).toBe(false);
  });

  it('is undefined for pictures of different size or silhouette', () => {
    expect(
      fitTint(
        master,
        makeImage(6, 8, () => [10, 10, 10]),
      ),
    ).toBeUndefined();
    const hollow = makeImage(8, 8, (x) => (x < 4 ? [10, 10, 10, 0] : [10, 10, 10, 255]));
    expect(fitTint(master, hollow)).toBeUndefined();
  });
});

describe('applyTint', () => {
  it('multiplies the colour channels and leaves alpha alone', () => {
    const image = makeImage(2, 1, () => [200, 100, 50, 128]);

    const tinted = applyTint(image, [0.5, 1, 0]);

    expect(pixelAt(tinted, 0, 0)).toEqual([100, 100, 0, 128]);
    expect(pixelAt(image, 0, 0)).toEqual([200, 100, 50, 128]);
  });
});
