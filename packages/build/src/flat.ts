import {
  type AssetHole,
  type AssetStep,
  type CandidatesDoc,
  type Project,
  type Rect,
  readFileIfExistsSync,
  resolveInside,
  type ScreenDoc,
  screenRelDir,
} from '@ui-pro/core';
import type { ArtStyle, GrayMask, RgbaImage } from '@ui-pro/perception';
import {
  CROP_MARGIN_MAX,
  CROP_MARGIN_MIN,
  CROP_MARGIN_RATIO,
  EXCLUSION_GROW,
  HOLE_GROW,
  MASK_ALPHA,
  STRIP_COVERED,
} from './constants';
import { type Finished, finishAsset } from './finish';
import type { BuiltAsset, TextMeasurement } from './model';
import type { PlannedAsset, PlannedHole } from './plan';
import {
  blankImage,
  blankMask,
  clampRect,
  cloneImage,
  cropImage,
  decodePng,
  expandRect,
  fillMaskRect,
  growMask,
  maskBounds,
  maskCount,
  nearestSources,
  type PixelRect,
  resizeImage,
} from './raster';
import type { PixelRunner } from './runner';

export interface FlatContext {
  project: Project;
  screen: string;
  doc: ScreenDoc;
  /** The reference image, in source pixels. */
  reference: RgbaImage;
  runner: PixelRunner;
  style: ArtStyle;
  evidence: CandidatesDoc | null;
  /** What text strips measured, for the text nodes that were stripped. */
  measurements: TextMeasurement[];
}

/** One node's element cut from the reference, alone on a transparent background. */
export interface Element {
  plan: PlannedAsset;
  /** The part of the reference worked on, in source pixels. */
  window: PixelRect;
  /** Window-sized: the element's colour and alpha. */
  image: RgbaImage;
  /** The reference inside the window, with everything else still on it. */
  backdrop: RgbaImage;
  steps: AssetStep[];
}

const EXCLUSION_ID = /^ex_[0-9]+$/;
const HALF_ALPHA = 128;

/** Design-pixel rectangle -> source pixels, rounded outwards so no edge pixel is lost. */
export function toSourceRect(rect: Rect, scale: number): PixelRect {
  const epsilon = 1e-6;
  const x0 = Math.floor(rect[0] / scale + epsilon);
  const y0 = Math.floor(rect[1] / scale + epsilon);
  const x1 = Math.ceil((rect[0] + rect[2]) / scale - epsilon);
  const y1 = Math.ceil((rect[1] + rect[3]) / scale - epsilon);
  return [x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)];
}

const toLocal = (rect: PixelRect, window: PixelRect): PixelRect => [
  rect[0] - window[0],
  rect[1] - window[1],
  rect[2],
  rect[3],
];

/** The analysis mask of the node's candidate, laid into a window-sized mask; none when absent. */
async function loadHint(
  ctx: FlatContext,
  plan: PlannedAsset,
  window: PixelRect,
): Promise<GrayMask | undefined> {
  const refs = new Set(ctx.doc.nodes[plan.node]?.evidence ?? []);
  const candidate = ctx.evidence?.candidates.find(
    (entry) => refs.has(entry.id) && entry.mask !== undefined && entry.source !== 'layer',
  );
  if (candidate?.mask === undefined) return undefined;
  const bytes = readFileIfExistsSync(
    resolveInside(ctx.project.root, `${screenRelDir(ctx.screen)}/evidence/${candidate.mask}`),
  );
  if (bytes === null) return undefined;
  const [bx, by, bw, bh] = candidate.bbox.map(Math.round) as PixelRect;
  if (bw < 1 || bh < 1) return undefined;
  const mask = await resizeImage(await decodePng(bytes), bw, bh, 'nearest');
  // A gray mask has no alpha to speak of: its brightness is the mask. A cut-out has alpha.
  let opaque = true;
  for (let i = 0; i < bw * bh; i++) {
    if ((mask.data[i * 4 + 3] ?? 255) !== 255) {
      opaque = false;
      break;
    }
  }
  const hint = blankMask(window[2], window[3]);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const tx = bx + x - window[0];
      const ty = by + y - window[1];
      if (tx < 0 || ty < 0 || tx >= hint.width || ty >= hint.height) continue;
      hint.data[ty * hint.width + tx] = mask.data[(y * bw + x) * 4 + (opaque ? 0 : 3)] ?? 0;
    }
  }
  return hint;
}

function emptyElement(plan: PlannedAsset, reason: string): Element {
  return {
    plan,
    window: [0, 0, 1, 1],
    image: blankImage(1, 1),
    backdrop: blankImage(1, 1),
    steps: [{ step: 'extract', method: 'none', detail: reason }],
  };
}

/**
 * DESIGN §6.5 抠取: the element of one node, from the reference at the source's own density.
 * A full-screen background is cut as it is; everything else goes through the pixel ops with some
 * margin around the node's box so the extraction sees what lies beneath.
 */
export async function extractElement(ctx: FlatContext, plan: PlannedAsset): Promise<Element> {
  const { reference, doc } = ctx;
  const box = clampRect(toSourceRect(plan.rect, doc.scale), reference.width, reference.height);
  if (box === undefined) return emptyElement(plan, '节点的矩形在源图之外，没有像素可取');

  if (plan.fullBleed) {
    const image = cropImage(reference, box);
    return {
      plan,
      window: box,
      image,
      backdrop: image,
      steps: [{ step: 'extract', method: 'crop', detail: '铺满全屏的背景，整块裁下，不抠取' }],
    };
  }

  const margin = Math.min(
    CROP_MARGIN_MAX,
    Math.max(CROP_MARGIN_MIN, Math.round(Math.max(box[2], box[3]) * CROP_MARGIN_RATIO)),
  );
  const window = clampRect(expandRect(box, margin), reference.width, reference.height) ?? box;
  const backdrop = cropImage(reference, window);
  const result = await ctx.runner.extract(plan.node, {
    image: backdrop,
    box: toLocal(box, window),
    hint: await loadHint(ctx, plan, window),
    subject: plan.subject,
  });
  if (result.image.width !== window[2] || result.image.height !== window[3]) {
    throw new Error(
      `抠取 #${plan.node} 返回了 ${result.image.width}x${result.image.height} 的图，应为 ${window[2]}x${window[3]}`,
    );
  }
  const image = cloneImage(result.image);
  for (let i = 0; i < window[2] * window[3]; i++) image.data[i * 4 + 3] = result.alpha.data[i] ?? 0;
  return {
    plan,
    window,
    image,
    backdrop,
    steps: [{ step: 'extract', method: result.method, generated: result.generated }],
  };
}

/** Marks in `into` the pixels of `occluder`'s element (grown) that lie over `overlap`. */
function paintOccluder(
  into: GrayMask,
  window: PixelRect,
  occluder: Element,
  overlap: PixelRect,
): PixelRect | undefined {
  const wide = clampRect(expandRect(overlap, 2 * HOLE_GROW), into.width, into.height);
  if (wide === undefined) return undefined;
  const sub = blankMask(wide[2], wide[3]);
  const dx = occluder.window[0] - window[0] - wide[0];
  const dy = occluder.window[1] - window[1] - wide[1];
  for (let y = 0; y < occluder.image.height; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= sub.height) continue;
    for (let x = 0; x < occluder.image.width; x++) {
      const tx = x + dx;
      if (tx < 0 || tx >= sub.width) continue;
      if ((occluder.image.data[(y * occluder.image.width + x) * 4 + 3] ?? 0) >= MASK_ALPHA) {
        sub.data[ty * sub.width + tx] = 255;
      }
    }
  }
  const grown = growMask(sub, HOLE_GROW);
  const area = clampRect(expandRect(overlap, HOLE_GROW), into.width, into.height);
  if (area === undefined) return undefined;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = -1;
  let maxY = -1;
  for (let y = area[1]; y < area[1] + area[3]; y++) {
    for (let x = area[0]; x < area[0] + area[2]; x++) {
      if ((grown.data[(y - wide[1]) * grown.width + (x - wide[0])] ?? 0) === 0) continue;
      into.data[y * into.width + x] = 255;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return maxX < 0 ? undefined : [minX, minY, maxX - minX + 1, maxY - minY + 1];
}

function coverage(mask: GrayMask, rect: PixelRect): number {
  let covered = 0;
  for (let y = rect[1]; y < rect[1] + rect[3]; y++) {
    for (let x = rect[0]; x < rect[0] + rect[2]; x++) {
      if ((mask.data[y * mask.width + x] ?? 0) !== 0) covered++;
    }
  }
  return covered / (rect[2] * rect[3]);
}

/** The element with the colour of the backdrop under its transparent pixels, for the fill model. */
function fillInput(image: RgbaImage, backdrop: RgbaImage, hole: GrayMask): RgbaImage {
  const out = cloneImage(image);
  for (let i = 0; i < image.width * image.height; i++) {
    if ((hole.data[i] ?? 0) !== 0) {
      out.data[i * 4 + 3] = 255;
    } else if ((image.data[i * 4 + 3] ?? 0) === 0) {
      for (let c = 0; c < 3; c++) out.data[i * 4 + c] = backdrop.data[i * 4 + c] ?? 0;
    }
  }
  return out;
}

const names = (ids: readonly string[]) => ids.map((id) => `#${id}`).join('、');

interface HoleRecord {
  node: string;
  handling: AssetHole['handling'];
  /** Window-local source pixels; none when it lies outside the window. */
  local?: PixelRect;
}

/**
 * DESIGN §6.5 补全与文字剥离, then 提升分辨率、九宫、整理 (`finishAsset`): what lies under the
 * nodes drawn above is filled where the plan says so, text above is stripped, and the result
 * becomes the asset's file.
 */
export async function buildFlatAsset(
  ctx: FlatContext,
  element: Element,
  elements: ReadonlyMap<string, Element>,
): Promise<BuiltAsset> {
  const { plan } = element;
  const { runner, doc } = ctx;
  const window = element.window;
  const [width, height] = [window[2], window[3]];
  const ownBox = clampRect(toLocal(toSourceRect(plan.rect, doc.scale), window), width, height) ?? [
    0,
    0,
    width,
    height,
  ];
  let image = cloneImage(element.image);
  const records: HoleRecord[] = [];
  const steps: AssetStep[] = [...element.steps];
  const fillMask = blankMask(width, height);
  const filled: PlannedHole[] = [];
  const stripped: PlannedHole[] = [];

  for (const hole of plan.holes) {
    const overlap = clampRect(toLocal(toSourceRect(hole.rect, doc.scale), window), width, height);
    if (hole.handling === 'kept') {
      records.push({ node: hole.node, handling: 'kept', local: overlap });
    } else if (hole.handling === 'stripped') {
      stripped.push(hole);
      records.push({ node: hole.node, handling: 'stripped', local: overlap });
    } else {
      filled.push(hole);
      const occluder = EXCLUSION_ID.test(hole.node) ? undefined : elements.get(hole.node);
      let bounds: PixelRect | undefined;
      if (overlap !== undefined) {
        if (occluder === undefined) {
          const grow = EXCLUSION_ID.test(hole.node) ? EXCLUSION_GROW : HOLE_GROW;
          const grown = clampRect(expandRect(overlap, grow), width, height) ?? overlap;
          fillMaskRect(fillMask, grown);
          bounds = grown;
        } else {
          bounds = paintOccluder(fillMask, window, occluder, overlap);
        }
      }
      records.push({ node: hole.node, handling: 'filled', local: bounds });
    }
  }

  const invented = maskCount(fillMask);
  const fillBounds = maskBounds(fillMask);
  let fillStep: AssetStep | undefined;
  if (fillBounds !== undefined) {
    const hole = fillMask;
    const result = await runner.fill(
      plan.node,
      filled.map((entry) => entry.node),
      {
        image: fillInput(image, element.backdrop, hole),
        hole,
        prompt: `补全被 ${names(filled.map((entry) => entry.node))} 遮住的部分，延续周围的颜色和纹理，不要画出新的图案`,
      },
    );
    // What the hole's alpha follows: the nearest pixel the element itself covers outside the hole.
    const known = new Uint8Array(width * height);
    for (let i = 0; i < known.length; i++) {
      known[i] = (hole.data[i] ?? 0) === 0 && (image.data[i * 4 + 3] ?? 0) >= HALF_ALPHA ? 1 : 0;
    }
    const sources = nearestSources(known, width, height);
    const next = cloneImage(image);
    for (let i = 0; i < known.length; i++) {
      if ((hole.data[i] ?? 0) === 0) continue;
      for (let c = 0; c < 3; c++) next.data[i * 4 + c] = result.image.data[i * 4 + c] ?? 0;
      // Inside the node's box the hole is part of the element; the grown rim outside it is not.
      const x = i % width;
      const y = Math.floor(i / width);
      const inside =
        x >= ownBox[0] && y >= ownBox[1] && x < ownBox[0] + ownBox[2] && y < ownBox[1] + ownBox[3];
      const source = sources[i] ?? -1;
      next.data[i * 4 + 3] = !inside
        ? (image.data[i * 4 + 3] ?? 0)
        : source < 0
          ? 255
          : (image.data[source * 4 + 3] ?? 0);
    }
    image = next;
    fillStep = {
      step: 'fill',
      method: result.method,
      generated: result.generated,
      detail: `补全 ${names(filled.map((entry) => entry.node))} 遮住的部分（${result.tier}）`,
    };
  }

  const stripSteps: Array<{ step: AssetStep; local: PixelRect }> = [];
  for (const hole of stripped) {
    const local = records.find((entry) => entry.node === hole.node)?.local;
    if (local === undefined || coverage(fillMask, local) >= STRIP_COVERED) continue;
    const result = await runner.stripText(plan.node, hole.node, { image, box: local });
    const next = cloneImage(result.image);
    for (let i = 0; i < width * height; i++) next.data[i * 4 + 3] = image.data[i * 4 + 3] ?? 0;
    image = next;
    ctx.measurements.push({
      node: hole.node,
      ownerArea: plan.rect[2] * plan.rect[3],
      measured: result.measured,
    });
    stripSteps.push({
      local,
      step: {
        step: 'text-strip',
        method: result.method,
        generated: result.generated,
        detail: `剥离 #${hole.node} 的文字（${result.tier}）`,
      },
    });
  }

  const finished: Finished = await finishAsset({
    plan,
    scale: doc.scale,
    style: ctx.style,
    image,
    origin: [window[0], window[1]],
    runner,
  });

  const holes: AssetHole[] = records.map((entry) => ({
    node: entry.node,
    handling: entry.handling,
    region: entry.local === undefined ? [0, 0, 0, 0] : finished.mapRegion(entry.local),
  }));
  if (fillStep !== undefined && fillBounds !== undefined) {
    steps.push({ ...fillStep, region: finished.mapRegion(fillBounds) });
  }
  for (const { step, local } of stripSteps)
    steps.push({ ...step, region: finished.mapRegion(local) });
  steps.push(...finished.steps);

  return {
    node: plan.node,
    plan,
    origin: finished.empty
      ? 'placeholder'
      : steps.some((step) => step.generated !== undefined)
        ? 'generated'
        : 'crop',
    image: finished.image,
    inset: finished.inset,
    nineSlice: finished.nineSlice,
    holes: finished.empty ? holes.map((hole) => ({ ...hole, region: [0, 0, 0, 0] })) : holes,
    steps,
    approximations: [...plan.approximations, ...finished.approximations],
    invented,
  };
}
