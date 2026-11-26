import type { CV, Mat } from '@techstark/opencv-js';
import type { Rect } from '@ui-pro/core';
import { type MatScope, matFromImage, withOpenCv } from './cv-scope';
import { iou } from './geometry';
import type { RgbaImage } from './image';

/** A region that stays put while the threshold moves: a flat-coloured shape or its outline. */
export interface StableRegion {
  bbox: Rect;
  /** Number of consecutive threshold levels at which the region kept its box. */
  stability: number;
}

export interface RegionOptions {
  /** Regions shorter than this (in working pixels) are ignored. */
  minSide?: number;
  /** Fewest consecutive levels a region must survive. */
  minStability?: number;
}

const WORK_MAX_SIDE = 1100;
const LEVEL_START = 8;
const LEVEL_END = 250;
const LEVEL_STEP = 12;
const SAME_BOX_IOU = 0.85;
const MIN_AREA = 40;

interface Track {
  box: Rect;
  length: number;
  lastLevel: number;
}

/** Binary thresholds applied to each view: pixels above the level, and pixels at or below it. */
const POLARITIES = ['above', 'below'] as const;

function linkTracks(cv: CV, scope: MatScope, view: Mat, minSide: number): Track[] {
  const finished: Track[] = [];
  const mask = scope.add(new cv.Mat());
  const labels = scope.add(new cv.Mat());
  const stats = scope.add(new cv.Mat());
  const centroids = scope.add(new cv.Mat());
  const maxWidth = view.cols * 0.95;
  const maxHeight = view.rows * 0.95;

  for (const polarity of POLARITIES) {
    let active: Track[] = [];
    let level = 0;
    for (let threshold = LEVEL_START; threshold < LEVEL_END; threshold += LEVEL_STEP, level++) {
      cv.threshold(
        view,
        mask,
        threshold,
        255,
        polarity === 'above' ? cv.THRESH_BINARY : cv.THRESH_BINARY_INV,
      );
      const count = cv.connectedComponentsWithStats(mask, labels, stats, centroids, 8, cv.CV_32S);
      const values = stats.data32S;
      const taken = new Set<Track>();
      const next: Track[] = [];
      for (let i = 1; i < count; i++) {
        const [x, y, w, h, size] = [
          values[i * 5],
          values[i * 5 + 1],
          values[i * 5 + 2],
          values[i * 5 + 3],
          values[i * 5 + 4],
        ] as [number, number, number, number, number];
        if (w < minSide || h < minSide || size < MIN_AREA) continue;
        if (w > maxWidth && h > maxHeight) continue;
        const box: Rect = [x, y, w, h];
        const track = active.find(
          (candidate) => !taken.has(candidate) && iou(candidate.box, box) > SAME_BOX_IOU,
        );
        if (track) {
          track.box = box;
          track.length++;
          track.lastLevel = level;
          taken.add(track);
          next.push(track);
        } else {
          const fresh: Track = { box, length: 1, lastLevel: level };
          finished.push(fresh);
          next.push(fresh);
        }
      }
      active = next;
    }
  }
  return finished;
}

/**
 * Stable regions of the lightness, colour and saturation channels (an MSER-style search done
 * with plain thresholds): connected components whose bounding box survives several consecutive
 * levels. Boxes are in source pixels, ordered by stability then position.
 */
export async function detectStableRegions(
  image: RgbaImage,
  options: RegionOptions = {},
): Promise<StableRegion[]> {
  const minSide = options.minSide ?? 8;
  const minStability = options.minStability ?? 3;
  return withOpenCv((cv, scope) => {
    const full = matFromImage(cv, scope, image);
    const factor = Math.min(1, WORK_MAX_SIDE / Math.max(image.width, image.height));
    let work: Mat = full;
    if (factor < 1) {
      work = scope.add(new cv.Mat());
      const size = new cv.Size(Math.round(image.width * factor), Math.round(image.height * factor));
      cv.resize(full, work, size, 0, 0, cv.INTER_AREA);
    }

    const rgb = scope.add(new cv.Mat());
    cv.cvtColor(work, rgb, cv.COLOR_RGBA2RGB);
    const lab = scope.add(new cv.Mat());
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
    const hsv = scope.add(new cv.Mat());
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    const labChannels = scope.add(new cv.MatVector());
    cv.split(lab, labChannels);
    const hsvChannels = scope.add(new cv.MatVector());
    cv.split(hsv, hsvChannels);
    const views = [
      scope.add(labChannels.get(0)),
      scope.add(labChannels.get(1)),
      scope.add(labChannels.get(2)),
      scope.add(hsvChannels.get(1)),
    ];

    const tracks = views.flatMap((view) => linkTracks(cv, scope, view, minSide));
    const strong = tracks
      .filter((track) => track.length >= minStability)
      .sort((a, b) => b.length - a.length || a.box[1] - b.box[1] || a.box[0] - b.box[0]);

    const regions: StableRegion[] = [];
    for (const track of strong) {
      if (regions.some((kept) => iou(kept.bbox, track.box) > SAME_BOX_IOU)) continue;
      const [x, y, w, h] = track.box;
      regions.push({
        bbox: [x / factor, y / factor, w / factor, h / factor],
        stability: track.length,
      });
    }
    return regions;
  });
}
