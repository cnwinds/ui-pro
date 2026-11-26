import { describe, expect, it } from 'vitest';
import { cliIn, dataOf, useTempDirs } from './helpers';

const makeDir = useTempDirs();

describe('ui-pro schema', () => {
  it('lists every operation without needing a project', async () => {
    const cli = cliIn(await makeDir());

    const envelope = await cli.ok(['schema']);

    const { ops } = dataOf<{ ops: Array<{ name: string; family: string; summary: string }> }>(
      envelope,
    );
    expect(ops.map((op) => op.name)).toEqual([
      'node.add',
      'node.set',
      'node.split',
      'node.merge',
      'node.move',
      'node.remove',
      'node.rename',
      'cluster.split',
      'exclusion.add',
      'exclusion.remove',
      'concept.define',
      'component.extract',
      'pin.set',
      'pin.clear',
      'layout.set',
      'state.set',
      'bind.set',
      'rule.propose',
      'rule.adopt',
      'rule.disable',
      'rule.enable',
      'rule.remove',
      'exception.add',
      'exception.remove',
      'rule.recompute',
    ]);
    expect(envelope.summary).toBe('共 25 个操作');
    expect(envelope.next).toEqual(['ui-pro schema <op>  # 查看某个操作的参数']);
  });

  it('prints the JSON Schema of one operation', async () => {
    const cli = cliIn(await makeDir());

    const envelope = await cli.ok(['schema', 'node.set']);

    const data = dataOf<{ name: string; family: string; schema: Record<string, unknown> }>(
      envelope,
    );
    expect(data).toMatchObject({ name: 'node.set', family: 'structure' });
    expect(data.schema).toMatchObject({
      type: 'object',
      required: ['op', 'target', 'set'],
      additionalProperties: false,
      properties: { op: { const: 'node.set' } },
    });
  });

  it('fails for an unknown operation', async () => {
    const cli = cliIn(await makeDir());

    const { code, error } = await cli.fail(['schema', 'node.explode']);

    expect(code).toBe(1);
    expect(error.code).toBe('E_OP_UNKNOWN');
    expect(error.hint).toContain('node.add');
  });
});
