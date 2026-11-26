import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ApplyOptions,
  type ApplyResult,
  addScreen,
  applyOps,
  createCoreRegistry,
  createProject,
  loadScreen,
  type Project,
  type Registry,
  type ScreenDoc,
  screenRelPath,
  serializeScreen,
  sha256Hex,
  UINodeSchema,
  UiProError,
} from '@ui-pro/core';
import {
  type CloudImageModel,
  type GrayMask,
  PerceptionErrorCodes,
  type PixelContext,
  type PixelOps,
  type RgbaImage,
} from '@ui-pro/perception';
import { registerRules } from '@ui-pro/rules';
import sharp from 'sharp';
import { afterEach } from 'vitest';
import {
  type BuildDeps,
  type BuildOptions,
  type BuildReport,
  buildScreen,
  registerBuild,
} from '../src';
import { decodePng, encodePng } from '../src/raster';

/** Registers cleanup for every directory the returned factory creates under the OS temp dir. */
export function useTempDirs(): () => Promise<string> {
  const created: string[] = [];
  afterEach(async () => {
    await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ui-pro-build-test-'));
    created.push(dir);
    return dir;
  };
}

export type Color = [number, number, number];

/** A tiny drawing surface for synthetic UI sources: filled rectangles and framed boxes. */
export class Canvas {
  readonly data: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    background: Color,
  ) {
    this.data = new Uint8Array(width * height * 4);
    this.rect(0, 0, width, height, background);
  }

  rect(x: number, y: number, w: number, h: number, [r, g, b]: Color): void {
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) {
        this.data.set([r, g, b, 255], (row * this.width + col) * 4);
      }
    }
  }

  /** A box with a border of `border` pixels around a face. */
  frame(
    x: number,
    y: number,
    w: number,
    h: number,
    border: number,
    edge: Color,
    face: Color,
  ): void {
    this.rect(x, y, w, h, edge);
    this.rect(x + border, y + border, w - 2 * border, h - 2 * border, face);
  }

  async png(): Promise<Buffer> {
    return sharp(Buffer.from(this.data), {
      raw: { width: this.width, height: this.height, channels: 4 },
    })
      .png()
      .toBuffer();
  }
}

/** An image whose pixel at (x, y) is `pixel(x, y)`; alpha defaults to opaque. */
export function makeImage(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number] | [number, number, number, number],
): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = pixel(x, y);
      data.set([r, g, b, a], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

/** Colour and alpha of one pixel. */
export function pixelAt(image: RgbaImage, x: number, y: number): number[] {
  const i = (y * image.width + x) * 4;
  return [...image.data.slice(i, i + 4)];
}

export const multiply = ([r, g, b]: Color, factor: number): Color => [
  Math.round(r * factor),
  Math.round(g * factor),
  Math.round(b * factor),
];

export const INK: Color = [26, 26, 26];
export const SCREEN_SIZE: [number, number] = [360, 640];
const BACKGROUND: Color = [36, 74, 122];
const PANEL_EDGE: Color = [122, 74, 28];
const PANEL_FACE: Color = [239, 224, 184];
const STAR: Color = [255, 210, 58];
const BUTTON_EDGE: Color = [29, 90, 38];
const BUTTON_FACE: Color = [58, 160, 74];
const TRACK_EDGE: Color = [14, 18, 32];
const TRACK_FACE: Color = [28, 36, 51];
const BAR_FILL: Color = [95, 208, 95];
const WATERMARK: Color = [255, 255, 255];

/** The pixels of the synthetic screen `main`, 360x640. */
export async function syntheticSource(): Promise<Buffer> {
  const canvas = new Canvas(...SCREEN_SIZE, BACKGROUND);
  canvas.rect(300, 0, 60, 40, WATERMARK);
  canvas.frame(20, 120, 320, 260, 6, PANEL_EDGE, PANEL_FACE);
  canvas.rect(50, 150, 48, 48, STAR);
  for (const x of [112, 128, 144, 160]) canvas.rect(x, 156, 8, 16, INK);
  canvas.frame(140, 400, 80, 36, 3, BUTTON_EDGE, BUTTON_FACE);
  canvas.frame(30, 450, 90, 40, 3, BUTTON_EDGE, BUTTON_FACE);
  canvas.frame(135, 450, 90, 40, 3, BUTTON_EDGE, BUTTON_FACE);
  canvas.frame(240, 450, 90, 40, 3, multiply(BUTTON_EDGE, 0.5), multiply(BUTTON_FACE, 0.5));
  canvas.frame(40, 520, 280, 24, 2, TRACK_EDGE, TRACK_FACE);
  canvas.rect(40, 520, 140, 24, BAR_FILL);
  return canvas.png();
}

export interface NodeDef {
  id: string;
  type: string;
  rect: [number, number, number, number];
  parent?: string;
  varies?: string[];
  cluster?: string;
  states?: Record<string, Record<string, unknown>>;
  text?: { content: string };
}

/** The tree of the synthetic screen, back to front. */
export const SYNTHETIC_NODES: NodeDef[] = [
  { id: 'bg', type: 'image', rect: [0, 0, 360, 640] },
  { id: 'panel', type: 'image', rect: [20, 120, 320, 260], varies: ['size'] },
  { id: 'star', type: 'image', rect: [50, 150, 48, 48], parent: 'panel', varies: ['visibility'] },
  {
    id: 'title',
    type: 'text',
    rect: [110, 152, 200, 24],
    parent: 'panel',
    text: { content: '标题' },
  },
  { id: 'btn_ok', type: 'button', rect: [140, 400, 80, 36], states: { pressed: {}, disabled: {} } },
  { id: 'btn_a', type: 'button', rect: [30, 450, 90, 40], cluster: 'row', states: { pressed: {} } },
  { id: 'btn_b', type: 'button', rect: [135, 450, 90, 40], cluster: 'row' },
  { id: 'btn_c', type: 'button', rect: [240, 450, 90, 40], cluster: 'row' },
  { id: 'bar', type: 'progress', rect: [40, 520, 280, 24], varies: ['content'] },
  { id: 'bar_fill', type: 'image', rect: [40, 520, 140, 24], parent: 'bar', varies: ['size'] },
];

/** Node exceptions that make the synthetic screen's decisions what the tests rely on. */
export const SYNTHETIC_DECISIONS: Array<[string, string, string]> = [
  ['bg', 'decor.merge', 'separate'],
  ['bar', 'content.split', 'separate'],
];

export interface Call {
  step: 'extract' | 'fill' | 'stripText' | 'upscale';
  node: string;
  quality?: string;
}

const hex = (color: readonly number[]): string =>
  `#${color
    .slice(0, 3)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;

function at(image: RgbaImage, x: number, y: number): number {
  return (y * image.width + x) * 4;
}

/**
 * Pixel ops that are fast and deterministic: extraction cuts the box, the fill copies the nearest
 * known pixel of the row (then the column), text stripping paints ink pixels over with their
 * left or right neighbour, upscaling repeats pixels. Everything that would run a model goes
 * through the generation store exactly like the real ops, so locking and reuse can be tested.
 */
export function fakeOps(
  context: PixelContext,
  calls: Call[] = [],
  /** Added to the red channel of every pixel a fill invents: a "different" model output. */
  tweak = 0,
): PixelOps {
  const { store } = context;

  async function locked(
    operation: string,
    key: unknown,
    pixels: Uint8Array,
    compute: () => RgbaImage,
  ): Promise<{ image: RgbaImage; generated: string }> {
    const requestKey = sha256Hex(`${operation}:${JSON.stringify(key)}:${sha256Hex(pixels)}`);
    const hit = await store.get(requestKey);
    if (hit !== undefined) return { image: await decodePng(hit.png), generated: requestKey };
    if (!store.allowNew) {
      throw new UiProError(PerceptionErrorCodes.notLocked, `锁文件里没有 ${operation} 的输出`);
    }
    const image = compute();
    await store.put({ key: requestKey, by: 'local:lama', png: await encodePng(image) });
    return { image, generated: requestKey };
  }

  return {
    async extract(request) {
      calls.push({ step: 'extract', node: request.label.node });
      const { image, box } = request;
      const out: RgbaImage = { ...image, data: new Uint8Array(image.data) };
      const alpha: GrayMask = {
        width: image.width,
        height: image.height,
        data: new Uint8Array(image.width * image.height),
      };
      for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
          const inside = x >= box[0] && y >= box[1] && x < box[0] + box[2] && y < box[1] + box[3];
          alpha.data[y * image.width + x] = inside ? 255 : 0;
          out.data[at(image, x, y) + 3] = inside ? (image.data[at(image, x, y) + 3] ?? 255) : 0;
        }
      }
      return { image: out, alpha, method: 'fake-box', warnings: [] };
    },

    async fill(request) {
      calls.push({ step: 'fill', node: request.label.node, quality: request.quality });
      const { image, hole } = request;
      const { image: result, generated } = await locked(
        'fill',
        { quality: request.quality, prompt: request.prompt },
        concat(image.data, hole.data),
        () => {
          const out: RgbaImage = { ...image, data: new Uint8Array(image.data) };
          const known = (x: number, y: number) =>
            hole.data[y * image.width + x] === 0 && (image.data[at(image, x, y) + 3] ?? 0) > 0;
          for (let y = 0; y < image.height; y++) {
            for (let x = 0; x < image.width; x++) {
              if (hole.data[y * image.width + x] === 0) continue;
              let found = -1;
              for (let d = 1; d < image.width && found < 0; d++) {
                if (x - d >= 0 && known(x - d, y)) found = at(image, x - d, y);
                else if (x + d < image.width && known(x + d, y)) found = at(image, x + d, y);
              }
              for (let d = 1; d < image.height && found < 0; d++) {
                if (y - d >= 0 && known(x, y - d)) found = at(image, x, y - d);
                else if (y + d < image.height && known(x, y + d)) found = at(image, x, y + d);
              }
              if (found >= 0) out.data.set(image.data.slice(found, found + 3), at(image, x, y));
              out.data[at(image, x, y)] = Math.min(255, (out.data[at(image, x, y)] ?? 0) + tweak);
            }
          }
          return out;
        },
      );
      return { image: result, method: 'fake-nearest', generated, tier: 'local', warnings: [] };
    },

    async stripText(request) {
      calls.push({ step: 'stripText', node: request.label.node, quality: request.quality });
      const { image, box } = request;
      const isInk = (x: number, y: number) =>
        INK.every((value, c) => image.data[at(image, x, y) + c] === value);
      const { image: result, generated } = await locked('strip', { box }, image.data, () => {
        const out: RgbaImage = { ...image, data: new Uint8Array(image.data) };
        for (let y = box[1]; y < box[1] + box[3]; y++) {
          for (let x = box[0]; x < box[0] + box[2]; x++) {
            if (!isInk(x, y)) continue;
            let source = -1;
            for (let d = 1; d < image.width && source < 0; d++) {
              if (x - d >= 0 && !isInk(x - d, y)) source = at(image, x - d, y);
              else if (x + d < image.width && !isInk(x + d, y)) source = at(image, x + d, y);
            }
            if (source >= 0) out.data.set(image.data.slice(source, source + 3), at(image, x, y));
          }
        }
        return out;
      });
      return {
        image: result,
        method: 'fake-neighbour',
        generated,
        tier: 'local',
        measured: { color: hex(INK), size: Math.round(box[3] * 0.8) },
        warnings: [],
      };
    },

    async upscale(request) {
      calls.push({ step: 'upscale', node: request.label.node, quality: request.quality });
      const { image, factor } = request;
      const width = Math.round(image.width * factor);
      const height = Math.round(image.height * factor);
      const { image: result, generated } = await locked('upscale', { factor }, image.data, () => {
        const out: RgbaImage = { width, height, data: new Uint8Array(width * height * 4) };
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const sx = Math.min(image.width - 1, Math.floor(x / factor));
            const sy = Math.min(image.height - 1, Math.floor(y / factor));
            out.data.set(
              image.data.slice(at(image, sx, sy), at(image, sx, sy) + 4),
              (y * width + x) * 4,
            );
          }
        }
        return out;
      });
      return {
        image: result,
        method: 'fake-repeat',
        generated,
        tier: 'local',
        fidelity: 1,
        warnings: [],
      };
    },
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export const FIXED_NOW = '2026-01-01T00:00:00.000Z';

/** A cloud image model that is never called: the fake ops do not use it. */
export const FAKE_CLOUD: CloudImageModel = {
  id: 'dashscope/fake',
  capabilities: {
    maskInput: true,
    transparentOutput: false,
    layerDecomposition: false,
    minSide: 64,
    maxSide: 4096,
    maxCandidates: 1,
  },
  inpaint: async () => [],
  removeText: async () => [],
  upscale: async () => new Uint8Array(),
};

export interface BuildFixture {
  project: Project;
  registry: Registry;
  screen: string;
  deps: BuildDeps;
  calls: Call[];
  apply(ops: unknown[], options?: ApplyOptions): Promise<ApplyResult>;
  load(): ScreenDoc;
  /** Rewrites the screen document directly, then lets the rules recompute its decisions. */
  edit(change: (doc: ScreenDoc) => void): Promise<void>;
  /** Rewrites the screen document directly and leaves it as it is. */
  tamper(change: (doc: ScreenDoc) => void): Promise<void>;
  /** From now on fills invent pixels that differ by `tweak` in red. */
  retweak(tweak: number): void;
  run(options?: BuildOptions): Promise<BuildReport>;
}

/** Relative posix path -> sha256 of every file under `root`, for byte-exact comparisons. */
export async function snapshotTree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else result[rel] = sha256Hex(await readFile(join(dir, entry.name)));
    }
  }
  await walk(root, '');
  return result;
}

export function newRegistry(): Registry {
  const registry = createCoreRegistry();
  registerRules(registry);
  registerBuild(registry);
  return registry;
}

export interface FixtureOptions {
  /** Design width; the source is 360 wide, so 720 makes the scale 2. */
  designWidth?: number;
  /** Replaces the synthetic source and its nodes. */
  source?: Buffer;
  nodes?: NodeDef[];
  decisions?: Array<[string, string, string]>;
  exclusions?: Array<[number, number, number, number]>;
  /** False leaves the screen without evidence, as before `ui-pro analyze`. */
  analyzed?: boolean;
  egress?: 'local' | 'cloud';
}

function addNodes(doc: ScreenDoc, nodes: readonly NodeDef[]): void {
  for (const def of nodes) {
    const parent = def.parent ?? doc.root;
    doc.nodes[def.id] = UINodeSchema.parse({
      id: def.id,
      type: def.type,
      parent,
      children: [],
      rect: def.rect.map((value) => value * doc.scale),
      varies: def.varies ?? [],
      cluster: def.cluster,
      states: def.states,
      text: def.text,
    });
    doc.nodes[parent]?.children.push(def.id);
  }
}

/**
 * Project `demo` with the flat screen `main`: a 360x640 synthetic UI (background with a watermark,
 * a panel with a star and a title, buttons, a progress bar), analysed as far as the build needs
 * (empty candidates) and with every decision computed by the default rules.
 */
export async function buildFixture(
  makeDir: () => Promise<string>,
  options: FixtureOptions = {},
): Promise<BuildFixture> {
  const root = await makeDir();
  const designWidth = options.designWidth ?? SCREEN_SIZE[0];
  const project = await createProject(join(root, 'proj'), {
    name: 'demo',
    egress: options.egress,
    design: {
      width: designWidth,
      height: Math.round((designWidth * SCREEN_SIZE[1]) / SCREEN_SIZE[0]),
    },
  });
  const registry = newRegistry();
  const sourcePath = join(root, 'main.png');
  await writeFile(sourcePath, options.source ?? (await syntheticSource()));
  await addScreen(project, { name: 'main', source: sourcePath });

  const calls: Call[] = [];
  let tweak = 0;
  const fixture: BuildFixture = {
    project,
    registry,
    screen: 'main',
    calls,
    deps: {
      createPixelOps: (context) => fakeOps(context, calls, tweak),
      createModelStore: () => ({
        path: async () => {
          throw new Error('测试里不应加载模型');
        },
        has: async () => false,
      }),
      createCloudImageModel: () => null,
      env: {},
      now: () => FIXED_NOW,
      registry,
    },
    apply: (ops, applyOptions = {}) =>
      applyOps(project, ops, { screen: 'main', registry, ...applyOptions }),
    load: () => loadScreen(project, 'main'),
    async tamper(change) {
      const doc = loadScreen(project, 'main');
      change(doc);
      await writeFile(
        join(project.root, ...screenRelPath('main', 'doc').split('/')),
        serializeScreen(doc),
      );
    },
    async edit(change) {
      await fixture.tamper(change);
      await applyOps(project, [{ op: 'rule.recompute' }], {
        screen: 'main',
        registry,
        message: '重算决定',
      });
    },
    retweak(value) {
      tweak = value;
    },
    run: (runOptions = {}) => buildScreen(project, 'main', runOptions, fixture.deps),
  };

  await seedSynthetic(project, registry, options);
  return fixture;
}

/**
 * Puts the synthetic screen's nodes, exclusion and decisions into the screen `main` of `project`,
 * and (unless `analyzed` is false) its empty evidence. Without a `registry` the default one
 * (what the CLI uses) commits the ops.
 */
export async function seedSynthetic(
  project: Project,
  registry: Registry | undefined,
  options: FixtureOptions = {},
): Promise<void> {
  const through = registry === undefined ? {} : { registry };
  const seeded = loadScreen(project, 'main');
  addNodes(seeded, options.nodes ?? SYNTHETIC_NODES);
  await writeFile(
    join(project.root, ...screenRelPath('main', 'doc').split('/')),
    serializeScreen(seeded),
  );
  await applyOps(project, [{ op: 'rule.recompute' }], {
    screen: 'main',
    message: '重算决定',
    ...through,
  });

  const ops: unknown[] = [];
  for (const rect of options.exclusions ?? [[300, 0, 60, 40]]) {
    ops.push({
      op: 'exclusion.add',
      rect: rect.map((value) => value * seeded.scale),
      because: '水印',
    });
  }
  for (const [node, point, value] of options.decisions ?? SYNTHETIC_DECISIONS) {
    ops.push({
      op: 'exception.add',
      target: `#${node}`,
      point,
      value,
      because: '测试需要这个取值',
    });
  }
  await applyOps(project, ops, {
    screen: 'main',
    message: '种下排除区和例外',
    ...through,
    ...(options.analyzed === false
      ? {}
      : {
          evidence: {
            main: {
              candidates: {
                format: 'ui-pro/candidates' as const,
                version: 1 as const,
                sourceSha256: seeded.source.sha256,
                candidates: [],
                clusters: [],
              },
            },
          },
        }),
  });
}

export async function failureOf(promise: Promise<unknown>): Promise<UiProError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UiProError) return error;
    throw error;
  }
  throw new Error('expected the promise to reject with a UiProError');
}
