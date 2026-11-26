import sharp from 'sharp';
import { type Mock, vi } from 'vitest';
import type { ModelRunner } from '../../src/pixel/runner';
import type {
  CloudImageModel,
  EgressLog,
  EgressRecord,
  GenerationStore,
  GrayMask,
  LockedOutput,
  ModelStore,
  PixelContext,
  RgbaImage,
} from '../../src/pixel/types';

export type Color = readonly [number, number, number];

export function blank(width: number, height: number, [r, g, b]: Color = [0, 0, 0]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([r, g, b, 255], i * 4);
  return { width, height, data };
}

/** A horizontal-and-vertical linear gradient: `from` at the top-left, `to` at the bottom-right. */
export function gradient(width: number, height: number, from: Color, to: Color): RgbaImage {
  const image = blank(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = (x / (width - 1) + y / (height - 1)) / 2;
      for (let c = 0; c < 3; c++) {
        image.data[(y * width + x) * 4 + c] = Math.round(
          (from[c] as number) + ((to[c] as number) - (from[c] as number)) * t,
        );
      }
    }
  }
  return image;
}

export function fillRect(
  image: RgbaImage,
  [x, y, w, h]: readonly [number, number, number, number],
  [r, g, b]: Color,
): void {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      image.data.set([r, g, b, 255], (row * image.width + col) * 4);
    }
  }
}

export function maskOfRect(
  width: number,
  height: number,
  [x, y, w, h]: readonly [number, number, number, number],
): GrayMask {
  const mask: GrayMask = { width, height, data: new Uint8Array(width * height) };
  for (let row = y; row < y + h; row++) mask.data.fill(255, row * width + x, row * width + x + w);
  return mask;
}

export function pixelAt(image: RgbaImage, x: number, y: number): [number, number, number, number] {
  const at = (y * image.width + x) * 4;
  return [
    image.data[at] ?? 0,
    image.data[at + 1] ?? 0,
    image.data[at + 2] ?? 0,
    image.data[at + 3] ?? 0,
  ];
}

export async function rasterize(svg: string): Promise<RgbaImage> {
  const { data, info } = await sharp(Buffer.from(svg))
    .ensureAlpha()
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

export async function pngOf(image: RgbaImage): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } })
      .png()
      .toBuffer(),
  );
}

export async function decode(png: Uint8Array): Promise<RgbaImage> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

/** Number of pixels (any channel, any alpha) where two same-size images differ. */
export function differing(a: RgbaImage, b: RgbaImage, region?: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    if (region && !region[i]) continue;
    for (let k = 0; k < 4; k++) {
      if (a.data[i * 4 + k] !== b.data[i * 4 + k]) {
        count++;
        break;
      }
    }
  }
  return count;
}

export function meanAbsolute(a: RgbaImage, b: RgbaImage, region?: Uint8Array): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    if (region && !region[i]) continue;
    for (let k = 0; k < 3; k++)
      sum += Math.abs((a.data[i * 4 + k] ?? 0) - (b.data[i * 4 + k] ?? 0));
    n += 3;
  }
  return n === 0 ? 0 : sum / n;
}

/** Soft intersection over union of two alpha channels given as RGBA images. */
export function alphaIou(a: RgbaImage, b: RgbaImage): number {
  let min = 0;
  let max = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    const x = a.data[i * 4 + 3] ?? 0;
    const y = b.data[i * 4 + 3] ?? 0;
    min += Math.min(x, y);
    max += Math.max(x, y);
  }
  return max === 0 ? 1 : min / max;
}

/** `image` composited over a flat colour, as an opaque image. */
export function overColor(image: RgbaImage, [r, g, b]: Color): RgbaImage {
  const out = blank(image.width, image.height, [r, g, b]);
  for (let i = 0; i < image.width * image.height; i++) {
    const a = (image.data[i * 4 + 3] ?? 0) / 255;
    const back = [r, g, b];
    for (let c = 0; c < 3; c++) {
      out.data[i * 4 + c] = Math.round(
        (image.data[i * 4 + c] ?? 0) * a + (back[c] as number) * (1 - a),
      );
    }
  }
  return out;
}

export function memoryStore(allowNew = true) {
  const entries = new Map<string, LockedOutput>();
  const alternatives = new Map<string, readonly Uint8Array[]>();
  const store: GenerationStore & {
    entries: Map<string, LockedOutput>;
    alternatives: Map<string, readonly Uint8Array[]>;
  } = {
    entries,
    alternatives,
    allowNew,
    get: async (key) => entries.get(key),
    put: async (output, others) => {
      entries.set(output.key, output);
      alternatives.set(output.key, others ?? []);
    },
  };
  return store;
}

export function memoryLog(initial = 0) {
  const records: EgressRecord[] = [];
  const log: EgressLog & { records: EgressRecord[] } = {
    records,
    append: async (record) => {
      records.push(record);
    },
    count: async () => initial + records.length,
  };
  return log;
}

export function fakeModels(): ModelStore {
  return {
    path: async () => {
      throw new Error('测试里不应该加载真实模型');
    },
    has: async () => true,
  };
}

export function makeContext(overrides: Partial<PixelContext> = {}) {
  const store = memoryStore();
  const log = memoryLog();
  const messages: string[] = [];
  const context: PixelContext = {
    store,
    cloud: null,
    egress: 'cloud',
    log,
    budget: 200,
    models: fakeModels(),
    onProgress: (message) => messages.push(message),
    ...overrides,
  };
  return {
    context,
    store: context.store as typeof store,
    log: context.log as typeof log,
    messages,
  };
}

/** Deterministic stand-ins for the models. `inpaint` paints the mask with a flat colour. */
export type SpiedRunner = {
  [K in keyof ModelRunner]: Mock<ModelRunner[K]>;
};

export function fakeRunner(overrides: Partial<ModelRunner> = {}): SpiedRunner {
  const defaults: ModelRunner = {
    async inpaint(image, mask) {
      const out = { ...image, data: new Uint8Array(image.data) };
      for (let i = 0; i < mask.data.length; i++) {
        if ((mask.data[i] ?? 0) >= 128) out.data.set([200, 30, 30, 255], i * 4);
      }
      return out;
    },
    async upscaleTile(tile) {
      const out = blank(tile.width * 4, tile.height * 4);
      for (let y = 0; y < out.height; y++) {
        for (let x = 0; x < out.width; x++) {
          const from = ((y >> 2) * tile.width + (x >> 2)) * 4;
          out.data.set(tile.data.subarray(from, from + 3), (y * out.width + x) * 4);
        }
      }
      return out;
    },
    async segment(image) {
      return {
        width: image.width,
        height: image.height,
        data: new Uint8Array(image.width * image.height),
      };
    },
  };
  return {
    inpaint: vi.fn(overrides.inpaint ?? defaults.inpaint),
    upscaleTile: vi.fn(overrides.upscaleTile ?? defaults.upscaleTile),
    segment: vi.fn(overrides.segment ?? defaults.segment),
  };
}

export function fakeCloud(
  overrides: Partial<CloudImageModel> = {},
  capabilities: Partial<CloudImageModel['capabilities']> = {},
) {
  const model = {
    id: 'fake/model',
    capabilities: {
      maskInput: true,
      transparentOutput: false,
      layerDecomposition: false,
      minSide: 512,
      maxSide: 4096,
      maxCandidates: 4,
      ...capabilities,
    },
    inpaint: vi.fn(async (): Promise<Uint8Array[]> => []),
    removeText: vi.fn(async (): Promise<Uint8Array[]> => []),
    upscale: vi.fn(async (): Promise<Uint8Array> => new Uint8Array()),
    ...overrides,
  };
  return model satisfies CloudImageModel;
}

export const label = { screen: 'main', node: 'icon' };
