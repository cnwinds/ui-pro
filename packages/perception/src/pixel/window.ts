import type { RgbaImage } from './types';

/**
 * Mean colour of the flagged pixels inside a square window around any pixel, in constant time
 * per query (summed-area tables). "Normalised convolution": unflagged pixels do not count.
 */
export class FlaggedWindows {
  readonly #stride: number;
  readonly #width: number;
  readonly #height: number;
  readonly #sums: Float64Array[];

  constructor(image: RgbaImage, flags: Uint8Array) {
    this.#width = image.width;
    this.#height = image.height;
    this.#stride = image.width + 1;
    const size = this.#stride * (image.height + 1);
    this.#sums = [0, 1, 2, 3].map(() => new Float64Array(size));
    for (let y = 0; y < image.height; y++) {
      const row = [0, 0, 0, 0];
      for (let x = 0; x < image.width; x++) {
        const at = y * image.width + x;
        const on = flags[at] ? 1 : 0;
        row[0] = (row[0] as number) + on * (image.data[at * 4] ?? 0);
        row[1] = (row[1] as number) + on * (image.data[at * 4 + 1] ?? 0);
        row[2] = (row[2] as number) + on * (image.data[at * 4 + 2] ?? 0);
        row[3] = (row[3] as number) + on;
        const target = (y + 1) * this.#stride + x + 1;
        const above = y * this.#stride + x + 1;
        for (let k = 0; k < 4; k++) {
          (this.#sums[k] as Float64Array)[target] =
            ((this.#sums[k] as Float64Array)[above] as number) + (row[k] as number);
        }
      }
    }
  }

  /** Mean colour and pixel count within `radius` pixels of (x, y), or null when none is flagged. */
  average(
    x: number,
    y: number,
    radius: number,
  ): { color: [number, number, number]; count: number } | null {
    const x0 = Math.max(0, x - radius);
    const y0 = Math.max(0, y - radius);
    const x1 = Math.min(this.#width, x + radius + 1);
    const y1 = Math.min(this.#height, y + radius + 1);
    const total = (k: number) => {
      const sums = this.#sums[k] as Float64Array;
      return (
        (sums[y1 * this.#stride + x1] as number) -
        (sums[y0 * this.#stride + x1] as number) -
        (sums[y1 * this.#stride + x0] as number) +
        (sums[y0 * this.#stride + x0] as number)
      );
    };
    const count = total(3);
    if (count < 0.5) return null;
    return { color: [total(0) / count, total(1) / count, total(2) / count], count };
  }

  /**
   * The mean over the smallest window, among `radii`, that holds at least `minCount` flagged
   * pixels: the nearest samples decide, the farther ones only fill in.
   */
  nearest(
    x: number,
    y: number,
    radii: readonly number[],
    minCount: number,
  ): [number, number, number] | null {
    let last: [number, number, number] | null = null;
    for (const radius of radii) {
      const found = this.average(x, y, radius);
      if (!found) continue;
      last = found.color;
      if (found.count >= minCount) return found.color;
    }
    return last;
  }
}
