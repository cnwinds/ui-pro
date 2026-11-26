import type { GateContext } from '../context';
import type { GateProblem } from '../types';
import { type GateRun, gateResult, round } from './types';

/**
 * Longest side of one asset, in pixels. 2048 is the texture size every mobile GPU the engine
 * targets accepts; a bigger file is split by the driver or refused.
 */
export const MAX_ASSET_SIDE = 2048;

/**
 * Texture memory of the whole screen (every asset as RGBA, 4 bytes a pixel). 32 MiB is four screens'
 * worth of full-screen 1080 x 1920 images: more than a screen needs, and low-end phones start
 * dropping textures well before they run out of memory.
 */
export const MAX_TEXTURE_BYTES = 32 * 1024 * 1024;

/**
 * Draw batches, estimated as texture changes along the draw order. Beyond 100 a frame is
 * noticeably CPU-bound on a low-end phone; beyond 200 it is the main cost. Fewer than the first
 * limit is silent.
 */
export const BATCHES_WARN = 100;
export const BATCHES_FAIL = 200;

/**
 * Blended (neither fully opaque nor fully clear) pixels the screen draws, as a share of its area.
 * Each is a read-modify-write of the frame buffer; a screen that blends more than its own area
 * warns at 0.5 and fails at 1.0 (a full-screen dim plus a full-screen glow is already 1.0).
 */
export const TRANSLUCENT_WARN = 0.5;
export const TRANSLUCENT_FAIL = 1;

/** Pixels with alpha in this range count as blended (below it they are invisible, above it opaque). */
const BLENDED_ALPHA_MIN = 8;
const BLENDED_ALPHA_MAX = 247;

/** Text is drawn from one glyph atlas, so all text ops share a texture key. */
const TEXT_TEXTURE = '\0text';

const MIB = 1024 * 1024;

/**
 * 性能预算: from the manifest and the draw list, without drawing: the largest asset side, texture
 * memory (RGBA), draw batches (a texture change between neighbouring ops makes a new batch), and
 * the share of the screen covered by blended pixels. The limits are constants: the project config
 * has no budget fields yet.
 */
export async function runBudgetGate(ctx: GateContext): Promise<GateRun> {
  const baseline = await ctx.baseline();
  const problems: GateProblem[] = [];
  const warnings: string[] = [];
  const records = new Map(ctx.manifest.assets.map((record) => [record.name, record]));

  // Size and memory.
  let bytes = 0;
  let longest = 0;
  for (const record of ctx.manifest.assets) {
    const [width, height] = record.size;
    bytes += width * height * 4;
    longest = Math.max(longest, width, height);
    if (Math.max(width, height) > MAX_ASSET_SIDE) {
      problems.push({
        node: record.uses[0]?.node,
        message: `资产 ${record.name} 是 ${width}×${height}，长边超过 ${MAX_ASSET_SIDE}`,
        fix: '把这个资产切成几张，或降低分辨率；然后重新运行 ui-pro build',
        metrics: { width, height },
      });
    }
  }
  if (bytes > MAX_TEXTURE_BYTES) {
    problems.push({
      message: `整个界面的纹理占 ${round(bytes / MIB, 1)} MiB（按 RGBA 算），超过 ${MAX_TEXTURE_BYTES / MIB} MiB`,
      fix: '合并重复的资产，裁掉透明边，或降低大图的分辨率',
      metrics: { mib: round(bytes / MIB, 1) },
    });
  }

  // Batches along the draw order.
  let batches = 0;
  let previous: string | undefined;
  for (const op of baseline.list.ops) {
    if (op.kind === 'placeholder') continue;
    const key =
      op.kind === 'text' ? TEXT_TEXTURE : (records.get(op.asset)?.atlas ?? `asset:${op.asset}`);
    if (key !== previous) batches++;
    previous = key;
  }
  if (batches > BATCHES_FAIL) {
    problems.push({
      message: `估计要 ${batches} 个绘制批次，超过 ${BATCHES_FAIL}`,
      fix: '把常一起画的小资产打进同一张图集，或减少交错的文字和图片',
      metrics: { batches },
    });
  } else if (batches > BATCHES_WARN) {
    warnings.push(`估计要 ${batches} 个绘制批次，超过 ${BATCHES_WARN}，低端机上会吃力`);
  }

  // Blended area.
  const screenArea = baseline.list.width * baseline.list.height;
  const blendedShare = new Map<string, number>();
  let blended = 0;
  for (const op of baseline.list.ops) {
    if (op.kind !== 'image') continue;
    let share = blendedShare.get(op.asset);
    if (share === undefined) {
      const raster = await ctx.asset(op.asset);
      share = 0;
      if (raster) {
        let count = 0;
        for (let i = 3; i < raster.data.length; i += 4) {
          const alpha = raster.data[i] ?? 0;
          if (alpha >= BLENDED_ALPHA_MIN && alpha <= BLENDED_ALPHA_MAX) count++;
        }
        share = count / (raster.width * raster.height);
      }
      blendedShare.set(op.asset, share);
    }
    blended += op.dest[2] * op.dest[3] * share;
  }
  const translucent = blended / screenArea;
  if (translucent > TRANSLUCENT_FAIL) {
    problems.push({
      message: `半透明像素覆盖了界面面积的 ${round(translucent * 100, 0)}%，超过 ${TRANSLUCENT_FAIL * 100}%`,
      fix: '减少大面积的半透明叠层（光晕、遮罩），或把不透明部分单独切出来',
      metrics: { translucent: round(translucent, 2) },
    });
  } else if (translucent > TRANSLUCENT_WARN) {
    warnings.push(
      `半透明像素覆盖了界面面积的 ${round(translucent * 100, 0)}%，超过 ${TRANSLUCENT_WARN * 100}%`,
    );
  }

  return {
    result: gateResult('budget', {
      metrics: {
        assets: ctx.manifest.assets.length,
        longestSide: longest,
        textureMiB: round(bytes / MIB, 2),
        batches,
        translucent: round(translucent, 3),
      },
      problems,
      warnings,
    }),
  };
}
