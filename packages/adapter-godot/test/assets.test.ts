import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { meanAbsDiff } from '../src';

describe('meanAbsDiff', () => {
  const solid = (value: number, width = 4, height = 4) =>
    sharp({ create: { width, height, channels: 3, background: { r: value, g: value, b: value } } })
      .png()
      .toBuffer();

  it('is 0 for identical images and 1 for black against white', async () => {
    expect(await meanAbsDiff(await solid(90), await solid(90), 4, 4)).toBe(0);
    expect(await meanAbsDiff(await solid(0), await solid(255), 4, 4)).toBe(1);
  });

  it('scales the images to the same size first', async () => {
    const diff = await meanAbsDiff(await solid(0, 2, 2), await solid(51, 10, 10), 8, 8);

    expect(diff).toBeCloseTo(0.2, 5);
  });

  it('puts transparent pixels on black', async () => {
    const clear = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 0 },
      },
    })
      .png()
      .toBuffer();

    expect(await meanAbsDiff(clear, await solid(0, 2, 2), 2, 2)).toBe(0);
  });
});
