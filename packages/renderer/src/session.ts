import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Canvas,
  createCanvas,
  GlobalFonts,
  type Image,
  ImageData,
  loadImage,
} from '@napi-rs/canvas';
import {
  type AssetManifest,
  ErrorCodes,
  loadScreen,
  type Project,
  type Rect,
  readAssetFile,
  readAssetManifest,
  readFileIfExistsSync,
  resolveInside,
  type ScreenDoc,
  screenRelPath,
  UiProError,
} from '@ui-pro/core';
import { buildDrawList } from './drawlist';
import {
  type Canvas2D,
  type DecodedImage,
  type ExecEnv,
  executeDrawList,
  measureTextWidth,
  type Scratch,
} from './exec';
import { layoutScreen } from './layout';
import type { DrawList, RenderOptions, RenderResult, RenderSession, TextOp } from './types';

/** What the Node session adds to `RenderSession`: the pieces the gates measure with. */
export interface ReferenceSession extends RenderSession {
  /** The screen document, asset manifest and mock data the session was opened with. */
  readonly doc: ScreenDoc;
  readonly manifest: AssetManifest | null;
  readonly mock: unknown;
  /** Width in design pixels of `content` on one line in the op's font. */
  measureText(font: TextOp['font'], content: string): number;
  /**
   * Draws only these nodes' ops on a transparent ground, with `render`'s options: where exactly
   * they put pixels (the hide test's footprints, text ink).
   */
  renderNodes(nodes: readonly string[], options?: RenderOptions): Promise<RenderResult>;
}

const MAX_CACHED_SURFACES = 4;

const registeredFonts = new Set<string>();

/** Registers the project's font files with Skia; returns what could not be loaded. */
function registerFonts(project: Project): string[] {
  const problems: string[] = [];
  for (const [name, file] of Object.entries(project.config.fonts)) {
    let path: string;
    try {
      path = resolveInside(project.root, file);
    } catch {
      problems.push(`字体 ${name} 的文件 ${file} 不在项目目录内，用系统字体兜底`);
      continue;
    }
    if (!existsSync(path)) {
      problems.push(`字体 ${name} 的文件 ${file} 不存在，用系统字体兜底`);
      continue;
    }
    const key = `${path}|${name}`;
    if (registeredFonts.has(key)) continue;
    if (GlobalFonts.registerFromPath(path, name) === null) {
      problems.push(`字体 ${name} 的文件 ${file} 无法加载，用系统字体兜底`);
    } else {
      registeredFonts.add(key);
    }
  }
  return problems;
}

function readMock(project: Project, screen: string): unknown {
  const path = screenRelPath(screen, 'mock');
  const bytes = readFileIfExistsSync(join(project.root, ...path.split('/')));
  if (bytes === null) return {};
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new UiProError(ErrorCodes.docInvalid, `${path} 不是合法的 JSON`, { cause: error });
  }
}

/** A frame is drawn on one canvas per size, reused: frames in a row do not allocate. */
class Surfaces {
  private readonly canvases = new Map<string, Canvas>();

  get(width: number, height: number): Canvas {
    const key = `${width}x${height}`;
    let canvas = this.canvases.get(key);
    if (!canvas) {
      if (this.canvases.size >= MAX_CACHED_SURFACES) {
        const oldest = this.canvases.keys().next().value;
        if (oldest !== undefined) this.canvases.delete(oldest);
      }
      canvas = createCanvas(width, height);
      this.canvases.set(key, canvas);
    }
    return canvas;
  }

  clear(): void {
    this.canvases.clear();
  }
}

/**
 * Lets the event loop run one turn. Skia's pixel buffers are released by finalizers that Node
 * only runs between turns: a loop of `await session.render()` that never leaves the microtask
 * queue frees none of them until it ends (8 MB a frame at 1080 x 1920, measured). One turn per
 * frame keeps the memory flat; it costs well under a millisecond.
 */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function encodePng(width: number, height: number, data: Uint8Array): Uint8Array {
  const canvas = createCanvas(width, height);
  canvas
    .getContext('2d')
    .putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  return canvas.toBuffer('image/png');
}

/**
 * Loads the screen's assets and fonts once, then renders any number of frames with them: the
 * hide test renders one frame per hidden node and decodes nothing again. Reads the screen,
 * manifest and mock data as they are when it opens; open a new session after a build. A screen
 * with no manifest renders (every node that draws an asset is a placeholder), so it can be
 * previewed before the build.
 */
export async function openRenderSession(
  project: Project,
  screen: string,
): Promise<ReferenceSession> {
  const doc = loadScreen(project, screen);
  const manifest = readAssetManifest(project, screen);
  const mock = readMock(project, screen);
  const warnings = registerFonts(project);

  const images = new Map<string, DecodedImage>();
  for (const record of manifest?.assets ?? []) {
    const bytes = readAssetFile(project, screen, record.file);
    if (bytes === null) {
      warnings.push(`资产 ${record.name} 的文件 ${record.file} 不存在`);
      continue;
    }
    try {
      const image = await loadImage(Buffer.from(bytes));
      images.set(record.name, { source: image, width: image.width, height: image.height });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`资产 ${record.name} 的文件 ${record.file} 无法解码：${reason}`);
    }
  }

  const surfaces = new Surfaces();
  const scratch = new Map<string, Scratch>();
  const crops = new WeakMap<DecodedImage, Map<string, DecodedImage>>();
  const env: ExecEnv = {
    image: (asset) => images.get(asset),
    crop(image, x, y, width, height) {
      const kept = crops.get(image) ?? new Map<string, DecodedImage>();
      crops.set(image, kept);
      const key = `${x},${y},${width},${height}`;
      let piece = kept.get(key);
      if (!piece) {
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(image.source as Image, x, y, width, height, 0, 0, width, height);
        piece = { source: canvas, width, height };
        kept.set(key, piece);
      }
      return piece;
    },
    surface(width, height) {
      const key = `${width}x${height}`;
      let found = scratch.get(key);
      if (!found) {
        if (scratch.size >= MAX_CACHED_SURFACES * 2) scratch.clear();
        const canvas = createCanvas(width, height);
        found = { canvas, ctx: canvas.getContext('2d') as unknown as Canvas2D };
        scratch.set(key, found);
      }
      return found;
    },
  };
  const measureCtx = createCanvas(1, 1).getContext('2d') as unknown as Canvas2D;
  let disposed = false;

  async function frame(
    options: RenderOptions,
    only: ReadonlySet<string> | undefined,
  ): Promise<RenderResult> {
    if (disposed) throw new UiProError(ErrorCodes.invariant, '渲染会话已经关闭');
    await yieldToEventLoop();
    if (disposed) throw new UiProError(ErrorCodes.invariant, '渲染会话已经关闭');
    const merged = { ...options, mock: options.mock ?? mock };
    const full = buildDrawList(doc, manifest, project.config.fonts, merged);
    const list: DrawList = {
      ...full,
      ops: only ? full.ops.filter((op) => only.has(op.node)) : full.ops,
      warnings: [...full.warnings, ...warnings],
    };
    const scale = options.scale ?? 1 / doc.scale;
    const width = Math.max(1, Math.round(list.width * scale));
    const height = Math.max(1, Math.round(list.height * scale));

    const canvas = surfaces.get(width, height);
    const ctx = canvas.getContext('2d');
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, width, height);
    if (options.background !== undefined && !only) {
      ctx.fillStyle = options.background;
      ctx.fillRect(0, 0, width, height);
    }
    executeDrawList(ctx as unknown as Canvas2D, list, scale, env);

    const data = new Uint8Array(ctx.getImageData(0, 0, width, height).data);
    let png: Uint8Array | undefined;
    const rects: ReadonlyMap<string, Rect> = layoutScreen(
      doc,
      options.viewport ?? { width: doc.size[0], height: doc.size[1] },
    );
    return {
      // Encoded on first use: a hide test that only reads pixels never pays for the PNG.
      get png() {
        png ??= encodePng(width, height, data);
        return png;
      },
      width,
      height,
      data,
      list,
      rects,
    };
  }

  return {
    doc,
    manifest,
    mock,
    render: (options = {}) => frame(options, undefined),
    renderNodes: (nodes, options = {}) => frame(options, new Set(nodes)),
    measureText: (font, content) => measureTextWidth(measureCtx, font, content),
    dispose() {
      disposed = true;
      images.clear();
      scratch.clear();
      surfaces.clear();
    },
  };
}
