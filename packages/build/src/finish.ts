import type { AssetStep, Rect } from '@ui-pro/core';
import type { ArtStyle, RgbaImage } from '@ui-pro/perception';
import { BLEED_RADIUS, TRIM_ALPHA, UPSCALE_MIN_FIDELITY } from './constants';
import type { Inset } from './model';
import {
  cutNineSlice,
  cutWithMargins,
  mapThroughCut,
  type NineSliceCut,
  type SliceMargins,
  showRatio,
} from './nine-slice';
import type { PlannedAsset } from './plan';
import {
  alphaExtent,
  blankImage,
  bleedEdges,
  cropImage,
  type PixelRect,
  resizeImage,
} from './raster';
import type { PixelRunner } from './runner';

export interface FinishInput {
  plan: PlannedAsset;
  /** The screen's scale: design pixels per source pixel. */
  scale: number;
  style: ArtStyle;
  /** The element's pixels in source pixels, after any fill and strip. */
  image: RgbaImage;
  /** Where `image`'s top-left corner lies in the source, in source pixels. */
  origin: [number, number];
  runner: PixelRunner;
  /** Cut with these nine-slice margins instead of looking for them (a state follows the normal look). */
  margins?: SliceMargins;
  /** What the tidy step says about where the pixels came from, when it is not a crop. */
  tidy?: { method: string; detail: string };
}

export interface Finished {
  /** The file's pixels. */
  image: RgbaImage;
  inset: Inset;
  nineSlice?: SliceMargins;
  /** upscale, nine-slice and tidy steps, in that order. */
  steps: AssetStep[];
  /** Each begins with the decision point it is about. */
  approximations: string[];
  /** A rectangle in `image`'s source pixels (as passed in), found in the file. */
  mapRegion(rect: PixelRect): Rect;
  /** Nothing of the element was left to draw: the file is one transparent pixel. */
  empty: boolean;
}

const round2 = (value: number): number => Math.round(value * 100) / 100 + 0;

/** Insets from the node's design rect to the design rect of the trimmed picture. */
function insetOf(rect: Rect, trimmed: PixelRect, origin: [number, number], scale: number): Inset {
  const x = (origin[0] + trimmed[0]) * scale;
  const y = (origin[1] + trimmed[1]) * scale;
  const w = trimmed[2] * scale;
  const h = trimmed[3] * scale;
  return [
    round2(x - rect[0]),
    round2(y - rect[1]),
    round2(rect[0] + rect[2] - (x + w)),
    round2(rect[1] + rect[3] - (y + h)),
  ];
}

const AXES: Record<NineSliceCut['axes'], string> = {
  both: '横纵向都拉伸',
  x: '只横向拉伸',
  y: '只纵向拉伸',
};

/**
 * DESIGN §6.5 提升分辨率、九宫、整理: trims the transparent margins (recording the insets),
 * brings the picture to the density the plan asks for, cuts a nine-slice texture when the plan
 * asks for one and the cut reproduces the picture, and lets the edge colour bleed outwards.
 */
export async function finishAsset(input: FinishInput): Promise<Finished> {
  const { plan, scale, image, origin, runner } = input;
  const steps: AssetStep[] = [];
  const approximations: string[] = [];

  const extent = alphaExtent(image, TRIM_ALPHA);
  if (extent === undefined) {
    return {
      image: blankImage(1, 1),
      inset: [0, 0, 0, 0],
      steps: [
        { step: 'tidy', method: 'empty', detail: '没有取到任何不透明的像素，留下 1 个透明像素' },
      ],
      approximations: [`extract：#${plan.node} 的区域里没有取到像素，资产是一个透明像素`],
      mapRegion: () => [0, 0, 0, 0],
      empty: true,
    };
  }
  const trimmed = cropImage(image, extent);
  const inset = insetOf(plan.rect, extent, origin, scale);

  let file = trimmed;
  if (plan.density === 'design' && Math.abs(scale - 1) > 1e-6) {
    const width = Math.max(1, Math.round(trimmed.width * scale));
    const height = Math.max(1, Math.round(trimmed.height * scale));
    if (scale > 1) {
      const result = await runner.upscale(plan.node, { image: trimmed, factor: scale });
      file = await resizeImage(
        result.image,
        width,
        height,
        input.style === 'pixel' ? 'nearest' : 'lanczos3',
      );
      steps.push({
        step: 'upscale',
        method: result.method,
        generated: result.generated,
        detail: `按 ${scale.toFixed(2)} 倍提升到设计密度（${result.tier}），缩回后与放大前的结构相似度 ${showRatio(result.fidelity)}`,
      });
      if (result.fidelity < UPSCALE_MIN_FIDELITY) {
        approximations.push(
          `scale.source：放大后缩回原尺寸与放大前的结构相似度 ${showRatio(result.fidelity)}，低于 ${UPSCALE_MIN_FIDELITY.toFixed(2)}，细节可能被改写`,
        );
      }
    } else {
      file = await resizeImage(
        trimmed,
        width,
        height,
        input.style === 'pixel' ? 'nearest' : 'lanczos3',
      );
      steps.push({
        step: 'upscale',
        method: 'resample',
        detail: `源文件比设计分辨率大，按 ${scale.toFixed(2)} 倍缩小到设计密度`,
      });
    }
  }

  let cut: NineSliceCut | undefined;
  if (plan.stretch !== 'fixed') {
    const outcome =
      input.margins === undefined
        ? cutNineSlice(file, plan.stretch)
        : cutWithMargins(file, input.margins);
    if (outcome.ok) {
      cut = outcome.cut;
      steps.push({
        step: 'nine-slice',
        method: 'uniform-band',
        detail: `边距 [${cut.margins.join(', ')}]，${AXES[cut.axes]}，拉伸回原尺寸后结构相似度 ${showRatio(cut.ssim)}`,
      });
      if (plan.stretch === 'nine-slice' && cut.axes !== 'both') {
        approximations.push(
          `stretch.mode：只找到${cut.axes === 'x' ? '横' : '纵'}向均匀的中段，按三宫（${AXES[cut.axes]}）处理`,
        );
      }
    } else {
      approximations.push(`stretch.mode：${outcome.reason}`);
    }
  }

  const texture = bleedEdges(cut?.texture ?? file, BLEED_RADIUS);
  const trimDetail = `裁掉透明边（${extent[2]}x${extent[3]} 的内容），边缘颜色外扩 ${BLEED_RADIUS} 像素防渗色`;
  steps.push({
    step: 'tidy',
    method: input.tidy?.method ?? 'trim-bleed',
    detail: input.tidy === undefined ? trimDetail : `${input.tidy.detail}；${trimDetail}`,
  });

  const mapRegion = (rect: PixelRect): Rect => {
    const x0 = Math.max(0, rect[0] - extent[0]);
    const y0 = Math.max(0, rect[1] - extent[1]);
    const x1 = Math.min(extent[2], rect[0] + rect[2] - extent[0]);
    const y1 = Math.min(extent[3], rect[1] + rect[3] - extent[1]);
    if (x1 <= x0 || y1 <= y0) return [0, 0, 0, 0];
    const fx = file.width / extent[2];
    const fy = file.height / extent[3];
    const inFile: [number, number, number, number] = [
      Math.floor(x0 * fx),
      Math.floor(y0 * fy),
      Math.max(1, Math.ceil(x1 * fx) - Math.floor(x0 * fx)),
      Math.max(1, Math.ceil(y1 * fy) - Math.floor(y0 * fy)),
    ];
    return cut === undefined ? inFile : mapThroughCut(inFile, cut.margins, file, cut.texture);
  };

  return {
    image: texture,
    inset,
    nineSlice: cut?.margins,
    steps,
    approximations,
    mapRegion,
    empty: false,
  };
}
