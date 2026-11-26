import type { Rect } from '@ui-pro/core';
import { withOpenCv } from '../cv-scope';
import { edgeStrength } from '../ink';
import { fitPlane, type PlaneFit, ringAround, ringInside } from './background';
import { deltaE, rgbToLab } from './color';
import {
  binarize,
  boundsOf,
  components,
  countOn,
  depthInside,
  dilate,
  distanceToOn,
  fillHoles,
} from './mask';
import { cropImage, cropMask, newImage, newMask, pasteImage, pasteMask } from './raster';
import type { ModelRunner } from './runner';
import type { ExtractRequest, ExtractResult, GrayMask, RgbaImage } from './types';
import { FlaggedWindows } from './window';

/** Pixels within this distance of the foreground's outline are solved for a soft alpha. */
const BAND_UI = 3;
const BAND_TEXT = 1;
/** How much of the surroundings the work region keeps around the box, in pixels. */
const WORK_MARGIN = 32;
/** The ring of the request image that stands for the background, in pixels. */
const RING_WIDTH = 12;
/** Width of the rim just inside a text box that stands for what is behind the text, in pixels. */
const INNER_RIM = 2;
const MIN_RING_SAMPLES = 24;
/** Below this RGB distance between foreground and background, colour cannot tell them apart. */
const MIN_CONTRAST = 20;
/** A pixel farther than this from the line between foreground and background colour is neither. */
const PERPENDICULAR_LIMIT = 28;
const MIN_ELEMENT_DISTANCE = 6;
const MAX_ELEMENT_DISTANCE = 30;
const MIN_TEXT_DISTANCE = 10;
/** The contour of the foreground must agree with the box at least this much (IoU of boxes). */
const CONTOUR_BOX_AGREEMENT = 0.7;
/** A background plane whose residual is above this cannot be trusted to find text by colour. */
const COMPLEX_BACKGROUND_RMS = 12;
const GRABCUT_ITERATIONS = 5;
/** Model probabilities below and above these are pushed to 0 and 1. */
const SEGMENT_LOW = 0.08;
const SEGMENT_HIGH = 0.92;

export interface ExtractDeps {
  runner: ModelRunner;
  /** Called once with a Simplified Chinese message when a model is about to run. */
  say?: (message: string) => void;
}

function expand([x, y, w, h]: Rect, margin: number): Rect {
  return [x - margin, y - margin, w + 2 * margin, h + 2 * margin];
}

function clip([x, y, w, h]: Rect, width: number, height: number): Rect {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(width, Math.ceil(x + w));
  const bottom = Math.min(height, Math.ceil(y + h));
  return [left, top, Math.max(0, right - left), Math.max(0, bottom - top)];
}

function boxIou(a: Rect, b: Rect): number {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const shared = w * h;
  return shared / (a[2] * a[3] + b[2] * b[3] - shared);
}

/** Colour distance (CIE76) of every pixel of `region` to the background plane; 0 outside it. */
function distanceToBackground(image: RgbaImage, plane: PlaneFit, region: Rect): Float32Array {
  const out = new Float32Array(image.width * image.height);
  const [rx, ry, rw, rh] = region;
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      const at = y * image.width + x;
      const bg = plane.at(x, y);
      out[at] = deltaE(
        rgbToLab(image.data[at * 4] ?? 0, image.data[at * 4 + 1] ?? 0, image.data[at * 4 + 2] ?? 0),
        rgbToLab(bg[0], bg[1], bg[2]),
      );
    }
  }
  return out;
}

/** Otsu's threshold of the values inside `region`, in the units of the values. */
function otsu(
  values: Float32Array,
  width: number,
  region: Rect,
  bins = 200,
  maxValue = 100,
): number {
  const histogram = new Float64Array(bins);
  let total = 0;
  const [rx, ry, rw, rh] = region;
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      const bin = Math.min(bins - 1, Math.floor(((values[y * width + x] ?? 0) / maxValue) * bins));
      histogram[bin] = (histogram[bin] as number) + 1;
      total++;
    }
  }
  if (total === 0) return 0;
  let sumAll = 0;
  for (let i = 0; i < bins; i++) sumAll += i * (histogram[i] as number);
  let weightBelow = 0;
  let sumBelow = 0;
  let best = -1;
  let bestBin = 0;
  for (let i = 0; i < bins; i++) {
    weightBelow += histogram[i] as number;
    if (weightBelow === 0) continue;
    const weightAbove = total - weightBelow;
    if (weightAbove === 0) break;
    sumBelow += i * (histogram[i] as number);
    const meanBelow = sumBelow / weightBelow;
    const meanAbove = (sumAll - sumBelow) / weightAbove;
    const between = weightBelow * weightAbove * (meanBelow - meanAbove) ** 2;
    if (between > best) {
      best = between;
      bestBin = i;
    }
  }
  return ((bestBin + 1) / bins) * maxValue;
}

/** The background plane of a work image: the ring around the box, or the image border without one. */
export function backgroundPlane(image: RgbaImage, box: Rect): PlaneFit | null {
  let samples = ringAround(image, box, RING_WIDTH);
  if (countOn(samples) < MIN_RING_SAMPLES) {
    samples = new Uint8Array(image.width * image.height);
    for (let x = 0; x < image.width; x++) {
      samples[x] = 1;
      samples[(image.height - 1) * image.width + x] = 1;
    }
    for (let y = 0; y < image.height; y++) {
      samples[y * image.width] = 1;
      samples[y * image.width + image.width - 1] = 1;
    }
  }
  return fitPlane(image, samples, 8);
}

/** GrabCut inside `box`; everything outside the box is background. Null when it cannot run. */
function grabCut(image: RgbaImage, box: Rect): Promise<Uint8Array | null> {
  return withOpenCv((cv, scope) => {
    const rgba = scope.add(new cv.Mat(image.height, image.width, cv.CV_8UC4));
    rgba.data.set(image.data);
    const rgb = scope.add(new cv.Mat());
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    const mask = scope.add(new cv.Mat(image.height, image.width, cv.CV_8UC1, new cv.Scalar(0)));
    const background = scope.add(new cv.Mat());
    const foreground = scope.add(new cv.Mat());
    const [x, y, w, h] = clip(box, image.width, image.height);
    if (w < 3 || h < 3) return null;
    try {
      cv.grabCut(
        rgb,
        mask,
        new cv.Rect(x, y, w, h),
        background,
        foreground,
        GRABCUT_ITERATIONS,
        cv.GC_INIT_WITH_RECT,
      );
    } catch {
      return null;
    }
    const flags = new Uint8Array(image.width * image.height);
    for (let i = 0; i < flags.length; i++) {
      const value = mask.data[i];
      flags[i] = value === cv.GC_FGD || value === cv.GC_PR_FGD ? 1 : 0;
    }
    return flags;
  });
}

/** The largest connected foreground, holes filled when asked. */
function largestPart(flags: Uint8Array, width: number, height: number, fill: boolean): Uint8Array {
  const [largest] = components(flags, width, height);
  const out = new Uint8Array(flags.length);
  if (!largest) return out;
  for (const at of largest.pixels) out[at] = 1;
  return fill ? fillHoles(out, width, height) : out;
}

interface Foreground {
  core: Uint8Array;
  method: 'hint' | 'contour' | 'grabcut' | 'ink';
  plane: PlaneFit | null;
  warnings: string[];
}

/** Finds the element of `box` in a work image by colour distance, falling back to GrabCut. */
async function findElement(image: RgbaImage, box: Rect): Promise<Foreground> {
  const { width, height } = image;
  const plane = backgroundPlane(image, box);
  const region = clip(expand(box, 2), width, height);
  const warnings: string[] = [];
  let contour: Uint8Array | null = null;
  if (plane) {
    const distance = distanceToBackground(image, plane, region);
    const threshold = Math.min(
      MAX_ELEMENT_DISTANCE,
      Math.max(MIN_ELEMENT_DISTANCE, otsu(distance, width, region)),
    );
    const flags = new Uint8Array(width * height);
    for (let i = 0; i < flags.length; i++) flags[i] = (distance[i] as number) > threshold ? 1 : 0;
    const found = largestPart(flags, width, height, true);
    const bounds = boundsOf(found, width, height);
    if (bounds && boxIou(bounds, box) >= CONTOUR_BOX_AGREEMENT) contour = found;
    else if (bounds) warnings.push('轮廓与元素框对不上，改用 GrabCut 求前景');
  }
  if (contour) return { core: contour, method: 'contour', plane, warnings };
  const cut = await grabCut(image, box);
  if (cut) {
    const found = largestPart(cut, width, height, true);
    if (countOn(found) > 0) return { core: found, method: 'grabcut', plane, warnings };
  }
  warnings.push('GrabCut 没有求出前景，按元素框处理');
  const whole = new Uint8Array(width * height);
  const [x, y, w, h] = clip(box, width, height);
  for (let row = y; row < y + h; row++) whole.fill(1, row * width + x, row * width + x + w);
  return { core: whole, method: 'contour', plane, warnings };
}

/** Ink pixels on the outermost rows and columns of `region`, except where it is the image's edge. */
function inkOnRegionEdge(ink: Uint8Array, region: Rect, width: number, height: number): number {
  const [rx, ry, rw, rh] = region;
  let count = 0;
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      if (!ink[y * width + x]) continue;
      if (
        (x === rx && rx > 0) ||
        (x === rx + rw - 1 && rx + rw < width) ||
        (y === ry && ry > 0) ||
        (y === ry + rh - 1 && ry + rh < height)
      ) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Ink that runs into the edge of the search region is more than glyphs (the rim of a badge, the
 * frame around it): of such pieces only what lies within a pixel of the text box is kept.
 */
function trimStrays(ink: Uint8Array, region: Rect, box: Rect, width: number, height: number) {
  const [rx, ry, rw, rh] = region;
  const [tx, ty, tw, th] = clip(expand(box, 1), width, height);
  const onEdge = (x: number, y: number) =>
    (x === rx && rx > 0) ||
    (x === rx + rw - 1 && rx + rw < width) ||
    (y === ry && ry > 0) ||
    (y === ry + rh - 1 && ry + rh < height);
  for (const part of components(ink, width, height)) {
    if (!part.pixels.some((at) => onEdge(at % width, Math.floor(at / width)))) continue;
    for (const at of part.pixels) {
      const x = at % width;
      const y = Math.floor(at / width);
      if (x < tx || x >= tx + tw || y < ty || y >= ty + th) ink[at] = 0;
    }
  }
}

/** The pixels of `region` that differ from the background `plane` by more than the glyphs' threshold. */
function inkAgainst(image: RgbaImage, plane: PlaneFit, region: Rect): Uint8Array {
  const { width, height } = image;
  const ink = new Uint8Array(width * height);
  const [rx, ry, rw, rh] = region;
  const distance = distanceToBackground(image, plane, region);
  const threshold = Math.max(MIN_TEXT_DISTANCE, otsu(distance, width, region) * 0.6);
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      if ((distance[y * width + x] as number) > threshold) ink[y * width + x] = 1;
    }
  }
  return ink;
}

/**
 * Glyph pixels (fill, stroke, shadow) of the text inside `box`, as 0/1 flags over the image.
 * What is behind the text is read from the ring around the box, or, when the text sits on a badge
 * or a button only a few pixels larger than itself, from the rim inside the box: of the two, the
 * one whose glyphs stay inside the box's surroundings (a wrong background makes the whole badge
 * look like ink, reaching the edge of the search region) is used.
 */
export function findInk(image: RgbaImage, box: Rect): { ink: Uint8Array; plane: PlaneFit | null } {
  const { width, height } = image;
  const region = clip(expand(box, 3), width, height);
  const outer = backgroundPlane(image, expand(box, 3));
  const inner = fitPlane(image, ringInside(image, box, INNER_RIM), 8);
  const candidates = [outer, inner]
    .filter((plane): plane is PlaneFit => plane !== null && plane.rms <= COMPLEX_BACKGROUND_RMS)
    .map((plane) => {
      const found = inkAgainst(image, plane, region);
      return { plane, ink: found, edge: inkOnRegionEdge(found, region, width, height) };
    });
  if (candidates.length > 0) {
    // The ring around the box is preferred; the rim inside it only when it clearly does better.
    const best = candidates.reduce((chosen, candidate) =>
      candidate.edge < chosen.edge ? candidate : chosen,
    );
    trimStrays(best.ink, region, box, width, height);
    return { ink: best.ink, plane: best.plane };
  }
  const plane = outer;
  const ink = new Uint8Array(width * height);
  const [rx, ry, rw, rh] = region;
  // On a busy background colour alone cannot tell glyphs from it; take what has hard edges.
  const strength = edgeStrength({ data: image.data, width, height });
  const values = [] as number[];
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) values.push(strength[y * width + x] as number);
  }
  values.sort((a, b) => a - b);
  const peak = values[Math.floor(values.length * 0.95)] ?? 0;
  const threshold = Math.min(120, Math.max(26, Math.round(peak * 0.5)));
  const edges = new Uint8Array(width * height);
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      if ((strength[y * width + x] as number) >= threshold) edges[y * width + x] = 1;
    }
  }
  const grown = dilate(edges, width, height, 1);
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) ink[y * width + x] = grown[y * width + x] as number;
  }
  return { ink, plane };
}

interface SoftEdgeOptions {
  /** Width of the band around the outline whose pixels are solved, in pixels. */
  band: number;
  /** Alpha to keep as it is (a model's output) instead of solving it from colours. */
  givenAlpha?: GrayMask;
  /** Used where no background pixel is near enough to sample. */
  plane: PlaneFit | null;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const clamp255 = (value: number) => Math.max(0, Math.min(255, value));

/**
 * Turns a hard foreground (`core`) into an element with a soft edge. Around the outline,
 * every pixel is a mix of foreground F and background B: its alpha is where it lies on the line
 * from B to F, and the colour is un-mixed, F = (I - (1 - a) * B) / a, so no background colour is
 * left in the edge. B is read from the pixels outside the band and F from those inside, nearest first.
 */
export function solveSoftEdge(
  image: RgbaImage,
  core: Uint8Array,
  options: SoftEdgeOptions,
): { image: RgbaImage; alpha: GrayMask } {
  const { width, height } = image;
  const { band, givenAlpha, plane } = options;
  const depth = depthInside(core, width, height);
  const outside = distanceToOn(core, width, height);
  let maxDepth = 0;
  for (const value of depth) if (value > maxDepth) maxDepth = value;
  const coreDepth = Math.min(band, Math.max(0, Math.floor(maxDepth / 2)));
  const nearForeground = new Uint8Array(width * height);
  const nearBackground = new Uint8Array(width * height);
  const foregroundSum = [0, 0, 0];
  let foregroundCount = 0;
  for (let i = 0; i < nearForeground.length; i++) {
    if (core[i] && (depth[i] as number) > coreDepth) {
      nearForeground[i] = 1;
      foregroundSum[0] = (foregroundSum[0] as number) + (image.data[i * 4] ?? 0);
      foregroundSum[1] = (foregroundSum[1] as number) + (image.data[i * 4 + 1] ?? 0);
      foregroundSum[2] = (foregroundSum[2] as number) + (image.data[i * 4 + 2] ?? 0);
      foregroundCount++;
    } else if (!core[i] && (outside[i] as number) > band) {
      nearBackground[i] = 1;
    }
  }
  const globalForeground = foregroundSum.map((sum) => sum / Math.max(1, foregroundCount)) as [
    number,
    number,
    number,
  ];
  const foreground = new FlaggedWindows(image, nearForeground);
  const background = new FlaggedWindows(image, nearBackground);
  const radii = [2 * band + 2, 4 * band + 4, 8 * band + 8];

  const out = newImage(width, height);
  const alpha = newMask(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      const inside = core[at] === 1;
      const solid = inside && (depth[at] as number) > band;
      const far = !inside && (outside[at] as number) > band;
      const r = image.data[at * 4] ?? 0;
      const g = image.data[at * 4 + 1] ?? 0;
      const b = image.data[at * 4 + 2] ?? 0;
      if (givenAlpha) {
        const given = (givenAlpha.data[at] ?? 0) / 255;
        if (given <= 0 && far) continue;
      } else {
        if (solid) {
          out.data.set([r, g, b, 255], at * 4);
          alpha.data[at] = 255;
          continue;
        }
        if (far) continue;
      }
      const f = foreground.nearest(x, y, radii, 4) ?? globalForeground;
      const bg = background.nearest(x, y, radii, 4) ?? plane?.at(x, y) ?? null;
      let a: number;
      let color: [number, number, number] = [r, g, b];
      const signed = inside ? (depth[at] as number) - 0.5 : -((outside[at] as number) - 0.5);
      const geometric = clamp01(0.5 + signed / (2 * band));
      if (givenAlpha) a = (givenAlpha.data[at] ?? 0) / 255;
      else a = geometric;
      if (bg) {
        const fb: [number, number, number] = [f[0] - bg[0], f[1] - bg[1], f[2] - bg[2]];
        const length2 = fb[0] * fb[0] + fb[1] * fb[1] + fb[2] * fb[2];
        if (length2 >= MIN_CONTRAST * MIN_CONTRAST) {
          const ib: [number, number, number] = [r - bg[0], g - bg[1], b - bg[2]];
          const t = (ib[0] * fb[0] + ib[1] * fb[1] + ib[2] * fb[2]) / length2;
          const perpendicular = Math.hypot(ib[0] - t * fb[0], ib[1] - t * fb[1], ib[2] - t * fb[2]);
          if (perpendicular > PERPENDICULAR_LIMIT) {
            // Neither foreground nor background nor a mix: an outline or a highlight of the element.
            if (!givenAlpha) a = inside ? 1 : 0;
          } else {
            if (!givenAlpha) a = clamp01(t);
            if (a > 0.01 && a < 0.99) {
              const unmix = (value: number, back: number) => clamp255((value - (1 - a) * back) / a);
              const weight = clamp01(1 - a / 0.6);
              color = [
                unmix(r, bg[0]) * (1 - weight) + f[0] * weight,
                unmix(g, bg[1]) * (1 - weight) + f[1] * weight,
                unmix(b, bg[2]) * (1 - weight) + f[2] * weight,
              ];
            }
          }
        }
      }
      if (a < 0.01) color = f;
      out.data[at * 4] = Math.round(color[0]);
      out.data[at * 4 + 1] = Math.round(color[1]);
      out.data[at * 4 + 2] = Math.round(color[2]);
      const value = Math.round(clamp01(a) * 255);
      out.data[at * 4 + 3] = value;
      alpha.data[at] = value;
    }
  }
  return { image: out, alpha };
}

/** Hard edges for pixel art: alpha is 0 or 255 and the colours are left alone. */
function hardEdge(image: RgbaImage, core: Uint8Array): { image: RgbaImage; alpha: GrayMask } {
  const out = newImage(image.width, image.height);
  const alpha = newMask(image.width, image.height);
  for (let i = 0; i < core.length; i++) {
    if (!core[i]) continue;
    out.data.set(image.data.subarray(i * 4, i * 4 + 3), i * 4);
    out.data[i * 4 + 3] = 255;
    alpha.data[i] = 255;
  }
  return { image: out, alpha };
}

function stretchModelAlpha(probability: GrayMask): GrayMask {
  const out = newMask(probability.width, probability.height);
  for (let i = 0; i < out.data.length; i++) {
    const p = (probability.data[i] ?? 0) / 255;
    out.data[i] = Math.round(clamp01((p - SEGMENT_LOW) / (SEGMENT_HIGH - SEGMENT_LOW)) * 255);
  }
  return out;
}

/**
 * Extraction of one element: the hint (or a contour, or GrabCut; or the segmentation model for
 * figures; or the glyph ink for text) gives the outline, then the edge gets a soft alpha and
 * loses the background colour mixed into it.
 */
export async function extractElement(
  deps: ExtractDeps,
  request: ExtractRequest,
): Promise<ExtractResult> {
  const { image, box, hint, subject, style } = request;
  const warnings: string[] = [];
  const band = subject === 'text' ? BAND_TEXT : BAND_UI;
  const regionBox = clip(expand(box, WORK_MARGIN), image.width, image.height);
  const work = cropImage(image, regionBox);
  const localBox: Rect = [box[0] - regionBox[0], box[1] - regionBox[1], box[2], box[3]];
  const limit = clip(expand(localBox, band + 1), work.width, work.height);
  const limited = (flags: Uint8Array) => {
    const out = new Uint8Array(flags.length);
    for (let y = limit[1]; y < limit[1] + limit[3]; y++) {
      const from = y * work.width + limit[0];
      out.set(flags.subarray(from, from + limit[2]), from);
    }
    return out;
  };

  let core: Uint8Array;
  let method: ExtractResult['method'];
  let plane: PlaneFit | null = null;
  let givenAlpha: GrayMask | undefined;

  if (subject === 'figure') {
    deps.say?.('抠取角色：用本地模型 anime-seg 求遮罩');
    const probability = await deps.runner.segment(work);
    const soft = stretchModelAlpha(probability);
    const confined = limited(binarize(soft, 1));
    for (let i = 0; i < soft.data.length; i++) if (!confined[i]) soft.data[i] = 0;
    givenAlpha = soft;
    core = binarize(soft, 128);
    method = 'anime-seg';
    plane = backgroundPlane(work, localBox);
  } else if (hint) {
    core = limited(binarize(cropMask(hint, regionBox), 128));
    method = 'hint';
    plane = backgroundPlane(work, localBox);
  } else if (subject === 'text') {
    const found = findInk(work, localBox);
    core = limited(found.ink);
    method = 'ink';
    plane = found.plane;
  } else {
    const found = await findElement(work, localBox);
    core = limited(found.core);
    method = found.method;
    plane = found.plane;
    warnings.push(...found.warnings);
  }
  if (countOn(core) === 0) {
    warnings.push('没有抠出任何前景像素，资产会是空的');
  }

  const solved =
    style === 'pixel' && !givenAlpha
      ? hardEdge(work, core)
      : solveSoftEdge(work, core, { band, givenAlpha, plane });
  if (style === 'pixel' && givenAlpha) {
    for (let i = 0; i < solved.alpha.data.length; i++) {
      const hard = (solved.alpha.data[i] ?? 0) >= 128 ? 255 : 0;
      solved.alpha.data[i] = hard;
      solved.image.data[i * 4 + 3] = hard;
    }
  }

  const resultImage = newImage(image.width, image.height);
  const resultAlpha = newMask(image.width, image.height);
  pasteImage(resultImage, solved.image, regionBox[0], regionBox[1]);
  pasteMask(resultAlpha, solved.alpha, regionBox[0], regionBox[1]);
  return { image: resultImage, alpha: resultAlpha, method, warnings };
}
