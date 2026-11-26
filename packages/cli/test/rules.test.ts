import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerPlugins } from '../src/plugins';
import { type Cli, dataOf, treeProject, useTempDirs } from './helpers';

const makeDir = useTempDirs();

beforeAll(() => registerPlugins());

interface Decision {
  value: string;
  by: string;
}

interface Applied {
  dryRun: boolean;
  version?: number;
  changes: { screens: Record<string, { modified: Record<string, string[]> }> };
}

interface Listed {
  total: number;
  items: Array<{
    ref: string;
    layer: string;
    point: string;
    fallback?: boolean;
    disabledBecause?: string;
  }>;
}

interface Explained {
  total: number;
  items: Array<{
    id: string;
    points: Array<{
      point: string;
      status: string;
      value?: string;
      by?: string;
      rules: Array<{ ref: string; verdict: string }>;
    }>;
  }>;
}

interface Check {
  id: string;
  name: string;
  status: string;
  problems: Array<{ message: string; rules?: string[]; nodes?: string[] }>;
}

const apply = (cli: Cli, ops: unknown[], ...flags: string[]) =>
  cli.ok(['apply', '-', ...flags], JSON.stringify(ops));

async function decisionsOf(cli: Cli, selector: string): Promise<Record<string, Decision>> {
  const envelope = await cli.ok(['query', selector, '--fields', 'decisions']);
  const [item] = dataOf<{ items: Array<{ decisions: Record<string, Decision> }> }>(envelope).items;
  return item?.decisions ?? {};
}

const dotBaked = {
  id: 'attach.dot-baked',
  point: 'attach.split',
  when: { concept: '红点' },
  value: 'baked',
  because: '红点画在按钮的描边上，运行时不会变',
};

describe('decisions after apply', () => {
  it('exist for every node with a real rule behind them', async () => {
    const { cli } = await treeProject(makeDir);

    await apply(cli, [{ op: 'node.set', target: '#title', set: { rect: [300, 300, 500, 80] } }]);

    const envelope = await cli.ok(['query', '*', '--fields', 'decisions', '--limit', '50']);
    const items = dataOf<{ items: Array<{ id: string; decisions: Record<string, Decision> }> }>(
      envelope,
    ).items;
    expect(items.length).toBeGreaterThanOrEqual(7);
    for (const item of items) {
      expect(item.decisions['naming.node'], item.id).toBeDefined();
      for (const [point, decision] of Object.entries(item.decisions)) {
        expect(decision.by, `${item.id} ${point}`).toMatch(/@default$/);
      }
    }
    expect((await decisionsOf(cli, '#badge_dot'))['attach.split']).toEqual({
      value: 'independent',
      by: 'attach.varies-independent@default',
    });
  });

  it('list the rule operations in ui-pro schema', async () => {
    const { cli } = await treeProject(makeDir);

    const envelope = await cli.ok(['schema']);

    const names = dataOf<{ ops: Array<{ name: string; family: string }> }>(envelope)
      .ops.filter((op) => op.family === 'rules')
      .map((op) => op.name);
    expect(names).toEqual([
      'rule.propose',
      'rule.adopt',
      'rule.disable',
      'rule.enable',
      'rule.remove',
      'exception.add',
      'exception.remove',
      'rule.recompute',
    ]);
  });
});

describe('the red-dot flow through the command line (DESIGN §5.5)', () => {
  it('proposes, previews, adopts and undoes', async () => {
    const { cli } = await treeProject(makeDir);

    const proposed = await apply(cli, [{ op: 'rule.propose', rule: dotBaked }]);

    expect(dataOf<Applied>(proposed).changes.screens.main?.modified.badge_dot).toBeUndefined();
    expect(proposed.warnings?.join('\n')).toContain(
      'main/#badge_dot 的 attach.split：independent → baked',
    );
    expect(proposed.ask).toEqual([
      expect.objectContaining({
        id: 'scope',
        options: ['project', 'screen', 'node'],
        default: 'project',
      }),
    ]);
    expect((await decisionsOf(cli, '#badge_dot'))['attach.split']?.value).toBe('independent');
    const pending = await cli.ok(['rules', 'list', '--pending']);
    expect(dataOf<Listed>(pending).items.map((item) => item.ref)).toEqual([
      'attach.dot-baked@project',
    ]);
    expect(pending.summary).toBe('待定区有 1 条规则（尚未生效）');

    const preview = await apply(cli, [{ op: 'rule.adopt', id: 'attach.dot-baked' }], '--dry-run');
    expect(dataOf<Applied>(preview).dryRun).toBe(true);
    expect(dataOf<Applied>(preview).changes.screens.main?.modified.badge_dot).toContain(
      'decisions',
    );
    expect((await decisionsOf(cli, '#badge_dot'))['attach.split']?.value).toBe('independent');

    const adopted = await apply(cli, [{ op: 'rule.adopt', id: 'attach.dot-baked' }]);
    expect(dataOf<Applied>(adopted).changes.screens.main?.modified.badge_dot).toContain(
      'decisions',
    );
    expect((await decisionsOf(cli, '#badge_dot'))['attach.split']).toEqual({
      value: 'baked',
      by: 'attach.dot-baked@project',
    });
    const why = await cli.ok(['rules', 'why', '#badge_dot', '--point', 'attach.split']);
    const [point] = dataOf<Explained>(why).items[0]?.points ?? [];
    expect(point).toMatchObject({
      status: 'decided',
      value: 'baked',
      by: 'attach.dot-baked@project',
    });
    expect(point?.rules.map((rule) => rule.verdict)).toEqual([
      'winner',
      'lower-layer',
      'lower-layer',
    ]);

    await cli.ok(['history', 'undo']);
    expect((await decisionsOf(cli, '#badge_dot'))['attach.split']?.value).toBe('independent');
  });
});

describe('ui-pro rules list', () => {
  it('lists the default pack with a count per layer', async () => {
    const { cli } = await treeProject(makeDir);

    const envelope = await cli.ok(['rules', 'list', '--limit', '1000']);

    const data = dataOf<Listed>(envelope);
    expect(envelope.summary).toBe(
      `共 ${data.total} 条生效的规则（默认规则包 ${data.total} 条、项目规则 0 条、界面规则 0 条）`,
    );
    expect(data.items.filter((item) => item.fallback)).toHaveLength(18);
  });

  it('filters by point and layer', async () => {
    const { cli } = await treeProject(makeDir);
    await apply(cli, [{ op: 'rule.adopt', rule: dotBaked }]);

    const byPoint = await cli.ok(['rules', 'list', '--point', 'attach.split']);
    const byLayer = await cli.ok(['rules', 'list', '--layer', 'project']);

    expect(dataOf<Listed>(byPoint).items.map((item) => item.ref)).toEqual([
      'attach.varies-independent@default',
      'attach.interactive-independent@default',
      'attach.fallback@default',
      'attach.dot-baked@project',
    ]);
    expect(dataOf<Listed>(byLayer).items.map((item) => item.ref)).toEqual([
      'attach.dot-baked@project',
    ]);
  });

  it('pages and suggests the next page', async () => {
    const { cli } = await treeProject(makeDir);

    const first = await cli.ok(['rules', 'list', '--limit', '5']);
    const second = await cli.ok(['rules', 'list', '--limit', '5', '--offset', '5']);

    expect(dataOf<Listed>(first).items).toHaveLength(5);
    expect(first.next).toEqual(['ui-pro rules list --offset 5']);
    expect(dataOf<Listed>(second).items[0]?.ref).not.toBe(dataOf<Listed>(first).items[0]?.ref);
  });

  it('lists disabled rules with their reasons', async () => {
    const { cli } = await treeProject(makeDir);
    await apply(cli, [{ op: 'rule.disable', rule: 'hit.small-padded', because: '热区够大了' }]);

    const envelope = await cli.ok(['rules', 'list', '--disabled']);

    expect(envelope.summary).toBe('已停用 1 条规则');
    expect(dataOf<Listed>(envelope).items).toMatchObject([
      { ref: 'hit.small-padded@default', disabledBecause: '热区够大了' },
    ]);
  });

  it('rejects contradictory flags and unknown points as usage errors', async () => {
    const { cli } = await treeProject(makeDir);

    const both = await cli.fail(['rules', 'list', '--pending', '--disabled']);
    const unknown = await cli.fail(['rules', 'list', '--point', 'no.such-point']);

    expect(both.code).toBe(2);
    expect(unknown.code).toBe(2);
    expect(unknown.error.message).toContain('no.such-point');
    expect(unknown.error.hint).toContain('attach.split');
  });
});

describe('ui-pro rules why', () => {
  it('explains every applicable point of a node', async () => {
    const { cli } = await treeProject(makeDir);

    const envelope = await cli.ok(['rules', 'why', '#btn_upgrade']);

    const [item] = dataOf<Explained>(envelope).items;
    const points = item?.points.map((point) => point.point) ?? [];
    expect(points).toEqual(
      expect.arrayContaining(['press.feedback', 'hit.area', 'state.source', 'layout.anchor']),
    );
    expect(item?.points.every((point) => point.status === 'decided')).toBe(true);
    expect(envelope.summary).toBe(`main/#btn_upgrade：${points.length} 个适用的决策点`);
  });

  it('limits the nodes explained when the selector matches many', async () => {
    const { cli } = await treeProject(makeDir);

    const envelope = await cli.ok([
      'rules',
      'why',
      'button',
      '--limit',
      '1',
      '--point',
      'hit.area',
    ]);

    const data = dataOf<Explained>(envelope);
    expect(data.total).toBe(3);
    expect(data.items).toHaveLength(1);
    expect(envelope.summary).toBe('匹配 3 个节点，解释了其中 1 个');
  });

  it('fails when the selector matches nothing', async () => {
    const { cli } = await treeProject(makeDir);

    const { code, error } = await cli.fail(['rules', 'why', '#ghost']);

    expect(code).toBe(1);
    expect(error.code).toBe('E_SELECTOR_EMPTY');
  });

  it('names the exception that decides', async () => {
    const { cli } = await treeProject(makeDir);
    await apply(cli, [
      {
        op: 'exception.add',
        target: '#badge_dot',
        point: 'attach.split',
        value: 'baked',
        because: '这个红点画在描边上',
      },
    ]);

    const envelope = await cli.ok(['rules', 'why', '#badge_dot', '--point', 'attach.split']);

    const [point] = dataOf<Explained>(envelope).items[0]?.points ?? [];
    expect(point).toMatchObject({ value: 'baked', by: 'exception' });
    expect(point?.rules.every((rule) => rule.verdict === 'exception')).toBe(true);
  });
});

describe('ui-pro rules check', () => {
  it('passes on a fresh project', async () => {
    const { cli } = await treeProject(makeDir);

    const envelope = await cli.ok(['rules', 'check']);

    expect(envelope.summary).toBe('规则检查通过：5 项通过，1 项跳过（无漂移）');
    expect(dataOf<{ ok: boolean; checks: Check[] }>(envelope).checks).toHaveLength(6);
  });

  it('fails on ambiguity, naming both rules and the nodes', async () => {
    const { cli } = await treeProject(makeDir);
    await apply(cli, [
      {
        op: 'rule.adopt',
        rule: {
          id: 'image-baked',
          point: 'attach.split',
          when: { type: 'image' },
          value: 'baked',
          because: '理由一',
        },
      },
      {
        op: 'rule.adopt',
        rule: {
          id: 'badge-apart',
          point: 'attach.split',
          when: { role: 'badge.notification' },
          value: 'independent',
          because: '理由二',
        },
      },
    ]);

    const { code, error } = await cli.fail(['rules', 'check']);

    expect(code).toBe(1);
    expect(error.code).toBe('E_RULES_CHECK');
    expect(error.message).toBe('规则检查未通过：无歧义（共 1 个问题）');
    const { checks } = error.details as { checks: Check[] };
    const item = checks.find((entry) => entry.id === 'unambiguous');
    expect(item?.problems[0]?.rules).toEqual(['badge-apart@project', 'image-baked@project']);
    expect(item?.problems[0]?.nodes).toEqual(['badge_dot']);
    expect(item?.problems[0]?.message).toContain('badge-apart@project');
    expect(item?.problems[0]?.message).toContain('image-baked@project');
    expect(item?.problems[0]?.message).toContain('#badge_dot');
    expect(error.hint).toContain('rule.recompute');
  });

  it('fails on stale decisions until rule.recompute refreshes them', async () => {
    const { dir, cli } = await treeProject(makeDir);
    const path = join(dir, 'rules', 'project.yaml');
    const text = await readFile(path, 'utf8');
    await writeFile(
      path,
      text.replace(
        'rules: []',
        'rules:\n  - { id: by-hand, point: attach.split, when: { type: image }, value: baked, because: 手写的规则 }',
      ),
    );

    const failed = await cli.fail(['rules', 'check']);
    await apply(cli, [{ op: 'rule.recompute' }]);
    const passed = await cli.ok(['rules', 'check']);

    expect(failed.error.message).toBe('规则检查未通过：完备（共 1 个问题）');
    expect(passed.summary).toContain('规则检查通过');
  });
});

describe('node exceptions through the command line', () => {
  const exception = {
    op: 'exception.add',
    target: '#badge_dot',
    point: 'attach.split',
    value: 'baked',
    because: '这个红点画在按钮的描边上',
  };

  it('are rejected without a reason', async () => {
    const { cli } = await treeProject(makeDir);
    const { because: _, ...missing } = exception;

    const withoutField = await cli.fail(['apply', '-'], JSON.stringify([missing]));
    const blank = await cli.fail(['apply', '-'], JSON.stringify([{ ...exception, because: ' ' }]));

    expect(withoutField.error.code).toBe('E_OP_INVALID');
    expect(blank.error.code).toBe('E_OP_INVALID');
    expect(blank.error.message).toContain('必须写理由');
  });

  it('follow a renamed node and are dropped, with a warning, for a deleted one', async () => {
    const { cli } = await treeProject(makeDir);
    await apply(cli, [exception]);

    await apply(cli, [{ op: 'node.rename', target: '#badge_dot', id: 'dot' }]);
    expect((await decisionsOf(cli, '#dot'))['attach.split']).toEqual({
      value: 'baked',
      by: 'exception',
    });
    const removed = await apply(cli, [{ op: 'node.remove', target: '#dot' }]);

    expect(removed.warnings?.join('\n')).toContain('节点 #dot 已不存在');
    expect((await cli.ok(['rules', 'check'])).summary).toContain('规则检查通过');
  });
});

describe('ui-pro rules lint', () => {
  it('passes on a fresh project', async () => {
    const { cli } = await treeProject(makeDir);

    const envelope = await cli.ok(['rules', 'lint']);

    expect(envelope.summary).toBe('规则文件检查通过：3 个文件，0 个警告');
    expect(dataOf<{ files: string[] }>(envelope).files).toEqual([
      'packages/rules/pack/default.rules.yaml',
      'rules/project.yaml',
      'screens/main/rules.yaml',
    ]);
  });

  it('fails on a rule that names an impossible value', async () => {
    const { dir, cli } = await treeProject(makeDir);
    await writeFile(
      join(dir, 'rules', 'project.yaml'),
      'format: ui-pro/rules\nversion: 1\nrules:\n  - { id: bad, point: attach.split, value: sideways, because: 理由 }\n',
    );

    const { code, error } = await cli.fail(['rules', 'lint']);

    expect(code).toBe(1);
    expect(error.code).toBe('E_RULES_LINT');
    expect(error.message).toBe('规则文件检查未通过：1 个错误、0 个警告');
    const { problems } = error.details as {
      problems: Array<{ file: string; rule: string; message: string }>;
    };
    expect(problems[0]).toMatchObject({ file: 'rules/project.yaml', rule: 'bad' });
    expect(problems[0]?.message).toContain('independent、baked');
  });

  it('reports warnings without failing', async () => {
    const { dir, cli } = await treeProject(makeDir);
    await writeFile(
      join(dir, 'rules', 'project.yaml'),
      'format: ui-pro/rules\nversion: 1\nrules:\n  - { id: a, point: hit.area, when: { concept: 没有这个概念 }, value: padded, because: 理由 }\n',
    );

    const envelope = await cli.ok(['rules', 'lint']);

    expect(envelope.summary).toBe('规则文件检查通过：3 个文件，1 个警告');
    expect(envelope.warnings?.[0]).toContain('概念库里没有概念 没有这个概念');
  });
});
