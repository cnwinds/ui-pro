import type { CV } from '@techstark/opencv-js';
import type { RgbaImage } from './image';
import { loadOpenCv } from './opencv';

/** Owns the Mats (and other Emscripten objects) created during one computation. */
export class MatScope {
  readonly #items: { delete(): void }[] = [];

  add<T extends { delete(): void }>(item: T): T {
    this.#items.push(item);
    return item;
  }

  dispose(): void {
    for (const item of this.#items.splice(0).reverse()) item.delete();
  }
}

/** Runs `compute` with opencv and a scope whose Mats are all deleted afterwards. */
export async function withOpenCv<T>(compute: (cv: CV, scope: MatScope) => T): Promise<T> {
  const { cv } = await loadOpenCv();
  const scope = new MatScope();
  try {
    return compute(cv, scope);
  } finally {
    scope.dispose();
  }
}

/** An RGBA Mat holding a copy of the image. */
export function matFromImage(cv: CV, scope: MatScope, image: RgbaImage) {
  const mat = scope.add(new cv.Mat(image.height, image.width, cv.CV_8UC4));
  mat.data.set(image.data);
  return mat;
}
