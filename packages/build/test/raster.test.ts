import { describe, expect, it } from 'vitest';
import {
  alphaExtent,
  blankMask,
  bleedEdges,
  cropImage,
  decodePng,
  encodePng,
  growMask,
  hashDistance,
  maskBounds,
  maskCount,
  meanDifference,
  nearestSources,
  parseHex,
  pasteOver,
  perceptualHash,
  resizeImage,
  sameImage,
  sharpness,
  ssim,
  toHex,
} from '../src/raster';
import { makeImage, pixelAt } from './support';

const noise = (seed: number) =>
  makeImage(24, 24, (x, y) => {
    const v = (x * 53 + y * 97 + seed * 31) % 256;
    return [v, (v * 3) % 256, 255 - v];
  });

describe('png', () => {
  it('round-trips pixels and makes the same bytes for the same picture', async () => {
    const image = noise(1);

    const bytes = await encodePng(image);
    const back = await decodePng(bytes);

    expect(sameImage(back, image)).toBe(true);
    expect(Buffer.from(await encodePng(back)).equals(Buffer.from(bytes))).toBe(true);
  });
});

describe('geometry helpers', () => {
  it('finds the extent of visible pixels, or nothing', () => {
    const image = makeImage(10, 10, (x, y) => [
      1,
      2,
      3,
      x >= 2 && x < 5 && y >= 4 && y < 9 ? 255 : 0,
    ]);

    expect(alphaExtent(image)).toEqual([2, 4, 3, 5]);
    expect(alphaExtent(makeImage(4, 4, () => [0, 0, 0, 0]))).toBeUndefined();
  });

  it('crops and pastes with source-over blending', () => {
    const base = makeImage(4, 4, () => [0, 0, 255, 255]);
    const top = makeImage(2, 2, () => [255, 0, 0, 128]);

    pasteOver(base, top, 1, 1);

    expect(pixelAt(base, 0, 0)).toEqual([0, 0, 255, 255]);
    const [r, , b, a] = pixelAt(base, 1, 1);
    expect(r).toBeGreaterThan(120);
    expect(b).toBeGreaterThan(100);
    expect(a).toBe(255);
    expect(cropImage(base, [1, 1, 2, 2]).width).toBe(2);
  });

  it('resizes to the requested size', async () => {
    const out = await resizeImage(noise(2), 12, 6, 'nearest');

    expect([out.width, out.height]).toEqual([12, 6]);
  });
});

describe('masks', () => {
  it('grows a mask by a square radius and reports bounds and count', () => {
    const mask = blankMask(20, 20);
    mask.data[10 * 20 + 10] = 255;

    const grown = growMask(mask, 2);

    expect(maskCount(grown)).toBe(25);
    expect(maskBounds(grown)).toEqual([8, 8, 5, 5]);
    expect(maskCount(mask)).toBe(1);
  });

  it('finds the nearest known pixel for every pixel, -1 when nothing is known', () => {
    const known = new Uint8Array(5 * 1);
    known[0] = 1;
    known[4] = 1;

    const sources = nearestSources(known, 5, 1);

    expect([...sources]).toEqual([0, 0, 0, 4, 4]);
    expect([...nearestSources(new Uint8Array(4), 2, 2)]).toEqual([-1, -1, -1, -1]);
  });

  it('lets edge colour bleed into transparent pixels beside opaque ones', () => {
    const image = makeImage(5, 1, (x) => (x === 0 ? [200, 50, 20, 255] : [0, 0, 0, 0]));

    const out = bleedEdges(image, 2);

    expect(pixelAt(out, 1, 0)).toEqual([200, 50, 20, 0]);
    expect(pixelAt(out, 2, 0)).toEqual([200, 50, 20, 0]);
    expect(pixelAt(out, 4, 0)).toEqual([0, 0, 0, 0]);
    expect(pixelAt(out, 0, 0)).toEqual([200, 50, 20, 255]);
  });
});

describe('comparisons', () => {
  it('measures identical pictures as identical and different ones as different', () => {
    const a = noise(1);
    const b = noise(7);

    expect(ssim(a, a)).toBeCloseTo(1, 5);
    expect(ssim(a, b)).toBeLessThan(0.6);
    expect(meanDifference(a, a)).toBe(0);
    expect(meanDifference(a, b)).toBeGreaterThan(20);
  });

  it('hashes the look of a picture, not its bytes', () => {
    const smooth = makeImage(32, 32, (x) => [x * 8, x * 8, x * 8]);
    const slightly = makeImage(32, 32, (x) => [Math.min(255, x * 8 + 2), x * 8, x * 8]);
    const other = makeImage(32, 32, (x, y) =>
      ((x >> 2) + (y >> 2)) % 2 === 0 ? [0, 0, 0] : [255, 255, 255],
    );

    expect(perceptualHash(smooth)).toMatch(/^[0-9a-f]{16}$/);
    expect(hashDistance(perceptualHash(smooth), perceptualHash(slightly))).toBeLessThanOrEqual(2);
    expect(hashDistance(perceptualHash(smooth), perceptualHash(other))).toBeGreaterThan(12);
  });

  it('calls a crisp picture sharper than a flat one', () => {
    expect(sharpness(noise(1))).toBeGreaterThan(sharpness(makeImage(24, 24, () => [90, 90, 90])));
  });
});

describe('colour text', () => {
  it('writes and reads #rrggbb', () => {
    expect(toHex(255, 0, 16)).toBe('#ff0010');
    expect(parseHex('#ff0010')).toEqual([255, 0, 16]);
    expect(parseHex('red')).toBeUndefined();
  });
});
