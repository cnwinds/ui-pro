import { describe, expect, it } from 'vitest';
import { rotatedCrop, scaleAndPad } from '../src/image';
import { imageFromSvg, inkBounds, svgDocument } from './helpers';

describe('scaleAndPad', () => {
  it('enlarges and extends to a multiple, so the library does not letterbox', async () => {
    const image = await imageFromSvg(svgDocument(50, 30, ''));

    const padded = await scaleAndPad(image, 2, 32);

    expect([padded.width, padded.height]).toEqual([128, 64]);
    expect(padded.data.length).toBe(128 * 64 * 4);
  });
});

describe('rotatedCrop', () => {
  it('maps points of the rotated crop back to source pixels', async () => {
    const image = await imageFromSvg(
      svgDocument(300, 200, '<rect x="150" y="100" width="14" height="8" fill="#000"/>'),
    );

    for (const tilt of [12, -12]) {
      const crop = await rotatedCrop(image, [110, 70, 120, 70], 3, tilt);
      expect(crop).not.toBeNull();
      if (!crop) return;
      const ink = inkBounds(crop.image, [0, 0, crop.image.width, crop.image.height], 90);
      expect(ink).not.toBeNull();
      if (!ink) return;
      const [x, y] = crop.toSource([ink[0] + ink[2] / 2, ink[1] + ink[3] / 2]);

      expect(Math.abs(x - 157)).toBeLessThan(1.5);
      expect(Math.abs(y - 104)).toBeLessThan(1.5);
    }
  });

  it('returns nothing for a region outside the picture', async () => {
    const image = await imageFromSvg(svgDocument(50, 30, ''));

    expect(await rotatedCrop(image, [60, 40, 10, 10], 2, 12)).toBeNull();
  });
});
