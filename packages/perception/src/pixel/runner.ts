import type { GrayMask, RgbaImage } from './types';

/**
 * The three local models behind plain pixel arrays. The ONNX implementation is `createOnnxRunner`;
 * tests replace it with deterministic fakes so the plumbing around the models is tested without them.
 */
export interface ModelRunner {
  /** LaMa. `image` and `mask` are 512x512 (mask 255 where to invent); returns the 512x512 result. */
  inpaint(image: RgbaImage, mask: GrayMask): Promise<RgbaImage>;
  /** Real-ESRGAN animevideov3. One 256x256 tile in, the 1024x1024 four-times enlargement out. */
  upscaleTile(tile: RgbaImage): Promise<RgbaImage>;
  /** anime-seg. Foreground probability (255 = figure) for an image of any size. */
  segment(image: RgbaImage): Promise<GrayMask>;
}

export const LAMA_SIZE = 512;
export const UPSCALE_TILE = 256;
export const UPSCALE_SCALE = 4;
