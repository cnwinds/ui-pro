import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DECISION_POINTS, DEFAULT_PACK_FILE, defaultPack, lintProject, lintRuleSet } from '../src';
import { type Fixture, ruleOf, treeFixture, useTempDirs } from './helpers';

const makeDir = useTempDirs();

const lintDefault = (...rules: ReturnType<typeof ruleOf>[]) =>
  lintRuleSet([...defaultPack().rules, ...(rules as never)], { layer: 'default', file: 'pack' });

async function writeRules(fx: Fixture, path: string, text: string) {
  await writeFile(join(fx.project.root, ...path.split('/')), text);
}

describe('rules lint on the default pack', () => {
  it('catches a concept in a condition', () => {
    const problems = lintDefault(ruleOf('x.concept', 'hit.area', 'padded', { concept: '红点' }));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ severity: 'error', rule: 'x.concept' });
    expect(problems[0]?.message).toContain('概念');
  });

  it.each<[string, Record<string, string>]>([
    ['a genre word in the reason', { because: '背包里的格子要补全' }],
    ['a genre word in the id', { id: 'inventory.slot' }],
    ['pixel sizes in the reason', { because: '宽 100x200 以内' }],
    ['a coordinate in the reason', { because: '位于 x=100 的位置' }],
    ['a pixel length in the reason', { because: '小于 44px 的热区' }],
  ])('catches %s', (_name, extra) => {
    const problems = lintDefault(
      ruleOf('x.other', 'hit.area', 'padded', { attached: true }, extra),
    );

    expect(problems.filter((problem) => problem.severity === 'error').length).toBeGreaterThan(0);
    expect(problems[0]?.rule).toBe(extra.id ?? 'x.other');
  });

  it('catches a role outside the generic table', () => {
    const problems = lintDefault(ruleOf('x.role', 'hit.area', 'padded', { role: 'shop.entry' }));

    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('通用角色表');
  });

  it('accepts the generic roles and role prefixes', () => {
    expect(
      lintDefault(ruleOf('x.role', 'hit.area', 'padded', { role: ['badge.*', 'panel'] })),
    ).toEqual([]);
  });

  it('catches examples, which are nodes of a concrete project', () => {
    const problems = lintDefault(
      ruleOf('x.ex', 'hit.area', 'padded', { attached: true }, { examples: ['main/#a'] }),
    );

    expect(problems[0]?.message).toContain('样例');
  });

  it('catches a missing and a doubled fallback', () => {
    const without = lintRuleSet(
      defaultPack().rules.filter((rule) => rule.id !== 'hit.fallback'),
      { layer: 'default', file: 'pack' },
    );
    const doubled = lintDefault(ruleOf('hit.second-fallback', 'hit.area', 'visible'));

    expect(without.map((problem) => problem.message).join('\n')).toContain(
      '决策点 hit.area 没有兜底规则',
    );
    expect(doubled.map((problem) => problem.message).join('\n')).toContain('2 条兜底规则');
  });

  it('asks for a fallback of every point of the catalog', () => {
    const problems = lintRuleSet([], { layer: 'default', file: 'pack' });

    expect(problems).toHaveLength(DECISION_POINTS.length);
  });
});

describe('rules lint in general', () => {
  const lint = (...rules: ReturnType<typeof ruleOf>[]) =>
    lintRuleSet(rules as never, { layer: 'project', file: 'rules/project.yaml' });

  it('catches unknown points and impossible values with the catalog in the message', () => {
    const problems = lint(
      ruleOf('a', 'no.such-point', 'x'),
      ruleOf('b', 'attach.split', 'sideways'),
      ruleOf('c', 'naming.node', 'Bad Template'),
    );

    expect(problems.map((problem) => problem.rule)).toEqual(['a', 'b', 'c']);
    expect(problems[0]?.message).toContain('attach.split');
    expect(problems[1]?.message).toContain('independent、baked');
    expect(problems[2]?.message).toContain('{prefix}');
  });

  it('catches identical conditions with different values, and mere duplicates as warnings', () => {
    const problems = lint(
      ruleOf('a', 'attach.split', 'baked', { type: 'image' }),
      ruleOf('b', 'attach.split', 'independent', { type: 'image' }),
      ruleOf('d', 'attach.split', 'baked', { type: 'image' }),
    );

    expect(problems.map((problem) => [problem.severity, problem.rule])).toEqual([
      ['error', 'b'],
      ['warning', 'd'],
    ]);
  });

  it('does not hold project rules to the generality constraint', () => {
    expect(
      lint(ruleOf('shop.dot', 'attach.split', 'baked', { concept: '红点', role: 'shop.entry' })),
    ).toEqual([]);
  });

  it('marks pending rules in the message', () => {
    const problems = lintRuleSet([ruleOf('a', 'no.such-point', 'x')] as never, {
      layer: 'project',
      file: 'rules/project.yaml',
      pending: true,
    });

    expect(problems[0]?.message).toMatch(/^待定区：/);
  });
});

describe('lintProject', () => {
  it('finds nothing wrong with a fresh project', async () => {
    const fx = await treeFixture(makeDir);

    const report = lintProject(fx.project);

    expect(report.problems).toEqual([]);
    expect(report.files).toEqual([
      DEFAULT_PACK_FILE,
      'rules/project.yaml',
      'screens/main/rules.yaml',
    ]);
  });

  it('names the file of each problem', async () => {
    const fx = await treeFixture(makeDir);
    await writeRules(
      fx,
      'rules/project.yaml',
      [
        'format: ui-pro/rules',
        'version: 1',
        'rules:',
        '  - { id: bad-value, point: attach.split, value: sideways, because: 理由 }',
        '  - { id: new-concept, point: hit.area, when: { concept: 不存在的概念 }, value: padded, because: 理由 }',
        '  - { id: gone, point: hit.area, when: { type: button }, value: padded, because: 理由, examples: ["main/#ghost", "other/#a"] }',
        'disabled:',
        '  - { rule: attach.fallback@default, because: 想试试 }',
        '  - { rule: nope@default, because: 理由 }',
        '',
      ].join('\n'),
    );

    const { problems } = lintProject(fx.project);

    expect(problems.every((problem) => problem.file === 'rules/project.yaml')).toBe(true);
    const text = problems.map((problem) => `${problem.severity}:${problem.message}`).join('\n');
    expect(text).toContain('error:决策点 attach.split 没有取值 sideways');
    expect(text).toContain('warning:概念库里没有概念 不存在的概念');
    expect(text).toContain('warning:样例节点 main/#ghost 已不存在');
    expect(text).toContain('warning:样例 other/#a 所在的界面不存在');
    expect(text).toContain(
      'error:attach.fallback@default 是决策点 attach.split 的兜底规则，不能停用',
    );
    expect(text).toContain('error:停用了不存在的规则 nope@default');
  });

  it('reports a file that does not parse instead of throwing', async () => {
    const fx = await treeFixture(makeDir);
    await writeRules(fx, 'screens/main/rules.yaml', 'format: ui-pro/rules\nversion: 1\nrules: 5\n');

    const { problems } = lintProject(fx.project);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ severity: 'error', file: 'screens/main/rules.yaml' });
  });

  it('flags screen exceptions on missing nodes and at points that do not apply', async () => {
    const fx = await treeFixture(makeDir);
    await writeRules(
      fx,
      'screens/main/rules.yaml',
      [
        'format: ui-pro/rules',
        'version: 1',
        'rules: []',
        'exceptions:',
        '  - { node: ghost, point: hit.area, value: padded, because: 理由 }',
        '  - { node: title, point: hit.area, value: padded, because: 理由 }',
        '  - { node: title, point: no.such-point, value: x, because: 理由 }',
        '',
      ].join('\n'),
    );

    const { problems } = lintProject(fx.project);

    const text = problems.map((problem) => `${problem.severity}:${problem.message}`).join('\n');
    expect(text).toContain('error:节点例外指向不存在的节点 #ghost');
    expect(text).toContain('warning:节点 #title 的节点例外在 hit.area 上不会生效');
    expect(text).toContain('error:节点 #title 的节点例外：引用了不存在的决策点 no.such-point');
  });
});
