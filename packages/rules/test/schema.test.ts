import { INITIAL_PROJECT_RULES, INITIAL_SCREEN_RULES } from '@ui-pro/core';
import { describe, expect, it } from 'vitest';
import {
  defaultPack,
  ProjectRulesSchema,
  projectRulesKind,
  RuleSchema,
  ScreenRulesSchema,
  screenRulesKind,
  WHEN_KEYS,
  WhenSchema,
} from '../src';

const header = 'format: ui-pro/rules\nversion: 1\n';

describe('rule documents', () => {
  it('parse what the kernel writes into a new project and screen', () => {
    expect(projectRulesKind.parse(INITIAL_PROJECT_RULES, 'rules/project.yaml')).toEqual({
      format: 'ui-pro/rules',
      version: 1,
      rules: [],
      pending: [],
      disabled: [],
    });
    expect(screenRulesKind.parse(INITIAL_SCREEN_RULES, 'screens/main/rules.yaml')).toEqual({
      format: 'ui-pro/rules',
      version: 1,
      rules: [],
      exceptions: [],
    });
  });

  it('round-trip the default pack through the codec', () => {
    const pack = defaultPack();

    const text = projectRulesKind.serialize(pack);

    expect(projectRulesKind.parse(text, 'pack')).toEqual(pack);
  });

  it('give a rule without conditions an empty when', () => {
    const rule = RuleSchema.parse({
      id: 'a.b',
      point: 'hit.area',
      value: 'padded',
      because: '理由',
    });

    expect(rule.when).toEqual({});
  });

  it('reject a rule without a reason', () => {
    expect(
      RuleSchema.safeParse({ id: 'a', point: 'hit.area', value: 'padded', because: '  ' }).success,
    ).toBe(false);
  });

  it('reject unknown condition keys and malformed ids', () => {
    expect(WhenSchema.safeParse({ colour: 'red' }).success).toBe(false);
    expect(
      RuleSchema.safeParse({ id: 'Bad Id', point: 'hit.area', value: 'padded', because: '理由' })
        .success,
    ).toBe(false);
  });

  it('have the 17 documented condition keys', () => {
    expect(WHEN_KEYS).toHaveLength(17);
    expect(new Set(WHEN_KEYS).size).toBe(17);
  });

  it('accept one value or a list for the multi-valued keys', () => {
    expect(WhenSchema.safeParse({ type: 'image' }).success).toBe(true);
    expect(WhenSchema.safeParse({ type: ['image', 'button'] }).success).toBe(true);
    expect(WhenSchema.safeParse({ type: [] }).success).toBe(false);
    expect(WhenSchema.safeParse({ varies: 'non-empty' }).success).toBe(true);
    expect(WhenSchema.safeParse({ varies: ['state', 'size'] }).success).toBe(true);
    expect(WhenSchema.safeParse({ repeat: { min: 2 } }).success).toBe(true);
    expect(WhenSchema.safeParse({ repeat: {} }).success).toBe(false);
    expect(WhenSchema.safeParse({ repeat: { min: 3, max: 2 } }).success).toBe(false);
    expect(WhenSchema.safeParse({ role: 'badge.*' }).success).toBe(true);
    expect(WhenSchema.safeParse({ role: 'Badge' }).success).toBe(false);
  });

  it('reject a node exception without a reason', () => {
    const missing = `${header}rules: []\nexceptions:\n  - { node: badge_dot, point: attach.split, value: baked }\n`;
    const blank = `${header}rules: []\nexceptions:\n  - { node: badge_dot, point: attach.split, value: baked, because: "" }\n`;

    expect(() => screenRulesKind.parse(missing, 'rules.yaml')).toThrow(/because/);
    expect(() => screenRulesKind.parse(blank, 'rules.yaml')).toThrow(/必须写理由/);
  });

  it('reject duplicate rule ids, also between rules and the pending area', () => {
    const rule = { id: 'a', point: 'hit.area', value: 'padded', because: '理由' };

    expect(
      ProjectRulesSchema.safeParse({
        format: 'ui-pro/rules',
        version: 1,
        rules: [rule],
        pending: [rule],
      }).success,
    ).toBe(false);
    expect(
      ScreenRulesSchema.safeParse({ format: 'ui-pro/rules', version: 1, rules: [rule, rule] })
        .success,
    ).toBe(false);
  });

  it('allow one exception per node and decision point', () => {
    const entry = { node: 'a', point: 'hit.area', value: 'padded', because: '理由' };

    expect(
      ScreenRulesSchema.safeParse({
        format: 'ui-pro/rules',
        version: 1,
        rules: [],
        exceptions: [entry, { ...entry, value: 'visible' }],
      }).success,
    ).toBe(false);
  });

  it('reject disabling the same rule twice and a disable without a reason', () => {
    const base = { format: 'ui-pro/rules', version: 1, rules: [] };

    expect(
      ProjectRulesSchema.safeParse({
        ...base,
        disabled: [
          { rule: 'a@default', because: '一' },
          { rule: 'a@default', because: '二' },
        ],
      }).success,
    ).toBe(false);
    expect(
      ProjectRulesSchema.safeParse({ ...base, disabled: [{ rule: 'a@default', because: '' }] })
        .success,
    ).toBe(false);
  });
});
