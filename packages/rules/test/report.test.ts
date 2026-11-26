import { describe, expect, it } from 'vitest';
import { defaultPack, explainNodes, listRules, readRuleInputs } from '../src';
import { ruleOf, treeFixture, useTempDirs } from './helpers';

const makeDir = useTempDirs();

describe('listRules', () => {
  it('lists the default pack, project rules and screen rules in that order', async () => {
    const fx = await treeFixture(makeDir);
    await fx.apply([
      { op: 'rule.adopt', rule: ruleOf('proj-one', 'hit.area', 'padded', { type: 'button' }) },
      {
        op: 'rule.adopt',
        rule: ruleOf('screen-one', 'hit.area', 'visible', { type: 'button' }),
        scope: 'screen',
      },
    ]);

    const items = listRules(readRuleInputs(fx.project));

    expect(items).toHaveLength(defaultPack().rules.length + 2);
    expect(items.slice(-2).map((item) => item.ref)).toEqual([
      'proj-one@project',
      'screen-one@screen:main',
    ]);
    expect(items[0]).toMatchObject({ layer: 'default', ref: 'attach.varies-independent@default' });
    expect(items.filter((item) => item.fallback)).toHaveLength(18);
  });

  it('filters by point, layer and screen', async () => {
    const fx = await treeFixture(makeDir);
    await fx.apply([
      { op: 'rule.adopt', rule: ruleOf('proj-one', 'hit.area', 'padded', { type: 'button' }) },
    ]);
    const inputs = readRuleInputs(fx.project);

    expect(listRules(inputs, { point: 'hit.area' }).map((item) => item.ref)).toEqual([
      'hit.small-padded@default',
      'hit.fallback@default',
      'proj-one@project',
    ]);
    expect(listRules(inputs, { layer: 'project' }).map((item) => item.ref)).toEqual([
      'proj-one@project',
    ]);
    expect(listRules(inputs, { layer: 'screen' })).toEqual([]);
    expect(listRules(inputs, { screen: 'other', layer: 'project' })).toHaveLength(1);
  });

  it('shows pending rules and disabled rules with their reasons', async () => {
    const fx = await treeFixture(makeDir);
    await fx.apply([
      { op: 'rule.propose', rule: ruleOf('wait', 'hit.area', 'padded') },
      { op: 'rule.disable', rule: 'hit.small-padded', because: '热区够大了' },
    ]);
    const inputs = readRuleInputs(fx.project);

    const pending = listRules(inputs, { mode: 'pending' });
    const disabled = listRules(inputs, { mode: 'disabled' });
    const effective = listRules(inputs);

    expect(pending.map((item) => item.ref)).toEqual(['wait@project']);
    expect(disabled).toHaveLength(1);
    expect(disabled[0]).toMatchObject({
      ref: 'hit.small-padded@default',
      disabledBecause: '热区够大了',
    });
    expect(effective.some((item) => item.ref === 'hit.small-padded@default')).toBe(false);
    expect(effective.some((item) => item.ref === 'wait@project')).toBe(false);
  });
});

describe('explainNodes', () => {
  it('explains the winner and the rules it beat, per decision point', async () => {
    const fx = await treeFixture(makeDir);
    await fx.apply([
      { op: 'rule.adopt', rule: ruleOf('dot-baked', 'attach.split', 'baked', { type: 'image' }) },
    ]);

    const [explained] = explainNodes(
      readRuleInputs(fx.project),
      [{ screen: 'main', id: 'badge_dot' }],
      { point: 'attach.split' },
    );

    expect(explained).toMatchObject({
      screen: 'main',
      id: 'badge_dot',
      type: 'image',
      role: 'badge.notification',
    });
    expect(explained?.points).toHaveLength(1);
    const [point] = explained?.points ?? [];
    expect(point).toMatchObject({
      point: 'attach.split',
      status: 'decided',
      value: 'baked',
      by: 'dot-baked@project',
    });
    expect(point?.because).toBe('测试用的理由');
    expect(point?.rules.map((trace) => [trace.ref, trace.verdict])).toEqual([
      ['dot-baked@project', 'winner'],
      ['attach.varies-independent@default', 'lower-layer'],
      ['attach.fallback@default', 'lower-layer'],
    ]);
    expect(point?.stored).toBeUndefined();
  });

  it('lists every applicable point when none is named, and reads facts', async () => {
    const fx = await treeFixture(makeDir);

    const [explained] = explainNodes(readRuleInputs(fx.project), [
      { screen: 'main', id: 'badge_dot' },
    ]);

    const names = explained?.points.map((point) => point.point) ?? [];
    expect(names).toContain('attach.split');
    expect(names).toContain('layout.anchor');
    expect(names).not.toContain('text.mode');
    expect(explained?.facts).toMatchObject({
      attached: true,
      position: 'top-right',
      varies: ['visibility'],
    });
  });

  it('shows the stored decision when it differs from the current rules', async () => {
    const fx = await treeFixture(makeDir);
    const inputs = readRuleInputs(fx.project);
    const stored = inputs.screens.get('main')?.doc.nodes.badge_dot;
    if (!stored) throw new Error('fixture node missing');
    stored.decisions['attach.split'] = { value: 'baked', by: 'old@project' };

    const [explained] = explainNodes(inputs, [{ screen: 'main', id: 'badge_dot' }], {
      point: 'attach.split',
    });

    expect(explained?.points[0]?.stored).toEqual({ value: 'baked', by: 'old@project' });
  });

  it('skips nodes that do not exist', async () => {
    const fx = await treeFixture(makeDir);

    expect(explainNodes(readRuleInputs(fx.project), [{ screen: 'main', id: 'ghost' }])).toEqual([]);
  });
});
