import type { Rect } from '@ui-pro/core';
import { area, clipToImage, intersectionArea } from './geometry';
import type { EdgeMap } from './ink';

/** One candidate to be compared: its box in source pixels and, for text, what it says. */
export interface SimilarityItem {
  bbox: Rect;
  text?: string;
}

export interface SimilarityOptions {
  /** Lowest correlation of two edge signatures that still counts as the same shape. */
  minSimilarity?: number;
}

const GRID = 24;
const MIN_SIDE = 10;
const MAX_SIZE_DRIFT = 0.18;
const MAX_TEXT_DRIFT = 0.35;
const BORDER_BAND = 0.12;
const INTERIOR_WEIGHT = 0.08;
const MIN_SIMILARITY = 0.72;
const MIN_EDGE_SCALE = 24;

interface Signature {
  values: Float32Array;
  weights: Float32Array;
}

function sample(map: EdgeMap, x: number, y: number): number {
  const left = Math.min(map.width - 1, Math.max(0, Math.floor(x)));
  const top = Math.min(map.height - 1, Math.max(0, Math.floor(y)));
  const right = Math.min(map.width - 1, left + 1);
  const bottom = Math.min(map.height - 1, top + 1);
  const fx = x - Math.floor(x);
  const fy = y - Math.floor(y);
  const at = (px: number, py: number) => map.strength[py * map.width + px] ?? 0;
  return (
    at(left, top) * (1 - fx) * (1 - fy) +
    at(right, top) * fx * (1 - fy) +
    at(left, bottom) * (1 - fx) * fy +
    at(right, bottom) * fx * fy
  );
}

/**
 * The shape of an element as a coarse grid of edge strength. Edges, not colours, so that the same
 * frame in purple and in green looks alike; normalised, so that bright and dim copies do too.
 * The outline counts for more than the inside: the contents of one frame differ from the next.
 */
function signatureOf(map: EdgeMap, bbox: Rect): Signature | null {
  const [left, top, width, height] = clipToImage(bbox, map.width, map.height);
  if (Math.min(width, height) < MIN_SIDE) return null;
  const values = new Float32Array(GRID * GRID);
  const weights = new Float32Array(GRID * GRID);
  const cellW = width / GRID;
  const cellH = height / GRID;
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      let sum = 0;
      for (const oy of [0.25, 0.75]) {
        for (const ox of [0.25, 0.75]) {
          sum += sample(map, left + (gx + ox) * cellW, top + (gy + oy) * cellH);
        }
      }
      values[gy * GRID + gx] = sum / 4;
      const inset = Math.min(gx, gy, GRID - 1 - gx, GRID - 1 - gy) / GRID;
      weights[gy * GRID + gx] = inset < BORDER_BAND ? 1 : INTERIOR_WEIGHT;
    }
  }
  const sorted = [...values].sort((a, b) => a - b);
  const scale = Math.max(MIN_EDGE_SCALE, sorted[Math.floor(sorted.length * 0.95)] ?? 0);
  for (let index = 0; index < values.length; index++) {
    values[index] = Math.min(1, (values[index] ?? 0) / scale);
  }
  return { values, weights };
}

/** Weighted normalised cross-correlation of two signatures. */
function correlation(a: Signature, b: Signature): number {
  let total = 0;
  let meanA = 0;
  let meanB = 0;
  for (let index = 0; index < a.values.length; index++) {
    const weight = Math.min(a.weights[index] ?? 0, b.weights[index] ?? 0);
    total += weight;
    meanA += weight * (a.values[index] ?? 0);
    meanB += weight * (b.values[index] ?? 0);
  }
  meanA /= total;
  meanB /= total;
  let cross = 0;
  let varA = 0;
  let varB = 0;
  for (let index = 0; index < a.values.length; index++) {
    const weight = Math.min(a.weights[index] ?? 0, b.weights[index] ?? 0);
    const da = (a.values[index] ?? 0) - meanA;
    const db = (b.values[index] ?? 0) - meanB;
    cross += weight * da * db;
    varA += weight * da * da;
    varB += weight * db * db;
  }
  const norm = Math.sqrt(varA * varB);
  return norm < 1e-9 ? 0 : cross / norm;
}

const MAX_OVERLAP = 0.3;

function apart(a: Rect, b: Rect): boolean {
  return intersectionArea(a, b) <= MAX_OVERLAP * Math.min(area(a), area(b));
}

function similarSize(a: Rect, b: Rect, drift = MAX_SIZE_DRIFT): boolean {
  const close = (x: number, y: number) => Math.abs(x - y) <= drift * Math.max(x, y);
  return close(a[2], b[2]) && close(a[3], b[3]);
}

const SHIFTS = [-1, 0, 1];
const SHIFT_SHARE = 0.04;

const PROFILE_BINS = 14;
const PROFILE_SPAN = 0.28;
const PROFILE_PENALTY = 0.08;
const MIN_PROFILE_SIDE = 40;

/**
 * Edge strength as a function of the distance from the box's border (in shares of its short
 * side), averaged around the whole outline. Frames whose contents differ and whose box is a few
 * pixels off still share this profile: the same outline, border band and inner rim.
 */
function outlineProfile(map: EdgeMap, bbox: Rect): number[] | null {
  const [left, top, width, height] = clipToImage(bbox, map.width, map.height);
  const side = Math.min(width, height);
  if (side < MIN_SIDE) return null;
  const sums = new Array<number>(PROFILE_BINS).fill(0);
  const counts = new Array<number>(PROFILE_BINS).fill(0);
  for (let y = top; y < top + height; y++) {
    for (let x = left; x < left + width; x++) {
      const inset = Math.min(x - left, left + width - 1 - x, y - top, top + height - 1 - y) / side;
      const bin = Math.floor((inset / PROFILE_SPAN) * PROFILE_BINS);
      if (bin < 0 || bin >= PROFILE_BINS) continue;
      sums[bin] = (sums[bin] ?? 0) + (map.strength[y * map.width + x] ?? 0);
      counts[bin] = (counts[bin] ?? 0) + 1;
    }
  }
  return sums.map((sum, index) => ((counts[index] ?? 0) > 0 ? sum / (counts[index] ?? 1) : 0));
}

function profileCorrelation(a: readonly number[], b: readonly number[]): number {
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
  let cross = 0;
  let varA = 0;
  let varB = 0;
  for (let index = 0; index < a.length; index++) {
    const da = (a[index] ?? 0) - meanA;
    const db = (b[index] ?? 0) - meanB;
    cross += da * db;
    varA += da * da;
    varB += db * db;
  }
  const norm = Math.sqrt(varA * varB);
  return norm < 1e-9 ? 0 : cross / norm;
}

interface Looks {
  grid: Signature | null;
  profile: number[] | null;
}

/** Computes each box's signatures once, however many comparisons need them. */
class LookCache {
  private readonly map: EdgeMap;
  private readonly looks = new Map<string, Looks>();

  constructor(map: EdgeMap) {
    this.map = map;
  }

  of(bbox: Rect): Looks {
    const key = bbox.join(',');
    let looks = this.looks.get(key);
    if (!looks) {
      looks = {
        grid: signatureOf(this.map, bbox),
        profile:
          Math.min(bbox[2], bbox[3]) >= MIN_PROFILE_SIDE ? outlineProfile(this.map, bbox) : null,
      };
      this.looks.set(key, looks);
    }
    return looks;
  }

  /**
   * How alike two boxes look by their edges: the better of the grid signatures' correlation and
   * the outline profiles' (which counts a little less). The second box slides a little to
   * forgive a loose box.
   */
  similarity(a: Rect, b: Rect): number {
    const first = this.of(a);
    if (!first.grid) return 0;
    const step = Math.max(1, Math.round(SHIFT_SHARE * Math.min(b[2], b[3])));
    let best = Number.NEGATIVE_INFINITY;
    for (const dy of SHIFTS) {
      for (const dx of SHIFTS) {
        const second = this.of([b[0] + dx * step, b[1] + dy * step, b[2], b[3]]);
        if (second.grid) best = Math.max(best, correlation(first.grid, second.grid));
        if (first.profile && second.profile) {
          best = Math.max(
            best,
            profileCorrelation(first.profile, second.profile) - PROFILE_PENALTY,
          );
        }
      }
    }
    return best === Number.NEGATIVE_INFINITY ? 0 : best;
  }
}

export function edgeSimilarity(map: EdgeMap, a: Rect, b: Rect): number {
  return new LookCache(map).similarity(a, b);
}

/**
 * Groups items that are the same element repeated: same text of the same size, or the same shape
 * regardless of colour, side by side rather than one over the other. Each group is held together
 * by its first member, so a chain of ever-so-slightly different shapes cannot grow into one big
 * group. Returns groups of item indices, two or more each, in order of their first member.
 */
export function similarityGroups(
  map: EdgeMap,
  items: readonly SimilarityItem[],
  options: SimilarityOptions = {},
): number[][] {
  const threshold = options.minSimilarity ?? MIN_SIMILARITY;
  const cache = new LookCache(map);
  const groups: number[][] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index] as SimilarityItem;
    let chosen: number[] | undefined;
    let chosenScore = Number.NEGATIVE_INFINITY;
    for (const members of groups) {
      const leader = items[members[0] as number] as SimilarityItem;
      const drift =
        leader.text !== undefined || item.text !== undefined ? MAX_TEXT_DRIFT : MAX_SIZE_DRIFT;
      if (!similarSize(leader.bbox, item.bbox, drift)) continue;
      if (!members.every((member) => apart((items[member] as SimilarityItem).bbox, item.bbox))) {
        continue;
      }
      const score =
        leader.text !== undefined || item.text !== undefined
          ? Number(leader.text === item.text)
          : cache.similarity(leader.bbox, item.bbox);
      const matches =
        leader.text !== undefined || item.text !== undefined ? score === 1 : score >= threshold;
      if (matches && score > chosenScore) {
        chosen = members;
        chosenScore = score;
      }
    }
    if (chosen) chosen.push(index);
    else groups.push([index]);
  }
  return groups.filter((members) => members.length >= 2);
}
