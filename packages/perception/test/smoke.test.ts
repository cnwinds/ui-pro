import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { loadOpenCv } from '../src/opencv';

describe('perception dependencies', () => {
  it('sharp resizes a 2x2 PNG', async () => {
    const png = await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    })
      .png()
      .toBuffer();

    const { info } = await sharp(png)
      .resize(8, 8, { kernel: 'nearest' })
      .toBuffer({ resolveWithObject: true });

    expect([info.width, info.height]).toEqual([8, 8]);
  });

  it('opencv-js initializes in Node and exposes the functions the kernel needs', async () => {
    const { cv } = await loadOpenCv();

    expect(typeof cv.inpaint).toBe('function');
    expect(typeof cv.connectedComponentsWithStats).toBe('function');
    expect(typeof cv.findContours).toBe('function');
    expect(typeof cv.Canny).toBe('function');
    expect(typeof cv.matchTemplate).toBe('function');

    const source = cv.Mat.zeros(8, 8, cv.CV_8UC1);
    const edges = new cv.Mat();
    try {
      cv.Canny(source, edges, 50, 150);
      expect([edges.rows, edges.cols]).toEqual([8, 8]);
    } finally {
      source.delete();
      edges.delete();
    }
  });
});
