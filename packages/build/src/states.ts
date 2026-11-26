import type { RgbaImage } from '@ui-pro/perception';
import { DISABLED_ALPHA, HOVER_BRIGHTNESS, PRESSED_BRIGHTNESS } from './constants';

export interface DerivedState {
  image: RgbaImage;
  /** Goes into the asset step's `method`. */
  method: string;
  /** In Simplified Chinese. */
  detail: string;
}

function adjust(
  image: RgbaImage,
  pixel: (rgba: [number, number, number, number]) => void,
): RgbaImage {
  const data = image.data.slice();
  for (let i = 0; i < image.width * image.height; i++) {
    const rgba: [number, number, number, number] = [
      data[i * 4] ?? 0,
      data[i * 4 + 1] ?? 0,
      data[i * 4 + 2] ?? 0,
      data[i * 4 + 3] ?? 0,
    ];
    pixel(rgba);
    for (let c = 0; c < 4; c++)
      data[i * 4 + c] = Math.max(0, Math.min(255, Math.round(rgba[c] ?? 0)));
  }
  return { width: image.width, height: image.height, data };
}

function brightness(image: RgbaImage, factor: number): RgbaImage {
  return adjust(image, (rgba) => {
    rgba[0] *= factor;
    rgba[1] *= factor;
    rgba[2] *= factor;
  });
}

const PRESSED = new Set(['pressed', 'press', 'down', 'active']);

/**
 * The picture of a state that the artwork does not show, derived from the normal look
 * (`state.source: derive`): pressed is darker, hover slightly lighter, disabled gray and
 * translucent. Other states have no recipe: `undefined`.
 */
export function deriveState(state: string, normal: RgbaImage): DerivedState | undefined {
  if (PRESSED.has(state)) {
    return {
      image: brightness(normal, PRESSED_BRIGHTNESS),
      method: 'derive-darken',
      detail: `由常态压暗到 ${Math.round(PRESSED_BRIGHTNESS * 100)}% 推导`,
    };
  }
  if (state === 'hover') {
    return {
      image: brightness(normal, HOVER_BRIGHTNESS),
      method: 'derive-lighten',
      detail: `由常态提亮 ${Math.round((HOVER_BRIGHTNESS - 1) * 100)}% 推导`,
    };
  }
  if (state === 'disabled') {
    return {
      image: adjust(normal, (rgba) => {
        const light = 0.299 * rgba[0] + 0.587 * rgba[1] + 0.114 * rgba[2];
        rgba[0] = light;
        rgba[1] = light;
        rgba[2] = light;
        rgba[3] *= DISABLED_ALPHA;
      }),
      method: 'derive-desaturate',
      detail: `由常态去色、透明度降到 ${Math.round(DISABLED_ALPHA * 100)}% 推导`,
    };
  }
  return undefined;
}
