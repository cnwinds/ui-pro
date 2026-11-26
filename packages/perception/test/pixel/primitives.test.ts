import { describe, expect, it } from 'vitest';
import { fitPlane, ringAroundHole } from '../../src/pixel/background';
import { deltaE, rgbToLab, toHex } from '../../src/pixel/color';
import { blendIntoHole, takeInside } from '../../src/pixel/compose';
import {
  localModelId,
  methodOfLock,
  readLocked,
  requestKey,
  tierOfLock,
} from '../../src/pixel/lock';
import {
  binarize,
  boundsOf,
  components,
  depthInside,
  dilate,
  distanceToOn,
  erode,
  featherWeights,
  fillHoles,
} from '../../src/pixel/mask';
import {
  decodeBytes,
  encodePng,
  extendMirrored,
  resizeImage,
  resizeMask,
} from '../../src/pixel/raster';
import { ssim } from '../../src/pixel/ssim';
import { blank, differing, fillRect, gradient, makeContext, maskOfRect, pixelAt } from './helpers';

const flagsOf = (width: number, height: number, rect: readonly [number, number, number, number]) =>
  Uint8Array.from(maskOfRect(width, height, rect).data, (v) => (v ? 1 : 0));

describe('mask', () => {
  it('measures the distance to the nearest set pixel exactly', () => {
    const flags = new Uint8Array(11 * 7);
    flags[3 * 11 + 5] = 1;
    const distance = distanceToOn(flags, 11, 7);
    expect(distance[3 * 11 + 5]).toBe(0);
    expect(distance[3 * 11 + 8]).toBeCloseTo(3, 5);
    expect(distance[0]).toBeCloseTo(Math.hypot(5, 3), 4);
    expect(distanceToOn(new Uint8Array(9), 3, 3)[4]).toBeGreaterThan(1e6);
  });

  it('knows how deep a pixel is inside a shape', () => {
    const flags = flagsOf(20, 20, [4, 4, 10, 10]);
    const depth = depthInside(flags, 20, 20);
    expect(depth[4 * 20 + 4]).toBe(1);
    expect(depth[8 * 20 + 8]).toBe(5);
    expect(depth[0]).toBe(0);
  });

  it('grows and shrinks by whole pixels', () => {
    const flags = flagsOf(30, 30, [10, 10, 6, 6]);
    expect(boundsOf(dilate(flags, 30, 30, 2), 30, 30)).toEqual([8, 8, 10, 10]);
    expect(boundsOf(erode(flags, 30, 30, 1), 30, 30)).toEqual([11, 11, 4, 4]);
    expect(boundsOf(new Uint8Array(900), 30, 30)).toBeNull();
  });

  it('finds components and fills enclosed holes', () => {
    const flags = flagsOf(30, 30, [2, 2, 8, 8]);
    for (const at of [20 * 30 + 20, 20 * 30 + 21, 21 * 30 + 20]) flags[at] = 1;
    flags[5 * 30 + 5] = 0;
    const parts = components(flags, 30, 30);
    expect(parts.map((part) => part.pixels.length)).toEqual([63, 3]);
    expect(parts[0]?.box).toEqual([2, 2, 8, 8]);
    expect(fillHoles(flags, 30, 30)[5 * 30 + 5]).toBe(1);
  });

  it('feathers inwards only', () => {
    const flags = flagsOf(20, 20, [5, 5, 10, 10]);
    const weights = featherWeights(flags, 20, 20, 3);
    expect(weights[4 * 20 + 4]).toBe(0);
    expect(weights[5 * 20 + 5]).toBeCloseTo(1 / 3, 5);
    expect(weights[7 * 20 + 7]).toBe(1);
    expect(featherWeights(flags, 20, 20, 0)[5 * 20 + 5]).toBe(1);
    expect(binarize({ width: 2, height: 1, data: Uint8Array.from([127, 128]) })).toEqual(
      Uint8Array.from([0, 1]),
    );
  });
});

describe('raster', () => {
  it('resizes a mask to a one-byte-per-pixel mask', async () => {
    const mask = maskOfRect(60, 60, [18, 20, 24, 20]);
    const big = await resizeMask(mask, 512, 512, 'cubic');
    expect(big.data.length).toBe(512 * 512);
    const on = big.data.reduce((n, v) => n + (v >= 128 ? 1 : 0), 0);
    expect(Math.abs(on / (512 * 512) - (24 * 20) / (60 * 60))).toBeLessThan(0.01);
    const small = await resizeMask(big, 30, 30, 'cubic');
    expect(small.data.length).toBe(900);
  });

  it('keeps colours exact for a nearest-neighbour resize', async () => {
    const image = blank(2, 2, [10, 20, 30]);
    fillRect(image, [1, 1, 1, 1], [200, 100, 50]);
    const big = await resizeImage(image, 8, 8, 'nearest');
    expect(pixelAt(big, 7, 7)).toEqual([200, 100, 50, 255]);
    expect(pixelAt(big, 3, 3)).toEqual([10, 20, 30, 255]);
  });

  it('round-trips PNG with alpha', async () => {
    const image = blank(3, 3, [1, 2, 3]);
    image.data[3] = 0;
    image.data[7] = 90;
    const back = await decodeBytes(await encodePng(image));
    expect(Array.from(back.data)).toEqual(Array.from(image.data).map((v, i) => (i === 0 ? 1 : v)));
  });

  it('extends by mirroring', async () => {
    const image = gradient(4, 4, [0, 0, 0], [255, 255, 255]);
    const wide = await extendMirrored(image, { right: 2, bottom: 1 });
    expect([wide.width, wide.height]).toEqual([6, 5]);
    expect(pixelAt(wide, 4, 0)).toEqual(pixelAt(image, 3, 0));
    expect(pixelAt(wide, 5, 0)).toEqual(pixelAt(image, 2, 0));
    expect(pixelAt(wide, 0, 4)).toEqual(pixelAt(image, 0, 3));
  });
});

describe('colour', () => {
  it('has distance zero to itself and a large one between very different colours', () => {
    const red = rgbToLab(255, 0, 0);
    expect(deltaE(red, red)).toBe(0);
    expect(deltaE(red, rgbToLab(0, 0, 255))).toBeGreaterThan(100);
    expect(deltaE(rgbToLab(100, 100, 100), rgbToLab(101, 100, 100))).toBeLessThan(1);
    expect(toHex(255, 210, 58)).toBe('#ffd23a');
  });
});

describe('background planes', () => {
  it('recovers a linear gradient from the ring around a hole', () => {
    const image = gradient(100, 80, [20, 40, 60], [220, 200, 160]);
    const flags = flagsOf(100, 80, [40, 30, 20, 20]);
    const plane = fitPlane(image, ringAroundHole(image, flags, 6, 1));
    expect(plane?.rms).toBeLessThan(1);
    const [r, g, b] = plane?.at(50, 40) ?? [0, 0, 0];
    const want = pixelAt(image, 50, 40);
    expect(Math.abs(r - want[0])).toBeLessThan(2);
    expect(Math.abs(g - want[1])).toBeLessThan(2);
    expect(Math.abs(b - want[2])).toBeLessThan(2);
  });

  it('is not fooled by a few outliers, and declines a picture that is no plane', () => {
    const image = blank(80, 80, [100, 100, 100]);
    for (let i = 0; i < 5; i++) fillRect(image, [10 + i * 12, 5, 2, 2], [255, 0, 0]);
    const clean = fitPlane(image, new Uint8Array(80 * 80).fill(1));
    expect(Math.abs((clean?.at(40, 40)[0] ?? 0) - 100)).toBeLessThan(3);

    const split = blank(80, 80, [0, 0, 0]);
    fillRect(split, [40, 0, 40, 80], [255, 255, 255]);
    const plane = fitPlane(split, new Uint8Array(80 * 80).fill(1));
    expect(plane === null || plane.rms > 10 || plane.outlierShare > 0.1).toBe(true);
  });
});

describe('ssim', () => {
  it('is 1 for identical images and falls with noise and structure loss', () => {
    const image = gradient(64, 64, [0, 0, 0], [255, 255, 255]);
    fillRect(image, [10, 10, 20, 20], [255, 0, 0]);
    expect(ssim(image, image)).toBe(1);
    const flat = blank(64, 64, [128, 128, 128]);
    expect(ssim(image, flat)).toBeLessThan(0.7);
    const noisy = { ...image, data: new Uint8Array(image.data) };
    for (let i = 0; i < 64 * 64; i++) {
      const jitter = ((i * 2654435761) % 41) - 20;
      for (let c = 0; c < 3; c++) {
        noisy.data[i * 4 + c] = Math.max(0, Math.min(255, (noisy.data[i * 4 + c] ?? 0) + jitter));
      }
    }
    expect(ssim(image, noisy)).toBeLessThan(0.9);
    // A small brightness change keeps the structure.
    const brighter = { ...image, data: new Uint8Array(image.data) };
    for (let i = 0; i < 64 * 64 * 4; i++) {
      if (i % 4 !== 3) brighter.data[i] = Math.min(255, (brighter.data[i] ?? 0) + 6);
    }
    expect(ssim(image, brighter)).toBeGreaterThan(0.95);
  });

  it('only counts pixels that are opaque in the reference', () => {
    const image = blank(32, 32, [200, 200, 200]);
    const other = blank(32, 32, [200, 200, 200]);
    fillRect(other, [0, 0, 32, 16], [0, 0, 0]);
    const opaque = ssim(image, other);
    for (let i = 0; i < 32 * 16; i++) image.data[i * 4 + 3] = 0;
    expect(ssim(image, other)).toBeGreaterThan(opaque + 0.1);
    expect(() => ssim(image, blank(8, 8))).toThrow(/尺寸/);
  });
});

describe('compose', () => {
  it('takes the generated pixels only inside the region', () => {
    const original = blank(10, 10, [10, 10, 10]);
    const generated = blank(10, 10, [200, 0, 0]);
    const region = flagsOf(10, 10, [3, 3, 4, 4]);
    const out = takeInside(original, generated, region);
    expect(pixelAt(out, 4, 4)).toEqual([200, 0, 0, 255]);
    expect(pixelAt(out, 2, 2)).toEqual([10, 10, 10, 255]);
  });

  it('fades the generated pixels in from the colour outside, never from what the hole held', () => {
    const original = blank(20, 20, [10, 10, 10]);
    fillRect(original, [5, 5, 10, 10], [255, 0, 255]);
    const generated = blank(20, 20, [110, 110, 110]);
    const hole = flagsOf(20, 20, [5, 5, 10, 10]);
    const out = blendIntoHole(original, generated, hole, 4);
    expect(pixelAt(out, 5, 10)[0]).toBe(35);
    expect(pixelAt(out, 6, 10)[0]).toBe(60);
    expect(pixelAt(out, 7, 10)[0]).toBe(85);
    expect(pixelAt(out, 9, 10)).toEqual([110, 110, 110, 255]);
    const outside = Uint8Array.from(hole, (v) => (v ? 0 : 1));
    expect(differing(out, original, outside)).toBe(0);
    // No feather: a hard edge.
    expect(pixelAt(blendIntoHole(original, generated, hole, 0), 5, 10)).toEqual([
      110, 110, 110, 255,
    ]);
  });
});

describe('locking', () => {
  const image = blank(4, 4, [1, 2, 3]);
  const hole = maskOfRect(4, 4, [1, 1, 2, 2]);

  it('derives the same key for the same request and another for any change', () => {
    const key = requestKey('fill', 'local:lama', { style: 'smooth' }, [image, hole]);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(requestKey('fill', 'local:lama', { style: 'smooth' }, [image, hole])).toBe(key);
    expect(requestKey('fill', 'local:lama', { style: 'pixel' }, [image, hole])).not.toBe(key);
    expect(requestKey('upscale', 'local:lama', { style: 'smooth' }, [image, hole])).not.toBe(key);
    expect(requestKey('fill', 'cloud:a/b', { style: 'smooth' }, [image, hole])).not.toBe(key);
    expect(
      requestKey('fill', 'local:lama', { style: 'smooth' }, [blank(4, 4, [1, 2, 4]), hole]),
    ).not.toBe(key);
    expect(
      requestKey('fill', 'local:lama', { style: 'smooth' }, [blank(2, 8, [1, 2, 3]), hole]),
    ).not.toBe(key);
    // Parameter order does not matter.
    expect(requestKey('x', 'm', { a: 1, b: 2 }, [image])).toBe(
      requestKey('x', 'm', { b: 2, a: 1 }, [image]),
    );
  });

  it('names models and tiers', () => {
    expect(localModelId('lama')).toMatch(/^local:lama@[0-9a-f]{12}$/);
    expect(methodOfLock('local:lama')).toBe('lama');
    expect(methodOfLock('cloud:dashscope/wanx2.1-imageedit')).toBe('dashscope/wanx2.1-imageedit');
    expect(tierOfLock('cloud:x/y')).toBe('cloud');
    expect(tierOfLock('local:lama')).toBe('local');
  });

  it('reads a locked output only when it is a picture of the expected size', async () => {
    const { context, store } = makeContext();
    const key = 'a'.repeat(64);
    expect(await readLocked(context, key, image)).toBeUndefined();
    await store.put({ key, by: 'local:lama', png: await encodePng(image) });
    expect((await readLocked(context, key, image))?.by).toBe('local:lama');
    expect(await readLocked(context, key, { width: 5, height: 4 })).toBeUndefined();
    await store.put({ key, by: 'local:lama', png: new Uint8Array([1, 2, 3]) });
    expect(await readLocked(context, key, image)).toBeUndefined();
  });
});
