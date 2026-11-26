import type { Candidate, CandidatesDoc, Cluster, Rect } from '@ui-pro/core';
import { similarityGroups } from './cluster';
import { area, coverage, iou, roundBox } from './geometry';
import type { EdgeMap } from './ink';
import type { StableRegion } from './regions';
import type { TextCandidate } from './text';

export interface CandidateInput {
  shapes: readonly StableRegion[];
  texts: readonly TextCandidate[];
  edges: EdgeMap;
  sourceSha256: string;
}

const TEXT_OVERLAP = 0.55;
const TEXT_FRAGMENT = 0.7;
const PARENT_COVERAGE = 0.9;
const PARENT_GROWTH = 1.15;
const MAX_STABILITY = 21;

interface Draft {
  source: 'cv' | 'ocr';
  bbox: Rect;
  score: number;
  text?: string;
}

function position(a: Draft, b: Draft): number {
  return (
    a.bbox[1] - b.bbox[1] ||
    a.bbox[0] - b.bbox[0] ||
    a.bbox[3] - b.bbox[3] ||
    a.bbox[2] - b.bbox[2] ||
    a.source.localeCompare(b.source)
  );
}

/** Shapes that merely trace the letters of a text, or one of its glyphs, say nothing new. */
function isTextDetail(shape: Rect, texts: readonly Rect[]): boolean {
  return texts.some(
    (text) => iou(shape, text) >= TEXT_OVERLAP || coverage(shape, text) >= TEXT_FRAGMENT,
  );
}

/** The smallest shape that holds `inner`, so that the candidates form a containment tree. */
function parentOf(index: number, drafts: readonly Draft[]): number | undefined {
  const inner = drafts[index] as Draft;
  let best: number | undefined;
  for (let other = 0; other < drafts.length; other++) {
    const outer = drafts[other] as Draft;
    if (other === index || outer.source !== 'cv') continue;
    if (area(outer.bbox) < PARENT_GROWTH * area(inner.bbox)) continue;
    if (coverage(inner.bbox, outer.bbox) < PARENT_COVERAGE) continue;
    if (best === undefined || area(outer.bbox) < area((drafts[best] as Draft).bbox)) best = other;
  }
  return best;
}

/**
 * Numbers the detected shapes and texts by position (top to bottom, then left to right), so that
 * the same image always gets the same numbers; links each to the smallest shape around it; and
 * groups repeated elements into visual clusters. Every box is in source pixels.
 */
export function buildCandidates(input: CandidateInput): CandidatesDoc {
  const texts: Draft[] = input.texts.map((text) => ({
    source: 'ocr',
    bbox: roundBox(text.bbox),
    score: Math.round(text.confidence * 100) / 100,
    text: text.text,
  }));
  const textBoxes = texts.map((text) => text.bbox);
  const shapes: Draft[] = input.shapes
    .map((shape) => ({
      source: 'cv' as const,
      bbox: roundBox(shape.bbox),
      score: Math.round((Math.min(shape.stability, MAX_STABILITY) / MAX_STABILITY) * 100) / 100,
    }))
    .filter((shape) => !isTextDetail(shape.bbox, textBoxes));
  const drafts = [...texts, ...shapes].sort(position);

  const ids = drafts.map((_, index) => `cand#${index + 1}`);
  const groups = similarityGroups(
    input.edges,
    drafts.map((draft) => ({ bbox: draft.bbox, text: draft.text })),
  );
  const clusterOf = new Map<number, string>();
  const clusters: Cluster[] = groups.map((members, index) => {
    const id = `vis#${index + 1}`;
    for (const member of members) clusterOf.set(member, id);
    return { id, members: members.map((member) => ids[member] as string), kind: 'visual' };
  });

  const candidates: Candidate[] = drafts.map((draft, index) => {
    const parent = parentOf(index, drafts);
    const cluster = clusterOf.get(index);
    return {
      id: ids[index] as string,
      source: draft.source,
      bbox: draft.bbox,
      score: draft.score,
      ...(draft.text === undefined ? {} : { text: draft.text }),
      ...(parent === undefined ? {} : { parent: ids[parent] as string }),
      ...(cluster === undefined ? {} : { cluster }),
    };
  });
  return {
    format: 'ui-pro/candidates',
    version: 1,
    sourceSha256: input.sourceSha256,
    candidates,
    clusters,
  };
}
