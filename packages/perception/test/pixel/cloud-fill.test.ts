import { createHash } from 'node:crypto';
import { UiProError } from '@ui-pro/core';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { createPixelOps } from '../../src/pixel';
import { CLOUD_CANDIDATES, planCrop, TRANSITION_PIXELS } from '../../src/pixel/cloud-fill';
import type { RgbaImage } from '../../src/pixel/types';
import {
  blank,
  decode,
  differing,
  fakeCloud,
  fakeRunner,
  fillRect,
  label,
  makeContext,
  maskOfRect,
  memoryLog,
  memoryStore,
  pixelAt,
  pngOf,
} from './helpers';

const WIDTH = 640;
const HEIGHT = 600;
const EDGE = 320;
const DARK = [30, 40, 60] as const;
const LIGHT = [230, 210, 120] as const;
const RECT: [number, number, number, number] = [EDGE - 30, 200, 60, 40];
const LIMITS = { minSide: 512, maxSide: 4096 };

/** Two flat halves with small dots for texture; the hole straddles the edge, so no plane fits. */
function scene(
  width = WIDTH,
  height = HEIGHT,
  edge = EDGE,
  rect: readonly [number, number, number, number] = RECT,
) {
  const image = blank(width, height, DARK);
  fillRect(image, [edge, 0, width - edge, height], LIGHT);
  for (let y = 5; y < height - 9; y += 16) {
    for (let x = 5; x < width - 9; x += 16) {
      const base = x < edge ? DARK : LIGHT;
      const shift = (((x * 7 + y * 3) % 5) - 2) * 18;
      fillRect(
        image,
        [x, y, 6, 6],
        [
          Math.max(0, Math.min(255, base[0] + shift)),
          Math.max(0, Math.min(255, base[1] + shift)),
          Math.max(0, Math.min(255, base[2] + shift)),
        ],
      );
    }
  }
  fillRect(image, rect, [255, 0, 255]);
  return { image, hole: maskOfRect(width, height, rect) };
}

interface Sent {
  image: RgbaImage;
  hole: Uint8Array;
  imageBytes: Uint8Array;
  maskBytes: Uint8Array;
}

async function receive(args: { image: Uint8Array; mask: Uint8Array }): Promise<Sent> {
  const image = await decode(args.image);
  const mask = await decode(args.mask);
  const hole = Uint8Array.from({ length: image.width * image.height }, (_, i) =>
    (mask.data[i * 4] ?? 0) >= 128 ? 1 : 0,
  );
  return { image, hole, imageBytes: args.image, maskBytes: args.mask };
}

/** A service whose candidates are made by `make` from what it was sent. */
function service(make: (sent: Sent, call: number) => RgbaImage[], capabilities = {}) {
  const received: Sent[] = [];
  const cloud = fakeCloud(
    {
      inpaint: vi.fn(
        async (args: {
          image: Uint8Array;
          mask: Uint8Array;
          prompt: string;
          candidates: number;
        }) => {
          const sent = await receive(args);
          received.push(sent);
          return Promise.all(make(sent, received.length).map(pngOf));
        },
      ),
    },
    capabilities,
  );
  return { cloud, received };
}

function paintHole(
  sent: Sent,
  colorAt: (x: number, y: number) => readonly [number, number, number],
) {
  const out = { ...sent.image, data: new Uint8Array(sent.image.data) };
  for (let i = 0; i < sent.hole.length; i++) {
    if (!sent.hole[i]) continue;
    out.data.set([...colorAt(i % out.width, Math.floor(i / out.width)), 255], i * 4);
  }
  return out;
}

/** The picture moved 5 pixels right and 3 down, which services do (and the hole well filled). */
function shifted(sent: Sent): RgbaImage {
  const out = blank(sent.image.width, sent.image.height);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const from = (Math.max(0, y - 3) * out.width + Math.max(0, x - 5)) * 4;
      out.data.set(sent.image.data.subarray(from, from + 4), (y * out.width + x) * 4);
    }
  }
  return paintHole({ ...sent, image: out }, (x) => truthAt(x));
}

/** What the hole should hold: the two halves continued, in the sent image's coordinates. */
const crop = planCrop(RECT, { width: WIDTH, height: HEIGHT }, LIMITS).crop;
const truthAt = (x: number) => (crop[0] + x < EDGE ? DARK : LIGHT);
const trueFill = (sent: Sent) => paintHole(sent, (x) => truthAt(x));
const redFill = (sent: Sent) => paintHole(sent, () => [220, 30, 30]);

const final = { quality: 'final' as const, style: 'smooth' as const, label };

function inputs() {
  const { image, hole } = scene();
  return { image, hole };
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('planCrop', () => {
  it('sends a square at the source density, centred on the hole', () => {
    const plan = planCrop([300, 280, 60, 40], { width: 2000, height: 1500 }, LIMITS);
    expect(plan.scale).toBe(1);
    expect(plan.crop).toEqual([74, 44, 512, 512]);
    expect(plan.sent).toEqual({ width: 512, height: 512 });
    expect(plan.warnings).toEqual([]);
  });

  it('keeps the crop inside the source', () => {
    const plan = planCrop([0, 0, 20, 20], { width: 2000, height: 1500 }, LIMITS);
    expect(plan.crop).toEqual([0, 0, 512, 512]);
    const corner = planCrop([1990, 1490, 10, 10], { width: 2000, height: 1500 }, LIMITS);
    expect(corner.crop).toEqual([1488, 988, 512, 512]);
  });

  it('takes more context for a larger hole, still at the source density', () => {
    const plan = planCrop([100, 100, 800, 600], { width: 3000, height: 3000 }, LIMITS);
    expect(plan.scale).toBe(1);
    expect(plan.crop[2]).toBeGreaterThan(800);
    expect(plan.crop[3]).toBeGreaterThan(600);
  });

  it('enlarges the crop only when the whole source is under the minimum', () => {
    const plan = planCrop([100, 60, 40, 30], { width: 300, height: 200 }, LIMITS);
    expect(plan.crop).toEqual([0, 0, 300, 200]);
    expect(plan.scale).toBeCloseTo(2.56, 5);
    expect(plan.sent.height).toBe(512);
    expect(plan.sent.width).toBe(768);
    expect(plan.warnings.join('')).toMatch(/Lanczos/);
  });

  it('shrinks a crop beyond the service maximum', () => {
    const plan = planCrop([100, 100, 6000, 300], { width: 8000, height: 8000 }, LIMITS);
    expect(Math.max(plan.sent.width, plan.sent.height)).toBeLessThanOrEqual(4096);
    expect(plan.scale).toBeLessThan(1);
    expect(plan.warnings.join('')).toMatch(/缩小/);
  });
});

describe('cloud fill: the eight constraints', () => {
  it('takes only the mask pixels, with a short transition, and leaves the rest of the picture untouched (1)', async () => {
    const { cloud } = service((sent) => [redFill(sent), redFill(sent)]);
    const { context } = makeContext({ cloud });
    const { image, hole } = inputs();
    const result = await createPixelOps(context, { runner: fakeRunner() }).fill({
      image,
      hole,
      ...final,
    });

    expect(result.tier).toBe('cloud');
    expect(result.method).toBe('fake/model');
    // Outside the hole: every byte of the input.
    const outside = Uint8Array.from(hole.data, (v) => (v ? 0 : 1));
    expect(differing(result.image, image, outside)).toBe(0);
    // Deep inside the hole: the service's pixels.
    expect(pixelAt(result.image, RECT[0] + 30, RECT[1] + 20)).toEqual([220, 30, 30, 255]);
    // Along the hole's edge the service's pixels fade in from the colour just outside it (not
    // from what the hole held, which is magenta here), over TRANSITION_PIXELS pixels.
    const row = RECT[1] + 20;
    const next = pixelAt(image, RECT[0] - 1, row);
    const reds = Array.from(
      { length: TRANSITION_PIXELS },
      (_, d) => pixelAt(result.image, RECT[0] + d, row)[0] ?? 0,
    );
    expect(reds[0]).toBeGreaterThan(next[0] as number);
    expect(reds[0]).toBeLessThan(120);
    for (let d = 1; d < reds.length - 1; d++)
      expect(reds[d]).toBeGreaterThan(reds[d - 1] as number);
    expect(reds[TRANSITION_PIXELS - 1]).toBe(220);
    expect(pixelAt(result.image, RECT[0], row)[2]).toBeLessThan(120);
  });

  it('sends a crop at the source density with a mask of exactly the hole, as RGB PNGs (3)', async () => {
    const { cloud, received } = service((sent) => [trueFill(sent), trueFill(sent)]);
    const { context } = makeContext({ cloud });
    const { image, hole } = inputs();
    await createPixelOps(context, { runner: fakeRunner() }).fill({ image, hole, ...final });

    const [sent] = received;
    expect(sent && [sent.image.width, sent.image.height]).toEqual([512, 512]);
    // The crop's pixels are the source's, not resampled.
    expect(sent && pixelAt(sent.image, 3, 5)).toEqual(pixelAt(image, crop[0] + 3, crop[1] + 5));
    expect(sent && pixelAt(sent.image, 400, 300)).toEqual(
      pixelAt(image, crop[0] + 400, crop[1] + 300),
    );
    // The mask is the hole in the crop's coordinates.
    const holePixels = sent?.hole.reduce((n, v) => n + v, 0);
    expect(holePixels).toBe(RECT[2] * RECT[3]);
    expect(sent?.hole[(RECT[1] - crop[1] + 5) * 512 + (RECT[0] - crop[0] + 5)]).toBe(1);
    expect(sent?.hole[(RECT[1] - crop[1] - 1) * 512 + (RECT[0] - crop[0] + 5)]).toBe(0);
    for (const bytes of [sent?.imageBytes, sent?.maskBytes]) {
      expect((await sharp(bytes).metadata()).channels).toBe(3);
    }
    expect(cloud.inpaint).toHaveBeenCalledWith(
      expect.objectContaining({ candidates: CLOUD_CANDIDATES }),
    );
  });

  it('enlarges a source smaller than the minimum before sending and shrinks the result back (3)', async () => {
    const { image, hole } = scene(300, 200, 150, [135, 80, 30, 30]);
    const { cloud, received } = service((sent) => [redFill(sent), redFill(sent)]);
    const { context } = makeContext({ cloud });
    const result = await createPixelOps(context, { runner: fakeRunner() }).fill({
      image,
      hole,
      ...final,
    });

    const [sent] = received;
    expect(Math.min(sent?.image.width ?? 0, sent?.image.height ?? 0)).toBeGreaterThanOrEqual(512);
    expect([result.image.width, result.image.height]).toEqual([300, 200]);
    expect(result.warnings.join('')).toMatch(/Lanczos/);
    const outside = Uint8Array.from(hole.data, (v) => (v ? 0 : 1));
    expect(differing(result.image, image, outside)).toBe(0);
    const [r, g, b] = pixelAt(result.image, 150, 95);
    expect([r, g, b]).toEqual([220, 30, 30]);
  });

  it('caps the candidates at what the service can return (5)', async () => {
    const { cloud } = service((sent) => [trueFill(sent)], { maxCandidates: 1 });
    const { context } = makeContext({ cloud });
    const { image, hole } = inputs();
    await createPixelOps(context, { runner: fakeRunner() }).fill({ image, hole, ...final });
    expect(cloud.inpaint).toHaveBeenCalledWith(expect.objectContaining({ candidates: 1 }));
  });

  it('rejects a result whose picture was shifted (2) and falls back to the local model', async () => {
    const { cloud } = service((sent) => [shifted(sent), shifted(sent)]);
    const runner = fakeRunner();
    const { context, store } = makeContext({ cloud });
    const { image, hole } = inputs();
    const result = await createPixelOps(context, { runner }).fill({ image, hole, ...final });

    expect(result.tier).toBe('local');
    expect(runner.inpaint).toHaveBeenCalledOnce();
    const text = result.warnings.join('\n');
    expect(text).toMatch(/平移/);
    expect(text).toMatch(/改用本地模型/);
    // The local result stands for the cloud request from now on.
    expect(store.entries.size).toBe(1);
    expect(store.entries.get(result.generated as string)?.by).toBe('local:lama');
  });

  it('rejects a result whose colours around the hole drifted (4)', async () => {
    const { cloud } = service((sent) => {
      const tinted = (): RgbaImage => {
        const out = trueFill(sent);
        for (let y = 0; y < out.height; y++) {
          for (let x = 0; x < out.width; x++) {
            const dx = Math.max(RECT[0] - crop[0] - x, 0, x - (RECT[0] - crop[0] + RECT[2] - 1));
            const dy = Math.max(RECT[1] - crop[1] - y, 0, y - (RECT[1] - crop[1] + RECT[3] - 1));
            if (Math.hypot(dx, dy) > 3 && Math.hypot(dx, dy) <= 18) {
              const at = (y * out.width + x) * 4;
              for (let c = 0; c < 3; c++)
                out.data[at + c] = Math.min(255, (out.data[at + c] ?? 0) + 22);
            }
          }
        }
        return out;
      };
      return [tinted(), tinted()];
    });
    const { context } = makeContext({ cloud });
    const { image, hole } = inputs();
    const result = await createPixelOps(context, { runner: fakeRunner() }).fill({
      image,
      hole,
      ...final,
    });
    expect(result.tier).toBe('local');
    expect(result.warnings.join('\n')).toMatch(/颜色偏了/);
  });

  it('keeps the best of the candidates and the others as alternatives (5)', async () => {
    // The first candidate has a flat red patch, the second continues the picture.
    const { cloud } = service((sent) => [redFill(sent), trueFill(sent)]);
    const { context, store } = makeContext({ cloud });
    const { image, hole } = inputs();
    const result = await createPixelOps(context, { runner: fakeRunner() }).fill({
      image,
      hole,
      ...final,
    });

    expect(result.tier).toBe('cloud');
    expect(pixelAt(result.image, RECT[0] + 15, RECT[1] + 20)).toEqual([...DARK, 255]);
    expect(pixelAt(result.image, RECT[0] + 45, RECT[1] + 20)).toEqual([...LIGHT, 255]);
    const kept = store.alternatives.get(result.generated as string) ?? [];
    expect(kept).toHaveLength(1);
    const other = await decode(kept[0] as Uint8Array);
    expect([other.width, other.height]).toEqual([WIDTH, HEIGHT]);
    expect(pixelAt(other, RECT[0] + 15, RECT[1] + 20)).toEqual([220, 30, 30, 255]);
    expect(store.entries.get(result.generated as string)?.by).toBe('cloud:fake/model');
  });

  it('is not used when every candidate is fine but one is clearly worse (still picks by cost)', async () => {
    const { cloud } = service((sent) => [trueFill(sent), redFill(sent)]);
    const { context, store } = makeContext({ cloud });
    const { image, hole } = inputs();
    const result = await createPixelOps(context, { runner: fakeRunner() }).fill({
      image,
      hole,
      ...final,
    });
    expect(pixelAt(result.image, RECT[0] + 15, RECT[1] + 20)).toEqual([...DARK, 255]);
    expect(store.alternatives.get(result.generated as string)).toHaveLength(1);
  });

  it('stops at the per-screen budget before any service call (7)', async () => {
    const { cloud } = service((sent) => [trueFill(sent)]);
    const { context, log } = makeContext({ cloud, budget: 3, log: memoryLog(3) });
    const { image, hole } = inputs();
    const error = await createPixelOps(context, { runner: fakeRunner() })
      .fill({ image, hole, ...final })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UiProError);
    expect((error as UiProError).code).toBe('E_IMAGE_BUDGET');
    expect((error as UiProError).message).toMatch(/main/);
    expect(cloud.inpaint).not.toHaveBeenCalled();
    expect(log.records).toHaveLength(0);
  });

  it('records what was sent, and how much (8)', async () => {
    const { cloud, received } = service((sent) => [trueFill(sent), trueFill(sent)]);
    const { context, log } = makeContext({ cloud });
    const { image, hole } = inputs();
    await createPixelOps(context, { runner: fakeRunner() }).fill({ image, hole, ...final });

    expect(log.records).toHaveLength(1);
    const [record] = log.records;
    const [sent] = received;
    expect(record).toMatchObject({
      model: 'fake/model',
      purpose: 'inpaint',
      screen: 'main',
      node: 'icon',
    });
    expect(Number.isNaN(Date.parse(record?.at ?? ''))).toBe(false);
    expect(record?.sha256).toEqual([
      sha(sent?.imageBytes as Uint8Array),
      sha(sent?.maskBytes as Uint8Array),
    ]);
    expect(record?.bytes).toBe(
      (sent?.imageBytes.byteLength ?? 0) + (sent?.maskBytes.byteLength ?? 0),
    );
  });

  it('reuses a locked output without calling the service, even when the budget is spent (6)', async () => {
    const { cloud } = service((sent) => [redFill(sent), trueFill(sent)]);
    const { context, log } = makeContext({ cloud, budget: 1 });
    const ops = createPixelOps(context, { runner: fakeRunner() });
    const { image, hole } = inputs();
    const first = await ops.fill({ image, hole, ...final });
    const second = await ops.fill({ image, hole, ...final });
    expect(cloud.inpaint).toHaveBeenCalledOnce();
    expect(log.records).toHaveLength(1);
    expect(second.generated).toBe(first.generated);
    expect(second.tier).toBe('cloud');
    expect(Array.from(second.image.data)).toEqual(Array.from(first.image.data));
  });

  it('does not reuse a locked output for another prompt or another image (6)', async () => {
    const { cloud } = service((sent) => [trueFill(sent)]);
    const { context } = makeContext({ cloud });
    const ops = createPixelOps(context, { runner: fakeRunner() });
    const { image, hole } = inputs();
    await ops.fill({ image, hole, ...final });
    await ops.fill({ image, hole, ...final, prompt: '补成另一种材质' });
    const other = scene(WIDTH, HEIGHT, EDGE + 1);
    await ops.fill({ image: other.image, hole: other.hole, ...final });
    expect(cloud.inpaint).toHaveBeenCalledTimes(3);
  });

  it('refuses a new generation under --locked (E_NOT_LOCKED), and never calls out (6)', async () => {
    const { cloud } = service((sent) => [trueFill(sent)]);
    const { context, log } = makeContext({ cloud, store: memoryStore(false) });
    const { image, hole } = inputs();
    const error = await createPixelOps(context, { runner: fakeRunner() })
      .fill({ image, hole, ...final })
      .catch((e: unknown) => e);
    expect((error as UiProError).code).toBe('E_NOT_LOCKED');
    expect(cloud.inpaint).not.toHaveBeenCalled();
    expect(log.records).toHaveLength(0);
  });

  it('keeps the local fallback reproducible: the second build neither calls the service nor the model', async () => {
    const { cloud } = service((sent) => [shifted(sent)]);
    const runner = fakeRunner();
    const { context } = makeContext({ cloud });
    const ops = createPixelOps(context, { runner });
    const { image, hole } = inputs();
    const first = await ops.fill({ image, hole, ...final });
    const second = await ops.fill({ image, hole, ...final });
    expect(first.tier).toBe('local');
    expect(second.tier).toBe('local');
    expect(cloud.inpaint).toHaveBeenCalledOnce();
    expect(runner.inpaint).toHaveBeenCalledOnce();
    expect(Array.from(second.image.data)).toEqual(Array.from(first.image.data));
  });

  it('turns a service failure into its error instead of a silent fallback', async () => {
    const failure = new UiProError('E_CLOUD_IMAGE', '云端图像模型调用失败');
    const cloud = fakeCloud({ inpaint: vi.fn(async () => Promise.reject(failure)) });
    const { context, store } = makeContext({ cloud });
    const { image, hole } = inputs();
    await expect(
      createPixelOps(context, { runner: fakeRunner() }).fill({ image, hole, ...final }),
    ).rejects.toBe(failure);
    expect(store.entries.size).toBe(0);
  });

  it('copes with candidates that are not images or have another size', async () => {
    const received: Sent[] = [];
    const cloud = fakeCloud({
      inpaint: vi.fn(async (args: { image: Uint8Array; mask: Uint8Array }) => {
        const sent = await receive(args);
        received.push(sent);
        const half = blank(256, 256, [0, 0, 0]);
        return [new Uint8Array([1, 2, 3]), await pngOf(half)];
      }),
    });
    const { context } = makeContext({ cloud });
    const { image, hole } = inputs();
    const result = await createPixelOps(context, { runner: fakeRunner() }).fill({
      image,
      hole,
      ...final,
    });
    expect(result.tier).toBe('local');
    expect(result.warnings.join('\n')).toMatch(/不是可读的图片/);
  });
});

describe('cloud fill: when it is not used', () => {
  it('is skipped for a draft, under egress local, and without a model', async () => {
    const { cloud } = service((sent) => [trueFill(sent)]);
    const { image, hole } = inputs();
    const draft = { image, hole, quality: 'draft' as const, style: 'smooth' as const, label };
    await createPixelOps(makeContext({ cloud }).context, { runner: fakeRunner() }).fill(draft);
    await createPixelOps(makeContext({ cloud, egress: 'local' }).context, {
      runner: fakeRunner(),
    }).fill({
      ...draft,
      quality: 'final',
    });
    const result = await createPixelOps(makeContext({ cloud: null }).context, {
      runner: fakeRunner(),
    }).fill({
      ...draft,
      quality: 'final',
    });
    expect(cloud.inpaint).not.toHaveBeenCalled();
    expect(result.tier).toBe('local');
  });

  it('sends nothing for a hole an arithmetic fill handles', async () => {
    const { cloud } = service((sent) => [trueFill(sent)]);
    const image = blank(600, 600, [90, 90, 90]);
    fillRect(image, [100, 100, 20, 20], [0, 0, 0]);
    const result = await createPixelOps(makeContext({ cloud }).context, {
      runner: fakeRunner(),
    }).fill({
      image,
      hole: maskOfRect(600, 600, [100, 100, 20, 20]),
      ...final,
    });
    expect(result.tier).toBe('analytic');
    expect(cloud.inpaint).not.toHaveBeenCalled();
  });
});
