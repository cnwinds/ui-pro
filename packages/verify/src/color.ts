/** Colour differences, measured in CIE Lab (D65) the way people see them. */

const LINEAR = new Float64Array(256).map((_, value) => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

const WHITE_X = 0.95047;
const WHITE_Z = 1.08883;
const EPSILON = 216 / 24389;
const KAPPA = 24389 / 27;

const pivot = (t: number): number => (t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116);

/** sRGB (0–255) to CIE L*a*b*, D65 white. */
export function rgbToLab(
  r: number,
  g: number,
  b: number,
  out: Float64Array | number[] = [0, 0, 0],
): Float64Array | number[] {
  // Channels are looked up by whole level, so a fractional mean is rounded rather than read as 0.
  const lr = LINEAR[Math.round(r)] ?? 0;
  const lg = LINEAR[Math.round(g)] ?? 0;
  const lb = LINEAR[Math.round(b)] ?? 0;
  const x = pivot((0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / WHITE_X);
  const y = pivot(0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb);
  const z = pivot((0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / WHITE_Z);
  out[0] = 116 * y - 16;
  out[1] = 500 * (x - y);
  out[2] = 200 * (y - z);
  return out;
}

const RAD = Math.PI / 180;

/**
 * CIEDE2000 between two Lab colours (Sharma, Wu and Dalal's formulation). 1 is about the
 * smallest difference people notice side by side; the gates use this one, not ΔE76, because ΔE76
 * overstates differences between saturated colours, which game art is full of.
 */
export function deltaE2000(
  l1: number,
  a1: number,
  b1: number,
  l2: number,
  a2: number,
  b2: number,
): number {
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cMean7 = ((c1 + c2) / 2) ** 7;
  const g = 0.5 * (1 - Math.sqrt(cMean7 / (cMean7 + 25 ** 7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const h1p = c1p === 0 ? 0 : (Math.atan2(b1, a1p) / RAD + 360) % 360;
  const h2p = c2p === 0 ? 0 : (Math.atan2(b2, a2p) / RAD + 360) % 360;

  const dL = l2 - l1;
  const dC = c2p - c1p;
  let dh = 0;
  if (c1p * c2p !== 0) {
    dh = h2p - h1p;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(c1p * c2p) * Math.sin((dh * RAD) / 2);

  const lMean = (l1 + l2) / 2;
  const cMean = (c1p + c2p) / 2;
  let hMean = h1p + h2p;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hMean += h1p + h2p < 360 ? 360 : -360;
    hMean /= 2;
  }
  const t =
    1 -
    0.17 * Math.cos((hMean - 30) * RAD) +
    0.24 * Math.cos(2 * hMean * RAD) +
    0.32 * Math.cos((3 * hMean + 6) * RAD) -
    0.2 * Math.cos((4 * hMean - 63) * RAD);
  const dTheta = 30 * Math.exp(-(((hMean - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cMean ** 7 / (cMean ** 7 + 25 ** 7));
  const sl = 1 + (0.015 * (lMean - 50) ** 2) / Math.sqrt(20 + (lMean - 50) ** 2);
  const sc = 1 + 0.045 * cMean;
  const sh = 1 + 0.015 * cMean * t;
  const rt = -Math.sin(2 * dTheta * RAD) * rc;

  const lTerm = dL / sl;
  const cTerm = dC / sc;
  const hTerm = dH / sh;
  return Math.sqrt(lTerm * lTerm + cTerm * cTerm + hTerm * hTerm + rt * cTerm * hTerm);
}

const scratchA: number[] = [0, 0, 0];
const scratchB: number[] = [0, 0, 0];

/** ΔE2000 between two sRGB colours. */
export function deltaERgb(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number {
  if (r1 === r2 && g1 === g2 && b1 === b2) return 0;
  rgbToLab(r1, g1, b1, scratchA);
  rgbToLab(r2, g2, b2, scratchB);
  return deltaE2000(
    scratchA[0] ?? 0,
    scratchA[1] ?? 0,
    scratchA[2] ?? 0,
    scratchB[0] ?? 0,
    scratchB[1] ?? 0,
    scratchB[2] ?? 0,
  );
}
