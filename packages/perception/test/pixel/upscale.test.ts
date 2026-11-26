import { UiProError } from '@ui-pro/core';
import { describe, expect, it, vi } from 'vitest';
import { createPixelOps } from '../../src/pixel';
import { FIDELITY_MIN, upscaleByTiles } from '../../src/pixel/upscale';
import {
  blank,
  decode,
  fakeCloud,
  fakeRunner,
  fillRect,
  gradient,
  label,
  makeContext,
  memoryStore,
  pixelAt,
  pngOf,
} from './helpers';

/** Something with edges and a gradient, so structure is measurable. */
function icon(width: number, height: number) {
  const image = gradient(width, height, [40, 70, 120], [210, 190, 90]);
  fillRect(
    image,
    [Math.floor(width / 4), Math.floor(height / 4), Math.floor(width / 2), 6],
    [250, 250, 250],
  );
  fillRect(
    image,
    [Math.floor(width / 4), Math.floor(height / 2), 8, Math.floor(height / 4)],
    [20, 20, 20],
  );
  fillRect(image, [Math.floor(width * 0.6), Math.floor(height * 0.5), 10, 10], [200, 40, 40]);
  return image;
}

const request = (image: ReturnType<typeof icon>, factor: number, extra = {}) => ({
  image,
  factor,
  quality: 'draft' as const,
  style: 'smooth' as const,
  label,
  ...extra,
});

describe('upscale: resampling', () => {
  it('resamples a factor up to 1.25 without any model', async () => {
    const runner = fakeRunner();
    const { context, store } = makeContext();
    const input = icon(80, 60);
    const result = await createPixelOps(context, { runner }).upscale(request(input, 1.2));
    expect([result.image.width, result.image.height]).toEqual([96, 72]);
    expect(result.tier).toBe('resample');
    expect(result.method).toBe('lanczos');
    expect(result.fidelity).toBeGreaterThan(0.93);
    expect(runner.upscaleTile).not.toHaveBeenCalled();
    expect(store.entries.size).toBe(0);
  });

  it('uses nearest neighbour for pixel art at any factor', async () => {
    const input = blank(4, 4, [10, 10, 10]);
    fillRect(input, [1, 1, 2, 2], [240, 20, 20]);
    const runner = fakeRunner();
    const result = await createPixelOps(makeContext().context, { runner }).upscale(
      request(input, 3, { style: 'pixel' }),
    );
    expect([result.image.width, result.image.height]).toEqual([12, 12]);
    expect(result.method).toBe('nearest');
    expect(result.tier).toBe('resample');
    expect(pixelAt(result.image, 3, 3)).toEqual([240, 20, 20, 255]);
    expect(pixelAt(result.image, 8, 8)).toEqual([240, 20, 20, 255]);
    expect(pixelAt(result.image, 2, 2)).toEqual([10, 10, 10, 255]);
    // No blended colours: every pixel is one of the two.
    const colours = new Set<string>();
    for (let i = 0; i < 144; i++)
      colours.add(Array.from(result.image.data.subarray(i * 4, i * 4 + 3)).join());
    expect(colours.size).toBe(2);
    expect(runner.upscaleTile).not.toHaveBeenCalled();
  });
});

describe('upscale: local model', () => {
  it('enlarges with the model, to the requested size, and locks the result', async () => {
    const runner = fakeRunner();
    const { context, store } = makeContext();
    const input = icon(64, 48);
    const result = await createPixelOps(context, { runner }).upscale(request(input, 2));
    expect([result.image.width, result.image.height]).toEqual([128, 96]);
    expect(runner.upscaleTile).toHaveBeenCalledOnce();
    expect(result.tier).toBe('local');
    expect(result.method).toBe('realesr-animevideov3');
    expect(result.fidelity).toBeGreaterThanOrEqual(FIDELITY_MIN);
    expect(result.generated).toMatch(/^[0-9a-f]{64}$/);
    expect(store.entries.get(result.generated as string)?.by).toBe('local:realesr-animevideov3');
  });

  it('reuses a locked result without running the model', async () => {
    const runner = fakeRunner();
    const { context } = makeContext();
    const ops = createPixelOps(context, { runner });
    const input = icon(64, 48);
    const first = await ops.upscale(request(input, 2));
    const second = await ops.upscale(request(input, 2));
    expect(runner.upscaleTile).toHaveBeenCalledOnce();
    expect(Array.from(second.image.data)).toEqual(Array.from(first.image.data));
    expect(second.generated).toBe(first.generated);
    expect(second.tier).toBe('local');
  });

  it('does not use a locked result for a different image or size', async () => {
    const runner = fakeRunner();
    const ops = createPixelOps(makeContext().context, { runner });
    await ops.upscale(request(icon(64, 48), 2));
    await ops.upscale(request(icon(64, 48), 3));
    await ops.upscale(request(icon(60, 48), 2));
    expect(runner.upscaleTile).toHaveBeenCalledTimes(3);
  });

  it('refuses to run the model when only locked outputs are allowed (E_NOT_LOCKED)', async () => {
    const runner = fakeRunner();
    const { context } = makeContext({ store: memoryStore(false) });
    const ops = createPixelOps(context, { runner });
    const error = await ops.upscale(request(icon(64, 48), 2)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UiProError);
    expect((error as UiProError).code).toBe('E_NOT_LOCKED');
    expect(runner.upscaleTile).not.toHaveBeenCalled();
    // Plain resampling needs no lock.
    await expect(ops.upscale(request(icon(64, 48), 1.1))).resolves.toMatchObject({
      tier: 'resample',
    });
  });

  it('keeps the input transparency and enlarges it separately from the colours', async () => {
    const input = icon(64, 64);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        if (Math.hypot(x - 32, y - 32) > 26) input.data[(y * 64 + x) * 4 + 3] = 0;
      }
    }
    const result = await createPixelOps(makeContext().context, { runner: fakeRunner() }).upscale(
      request(input, 2),
    );
    expect(pixelAt(result.image, 64, 64)[3]).toBe(255);
    expect(pixelAt(result.image, 1, 1)[3]).toBe(0);
    expect(pixelAt(result.image, 126, 126)[3]).toBe(0);
    // A pixel well inside keeps the input's colour.
    const [r, g, b] = pixelAt(result.image, 64, 64);
    const [wr, wg, wb] = pixelAt(input, 32, 32);
    expect(Math.abs(r - wr) + Math.abs(g - wg) + Math.abs(b - wb)).toBeLessThan(40);
  });

  it('falls back to resampling, with a warning, when the model rewrites the picture', async () => {
    const runner = fakeRunner({
      upscaleTile: vi.fn(async (tile) => {
        // A different picture: stripes unrelated to the input.
        const out = blank(tile.width * 4, tile.height * 4);
        for (let y = 0; y < out.height; y++) {
          for (let x = 0; x < out.width; x++) {
            const v = (x >> 2) % 2 === 0 ? 255 : 0;
            out.data.set([v, 255 - v, 128, 255], (y * out.width + x) * 4);
          }
        }
        return out;
      }),
    });
    const { context, store } = makeContext();
    const ops = createPixelOps(context, { runner });
    const input = icon(64, 48);
    const result = await ops.upscale(request(input, 2));
    expect(result.tier).toBe('resample');
    expect(result.method).toBe('lanczos');
    expect(result.warnings.join('')).toMatch(/相似度/);
    expect(result.fidelity).toBeGreaterThan(0.95);
    expect(store.entries.get(result.generated as string)?.by).toBe('local:resample');

    // The outcome is locked: a rebuild does not call the model again and still resamples.
    const again = await ops.upscale(request(input, 2));
    expect(runner.upscaleTile).toHaveBeenCalledOnce();
    expect(again.tier).toBe('resample');
    expect(Array.from(again.image.data)).toEqual(Array.from(result.image.data));
  });

  it('says so and resamples when the image is too large for the local model', async () => {
    const runner = fakeRunner();
    const big = blank(1500, 1400, [60, 60, 60]);
    const result = await createPixelOps(makeContext().context, { runner }).upscale(
      request(big, 1.5),
    );
    expect(runner.upscaleTile).not.toHaveBeenCalled();
    expect(result.tier).toBe('resample');
    expect(result.warnings.join('')).toMatch(/200 万像素/);
  });
});

describe('upscaleByTiles', () => {
  it('covers an image larger than a tile without seams', async () => {
    const runner = fakeRunner();
    const input = gradient(300, 200, [0, 0, 0], [255, 200, 100]);
    const progress = vi.fn();
    const out = await upscaleByTiles(runner, input, progress);
    expect([out.width, out.height]).toEqual([1200, 800]);
    expect(runner.upscaleTile).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenLastCalledWith(2, 2);
    // The fake model enlarges by nearest neighbour, so the blended tiles must equal exactly that.
    let worst = 0;
    for (let y = 0; y < out.height; y += 7) {
      for (let x = 0; x < out.width; x += 5) {
        const want = pixelAt(input, x >> 2, y >> 2);
        const got = pixelAt(out, x, y);
        for (let c = 0; c < 3; c++)
          worst = Math.max(worst, Math.abs((got[c] as number) - (want[c] as number)));
      }
    }
    expect(worst).toBeLessThanOrEqual(1);
  });

  it('tiles with reflected edges when the image is smaller than a tile', async () => {
    const runner = fakeRunner();
    const out = await upscaleByTiles(runner, icon(40, 30));
    expect([out.width, out.height]).toEqual([160, 120]);
    expect(runner.upscaleTile).toHaveBeenCalledOnce();
    const sent = (
      runner.upscaleTile.mock.calls[0] as unknown as [{ width: number; height: number }]
    )[0];
    expect([sent.width, sent.height]).toEqual([256, 256]);
  });
});

describe('upscale: cloud', () => {
  /** A service that enlarges what it is sent by nearest neighbour. */
  function enlargingCloud() {
    const sent: { width: number; height: number }[] = [];
    const cloud = fakeCloud({
      upscale: vi.fn(async ({ image, factor }: { image: Uint8Array; factor: number }) => {
        const source = await decode(image);
        sent.push({ width: source.width, height: source.height });
        const out = blank(source.width * factor, source.height * factor);
        for (let y = 0; y < out.height; y++) {
          for (let x = 0; x < out.width; x++) {
            const from = (Math.floor(y / factor) * source.width + Math.floor(x / factor)) * 4;
            out.data.set(source.data.subarray(from, from + 3), (y * out.width + x) * 4);
          }
        }
        return pngOf(out);
      }),
    });
    return { cloud, sent };
  }

  const final = { quality: 'final' as const };

  it('extends a small image to the service minimum, crops the result back, records the egress and locks', async () => {
    const { cloud, sent } = enlargingCloud();
    const { context, log, store } = makeContext({ cloud });
    const input = icon(100, 80);
    const result = await createPixelOps(context, { runner: fakeRunner() }).upscale(
      request(input, 2, final),
    );
    expect(sent).toEqual([{ width: 512, height: 512 }]);
    expect([result.image.width, result.image.height]).toEqual([200, 160]);
    expect(result.tier).toBe('cloud');
    expect(result.method).toBe('fake/model');
    expect(result.warnings.join('')).toMatch(/镜像外扩/);
    expect(log.records).toHaveLength(1);
    expect(log.records[0]).toMatchObject({
      model: 'fake/model',
      purpose: 'upscale',
      screen: 'main',
      node: 'icon',
    });
    expect(log.records[0]?.sha256).toHaveLength(1);
    expect(store.entries.get(result.generated as string)?.by).toBe('cloud:fake/model');
  });

  it('does not call the service again for a locked result', async () => {
    const { cloud } = enlargingCloud();
    const { context, log } = makeContext({ cloud });
    const ops = createPixelOps(context, { runner: fakeRunner() });
    const input = icon(100, 80);
    await ops.upscale(request(input, 2, final));
    await ops.upscale(request(input, 2, final));
    expect(cloud.upscale).toHaveBeenCalledOnce();
    expect(log.records).toHaveLength(1);
  });

  it('is not used for a draft or when nothing may leave the machine', async () => {
    const { cloud } = enlargingCloud();
    const input = icon(100, 80);
    await createPixelOps(makeContext({ cloud }).context, { runner: fakeRunner() }).upscale(
      request(input, 2),
    );
    await createPixelOps(makeContext({ cloud, egress: 'local' }).context, {
      runner: fakeRunner(),
    }).upscale(request(input, 2, final));
    expect(cloud.upscale).not.toHaveBeenCalled();
  });

  it('stops at the per-screen budget (E_IMAGE_BUDGET)', async () => {
    const { cloud } = enlargingCloud();
    const { context } = makeContext({ cloud, budget: 1 });
    const ops = createPixelOps(context, { runner: fakeRunner() });
    await ops.upscale(request(icon(100, 80), 2, final));
    const error = await ops.upscale(request(icon(90, 80), 2, final)).catch((e: unknown) => e);
    expect((error as UiProError).code).toBe('E_IMAGE_BUDGET');
    expect(cloud.upscale).toHaveBeenCalledOnce();
  });

  it('falls back to the local model when the service rewrites the picture', async () => {
    const cloud = fakeCloud({
      upscale: vi.fn(async ({ image, factor }: { image: Uint8Array; factor: number }) => {
        const source = await decode(image);
        const out = blank(source.width * factor, source.height * factor, [10, 200, 10]);
        return pngOf(out);
      }),
    });
    const runner = fakeRunner();
    const { context, store } = makeContext({ cloud });
    const ops = createPixelOps(context, { runner });
    const input = icon(100, 80);
    const result = await ops.upscale(request(input, 2, final));
    expect(result.tier).toBe('local');
    expect(result.warnings.join('')).toMatch(/云端超分/);
    expect(runner.upscaleTile).toHaveBeenCalledOnce();
    // The local result is locked under the cloud request's key, so a rebuild stays offline.
    const again = await ops.upscale(request(input, 2, final));
    expect(cloud.upscale).toHaveBeenCalledOnce();
    expect(again.generated).toBe(result.generated);
    expect(store.entries.get(result.generated as string)?.by).toBe('local:realesr-animevideov3');
  });

  it('turns a failing service into the service error, not a fallback', async () => {
    const failure = new UiProError('E_CLOUD_IMAGE', '云端图像模型超分失败');
    const cloud = fakeCloud({ upscale: vi.fn(async () => Promise.reject(failure)) });
    const { context } = makeContext({ cloud });
    await expect(
      createPixelOps(context, { runner: fakeRunner() }).upscale(request(icon(100, 80), 2, final)),
    ).rejects.toBe(failure);
  });
});
