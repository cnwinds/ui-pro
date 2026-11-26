import { type AskQuestion, preOrder, subtreeIds } from '@ui-pro/core';
import type { RenderResult } from '@ui-pro/renderer';
import { deltaERgb } from '../color';
import { FRAME_BACKGROUND, type GateContext } from '../context';
import { dilateMask, erodeMask, growBox, type PixelBox, pixelBox, type Raster } from '../raster';
import type { GateProblem } from '../types';
import { compareSheet } from '../views';
import { type GateRun, gateResult, round } from './types';

/**
 * Ghost: how alike the grey values of the reference and of the frame with the occluder hidden are
 * where the occluder was (normalized cross-correlation). Properly filled, the two share nothing
 * (about 0 or negative); if the occluder's pixels were left in the asset they match (0.9 or more).
 * 0.75 leaves room for resampling.
 */
export const GHOST_NCC_MIN = 0.75;

/** Ghost: and the colours must be close too, mean ΔE2000 at most this (a recoloured copy is not a ghost). */
export const GHOST_DELTA_E_MAX = 10;

/** Correlation is meaningless on flat patches; below this standard deviation (grey levels) it counts as 0. */
export const FLAT_STD = 2;

/**
 * Seam: ΔE2000 between the mean colour of the revealed area and of a band round it (inside the
 * same asset). A filled area that belongs there is within a few units; a leftover of a red badge
 * on a blue panel is 50 or more. ΔE2000 shrinks in dark colours: a lighter navy card left on a
 * dark navy ground is only about 14 yet plainly visible (measured on the medium screen), so the
 * limit is 10, which still allows the shading across a large area (a few units).
 */
export const SEAM_DELTA_E_MAX = 10;

/**
 * Seam: how much busier (mean Sobel gradient, grey levels per pixel) the revealed area is than the
 * band round it. Invented noise or leftover edges make it busier; 8 is clearly visible texture.
 */
export const SEAM_GRADIENT_EXCESS_MAX = 8;

/** Fewer revealed pixels than this give no reliable measure (about a 3 x 4 patch). */
export const MIN_EXPOSED_PIXELS = 12;

/** Dynamic text and other soft shapes count as an occluder's footprint from this alpha. */
export const FOOTPRINT_ALPHA = 64;

/** A filled or stripped area above this share of the screen is a lot of invented pixels: ask. */
export const FILL_ASK_AREA_RATIO = 0.05;

/** A single block above this (design px², about 200 x 200) is asked about by itself. */
export const FILL_ASK_BLOCK_AREA = 40_000;

/** Most single-block questions per screen; the total question covers the rest. */
const MAX_BLOCK_ASKS = 5;

/** Most pictures of problems and questions. */
const MAX_VIEWS = 8;

interface Footprint {
  mask: Uint8Array;
}

const luma = (data: Uint8Array, at: number): number =>
  0.299 * (data[at * 4] ?? 0) + 0.587 * (data[at * 4 + 1] ?? 0) + 0.114 * (data[at * 4 + 2] ?? 0);

/** The band round the revealed area is this wide (design-independent): 15% of its short side, 3 to 12 px. */
const bandWidth = (box: PixelBox): number =>
  Math.max(3, Math.min(12, Math.round(0.15 * Math.min(box[2] - box[0], box[3] - box[1]))));

/** Sobel gradient magnitude (grey levels per pixel) at a pixel that has all eight neighbours. */
function gradient(gray: Float32Array, width: number, at: number): number {
  const g = (offset: number) => gray[at + offset] ?? 0;
  const gx = g(-width + 1) + 2 * g(1) + g(width + 1) - g(-width - 1) - 2 * g(-1) - g(width - 1);
  const gy =
    g(width - 1) + 2 * g(width) + g(width + 1) - g(-width - 1) - 2 * g(-width) - g(-width + 1);
  return Math.hypot(gx, gy) / 8;
}

interface Pair {
  owner: string;
  occluder: string;
  handling: 'filled' | 'stripped';
}

/**
 * 显隐测试: for each asset owner, renders the frame with every occluder that was filled or
 * stripped hidden, and looks at what shows where each occluder was. Two defects: a ghost (the
 * occluder's own pixels are still in the asset, so they match the reference there) and a seam (the
 * revealed area does not belong with the band round it in colour or texture). Occluders whose
 * pixels were deliberately kept (`occlusion.fill: none`) stay drawn. Large filled areas are not
 * failures, they raise questions: the pixels there were invented.
 */
export async function runHideGate(ctx: GateContext): Promise<GateRun> {
  if (ctx.doc.source.kind === 'psd') {
    return {
      result: gateResult('hide', {
        status: 'skipped',
        reason: 'PSD 源文件的图层本来就是分开的，没有补全或剥离的区域可测',
      }),
    };
  }
  const session = await ctx.session();
  const baseline = await ctx.baseline();
  const reference = await ctx.reference();
  const { width, height } = baseline;
  const scale = width / baseline.list.width;
  const screenArea = width * height;
  const problems: GateProblem[] = [];
  const warnings: string[] = [];
  const views: string[] = [];
  const asks: AskQuestion[] = [];
  const filledEver = new Uint8Array(screenArea);
  const blocks: {
    owner: string;
    occluder: string;
    area: number;
    box: PixelBox;
    frame: RenderResult;
  }[] = [];

  let frames = 0;
  let checks = 0;
  let ghosts = 0;
  let seams = 0;
  let skipped = 0;
  const footprints = new Map<string, Footprint | undefined>();

  /** Where the node and its subtree put solid pixels; `own` limits it to the node's own ops. */
  async function footprintOf(id: string, own = false): Promise<Footprint | undefined> {
    const key = `${own ? '1' : '0'}${id}`;
    if (footprints.has(key)) return footprints.get(key);
    const ids = own ? [id] : subtreeIds(ctx.doc, id);
    const drawn = baseline.list.ops.some(
      (op) => ids.includes(op.node) && op.kind !== 'placeholder',
    );
    let found: Footprint | undefined;
    if (drawn) {
      const frame = await session.renderNodes(ids);
      frames++;
      let mask: Uint8Array = new Uint8Array(screenArea);
      for (let i = 0; i < screenArea; i++) {
        if ((frame.data[i * 4 + 3] ?? 0) >= FOOTPRINT_ALPHA) mask[i] = 1;
      }
      // Antialiased glyph edges are in the reference but fainter than the footprint's cut-off.
      if (ctx.doc.nodes[id]?.type === 'text') mask = dilateMask(mask, width, height, 1);
      found = { mask };
    }
    footprints.set(key, found);
    return found;
  }

  const rendered = new Map<string, RenderResult>();
  const ownersWithHoles = preOrder(ctx.doc).filter(
    (id) => ctx.shown(id) && (ctx.holes.get(id) ?? []).some((hole) => hole.handling !== 'kept'),
  );

  for (const owner of ownersWithHoles) {
    const all = ctx.holes.get(owner) ?? [];
    const pairs: Pair[] = all
      .filter(
        (hole): hole is typeof hole & { handling: 'filled' | 'stripped' } =>
          hole.handling !== 'kept',
      )
      .map((hole) => ({ owner, occluder: hole.node, handling: hole.handling }));
    const ownerOp = baseline.list.ops.find((op) => op.node === owner && op.kind === 'image');
    if (!ownerOp) {
      skipped++;
      continue;
    }
    const ownerPrint = await footprintOf(owner, true);
    if (!ownerPrint) continue;

    const hidden = [
      ...new Set(pairs.map((pair) => pair.occluder).filter((id) => ctx.doc.nodes[id])),
    ];
    let frame = baseline;
    if (hidden.length > 0) {
      const key = hidden.join('|');
      const cached = rendered.get(key);
      if (cached) frame = cached;
      else {
        frame = await session.render({ hidden, background: FRAME_BACKGROUND });
        frames++;
        rendered.set(key, frame);
      }
    }

    // Occluders that stay drawn in this frame: kept ones whose ancestors are not hidden.
    const hiddenTree = new Set(hidden.flatMap((id) => subtreeIds(ctx.doc, id)));
    const stays: Footprint[] = [];
    for (const hole of all) {
      if (hole.handling !== 'kept' || hiddenTree.has(hole.node)) continue;
      const print = await footprintOf(hole.node);
      if (print) stays.push(print);
    }

    for (const pair of pairs) {
      const hole = all.find((entry) => entry.node === pair.occluder);
      if (!hole) continue;
      const box = pixelBox(hole.rect, scale, width, height);
      if (!box) continue;
      const isNode = ctx.doc.nodes[pair.occluder] !== undefined;
      const print = isNode ? await footprintOf(pair.occluder) : undefined;
      if (isNode && !print) continue;

      const margin = bandWidth(box);
      const around = growBox(box, 2 * margin, width, height);
      const bw = around[2] - around[0];
      const bh = around[3] - around[1];
      const exposed = new Uint8Array(bw * bh);
      let count = 0;
      for (let y = box[1]; y < box[3]; y++) {
        for (let x = box[0]; x < box[2]; x++) {
          const at = y * width + x;
          if (!ownerPrint.mask[at] || (print && !print.mask[at])) continue;
          if (stays.some((stay) => stay.mask[at])) continue;
          exposed[(y - around[1]) * bw + (x - around[0])] = 1;
          filledEver[at] = 1;
          count++;
        }
      }
      if (count < MIN_EXPOSED_PIXELS) continue;
      checks++;

      const area = count / (scale * scale);
      const picture = async (name: string): Promise<string> => {
        const framed = growBox(box, 12, width, height);
        const where = await ctx.writeView(
          `hide-${name}.png`,
          compareSheet(framed, [
            { label: '基准图', raster: reference },
            { label: `隐藏 #${pair.occluder} 后`, raster: frameRaster(frame) },
            { label: '重组图', raster: frameRaster(baseline) },
          ]),
        );
        return where;
      };

      // Ghost: do the reference and the revealed pixels still look the same?
      let sumR = 0;
      let sumH = 0;
      let sumRR = 0;
      let sumHH = 0;
      let sumRH = 0;
      let sumDelta = 0;
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          if (!exposed[y * bw + x]) continue;
          const at = (y + around[1]) * width + (x + around[0]);
          const r = luma(reference.data, at);
          const h = luma(frame.data, at);
          sumR += r;
          sumH += h;
          sumRR += r * r;
          sumHH += h * h;
          sumRH += r * h;
          sumDelta += deltaERgb(
            reference.data[at * 4] ?? 0,
            reference.data[at * 4 + 1] ?? 0,
            reference.data[at * 4 + 2] ?? 0,
            frame.data[at * 4] ?? 0,
            frame.data[at * 4 + 1] ?? 0,
            frame.data[at * 4 + 2] ?? 0,
          );
        }
      }
      const varR = sumRR / count - (sumR / count) ** 2;
      const varH = sumHH / count - (sumH / count) ** 2;
      const flat =
        Math.sqrt(Math.max(0, varR)) < FLAT_STD || Math.sqrt(Math.max(0, varH)) < FLAT_STD;
      const ncc = flat
        ? 0
        : (sumRH / count - (sumR / count) * (sumH / count)) / Math.sqrt(varR * varH);
      const meanDelta = sumDelta / count;
      const ghost = ncc >= GHOST_NCC_MIN && meanDelta <= GHOST_DELTA_E_MAX;

      // Seam: does it belong with its surroundings?
      const grown = dilateMask(exposed, bw, bh, margin);
      const outer = dilateMask(exposed, bw, bh, 2 * margin);
      const inner = erodeMask(exposed, bw, bh, 1);
      const gray = new Float32Array(bw * bh);
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          gray[y * bw + x] = luma(frame.data, (y + around[1]) * width + (x + around[0]));
        }
      }
      let inR = 0;
      let inG = 0;
      let inB = 0;
      let inN = 0;
      let bandR = 0;
      let bandG = 0;
      let bandB = 0;
      let bandN = 0;
      let gradIn = 0;
      let gradInN = 0;
      let gradBand = 0;
      let gradBandN = 0;
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const local = y * bw + x;
          const at = (y + around[1]) * width + (x + around[0]);
          const edge = x === 0 || y === 0 || x === bw - 1 || y === bh - 1;
          if (exposed[local]) {
            inR += frame.data[at * 4] ?? 0;
            inG += frame.data[at * 4 + 1] ?? 0;
            inB += frame.data[at * 4 + 2] ?? 0;
            inN++;
            if (inner[local] && !edge) {
              gradIn += gradient(gray, bw, local);
              gradInN++;
            }
          } else if (outer[local] && !grown[local] && ownerPrint.mask[at]) {
            bandR += frame.data[at * 4] ?? 0;
            bandG += frame.data[at * 4 + 1] ?? 0;
            bandB += frame.data[at * 4 + 2] ?? 0;
            bandN++;
            if (!edge) {
              gradBand += gradient(gray, bw, local);
              gradBandN++;
            }
          }
        }
      }
      let seamDelta = 0;
      let excess = 0;
      let seam = false;
      if (bandN >= MIN_EXPOSED_PIXELS) {
        seamDelta = deltaERgb(
          Math.round(inR / inN),
          Math.round(inG / inN),
          Math.round(inB / inN),
          Math.round(bandR / bandN),
          Math.round(bandG / bandN),
          Math.round(bandB / bandN),
        );
        if (gradInN > 0 && gradBandN > 0) excess = gradIn / gradInN - gradBand / gradBandN;
        seam = seamDelta > SEAM_DELTA_E_MAX || excess > SEAM_GRADIENT_EXCESS_MAX;
      }

      const what = pair.handling === 'stripped' ? '剥离的文字' : '补全';
      const name = `${owner}-${pair.occluder}`;
      if (ghost || seam) {
        if (ghost) ghosts++;
        if (seam) seams++;
        const view = views.length < MAX_VIEWS ? await picture(name) : undefined;
        if (view) views.push(view);
        if (ghost) {
          problems.push({
            node: owner,
            message: `隐藏 #${pair.occluder} 后，#${owner} 上它原来的位置还留着残影（与基准图的相关度 ${round(ncc, 2)}，平均色差 ${round(meanDelta, 1)}）：${what}没有把它的像素去干净`,
            fix: `重新补全 #${owner} 被 #${pair.occluder} 挡住的区域；如果这里本来就该保留，把 #${pair.occluder} 的 occlusion.fill 改成 none`,
            metrics: { ncc: round(ncc, 2), deltaE: round(meanDelta, 1), area: Math.round(area) },
            ...(view ? { view } : {}),
          });
        }
        if (seam) {
          const reasons: string[] = [];
          if (seamDelta > SEAM_DELTA_E_MAX) {
            reasons.push(`与周围色差 ${round(seamDelta, 1)}，高于 ${SEAM_DELTA_E_MAX}`);
          }
          if (excess > SEAM_GRADIENT_EXCESS_MAX) {
            reasons.push(`纹理比周围杂 ${round(excess, 1)}，高于 ${SEAM_GRADIENT_EXCESS_MAX}`);
          }
          problems.push({
            node: owner,
            message: `隐藏 #${pair.occluder} 后，#${owner} 露出来的区域与周围接不上（${reasons.join('；')}）`,
            fix: `重新补全 #${owner} 被 #${pair.occluder} 挡住的区域，让它与周围衔接`,
            metrics: {
              seamDeltaE: round(seamDelta, 1),
              gradientExcess: round(excess, 1),
              area: Math.round(area),
            },
            ...(view ? { view } : {}),
          });
        }
      }
      blocks.push({ owner, occluder: pair.occluder, area, box, frame });
    }
  }

  // Large invented areas are for the user to confirm.
  let filledPixels = 0;
  for (let i = 0; i < screenArea; i++) if (filledEver[i]) filledPixels++;
  const share = filledPixels / screenArea;
  const big = blocks
    .filter((block) => block.area > FILL_ASK_BLOCK_AREA)
    .sort((a, b) => b.area - a.area)
    .slice(0, MAX_BLOCK_ASKS);
  for (const block of big) {
    let view: string | undefined;
    if (views.length < 2 * MAX_VIEWS) {
      view = await ctx.writeView(
        `hide-fill-${block.owner}-${block.occluder}.png`,
        compareSheet(growBox(block.box, 12, width, height), [
          { label: '基准图', raster: reference },
          { label: `隐藏 #${block.occluder} 后`, raster: frameRaster(block.frame) },
        ]),
      );
      views.push(view);
    }
    asks.push({
      id: `hide.fill.${block.owner}.${block.occluder}`,
      question: `#${block.owner} 上被 #${block.occluder} 挡住的 ${Math.round(block.area)} 设计像素是补出来的（单块超过 ${FILL_ASK_BLOCK_AREA}），请看图确认补得对不对${view ? `：${view}` : ''}`,
      options: ['确认', '重做'],
      default: '确认',
    });
  }
  if (share > FILL_ASK_AREA_RATIO) {
    asks.push({
      id: 'hide.fill.total',
      question: `这个界面共有约 ${round(share * 100, 1)}% 的画面是补全或剥离文字时编造的像素（超过 ${FILL_ASK_AREA_RATIO * 100}%），请确认`,
      options: ['确认', '重做'],
      default: '确认',
    });
  }
  if (skipped > 0) warnings.push(`${skipped} 个节点还没有资产，没法做显隐测试`);

  return {
    result: gateResult('hide', {
      metrics: {
        frames,
        checks,
        ghosts,
        seams,
        filledShare: round(share, 4),
      },
      problems,
      warnings,
      views,
    }),
    ...(asks.length > 0 ? { ask: asks } : {}),
  };
}

function frameRaster(frame: RenderResult): Raster {
  return { width: frame.width, height: frame.height, data: frame.data };
}
