import { createRequire } from 'node:module';
import type { CV } from '@techstark/opencv-js';

const require = createRequire(import.meta.url);

type Runtime = CV & { onRuntimeInitialized?: () => void };

let ready: Promise<{ cv: CV }> | undefined;

/**
 * The opencv.js runtime, shared with the OCR library. Resolves to a wrapper because the runtime
 * object is an Emscripten thenable: awaiting it directly, or returning it from an async
 * function, never settles.
 */
export function loadOpenCv(): Promise<{ cv: CV }> {
  ready ??= new Promise((resolve) => {
    const cv = require('@techstark/opencv-js') as Runtime;
    if (typeof cv.Mat === 'function') resolve({ cv });
    else cv.onRuntimeInitialized = () => resolve({ cv });
  });
  return ready;
}
