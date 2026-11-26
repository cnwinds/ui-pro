import { describe, expect, it } from 'vitest';
import { evaluatePoint, getPoint, makeFacts, type NodeFacts, type Rule } from '../src';
import { matchesWhen } from '../src/condition';
import { buildRuleIndex, defaultPack } from '../src/layers';
import {
  emptyProjectRules,
  emptyScreenRules,
  type NodeException,
  type ProjectRules,
  type ScreenRules,
} from '../src/schema';

const rule = (
  id: string,
  point: string,
  value: string,
  when: Rule['when'] = {},
  because = '测试用的理由',
): Rule => ({ id, point, value, when, because });

interface Layers {
  project?: Partial<ProjectRules>;
  screen?: Partial<ScreenRules>;
}

function decide(
  facts: NodeFacts,
  pointName: string,
  layers: Layers = {},
  exception?: NodeException,
) {
  const index = buildRuleIndex({
    pack: defaultPack(),
    project: { ...emptyProjectRules(), ...layers.project },
    screens: new Map([['main', { rules: { ...emptyScreenRules(), ...layers.screen } }]]),
  });
  const point = getPoint(pointName);
  if (!point) throw new Error(`unknown point ${pointName}`);
  return evaluatePoint(index, 'main', facts, point, exception);
}

const dot = makeFacts({
  type: 'image',
  role: 'badge.notification',
  attached: true,
  varies: ['visibility'],
  parentType: 'button',
});

describe('layered evaluation', () => {
  it('lets the default pack decide when nothing else speaks', () => {
    const outcome = decide(dot, 'attach.split');

    expect(outcome.status).toBe('decided');
    expect(outcome.decision).toEqual({
      value: 'independent',
      by: 'attach.varies-independent@default',
    });
    expect(outcome.because).toContain('独立变化');
  });

  it('falls back to the unconditional rule when no specific rule matches', () => {
    const plain = makeFacts({ type: 'image', attached: true });

    expect(decide(plain, 'attach.split').decision).toEqual({
      value: 'baked',
      by: 'attach.fallback@default',
    });
  });

  it('lets a project rule beat a more specific default rule', () => {
    const outcome = decide(dot, 'attach.split', {
      project: { rules: [rule('dot-baked', 'attach.split', 'baked')] },
    });

    expect(outcome.decision).toEqual({ value: 'baked', by: 'dot-baked@project' });
    expect(
      outcome.rules.find((trace) => trace.ref === 'attach.varies-independent@default'),
    ).toMatchObject({
      verdict: 'lower-layer',
    });
  });

  it('lets a screen rule beat a project rule', () => {
    const outcome = decide(dot, 'attach.split', {
      project: { rules: [rule('dot-baked', 'attach.split', 'baked')] },
      screen: { rules: [rule('dot-apart', 'attach.split', 'independent')] },
    });

    expect(outcome.decision).toEqual({ value: 'independent', by: 'dot-apart@screen:main' });
  });

  it('picks the rule with more predicates inside one layer', () => {
    const outcome = decide(dot, 'attach.split', {
      project: {
        rules: [
          rule('image-baked', 'attach.split', 'baked', { type: 'image' }),
          rule('image-varies-apart', 'attach.split', 'independent', {
            type: 'image',
            varies: 'non-empty',
          }),
        ],
      },
    });

    expect(outcome.decision?.by).toBe('image-varies-apart@project');
    expect(outcome.rules.find((trace) => trace.ref === 'image-baked@project')?.verdict).toBe(
      'less-specific',
    );
  });

  it('counts predicates, not values: a list is one predicate', () => {
    const outcome = decide(dot, 'attach.split', {
      project: {
        rules: [
          rule('wide', 'attach.split', 'baked', { type: ['image', 'button', 'text'] }),
          rule('narrow', 'attach.split', 'independent', { type: 'image', attached: true }),
        ],
      },
    });

    expect(outcome.decision?.by).toBe('narrow@project');
  });

  it('decides nothing when two equally specific rules disagree', () => {
    const outcome = decide(dot, 'attach.split', {
      project: {
        rules: [
          rule('b-rule', 'attach.split', 'baked', { type: 'image' }),
          rule('a-rule', 'attach.split', 'independent', { role: 'badge.*' }),
        ],
      },
    });

    expect(outcome.status).toBe('ambiguous');
    expect(outcome.decision).toBeUndefined();
    expect(outcome.tied).toEqual(['a-rule@project', 'b-rule@project']);
    expect(outcome.rules.filter((trace) => trace.verdict === 'ambiguous')).toHaveLength(2);
  });

  it('does not let a lower layer rescue an ambiguous layer', () => {
    const outcome = decide(dot, 'attach.split', {
      project: {
        rules: [
          rule('b-rule', 'attach.split', 'baked', { type: 'image' }),
          rule('a-rule', 'attach.split', 'independent', { role: 'badge.*' }),
        ],
      },
    });

    expect(outcome.status).toBe('ambiguous');
    expect(outcome.rules.some((trace) => trace.layer === 'default')).toBe(true);
  });

  it('breaks a tie of equal values by the smaller reference', () => {
    const outcome = decide(dot, 'attach.split', {
      project: {
        rules: [
          rule('zeta', 'attach.split', 'baked', { type: 'image' }),
          rule('alpha', 'attach.split', 'baked', { role: 'badge.*' }),
        ],
      },
    });

    expect(outcome.status).toBe('decided');
    expect(outcome.decision?.by).toBe('alpha@project');
    expect(outcome.rules.find((trace) => trace.ref === 'zeta@project')?.verdict).toBe('tied');
  });

  it('does not depend on the order of rules in the files', () => {
    const rules = [
      rule('r1', 'attach.split', 'baked', { type: 'image' }),
      rule('r2', 'attach.split', 'independent', { type: 'image', attached: true }),
      rule('r3', 'attach.split', 'baked', { role: 'badge.*', attached: true }),
      rule('r4', 'attach.split', 'independent', { role: 'badge.*', varies: 'non-empty' }),
    ];

    const forward = decide(dot, 'attach.split', { project: { rules } });
    const backward = decide(dot, 'attach.split', { project: { rules: [...rules].reverse() } });

    expect(backward).toEqual(forward);
  });

  it('lets a node exception beat every layer', () => {
    const outcome = decide(
      dot,
      'attach.split',
      { screen: { rules: [rule('dot-apart', 'attach.split', 'independent')] } },
      { node: 'badge_dot', point: 'attach.split', value: 'baked', because: '这个红点画在按钮上' },
    );

    expect(outcome.decision).toEqual({ value: 'baked', by: 'exception' });
    expect(outcome.because).toBe('这个红点画在按钮上');
    expect(outcome.rules.find((trace) => trace.ref === 'dot-apart@screen:main')?.verdict).toBe(
      'exception',
    );
  });

  it('skips a disabled rule and names the reason in the trace', () => {
    const outcome = decide(dot, 'attach.split', {
      project: {
        disabled: [
          { rule: 'attach.varies-independent@default', because: '本项目的红点都画在底板上' },
        ],
      },
    });

    expect(outcome.decision?.by).toBe('attach.fallback@default');
    expect(
      outcome.rules.find((trace) => trace.ref === 'attach.varies-independent@default'),
    ).toMatchObject({
      verdict: 'disabled',
      disabledBecause: '本项目的红点都画在底板上',
    });
  });

  it('never disables a fallback', () => {
    const index = buildRuleIndex({
      pack: defaultPack(),
      project: {
        ...emptyProjectRules(),
        disabled: [{ rule: 'attach.fallback@default', because: '想试试' }],
      },
      screens: new Map(),
    });

    expect(index.disabled.has('attach.fallback@default')).toBe(false);
  });

  it('sets aside rules naming an unknown point or an impossible value', () => {
    const index = buildRuleIndex({
      pack: defaultPack(),
      project: {
        ...emptyProjectRules(),
        rules: [
          rule('ghost', 'no.such-point', 'x'),
          rule('bad-value', 'attach.split', 'sideways'),
          rule('ok', 'attach.split', 'baked'),
        ],
      },
      screens: new Map(),
    });

    expect(index.invalid.map((entry) => entry.entry.rule.id)).toEqual(['ghost', 'bad-value']);
    expect(index.byRef.has('ok@project')).toBe(true);
    expect(index.byRef.has('ghost@project')).toBe(false);
  });

  it('keeps the same rule id in different layers apart', () => {
    const outcome = decide(dot, 'attach.split', {
      project: { rules: [rule('same', 'attach.split', 'baked')] },
      screen: { rules: [rule('same', 'attach.split', 'independent')] },
    });

    expect(outcome.decision?.by).toBe('same@screen:main');
    expect(outcome.rules.map((trace) => trace.ref)).toContain('same@project');
  });
});

describe('the condition language', () => {
  const sample = makeFacts({
    type: 'button',
    role: 'badge.count',
    concept: '红点',
    varies: ['visibility', 'content'],
    interactive: true,
    textKind: 'value',
    grouped: true,
    repeat: 3,
    parentType: 'container',
    parentRole: 'panel',
    attached: true,
    overVariable: true,
    position: 'top-right',
    shape: 'square',
    childrenEven: true,
    touchSmall: true,
    lowRes: true,
    crossScreen: true,
  });

  const cases: Array<[string, Rule['when'], Rule['when']]> = [
    ['type', { type: ['image', 'button'] }, { type: 'image' }],
    ['role (exact)', { role: 'badge.count' }, { role: 'badge.mark' }],
    ['role (prefix)', { role: 'badge.*' }, { role: 'panel.*' }],
    ['concept', { concept: '红点' }, { concept: '商店' }],
    ['varies (list)', { varies: ['content', 'size'] }, { varies: ['size', 'motion'] }],
    ['varies (non-empty)', { varies: 'non-empty' }, { varies: 'empty' }],
    ['interactive', { interactive: true }, { interactive: false }],
    ['textKind', { textKind: ['value', 'label'] }, { textKind: 'title' }],
    ['repeat (min)', { repeat: { min: 3 } }, { repeat: { min: 4 } }],
    ['repeat (max)', { repeat: { max: 3 } }, { repeat: { max: 2 } }],
    ['parentType', { parentType: 'container' }, { parentType: 'image' }],
    ['parentRole', { parentRole: 'panel' }, { parentRole: 'frame' }],
    ['attached', { attached: true }, { attached: false }],
    ['overVariable', { overVariable: true }, { overVariable: false }],
    ['position', { position: ['top', 'top-right'] }, { position: 'bottom' }],
    ['shape', { shape: 'square' }, { shape: 'wide' }],
    ['childrenEven', { childrenEven: true }, { childrenEven: false }],
    ['touchSmall', { touchSmall: true }, { touchSmall: false }],
    ['lowRes', { lowRes: true }, { lowRes: false }],
    ['crossScreen', { crossScreen: true }, { crossScreen: false }],
  ];

  it.each(cases)('%s matches and mismatches', (_name, yes, no) => {
    expect(matchesWhen(yes, sample)).toBe(true);
    expect(matchesWhen(no, sample)).toBe(false);
  });

  it('requires every predicate to hold', () => {
    expect(matchesWhen({ type: 'button', attached: true }, sample)).toBe(true);
    expect(matchesWhen({ type: 'button', attached: false }, sample)).toBe(false);
  });

  it('matches every node with an empty condition', () => {
    expect(matchesWhen({}, sample)).toBe(true);
    expect(matchesWhen({}, makeFacts({ type: 'container' }))).toBe(true);
  });

  it('does not match absent facts', () => {
    const bare = makeFacts({ type: 'image' });

    expect(matchesWhen({ role: 'badge.*' }, bare)).toBe(false);
    expect(matchesWhen({ concept: '红点' }, bare)).toBe(false);
    expect(matchesWhen({ position: 'top' }, bare)).toBe(false);
    expect(matchesWhen({ parentType: 'container' }, bare)).toBe(false);
    expect(matchesWhen({ textKind: 'value' }, bare)).toBe(false);
    expect(matchesWhen({ varies: 'empty' }, bare)).toBe(true);
  });
});
