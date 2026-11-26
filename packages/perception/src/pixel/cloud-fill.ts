import { type Rect, UiProError } from '@ui-pro/core';
import { PerceptionErrorCodes } from '../errors';
import {
  ALIGN_MAX_DIFFERENCE,
  COLOR_MAX_DELTA_E,
  candidateCost,
  detectShift,
  meanDifference,
  outsideZone,
  ringColorDelta,
  ringZone,
} from './cloud-checks';
import { blendIntoHole, takeInside } from './compose';
import { notLockedError, readLocked, requestKey } from './lock';
import { boundsOf } from './mask';
import {
  cloneImage,
  cropImage,
  cropMask,
  decodeBytes,
  encodeMaskPng,
  encodePng,
  encodeRgbPng,
  resizeImage,
  resizeMask,
  sha256Hex,
} from './raster';
import type {
  ArtStyle,
  CloudImageModel,
  GrayMask,
  PixelContext,
  RequestLabel,
  RgbaImage,
} from './types';

/** Candidates asked for in one call (constraint 5); the service's own limit caps it. */
export const CLOUD_CANDIDATES = 2;
/** Width of the transition inside the mask's edge, in pixels (constraint 1). */
export const TRANSITION_PIXELS = 3;
/** Context around the hole in the crop that is sent, at least this many pixels (constraint 3). */
const CONTEXT_MIN = 32;
const CONTEXT_SHARE = 0.5;

export interface CloudFillJob {
  image: RgbaImage;
  /** 0/1 flags, one per pixel. */
  hole: Uint8Array;
  prompt: string;
  /** What the call is for; `remove-text` is a masked repaint whose mask is the glyphs. */
  purpose: 'inpaint' | 'remove-text';
  style: ArtStyle;
  label: RequestLabel;
}

export type CloudFillOutcome =
  | { ok: true; image: RgbaImage; key: string; by: string; reused: boolean; warnings: string[] }
  | { ok: false; key: string; warnings: string[] };

export interface CropPlan {
  /** The crop of the source image, in source pixels. */
  crop: Rect;
  /** Factor from crop pixels to sent pixels. */
  scale: number;
  sent: { width: number; height: number };
  warnings: string[];
}

/**
 * The part of the source that is sent (constraint 3): the hole and a ring of context at the
 * source's own pixel density. A crop under the minimum side gets more context; only when the
 * whole source is too small is the crop enlarged (Lanczos) and then shrunk back on return.
 */
export function planCrop(
  hole: Rect,
  source: { width: number; height: number },
  limits: { minSide: number; maxSide: number },
): CropPlan {
  const [hx, hy, hw, hh] = hole;
  const context = Math.max(CONTEXT_MIN, Math.round(CONTEXT_SHARE * Math.max(hw, hh)));
  let cw = Math.min(source.width, Math.max(hw + 2 * context, limits.minSide));
  let ch = Math.min(source.height, Math.max(hh + 2 * context, limits.minSide));
  cw = Math.max(1, cw);
  ch = Math.max(1, ch);
  const x0 = Math.min(Math.max(0, Math.round(hx + hw / 2 - cw / 2)), source.width - cw);
  const y0 = Math.min(Math.max(0, Math.round(hy + hh / 2 - ch / 2)), source.height - ch);
  const warnings: string[] = [];
  let scale = 1;
  if (Math.min(cw, ch) < limits.minSide) {
    scale = limits.minSide / Math.min(cw, ch);
    warnings.push(
      `整张源图有一边不足 ${limits.minSide} 像素，已用 Lanczos 放大 ${scale.toFixed(2)} 倍后送出，取回后缩回原尺寸`,
    );
  }
  if (Math.max(cw, ch) * scale > limits.maxSide) {
    scale = limits.maxSide / Math.max(cw, ch);
    warnings.push(
      `要补全的区域太大，送出前缩小到 ${scale.toFixed(2)} 倍（云端接口每边最多 ${limits.maxSide} 像素）`,
    );
  }
  const width = Math.max(limits.minSide, Math.round(cw * scale));
  const height = Math.max(limits.minSide, Math.round(ch * scale));
  if (width > limits.maxSide || height > limits.maxSide) {
    throw new UiProError(
      PerceptionErrorCodes.cloudImage,
      `要补全的区域形状太极端（${cw}x${ch}），无法裁成云端接口接受的 ${limits.minSide}–${limits.maxSide} 像素`,
    );
  }
  return { crop: [x0, y0, cw, ch], scale, sent: { width, height }, warnings };
}

interface Candidate {
  image: RgbaImage;
  cost: number;
}

/** Why a candidate is thrown out (constraints 2 and 4), or null when it passes both checks. */
function rejectionReason(
  sent: RgbaImage,
  candidate: RgbaImage,
  holeSent: Uint8Array,
): string | null {
  const { width, height } = sent;
  const outside = outsideZone(holeSent, width, height);
  const difference = meanDifference(sent, candidate, outside);
  if (difference > ALIGN_MAX_DIFFERENCE) {
    const shift = detectShift(sent, candidate, outside);
    return shift
      ? `画面平移了（${shift.dx}, ${shift.dy}）像素，遮罩外与送出的像素对不上（差异 ${difference.toFixed(1)}）`
      : `遮罩外与送出的像素对不上，可能被平移或缩放（差异 ${difference.toFixed(1)}）`;
  }
  const delta = ringColorDelta(sent, candidate, ringZone(holeSent, width, height));
  if (delta > COLOR_MAX_DELTA_E) {
    return `遮罩外一圈的颜色偏了（色差 ${delta.toFixed(1)}）`;
  }
  return null;
}

/**
 * Fills the hole with the cloud image model under the eight constraints of DESIGN §6.6:
 * locked output first (6), budget (7), a crop at the source's density (3), the egress record (8),
 * several candidates (5), alignment (2) and colour (4) checks, and only the mask's pixels taken (1).
 *
 * Throws `E_NOT_LOCKED`, `E_IMAGE_BUDGET` and `E_CLOUD_IMAGE`; when every candidate is thrown
 * out the outcome is `ok: false` and the caller falls back to the local model.
 */
export async function cloudFill(
  context: PixelContext,
  cloud: CloudImageModel,
  job: CloudFillJob,
): Promise<CloudFillOutcome> {
  const { image, hole, label } = job;
  const { width, height } = image;
  const candidatesWanted = Math.min(CLOUD_CANDIDATES, cloud.capabilities.maxCandidates);
  const holeMask: GrayMask = {
    width,
    height,
    data: Uint8Array.from(hole, (flag) => (flag ? 255 : 0)),
  };
  const key = requestKey(
    job.purpose,
    `cloud:${cloud.id}`,
    { prompt: job.prompt, candidates: candidatesWanted, style: job.style },
    [image, holeMask],
  );

  const locked = await readLocked(context, key, image);
  if (locked) {
    return {
      ok: true,
      image: takeInside(image, locked.image, hole),
      key,
      by: locked.by,
      reused: true,
      warnings: [],
    };
  }
  if (!context.store.allowNew) {
    throw notLockedError(label, job.purpose === 'remove-text' ? '文字剥离' : '补全');
  }
  if ((await context.log.count(label.screen)) >= context.budget) {
    throw new UiProError(
      PerceptionErrorCodes.imageBudget,
      `界面 ${label.screen} 的云端图像模型调用已达到上限 ${context.budget} 次，不再继续调用`,
      {
        hint: '提高项目配置 budget.image_calls_per_screen，或改用本地模型出初稿（ui-pro build --draft）',
        details: { screen: label.screen, budget: context.budget },
      },
    );
  }

  const bounds = boundsOf(hole, width, height);
  if (!bounds) return { ok: false, key, warnings: [] };
  const plan = planCrop(bounds, { width, height }, cloud.capabilities);
  const warnings = [...plan.warnings];
  const [cx, cy, cw, ch] = plan.crop;
  const cropped = cropImage(image, plan.crop);
  const sentImage =
    plan.scale === 1
      ? cropped
      : await resizeImage(cropped, plan.sent.width, plan.sent.height, 'lanczos3');
  const croppedMask = cropMask(holeMask, plan.crop);
  const sentMask =
    plan.scale === 1
      ? croppedMask
      : await resizeMask(croppedMask, plan.sent.width, plan.sent.height, 'cubic');
  const holeSent = Uint8Array.from(sentMask.data, (value) => (value >= 128 ? 1 : 0));

  const imagePng = await encodeRgbPng(sentImage);
  const maskPng = await encodeMaskPng(sentMask);
  await context.log.append({
    at: new Date().toISOString(),
    model: cloud.id,
    purpose: job.purpose,
    screen: label.screen,
    node: label.node,
    sha256: [sha256Hex(imagePng), sha256Hex(maskPng)],
    bytes: imagePng.byteLength + maskPng.byteLength,
  });

  const returned = await cloud.inpaint({
    image: imagePng,
    mask: maskPng,
    prompt: job.prompt,
    candidates: candidatesWanted,
  });

  const accepted: Candidate[] = [];
  const reasons: string[] = [];
  for (const [index, bytes] of returned.entries()) {
    let candidate: RgbaImage;
    try {
      candidate = await decodeBytes(bytes);
    } catch {
      reasons.push(`候选 ${index + 1}：不是可读的图片`);
      continue;
    }
    if (candidate.width !== sentImage.width || candidate.height !== sentImage.height) {
      candidate = await resizeImage(candidate, sentImage.width, sentImage.height, 'lanczos3');
    }
    const reason = rejectionReason(sentImage, candidate, holeSent);
    if (reason) {
      reasons.push(`候选 ${index + 1}：${reason}`);
      continue;
    }
    accepted.push({ image: candidate, cost: candidateCost(sentImage, candidate, holeSent) });
  }
  if (accepted.length === 0) {
    warnings.push(
      `云端图像模型返回的 ${returned.length} 个候选全部被淘汰（${reasons.join('；')}），改用本地模型的结果`,
    );
    return { ok: false, key, warnings };
  }

  accepted.sort((a, b) => a.cost - b.cost);
  const compose = async (candidate: Candidate): Promise<RgbaImage> => {
    const back =
      plan.scale === 1 ? candidate.image : await resizeImage(candidate.image, cw, ch, 'lanczos3');
    const full = cloneImage(image);
    // Only the crop is known; put the candidate's pixels where the crop lies, then blend in the hole.
    for (let row = 0; row < ch; row++) {
      full.data.set(
        back.data.subarray(row * cw * 4, (row + 1) * cw * 4),
        ((cy + row) * width + cx) * 4,
      );
    }
    return blendIntoHole(image, full, hole, TRANSITION_PIXELS);
  };
  const [best, ...others] = accepted as [Candidate, ...Candidate[]];
  const result = await compose(best);
  const by = `cloud:${cloud.id}`;
  await context.store.put(
    { key, by, png: await encodePng(result) },
    await Promise.all(others.map(async (other) => encodePng(await compose(other)))),
  );
  if (reasons.length > 0) warnings.push(`云端候选中有被淘汰的：${reasons.join('；')}`);
  return { ok: true, image: result, key, by, reused: false, warnings };
}
