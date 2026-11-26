import type { Rect } from '@ui-pro/core';
import { fitPlane, ringAroundHole } from './background';
import { cloudFill } from './cloud-fill';
import { blendIntoHole, takeInside } from './compose';
import {
  localModelId,
  lockedByLocal,
  methodOfLock,
  notLockedError,
  readLocked,
  requestKey,
  tierOfLock,
} from './lock';
import { binarize, boundsOf, countOn } from './mask';
import {
  cloneImage,
  cropImage,
  cropMask,
  encodePng,
  extendMirrored,
  newImage,
  newMask,
  pasteImage,
  resizeImage,
  resizeMask,
} from './raster';
import { LAMA_SIZE, type ModelRunner } from './runner';
import type {
  ArtStyle,
  FillResult,
  GrayMask,
  PixelContext,
  Quality,
  RequestLabel,
  RgbaImage,
} from './types';

/** A flat or linear-gradient surround this clean is filled by arithmetic. */
const ANALYTIC_MAX_RMS = 2.5;
const ANALYTIC_MAX_OUTLIERS = 0.005;
/** The ring around the hole whose colours are fitted, and the gap kept from the hole's edge. */
const ANALYTIC_RING = 6;
const ANALYTIC_GAP = 1;
/** The context square the local model sees is this many times the hole's longer side. */
const LAMA_CONTEXT = 2.5;
const LAMA_MIN_CONTEXT = 16;
/** Pixels over which the model's pixels fade in from the hole's edge. */
const LAMA_FEATHER = 2;

export const DEFAULT_FILL_PROMPT =
  '把遮罩区域补全为与周围一致的底图，保持原有的颜色、材质和光照，不要添加新的物体或文字';
export const DEFAULT_TEXT_STRIP_PROMPT =
  '去掉遮罩区域里的文字，还原文字下面的底图，保持与周围一致的颜色、材质和光照，不要添加新的文字或图案';

export interface FillDeps {
  context: PixelContext;
  runner: ModelRunner;
  say: (message: string) => void;
}

export interface FillJob {
  image: RgbaImage;
  hole: GrayMask;
  prompt?: string;
  quality: Quality;
  style: ArtStyle;
  label: RequestLabel;
  /** `remove-text` is what stripping glyphs is called in the egress record and the cloud prompt. */
  purpose: 'inpaint' | 'remove-text';
}

/** The hole filled with a plane fitted to the colours around it, or null when they are not a plane. */
export function analyticFill(image: RgbaImage, hole: Uint8Array): RgbaImage | null {
  const ring = ringAroundHole(image, hole, ANALYTIC_RING, ANALYTIC_GAP);
  const plane = fitPlane(image, ring, 24);
  if (!plane || plane.rms > ANALYTIC_MAX_RMS || plane.outlierShare > ANALYTIC_MAX_OUTLIERS)
    return null;
  const out = cloneImage(image);
  for (let i = 0; i < hole.length; i++) {
    if (!hole[i]) continue;
    const [r, g, b] = plane.at(i % image.width, Math.floor(i / image.width));
    out.data[i * 4] = Math.max(0, Math.min(255, Math.round(r)));
    out.data[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(g)));
    out.data[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(b)));
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

/** The square of context LaMa sees: around the hole, clipped to the image. */
export function lamaCrop(hole: Rect, image: { width: number; height: number }): Rect {
  const [hx, hy, hw, hh] = hole;
  const side = Math.max(hw, hh);
  const size = Math.max(Math.round(side * LAMA_CONTEXT), side + 2 * LAMA_MIN_CONTEXT);
  const cw = Math.min(size, image.width);
  const ch = Math.min(size, image.height);
  const x = Math.min(Math.max(0, Math.round(hx + hw / 2 - cw / 2)), image.width - cw);
  const y = Math.min(Math.max(0, Math.round(hy + hh / 2 - ch / 2)), image.height - ch);
  return [x, y, cw, ch];
}

/**
 * LaMa on a 512x512 view of the hole and its surroundings (letterboxed with mirrored edges when
 * the surroundings are not square), scaled back and pasted into the hole only.
 */
async function runLama(
  runner: ModelRunner,
  image: RgbaImage,
  hole: Uint8Array,
  style: ArtStyle,
): Promise<RgbaImage> {
  const bounds = boundsOf(hole, image.width, image.height);
  if (!bounds) return cloneImage(image);
  const crop = lamaCrop(bounds, image);
  const [cx, cy, cw, ch] = crop;
  const kernel = style === 'pixel' ? 'nearest' : 'lanczos3';
  const scale = LAMA_SIZE / Math.max(cw, ch);
  const rw = Math.max(1, Math.round(cw * scale));
  const rh = Math.max(1, Math.round(ch * scale));
  const holeMask: GrayMask = {
    width: image.width,
    height: image.height,
    data: Uint8Array.from(hole, (flag) => (flag ? 255 : 0)),
  };
  const view = await extendMirrored(await resizeImage(cropImage(image, crop), rw, rh, kernel), {
    right: LAMA_SIZE - rw,
    bottom: LAMA_SIZE - rh,
  });
  const small = await resizeMask(cropMask(holeMask, crop), rw, rh, 'cubic');
  const viewMask = newMask(LAMA_SIZE, LAMA_SIZE);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      // Generous at the edge: a hole that shrinks in the downscale would leave its rim behind.
      viewMask.data[y * LAMA_SIZE + x] = (small.data[y * rw + x] ?? 0) >= 32 ? 255 : 0;
    }
  }
  const output = await runner.inpaint(view, viewMask);
  const back = await resizeImage(cropImage(output, [0, 0, rw, rh]), cw, ch, kernel);
  const generated = newImage(image.width, image.height);
  pasteImage(generated, back, cx, cy);
  return blendIntoHole(image, generated, hole, style === 'pixel' ? 0 : LAMA_FEATHER);
}

/** The local model's fill, through the lock: a locked output is reused, a new one is locked. */
async function localFill(
  deps: FillDeps,
  job: FillJob,
  hole: Uint8Array,
  lockKey?: string,
): Promise<{ image: RgbaImage; key: string; by: string; reused: boolean }> {
  const { context } = deps;
  const { image } = job;
  const key =
    lockKey ?? requestKey('fill', localModelId('lama'), { style: job.style }, [image, job.hole]);
  const locked = await readLocked(context, key, image);
  if (locked)
    return { image: takeInside(image, locked.image, hole), key, by: locked.by, reused: true };
  if (!context.store.allowNew) {
    throw notLockedError(job.label, job.purpose === 'remove-text' ? '文字剥离' : '补全');
  }
  if (!(await context.models.has('lama'))) {
    deps.say('补全：本地模型 LaMa 还没有下载，先下载（约 208 MB）');
  }
  deps.say('补全：用本地模型 LaMa 出初稿（CPU 上约几秒到十几秒）');
  const result = await runLama(deps.runner, image, hole, job.style);
  const by = lockedByLocal('lama');
  await context.store.put({ key, by, png: await encodePng(result) });
  return { image: result, key, by, reused: false };
}

/**
 * Fills the hole by the simplest method that works: arithmetic when the surroundings are a flat
 * colour or a gradient, the cloud image model for a final when it is allowed, else LaMa. Pixels
 * outside the hole are those of the input, whatever the tier.
 */
export async function fillHole(deps: FillDeps, job: FillJob): Promise<FillResult> {
  const { context } = deps;
  const { image } = job;
  if (job.hole.width !== image.width || job.hole.height !== image.height) {
    throw new Error('补全：遮罩的尺寸必须与图相同');
  }
  const hole = binarize(job.hole, 128);
  if (countOn(hole) === 0) {
    return { image: cloneImage(image), tier: 'analytic', method: 'analytic', warnings: [] };
  }

  const analytic = analyticFill(image, hole);
  if (analytic) return { image: analytic, tier: 'analytic', method: 'analytic', warnings: [] };

  const warnings: string[] = [];
  let lockKey: string | undefined;
  if (job.quality === 'final' && context.cloud && context.egress !== 'local') {
    deps.say('补全：用云端图像模型出终稿');
    const outcome = await cloudFill(context, context.cloud, {
      image,
      hole,
      prompt:
        job.prompt ??
        (job.purpose === 'remove-text' ? DEFAULT_TEXT_STRIP_PROMPT : DEFAULT_FILL_PROMPT),
      purpose: job.purpose,
      style: job.style,
      label: job.label,
    });
    warnings.push(...outcome.warnings);
    if (outcome.ok) {
      return {
        image: outcome.image,
        tier: tierOfLock(outcome.by),
        method: methodOfLock(outcome.by),
        generated: outcome.key,
        warnings,
      };
    }
    // The local result stands for this request from now on, so a rebuild does not call again
    // and `--locked` finds it.
    lockKey = outcome.key;
  }

  const local = await localFill(deps, job, hole, lockKey);
  return {
    image: local.image,
    tier: 'local',
    method: methodOfLock(local.by),
    generated: local.key,
    warnings,
  };
}
