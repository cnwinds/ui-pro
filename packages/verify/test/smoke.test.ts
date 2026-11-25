import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

describe('verify dependencies', () => {
  it('sharp resizes a 2x2 PNG', async () => {
    const png = await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } },
    })
      .png()
      .toBuffer();

    const { info } = await sharp(png)
      .resize(6, 6, { kernel: 'nearest' })
      .toBuffer({ resolveWithObject: true });

    expect([info.width, info.height]).toEqual([6, 6]);
  });
});
