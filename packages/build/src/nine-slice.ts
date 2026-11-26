import type { RgbaImage } from '@ui-pro/perception';
import {
  NINE_SLICE_KEEP,
  NINE_SLICE_MIN_BAND,
  NINE_SLICE_MIN_SSIM,
  NINE_SLICE_TOLERANCE,
} from './constants';
import { blankImage, ssim } from './raster';

/** `[left, top, right, bottom]` in texture pixels. */
export type SliceMargins = [number, number, number, number];

export interface NineSliceCut {
  margins: SliceMargins;
  /** The picture with its uniform bands cut down to a few pixels. */
  texture: RgbaImage;
  /** Structural similarity of the texture stretched back to the original size. */
  ssim: number;
  /** Which directions stretch: both for a nine-slice, one for a three-slice. */
  axes: 'both' | 'x' | 'y';
}

export type NineSliceOutcome = { ok: true; cut: NineSliceCut } | { ok: false; reason: string };

interface Band {
  start: number;
  /** Exclusive. */
  end: number;
}

/** Two numbers the way a message shows a similarity: truncated, so 0.949 never reads as 0.95. */
export function showRatio(value: number): string {
  return (Math.floor(value * 100) / 100).toFixed(2);
}

function pixelDiff(data: Uint8Array, a: number, b: number): number {
  const aa = data[a + 3] ?? 0;
  const ba = data[b + 3] ?? 0;
  if (aa === 0 && ba === 0) return 0;
  return Math.max(
    Math.abs((data[a] ?? 0) - (data[b] ?? 0)),
    Math.abs((data[a + 1] ?? 0) - (data[b + 1] ?? 0)),
    Math.abs((data[a + 2] ?? 0) - (data[b + 2] ?? 0)),
    Math.abs(aa - ba),
  );
}

function columnsAlike(image: RgbaImage, a: number, b: number): boolean {
  for (let y = 0; y < image.height; y++) {
    const row = y * image.width;
    if (pixelDiff(image.data, (row + a) * 4, (row + b) * 4) > NINE_SLICE_TOLERANCE) return false;
  }
  return true;
}

function rowsAlike(image: RgbaImage, a: number, b: number): boolean {
  for (let x = 0; x < image.width; x++) {
    if (
      pixelDiff(image.data, (a * image.width + x) * 4, (b * image.width + x) * 4) >
      NINE_SLICE_TOLERANCE
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The longest run of columns (or rows) that all look like the run's first one: stretching it
 * changes nothing. Runs narrower than `NINE_SLICE_MIN_BAND` are not worth cutting; of equal
 * runs the one nearest the middle wins.
 */
function findBand(image: RgbaImage, axis: 'x' | 'y'): Band | undefined {
  const size = axis === 'x' ? image.width : image.height;
  const alike = axis === 'x' ? columnsAlike : rowsAlike;
  let best: Band | undefined;
  const score = (band: Band) => band.end - band.start;
  const distance = (band: Band) => Math.abs((band.start + band.end) / 2 - size / 2);
  let start = 0;
  while (start < size) {
    let end = start + 1;
    while (end < size && alike(image, start, end)) end++;
    const band = { start, end };
    if (score(band) >= NINE_SLICE_MIN_BAND) {
      if (
        best === undefined ||
        score(band) > score(best) ||
        (score(band) === score(best) && distance(band) < distance(best))
      ) {
        best = band;
      }
    }
    start = end;
  }
  return best;
}

function axisMargins(
  size: number,
  band: Band | undefined,
): { margins: [number, number]; to: number } {
  if (band === undefined) return { margins: [0, 0], to: size };
  const keep = Math.min(band.end - band.start, NINE_SLICE_KEEP);
  return { margins: [band.start, size - band.end], to: band.start + keep + (size - band.end) };
}

/** Where texture pixel `t` comes from in the original, for a band cut down to `keep` pixels. */
function sourceIndex(t: number, band: Band | undefined, keep: number): number {
  if (band === undefined) return t;
  if (t < band.start + keep) return t;
  return band.end + (t - band.start - keep);
}

function cutTexture(
  image: RgbaImage,
  bandX: Band | undefined,
  bandY: Band | undefined,
): NineSliceCut {
  const x = axisMargins(image.width, bandX);
  const y = axisMargins(image.height, bandY);
  const keepX = bandX ? Math.min(bandX.end - bandX.start, NINE_SLICE_KEEP) : 0;
  const keepY = bandY ? Math.min(bandY.end - bandY.start, NINE_SLICE_KEEP) : 0;
  const texture = blankImage(x.to, y.to);
  for (let ty = 0; ty < texture.height; ty++) {
    const sy = sourceIndex(ty, bandY, keepY);
    for (let tx = 0; tx < texture.width; tx++) {
      const sx = sourceIndex(tx, bandX, keepX);
      const from = (sy * image.width + sx) * 4;
      texture.data.set(image.data.subarray(from, from + 4), (ty * texture.width + tx) * 4);
    }
  }
  const axes = bandX && bandY ? 'both' : bandX ? 'x' : 'y';
  return {
    margins: [x.margins[0], y.margins[0], x.margins[1], y.margins[1]],
    texture,
    ssim: 0,
    axes,
  };
}

function stretchIndex(position: number, from: number, to: number, size: number, target: number) {
  if (position < from) return position;
  if (position >= target - to) return size - (target - position);
  const middle = target - from - to;
  const source = size - from - to;
  return from + Math.min(source - 1, Math.floor(((position - from) * source) / middle));
}

/** What an engine's nine-patch does: corners stay, edges and middle stretch to the target size. */
export function stretchTexture(
  texture: RgbaImage,
  margins: SliceMargins,
  width: number,
  height: number,
): RgbaImage {
  const [left, top, right, bottom] = margins;
  const out = blankImage(width, height);
  for (let y = 0; y < height; y++) {
    const sy = stretchIndex(y, top, bottom, texture.height, height);
    for (let x = 0; x < width; x++) {
      const sx = stretchIndex(x, left, right, texture.width, width);
      const from = (sy * texture.width + sx) * 4;
      out.data.set(texture.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return out;
}

/**
 * Cuts `image` with margins that are already decided (a state's picture follows the margins of
 * the node's normal look, because the node has only one `nineSlice`). A margin pair of `0, 0` means
 * that direction does not stretch.
 */
export function cutWithMargins(image: RgbaImage, margins: SliceMargins): NineSliceOutcome {
  const [left, top, right, bottom] = margins;
  const bandX =
    left + right > 0 && left + right < image.width
      ? { start: left, end: image.width - right }
      : undefined;
  const bandY =
    top + bottom > 0 && top + bottom < image.height
      ? { start: top, end: image.height - bottom }
      : undefined;
  if (bandX === undefined && bandY === undefined) {
    return { ok: false, reason: '图片比沿用的九宫边距还小，按固定尺寸处理' };
  }
  const cut = cutTexture(image, bandX, bandY);
  const similarity = ssim(
    stretchTexture(cut.texture, cut.margins, image.width, image.height),
    image,
  );
  if (similarity >= NINE_SLICE_MIN_SSIM) return { ok: true, cut: { ...cut, ssim: similarity } };
  return {
    ok: false,
    reason: `按常态的九宫边距裁切后，拉伸回原尺寸的结构相似度 ${showRatio(similarity)}，低于 ${NINE_SLICE_MIN_SSIM.toFixed(2)}，按固定尺寸处理`,
  };
}

function mapAxis(value: number, from: number, to: number, size: number, cut: number): number {
  if (value <= from) return value;
  if (value >= size - to) return cut - (size - value);
  return from + ((value - from) * (cut - from - to)) / (size - from - to);
}

/**
 * A rectangle of the full-size picture, found in the cut texture: edges inside a collapsed band
 * land inside the kept pixels, everything else keeps its distance to the margins.
 */
export function mapThroughCut(
  [x, y, w, h]: [number, number, number, number],
  margins: SliceMargins,
  full: { width: number; height: number },
  texture: { width: number; height: number },
): [number, number, number, number] {
  const [left, top, right, bottom] = margins;
  const span = (
    start: number,
    size: number,
    lo: number,
    hi: number,
    whole: number,
    kept: number,
  ) => {
    const from = Math.min(kept - 1, Math.round(mapAxis(start, lo, hi, whole, kept)));
    const to = Math.round(mapAxis(start + size, lo, hi, whole, kept));
    // A rectangle inside a collapsed band still covers at least one kept pixel.
    return [Math.max(0, from), Math.max(1, to - from)] as const;
  };
  const [x0, width] = span(x, w, left, right, full.width, texture.width);
  const [y0, height] = span(y, h, top, bottom, full.height, texture.height);
  return [x0, y0, width, height];
}

/**
 * Cuts `image` down to the smallest texture an engine can stretch back to it (DESIGN §6.5
 * 九宫). `nine-slice` looks for a uniform band in both directions, `three-slice` only along the
 * longer side. The cut is used only when stretching it back to the original size gives a picture
 * structurally similar to the original; otherwise the reason comes back for an approximation.
 */
export function cutNineSlice(
  image: RgbaImage,
  mode: 'nine-slice' | 'three-slice',
): NineSliceOutcome {
  const wantX = mode === 'nine-slice' || image.width >= image.height;
  const wantY = mode === 'nine-slice' || image.width < image.height;
  const bandX = wantX ? findBand(image, 'x') : undefined;
  const bandY = wantY ? findBand(image, 'y') : undefined;
  if (bandX === undefined && bandY === undefined) {
    return {
      ok: false,
      reason: `没有找到至少 ${NINE_SLICE_MIN_BAND} 像素宽、内容均匀的中段，按固定尺寸处理`,
    };
  }
  const attempts: Array<[Band | undefined, Band | undefined]> = [];
  if (bandX && bandY) attempts.push([bandX, bandY]);
  if (bandX) attempts.push([bandX, undefined]);
  if (bandY) attempts.push([undefined, bandY]);
  let best = 0;
  for (const [x, y] of attempts) {
    const cut = cutTexture(image, x, y);
    const back = stretchTexture(cut.texture, cut.margins, image.width, image.height);
    const similarity = ssim(back, image);
    if (similarity >= NINE_SLICE_MIN_SSIM) return { ok: true, cut: { ...cut, ssim: similarity } };
    best = Math.max(best, similarity);
  }
  return {
    ok: false,
    reason: `九宫拉伸回原尺寸后结构相似度 ${showRatio(best)}，低于 ${NINE_SLICE_MIN_SSIM.toFixed(2)}，按固定尺寸处理`,
  };
}
