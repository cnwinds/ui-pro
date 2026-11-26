import type { Rect } from '@ui-pro/core';
import { describe, expect, it, vi } from 'vitest';
import { createPixelOps } from '../../src/pixel';
import { binarize, toMask } from '../../src/pixel/mask';
import { SVG_FONT } from '../helpers';
import { alphaIou, blank, fakeRunner, label, makeContext, overColor, rasterize } from './helpers';

const WIDTH = 160;
const HEIGHT = 120;
const FILL = [232, 176, 48] as const;

const defs = `<defs>
  <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#2f5d8a"/><stop offset="1" stop-color="#9fd0f0"/>
  </linearGradient>
  <filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="0.9"/></filter>
</defs>`;
const roundedRect = `<rect x="40" y="30" width="80" height="60" rx="14" fill="rgb(${FILL.join(',')})" filter="url(#soft)"/>`;
const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${defs}${body}</svg>`;

function ops() {
  const { context } = makeContext();
  return createPixelOps(context, { runner: fakeRunner() });
}

/** Pixels where the truth is partly transparent: the soft edge. */
function edgeRegion(truth: { width: number; height: number; data: Uint8Array }) {
  const region = new Uint8Array(truth.width * truth.height);
  for (let i = 0; i < region.length; i++) {
    const a = truth.data[i * 4 + 3] ?? 0;
    if (a > 40 && a < 215) region[i] = 1;
  }
  return region;
}

describe('extract: a soft rounded rectangle on a gradient', () => {
  const box: Rect = [36, 26, 88, 68];

  it('finds the outline by contour and gets the soft alpha', async () => {
    const source = await rasterize(
      svg(`<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#g)"/>${roundedRect}`),
    );
    const truth = await rasterize(svg(roundedRect));
    const result = await ops().extract({
      image: source,
      box,
      subject: 'ui',
      style: 'smooth',
      label,
    });

    expect(result.method).toBe('contour');
    expect(result.image.width).toBe(WIDTH);
    expect(alphaIou(result.image, truth)).toBeGreaterThanOrEqual(0.95);
    expect(Array.from(result.alpha.data)).toEqual(
      Array.from({ length: WIDTH * HEIGHT }, (_, i) => result.image.data[i * 4 + 3]),
    );
  });

  it('leaves no background colour in the semi-transparent edge', async () => {
    const source = await rasterize(
      svg(`<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#g)"/>${roundedRect}`),
    );
    const truth = await rasterize(svg(roundedRect));
    const result = await ops().extract({
      image: source,
      box,
      subject: 'ui',
      style: 'smooth',
      label,
    });
    const edge = edgeRegion(truth);
    expect(edge.reduce((n, flag) => n + flag, 0)).toBeGreaterThan(40);

    // On a flat dark backdrop the element must look as it does in the truth, edge included.
    for (const backdrop of [[0, 0, 0] as const, [255, 255, 255] as const]) {
      const got = overColor(result.image, backdrop);
      const want = overColor(truth, backdrop);
      let sum = 0;
      let n = 0;
      for (let i = 0; i < edge.length; i++) {
        if (!edge[i]) continue;
        for (let c = 0; c < 3; c++)
          sum += Math.abs((got.data[i * 4 + c] ?? 0) - (want.data[i * 4 + c] ?? 0));
        n += 3;
      }
      expect(sum / n).toBeLessThan(6);
    }
    // The colour of edge pixels is the element's own colour, not a mix with the gradient.
    let colorError = 0;
    let n = 0;
    for (let i = 0; i < edge.length; i++) {
      if (!edge[i]) continue;
      for (let c = 0; c < 3; c++)
        colorError += Math.abs((result.image.data[i * 4 + c] ?? 0) - (FILL[c] as number));
      n += 3;
    }
    expect(colorError / n).toBeLessThan(14);
  });

  it('refines a rough hint instead of searching', async () => {
    const source = await rasterize(
      svg(`<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#g)"/>${roundedRect}`),
    );
    const truth = await rasterize(svg(roundedRect));
    // A hint that is a pixel too big on every side.
    const hint = toMask(
      binarize(
        {
          width: WIDTH,
          height: HEIGHT,
          data: Uint8Array.from({ length: WIDTH * HEIGHT }, (_, i) => truth.data[i * 4 + 3] ?? 0),
        },
        128,
      ),
      WIDTH,
      HEIGHT,
    );
    const result = await ops().extract({
      image: source,
      box,
      hint,
      subject: 'ui',
      style: 'smooth',
      label,
    });
    expect(result.method).toBe('hint');
    expect(alphaIou(result.image, truth)).toBeGreaterThanOrEqual(0.95);
  });

  it('falls back to GrabCut when colour alone cannot find the outline', async () => {
    // A mid-gradient colour on a gradient: no colour distance separates it from its surroundings.
    const lowContrast = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#2f5d8a"/><stop offset="1" stop-color="#d9822b"/>
    </linearGradient></defs>`;
    const shape = `<rect x="40" y="30" width="80" height="60" rx="14" fill="#8a7a5a"/>`;
    const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${lowContrast}`;
    const source = await rasterize(
      `${open}<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#g)"/>${shape}</svg>`,
    );
    const truth = await rasterize(`${open}${shape}</svg>`);
    const result = await ops().extract({
      image: source,
      box,
      subject: 'ui',
      style: 'smooth',
      label,
    });

    expect(result.method).toBe('grabcut');
    expect(result.warnings.join('')).toMatch(/GrabCut/);
    expect(alphaIou(result.image, truth)).toBeGreaterThanOrEqual(0.9);
  });

  it('makes hard edges for pixel art', async () => {
    const source = await rasterize(
      svg(`<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#g)"/>${roundedRect}`),
    );
    const result = await ops().extract({
      image: source,
      box,
      subject: 'ui',
      style: 'pixel',
      label,
    });
    const values = new Set(
      Array.from({ length: WIDTH * HEIGHT }, (_, i) => result.image.data[i * 4 + 3]),
    );
    expect([...values].sort()).toEqual([0, 255]);
  });

  it('does not crash on an empty box and says so', async () => {
    const source = blank(60, 60, [20, 20, 20]);
    const result = await ops().extract({
      image: source,
      box: [20, 20, 20, 20],
      subject: 'ui',
      style: 'smooth',
      label,
    });
    expect(result.warnings.join('')).toMatch(/[\u4e00-\u9fa5]/);
  });
});

describe('extract: bitmap text', () => {
  const textSvg = (extra = '') =>
    `<text x="14" y="72" font-family="${SVG_FONT}" font-size="46" font-weight="bold" fill="#ffd23a" stroke="#6b2b00" stroke-width="4" paint-order="stroke" stroke-linejoin="round"${extra}>Lv59</text>`;

  it('takes the glyph ink, stroke included, as the alpha', async () => {
    const source = await rasterize(
      svg(`<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#g)"/>${textSvg()}`),
    );
    const truth = await rasterize(svg(textSvg()));
    // The box of the truth's visible pixels, as OCR would report it.
    let [minX, minY, maxX, maxY] = [WIDTH, HEIGHT, 0, 0];
    for (let i = 0; i < WIDTH * HEIGHT; i++) {
      if ((truth.data[i * 4 + 3] ?? 0) < 128) continue;
      const x = i % WIDTH;
      const y = Math.floor(i / WIDTH);
      [minX, minY, maxX, maxY] = [
        Math.min(minX, x),
        Math.min(minY, y),
        Math.max(maxX, x),
        Math.max(maxY, y),
      ];
    }
    const box: Rect = [minX + 2, minY + 2, maxX - minX - 3, maxY - minY - 3];
    const result = await ops().extract({
      image: source,
      box,
      subject: 'text',
      style: 'smooth',
      label,
    });
    expect(result.method).toBe('ink');
    expect(alphaIou(result.image, truth)).toBeGreaterThanOrEqual(0.85);
    // The background gradient is not part of the text.
    expect(result.image.data[3]).toBe(0);
    expect(result.image.data[(HEIGHT * WIDTH - 1) * 4 + 3]).toBe(0);
  });
});

describe('extract: figures', () => {
  it('uses the segmentation model and removes background colour from its soft edge', async () => {
    // A red disc on blue; the fake model returns a soft disc mask slightly wider than the disc.
    const size = 120;
    const image = blank(size, size, [40, 60, 200]);
    const mask = { width: size, height: size, data: new Uint8Array(size * size) };
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x - 60, y - 60);
        if (d < 30) image.data.set([220, 40, 40, 255], (y * size + x) * 4);
        mask.data[y * size + x] = Math.round(Math.max(0, Math.min(1, (32 - d) / 4)) * 255);
      }
    }
    const runner = fakeRunner({ segment: vi.fn(async () => mask) });
    const { context } = makeContext();
    const result = await createPixelOps(context, { runner }).extract({
      image,
      box: [28, 28, 64, 64],
      subject: 'figure',
      style: 'smooth',
      label,
    });
    expect(result.method).toBe('anime-seg');
    expect(runner.segment).toHaveBeenCalledOnce();
    expect(result.image.data[(60 * size + 60) * 4 + 3]).toBe(255);
    expect(result.image.data[3]).toBe(0);
    // Pixels at the very edge carry the figure's red, not a blend with the blue behind it.
    const edge = (60 * size + 60 + 31) * 4;
    if ((result.image.data[edge + 3] ?? 0) > 0) {
      expect(result.image.data[edge + 2] ?? 255).toBeLessThan(110);
    }
  });
});
