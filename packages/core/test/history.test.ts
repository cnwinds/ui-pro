import { existsSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyOps,
  createProject,
  ErrorCodes,
  listHistory,
  listScreens,
  loadScreen,
  redo,
  showVersion,
  undo,
} from '../src';
import {
  emptyScreenProject,
  type Fixture,
  failureOf,
  readText,
  snapshotTree,
  treeFixture,
  useTempDirs,
} from './helpers';

const makeDir = useTempDirs();

/** The project's files, without the history store that changes with every undo and redo. */
async function content(fx: Fixture): Promise<Record<string, string>> {
  const all = await snapshotTree(fx.project.root);
  return Object.fromEntries(Object.entries(all).filter(([path]) => !path.startsWith('history/')));
}

const retitle = (label: string) => [
  { op: 'node.set', target: '#title', set: { label } },
  { op: 'concept.define', name: '标题', exemplars: '#title' },
];

describe('undo and redo', () => {
  it('walk back and forth through the versions, restoring files byte for byte', async () => {
    const fx = await treeFixture(makeDir);
    // v1 added the screen, v2 seeded the tree.
    const seeded = await content(fx);
    await applyOps(fx.project, retitle('主标题'), { screen: fx.screen }); // v3
    const edited = await content(fx);
    expect(edited).not.toEqual(seeded);

    await undo(fx.project); // v4 reverts v3
    expect(await content(fx)).toEqual(seeded);

    await undo(fx.project); // v5 reverts v2: the tree is gone again
    expect(Object.keys(loadScreen(fx.project, 'main').nodes)).toEqual(['root']);

    await redo(fx.project); // v6 brings v2 back
    expect(await content(fx)).toEqual(seeded);

    await redo(fx.project); // v7 brings v3 back
    expect(await content(fx)).toEqual(edited);

    await undo(fx.project);
    expect(await content(fx)).toEqual(seeded);
  });

  it('record themselves as new versions that point at what they reverted', async () => {
    const fx = await treeFixture(makeDir);
    await applyOps(fx.project, retitle('A'), { screen: fx.screen });

    const undone = await undo(fx.project);
    const liveFlags = () => listHistory(fx.project).map(({ version, live }) => [version, live]);
    expect(liveFlags()).toEqual([
      [1, true],
      [2, true],
      [3, false],
      [4, true],
    ]);
    const redone = await redo(fx.project);

    expect(undone).toMatchObject({ version: 4, revertOf: 3, message: '撤销 v3', source: 'cli' });
    expect(redone).toMatchObject({ version: 5, revertOf: 4, message: '重做 v3' });
    expect(liveFlags()).toEqual([
      [1, true],
      [2, true],
      [3, true],
      [4, false],
      [5, true],
    ]);
  });

  it('can be attributed to another source', async () => {
    const fx = await treeFixture(makeDir);

    const entry = await undo(fx.project, { source: 'studio' });

    expect(entry.source).toBe('studio');
  });

  it('refuse when there is nothing to undo or redo', async () => {
    const root = await makeDir();
    const project = await createProject(join(root, 'empty'));

    expect((await failureOf(undo(project))).code).toBe(ErrorCodes.historyEmpty);
    expect((await failureOf(redo(project))).code).toBe(ErrorCodes.historyEmpty);

    const fx = await treeFixture(makeDir);
    expect((await failureOf(redo(fx.project))).code).toBe(ErrorCodes.historyEmpty);
  });

  it('drop the redo chain once new work has been committed', async () => {
    const fx = await treeFixture(makeDir);
    await applyOps(fx.project, retitle('A'), { screen: fx.screen });
    await undo(fx.project);

    await applyOps(fx.project, retitle('B'), { screen: fx.screen });

    expect((await failureOf(redo(fx.project))).code).toBe(ErrorCodes.historyEmpty);
    await undo(fx.project);
    expect(loadScreen(fx.project, 'main').nodes.title?.label).toBeUndefined();
  });

  it('restore every file a version touched, including a deleted screen with its source', async () => {
    const fx = await emptyScreenProject(makeDir);
    const added = await content(fx);

    await undo(fx.project);
    expect(listScreens(fx.project)).toEqual([]);
    expect(existsSync(join(fx.project.root, 'screens', 'main'))).toBe(false);
    expect(existsSync(join(fx.project.root, 'screens'))).toBe(true);

    await redo(fx.project);
    expect(await content(fx)).toEqual(added);
    expect(existsSync(join(fx.project.root, 'screens', 'main', 'source', 'ui.png'))).toBe(true);
  });

  it('refuse to overwrite files that were edited outside ui-pro', async () => {
    const fx = await treeFixture(makeDir);
    await applyOps(fx.project, retitle('A'), { screen: fx.screen });
    const screenFile = join(fx.project.root, 'screens/main/screen.uir.json');
    await appendFile(screenFile, '\n');
    const before = await snapshotTree(fx.project.root);

    const error = await failureOf(undo(fx.project));

    expect(error.code).toBe(ErrorCodes.historyConflict);
    expect(error.message).toContain('screens/main/screen.uir.json');
    expect(await snapshotTree(fx.project.root)).toEqual(before);
  });

  it('report a damaged history store instead of guessing', async () => {
    const fx = await treeFixture(makeDir);
    await applyOps(fx.project, retitle('A'), { screen: fx.screen });
    const log = join(fx.project.root, 'history', 'log.jsonl');
    const intact = await readFile(log, 'utf8');
    await writeFile(log, `${intact}{ broken\n`);

    expect((await failureOf(undo(fx.project))).code).toBe(ErrorCodes.docInvalid);
    expect(() => listHistory(fx.project)).toThrowError(
      expect.objectContaining({ code: ErrorCodes.docInvalid }),
    );
  });
});

describe('listing and inspecting history', () => {
  it('lists versions oldest first, or only the newest few', async () => {
    const fx = await treeFixture(makeDir);
    await applyOps(fx.project, retitle('A'), { screen: fx.screen, message: '改标题' });

    const all = listHistory(fx.project);
    expect(all.map((item) => item.version)).toEqual([1, 2, 3]);
    expect(all[2]).toMatchObject({
      version: 3,
      message: '改标题',
      opCount: 2,
      docCount: 2,
      live: true,
      source: 'cli',
    });
    expect(all[2]?.revertOf).toBeUndefined();
    expect(Date.parse(all[2]?.time ?? '')).not.toBeNaN();

    expect(listHistory(fx.project, { limit: 2 }).map((item) => item.version)).toEqual([2, 3]);
  });

  it('keeps the log as one JSON object per line', async () => {
    const fx = await treeFixture(makeDir);
    await applyOps(fx.project, retitle('A'), { screen: fx.screen });

    const lines = (await readText(fx.project, 'history/log.jsonl')).trimEnd().split('\n');

    expect(lines).toHaveLength(3);
    expect(lines.map((line) => (JSON.parse(line) as { version: number }).version)).toEqual([
      1, 2, 3,
    ]);
  });

  it('shows a version with its ops and document hashes', async () => {
    const fx = await treeFixture(makeDir);
    const ops = retitle('A');
    await applyOps(fx.project, ops, { screen: fx.screen });

    const entry = showVersion(fx.project, 3);

    expect(entry.ops).toEqual(ops);
    expect(Object.keys(entry.docs)).toEqual(['glossary.yaml', 'screens/main/screen.uir.json']);
    for (const { before, after } of Object.values(entry.docs)) {
      expect(before).toMatch(/^[0-9a-f]{64}$/);
      expect(after).toMatch(/^[0-9a-f]{64}$/);
      expect(before).not.toBe(after);
    }
  });

  it('records a created file with a null before-hash', async () => {
    const fx = await emptyScreenProject(makeDir);

    const entry = showVersion(fx.project, 1);

    expect(entry.docs['screens/main/screen.uir.json']?.before).toBeNull();
    expect(entry.docs['screens/main/screen.uir.json']?.after).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects an unknown version with E_VERSION_NOT_FOUND', async () => {
    const fx = await treeFixture(makeDir);

    const error = await failureOf(Promise.resolve().then(() => showVersion(fx.project, 99)));

    expect(error.code).toBe(ErrorCodes.versionNotFound);
    expect(error.hint).toContain('history list');
  });
});
