import { loadSession, OrtTensor } from '../models/session';
import { newImage, newMask, resizeImage, resizeMask } from './raster';
import { LAMA_SIZE, type ModelRunner, UPSCALE_SCALE, UPSCALE_TILE } from './runner';
import type { GrayMask, ModelName, ModelStore, RgbaImage } from './types';

/** anime-seg takes a square 1024x1024 input. */
const SEGMENT_SIZE = 1024;

function toChw(image: RgbaImage): Float32Array {
  const plane = image.width * image.height;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    out[i] = (image.data[i * 4] ?? 0) / 255;
    out[plane + i] = (image.data[i * 4 + 1] ?? 0) / 255;
    out[2 * plane + i] = (image.data[i * 4 + 2] ?? 0) / 255;
  }
  return out;
}

function fromChw(data: Float32Array, width: number, height: number, scale: number): RgbaImage {
  const plane = width * height;
  const out = newImage(width, height);
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value * scale)));
  for (let i = 0; i < plane; i++) {
    out.data[i * 4] = clamp(data[i] as number);
    out.data[i * 4 + 1] = clamp(data[plane + i] as number);
    out.data[i * 4 + 2] = clamp(data[2 * plane + i] as number);
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

/** The three local models over onnxruntime; model files come from the store (downloaded on first use). */
export function createOnnxRunner(
  models: ModelStore,
  onWarning?: (message: string) => void,
): ModelRunner {
  const session = async (name: ModelName) => loadSession(await models.path(name), { onWarning });

  return {
    async inpaint(image, mask) {
      if (image.width !== LAMA_SIZE || image.height !== LAMA_SIZE) {
        throw new Error(`LaMa 的输入必须是 ${LAMA_SIZE}x${LAMA_SIZE}`);
      }
      const lama = await session('lama');
      const maskData = new Float32Array(LAMA_SIZE * LAMA_SIZE);
      for (let i = 0; i < maskData.length; i++) maskData[i] = (mask.data[i] ?? 0) >= 128 ? 1 : 0;
      const outputs = await lama.run({
        image: new OrtTensor('float32', toChw(image), [1, 3, LAMA_SIZE, LAMA_SIZE]),
        mask: new OrtTensor('float32', maskData, [1, 1, LAMA_SIZE, LAMA_SIZE]),
      });
      const output = outputs.output?.data as Float32Array | undefined;
      if (!output) throw new Error('LaMa 没有返回结果');
      // The published ONNX graph returns 0-255; read it as 0-1 if a later export normalises it.
      let largest = 0;
      for (let i = 0; i < output.length; i += 97) largest = Math.max(largest, output[i] as number);
      return fromChw(output, LAMA_SIZE, LAMA_SIZE, largest > 2 ? 1 : 255);
    },

    async upscaleTile(tile) {
      if (tile.width !== UPSCALE_TILE || tile.height !== UPSCALE_TILE) {
        throw new Error(`超分的块必须是 ${UPSCALE_TILE}x${UPSCALE_TILE}`);
      }
      const net = await session('realesr-animevideov3');
      const outputs = await net.run({
        input: new OrtTensor('float32', toChw(tile), [1, 3, UPSCALE_TILE, UPSCALE_TILE]),
      });
      const output = outputs.output?.data as Float32Array | undefined;
      if (!output) throw new Error('超分模型没有返回结果');
      const size = UPSCALE_TILE * UPSCALE_SCALE;
      return fromChw(output, size, size, 255);
    },

    async segment(image) {
      const net = await session('anime-seg');
      const scale = SEGMENT_SIZE / Math.max(image.width, image.height);
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      const resized = await resizeImage(image, width, height, 'lanczos3');
      const left = Math.floor((SEGMENT_SIZE - width) / 2);
      const top = Math.floor((SEGMENT_SIZE - height) / 2);
      // Letterboxed in the middle, black around it, as the model's own demo does it.
      const plane = SEGMENT_SIZE * SEGMENT_SIZE;
      const input = new Float32Array(3 * plane);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const from = (y * width + x) * 4;
          const to = (top + y) * SEGMENT_SIZE + left + x;
          input[to] = (resized.data[from] ?? 0) / 255;
          input[plane + to] = (resized.data[from + 1] ?? 0) / 255;
          input[2 * plane + to] = (resized.data[from + 2] ?? 0) / 255;
        }
      }
      const outputs = await net.run({
        img: new OrtTensor('float32', input, [1, 3, SEGMENT_SIZE, SEGMENT_SIZE]),
      });
      const output = outputs.mask?.data as Float32Array | undefined;
      if (!output) throw new Error('抠取模型没有返回结果');
      const cropped = newMask(width, height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const value = output[(top + y) * SEGMENT_SIZE + left + x] as number;
          cropped.data[y * width + x] = Math.max(0, Math.min(255, Math.round(value * 255)));
        }
      }
      const mask: GrayMask = await resizeMask(cropped, image.width, image.height, 'cubic');
      return mask;
    },
  };
}
