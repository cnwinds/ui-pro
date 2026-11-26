/** Structural similarity, after Wang et al. 2004, with a uniform window instead of a Gaussian. */

/** Half-width of the window: 3 gives the usual 7 x 7. */
const RADIUS = 3;
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

/** Mean over a (2r+1)^2 window, smaller at the edges, by running sums along rows then columns. */
function boxMean(source: Float32Array, width: number, height: number): Float32Array {
  const across = new Float32Array(source.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = 0; x < Math.min(RADIUS, width); x++) sum += source[row + x] ?? 0;
    for (let x = 0; x < width; x++) {
      const entering = x + RADIUS;
      const leaving = x - RADIUS - 1;
      if (entering < width) sum += source[row + entering] ?? 0;
      if (leaving >= 0) sum -= source[row + leaving] ?? 0;
      const count = Math.min(width - 1, x + RADIUS) - Math.max(0, x - RADIUS) + 1;
      across[row + x] = sum / count;
    }
  }
  const out = new Float32Array(source.length);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = 0; y < Math.min(RADIUS, height); y++) sum += across[y * width + x] ?? 0;
    for (let y = 0; y < height; y++) {
      const entering = y + RADIUS;
      const leaving = y - RADIUS - 1;
      if (entering < height) sum += across[entering * width + x] ?? 0;
      if (leaving >= 0) sum -= across[leaving * width + x] ?? 0;
      const count = Math.min(height - 1, y + RADIUS) - Math.max(0, y - RADIUS) + 1;
      out[y * width + x] = sum / count;
    }
  }
  return out;
}

/**
 * SSIM of every pixel of two grey images of the same size, 1 for identical windows. Windows are
 * 7 x 7, shrinking at the border. The mean of the map is the usual MSSIM.
 */
export function ssimMap(
  a: Float32Array,
  b: Float32Array,
  width: number,
  height: number,
): Float32Array {
  const muA = boxMean(a, width, height);
  const muB = boxMean(b, width, height);
  const product = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) product[i] = (a[i] ?? 0) * (a[i] ?? 0);
  const meanAA = boxMean(product, width, height);
  for (let i = 0; i < a.length; i++) product[i] = (b[i] ?? 0) * (b[i] ?? 0);
  const meanBB = boxMean(product, width, height);
  for (let i = 0; i < a.length; i++) product[i] = (a[i] ?? 0) * (b[i] ?? 0);
  const meanAB = boxMean(product, width, height);

  const map = new Float32Array(a.length);
  for (let i = 0; i < map.length; i++) {
    const ma = muA[i] ?? 0;
    const mb = muB[i] ?? 0;
    const varA = Math.max(0, (meanAA[i] ?? 0) - ma * ma);
    const varB = Math.max(0, (meanBB[i] ?? 0) - mb * mb);
    const cov = (meanAB[i] ?? 0) - ma * mb;
    map[i] =
      ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (varA + varB + C2));
  }
  return map;
}
