import type { Rect } from '@ui-pro/core';
import { describe, expect, it } from 'vitest';
import { edgeSimilarity, similarityGroups } from '../src/cluster';
import { type EdgeMap, edgeStrength } from '../src/ink';
import { imageFromSvg, svgDocument } from './helpers';

async function edgesOf(svg: string, width: number, height: number): Promise<EdgeMap> {
  const image = await imageFromSvg(svgDocument(width, height, svg, '#e8dcc4'));
  return { strength: edgeStrength(image), width, height };
}

function frame(x: number, y: number, fill: string, glyph: string): string {
  return (
    `<rect x="${x}" y="${y}" width="80" height="80" rx="12" fill="${fill}" stroke="#3a2a1a" stroke-width="4"/>` +
    `<rect x="${x + 8}" y="${y + 8}" width="64" height="64" rx="8" fill="none" stroke="#fff" stroke-width="3"/>` +
    glyph
  );
}

const FRAMES: Rect[] = [
  [20, 20, 80, 80],
  [140, 20, 80, 80],
  [260, 20, 80, 80],
];

describe('similarityGroups', () => {
  it('groups elements that share an outline although their colours and contents differ', async () => {
    const edges = await edgesOf(
      frame(20, 20, '#a050d0', '<circle cx="60" cy="60" r="14" fill="#fff"/>') +
        frame(140, 20, '#f0a020', '<rect x="168" y="48" width="24" height="24" fill="#fff"/>') +
        frame(260, 20, '#3080e0', '<polygon points="300,44 316,76 284,76" fill="#fff"/>') +
        '<rect x="20" y="140" width="200" height="30" rx="15" fill="#b03030"/>' +
        '<circle cx="320" cy="150" r="40" fill="#30a060"/>',
      400,
      200,
    );
    const items = [...FRAMES, [20, 140, 200, 30], [280, 110, 80, 80]].map((bbox) => ({
      bbox: bbox as Rect,
    }));

    const groups = similarityGroups(edges, items);

    expect(groups).toEqual([[0, 1, 2]]);
  });

  it('does not group elements of clearly different size', async () => {
    const edges = await edgesOf(
      frame(20, 20, '#a050d0', '') +
        '<rect x="160" y="20" width="160" height="160" rx="12" fill="#f0a020" stroke="#3a2a1a" stroke-width="4"/>',
      400,
      200,
    );

    expect(
      similarityGroups(edges, [{ bbox: [20, 20, 80, 80] }, { bbox: [160, 20, 160, 160] }]),
    ).toEqual([]);
  });

  it('groups texts that say the same thing at about the same size, and only those', async () => {
    const edges = await edgesOf('', 200, 100);
    const groups = similarityGroups(edges, [
      { bbox: [10, 10, 20, 12], text: '+5' },
      { bbox: [60, 12, 22, 13], text: '+5' },
      { bbox: [110, 10, 20, 12], text: '+6' },
      { bbox: [10, 50, 20, 12] },
      { bbox: [60, 50, 60, 24], text: '+5' },
    ]);

    expect(groups).toEqual([[0, 1]]);
  });

  it('never groups a box with one it overlaps', async () => {
    const edges = await edgesOf('', 200, 100);

    expect(
      similarityGroups(edges, [
        { bbox: [10, 10, 40, 14], text: 'ok' },
        { bbox: [14, 12, 40, 14], text: 'ok' },
      ]),
    ).toEqual([]);
  });
});

describe('edgeSimilarity', () => {
  it('is high for the same outline in another place and low for another shape', async () => {
    const edges = await edgesOf(
      frame(20, 20, '#a050d0', '') +
        frame(140, 20, '#3080e0', '') +
        '<circle cx="300" cy="60" r="40" fill="#30a060"/>',
      400,
      120,
    );

    expect(edgeSimilarity(edges, [20, 20, 80, 80], [140, 20, 80, 80])).toBeGreaterThan(0.9);
    expect(edgeSimilarity(edges, [20, 20, 80, 80], [260, 20, 80, 80])).toBeLessThan(0.72);
  });
});
