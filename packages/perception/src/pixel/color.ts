export type Lab = [number, number, number];

const LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

const WHITE = [0.95047, 1, 1.08883] as const;
const EPSILON = 216 / 24389;
const KAPPA = 24389 / 27;

function pivot(t: number): number {
  return t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
}

/** CIE L*a*b* (D65) of an sRGB colour with 0-255 channels. */
export function rgbToLab(r: number, g: number, b: number): Lab {
  const lr = LINEAR[Math.max(0, Math.min(255, Math.round(r)))] as number;
  const lg = LINEAR[Math.max(0, Math.min(255, Math.round(g)))] as number;
  const lb = LINEAR[Math.max(0, Math.min(255, Math.round(b)))] as number;
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / WHITE[0];
  const y = (0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb) / WHITE[1];
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / WHITE[2];
  const fx = pivot(x);
  const fy = pivot(y);
  const fz = pivot(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 colour difference. */
export function deltaE(a: Lab, b: Lab): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

const hex = (value: number) =>
  Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, '0');

export function toHex(r: number, g: number, b: number): string {
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}
