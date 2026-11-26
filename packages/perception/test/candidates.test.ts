import type { Rect } from '@ui-pro/core';
import { CandidatesDocSchema } from '@ui-pro/core';
import { describe, expect, it } from 'vitest';
import { buildCandidates } from '../src/candidates';
import type { EdgeMap } from '../src/ink';
import type { StableRegion } from '../src/regions';
import type { TextCandidate } from '../src/text';

const SHA = 'a'.repeat(64);
const EDGES: EdgeMap = { strength: new Uint8Array(400 * 300), width: 400, height: 300 };

function shape(bbox: Rect, stability = 21): StableRegion {
  return { bbox, stability };
}

function text(content: string, bbox: Rect, confidence = 0.97): TextCandidate {
  return { text: content, confidence, bbox, support: 3 };
}

const PANEL = shape([10, 10, 300, 200]);
const BUTTON = shape([40, 150, 120, 40]);
const BADGE = shape([200, 20, 40, 40]);

describe('buildCandidates', () => {
  it('numbers candidates by position, whatever order the detectors found them in', () => {
    const forward = buildCandidates({
      shapes: [BADGE, PANEL, BUTTON],
      texts: [text('Go', [60, 160, 30, 16]), text('Title', [30, 20, 60, 20])],
      edges: EDGES,
      sourceSha256: SHA,
    });
    const shuffled = buildCandidates({
      shapes: [BUTTON, BADGE, PANEL],
      texts: [text('Title', [30, 20, 60, 20]), text('Go', [60, 160, 30, 16])],
      edges: EDGES,
      sourceSha256: SHA,
    });

    expect(shuffled).toEqual(forward);
    expect(forward.candidates.map((candidate) => candidate.id)).toEqual([
      'cand#1',
      'cand#2',
      'cand#3',
      'cand#4',
      'cand#5',
    ]);
    // Top to bottom, then left to right.
    expect(forward.candidates.map((candidate) => candidate.bbox[1])).toEqual([
      10, 20, 20, 150, 160,
    ]);
    expect(forward.candidates.map((candidate) => candidate.bbox[0])).toEqual([10, 30, 200, 40, 60]);
  });

  it('produces a document the kernel accepts', () => {
    const doc = buildCandidates({
      shapes: [PANEL, BUTTON],
      texts: [text('Go', [60, 160, 30, 16])],
      edges: EDGES,
      sourceSha256: SHA,
    });

    expect(() => CandidatesDocSchema.parse(doc)).not.toThrow();
    expect(doc.sourceSha256).toBe(SHA);
  });

  it('links every candidate to the smallest shape that holds it', () => {
    const doc = buildCandidates({
      shapes: [PANEL, BUTTON, BADGE],
      texts: [text('Go', [60, 160, 30, 16])],
      edges: EDGES,
      sourceSha256: SHA,
    });
    const at = (box: Rect, source: string) =>
      doc.candidates.find(
        (candidate) =>
          candidate.source === source &&
          candidate.bbox.every((value, index) => value === box[index]),
      );

    expect(at(PANEL.bbox, 'cv')?.parent).toBeUndefined();
    expect(at(BUTTON.bbox, 'cv')?.parent).toBe(at(PANEL.bbox, 'cv')?.id);
    expect(at([60, 160, 30, 16], 'ocr')?.parent).toBe(at(BUTTON.bbox, 'cv')?.id);
    expect(at(BADGE.bbox, 'cv')?.parent).toBe(at(PANEL.bbox, 'cv')?.id);
  });

  it('drops shapes that only trace a text or one of its letters', () => {
    const doc = buildCandidates({
      shapes: [PANEL, shape([60, 160, 30, 15]), shape([62, 161, 8, 14])],
      texts: [text('Go', [60, 160, 30, 16])],
      edges: EDGES,
      sourceSha256: SHA,
    });

    expect(doc.candidates.map((candidate) => candidate.source).sort()).toEqual(['cv', 'ocr']);
  });

  it('puts texts that say the same thing into one visual cluster', () => {
    const doc = buildCandidates({
      shapes: [],
      texts: [
        text('+5', [20, 20, 18, 11]),
        text('+5', [120, 20, 19, 11]),
        text('x', [220, 40, 18, 11]),
      ],
      edges: EDGES,
      sourceSha256: SHA,
    });

    expect(doc.clusters).toEqual([{ id: 'vis#1', members: ['cand#1', 'cand#2'], kind: 'visual' }]);
    expect(doc.candidates.filter((candidate) => candidate.cluster === 'vis#1')).toHaveLength(2);
  });

  it('scores texts by confidence and shapes by how stable they were', () => {
    const doc = buildCandidates({
      shapes: [shape([10, 100, 50, 50], 10.5)],
      texts: [text('Hi', [10, 10, 20, 12], 0.9712)],
      edges: EDGES,
      sourceSha256: SHA,
    });

    expect(doc.candidates[0]?.score).toBe(0.97);
    expect(doc.candidates[1]?.score).toBe(0.5);
  });
});
