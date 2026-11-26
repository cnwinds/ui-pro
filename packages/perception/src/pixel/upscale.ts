import { UiProError } from '@ui-pro/core';
import { PerceptionErrorCodes } from '../errors';
import { COLOR_MAX_DELTA_E, ringColorDelta } from './cloud-checks';
import {
  localModelId,
  lockedByLocal,
  methodOfLock,
  notLockedError,
  readLocked,
  requestKey,
} from './lock';
import {
  alphaOf,
  bleedColors,
  cropImage,
  decodeBytes,
  encodePng,
  encodeRgbPng,
  extendMirrored,
  newImage,
  reflect,
  resizeImage,
  resizeMask,
  setAlpha,
  sha256Hex,
} from './raster';
import { type ModelRunner, UPSCALE_SCALE, UPSCALE_TILE } from './runner';
import { ssim } from './ssim';
import type {
  ArtStyle,
  CloudImageModel,
  PixelContext,
  RgbaImage,
  UpscaleRequest,
  UpscaleResult,
} from './types';

/** A result whose structural similarity to the input is below this is thrown out. */
export const FIDELITY_MIN = 0.9;
/** Up to this factor plain resampling is as good as a model. */
export const RESAMPLE_MAX_FACTOR = 1.25;
/** The model's tiles overlap by this many input pixels on each side and are blended there. */
const TILE_OVERLAP = 16;
/** Above this many input pixels the local model is not used (the tiles would take minutes). */
const MAX_LOCAL_PIXELS = 2_000_000;
const CLOUD_MAX_FACTOR = 4;

export interface UpscaleDeps {
  context: PixelContext;
  runner: ModelRunner;
  say: (message: string) => void;
}

const sizeFor = (image: RgbaImage, factor: number) => ({
  width: Math.max(1, Math.round(image.width * factor)),
  height: Math.max(1, Math.round(image.height * factor)),
});

/** Structural similarity between the input and the result shrunk back to the input's size. */
export async function fidelityOf(
  input: RgbaImage,
  result: RgbaImage,
  style: ArtStyle,
): Promise<number> {
  const back = await resizeImage(
    result,
    input.width,
    input.height,
    style === 'pixel' ? 'nearest' : 'lanczos3',
  );
  return ssim(input, back);
}

/** Plain resampling: nearest neighbour for pixel art, Lanczos otherwise. */
export function resample(image: RgbaImage, width: number, height: number, style: ArtStyle) {
  return resizeImage(image, width, height, style === 'pixel' ? 'nearest' : 'lanczos3');
}

function tileOrigins(length: number): number[] {
  const step = UPSCALE_TILE - 2 * TILE_OVERLAP;
  const origins: number[] = [];
  for (let start = 0; ; start += step) {
    if (start + UPSCALE_TILE >= length) {
      origins.push(Math.max(0, length - UPSCALE_TILE));
      break;
    }
    origins.push(start);
  }
  return origins;
}

/** The image enlarged four times by the model, tile by tile, with the tiles blended where they overlap. */
export async function upscaleByTiles(
  runner: ModelRunner,
  image: RgbaImage,
  progress?: (done: number, total: number) => void,
): Promise<RgbaImage> {
  const { width, height } = image;
  const outWidth = width * UPSCALE_SCALE;
  const outHeight = height * UPSCALE_SCALE;
  const sum = new Float32Array(outWidth * outHeight * 3);
  const weight = new Float32Array(outWidth * outHeight);
  const xs = tileOrigins(width);
  const ys = tileOrigins(height);
  const tileOut = UPSCALE_TILE * UPSCALE_SCALE;
  const ramp = TILE_OVERLAP * UPSCALE_SCALE;
  const edgeWeight = (index: number) =>
    Math.min(1, (index + 0.5) / ramp, (tileOut - index - 0.5) / ramp);
  const weights1d = Float32Array.from({ length: tileOut }, (_, index) => edgeWeight(index));
  let done = 0;
  for (const ty of ys) {
    for (const tx of xs) {
      const tile = newImage(UPSCALE_TILE, UPSCALE_TILE);
      for (let y = 0; y < UPSCALE_TILE; y++) {
        const sy = reflect(ty + y, height);
        for (let x = 0; x < UPSCALE_TILE; x++) {
          const from = (sy * width + reflect(tx + x, width)) * 4;
          tile.data.set(image.data.subarray(from, from + 4), (y * UPSCALE_TILE + x) * 4);
        }
      }
      const enlarged = await runner.upscaleTile(tile);
      for (let v = 0; v < tileOut; v++) {
        const oy = ty * UPSCALE_SCALE + v;
        if (oy >= outHeight) break;
        for (let u = 0; u < tileOut; u++) {
          const ox = tx * UPSCALE_SCALE + u;
          if (ox >= outWidth) break;
          const w = (weights1d[u] as number) * (weights1d[v] as number);
          const at = oy * outWidth + ox;
          const from = (v * tileOut + u) * 4;
          weight[at] = (weight[at] as number) + w;
          sum[at * 3] = (sum[at * 3] as number) + w * (enlarged.data[from] ?? 0);
          sum[at * 3 + 1] = (sum[at * 3 + 1] as number) + w * (enlarged.data[from + 1] ?? 0);
          sum[at * 3 + 2] = (sum[at * 3 + 2] as number) + w * (enlarged.data[from + 2] ?? 0);
        }
      }
      progress?.(++done, xs.length * ys.length);
    }
  }
  const out = newImage(outWidth, outHeight);
  for (let at = 0; at < outWidth * outHeight; at++) {
    const w = weight[at] as number;
    out.data[at * 4] = Math.round((sum[at * 3] as number) / w);
    out.data[at * 4 + 1] = Math.round((sum[at * 3 + 1] as number) / w);
    out.data[at * 4 + 2] = Math.round((sum[at * 3 + 2] as number) / w);
    out.data[at * 4 + 3] = 255;
  }
  return out;
}

/** Colour from the enlarged RGB, transparency from the input's own alpha enlarged separately. */
async function withOwnAlpha(
  input: RgbaImage,
  enlargedRgb: RgbaImage,
  width: number,
  height: number,
): Promise<RgbaImage> {
  const colors = await resizeImage(enlargedRgb, width, height, 'lanczos3');
  const alpha = await resizeMask(alphaOf(input), width, height, 'lanczos3');
  setAlpha(colors, alpha);
  return colors;
}

interface Tried {
  image: RgbaImage;
  fidelity: number;
}

/** The local model's result through the lock; the outcome of a rejected one is locked too. */
async function localUpscale(
  deps: UpscaleDeps,
  request: UpscaleRequest,
  lockKey?: string,
): Promise<{ image: RgbaImage; fidelity: number; by: string; key: string; warnings: string[] }> {
  const { context } = deps;
  const { image, style, label } = request;
  const target = sizeFor(image, request.factor);
  const key =
    lockKey ??
    requestKey(
      'upscale',
      localModelId('realesr-animevideov3'),
      { width: target.width, height: target.height },
      [image],
    );
  const locked = await readLocked(context, key, target);
  if (locked) {
    return {
      image: locked.image,
      fidelity: await fidelityOf(image, locked.image, style),
      by: locked.by,
      key,
      warnings: [],
    };
  }
  if (!context.store.allowNew) throw notLockedError(label, '提升分辨率');

  const warnings: string[] = [];
  let by = lockedByLocal('realesr-animevideov3');
  let result: Tried | null = null;
  if (image.width * image.height > MAX_LOCAL_PIXELS) {
    warnings.push('图太大，本地超分模型只处理不超过 200 万像素的图，改用重采样');
  } else {
    if (!(await context.models.has('realesr-animevideov3'))) {
      deps.say('提升分辨率：本地模型 realesr-animevideov3 还没有下载，先下载（约 2.5 MB）');
    }
    deps.say('提升分辨率：用本地模型 realesr-animevideov3 出初稿');
    const enlarged = await upscaleByTiles(deps.runner, bleedColors(image), (done, total) => {
      if (total > 1) deps.say(`提升分辨率：本地模型已处理 ${done} / ${total} 块`);
    });
    const candidate = await withOwnAlpha(image, enlarged, target.width, target.height);
    const fidelity = await fidelityOf(image, candidate, style);
    if (fidelity >= FIDELITY_MIN) result = { image: candidate, fidelity };
    else {
      warnings.push(
        `本地超分的结果与原图的结构相似度只有 ${fidelity.toFixed(3)}，低于 ${FIDELITY_MIN}，细节可能被改写，改用重采样`,
      );
    }
  }
  if (!result) {
    const plain = await resample(image, target.width, target.height, style);
    result = { image: plain, fidelity: await fidelityOf(image, plain, style) };
    by = 'local:resample';
  }
  await context.store.put({ key, by, png: await encodePng(result.image) });
  return { image: result.image, fidelity: result.fidelity, by, key, warnings };
}

type CloudUpscaleOutcome =
  | { ok: true; image: RgbaImage; fidelity: number; by: string; key: string; warnings: string[] }
  | { ok: false; key: string; warnings: string[] };

async function cloudUpscale(
  deps: UpscaleDeps,
  cloud: CloudImageModel,
  request: UpscaleRequest,
): Promise<CloudUpscaleOutcome> {
  const { context } = deps;
  const { image, style, label } = request;
  const target = sizeFor(image, request.factor);
  const key = requestKey(
    'upscale',
    `cloud:${cloud.id}`,
    { width: target.width, height: target.height },
    [image],
  );
  const locked = await readLocked(context, key, target);
  if (locked) {
    return {
      ok: true,
      image: locked.image,
      fidelity: await fidelityOf(image, locked.image, style),
      by: locked.by,
      key,
      warnings: [],
    };
  }
  if (!context.store.allowNew) throw notLockedError(label, '提升分辨率');
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
  const { minSide, maxSide } = cloud.capabilities;
  if (Math.max(image.width, image.height) > maxSide) {
    return {
      ok: false,
      key,
      warnings: [`图的一边超过云端接口的上限 ${maxSide} 像素，没有发送，改用本地模型`],
    };
  }

  const warnings: string[] = [];
  const padRight = Math.max(0, minSide - image.width);
  const padBottom = Math.max(0, minSide - image.height);
  const sent =
    padRight || padBottom
      ? await extendMirrored(image, { right: padRight, bottom: padBottom })
      : image;
  if (padRight || padBottom) {
    warnings.push(
      `图小于 ${minSide} 像素，已镜像外扩到 ${sent.width}x${sent.height} 后送出，取回后裁掉外扩`,
    );
  }
  const serviceFactor = Math.min(CLOUD_MAX_FACTOR, Math.ceil(request.factor));
  if (request.factor > CLOUD_MAX_FACTOR) {
    warnings.push(
      `倍数 ${request.factor.toFixed(2)} 超过云端接口的 ${CLOUD_MAX_FACTOR} 倍，超出的部分用重采样`,
    );
  }
  const png = await encodeRgbPng(sent);
  await context.log.append({
    at: new Date().toISOString(),
    model: cloud.id,
    purpose: 'upscale',
    screen: label.screen,
    node: label.node,
    sha256: [sha256Hex(png)],
    bytes: png.byteLength,
  });
  const returned = await decodeBytes(await cloud.upscale({ image: png, factor: serviceFactor }));
  const expected = { width: sent.width * serviceFactor, height: sent.height * serviceFactor };
  const full =
    returned.width === expected.width && returned.height === expected.height
      ? returned
      : await resizeImage(returned, expected.width, expected.height, 'lanczos3');
  const enlarged = cropImage(full, [
    0,
    0,
    image.width * serviceFactor,
    image.height * serviceFactor,
  ]);
  const candidate = await withOwnAlpha(image, enlarged, target.width, target.height);

  const fidelity = await fidelityOf(image, candidate, style);
  const back = await resizeImage(candidate, image.width, image.height, 'lanczos3');
  const opaque = Uint8Array.from({ length: image.width * image.height }, (_, i) =>
    (image.data[i * 4 + 3] ?? 0) >= 128 ? 1 : 0,
  );
  const delta = ringColorDelta(image, back, opaque);
  if (fidelity < FIDELITY_MIN || delta > COLOR_MAX_DELTA_E) {
    warnings.push(
      fidelity < FIDELITY_MIN
        ? `云端超分的结果与原图的结构相似度只有 ${fidelity.toFixed(3)}，低于 ${FIDELITY_MIN}，细节可能被改写，改用本地模型`
        : `云端超分的结果偏色（色差 ${delta.toFixed(1)}），改用本地模型`,
    );
    return { ok: false, key, warnings };
  }
  const by = `cloud:${cloud.id}`;
  await context.store.put({ key, by, png: await encodePng(candidate) });
  return { ok: true, image: candidate, fidelity, by, key, warnings };
}

/**
 * Enlarges by the simplest method that keeps the picture: resampling for small factors and pixel
 * art, the local model for a draft, the cloud model for a final when it is allowed. A model's
 * result must stay faithful to the input (structural similarity); else the tier below is used.
 */
export async function upscaleImage(
  deps: UpscaleDeps,
  request: UpscaleRequest,
): Promise<UpscaleResult> {
  const { context } = deps;
  const { image, factor, quality, style } = request;
  const target = sizeFor(image, factor);
  if (factor <= RESAMPLE_MAX_FACTOR || style === 'pixel') {
    const plain = await resample(image, target.width, target.height, style);
    return {
      image: plain,
      fidelity: await fidelityOf(image, plain, style),
      tier: 'resample',
      method: style === 'pixel' ? 'nearest' : 'lanczos',
      warnings: [],
    };
  }

  const warnings: string[] = [];
  let lockKey: string | undefined;
  if (quality === 'final' && context.cloud && context.egress !== 'local') {
    deps.say('提升分辨率：用云端图像模型出终稿');
    const outcome = await cloudUpscale(deps, context.cloud, request);
    warnings.push(...outcome.warnings);
    if (outcome.ok) {
      return {
        image: outcome.image,
        fidelity: outcome.fidelity,
        tier:
          outcome.by === 'local:resample'
            ? 'resample'
            : outcome.by.startsWith('cloud:')
              ? 'cloud'
              : 'local',
        method: outcome.by === 'local:resample' ? 'lanczos' : methodOfLock(outcome.by),
        generated: outcome.key,
        warnings,
      };
    }
    lockKey = outcome.key;
  }

  const local = await localUpscale(deps, request, lockKey);
  const resampled = local.by === 'local:resample';
  return {
    image: local.image,
    fidelity: local.fidelity,
    tier: resampled ? 'resample' : 'local',
    method: resampled ? 'lanczos' : methodOfLock(local.by),
    generated: local.key,
    warnings: [...warnings, ...local.warnings],
  };
}
