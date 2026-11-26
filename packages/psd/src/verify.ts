import { decodePng, type RgbaImage } from './image';
import type { StoredRender } from './render-store';
import type { RenderUnit } from './renderer';

/**
 * A pixel counts as different when some premultiplied channel (or alpha) of the recomposition
 * and of the composite differ by more than this, out of 255. Renderers round differently and
 * antialias text and edges slightly differently from Photoshop; the measured text and
 * group-shadow fixtures stay within 7.
 */
export const PIXEL_TOLERANCE = 8;

/**
 * A layer fails when more than this share of the pixels it is topmost on are different. A few
 * wrong edge pixels do not make a layer unusable, but a wrong fill, shadow or blend mode moves
 * a large part of its area.
 */
export const MAX_DIFF_RATIO = 0.005;

/** Different pixels that no layer covers, as a share of the canvas, before the check fails. */
export const MAX_UNEXPLAINED_RATIO = 0.001;

export interface LayerCheck {
  id: number;
  pass: boolean;
  /** Pixels this layer is the topmost visible one on. */
  area: number;
  diffPixels: number;
  /** `diffPixels / area`; 0 for a layer that covers nothing. */
  diffRatio: number;
  /** Largest premultiplied channel difference over the layer's pixels, 0 to 255. */
  maxDelta: number;
}

export interface Verification {
  /** One check per visible unit, bottom to top. */
  checks: LayerCheck[];
  /** Pixels of the composite that no layer covers but the recomposition does not reproduce. */
  unexplained: { pixels: number; ratio: number; maxDelta: number; pass: boolean };
}

export interface Recomposition {
  /** Premultiplied RGBA on a 0 to 255 scale. */
  premultiplied: Float32Array;
  /** Per pixel, the 1-based index into `units` of the topmost covering unit; 0 for none. */
  owner: Int32Array;
  units: readonly RenderUnit[];
}

/** Lays the visible units over each other, bottom to top, with normal blending. */
export async function recompose(
  width: number,
  height: number,
  units: readonly RenderUnit[],
  stored: ReadonlyMap<number, StoredRender>,
): Promise<Recomposition> {
  const premultiplied = new Float32Array(width * height * 4);
  const owner = new Int32Array(width * height);
  const visible = units.filter((unit) => unit.visible);
  for (const [index, unit] of visible.entries()) {
    const render = stored.get(unit.id);
    if (render === undefined || render.box === null || render.png === null) continue;
    const [left, top, w, h] = render.box;
    const image = await decodePng(render.png);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const from = (y * w + x) * 4;
        const alpha = image.data[from + 3] ?? 0;
        if (alpha === 0) continue;
        const pixel = (top + y) * width + left + x;
        const to = pixel * 4;
        const keep = 1 - alpha / 255;
        for (let channel = 0; channel < 3; channel++) {
          premultiplied[to + channel] =
            ((image.data[from + channel] ?? 0) * alpha) / 255 +
            (premultiplied[to + channel] ?? 0) * keep;
        }
        premultiplied[to + 3] = alpha + (premultiplied[to + 3] ?? 0) * keep;
        owner[pixel] = index + 1;
      }
    }
  }
  return { premultiplied, owner, units: visible };
}

/** The recomposition as a straight-alpha image, for use as the reference when the file has none. */
export function toImage(width: number, height: number, composition: Recomposition): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  const { premultiplied } = composition;
  for (let pixel = 0; pixel < width * height; pixel++) {
    const at = pixel * 4;
    const alpha = premultiplied[at + 3] ?? 0;
    if (alpha === 0) continue;
    for (let channel = 0; channel < 3; channel++) {
      data[at + channel] = Math.min(
        255,
        Math.round(((premultiplied[at + channel] ?? 0) * 255) / alpha),
      );
    }
    data[at + 3] = Math.round(alpha);
  }
  return { width, height, data };
}

/**
 * Compares the recomposition with the composite pixel by pixel. A difference is charged to the
 * topmost layer covering the pixel, so each layer is judged on the part of the picture it decides.
 */
export function verify(composite: RgbaImage, composition: Recomposition): Verification {
  const { premultiplied, owner, units } = composition;
  const pixels = composite.width * composite.height;
  const area = new Int32Array(units.length + 1);
  const diff = new Int32Array(units.length + 1);
  const max = new Float32Array(units.length + 1);
  for (let pixel = 0; pixel < pixels; pixel++) {
    const at = pixel * 4;
    const alpha = composite.data[at + 3] ?? 0;
    let delta = Math.abs((premultiplied[at + 3] ?? 0) - alpha);
    for (let channel = 0; channel < 3; channel++) {
      const expected = ((composite.data[at + channel] ?? 0) * alpha) / 255;
      delta = Math.max(delta, Math.abs((premultiplied[at + channel] ?? 0) - expected));
    }
    const index = owner[pixel] ?? 0;
    area[index] = (area[index] ?? 0) + 1;
    if (delta > (max[index] ?? 0)) max[index] = delta;
    if (delta > PIXEL_TOLERANCE) diff[index] = (diff[index] ?? 0) + 1;
  }

  const checks = units.map((unit, offset): LayerCheck => {
    const index = offset + 1;
    const covered = area[index] ?? 0;
    const different = diff[index] ?? 0;
    const ratio = covered === 0 ? 0 : different / covered;
    return {
      id: unit.id,
      pass: ratio <= MAX_DIFF_RATIO,
      area: covered,
      diffPixels: different,
      diffRatio: ratio,
      maxDelta: Math.round(max[index] ?? 0),
    };
  });
  const unexplainedPixels = diff[0] ?? 0;
  const unexplainedRatio = pixels === 0 ? 0 : unexplainedPixels / pixels;
  return {
    checks,
    unexplained: {
      pixels: unexplainedPixels,
      ratio: unexplainedRatio,
      maxDelta: Math.round(max[0] ?? 0),
      pass: unexplainedRatio <= MAX_UNEXPLAINED_RATIO,
    },
  };
}
