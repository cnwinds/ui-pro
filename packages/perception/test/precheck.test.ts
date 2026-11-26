import { type Candidate, type CandidatesDoc, createScreenDoc } from '@ui-pro/core';
import { describe, expect, it } from 'vitest';
import { precheck } from '../src/precheck';
import { imageFromSvg, svgDocument } from './helpers';

function screen(file: string, width: number, scale: number) {
  return createScreenDoc({
    name: 'main',
    source: { kind: 'flat', file, width, height: 400, sha256: '0'.repeat(64) },
    scale,
    size: [Math.round(width * scale), Math.round(400 * scale)],
  });
}

function evidence(...candidates: Candidate[]): CandidatesDoc {
  return {
    format: 'ui-pro/candidates',
    version: 1,
    sourceSha256: '0'.repeat(64),
    candidates,
    clusters: [],
  };
}

const cv = (id: string, bbox: [number, number, number, number]): Candidate => ({
  id,
  source: 'cv',
  bbox,
});

describe('precheck', () => {
  it('lists an upscale above 1.5 times and a JPEG source as risks', async () => {
    const image = await imageFromSvg(svgDocument(300, 400, ''));

    const sharp = precheck(screen('source/ui.png', 300, 1.2), evidence(), image);
    const soft = precheck(screen('source/ui.jpg', 300, 2.5), evidence(), image);

    expect(sharp).toEqual({ upscale: 1.2, risks: [], ask: [] });
    expect(soft.upscale).toBe(2.5);
    expect(soft.risks).toHaveLength(2);
    expect(soft.risks[0]).toContain('2.50 倍');
    expect(soft.risks[1]).toContain('JPEG');
  });

  it('asks whether to exclude gray round shapes pressed against a side', async () => {
    const image = await imageFromSvg(
      svgDocument(
        300,
        400,
        [
          '<circle cx="20" cy="100" r="20" fill="#cdcdcd"/>',
          '<circle cx="280" cy="200" r="20" fill="#d4d4d4"/>',
          '<circle cx="20" cy="300" r="20" fill="#e0402a"/>',
          '<circle cx="150" cy="200" r="20" fill="#cdcdcd"/>',
        ].join(''),
        '#7fb0e0',
      ),
    );
    const candidates = evidence(
      cv('cand#1', [0, 80, 40, 40]),
      cv('cand#2', [260, 180, 40, 40]),
      cv('cand#3', [0, 280, 40, 40]),
      cv('cand#4', [130, 180, 40, 40]),
      cv('cand#5', [0, 0, 120, 30]),
    );

    const { ask } = precheck(screen('source/ui.png', 300, 1), candidates, image);

    expect(ask).toEqual([
      expect.objectContaining({
        id: 'exclude-screenshot-residue',
        options: ['排除', '保留'],
        default: '排除',
      }),
    ]);
    expect(ask[0]?.question).toContain('cand#1、cand#2');
    expect(ask[0]?.question).not.toContain('cand#3');
    expect(ask[0]?.question).not.toContain('cand#4');
  });
});
