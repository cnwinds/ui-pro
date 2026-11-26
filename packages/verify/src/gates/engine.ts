import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  exportProjectScreen,
  findGodotExecutable,
  GODOT_ENV,
  locateGodot,
  MIN_VERSION,
  takeShot,
  toResPath,
} from '@ui-pro/adapter-godot';
import { isUiProError, loadScreen, type Project, scratchPath, toPosix } from '@ui-pro/core';
import type { RenderSession, TextOp } from '@ui-pro/renderer';
import { composeSheet } from '@ui-pro/renderer';
import { deltaERgb } from '../color';
import { FRAME_BACKGROUND } from '../context';
import { errorMaps, maskedMean } from '../metrics';
import {
  boxArea,
  decodeRaster,
  fillMask,
  intersectBox,
  type PixelBox,
  pixelBox,
  type Raster,
} from '../raster';
import { GATE_NAMES, type GateProblem, type GateResult } from '../types';
import { heatRaster } from '../views';
import { round } from './types';

/**
 * Outside dynamic text: mean structural similarity of the grey images. A correct export lands
 * near 0.99; 0.95 is where a misplaced texture or a wrong anchor starts to show up over a whole
 * screen of a few hundred pixels.
 */
export const ENGINE_SSIM_MIN = 0.95;

/**
 * Outside dynamic text: mean CIEDE2000. Godot's linear filter and SubViewport sampling leave a
 * little more noise than the Canvas renderer, so this is looser than the fidelity gate's 2.
 */
export const ENGINE_DELTA_E_MAX = 4;

/** Dynamic text is excluded from the global measure with this much room round its box. */
export const ENGINE_TEXT_MARGIN = 2;

/** A pixel is ink when it differs from the magenta clear colour by this much. */
export const ENGINE_INK_DELTA_E = 15;

/** Fewer ink pixels than this: the box holds no text (or the font failed to draw). */
export const ENGINE_INK_MIN_PIXELS = 6;

/**
 * Text ink: intersection over union of the reference ink's bounding box and the engine's.
 * Skia's and Godot's fonts rarely overlap better than 0.7 and rarely worse than 0.5.
 */
export const ENGINE_INK_IOU_MIN = 0.5;

/** Text ink: ΔE2000 between the dominant colours. */
export const ENGINE_COLOR_DELTA_E_MAX = 20;

const SHOT_TIMEOUT_MS = 60_000;

interface Ink {
  box: PixelBox;
  count: number;
  color: [number, number, number];
}

const rgbAt = (data: Uint8Array, at: number): [number, number, number] => [
  data[at * 4] ?? 0,
  data[at * 4 + 1] ?? 0,
  data[at * 4 + 2] ?? 0,
];

function dominantColor(pixels: readonly [number, number, number][]): [number, number, number] {
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (const [r, g, b] of pixels) {
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bin.n++;
    bin.r += r;
    bin.g += g;
    bin.b += b;
    bins.set(key, bin);
  }
  let best = { n: 0, r: 0, g: 0, b: 0 };
  for (const bin of bins.values()) if (bin.n > best.n) best = bin;
  return best.n === 0
    ? [0, 0, 0]
    : [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)];
}

function inkOf(
  box: PixelBox,
  width: number,
  isInk: (at: number) => boolean,
  colorAt: (at: number) => [number, number, number],
): Ink | undefined {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = -1;
  let y1 = -1;
  const colors: [number, number, number][] = [];
  for (let y = box[1]; y < box[3]; y++) {
    for (let x = box[0]; x < box[2]; x++) {
      const at = y * width + x;
      if (!isInk(at)) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
      colors.push(colorAt(at));
    }
  }
  if (colors.length === 0) return undefined;
  return { box: [x0, y0, x1 + 1, y1 + 1], count: colors.length, color: dominantColor(colors) };
}

function iou(a: PixelBox, b: PixelBox): number {
  const overlap = intersectBox(a, b);
  const shared = overlap ? boxArea(overlap) : 0;
  return shared / (boxArea(a) + boxArea(b) - shared);
}

function textReach(op: TextOp): number {
  const stroke = op.stroke?.width ?? 0;
  const shadow = op.shadow
    ? Math.max(Math.abs(op.shadow.offset[0]), Math.abs(op.shadow.offset[1])) + (op.shadow.blur ?? 0)
    : 0;
  return ENGINE_TEXT_MARGIN + Math.max(stroke, shadow);
}

function textArea(op: TextOp, width: number, height: number): PixelBox | undefined {
  const reach = textReach(op);
  const [x, y, w, h] = op.box;
  return pixelBox([x - reach, y - reach, w + 2 * reach, h + 2 * reach], 1, width, height);
}

function godotHint(): string {
  return `安装 Godot ${MIN_VERSION.major}.${MIN_VERSION.minor} 及以上，设置环境变量 ${GODOT_ENV} 指向控制台版可执行文件，或把 godot 加入 PATH`;
}

/**
 * 引擎一致 (DESIGN §13.1): exports the screen to a scratch Godot project, screenshots it with
 * rendering on, and compares the shot with the reference renderer's frame at the same size.
 * Skipped, not failed, when Godot is not installed.
 */
export async function runEngineGate(
  project: Project,
  screen: string,
  render: RenderSession,
): Promise<GateResult> {
  if (findGodotExecutable() === undefined) {
    return {
      id: 'engine',
      name: GATE_NAMES.engine,
      status: 'skipped',
      reason: `本机没有 Godot：${godotHint()}`,
      metrics: {},
      problems: [],
      warnings: [],
      views: [],
    };
  }

  const doc = loadScreen(project, screen);
  const [width, height] = doc.size;
  const engineDir = scratchPath(project.root, 'engine', screen);
  const shotFile = join(engineDir, 'shot.png');
  const viewDir = scratchPath(project.root, 'verify', screen);
  const problems: GateProblem[] = [];
  const warnings: string[] = [];
  const views: string[] = [];

  try {
    const install = await locateGodot();
    await rm(engineDir, { recursive: true, force: true });
    await mkdir(engineDir, { recursive: true });

    const exported = await exportProjectScreen(project, screen, {
      target: engineDir,
      freshScene: true,
      godot: install,
    });
    await takeShot({
      install,
      project: engineDir,
      scene: toResPath(exported.report.scene),
      out: shotFile,
      width,
      height,
      clearColor: FRAME_BACKGROUND,
      timeoutMs: SHOT_TIMEOUT_MS,
    });

    const reference = await render.render({ scale: 1, background: FRAME_BACKGROUND });
    const engine = await decodeRaster(await readFile(shotFile));
    if (engine.width !== width || engine.height !== height) {
      return {
        id: 'engine',
        name: GATE_NAMES.engine,
        status: 'fail',
        metrics: {},
        problems: [
          {
            message: `引擎截图尺寸是 ${engine.width}×${engine.height}，期望 ${width}×${height}`,
            fix: '检查 Godot 工程的窗口尺寸和 shot.gd 是否按设计尺寸截图',
          },
        ],
        warnings: [],
        views: [],
      };
    }

    const referenceRaster: Raster = { width, height, data: reference.data };
    const textOps = reference.list.ops.filter((op): op is TextOp => op.kind === 'text');
    const counted = new Uint8Array(width * height).fill(1);
    for (const op of textOps) {
      const box = textArea(op, width, height);
      if (box) fillMask(counted, width, box, 0);
    }

    const maps = errorMaps(referenceRaster, engine);
    const whole: PixelBox = [0, 0, width, height];
    const global = {
      ssim: maskedMean(maps.ssim, width, whole, counted),
      deltaE: maskedMean(maps.deltaE, width, whole, counted),
    };

    const shownDelta = maps.deltaE.map((value, at) => (counted[at] ? value : 0));
    const heat = heatRaster(referenceRaster, shownDelta);
    const sheet = composeSheet([
      { label: '参考渲染', image: referenceRaster },
      { label: '引擎截图', image: engine },
      { label: '色差热力图', image: heat },
    ]);
    await mkdir(viewDir, { recursive: true });
    const viewPath = join(viewDir, 'engine.png');
    await writeFile(viewPath, sheet.png);
    views.push(toPosix(viewPath));

    const metrics: Record<string, number> = {
      ssim: round(global.ssim.mean),
      deltaE: round(global.deltaE.mean, 2),
    };

    const globalReasons: string[] = [];
    if (global.ssim.mean < ENGINE_SSIM_MIN) {
      globalReasons.push(`结构相似度 ${round(global.ssim.mean)}，低于 ${ENGINE_SSIM_MIN}`);
    }
    if (global.deltaE.mean > ENGINE_DELTA_E_MAX) {
      globalReasons.push(`平均色差 ${round(global.deltaE.mean, 2)}，高于 ${ENGINE_DELTA_E_MAX}`);
    }
    if (globalReasons.length > 0) {
      problems.push({
        message: `引擎画面与参考渲染不一致（${globalReasons.join('；')}）`,
        fix: '看三联对比图里红色的地方：锚点、贴图、inset 或九宫是否导出错了',
        metrics: { ssim: round(global.ssim.mean), deltaE: round(global.deltaE.mean, 2) },
        view: toPosix(viewPath),
      });
    }

    const clear: [number, number, number] = [255, 0, 255];
    let textChecked = 0;
    for (const op of textOps) {
      const box = textArea(op, width, height);
      if (!box) continue;
      const wanted = inkOf(
        box,
        width,
        (at) => deltaERgb(...rgbAt(reference.data, at), ...clear) > ENGINE_INK_DELTA_E,
        (at) => rgbAt(reference.data, at),
      );
      const drawn = inkOf(
        box,
        width,
        (at) => deltaERgb(...rgbAt(engine.data, at), ...clear) > ENGINE_INK_DELTA_E,
        (at) => rgbAt(engine.data, at),
      );
      if (!wanted || wanted.count < ENGINE_INK_MIN_PIXELS) {
        warnings.push(`节点 #${op.node} 的文字在参考渲染里几乎看不见，跳过墨迹比对`);
        continue;
      }
      textChecked++;
      if (!drawn || drawn.count < ENGINE_INK_MIN_PIXELS) {
        problems.push({
          node: op.node,
          message: `节点 #${op.node} 在引擎里几乎没有画出文字`,
          fix: '检查字体是否复制进了 Godot 工程，Label 的字号和颜色是否对',
          view: toPosix(viewPath),
        });
        continue;
      }
      const overlap = iou(wanted.box, drawn.box);
      const colorGap = deltaERgb(...wanted.color, ...drawn.color);
      metrics[`text.${op.node}.iou`] = round(overlap, 2);
      metrics[`text.${op.node}.deltaE`] = round(colorGap, 1);
      const reasons: string[] = [];
      if (overlap < ENGINE_INK_IOU_MIN) {
        reasons.push(`墨迹外接框交并比 ${round(overlap, 2)}，低于 ${ENGINE_INK_IOU_MIN}`);
      }
      if (colorGap > ENGINE_COLOR_DELTA_E_MAX) {
        reasons.push(`主体颜色色差 ${round(colorGap, 1)}，高于 ${ENGINE_COLOR_DELTA_E_MAX}`);
      }
      if (reasons.length > 0) {
        problems.push({
          node: op.node,
          message: `节点 #${op.node} 的文字与参考渲染差太多（${reasons.join('；')}）`,
          fix: '核对字号、颜色、对齐；字体光栅化的细微差别不算失败',
          metrics: { iou: round(overlap, 2), deltaE: round(colorGap, 1) },
          view: toPosix(viewPath),
        });
      }
    }
    metrics.textChecked = textChecked;

    return {
      id: 'engine',
      name: GATE_NAMES.engine,
      status: problems.length > 0 ? 'fail' : 'pass',
      metrics,
      problems,
      warnings,
      views,
    };
  } catch (error) {
    if (isUiProError(error) && error.code.startsWith('E_GODOT_')) {
      const lines =
        typeof error.details === 'object' &&
        error.details !== null &&
        'output' in error.details &&
        typeof error.details.output === 'string'
          ? error.details.output
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
              .slice(-8)
          : [];
      return {
        id: 'engine',
        name: GATE_NAMES.engine,
        status: 'fail',
        metrics: {},
        problems: [
          {
            message: error.message,
            fix: error.hint ?? godotHint(),
          },
        ],
        warnings: lines.length > 0 ? lines.map((line) => `Godot：${line}`) : [],
        views: [],
      };
    }
    throw error;
  }
}
