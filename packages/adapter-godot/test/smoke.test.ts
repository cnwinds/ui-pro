import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

describe('adapter-godot dependencies', () => {
  it('sharp resizes a 2x2 PNG', async () => {
    const png = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    const { info } = await sharp(png)
      .resize(6, 6, { kernel: 'nearest' })
      .toBuffer({ resolveWithObject: true });

    expect([info.width, info.height]).toEqual([6, 6]);
  });
});
