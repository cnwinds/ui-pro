import { describe, expect, it } from 'vitest';
import { dataOf, snapshotTree, treeProject, useTempDirs } from './helpers';

const makeDir = useTempDirs();

interface Entry {
  version: number;
  message: string;
  live: boolean;
  revertOf?: number;
}

describe('ui-pro history', () => {
  it('lists versions oldest first', async () => {
    const { cli } = await treeProject(makeDir);

    const envelope = await cli.ok(['history', 'list']);

    const { items } = dataOf<{ items: Entry[] }>(envelope);
    expect(items.map(({ version, message, live }) => [version, message, live])).toEqual([
      [1, '新增界面 main', true],
      [2, 'seed tree', true],
    ]);
  });

  it('keeps only the newest versions with --limit', async () => {
    const { cli } = await treeProject(makeDir);

    const envelope = await cli.ok(['history', 'list', '--limit', '1']);

    expect(dataOf<{ items: Entry[] }>(envelope).items.map((item) => item.version)).toEqual([2]);
  });

  it('shows one version, with or without the v prefix', async () => {
    const { cli } = await treeProject(makeDir);

    const plain = await cli.ok(['history', 'show', '2']);
    const prefixed = await cli.ok(['history', 'show', 'v2']);

    expect(plain.summary).toBe('v2：seed tree');
    expect(prefixed.data).toEqual(plain.data);
    expect(dataOf<{ docs: Record<string, unknown> }>(plain).docs).toHaveProperty([
      'screens/main/screen.uir.json',
    ]);
  });

  it('fails for a version that does not exist', async () => {
    const { cli } = await treeProject(makeDir);

    const { code, error } = await cli.fail(['history', 'show', '99']);

    expect(code).toBe(1);
    expect(error.code).toBe('E_VERSION_NOT_FOUND');
  });

  it('undoes and redoes, restoring the files byte for byte', async () => {
    const { dir, cli } = await treeProject(makeDir);
    const seeded = withoutHistory(await snapshotTree(dir));

    const undone = await cli.ok(['history', 'undo']);
    const afterUndo = withoutHistory(await snapshotTree(dir));
    const redone = await cli.ok(['history', 'redo']);

    expect(undone.summary).toBe('已撤销 v2，生成 v3');
    expect(dataOf<{ version: number; revertOf: number }>(undone)).toMatchObject({
      version: 3,
      revertOf: 2,
    });
    expect(afterUndo).not.toEqual(seeded);
    expect(redone.summary).toBe('已重做（回退了 v3 的撤销），生成 v4');
    expect(withoutHistory(await snapshotTree(dir))).toEqual(seeded);
    const listed = await cli.ok(['history', 'list']);
    expect(
      dataOf<{ items: Entry[] }>(listed).items.map(({ version, live }) => [version, live]),
    ).toEqual([
      [1, true],
      [2, true],
      [3, false],
      [4, true],
    ]);
  });

  it('refuses to undo when there is nothing left', async () => {
    const { cli } = await treeProject(makeDir);
    await cli.ok(['history', 'undo']);
    await cli.ok(['history', 'undo']);

    const { code, error } = await cli.fail(['history', 'undo']);

    expect(code).toBe(1);
    expect(error.code).toBe('E_HISTORY_EMPTY');
  });

  it('refuses to redo when nothing was undone', async () => {
    const { cli } = await treeProject(makeDir);

    const { error } = await cli.fail(['history', 'redo']);

    expect(error.code).toBe('E_HISTORY_EMPTY');
  });
});

/** Everything but history bookkeeping, which undo and redo must restore byte for byte. */
function withoutHistory(tree: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(tree).filter(([path]) => !path.startsWith('history/')));
}
