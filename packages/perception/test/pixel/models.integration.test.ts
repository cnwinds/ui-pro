import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Rect } from '@ui-pro/core';
import { describe, expect, it } from 'vitest';
import { createCloudImageModel, createModelStore, createPixelOps } from '../../src/pixel';
import { findInk } from '../../src/pixel/extract';
import {
  cropImage,
  decodeBytes,
  encodePng,
  newImage,
  pasteImage,
  resizeImage,
} from '../../src/pixel/raster';
import type { PixelOps, RgbaImage } from '../../src/pixel/types';
import { differing, label, makeContext, maskOfRect, memoryStore } from './helpers';

/**
 * Runs the three real local models on pieces of the candy-knight sample. The models are
 * downloaded on first use (about 386 MB), so this only runs with UI_PRO_MODELS=1:
 *
 *   $env:UI_PRO_MODELS='1'; pnpm vitest run packages/perception/test/pixel/models.integration.test.ts
 *
 * Outputs (before / after pictures and timings) go to .scratch/m1-batch3/ref/pixel/.
 */
const SAMPLE = resolve(__dirname, '../../../../benchmark/samples/candy-knight/ui.png');
const OUT = resolve(__dirname, '../../../../.scratch/m1-batch3/ref/pixel');
const FIVE_MINUTES = 5 * 60 * 1000;

const timings: Record<string, number> = {};
async function timed<T>(name: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await run();
  timings[name] = Math.round(performance.now() - started);
  await mkdir(OUT, { recursive: true });
  await writeFile(
    resolve(OUT, 'timings.json'),
    `${JSON.stringify({ ...(await previousTimings()), ...timings }, null, 2)}\n`,
  );
  return result;
}
async function previousTimings(): Promise<Record<string, number>> {
  try {
    return JSON.parse(await readFile(resolve(OUT, 'timings.json'), 'utf8')) as Record<
      string,
      number
    >;
  } catch {
    return {};
  }
}

async function save(name: string, image: RgbaImage) {
  await mkdir(OUT, { recursive: true });
  await writeFile(resolve(OUT, name), await encodePng(image));
}

/** Pictures side by side on a light grid, each enlarged `scale` times with hard pixels. */
async function sideBySide(images: RgbaImage[], scale: number): Promise<RgbaImage> {
  const enlarged = await Promise.all(
    images.map((image) => resizeImage(image, image.width * scale, image.height * scale, 'nearest')),
  );
  const gap = 8;
  const width = enlarged.reduce((sum, image) => sum + image.width, 0) + gap * (enlarged.length + 1);
  const height = Math.max(...enlarged.map((image) => image.height)) + 2 * gap;
  const board = newImage(width, height);
  for (let i = 0; i < width * height; i++) board.data.set([236, 236, 236, 255], i * 4);
  let x = gap;
  for (const image of enlarged) {
    pasteImage(board, image, x, gap);
    x += image.width + gap;
  }
  return board;
}

/** A picture over magenta, to see what is transparent. */
function overMagenta(image: RgbaImage): RgbaImage {
  const out = newImage(image.width, image.height);
  for (let i = 0; i < image.width * image.height; i++) {
    const a = (image.data[i * 4 + 3] ?? 0) / 255;
    const back = [255, 0, 255];
    for (let c = 0; c < 3; c++) {
      out.data[i * 4 + c] = Math.round(
        (image.data[i * 4 + c] ?? 0) * a + (back[c] as number) * (1 - a),
      );
    }
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

async function setup() {
  const messages: string[] = [];
  const models = createModelStore({
    onProgress: (message) => {
      messages.push(message);
      console.log(message);
    },
  });
  const { context } = makeContext({
    models,
    store: memoryStore(),
    budget: 0,
    onProgress: (message) => {
      messages.push(message);
      console.log(message);
    },
  });
  const ops: PixelOps = createPixelOps(context);
  const sample = await decodeBytes(await readFile(SAMPLE));
  return { ops, sample, messages };
}

const meanColor = (image: RgbaImage, rect: Rect) => {
  const part = cropImage(image, rect);
  const sum = [0, 0, 0];
  for (let i = 0; i < part.width * part.height; i++) {
    for (let c = 0; c < 3; c++) sum[c] = (sum[c] as number) + (part.data[i * 4 + c] ?? 0);
  }
  return sum.map((value) => value / (part.width * part.height));
};

describe.skipIf(!process.env.UI_PRO_MODELS)('local models on the candy-knight sample', () => {
  it(
    'LaMa removes a "+5" badge from an equipment frame (strip text)',
    async () => {
      const { ops, sample } = await setup();
      // The helmet frame at the top right, with the "+5" at the bottom corner.
      const crop: Rect = [320, 95, 100, 100];
      const image = cropImage(sample, crop);
      const box: Rect = [382 - crop[0] - 1, 163 - crop[1] - 1, 20, 12];

      const result = await timed(
        'stripText +5 (first call in the process: LaMa session creation + run)',
        () => ops.stripText({ image, box, quality: 'draft', style: 'smooth', label }),
      );

      await save('lama-strip-plus5.png', await sideBySide([image, result.image], 4));
      await save('lama-strip-plus5-after.png', result.image);
      await writeFile(
        resolve(OUT, 'lama-strip-plus5-measured.json'),
        `${JSON.stringify({ tier: result.tier, method: result.method, measured: result.measured, warnings: result.warnings }, null, 2)}\n`,
      );
      expect(['analytic', 'local']).toContain(result.tier);
      expect(result.measured.color).toMatch(/^#[0-9a-f]{6}$/);
      // The white digits are gone and the orange badge behind them is still there: the box now
      // looks like the badge pixels that were not glyphs.
      const { ink } = findInk(image, box);
      const badge = [0, 0, 0];
      let badgePixels = 0;
      for (let y = box[1]; y < box[1] + box[3]; y++) {
        for (let x = box[0]; x < box[0] + box[2]; x++) {
          if (ink[y * image.width + x]) continue;
          badgePixels++;
          for (let c = 0; c < 3; c++)
            badge[c] = (badge[c] as number) + (image.data[(y * image.width + x) * 4 + c] ?? 0);
        }
      }
      const inside = meanColor(result.image, [box[0] + 2, box[1] + 2, box[2] - 4, box[3] - 4]);
      for (let c = 0; c < 3; c++) {
        expect(Math.abs((inside[c] as number) - (badge[c] as number) / badgePixels)).toBeLessThan(
          45,
        );
      }
      // The glyphs were white: nothing that bright is left inside the box.
      const brightest = Math.max(
        ...Array.from({ length: (box[2] - 4) * (box[3] - 4) }, (_, i) => {
          const x = box[0] + 2 + (i % (box[2] - 4));
          const y = box[1] + 2 + Math.floor(i / (box[2] - 4));
          return Math.min(
            ...[0, 1, 2].map((c) => result.image.data[(y * image.width + x) * 4 + c] ?? 0),
          );
        }),
      );
      expect(brightest).toBeLessThan(200);
      // Far from the badge nothing moved.
      expect(
        differing(cropImage(result.image, [0, 0, 40, 40]), cropImage(image, [0, 0, 40, 40])),
      ).toBe(0);
    },
    FIVE_MINUTES,
  );

  it(
    'LaMa fills a hole that crosses a frame edge, and only inside the hole',
    async () => {
      const { ops, sample } = await setup();
      const crop: Rect = [10, 95, 110, 100];
      const image = cropImage(sample, crop);
      const hole = maskOfRect(image.width, image.height, [78, 55, 22, 26]);

      const first = await timed('fill 22x26 hole (LaMa session already created: run only)', () =>
        ops.fill({ image, hole, quality: 'draft', style: 'smooth', label }),
      );
      const second = await timed('fill 22x26 hole (LaMa run only, another hole)', () =>
        ops.fill({
          image,
          hole: maskOfRect(image.width, image.height, [10, 50, 22, 26]),
          quality: 'draft',
          style: 'smooth',
          label,
        }),
      );

      await save('lama-fill-edge.png', await sideBySide([image, first.image, second.image], 4));
      expect(first.tier).toBe('local');
      expect(first.method).toBe('lama');
      expect(second.tier).toBe('local');
      const outside = Uint8Array.from(hole.data, (v) => (v ? 0 : 1));
      expect(differing(first.image, image, outside)).toBe(0);
      expect(differing(first.image, image)).toBeGreaterThan(0);
    },
    FIVE_MINUTES,
  );

  it(
    'Real-ESRGAN enlarges an icon and a larger piece (tiles) without rewriting them',
    async () => {
      const { ops, sample } = await setup();
      const icon = cropImage(sample, [28, 108, 64, 64]);
      const small = await timed('upscale 64x64 icon x3 (first call: session + 1 tile)', () =>
        ops.upscale({ image: icon, factor: 3, quality: 'draft', style: 'smooth', label }),
      );
      expect([small.image.width, small.image.height]).toEqual([192, 192]);
      expect(small.tier).toBe('local');
      expect(small.fidelity).toBeGreaterThanOrEqual(0.9);
      const lanczos = await resizeImage(icon, 192, 192, 'lanczos3');
      await save('esrgan-icon.png', await sideBySide([lanczos, small.image], 2));
      await save('esrgan-icon-after.png', small.image);

      const piece = cropImage(sample, [100, 80, 200, 290]);
      const big = await timed('upscale 200x290 piece x2 (2 tiles)', () =>
        ops.upscale({ image: piece, factor: 2, quality: 'draft', style: 'smooth', label }),
      );
      expect([big.image.width, big.image.height]).toEqual([400, 580]);
      expect(big.tier).toBe('local');
      await save('esrgan-piece-after.png', big.image);
      await save('esrgan-piece-lanczos.png', await resizeImage(piece, 400, 580, 'lanczos3'));
    },
    FIVE_MINUTES,
  );

  it(
    'anime-seg cuts the character out of the sample',
    async () => {
      const { ops, sample } = await setup();
      const crop: Rect = [90, 85, 200, 235];
      const image = cropImage(sample, crop);
      const result = await timed('extract figure 200x235 (first call: session + run)', () =>
        ops.extract({ image, box: [15, 10, 170, 215], subject: 'figure', style: 'smooth', label }),
      );

      await save('animeseg-figure.png', result.image);
      await save(
        'animeseg-figure-over-magenta.png',
        await sideBySide([image, overMagenta(result.image)], 2),
      );
      expect(result.method).toBe('anime-seg');
      let opaque = 0;
      for (let i = 0; i < result.alpha.data.length; i++)
        if ((result.alpha.data[i] ?? 0) >= 128) opaque++;
      const share = opaque / result.alpha.data.length;
      expect(share).toBeGreaterThan(0.15);
      expect(share).toBeLessThan(0.7);
      // The face is part of the character; the sky in the corners is not.
      expect(result.alpha.data[75 * image.width + 100]).toBeGreaterThanOrEqual(250);
      expect(result.alpha.data[2 * image.width + 2]).toBe(0);
      expect(result.alpha.data[2 * image.width + (image.width - 3)]).toBe(0);
    },
    FIVE_MINUTES,
  );
});

describe.skipIf(process.env.UI_PRO_CLOUD !== '1' || !process.env.DASHSCOPE_API_KEY)(
  'the real DashScope image model (UI_PRO_CLOUD=1)',
  () => {
    it(
      'repaints the "+5" badge area through the whole pipeline, with an egress record',
      async () => {
        const cloud = createCloudImageModel({ provider: 'dashscope' });
        expect(cloud).not.toBeNull();
        const sample = await decodeBytes(await readFile(SAMPLE));
        const { context, log, store } = makeContext({
          cloud,
          store: memoryStore(),
          models: createModelStore(),
          budget: 5,
        });
        const ops = createPixelOps(context);
        const image = cropImage(sample, [320, 95, 100, 100]);
        const result = await ops.stripText({
          image,
          box: [61, 67, 20, 12],
          quality: 'final',
          style: 'smooth',
          label,
        });
        await save('dashscope-strip-plus5.png', await sideBySide([image, result.image], 4));
        expect(['cloud', 'local', 'analytic']).toContain(result.tier);
        expect(log.records.length).toBeLessThanOrEqual(1);
        if (result.tier === 'cloud') {
          expect(log.records[0]?.model).toBe('dashscope/wanx2.1-imageedit');
          expect(store.entries.size).toBe(1);
        }
      },
      FIVE_MINUTES,
    );
  },
);
