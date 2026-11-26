import { UiProError } from '@ui-pro/core';
import { describe, expect, it, vi } from 'vitest';
import { createPixelOps } from '../../src/pixel';
import { analyticFill, lamaCrop } from '../../src/pixel/fill';
import {
  blank,
  differing,
  fakeRunner,
  fillRect,
  gradient,
  label,
  makeContext,
  maskOfRect,
  meanAbsolute,
  memoryStore,
  pixelAt,
} from './helpers';

const request = (image: ReturnType<typeof blank>, hole: ReturnType<typeof maskOfRect>) => ({
  image,
  hole,
  quality: 'draft' as const,
  style: 'smooth' as const,
  label,
});

describe('fill: analytic', () => {
  it('fills a hole in a linear gradient accurately and leaves the rest alone', async () => {
    const truth = gradient(120, 90, [30, 60, 120], [200, 180, 90]);
    const image = { ...truth, data: new Uint8Array(truth.data) };
    const rect = [40, 30, 30, 24] as const;
    fillRect(image, rect, [255, 0, 255]);
    const hole = maskOfRect(120, 90, rect);

    const runner = fakeRunner();
    const { context } = makeContext();
    const result = await createPixelOps(context, { runner }).fill(request(image, hole));

    expect(result.tier).toBe('analytic');
    expect(result.method).toBe('analytic');
    expect(result.generated).toBeUndefined();
    expect(runner.inpaint).not.toHaveBeenCalled();
    const inside = Uint8Array.from(hole.data, (v) => (v ? 1 : 0));
    expect(meanAbsolute(result.image, truth, inside)).toBeLessThan(1.5);
    // Outside the hole every byte is the input's.
    const outside = Uint8Array.from(hole.data, (v) => (v ? 0 : 1));
    expect(differing(result.image, image, outside)).toBe(0);
  });

  it('fills a hole in a flat colour', () => {
    const image = blank(50, 50, [10, 120, 200]);
    fillRect(image, [20, 20, 10, 10], [0, 0, 0]);
    const hole = Uint8Array.from(maskOfRect(50, 50, [20, 20, 10, 10]).data, (v) => (v ? 1 : 0));
    const filled = analyticFill(image, hole);
    expect(filled && pixelAt(filled, 25, 25)).toEqual([10, 120, 200, 255]);
  });

  it('declines when the surroundings are not a plane', () => {
    const image = blank(60, 40, [20, 20, 20]);
    fillRect(image, [30, 0, 30, 40], [220, 220, 220]);
    const hole = Uint8Array.from(maskOfRect(60, 40, [24, 14, 12, 12]).data, (v) => (v ? 1 : 0));
    expect(analyticFill(image, hole)).toBeNull();
  });
});

describe('fill: local model', () => {
  /** Two flat halves with an edge through the hole: no plane fits, so the model must be used. */
  function edgeScene(width = 200, height = 150) {
    const image = blank(width, height, [30, 40, 60]);
    fillRect(image, [Math.floor(width / 2), 0, Math.ceil(width / 2), height], [230, 210, 120]);
    const rect = [Math.floor(width / 2) - 12, 60, 24, 20] as const;
    fillRect(image, rect, [255, 0, 255]);
    return { image, rect, hole: maskOfRect(width, height, rect) };
  }

  it('asks the model for the hole and pastes it back only inside the hole', async () => {
    const { image, rect, hole } = edgeScene();
    const runner = fakeRunner();
    const { context, store } = makeContext();
    const result = await createPixelOps(context, { runner }).fill(request(image, hole));

    expect(runner.inpaint).toHaveBeenCalledOnce();
    const [view, viewMask] = runner.inpaint.mock.calls[0] as [
      { width: number; height: number },
      { data: Uint8Array },
    ];
    expect([view.width, view.height]).toEqual([512, 512]);
    expect(viewMask.data.some((v) => v === 255)).toBe(true);
    expect(result.tier).toBe('local');
    expect(result.method).toBe('lama');
    expect(result.generated).toMatch(/^[0-9a-f]{64}$/);
    // The fake model paints the mask red; the hole's centre must be red where it lies in the image.
    const [r, g, b] = pixelAt(result.image, rect[0] + rect[2] / 2, rect[1] + rect[3] / 2);
    expect([r, g, b]).toEqual([200, 30, 30]);
    // Outside the hole nothing changed, byte for byte.
    const outside = Uint8Array.from(hole.data, (v) => (v ? 0 : 1));
    expect(differing(result.image, image, outside)).toBe(0);
    // And the output was locked under the key the result reports.
    const locked = store.entries.get(result.generated as string);
    expect(locked?.by).toBe('local:lama');
  });

  it('maps a hole in a non-square, small image to the right place', async () => {
    const { image, rect, hole } = edgeScene(90, 200);
    const result = await createPixelOps(makeContext().context, { runner: fakeRunner() }).fill(
      request(image, hole),
    );
    for (const [x, y] of [
      [rect[0] + 2, rect[1] + 2],
      [rect[0] + rect[2] - 3, rect[1] + rect[3] - 3],
      [rect[0] + rect[2] / 2, rect[1] + rect[3] / 2],
    ] as const) {
      expect(pixelAt(result.image, x, y).slice(0, 3)).toEqual([200, 30, 30]);
    }
    expect(pixelAt(result.image, rect[0] - 4, rect[1] - 4)).toEqual(
      pixelAt(image, rect[0] - 4, rect[1] - 4),
    );
  });

  it('reuses a locked output without running the model again', async () => {
    const { image, hole } = edgeScene();
    const runner = fakeRunner();
    const { context, store } = makeContext();
    const ops = createPixelOps(context, { runner });
    const first = await ops.fill(request(image, hole));
    const second = await ops.fill(request(image, hole));
    expect(runner.inpaint).toHaveBeenCalledOnce();
    expect(store.entries.size).toBe(1);
    expect(second.generated).toBe(first.generated);
    expect(Array.from(second.image.data)).toEqual(Array.from(first.image.data));
  });

  it('refuses to run the model when only locked outputs are allowed (E_NOT_LOCKED)', async () => {
    const { image, hole } = edgeScene();
    const runner = fakeRunner();
    const { context } = makeContext({ store: memoryStore(false) });
    const error = await createPixelOps(context, { runner })
      .fill(request(image, hole))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UiProError);
    expect((error as UiProError).code).toBe('E_NOT_LOCKED');
    expect((error as UiProError).message).toContain('icon');
    expect(runner.inpaint).not.toHaveBeenCalled();
  });

  it('does not need a lock for the analytic tier even when only locked outputs are allowed', async () => {
    const image = blank(60, 60, [90, 90, 90]);
    fillRect(image, [20, 20, 10, 10], [0, 0, 0]);
    const { context } = makeContext({ store: memoryStore(false) });
    const result = await createPixelOps(context, { runner: fakeRunner() }).fill(
      request(image, maskOfRect(60, 60, [20, 20, 10, 10])),
    );
    expect(result.tier).toBe('analytic');
  });

  it('reports the model download before it starts', async () => {
    const { image, hole } = edgeScene();
    const { context, messages } = makeContext({
      models: { path: async () => 'x', has: vi.fn(async () => false) },
    });
    await createPixelOps(context, { runner: fakeRunner() }).fill(request(image, hole));
    expect(messages.join('\n')).toMatch(/LaMa.*下载/);
  });

  it('never calls the cloud for a draft', async () => {
    const { image, hole } = edgeScene();
    const cloud = {
      id: 'fake/model',
      capabilities: {
        maskInput: true,
        transparentOutput: false,
        layerDecomposition: false,
        minSide: 512,
        maxSide: 4096,
        maxCandidates: 4,
      },
      inpaint: vi.fn(),
      removeText: vi.fn(),
      upscale: vi.fn(),
    };
    const { context } = makeContext({ cloud });
    await createPixelOps(context, { runner: fakeRunner() }).fill(request(image, hole));
    expect(cloud.inpaint).not.toHaveBeenCalled();
  });
});

describe('lamaCrop', () => {
  it('is a square of 2.5 times the hole, kept inside the image', () => {
    expect(lamaCrop([100, 100, 40, 20], { width: 1000, height: 1000 })).toEqual([70, 60, 100, 100]);
    const [x, y, w, h] = lamaCrop([0, 0, 40, 40], { width: 1000, height: 1000 });
    expect([x, y]).toEqual([0, 0]);
    expect([w, h]).toEqual([100, 100]);
    expect(lamaCrop([10, 10, 20, 20], { width: 60, height: 300 })).toEqual([0, 0, 52, 52]);
    // A small image is used whole.
    expect(lamaCrop([10, 10, 20, 20], { width: 40, height: 300 })).toEqual([0, 0, 40, 52]);
  });
});
