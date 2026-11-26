import { describe, expect, it } from 'vitest';
import { deltaE2000, deltaERgb, rgbToLab } from '../src/color';
import {
  cropRaster,
  decodeRaster,
  dilateMask,
  encodePng,
  erodeMask,
  grayscale,
  pixelBox,
  type Raster,
} from '../src/raster';
import { ssimMap } from '../src/ssim';

describe('ΔE2000', () => {
  it('与 Sharma 等人给出的参考数据一致', () => {
    // Sharma, Wu, Dalal (2005), pairs 1, 2 and 7.
    expect(deltaE2000(50, 2.6772, -79.7751, 50, 0, -82.7485)).toBeCloseTo(2.0425, 3);
    expect(deltaE2000(50, 3.1571, -77.2803, 50, 0, -82.7485)).toBeCloseTo(2.8615, 3);
    expect(deltaE2000(50, 2.5, 0, 50, 0, -2.5)).toBeCloseTo(4.3065, 3);
  });

  it('同色为 0，黑白相差约 100，且对称', () => {
    expect(deltaERgb(10, 20, 30, 10, 20, 30)).toBe(0);
    expect(deltaERgb(0, 0, 0, 255, 255, 255)).toBeCloseTo(100, 0);
    expect(deltaERgb(200, 30, 30, 30, 30, 200)).toBeCloseTo(deltaERgb(30, 30, 200, 200, 30, 30), 6);
  });

  it('sRGB 白在 D65 下是 L=100、a=b=0', () => {
    const lab = rgbToLab(255, 255, 255);
    expect(lab[0]).toBeCloseTo(100, 1);
    expect(lab[1]).toBeCloseTo(0, 1);
    expect(lab[2]).toBeCloseTo(0, 1);
  });
});

describe('SSIM', () => {
  const size = 24;
  const pattern = (x: number, y: number): number => ((x * 7 + y * 13) % 17) * 12;
  const gray = (paint: (x: number, y: number) => number): Float32Array => {
    const out = new Float32Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) out[y * size + x] = paint(x, y);
    return out;
  };
  const mean = (map: Float32Array): number =>
    map.reduce((sum, value) => sum + value, 0) / map.length;

  it('同一张图处处为 1', () => {
    const image = gray(pattern);
    const map = ssimMap(image, image, size, size);
    expect(Math.min(...map)).toBeCloseTo(1, 5);
  });

  it('纹理对上平色、反相的图都明显更低', () => {
    const image = gray(pattern);
    const flat = ssimMap(
      image,
      gray(() => 100),
      size,
      size,
    );
    const inverted = ssimMap(
      image,
      gray((x, y) => 255 - pattern(x, y)),
      size,
      size,
    );
    expect(mean(flat)).toBeLessThan(0.2);
    expect(mean(inverted)).toBeLessThan(0);
  });

  it('两张平色图只差亮度时仍接近 1（亮度差由色差指标管）', () => {
    expect(
      mean(
        ssimMap(
          gray(() => 100),
          gray(() => 110),
          size,
          size,
        ),
      ),
    ).toBeGreaterThan(0.99);
  });
});

describe('像素工具', () => {
  it('编码再解码得到同样的像素，解码补上 alpha', async () => {
    const raster: Raster = {
      width: 2,
      height: 1,
      data: Uint8Array.from([1, 2, 3, 255, 200, 100, 50, 128]),
    };
    expect(await decodeRaster(await encodePng(raster))).toEqual(raster);
  });

  it('裁剪与灰度', () => {
    const raster: Raster = {
      width: 3,
      height: 2,
      data: Uint8Array.from(
        Array.from({ length: 6 }, (_, i) => [i * 10, i * 10, i * 10, 255]).flat(),
      ),
    };
    const crop = cropRaster(raster, [1, 0, 3, 2]);
    expect([crop.width, crop.height]).toEqual([2, 2]);
    expect(Array.from(grayscale(crop))).toEqual(
      [10, 20, 40, 50].map((value) => expect.closeTo(value, 3)),
    );
  });

  it('设计像素的矩形按比例换算并裁到图内', () => {
    expect(pixelBox([10, 10, 20, 20], 2, 100, 100)).toEqual([20, 20, 60, 60]);
    expect(pixelBox([-5, -5, 10, 10], 1, 100, 100)).toEqual([0, 0, 5, 5]);
    expect(pixelBox([200, 200, 10, 10], 1, 100, 100)).toBeUndefined();
  });

  it('膨胀与腐蚀按方窗，与半径无关地线性', () => {
    const width = 9;
    const mask = new Uint8Array(width * width);
    mask[4 * width + 4] = 1;
    const grown = dilateMask(mask, width, width, 2);
    expect(grown.reduce((sum, value) => sum + value, 0)).toBe(25);
    expect(grown[2 * width + 2]).toBe(1);
    expect(grown[1 * width + 1]).toBe(0);
    const shrunk = erodeMask(grown, width, width, 2);
    expect(Array.from(shrunk).filter(Boolean)).toHaveLength(1);
    expect(shrunk[4 * width + 4]).toBe(1);
  });
});
