import type { Candidate, CandidatesDoc, Rect } from '@ui-pro/core';
import { describe, expect, it } from 'vitest';
import { buildDraft, isValueText } from '../src/draft';

function shape(id: number, bbox: Rect, extra: Partial<Candidate> = {}): Candidate {
  return { id: `cand#${id}`, source: 'cv', bbox, score: 0.9, ...extra };
}

function word(id: number, content: string, bbox: Rect, extra: Partial<Candidate> = {}): Candidate {
  return { id: `cand#${id}`, source: 'ocr', bbox, score: 0.95, text: content, ...extra };
}

function docOf(candidates: Candidate[], clusters: CandidatesDoc['clusters'] = []): CandidatesDoc {
  return {
    format: 'ui-pro/candidates',
    version: 1,
    sourceSha256: 'b'.repeat(64),
    candidates,
    clusters,
  };
}

interface AddOp {
  op: 'node.add';
  node: { id: string; type: string; parent?: string; text?: { content: string; kind?: string } };
  from: string[];
}

function addOps(ops: unknown[]): AddOp[] {
  return ops as AddOp[];
}

describe('isValueText', () => {
  it.each(['3,260', '168', '+5', 'Lv.36', 'LV36', '12/30', '45%', '×2', '1.5'])(
    'treats %s as a value',
    (content) => {
      expect(isValueText(content)).toBe(true);
    },
  );

  it.each(['攻击', '升级', 'ATK', 'Level up', '糖果骑士', ''])(
    'treats %s as a label',
    (content) => {
      expect(isValueText(content)).toBe(false);
    },
  );
});

describe('buildDraft', () => {
  const panel = shape(1, [0, 0, 300, 200]);
  const button = shape(3, [20, 120, 100, 50], { parent: 'cand#1' });
  const doc = docOf([
    panel,
    word(2, 'Title', [20, 10, 80, 20], { parent: 'cand#1' }),
    button,
    word(4, '升级', [40, 130, 40, 20], { parent: 'cand#3' }),
    word(5, '3,260', [150, 130, 50, 16], { parent: 'cand#1' }),
    shape(6, [210, 20, 30, 30], { parent: 'cand#1' }),
    shape(7, [250, 20, 30, 30], { parent: 'cand#1' }),
    shape(8, [10, 60, 40, 40], { parent: 'cand#1' }),
  ]);

  it('drafts every text, and the shapes that hold text or repeat', () => {
    const clustered = docOf(
      doc.candidates.map((candidate) =>
        ['cand#6', 'cand#7'].includes(candidate.id)
          ? { ...candidate, cluster: 'vis#1' }
          : candidate,
      ),
      [{ id: 'vis#1', members: ['cand#6', 'cand#7'], kind: 'visual' }],
    );

    const { ops, nodes } = buildDraft(clustered, []);

    expect(addOps(ops).map((op) => op.from[0])).toEqual([
      'cand#1',
      'cand#2',
      'cand#3',
      'cand#4',
      'cand#5',
      'cand#6',
      'cand#7',
    ]);
    // The lone shape that holds no text and repeats nothing is left to the evidence.
    expect(nodes.has('cand#8')).toBe(false);
    expect(nodes.size).toBe(7);
  });

  it('nests nodes under the nearest drafted shape, parents before children', () => {
    const { ops, nodes } = buildDraft(doc, []);
    const added = addOps(ops);
    const nodeOf = (candidate: string) => nodes.get(candidate) as string;

    expect(added[0]?.node.parent).toBeUndefined();
    expect(added.find((op) => op.from[0] === 'cand#3')?.node.parent).toBe(`#${nodeOf('cand#1')}`);
    expect(added.find((op) => op.from[0] === 'cand#4')?.node.parent).toBe(`#${nodeOf('cand#3')}`);
    const seen = new Set<string>();
    for (const op of added) {
      if (op.node.parent !== undefined) expect(seen.has(op.node.parent.slice(1))).toBe(true);
      seen.add(op.node.id);
    }
  });

  it('skips over a shape that is not drafted when looking for the parent', () => {
    const inner = docOf(
      [
        shape(1, [0, 0, 300, 200]),
        shape(2, [10, 10, 200, 100], { parent: 'cand#1' }),
        shape(3, [20, 20, 30, 30], { parent: 'cand#2', cluster: 'vis#1' }),
        word(4, 'Hi', [220, 150, 30, 16], { parent: 'cand#1' }),
      ],
      [{ id: 'vis#1', members: ['cand#3'], kind: 'visual' }],
    );

    const { ops, nodes } = buildDraft(inner, []);

    expect(nodes.has('cand#2')).toBe(false);
    expect(addOps(ops).map((op) => op.from[0])).toEqual(['cand#1', 'cand#3', 'cand#4']);
    expect(addOps(ops)[1]?.node.parent).toBe(`#${addOps(ops)[0]?.node.id}`);
  });

  it('types containers, images and texts, and marks numbers as values', () => {
    const clustered = docOf(
      doc.candidates.map((candidate) =>
        candidate.id === 'cand#6' ? { ...candidate, cluster: 'vis#1' } : candidate,
      ),
      [{ id: 'vis#1', members: ['cand#6'], kind: 'visual' }],
    );

    const { ops } = buildDraft(clustered, []);
    const byCandidate = new Map(addOps(ops).map((op) => [op.from[0], op.node]));

    expect(byCandidate.get('cand#1')?.type).toBe('container');
    expect(byCandidate.get('cand#3')?.type).toBe('container');
    expect(byCandidate.get('cand#6')?.type).toBe('image');
    expect(byCandidate.get('cand#4')).toMatchObject({ type: 'text', text: { content: '升级' } });
    expect(byCandidate.get('cand#4')?.text?.kind).toBeUndefined();
    expect(byCandidate.get('cand#5')).toMatchObject({
      type: 'text',
      text: { content: '3,260', kind: 'value' },
    });
  });

  it('picks ids that are not taken yet', () => {
    const { ops } = buildDraft(doc, ['container_1', 'text_1', 'text_2']);

    expect(addOps(ops).map((op) => op.node.id)).toEqual([
      'container_2',
      'text_3',
      'container_3',
      'text_4',
      'text_5',
    ]);
  });
});
