import { extractElement } from './extract';
import { fillHole } from './fill';
import { createOnnxRunner } from './onnx-runner';
import type { ModelRunner } from './runner';
import { stripText } from './strip-text';
import type { PixelContext, PixelOps } from './types';
import { upscaleImage } from './upscale';

export interface PixelOpsOptions {
  /** Replaces the ONNX models; tests pass deterministic fakes. */
  runner?: ModelRunner;
}

/** The pixel steps of the asset build, over local models and the optional cloud image model. */
export function createPixelOps(context: PixelContext, options: PixelOpsOptions = {}): PixelOps {
  const say = (message: string) => context.onProgress?.(message);
  const runner = options.runner ?? createOnnxRunner(context.models, say);
  const deps = { context, runner, say };
  return {
    extract: (request) => extractElement({ runner, say }, request),
    fill: (request) =>
      fillHole(deps, {
        image: request.image,
        hole: request.hole,
        prompt: request.prompt,
        quality: request.quality,
        style: request.style,
        label: request.label,
        purpose: 'inpaint',
      }),
    stripText: (request) => stripText(deps, request),
    upscale: (request) => upscaleImage(deps, request),
  };
}
