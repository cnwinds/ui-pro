import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SINGLETON_KEY } from '@ui-pro/core';
import { describe, expect, it } from 'vitest';
import { checkRules, projectRulesKind, readRuleInputs } from '../src';
import { type Fixture, node, ruleOf, treeFixture, useTempDirs } from './helpers';

const makeDir = useTempDirs();

const failed = (fx: Fixture) =>
  checkRules(readRuleInputs(fx.project)).items.filter((item) => item.status === 'fail');

describe('rules check', () => {
  it('passes on a project whose decisions are current, and skips drift', async () => {
    const fx = await treeFixture(makeDir);

    const report = checkRules(readRuleInputs(fx.project));

    expect(report.ok).toBe(true);
    expect(report.items.map((item) => item.name)).toEqual([
      '完备',
      '无歧义',
      '无漂移',
      '同形同判',
      '例外有据',
      '规则不回归',
    ]);
    expect(report.items.map((item) => item.status)).toEqual([
      'pass',
      'pass',
      'skipped',
      'pass',
      'pass',
      'pass',
    ]);
    expect(report.items[2]?.reason).toContain('资产构建');
  });

  it('fails 完备 when a rules file changed without recomputing, and passes after rule.recompute', async () => {
    const fx = await treeFixture(makeDir);
    const path = join(
      fx.project.root,
      ...projectRulesKind.path(fx.project, SINGLETON_KEY).split('/'),
    );
    const text = await fx.readText(projectRulesKind.path(fx.project, SINGLETON_KEY));
    await writeFile(
      path,
      text.replace(
        'rules: []',
        'rules:\n  - id: hand.written\n    point: attach.split\n    when: { type: image }\n    value: baked\n    because: 手写的规则\n',
      ),
    );

    const [item] = failed(fx);

    expect(item?.id).toBe('complete');
    expect(item?.problems[0]).toMatchObject({ kind: 'stale', screen: 'main', node: 'badge_dot' });
    expect(item?.problems[0]?.message).toContain('attach.split');
    expect(item?.problems[0]?.message).toContain('现为 independent，应为 baked');

    await fx.apply([{ op: 'rule.recompute' }]);
    expect(checkRules(readRuleInputs(fx.project)).ok).toBe(true);
  });

  it('fails 完备 for a decision that points at a rule that no longer exists', async () => {
    const fx = await treeFixture(makeDir);
    await fx.apply([
      { op: 'rule.adopt', rule: ruleOf('temp', 'hit.area', 'padded', { type: 'button' }) },
    ]);
    const path = join(
      fx.project.root,
      ...projectRulesKind.path(fx.project, SINGLETON_KEY).split('/'),
    );
    await writeFile(path, 'format: ui-pro/rules\nversion: 1\nrules: []\n');

    const problems = failed(fx).flatMap((item) => item.problems);

    expect(problems.map((problem) => problem.kind)).toContain('dangling');
    expect(problems.some((problem) => problem.message.includes('temp@project'))).toBe(true);
  });

  it('fails 无歧义 naming both rules and the nodes', async () => {
    const fx = await treeFixture(makeDir);
    await fx.apply([
      { op: 'rule.adopt', rule: ruleOf('image-baked', 'attach.split', 'baked', { type: 'image' }) },
      {
        op: 'rule.adopt',
        rule: ruleOf('badge-apart', 'attach.split', 'independent', { role: 'badge.notification' }),
      },
    ]);

    const report = checkRules(readRuleInputs(fx.project));
    const item = report.items.find((entry) => entry.id === 'unambiguous');

    expect(report.ok).toBe(false);
    expect(item?.status).toBe('fail');
    expect(item?.problems).toHaveLength(1);
    expect(item?.problems[0]).toMatchObject({
      screen: 'main',
      point: 'attach.split',
      rules: ['badge-apart@project', 'image-baked@project'],
      nodes: ['badge_dot'],
    });
    expect(item?.problems[0]?.message).toContain('badge-apart@project');
    expect(item?.problems[0]?.message).toContain('image-baked@project');
    expect(item?.problems[0]?.message).toContain('#badge_dot');
  });

  it('fails 规则不回归 when a higher layer changes what an example gets', async () => {
    const fx = await treeFixture(makeDir);
    await fx.apply([
      {
        op: 'rule.adopt',
        rule: ruleOf(
          'dot-baked',
          'attach.split',
          'baked',
          { type: 'image' },
          { examples: ['main/#badge_dot'] },
        ),
      },
    ]);
    expect(checkRules(readRuleInputs(fx.project)).ok).toBe(true);

    await fx.apply([
      {
        op: 'rule.adopt',
        rule: ruleOf('dot-apart', 'attach.split', 'independent', { role: 'badge.*' }),
        scope: 'screen',
      },
    ]);
    const [item] = failed(fx);

    expect(item?.id).toBe('no-regression');
    expect(item?.problems[0]).toMatchObject({ kind: 'regression', point: 'attach.split' });
    expect(item?.problems[0]?.message).toContain('dot-baked@project');
    expect(item?.problems[0]?.message).toContain('dot-apart@screen:main');
  });

  it('warns, but does not fail, about examples that no longer exist', async () => {
    const fx = await treeFixture(makeDir);
    await fx.apply([
      {
        op: 'rule.adopt',
        rule: ruleOf(
          'dot-baked',
          'attach.split',
          'baked',
          { type: 'image' },
          { examples: ['main/#badge_dot'] },
        ),
      },
    ]);
    await fx.apply([{ op: 'node.remove', target: '#badge_dot' }]);

    const report = checkRules(readRuleInputs(fx.project));
    const item = report.items.find((entry) => entry.id === 'no-regression');

    expect(report.ok).toBe(true);
    expect(item?.warnings).toEqual([
      '规则 dot-baked@project 的样例 main/#badge_dot 已不存在，无法重算',
    ]);
  });

  it('fails 例外有据 for exceptions without a reason, on missing nodes or with impossible values', async () => {
    const fx = await treeFixture(makeDir);
    const inputs = readRuleInputs(fx.project);
    const rules = inputs.screens.get('main')?.rules;
    if (!rules) throw new Error('screen rules missing');
    rules.exceptions.push(
      { node: 'badge_dot', point: 'attach.split', value: 'baked', because: '' },
      { node: 'ghost', point: 'hit.area', value: 'padded', because: '节点已经没了' },
      { node: 'btn_shop', point: 'hit.area', value: 'sideways', because: '取值不对' },
    );
    inputs.project.disabled.push({ rule: 'attach.varies-independent@default', because: ' ' });

    const item = checkRules(inputs).items.find((entry) => entry.id === 'exceptions-justified');

    expect(item?.status).toBe('fail');
    expect(item?.problems.map((problem) => problem.kind).sort()).toEqual([
      'dangling',
      'invalid',
      'no-reason',
      'no-reason',
    ]);
    expect(item?.problems.find((problem) => problem.node === 'ghost')?.message).toContain(
      '不存在的节点',
    );
  });

  it('fails 同形同判 for a cluster of mixed types', async () => {
    const fx = await treeFixture(makeDir);
    await fx.apply([
      node('a_btn', 'button', [50, 350, 200, 80], 'root'),
      node('b_img', 'image', [550, 350, 200, 80], 'root'),
    ]);
    const inputs = readRuleInputs(fx.project);
    const doc = inputs.screens.get('main')?.doc;
    if (!doc?.nodes.a_btn || !doc.nodes.b_img) throw new Error('fixture nodes missing');
    doc.nodes.a_btn.cluster = 'c1';
    doc.nodes.b_img.cluster = 'c1';

    const item = checkRules(inputs).items.find((entry) => entry.id === 'cluster-consistency');

    expect(item?.status).toBe('fail');
    expect(item?.problems[0]).toMatchObject({ screen: 'main', nodes: ['a_btn', 'b_img'] });
  });
});
