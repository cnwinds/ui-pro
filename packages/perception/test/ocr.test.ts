import { describe, expect, it } from 'vitest';
import { boundsOf, toImagePoint } from '../src/ocr';

describe('toImagePoint', () => {
  it('undoes a plain resize', () => {
    const geometry = { imageWidth: 100, imageHeight: 50, resizedWidth: 200, resizedHeight: 100 };

    expect(toImagePoint([100, 50], geometry)).toEqual([50, 25]);
    expect(toImagePoint([0, 0], geometry)).toEqual([0, 0]);
  });

  it('undoes the letterbox the library adds when the aspect ratio changes', () => {
    // 100x40 contained in 128x64: factor 1.28, 51 rows of picture centred with 6 rows above.
    const geometry = { imageWidth: 100, imageHeight: 40, resizedWidth: 128, resizedHeight: 64 };

    const [x, y] = toImagePoint([64, 32], geometry);

    expect(x).toBeCloseTo(50, 5);
    expect(y).toBeCloseTo((32 - 6) / 1.28, 5);
  });

  it('keeps points inside the image', () => {
    const geometry = { imageWidth: 100, imageHeight: 40, resizedWidth: 128, resizedHeight: 64 };

    expect(toImagePoint([500, -9], geometry)).toEqual([100, 0]);
  });
});

describe('boundsOf', () => {
  it('boxes a tilted polygon', () => {
    expect(
      boundsOf([
        [10, 4],
        [30, 8],
        [28, 20],
        [8, 16],
      ]),
    ).toEqual([8, 4, 22, 16]);
  });
});
