import { preOrder } from '@ui-pro/core';
import type { TextOp } from '@ui-pro/renderer';
import { deltaERgb } from '../color';
import type { GateContext } from '../context';
import { errorMaps, maskedMean } from '../metrics';
import {
  boxArea,
  encodePng,
  fillMask,
  intersectBox,
  type PixelBox,
  pixelBox,
  type Raster,
} from '../raster';
import type { GateProblem } from '../types';
import { compareSheet, framed, heatRaster } from '../views';
import { type GateRun, gateResult, round } from './types';

/**
 * Whole screen: mean structural similarity of the grey images. A rebuild from the same pixels
 * lands at 0.99 or more; 0.97 is where a missing or misplaced piece of any size starts to show
 * up as a drop over the whole page.
 */
export const GLOBAL_SSIM_MIN = 0.97;

/**
 * Whole screen: mean CIEDE2000 over the pixels that count. 1 is the smallest difference people
 * see side by side; 2 allows resampling and compression noise but not a miscoloured region of
 * any size (that one is caught per node, where its error is not diluted by the rest).
 */
export const GLOBAL_DELTA_E_MAX = 2;

/** Per node, in its own rectangle: smaller regions vary more, so the bounds are looser. */
export const NODE_SSIM_MIN = 0.9;
export const NODE_DELTA_E_MAX = 4;

/** A node with fewer counted pixels than this is too small to measure (a 5 x 5 patch). */
export const NODE_MIN_PIXELS = 24;

/** Dynamic text is excluded from the global measure with this much room round its box, in design pixels. */
export const TEXT_MASK_MARGIN = 2;

/** A pixel is ink when the reference differs from the same frame without the text by this much. */
export const TEXT_INK_DELTA_E = 15;

/** Fewer ink pixels than this in the reference: the box holds no text. */
export const TEXT_INK_MIN_PIXELS = 6;

/**
 * Text ink: intersection over union of the reference ink's bounding box and the rendered one's.
 * The same words in another typeface rarely overlap better than 0.7 and rarely worse than 0.5; a
 * box off by half its height or a size off by a third falls below.
 */
export const TEXT_INK_IOU_MIN = 0.5;

/** Text ink: ΔE2000 between the dominant colour of the reference ink and of the rendered ink. */
export const TEXT_COLOR_DELTA_E_MAX = 20;

/** Most nodes (worst first) that get a picture in the report. */
export const MAX_NODE_VIEWS = 10;

interface Ink {
  box: PixelBox;
  count: number;
  color: [number, number, number];
}

/** The most common colour (16 levels a channel) of the given pixels, averaged within its bin. */
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

/** Design-pixel room round a text box for its stroke and shadow. */
function textReach(op: TextOp): number {
  const stroke = op.stroke?.width ?? 0;
  const shadow = op.shadow
    ? Math.max(Math.abs(op.shadow.offset[0]), Math.abs(op.shadow.offset[1])) + (op.shadow.blur ?? 0)
    : 0;
  return TEXT_MASK_MARGIN + Math.max(stroke, shadow);
}

const rgbAt = (data: Uint8Array, at: number): [number, number, number] => [
  data[at * 4] ?? 0,
  data[at * 4 + 1] ?? 0,
  data[at * 4 + 2] ?? 0,
];

/** A text box with room for its stroke and shadow, as pixels. */
function textArea(op: TextOp, scale: number, width: number, height: number): PixelBox | undefined {
  const reach = textReach(op);
  const [x, y, w, h] = op.box;
  return pixelBox([x - reach, y - reach, w + 2 * reach, h + 2 * reach], scale, width, height);
}

/**
 * 重组保真: renders the default state at the reference's size and compares. Global SSIM and mean
 * ΔE2000 leave out the exclusion zones and dynamic text (drawn by the engine's font, so never
 * pixel-equal); each node that draws an asset is measured in its own rectangle less whatever is
 * drawn above it; each dynamic text is checked for where its ink lands, how big it is and its
 * main colour. Differences the manifest or the draw list already explains are warnings.
 */
export async function runFidelityGate(ctx: GateContext): Promise<GateRun> {
  const session = await ctx.session();
  const frame = await ctx.baseline();
  const reference = await ctx.reference();
  const { width, height } = frame;
  const scale = width / frame.list.width;
  const problems: GateProblem[] = [];
  const warnings: string[] = [...frame.list.warnings];
  const views: string[] = [];
  if (ctx.referenceResized()) {
    warnings.push('基准图与重组图差一个像素，已把基准图重采样到重组图的大小再比对');
  }

  const textOps = frame.list.ops.filter((op): op is TextOp => op.kind === 'text');
  const counted = new Uint8Array(width * height).fill(1);
  for (const exclusion of ctx.doc.exclusions) {
    const box = pixelBox(exclusion.rect, scale, width, height);
    if (box) fillMask(counted, width, box, 0);
  }
  for (const op of textOps) {
    const box = textArea(op, scale, width, height);
    if (box) fillMask(counted, width, box, 0);
  }

  const frameRaster: Raster = { width, height, data: frame.data };
  const maps = errorMaps(reference, frameRaster);
  const whole: PixelBox = [0, 0, width, height];
  const global = {
    ssim: maskedMean(maps.ssim, width, whole, counted),
    deltaE: maskedMean(maps.deltaE, width, whole, counted),
  };

  // The picture leaves out what does not count (exclusions, dynamic text) so it shows only what
  // would fail.
  const shownDelta = maps.deltaE.map((value, at) => (counted[at] ? value : 0));
  const heat = heatRaster(reference, shownDelta);
  const heatPng = await encodePng(heat);
  const heatPath = await ctx.writeView('fidelity.png', heatPng);
  views.push(heatPath);
  const sideBySide = await ctx.writeView(
    'fidelity-compare.png',
    compareSheet(whole, [
      { label: '基准图', raster: reference },
      { label: '重组图', raster: frameRaster },
      { label: '色差热力图', raster: heat },
    ]),
  );
  views.push(sideBySide);

  const globalReasons: string[] = [];
  if (global.ssim.mean < GLOBAL_SSIM_MIN) {
    globalReasons.push(`结构相似度 ${round(global.ssim.mean)}，低于 ${GLOBAL_SSIM_MIN}`);
  }
  if (global.deltaE.mean > GLOBAL_DELTA_E_MAX) {
    globalReasons.push(`平均色差 ${round(global.deltaE.mean, 2)}，高于 ${GLOBAL_DELTA_E_MAX}`);
  }
  if (globalReasons.length > 0) {
    problems.push({
      message: `整体与基准图不一致（${globalReasons.join('；')}）`,
      fix: '看热力图里红色的地方，是哪个资产没切对、没补全，或还缺资产；修好后重新运行 ui-pro build',
      metrics: { ssim: round(global.ssim.mean), deltaE: round(global.deltaE.mean, 2) },
      view: heatPath,
    });
  }

  // Per node.
  const records = new Map(ctx.manifest.assets.map((record) => [record.name, record]));
  const failures: {
    node: string;
    ssim: number;
    deltaE: number;
    box: PixelBox;
    excused?: string;
  }[] = [];
  let measured = 0;
  for (const id of preOrder(ctx.doc)) {
    if (ctx.ownership.get(id)?.kind !== 'asset' || !ctx.shown(id)) continue;
    const op = frame.list.ops.find((entry) => entry.node === id && entry.kind === 'image');
    const rect = frame.rects.get(id);
    if (!op || !rect) continue;
    const box = pixelBox(rect, scale, width, height);
    if (!box) continue;

    const local = new Uint8Array(counted.length);
    for (let y = box[1]; y < box[3]; y++) {
      local.set(counted.subarray(y * width + box[0], y * width + box[2]), y * width + box[0]);
    }
    for (const hole of ctx.holes.get(id) ?? []) {
      const covered = pixelBox(hole.rect, scale, width, height);
      if (covered) fillMask(local, width, covered, 0);
    }
    const ssim = maskedMean(maps.ssim, width, box, local);
    const deltaE = maskedMean(maps.deltaE, width, box, local);
    if (ssim.count < NODE_MIN_PIXELS) continue;
    measured++;
    if (ssim.mean >= NODE_SSIM_MIN && deltaE.mean <= NODE_DELTA_E_MAX) continue;

    const approximations = records.get(op.kind === 'image' ? op.asset : '')?.approximations ?? [];
    failures.push({
      node: id,
      ssim: ssim.mean,
      deltaE: deltaE.mean,
      box,
      ...(approximations.length > 0 ? { excused: approximations.join('；') } : {}),
    });
  }
  failures.sort((a, b) => a.ssim - b.ssim);

  let shownViews = 0;
  for (const failure of failures) {
    const reasons: string[] = [];
    if (failure.ssim < NODE_SSIM_MIN) {
      reasons.push(`结构相似度 ${round(failure.ssim)}，低于 ${NODE_SSIM_MIN}`);
    }
    if (failure.deltaE > NODE_DELTA_E_MAX) {
      reasons.push(`平均色差 ${round(failure.deltaE, 2)}，高于 ${NODE_DELTA_E_MAX}`);
    }
    const message = `节点 #${failure.node} 与基准图不一致（${reasons.join('；')}）`;
    if (failure.excused !== undefined) {
      warnings.push(`${message}；资产清单已记录近似项：${failure.excused}`);
      continue;
    }
    let view: string | undefined;
    if (shownViews < MAX_NODE_VIEWS) {
      shownViews++;
      const box = framed(failure.box, reference);
      view = await ctx.writeView(
        `fidelity-${failure.node}.png`,
        compareSheet(box, [
          { label: '基准图', raster: reference },
          { label: '重组图', raster: frameRaster },
          { label: '色差热力图', raster: heat },
        ]),
      );
      views.push(view);
    }
    problems.push({
      node: failure.node,
      message,
      fix: `检查节点 #${failure.node} 的资产：切得对不对、颜色（着色）对不对、遮挡处补得对不对；修好后重新运行 ui-pro build`,
      metrics: { ssim: round(failure.ssim), deltaE: round(failure.deltaE, 2) },
      ...(view ? { view } : {}),
    });
  }
  // Dynamic text: where the ink lands.
  let textChecked = 0;
  if (textOps.length > 0) {
    const ids = textOps.map((op) => op.node);
    const without = await session.render({ hidden: ids, background: '#ff00ff' });
    const only = await session.renderNodes(ids);
    for (const op of textOps) {
      const box = textArea(op, scale, width, height);
      if (!box) continue;
      textChecked++;
      const wanted = inkOf(
        box,
        width,
        (at) =>
          deltaERgb(...rgbAt(reference.data, at), ...rgbAt(without.data, at)) > TEXT_INK_DELTA_E,
        (at) => rgbAt(reference.data, at),
      );
      const drawn = inkOf(
        box,
        width,
        (at) => (only.data[at * 4 + 3] ?? 0) >= 128,
        (at) => rgbAt(only.data, at),
      );
      const fallback = op.font.file === undefined;
      const fix = `核对节点 #${op.node} 的文字框、字号（text.size）和颜色（text.color）；字体见项目配置 fonts`;
      const complain = (message: string, metrics?: Record<string, number>) => {
        if (fallback) warnings.push(`${message}；用的是系统字体兜底，字形不同在所难免`);
        else problems.push({ node: op.node, message, fix, ...(metrics ? { metrics } : {}) });
      };

      if (!wanted || wanted.count < TEXT_INK_MIN_PIXELS) {
        problems.push({
          node: op.node,
          message: `节点 #${op.node} 的文字框里，基准图和去掉文字的重组图没有差别：框可能框错了，或者文字没有从底下的资产里剥离`,
          fix: `看基准图里这个位置有没有字；有的话重新构建，让文字从底下的资产里剥离`,
        });
        continue;
      }
      if (!drawn) continue;
      const overlap = iou(wanted.box, drawn.box);
      if (overlap < TEXT_INK_IOU_MIN) {
        complain(
          `节点 #${op.node} 的文字墨迹位置或大小与基准图不符（外接框交并比 ${round(overlap, 2)}，低于 ${TEXT_INK_IOU_MIN}）`,
          { iou: round(overlap, 2) },
        );
      }
      const colorGap = deltaERgb(...wanted.color, ...drawn.color);
      if (colorGap > TEXT_COLOR_DELTA_E_MAX) {
        complain(
          `节点 #${op.node} 的文字主体颜色与基准图不符（色差 ${round(colorGap, 1)}，高于 ${TEXT_COLOR_DELTA_E_MAX}）`,
          { colorDeltaE: round(colorGap, 1) },
        );
      }
    }
  }

  return {
    result: gateResult('fidelity', {
      metrics: {
        ssim: round(global.ssim.mean),
        deltaE: round(global.deltaE.mean, 2),
        nodesMeasured: measured,
        nodesFailed: failures.length,
        textChecked,
      },
      problems,
      warnings,
      views,
    }),
  };
}
