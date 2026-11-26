import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dataOf, snapshotTree, treeProject, useTempDirs } from './helpers';

const makeDir = useTempDirs();

const resizeTitle = [{ op: 'node.set', target: '#title', set: { rect: [300, 300, 500, 80] } }];

interface Applied {
  dryRun: boolean;
  version?: number;
  changes: { screens: Record<string, { modified: Record<string, string[]> }> };
}

describe('ui-pro apply', () => {
  it('commits the operations in a file as a new version', async () => {
    const { dir, cli } = await treeProject(makeDir);
    await writeFile(join(dir, 'ops.json'), JSON.stringify(resizeTitle));

    const envelope = await cli.ok(['apply', 'ops.json', '--message', '加宽标题']);

    expect(envelope.summary).toBe('已提交 v3：节点新增 0、修改 1、删除 0');
    expect(dataOf<Applied>(envelope)).toMatchObject({
      dryRun: false,
      version: 3,
      changes: { screens: { main: { modified: { title: ['rect'] } } } },
    });
    expect(envelope.next).toEqual(['ui-pro history undo  # 撤销这次修改']);
    const queried = await cli.ok(['query', '#title', '--fields', 'rect']);
    expect(dataOf<{ items: unknown[] }>(queried).items).toMatchObject([
      { rect: [300, 300, 500, 80] },
    ]);
    const shown = await cli.ok(['history', 'show', '3']);
    expect(dataOf<{ message: string; source: string }>(shown)).toMatchObject({
      message: '加宽标题',
      source: 'cli',
    });
  });

  it('reads the operations from standard input with -', async () => {
    const { cli } = await treeProject(makeDir);

    const envelope = await cli.ok(['apply', '-'], JSON.stringify(resizeTitle));

    expect(dataOf<Applied>(envelope).version).toBe(3);
  });

  it('names the documents in the summary when no node changed', async () => {
    const { cli } = await treeProject(makeDir);

    const envelope = await cli.ok(
      ['apply', '-'],
      JSON.stringify([{ op: 'concept.define', name: '徽章' }]),
    );

    expect(envelope.summary).toBe('已提交 v3：改动 glossary.yaml');
  });

  it('accepts a file that starts with a UTF-8 byte order mark', async () => {
    const { dir, cli } = await treeProject(makeDir);
    await writeFile(join(dir, 'ops.json'), `\uFEFF${JSON.stringify(resizeTitle)}`);

    const envelope = await cli.ok(['apply', 'ops.json']);

    expect(dataOf<Applied>(envelope).version).toBe(3);
  });

  it('accepts operations wrapped in { "ops": [...] }', async () => {
    const { cli } = await treeProject(makeDir);

    const envelope = await cli.ok(['apply', '-'], JSON.stringify({ ops: resizeTitle }));

    expect(dataOf<Applied>(envelope).version).toBe(3);
  });

  it('names the operations in the default history message', async () => {
    const { cli } = await treeProject(makeDir);

    await cli.ok(['apply', '-'], JSON.stringify(resizeTitle));

    const shown = await cli.ok(['history', 'show', '3']);
    expect(dataOf<{ message: string }>(shown).message).toBe('node.set');
  });

  it('previews with --dry-run and writes nothing', async () => {
    const { dir, cli } = await treeProject(makeDir);
    const before = await snapshotTree(dir);

    const envelope = await cli.ok(['apply', '-', '--dry-run'], JSON.stringify(resizeTitle));

    expect(envelope.summary).toBe('预演通过（未写入）：节点新增 0、修改 1、删除 0');
    expect(dataOf<Applied>(envelope).dryRun).toBe(true);
    expect(dataOf<Applied>(envelope)).not.toHaveProperty('version');
    expect(envelope.next?.[0]).toContain('--dry-run');
    expect(await snapshotTree(dir)).toEqual(before);
  });

  it('applies nothing when a later operation fails', async () => {
    const { dir, cli } = await treeProject(makeDir);
    const before = await snapshotTree(dir);
    const ops = [...resizeTitle, { op: 'node.remove', target: '#ghost' }];

    const { code, error } = await cli.fail(['apply', '-'], JSON.stringify(ops));

    expect(code).toBe(1);
    expect(error.code).toBe('E_SELECTOR_EMPTY');
    expect(error.details).toMatchObject({ opIndex: 1 });
    expect(await snapshotTree(dir)).toEqual(before);
  });

  it('does not create a version for a batch that changes nothing', async () => {
    const { cli } = await treeProject(makeDir);
    const same = [{ op: 'node.set', target: '#title', set: { rect: [300, 300, 480, 80] } }];

    const envelope = await cli.ok(['apply', '-'], JSON.stringify(same));

    expect(envelope.summary).toBe('没有产生任何变化，未创建新版本');
    expect(dataOf<Applied>(envelope).version).toBeUndefined();
    const history = await cli.ok(['history', 'list']);
    expect(dataOf<{ items: unknown[] }>(history).items).toHaveLength(2);
  });

  it.each([
    ['malformed JSON', '{ nope', '不是合法的 JSON'],
    ['a scalar', '42', '需要是操作数组'],
    ['an object without ops', '{"target":"#title"}', '需要是操作数组'],
    ['an empty list', '[]', '里没有任何操作'],
  ])('rejects %s', async (_label, text, reason) => {
    const { cli } = await treeProject(makeDir);

    const { code, error } = await cli.fail(['apply', '-'], text);

    expect(code).toBe(1);
    expect(error.code).toBe('E_OP_INVALID');
    expect(error.message).toContain(reason);
    expect(error.message).toContain('标准输入');
  });

  it('rejects an unknown operation and lists the nearest ones', async () => {
    const { cli } = await treeProject(makeDir);

    const { error } = await cli.fail(['apply', '-'], JSON.stringify([{ op: 'node.explode' }]));

    expect(error.code).toBe('E_OP_UNKNOWN');
    expect(error.hint).toContain('node.add');
  });

  it('rejects an operation with unexpected fields', async () => {
    const { cli } = await treeProject(makeDir);
    const ops = [{ op: 'node.remove', target: '#title', force: true }];

    const { code, error } = await cli.fail(['apply', '-'], JSON.stringify(ops));

    expect(code).toBe(1);
    expect(error.code).toBe('E_OP_INVALID');
  });

  it('fails cleanly when the file cannot be read', async () => {
    const { cli } = await treeProject(makeDir);

    const { code, error } = await cli.fail(['apply', 'missing.json']);

    expect(code).toBe(1);
    expect(error.code).toBe('E_IO');
  });

  it('is a usage error to read standard input that is not there', async () => {
    const { cli } = await treeProject(makeDir);

    const { code, error } = await cli.fail(['apply', '-']);

    expect(code).toBe(2);
    expect(error.code).toBe('E_USAGE');
  });
});
