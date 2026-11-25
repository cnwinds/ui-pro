import { createRequire } from 'node:module';
import type { CV } from '@techstark/opencv-js';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

/**
 * The package is a CommonJS module whose export is a promise that resolves to the ready
 * runtime. Loading it with `require` works the same under Node, tsx and vitest, whereas a
 * default `import` is mis-handled by vitest's interop (it treats the namespace as a thenable).
 */
async function loadOpenCv(): Promise<CV> {
  const exported: unknown = require('@techstark/opencv-js');
  return (await exported) as CV;
}

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
    const cv = await loadOpenCv();

    expect(typeof cv.inpaint).toBe('function');
    expect(typeof cv.connectedComponentsWithStats).toBe('function');
    expect(typeof cv.findContours).toBe('function');
    expect(typeof cv.Canny).toBe('function');

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
