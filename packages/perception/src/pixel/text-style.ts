import type { PlaneFit } from './background';
import { deltaE, type Lab, median, rgbToLab, toHex } from './color';
import { components, depthInside, distanceToOn } from './mask';
import type { MeasuredTextStyle, RgbaImage } from './types';

/** Cap height (and digit height) as a share of the font size, typical for UI fonts. */
export const CAP_HEIGHT = 0.72;
/** Cluster centres closer than this (CIE76) are one colour. */
const MERGE_DELTA_E = 12;
/** A cluster whose pixels are on average shallower than this (pixels from the ink's edge) is a rim. */
const RIM_DEPTH = 1.4;
/** A colour that covers less than this share of the ink is noise. */
const MIN_CLUSTER_SHARE = 0.05;
const MAX_STROKE = 6;
const MAX_SHADOW_OFFSET = 6;
/** A stroke or shadow must explain its colour's pixels at least this well (Jaccard). */
const MIN_SHAPE_FIT = 0.3;
const SOLID_DEPTH = 2;
/** Transition width (pixels) above which a shadow is called blurred. */
const BLUR_FROM = 1.2;

interface Cluster {
  color: Lab;
  /** Median RGB of the cluster's pixels away from the glyph's outline. */
  rgb: [number, number, number];
  mask: Uint8Array;
  pixels: number;
  /** Sum of the depths of its pixels: interior colours score high, thin outlines low. */
  weight: number;
}

function kmeans(points: Lab[], k: number): Lab[] {
  const mean = [0, 1, 2].map(
    (axis) => points.reduce((sum, p) => sum + (p[axis] as number), 0) / points.length,
  ) as Lab;
  const first = points.reduce(
    (best, p) => (deltaE(p, mean) < deltaE(best, mean) ? p : best),
    points[0] as Lab,
  );
  const centers: Lab[] = [first];
  while (centers.length < k) {
    let far = points[0] as Lab;
    let farDistance = -1;
    for (const p of points) {
      const nearest = Math.min(...centers.map((c) => deltaE(p, c)));
      if (nearest > farDistance) {
        farDistance = nearest;
        far = p;
      }
    }
    centers.push(far);
  }
  for (let round = 0; round < 8; round++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (const p of points) {
      let best = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const [index, center] of centers.entries()) {
        const d = deltaE(p, center);
        if (d < bestDistance) {
          bestDistance = d;
          best = index;
        }
      }
      const sum = sums[best] as number[];
      sum[0] = (sum[0] as number) + p[0];
      sum[1] = (sum[1] as number) + p[1];
      sum[2] = (sum[2] as number) + p[2];
      sum[3] = (sum[3] as number) + 1;
    }
    sums.forEach((sum, index) => {
      if ((sum[3] as number) > 0) {
        centers[index] = [
          (sum[0] as number) / (sum[3] as number),
          (sum[1] as number) / (sum[3] as number),
          (sum[2] as number) / (sum[3] as number),
        ];
      }
    });
  }
  return centers;
}

function jaccard(a: Uint8Array, b: Uint8Array): number {
  let both = 0;
  let either = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] || b[i]) either++;
    if (a[i] && b[i]) both++;
  }
  return either === 0 ? 0 : both / either;
}

function shifted(
  flags: Uint8Array,
  width: number,
  height: number,
  dx: number,
  dy: number,
): Uint8Array {
  const out = new Uint8Array(flags.length);
  for (let y = 0; y < height; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= height) continue;
    for (let x = 0; x < width; x++) {
      const sx = x - dx;
      if (sx >= 0 && sx < width && flags[sy * width + sx]) out[y * width + x] = 1;
    }
  }
  return out;
}

function union(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < out.length; i++) out[i] = a[i] || b[i] ? 1 : 0;
  return out;
}

/** The ring thickness around `fill` that best matches `cluster`. */
function bestRing(cluster: Uint8Array, fill: Uint8Array, width: number, height: number) {
  const distance = distanceToOn(fill, width, height);
  let best = { score: 0, width: 1 };
  for (let ring = 1; ring <= MAX_STROKE; ring++) {
    const shape = new Uint8Array(fill.length);
    for (let i = 0; i < shape.length; i++)
      shape[i] = !fill[i] && (distance[i] as number) <= ring ? 1 : 0;
    const score = jaccard(cluster, shape);
    if (score > best.score) best = { score, width: ring };
  }
  return best;
}

/** The offset at which the shifted copy of `body` best explains `cluster` (what shows beyond `body`). */
function bestShadow(cluster: Uint8Array, body: Uint8Array, width: number, height: number) {
  let best = { score: 0, dx: 1, dy: 1 };
  for (let dy = -MAX_SHADOW_OFFSET; dy <= MAX_SHADOW_OFFSET; dy++) {
    for (let dx = -MAX_SHADOW_OFFSET; dx <= MAX_SHADOW_OFFSET; dx++) {
      if (dx === 0 && dy === 0) continue;
      const moved = shifted(body, width, height, dx, dy);
      for (let i = 0; i < moved.length; i++) if (body[i]) moved[i] = 0;
      const score = jaccard(cluster, moved);
      if (score > best.score) best = { score, dx, dy };
    }
  }
  return best;
}

/** Width over which the shadow fades out at its far edge, in pixels, from the colours around it. */
function shadowTransition(
  image: RgbaImage,
  shadow: Cluster,
  body: Uint8Array,
  offset: [number, number],
  plane: PlaneFit | null,
): number {
  if (!plane) return 0;
  const { width, height } = image;
  const shape = shifted(body, width, height, offset[0], offset[1]);
  const solid = union(shape, body);
  const distance = distanceToOn(solid, width, height);
  let mixed = 0;
  let edge = 0;
  for (let i = 0; i < solid.length; i++) {
    const d = distance[i] as number;
    if (solid[i] || d > 3) continue;
    if (d <= 1) edge++;
    const x = i % width;
    const y = Math.floor(i / width);
    const bg = plane.at(x, y);
    const full = deltaE(shadow.color, rgbToLab(bg[0], bg[1], bg[2]));
    if (full < 10) return 0;
    const here = deltaE(
      rgbToLab(image.data[i * 4] ?? 0, image.data[i * 4 + 1] ?? 0, image.data[i * 4 + 2] ?? 0),
      rgbToLab(bg[0], bg[1], bg[2]),
    );
    const share = here / full;
    if (share > 0.15 && share < 0.85) mixed++;
  }
  const transition = edge === 0 ? 0 : mixed / edge;
  return transition >= BLUR_FROM ? Math.round(transition * 10) / 10 : 0;
}

/**
 * Colour, size, outline and shadow of a text, from its glyph pixels (`ink`, flags over the image).
 * The colours present are clustered; the one that fills the glyphs' inside is the text colour, and
 * each other colour is tried as an outline (a ring around the fill) and as a shadow (a shifted
 * copy of the glyphs); whichever explains its pixels better is what it is.
 */
export function measureTextStyle(
  image: RgbaImage,
  ink: Uint8Array,
  plane: PlaneFit | null = null,
): MeasuredTextStyle {
  const { width, height } = image;
  const depth = depthInside(ink, width, height);
  const all: number[] = [];
  const solid: number[] = [];
  for (let i = 0; i < ink.length; i++) {
    if (!ink[i]) continue;
    all.push(i);
    if ((depth[i] as number) >= SOLID_DEPTH) solid.push(i);
  }
  const rgbAt = (i: number): [number, number, number] => [
    image.data[i * 4] ?? 0,
    image.data[i * 4 + 1] ?? 0,
    image.data[i * 4 + 2] ?? 0,
  ];
  if (all.length === 0) return { color: '#ffffff', size: 0 };
  const sample = solid.length >= 12 ? solid : all;

  const labs = sample.map((i) => rgbToLab(...rgbAt(i)));
  let centers = kmeans(labs, Math.min(3, labs.length));
  // Merge colours that are one colour (a gradient fill splits in two).
  for (let merged = true; merged && centers.length > 1; ) {
    merged = false;
    for (let a = 0; a < centers.length && !merged; a++) {
      for (let b = a + 1; b < centers.length && !merged; b++) {
        if (deltaE(centers[a] as Lab, centers[b] as Lab) < MERGE_DELTA_E) {
          const [first, second] = [centers[a] as Lab, centers[b] as Lab];
          centers = centers.filter((_, index) => index !== b);
          centers[a] = [
            (first[0] + second[0]) / 2,
            (first[1] + second[1]) / 2,
            (first[2] + second[2]) / 2,
          ];
          merged = true;
        }
      }
    }
  }
  const nearest = (lab: Lab) => {
    let best = 0;
    for (let c = 1; c < centers.length; c++) {
      if (deltaE(lab, centers[c] as Lab) < deltaE(lab, centers[best] as Lab)) best = c;
    }
    return best;
  };
  let clusters: Cluster[] = centers.map((color) => ({
    color,
    rgb: [0, 0, 0],
    mask: new Uint8Array(ink.length),
    pixels: 0,
    weight: 0,
  }));
  for (const i of all) {
    const cluster = clusters[nearest(rgbToLab(...rgbAt(i)))] as Cluster;
    cluster.mask[i] = 1;
    cluster.pixels++;
    cluster.weight += depth[i] as number;
  }
  clusters = clusters.filter((cluster) => cluster.pixels >= MIN_CLUSTER_SHARE * all.length);
  for (const cluster of clusters) {
    const inside = all.filter((i) => cluster.mask[i] && (depth[i] as number) >= SOLID_DEPTH);
    const take = inside.length > 0 ? inside : all.filter((i) => cluster.mask[i]);
    cluster.rgb = [0, 1, 2].map((channel) =>
      median(take.map((i) => rgbAt(i)[channel] as number)),
    ) as [number, number, number];
  }
  clusters.sort((a, b) => b.weight - a.weight);
  const fill = clusters[0] as Cluster;
  const measured: MeasuredTextStyle = { color: toHex(...fill.rgb), size: 0 };

  // A cluster that hugs the glyphs' outer edge, one pixel deep, is anti-aliasing (a blend of the
  // outline and the background), not a colour: its pixels go to the nearest real colour.
  const rims = clusters.slice(1).filter((cluster) => cluster.weight / cluster.pixels < RIM_DEPTH);
  clusters = clusters.filter((cluster) => !rims.includes(cluster));
  for (const rim of rims) {
    for (const i of all) {
      if (!rim.mask[i]) continue;
      const lab = rgbToLab(...rgbAt(i));
      const target = clusters.reduce((best, c) =>
        deltaE(lab, c.color) < deltaE(lab, best.color) ? c : best,
      );
      rim.mask[i] = 0;
      target.mask[i] = 1;
      target.pixels++;
    }
  }

  let body = fill.mask;
  const others = clusters.slice(1);
  let stroke: Cluster | undefined;
  let shadow: Cluster | undefined;
  let strokeWidth = 1;
  let shadowOffset: [number, number] = [1, 1];
  if (others.length === 1) {
    const only = others[0] as Cluster;
    const ring = bestRing(only.mask, fill.mask, width, height);
    const cast = bestShadow(only.mask, fill.mask, width, height);
    if (ring.score >= cast.score && ring.score >= MIN_SHAPE_FIT) {
      stroke = only;
      strokeWidth = ring.width;
    } else if (cast.score >= MIN_SHAPE_FIT) {
      shadow = only;
      shadowOffset = [cast.dx, cast.dy];
    }
  } else if (others.length >= 2) {
    const [a, b] = others as [Cluster, Cluster];
    const plans = [
      { stroke: a, shadow: b },
      { stroke: b, shadow: a },
    ].map((plan) => {
      const ring = bestRing(plan.stroke.mask, fill.mask, width, height);
      const cast = bestShadow(plan.shadow.mask, union(fill.mask, plan.stroke.mask), width, height);
      return { ...plan, ring, cast, total: ring.score + cast.score };
    });
    const best = plans.reduce((x, y) => (y.total > x.total ? y : x));
    if (best.ring.score >= MIN_SHAPE_FIT) {
      stroke = best.stroke;
      strokeWidth = best.ring.width;
    }
    if (best.cast.score >= MIN_SHAPE_FIT) {
      shadow = best.shadow;
      shadowOffset = [best.cast.dx, best.cast.dy];
    }
  }
  if (stroke) {
    measured.stroke = { color: toHex(...stroke.rgb), width: strokeWidth };
    body = union(body, stroke.mask);
  }
  if (shadow) {
    const blur = shadowTransition(image, shadow, body, shadowOffset, plane);
    measured.shadow = {
      color: toHex(...shadow.rgb),
      offset: shadowOffset,
      ...(blur > 0 ? { blur } : {}),
    };
  }

  // Size: the glyphs are mostly capitals and digits, whose height is `CAP_HEIGHT` of the font size.
  const heights = components(fill.mask, width, height)
    .map(({ box }) => box[3])
    .sort((a, b) => a - b);
  const glyph =
    heights.length > 0 ? (heights[Math.floor((heights.length - 1) * 0.75)] as number) : 0;
  measured.size = Math.round(glyph / CAP_HEIGHT);
  return measured;
}
