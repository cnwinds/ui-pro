import type { GrayMask, RgbaImage } from '@ui-pro/perception';
import sharp from 'sharp';

/** Integer rectangle `[x, y, w, h]` in pixels. */
export type PixelRect = [number, number, number, number];

export function blankImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

export function blankMask(width: number, height: number): GrayMask {
  return { width, height, data: new Uint8Array(width * height) };
}

export function cloneImage(image: RgbaImage): RgbaImage {
  return { width: image.width, height: image.height, data: image.data.slice() };
}

export function sameImage(a: RgbaImage, b: RgbaImage): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

/** Decodes any PNG into straight RGBA. */
export async function decodePng(bytes: Uint8Array): Promise<RgbaImage> {
  const { data, info } = await sharp(bytes)
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error(`PNG 解码得到 ${info.channels} 个通道，应为 4`);
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

/** Deterministic: the same pixels always give the same bytes with the same sharp version. */
export async function encodePng(image: RgbaImage): Promise<Uint8Array> {
  const buffer = await sharp(
    Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength),
    { raw: { width: image.width, height: image.height, channels: 4 } },
  )
    .png({ compressionLevel: 9 })
    .toBuffer();
  return new Uint8Array(buffer);
}

/** Resamples with a kernel that keeps edges; `nearest` for pixel art. */
export async function resizeImage(
  image: RgbaImage,
  width: number,
  height: number,
  kernel: 'lanczos3' | 'nearest' = 'lanczos3',
): Promise<RgbaImage> {
  if (image.width === width && image.height === height) return image;
  const { data, info } = await sharp(
    Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength),
    { raw: { width: image.width, height: image.height, channels: 4 } },
  )
    .resize(width, height, { fit: 'fill', kernel })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

export function clampRect(rect: PixelRect, width: number, height: number): PixelRect | undefined {
  const x = Math.max(0, rect[0]);
  const y = Math.max(0, rect[1]);
  const right = Math.min(width, rect[0] + rect[2]);
  const bottom = Math.min(height, rect[1] + rect[3]);
  return right > x && bottom > y ? [x, y, right - x, bottom - y] : undefined;
}

export function expandRect(rect: PixelRect, margin: number): PixelRect {
  return [rect[0] - margin, rect[1] - margin, rect[2] + 2 * margin, rect[3] + 2 * margin];
}

/** A copy of the part of `image` inside `rect`, which must lie within it. */
export function cropImage(image: RgbaImage, [x, y, w, h]: PixelRect): RgbaImage {
  const out = blankImage(w, h);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * image.width + x) * 4;
    out.data.set(image.data.subarray(from, from + w * 4), row * w * 4);
  }
  return out;
}

export function cropMask(mask: GrayMask, [x, y, w, h]: PixelRect): GrayMask {
  const out = blankMask(w, h);
  for (let row = 0; row < h; row++) {
    const from = (y + row) * mask.width + x;
    out.data.set(mask.data.subarray(from, from + w), row * w);
  }
  return out;
}

/** Draws `src` over `dst` at `(dx, dy)` with source-over blending; parts outside are dropped. */
export function pasteOver(dst: RgbaImage, src: RgbaImage, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = x + dx;
      if (tx < 0 || tx >= dst.width) continue;
      const from = (y * src.width + x) * 4;
      const to = (ty * dst.width + tx) * 4;
      const sa = (src.data[from + 3] ?? 0) / 255;
      if (sa === 0) continue;
      const da = (dst.data[to + 3] ?? 0) / 255;
      const outA = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) {
        const s = src.data[from + c] ?? 0;
        const d = dst.data[to + c] ?? 0;
        dst.data[to + c] = Math.round((s * sa + d * da * (1 - sa)) / outA);
      }
      dst.data[to + 3] = Math.round(outA * 255);
    }
  }
}

/** Bounding box of the pixels with alpha at or above `threshold`, or `undefined` when none. */
export function alphaExtent(image: RgbaImage, threshold = 1): PixelRect | undefined {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if ((image.data[(y * image.width + x) * 4 + 3] ?? 0) < threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? undefined : [minX, minY, maxX - minX + 1, maxY - minY + 1];
}

export function maskBounds(mask: GrayMask): PixelRect | undefined {
  let minX = mask.width;
  let minY = mask.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if ((mask.data[y * mask.width + x] ?? 0) === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? undefined : [minX, minY, maxX - minX + 1, maxY - minY + 1];
}

export function maskCount(mask: GrayMask): number {
  let count = 0;
  for (const value of mask.data) if (value !== 0) count++;
  return count;
}

/** A binary mask (255 or 0) of the alpha values at or above `threshold`. */
export function alphaMask(image: RgbaImage, threshold: number): GrayMask {
  const mask = blankMask(image.width, image.height);
  for (let i = 0; i < mask.data.length; i++) {
    mask.data[i] = (image.data[i * 4 + 3] ?? 0) >= threshold ? 255 : 0;
  }
  return mask;
}

/** Grows the non-zero area of `mask` by `radius` pixels in every direction (square element). */
export function growMask(mask: GrayMask, radius: number): GrayMask {
  const { width, height } = mask;
  const far = 1 << 24;
  const horizontal = blankMask(width, height);
  const left = new Int32Array(width);
  for (let y = 0; y < height; y++) {
    // Distance to the nearest set pixel on the left, then on the right.
    let last = -far;
    for (let x = 0; x < width; x++) {
      if ((mask.data[y * width + x] ?? 0) !== 0) last = x;
      left[x] = x - last;
    }
    last = far * 2;
    for (let x = width - 1; x >= 0; x--) {
      if ((mask.data[y * width + x] ?? 0) !== 0) last = x;
      if (Math.min(left[x] ?? far, last - x) <= radius) horizontal.data[y * width + x] = 255;
    }
  }
  const out = blankMask(width, height);
  const up = new Int32Array(height);
  for (let x = 0; x < width; x++) {
    let last = -far;
    for (let y = 0; y < height; y++) {
      if ((horizontal.data[y * width + x] ?? 0) !== 0) last = y;
      up[y] = y - last;
    }
    last = far * 2;
    for (let y = height - 1; y >= 0; y--) {
      if ((horizontal.data[y * width + x] ?? 0) !== 0) last = y;
      if (Math.min(up[y] ?? far, last - y) <= radius) out.data[y * width + x] = 255;
    }
  }
  return out;
}

/** Sets the pixels inside `rect` (clamped) in `mask`. */
export function fillMaskRect(mask: GrayMask, rect: PixelRect): void {
  const clamped = clampRect(rect, mask.width, mask.height);
  if (!clamped) return;
  for (let y = clamped[1]; y < clamped[1] + clamped[3]; y++) {
    mask.data.fill(255, y * mask.width + clamped[0], y * mask.width + clamped[0] + clamped[2]);
  }
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

/**
 * For every pixel, the index of the nearest pixel with `known` set (itself when it is set),
 * found by a breadth-first sweep; `-1` everywhere when nothing is known.
 */
export function nearestSources(known: Uint8Array, width: number, height: number): Int32Array {
  const source = new Int32Array(width * height).fill(-1);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < known.length; i++) {
    if ((known[i] ?? 0) === 0) continue;
    source[i] = i;
    queue[tail++] = i;
  }
  while (head < tail) {
    const at = queue[head++] ?? 0;
    const x = at % width;
    const y = (at - x) / width;
    const origin = source[at] ?? -1;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const next = ny * width + nx;
      if ((source[next] ?? 0) !== -1) continue;
      source[next] = origin;
      queue[tail++] = next;
    }
  }
  return source;
}

/**
 * Lets edge colour bleed `radius` pixels into the transparent area so scaling and filtering never
 * pull in dark fringes, and clears the colour of every pixel further out so the file is the same
 * whatever lay under the transparency.
 */
export function bleedEdges(image: RgbaImage, radius: number): RgbaImage {
  const { width, height } = image;
  const out = cloneImage(image);
  const reached = new Uint8Array(width * height);
  for (let i = 0; i < reached.length; i++) reached[i] = (image.data[i * 4 + 3] ?? 0) > 0 ? 1 : 0;
  for (let ring = 0; ring < radius; ring++) {
    const snapshot = reached.slice();
    const colours: Array<[number, number, number, number]> = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const at = y * width + x;
        if ((snapshot[at] ?? 0) !== 0) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (const [dx, dy] of NEIGHBOURS) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if ((snapshot[next] ?? 0) === 0) continue;
          r += out.data[next * 4] ?? 0;
          g += out.data[next * 4 + 1] ?? 0;
          b += out.data[next * 4 + 2] ?? 0;
          n++;
        }
        if (n > 0) colours.push([at, Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
      }
    }
    for (const [at, r, g, b] of colours) {
      out.data[at * 4] = r;
      out.data[at * 4 + 1] = g;
      out.data[at * 4 + 2] = b;
      reached[at] = 1;
    }
  }
  for (let i = 0; i < width * height; i++) {
    if ((out.data[i * 4 + 3] ?? 0) === 0 && (reached[i] ?? 0) === 0) {
      out.data[i * 4] = 0;
      out.data[i * 4 + 1] = 0;
      out.data[i * 4 + 2] = 0;
    }
  }
  return out;
}

const GRAY = 128;

/** Four planes (R, G, B over mid-gray, then alpha) as floats: what comparisons look at. */
function planes(image: RgbaImage): Float32Array[] {
  const count = image.width * image.height;
  const result = [0, 1, 2, 3].map(() => new Float32Array(count));
  for (let i = 0; i < count; i++) {
    const alpha = (image.data[i * 4 + 3] ?? 0) / 255;
    for (let c = 0; c < 3; c++) {
      const plane = result[c];
      if (plane) plane[i] = (image.data[i * 4 + c] ?? 0) * alpha + GRAY * (1 - alpha);
    }
    const alphaPlane = result[3];
    if (alphaPlane) alphaPlane[i] = alpha * 255;
  }
  return result;
}

const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

function planeSsim(a: Float32Array, b: Float32Array, width: number, height: number): number {
  const win = Math.min(8, width, height);
  const stride = Math.max(1, Math.floor(win / 2));
  let total = 0;
  let windows = 0;
  const last = (size: number) => Math.max(0, size - win);
  const starts = (size: number): number[] => {
    const list: number[] = [];
    for (let at = 0; at < last(size); at += stride) list.push(at);
    list.push(last(size));
    return list;
  };
  const ys = starts(height);
  const xs = starts(width);
  const n = win * win;
  for (const y0 of ys) {
    for (const x0 of xs) {
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      for (let y = y0; y < y0 + win; y++) {
        for (let x = x0; x < x0 + win; x++) {
          const va = a[y * width + x] ?? 0;
          const vb = b[y * width + x] ?? 0;
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
      }
      const ma = sa / n;
      const mb = sb / n;
      const va = saa / n - ma * ma;
      const vb = sbb / n - mb * mb;
      const cov = sab / n - ma * mb;
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      windows++;
    }
  }
  return windows === 0 ? 1 : total / windows;
}

/**
 * Structural similarity of two images of the same size, averaged over colour (composited on
 * mid-gray) and alpha; 1 for identical images.
 */
export function ssim(a: RgbaImage, b: RgbaImage): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `比较结构相似度需要同样大小的图：${a.width}x${a.height} 对 ${b.width}x${b.height}`,
    );
  }
  if (sameImage(a, b)) return 1;
  const pa = planes(a);
  const pb = planes(b);
  let sum = 0;
  for (let c = 0; c < 4; c++) {
    sum += planeSsim(pa[c] ?? new Float32Array(0), pb[c] ?? new Float32Array(0), a.width, a.height);
  }
  return sum / 4;
}

/** Mean absolute difference over the four planes, 0–255. */
export function meanDifference(a: RgbaImage, b: RgbaImage): number {
  if (a.width !== b.width || a.height !== b.height) return Number.POSITIVE_INFINITY;
  const pa = planes(a);
  const pb = planes(b);
  let sum = 0;
  for (let c = 0; c < 4; c++) {
    const x = pa[c];
    const y = pb[c];
    if (!x || !y) continue;
    for (let i = 0; i < x.length; i++) sum += Math.abs((x[i] ?? 0) - (y[i] ?? 0));
  }
  return sum / (4 * a.width * a.height);
}

function luminance(image: RgbaImage): Float32Array {
  const [r, g, b] = planes(image);
  const out = new Float32Array(image.width * image.height);
  for (let i = 0; i < out.length; i++) {
    out[i] = 0.299 * (r?.[i] ?? 0) + 0.587 * (g?.[i] ?? 0) + 0.114 * (b?.[i] ?? 0);
  }
  return out;
}

const HASH_COLUMNS = 9;
const HASH_ROWS = 8;

/** A 64-bit difference hash (16 hex digits): robust to scaling and small colour shifts. */
export function perceptualHash(image: RgbaImage): string {
  const light = luminance(image);
  const cell = new Float64Array(HASH_COLUMNS * HASH_ROWS);
  for (let cy = 0; cy < HASH_ROWS; cy++) {
    const y0 = Math.floor((cy * image.height) / HASH_ROWS);
    const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * image.height) / HASH_ROWS));
    for (let cx = 0; cx < HASH_COLUMNS; cx++) {
      const x0 = Math.floor((cx * image.width) / HASH_COLUMNS);
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * image.width) / HASH_COLUMNS));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < Math.min(y1, image.height); y++) {
        for (let x = x0; x < Math.min(x1, image.width); x++) {
          sum += light[y * image.width + x] ?? 0;
          n++;
        }
      }
      cell[cy * HASH_COLUMNS + cx] = n === 0 ? 0 : sum / n;
    }
  }
  let bits = '';
  for (let cy = 0; cy < HASH_ROWS; cy++) {
    for (let cx = 0; cx < HASH_COLUMNS - 1; cx++) {
      const left = cell[cy * HASH_COLUMNS + cx] ?? 0;
      const right = cell[cy * HASH_COLUMNS + cx + 1] ?? 0;
      bits += left > right + 0.5 ? '1' : '0';
    }
  }
  let hex = '';
  for (let at = 0; at < bits.length; at += 4)
    hex += Number.parseInt(bits.slice(at, at + 4), 2).toString(16);
  return hex;
}

/** Number of differing bits between two hashes of equal length. */
export function hashDistance(a: string, b: string): number {
  let distance = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    let diff = Number.parseInt(a[i] ?? '0', 16) ^ Number.parseInt(b[i] ?? '0', 16);
    while (diff !== 0) {
      distance += diff & 1;
      diff >>= 1;
    }
  }
  return distance;
}

/** Variance of the Laplacian of the luminance: the larger, the crisper the picture. */
export function sharpness(image: RgbaImage): number {
  if (image.width < 3 || image.height < 3) return 0;
  const light = luminance(image);
  const { width, height } = image;
  let sum = 0;
  let sumSquares = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const at = y * width + x;
      const value =
        4 * (light[at] ?? 0) -
        (light[at - 1] ?? 0) -
        (light[at + 1] ?? 0) -
        (light[at - width] ?? 0) -
        (light[at + width] ?? 0);
      sum += value;
      sumSquares += value * value;
      n++;
    }
  }
  const mean = sum / n;
  return sumSquares / n - mean * mean;
}

export function toHex(r: number, g: number, b: number): string {
  const part = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

export function parseHex(color: string): [number, number, number] | undefined {
  const match = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})(?:[0-9a-fA-F]{2})?$/.exec(
    color,
  );
  if (!match) return undefined;
  return [
    Number.parseInt(match[1] ?? '0', 16),
    Number.parseInt(match[2] ?? '0', 16),
    Number.parseInt(match[3] ?? '0', 16),
  ];
}
