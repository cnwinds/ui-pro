import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyOps,
  type CandidatesDoc,
  ErrorCodes,
  type EvidenceUpdate,
  listHistory,
  loadScreen,
  readCandidates,
  undo,
} from '../src';
import { emptyScreenProject, type Fixture, failureOf, snapshotTree, useTempDirs } from './helpers';

const makeDir = useTempDirs();

function candidatesFor(fx: Fixture, extra: Partial<CandidatesDoc> = {}): CandidatesDoc {
  return {
    format: 'ui-pro/candidates',
    version: 1,
    sourceSha256: loadScreen(fx.project, fx.screen).source.sha256,
    candidates: [
      { id: 'cand#1', source: 'cv', bbox: [10, 10, 40, 40], cluster: 'vis#1', mask: 'masks/1.png' },
      { id: 'cand#2', source: 'cv', bbox: [100, 10, 40, 40], cluster: 'vis#1' },
      { id: 'cand#3', source: 'ocr', bbox: [10, 100, 200, 30], text: '攻击' },
    ],
    clusters: [{ id: 'vis#1', kind: 'visual', members: ['cand#1', 'cand#2'] }],
    ...extra,
  };
}

const mask = { path: 'masks/1.png', content: Buffer.from('mask-bytes') };

function evidencePath(fx: Fixture, ...rest: string[]): string {
  return join(fx.project.root, 'screens', fx.screen, 'evidence', ...rest);
}

function analyze(fx: Fixture, ops: unknown[], update: EvidenceUpdate, dryRun = false) {
  return applyOps(fx.project, ops, {
    screen: fx.screen,
    message: '分析',
    dryRun,
    evidence: { [fx.screen]: update },
  });
}

describe('evidence committed with ops', () => {
  it('writes the candidates and the draft built on them as one undoable version', async () => {
    const fx = await emptyScreenProject(makeDir);
    const result = await analyze(
      fx,
      [{ op: 'node.add', node: { id: 'slot_a', type: 'image' }, from: ['cand#1'] }],
      { candidates: candidatesFor(fx), files: [mask] },
    );

    expect(result.changes.docs).toContain('screens/main/evidence/candidates.json');
    expect(loadScreen(fx.project, fx.screen).nodes.slot_a?.rect).toEqual([10, 10, 40, 40]);
    expect(readCandidates(fx.project, fx.screen)?.candidates).toHaveLength(3);
    expect(existsSync(evidencePath(fx, 'masks', '1.png'))).toBe(true);
    expect(listHistory(fx.project).at(-1)?.message).toBe('分析');

    await undo(fx.project);
    expect(readCandidates(fx.project, fx.screen)).toBeNull();
    expect(existsSync(evidencePath(fx, 'masks', '1.png'))).toBe(false);
    expect(loadScreen(fx.project, fx.screen).nodes.slot_a).toBeUndefined();
  });

  it('lets a dry run see the new evidence without writing it', async () => {
    const fx = await emptyScreenProject(makeDir);
    const before = await snapshotTree(fx.project.root);
    const result = await analyze(
      fx,
      [{ op: 'node.add', node: { id: 'label_atk', type: 'text' }, from: ['cand#3'] }],
      { candidates: candidatesFor(fx), files: [mask] },
      true,
    );

    expect(result.changes.screens.main?.added).toEqual(['label_atk']);
    expect(await snapshotTree(fx.project.root)).toEqual(before);
  });

  it('removes evidence files the new analysis no longer produces', async () => {
    const fx = await emptyScreenProject(makeDir);
    await analyze(fx, [], { candidates: candidatesFor(fx), files: [mask] });
    const second = candidatesFor(fx, {
      candidates: [{ id: 'cand#1', source: 'cv', bbox: [10, 10, 40, 40] }],
      clusters: [],
    });
    await analyze(fx, [], { candidates: second });

    expect(existsSync(evidencePath(fx, 'masks', '1.png'))).toBe(false);
    expect(readCandidates(fx.project, fx.screen)?.candidates).toHaveLength(1);
  });

  it('refuses evidence of another source, a missing mask, or an unsafe path', async () => {
    const fx = await emptyScreenProject(makeDir);
    const before = await snapshotTree(fx.project.root);

    const stale = await failureOf(
      analyze(fx, [], { candidates: candidatesFor(fx, { sourceSha256: 'a'.repeat(64) }) }),
    );
    expect(stale.code).toBe(ErrorCodes.invariant);
    expect(stale.message).toContain('sourceSha256');

    const noMask = await failureOf(analyze(fx, [], { candidates: candidatesFor(fx) }));
    expect(noMask.message).toContain('masks/1.png');

    const unsafe = await failureOf(
      analyze(fx, [], {
        candidates: candidatesFor(fx),
        files: [mask, { path: '../screen.uir.json', content: Buffer.from('x') }],
      }),
    );
    expect(unsafe.message).toContain('../screen.uir.json');

    expect(await snapshotTree(fx.project.root)).toEqual(before);
  });
});

describe('nodes built from evidence', () => {
  it('inherit the visual cluster their candidates share', async () => {
    const fx = await emptyScreenProject(makeDir);
    await analyze(
      fx,
      [
        { op: 'node.add', node: { id: 'slot_a', type: 'image' }, from: ['cand#1'] },
        { op: 'node.add', node: { id: 'slot_b', type: 'image' }, from: ['cand#2'] },
        { op: 'node.add', node: { id: 'mixed', type: 'container' }, from: ['cand#1', 'cand#3'] },
      ],
      { candidates: candidatesFor(fx), files: [mask] },
    );

    const nodes = loadScreen(fx.project, fx.screen).nodes;
    expect(nodes.slot_a?.cluster).toBe('vis#1');
    expect(nodes.slot_b?.cluster).toBe('vis#1');
    expect(nodes.mixed?.cluster).toBeUndefined();
  });
});
