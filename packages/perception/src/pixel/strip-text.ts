import { backgroundPlane, findInk } from './extract';
import { DEFAULT_TEXT_STRIP_PROMPT, type FillDeps, fillHole } from './fill';
import { binarize, countOn, dilate, toMask } from './mask';
import { cloneImage } from './raster';
import { measureTextStyle } from './text-style';
import type { TextStripRequest, TextStripResult } from './types';

/** The area to fill is the glyph pixels grown by this many pixels (anti-aliasing, a faint halo). */
export const STRIP_GROW = 2;
/** Glyph pixels of a mask the caller gives are those at least this strong. */
const INK_THRESHOLD = 64;
/** Without measurable glyphs the font size is guessed from the box. */
const BOX_HEIGHT_SHARE = 0.8;

/**
 * Removes a text from the image and reports what it looked like. The glyph pixels (given, or
 * found inside the box) are measured, then grown by two pixels and filled like any other hole;
 * the cloud, when used, repaints through a mask so nothing outside the glyphs is touched.
 */
export async function stripText(
  deps: FillDeps,
  request: TextStripRequest,
): Promise<TextStripResult> {
  const { image, box } = request;
  const { width, height } = image;
  if (request.ink && (request.ink.width !== width || request.ink.height !== height)) {
    throw new Error('文字剥离：墨迹遮罩的尺寸必须与图相同');
  }
  const found = request.ink ? null : findInk(image, box);
  const ink = request.ink ? binarize(request.ink, INK_THRESHOLD) : (found?.ink as Uint8Array);
  if (countOn(ink) === 0) {
    return {
      image: cloneImage(image),
      measured: { color: '#ffffff', size: Math.round(box[3] * BOX_HEIGHT_SHARE) },
      tier: 'analytic',
      method: 'analytic',
      warnings: ['在文字框里没有找到文字像素，什么也没有剥离'],
    };
  }
  const plane = found?.plane ?? backgroundPlane(image, box);
  const measured = measureTextStyle(image, ink, plane);
  if (measured.size <= 0) measured.size = Math.round(box[3] * BOX_HEIGHT_SHARE);

  const hole = toMask(dilate(ink, width, height, STRIP_GROW), width, height);
  const filled = await fillHole(deps, {
    image,
    hole,
    prompt: request.prompt ?? DEFAULT_TEXT_STRIP_PROMPT,
    quality: request.quality,
    style: request.style,
    label: request.label,
    purpose: 'remove-text',
  });
  return {
    image: filled.image,
    measured,
    tier: filled.tier,
    method: filled.method,
    generated: filled.generated,
    warnings: filled.warnings,
  };
}
