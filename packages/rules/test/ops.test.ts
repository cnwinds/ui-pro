import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SINGLETON_KEY, undo } from '@ui-pro/core';
import { describe, expect, it } from 'vitest';
import {
  decisionsOf,
  evaluate,
  projectRulesKind,
  readRuleInputs,
  registerRules,
  screenRulesKind,
} from '../src';
import {
  addSecondScreen,
  type Fixture,
  failureOf,
  newRegistry,
  node,
  ruleOf,
  treeFixture,
  useTempDirs,
} from './helpers';

const makeDir = useTempDirs();

const projectFile = (fx: Fixture) => projectRulesKind.path(fx.project, SINGLETON_KEY);
const screenFile = (fx: Fixture, name = 'main') => screenRulesKind.path(fx.project, name);
const decision = (fx: Fixture, id: string, point: string) => fx.load().nodes[id]?.decisions[point];

const dotBaked = ruleOf('attach.dot-baked', 'attach.split', 'baked', {
  role: 'badge.notification',
});

describe('decisions kept up to date by the beforeCommit hook', () => {
  it('give every node every applicable decision with a real rule behind it', async () => {
    const fx = await treeFixture(makeDir);

    const inputs = readRuleInputs(fx.project);
    const evaluation = evaluate(inputs);
    const doc = fx.load();
    let decided = 0;
    for (const [id, evaluated] of evaluation.screens.get('main') ?? []) {
      const stored = doc.nodes[id]?.decisions ?? {};
      expect(stored, id).toEqual(decisionsOf(evaluated));
      for (const [point, outcome] of evaluated.outcomes) {
        expect(stored[point], `${id} ${point}`).toBeDefined();
        expect(outcome.status).toBe('decided');
        expect(stored[point]?.by, `${id} ${point}`).toMatch(/@default$/);
        decided += 1;
      }
    }
    expect(decided).toBeGreaterThan(30);
    expect(doc.nodes.root?.decisions['naming.node']?.value).toBe('{prefix}_{semantic}_{index}');
    expect(doc.nodes.root?.decisions['layout.anchor']).toBeUndefined();
  });

  it('decide the red dot as an independent node because it varies', async () => {
    const fx = await treeFixture(makeDir);

    expect(decision(fx, 'badge_dot', 'attach.split')).toEqual({
      value: 'independent',
      by: 'attach.varies-independent@default',
    });
    expect(decision(fx, 'badge_dot', 'layout.anchor')).toEqual({
      value: 'top-right',
      by: 'layout.anchor-top-right@default',
    });
    expect(decision(fx, 'btn_upgrade', 'press.feedback')?.value).toBe('scale');
    expect(decision(fx, 'btn_upgrade', 'hit.area')?.value).toBe('visible');
    expect(decision(fx, 'title', 'text.mode')?.value).toBe('dynamic');
  });

  it('refresh decisions after any op, not only after rule ops', async () => {
    const fx = await treeFixture(makeDir);

    await fx.apply([{ op: 'node.set', target: '#badge_dot', set: { role: null, varies: [] } }]);

    expect(decision(fx, 'badge_dot', 'attach.split')).toEqual({
      value: 'baked',
      by: 'attach.fallback@default',
    });
  });

  it('give nodes added later their decisions too', async () => {
    const fx = await treeFixture(makeDir);

    await fx.apply([node('hint', 'text', [10, 10, 100, 30], 'root', { text: { content: 'a' } })]);

    expect(decision(fx, 'hint', 'text.mode')?.value).toBe('dynamic');
    expect(decision(fx, 'hint', 'naming.node')).toBeDefined();
  });

  it('give nodes with equal facts equal decisions', async () => {
    const fx = await treeFixture(makeDir);
    await fx.apply([
      node('panel_a', 'container', [0, 300, 500, 300], 'root'),
      node('panel_b', 'container', [500, 300, 500, 300], 'root'),
      node('a_btn', 'button', [50, 350, 200, 80], 'panel_a'),
      node('b_btn', 'button', [550, 350, 200, 80], 'panel_b'),
    ]);
    const inputs = readRuleInputs(fx.project);
    const doc = inputs.screens.get('main')?.doc;
    if (!doc?.nodes.a_btn || !doc.nodes.b_btn) throw new Error('fixture nodes missing');
    doc.nodes.a_btn.cluster = 'c1';
    doc.nodes.b_btn.cluster = 'c1';

    const nodes = evaluate(inputs).screens.get('main');
    const a = nodes?.get('a_btn');
    const b = nodes?.get('b_btn');

    expect(a?.facts).toEqual(b?.facts);
    expect(a && decisionsOf(a)).toEqual(b && decisionsOf(b));
    expect(a?.facts.repeat).toBe(2);
    expect(a?.outcomes.get('repeat.mode')?.decision?.value).toBe('component');
  });
});

describe('the red-dot flow (DESIGN §5.5)', () => {
  it('proposes without changing decisions, adopts, and undoes', async () => {
    const fx = await treeFixture(makeDir);
    const before = await fx.readText(projectFile(fx));

    const proposed = await fx.apply([{ op: 'rule.propose', rule: dotBaked }]);

    expect(decision(fx, 'badge_dot', 'attach.split')?.value).toBe('independent');
    expect(proposed.changes.screens.main?.modified.badge_dot).toBeUndefined();
    expect(proposed.changes.docs).toEqual([projectFile(fx)]);
    expect(proposed.warnings.join('\n')).toContain(
      'main/#badge_dot 的 attach.split：independent → baked',
    );
    expect(proposed.warnings[0]).toContain('会改变 1 处决定');
    expect(proposed.ask).toEqual([
      expect.objectContaining({
        id: 'scope',
        options: ['project', 'screen', 'node'],
        default: 'project',
      }),
    ]);
    const pending = projectRulesKind.parse(await fx.readText(projectFile(fx)), 'x');
    expect(pending.pending.map((rule) => rule.id)).toEqual(['attach.dot-baked']);
    expect(pending.rules).toEqual([]);

    const afterPropose = await fx.readText(projectFile(fx));
    const dry = await fx.apply([{ op: 'rule.adopt', id: 'attach.dot-baked' }], { dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.changes.screens.main?.modified.badge_dot).toContain('decisions');
    expect(await fx.readText(projectFile(fx))).toBe(afterPropose);
    expect(decision(fx, 'badge_dot', 'attach.split')?.value).toBe('independent');

    const adopted = await fx.apply([{ op: 'rule.adopt', id: 'attach.dot-baked' }]);
    expect(adopted.changes.screens.main?.modified.badge_dot).toContain('decisions');
    expect(decision(fx, 'badge_dot', 'attach.split')).toEqual({
      value: 'baked',
      by: 'attach.dot-baked@project',
    });
    const live = projectRulesKind.parse(await fx.readText(projectFile(fx)), 'x');
    expect(live.rules.map((rule) => rule.id)).toEqual(['attach.dot-baked']);
    expect(live.pending).toEqual([]);

    await undo(fx.project);
    expect(decision(fx, 'badge_dot', 'attach.split')?.value).toBe('independent');
    expect(await fx.readText(projectFile(fx))).toBe(afterPropose);
    expect(afterPropose).not.toBe(before);
  });

  it('says so when a proposed rule would change nothing', async () => {
    const fx = await treeFixture(makeDir);

    const proposed = await fx.apply([
      {
        op: 'rule.propose',
        rule: ruleOf('hit.never', 'hit.area', 'padded', { type: 'image', interactive: true }),
      },
    ]);

    expect(proposed.warnings).toEqual(['这条规则按整个项目生效，不会改变任何节点的任何决定']);
  });

  it('lists the impact across screens', async () => {
    const fx = await treeFixture(makeDir);
    await addSecondScreen(fx, 'shop');
    await fx.apply(
      [node('dot2', 'image', [980, 10, 30, 30], 'root', { role: 'badge.notification' })],
      { screen: 'shop' },
    );
    await fx.apply([
      node('card', 'image', [900, 20, 100, 100], 'root'),
      node('dot_on_card', 'image', [980, 20, 30, 30], 'card', { role: 'badge.notification' }),
    ]);

    const proposed = await fx.apply([{ op: 'rule.propose', rule: dotBaked }]);

    expect(proposed.warnings[0]).toContain('涉及 1 个界面');
    expect(proposed.warnings.join('\n')).toContain('main/#dot_on_card');
  });
});

describe('rule.adopt', () => {
  it('writes a screen rule into that screen only', async () => {
    const fx = await treeFixture(makeDir);
    await addSecondScreen(fx, 'shop');

    await fx.apply([{ op: 'rule.adopt', rule: dotBaked, scope: 'screen' }]);

    expect(decision(fx, 'badge_dot', 'attach.split')?.by).toBe('attach.dot-baked@screen:main');
    const screen = screenRulesKind.parse(await fx.readText(screenFile(fx)), 'x');
    expect(screen.rules.map((rule) => rule.id)).toEqual(['attach.dot-baked']);
    const other = screenRulesKind.parse(await fx.readText(screenFile(fx, 'shop')), 'x');
    expect(other.rules).toEqual([]);
  });

  it('takes the rule directly and removes it from the pending area', async () => {
    const fx = await treeFixture(makeDir);
    await fx.apply([{ op: 'rule.propose', rule: dotBaked }]);

    await fx.apply([{ op: 'rule.adopt', id: 'attach.dot-baked', scope: 'screen', screen: 'main' }]);

    const project = projectRulesKind.parse(await fx.readText(projectFile(fx)), 'x');
    expect(project.pending).toEqual([]);
    expect(project.rules).toEqual([]);
  });

  it('needs exactly one of id and rule', async () => {
    const fx = await treeFixture(makeDir);

    const neither = await failureOf(fx.apply([{ op: 'rule.adopt' }]));
    const both = await failureOf(fx.apply([{ op: 'rule.adopt', id: 'x', rule: dotBaked }]));

    expect(neither.code).toBe('E_OP_INVALID');
    expect(both.code).toBe('E_OP_INVALID');
  });

  it('rejects an id that is not pending, a duplicate id and impossible values', async () => {
    const fx = await treeFixture(makeDir);
    await fx.apply([{ op: 'rule.adopt', rule: dotBaked }]);

    const missing = await failureOf(fx.apply([{ op: 'rule.adopt', id: 'nope' }]));
    const duplicate = await failureOf(fx.apply([{ op: 'rule.adopt', rule: dotBaked }]));
    const badValue = await failureOf(
      fx.apply([{ op: 'rule.adopt', rule: ruleOf('bad', 'attach.split', 'sideways') }]),
    );
    const badPoint = await failureOf(
      fx.apply([{ op: 'rule.adopt', rule: ruleOf('bad', 'no.such-point', 'x') }]),
    );

    expect(missing.code).toBe('E_RULE_NOT_FOUND');
    expect(duplicate.code).toBe('E_RULE_EXISTS');
    expect(badValue.code).toBe('E_RULE_INVALID');
    expect(badValue.message).toContain('baked');
    expect(badPoint.code).toBe('E_RULE_INVALID');
    expect(badPoint.hint).toContain('attach.split');
  });

  it('refuses examples that name nodes which do not exist', async () => {
    const fx = await treeFixture(makeDir);

    const error = await failureOf(
      fx.apply([
        {
          op: 'rule.adopt',
          rule: ruleOf('with-example', 'attach.split', 'baked', {}, { examples: ['main/#ghost'] }),
        },
      ]),
    );

    expect(error.message).toContain('ghost');
  });

  it('warns when an example still does not get the adopted value', async () => {
    const fx = await treeFixture(makeDir);
    await fx.apply([
      {
        op: 'rule.adopt',
        rule: ruleOf('stronger', 'attach.split', 'independent', { type: 'image', attached: true }),
      },
    ]);

    const result = await fx.apply([
      {
        op: 'rule.adopt',
        rule: ruleOf(
          'weaker',
          'attach.split',
          'baked',
          { type: 'image' },
          { examples: ['main/#badge_dot'] },
        ),
      },
    ]);

    expect(result.warnings.join('\n')).toContain(
      '样例 main/#badge_dot 在 attach.split 上仍是independent',
    );
  });
});

describe('rule.disable and rule.enable', () => {
  it('switches a default rule off and back on', async () => {
    const fx = await treeFixture(makeDir);

    await fx.apply([
      {
        op: 'rule.disable',
        rule: 'attach.varies-independent@default',
        because: '本项目的红点都画在底板上',
      },
    ]);
    expect(decision(fx, 'badge_dot', 'attach.split')).toEqual({
      value: 'baked',
      by: 'attach.fallback@default',
    });

    await fx.apply([{ op: 'rule.enable', rule: 'attach.varies-independent' }]);
    expect(decision(fx, 'badge_dot', 'attach.split')?.by).toBe('attach.varies-independent@default');
  });

  it('needs a reason', async () => {
    const fx = await treeFixture(makeDir);

    const error = await failureOf(
      fx.apply([{ op: 'rule.disable', rule: 'attach.varies-independent', because: '  ' }]),
    );

    expect(error.code).toBe('E_OP_INVALID');
    expect(error.message).toContain('必须写理由');
  });

  it('refuses to disable a fallback', async () => {
    const fx = await treeFixture(makeDir);

    const error = await failureOf(
      fx.apply([{ op: 'rule.disable', rule: 'attach.fallback@default', because: '想试试' }]),
    );

    expect(error.code).toBe('E_RULE_PROTECTED');
  });

  it('refuses unknown rules, screen rules and ambiguous bare ids', async () => {
    const fx = await treeFixture(makeDir);
    await fx.apply([
      { op: 'rule.adopt', rule: ruleOf('attach.varies-independent', 'attach.split', 'baked') },
    ]);

    const unknown = await failureOf(
      fx.apply([{ op: 'rule.disable', rule: 'nope', because: '理由' }]),
    );
    const screen = await failureOf(
      fx.apply([{ op: 'rule.disable', rule: 'x@screen:main', because: '理由' }]),
    );
    const both = await failureOf(
      fx.apply([{ op: 'rule.disable', rule: 'attach.varies-independent', because: '理由' }]),
    );
    const notDisabled = await failureOf(fx.apply([{ op: 'rule.enable', rule: 'attach.fallback' }]));

    expect(unknown.code).toBe('E_RULE_NOT_FOUND');
    expect(screen.code).toBe('E_RULE_INVALID');
    expect(both.hint).toContain('attach.varies-independent@default');
    expect(notDisabled.code).toBe('E_RULE_NOT_FOUND');
  });
});

describe('rule.remove', () => {
  it('removes project and pending rules but never default ones', async () => {
    const fx = await treeFixture(makeDir);
    await fx.apply([
      { op: 'rule.adopt', rule: dotBaked },
      { op: 'rule.propose', rule: ruleOf('pending-one', 'hit.area', 'padded') },
    ]);

    await fx.apply([
      { op: 'rule.remove', id: 'attach.dot-baked' },
      { op: 'rule.remove', id: 'pending-one' },
    ]);
    const project = projectRulesKind.parse(await fx.readText(projectFile(fx)), 'x');
    const refused = await failureOf(fx.apply([{ op: 'rule.remove', id: 'attach.fallback' }]));

    expect(project.rules).toEqual([]);
    expect(project.pending).toEqual([]);
    expect(decision(fx, 'badge_dot', 'attach.split')?.by).toBe('attach.varies-independent@default');
    expect(refused.code).toBe('E_RULE_NOT_FOUND');
  });

  it('removes a screen rule', async () => {
    const fx = await treeFixture(makeDir);
    await fx.apply([{ op: 'rule.adopt', rule: dotBaked, scope: 'screen' }]);

    await fx.apply([{ op: 'rule.remove', id: 'attach.dot-baked', scope: 'screen' }]);

    expect(decision(fx, 'badge_dot', 'attach.split')?.by).toBe('attach.varies-independent@default');
  });
});

describe('node exceptions', () => {
  const addException = {
    op: 'exception.add',
    target: '#badge_dot',
    point: 'attach.split',
    value: 'baked',
    because: '这个红点画在按钮的描边上，运行时不会变',
  };

  it('beat every rule and are stored in the screen rules', async () => {
    const fx = await treeFixture(makeDir);

    await fx.apply([addException]);

    expect(decision(fx, 'badge_dot', 'attach.split')).toEqual({ value: 'baked', by: 'exception' });
    const screen = screenRulesKind.parse(await fx.readText(screenFile(fx)), 'x');
    expect(screen.exceptions).toEqual([
      {
        node: 'badge_dot',
        point: 'attach.split',
        value: 'baked',
        because: '这个红点画在按钮的描边上，运行时不会变',
      },
    ]);
  });

  it('are rejected without a reason', async () => {
    const fx = await treeFixture(makeDir);
    const { because: _, ...withoutReason } = addException;

    const missing = await failureOf(fx.apply([withoutReason]));
    const blank = await failureOf(fx.apply([{ ...addException, because: '   ' }]));

    expect(missing.code).toBe('E_OP_INVALID');
    expect(blank.code).toBe('E_OP_INVALID');
    expect(blank.message).toContain('必须写理由');
  });

  it('are rejected at points that do not apply to the node, or with bad values', async () => {
    const fx = await treeFixture(makeDir);

    const notApplicable = await failureOf(
      fx.apply([{ ...addException, target: '#btn_shop', point: 'text.mode', value: 'dynamic' }]),
    );
    const badValue = await failureOf(fx.apply([{ ...addException, value: 'sideways' }]));

    expect(notApplicable.code).toBe('E_OP_INVALID');
    expect(notApplicable.message).toContain('text.mode');
    expect(badValue.code).toBe('E_RULE_INVALID');
  });

  it('replace an earlier exception on the same point with a warning', async () => {
    const fx = await treeFixture(makeDir);
    await fx.apply([addException]);

    const result = await fx.apply([{ ...addException, value: 'independent' }]);

    expect(result.warnings.join('\n')).toContain('已被替换');
    expect(decision(fx, 'badge_dot', 'attach.split')?.value).toBe('independent');
  });

  it('can be written for several nodes at once and removed again', async () => {
    const fx = await treeFixture(makeDir);

    await fx.apply([{ ...addException, target: 'button', point: 'press.feedback', value: 'tint' }]);
    expect(decision(fx, 'btn_shop', 'press.feedback')?.by).toBe('exception');
    expect(decision(fx, 'btn_upgrade', 'press.feedback')?.by).toBe('exception');

    await fx.apply([{ op: 'exception.remove', target: '#btn_shop' }]);
    expect(decision(fx, 'btn_shop', 'press.feedback')?.by).toBe('press.fallback@default');
    expect(decision(fx, 'btn_upgrade', 'press.feedback')?.by).toBe('exception');

    const none = await failureOf(fx.apply([{ op: 'exception.remove', target: '#btn_shop' }]));
    expect(none.code).toBe('E_RULE_NOT_FOUND');
  });

  it('follow their node when it is renamed', async () => {
    const fx = await treeFixture(makeDir);
    await fx.apply([addException]);

    await fx.apply([{ op: 'node.rename', target: '#badge_dot', id: 'dot' }]);

    const screen = screenRulesKind.parse(await fx.readText(screenFile(fx)), 'x');
    expect(screen.exceptions.map((entry) => entry.node)).toEqual(['dot']);
    expect(decision(fx, 'dot', 'attach.split')).toEqual({ value: 'baked', by: 'exception' });
  });

  it('go away with their node, with a warning', async () => {
    const fx = await treeFixture(makeDir);
    await fx.apply([addException]);

    const result = await fx.apply([{ op: 'node.remove', target: '#badge_dot' }]);

    expect(result.warnings.join('\n')).toContain('节点 #badge_dot 已不存在');
    expect(result.warnings.join('\n')).toContain('已一并移除');
    const screen = screenRulesKind.parse(await fx.readText(screenFile(fx)), 'x');
    expect(screen.exceptions).toEqual([]);
  });

  it('stay when only a sibling is removed', async () => {
    const fx = await treeFixture(makeDir);
    await fx.apply([addException]);

    const result = await fx.apply([{ op: 'node.remove', target: '#title' }]);

    expect(result.warnings).toEqual([]);
    expect(decision(fx, 'badge_dot', 'attach.split')?.by).toBe('exception');
  });
});

describe('rule examples', () => {
  it('follow their node when it is renamed, in every layer', async () => {
    const fx = await treeFixture(makeDir);
    const withExample = (id: string) =>
      ruleOf(
        id,
        'attach.split',
        'independent',
        { type: 'image' },
        { examples: ['main/#badge_dot'] },
      );
    await fx.apply([
      { op: 'rule.adopt', rule: withExample('project-one') },
      { op: 'rule.adopt', rule: withExample('screen-one'), scope: 'screen' },
      { op: 'rule.propose', rule: withExample('pending-one') },
    ]);

    await fx.apply([{ op: 'node.rename', target: '#badge_dot', id: 'dot' }]);

    const project = projectRulesKind.parse(await fx.readText(projectFile(fx)), 'x');
    const screen = screenRulesKind.parse(await fx.readText(screenFile(fx)), 'x');
    expect(project.rules[0]?.examples).toEqual(['main/#dot']);
    expect(project.pending[0]?.examples).toEqual(['main/#dot']);
    expect(screen.rules[0]?.examples).toEqual(['main/#dot']);
  });
});

describe('ambiguity', () => {
  const rules = [
    ruleOf('image-baked', 'attach.split', 'baked', { type: 'image' }),
    ruleOf('badge-apart', 'attach.split', 'independent', { role: 'badge.notification' }),
  ];

  it('writes no decision for the affected node and warns naming the rules and nodes', async () => {
    const fx = await treeFixture(makeDir);

    const result = await fx.apply(rules.map((rule) => ({ op: 'rule.adopt', rule })));

    expect(decision(fx, 'badge_dot', 'attach.split')).toBeUndefined();
    const warning = result.warnings.join('\n');
    expect(warning).toContain('image-baked@project');
    expect(warning).toContain('badge-apart@project');
    expect(warning).toContain('#badge_dot');
    expect(warning).toContain('attach.split');
  });
});

describe('rule.recompute', () => {
  it('refreshes decisions after a rules file was edited by hand', async () => {
    const fx = await treeFixture(makeDir);
    const text = await fx.readText(projectFile(fx));
    await writeFile(
      join(fx.project.root, ...projectFile(fx).split('/')),
      text.replace(
        'rules: []',
        `rules:\n  - id: hand.written\n    point: attach.split\n    when: { type: image }\n    value: baked\n    because: 手写的规则\n`,
      ),
    );
    expect(decision(fx, 'badge_dot', 'attach.split')?.value).toBe('independent');

    const result = await fx.apply([{ op: 'rule.recompute' }]);

    expect(result.version).toBeDefined();
    expect(decision(fx, 'badge_dot', 'attach.split')).toEqual({
      value: 'baked',
      by: 'hand.written@project',
    });
  });

  it('changes nothing when decisions are already current', async () => {
    const fx = await treeFixture(makeDir);

    const result = await fx.apply([{ op: 'rule.recompute' }]);

    expect(result.version).toBeUndefined();
    expect(result.changes.docs).toEqual([]);
  });
});

describe('registerRules', () => {
  it('is idempotent on one registry', () => {
    const registry = newRegistry();

    expect(() => registerRules(registry)).not.toThrow();
    expect(registry.getOp('rule.propose')).toBeDefined();
    for (const name of [
      'rule.propose',
      'rule.adopt',
      'rule.disable',
      'rule.enable',
      'rule.remove',
      'exception.add',
      'exception.remove',
      'rule.recompute',
    ]) {
      expect(registry.getOp(name)?.family, name).toBe('rules');
    }
  });
});
