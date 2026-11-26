import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIMITIVES, VARIABILITIES } from '@ui-pro/core';
import { describe, expect, it } from 'vitest';
import {
  DECISION_POINTS,
  defaultPack,
  evaluatePoint,
  GENERIC_ROLES,
  isFallback,
  lintRuleSet,
  makeFacts,
  type NodeFacts,
  ROLE_NAMES,
  valueProblem,
} from '../src';
import { buildRuleIndex, entryOf } from '../src/layers';
import { defaultVaries } from '../src/roles';
import { emptyProjectRules, POSITIONS, SHAPES, TEXT_KINDS } from '../src/schema';

const index = buildRuleIndex({
  pack: defaultPack(),
  project: emptyProjectRules(),
  screens: new Map(),
});

function decideAll(facts: NodeFacts) {
  return DECISION_POINTS.filter((point) => point.applies(facts)).map((point) => ({
    point: point.name,
    outcome: evaluatePoint(index, 'main', facts, point),
  }));
}

describe('the default rule pack', () => {
  const pack = defaultPack();

  it('passes its own lint without a single problem', () => {
    expect(lintRuleSet(pack.rules, { layer: 'default', file: 'pack' })).toEqual([]);
  });

  it('has exactly one unconditional fallback for each decision point', () => {
    for (const point of DECISION_POINTS) {
      const fallbacks = pack.rules.filter(
        (rule) => rule.point === point.name && isFallback(entryOf(rule, 'default')),
      );
      expect(
        fallbacks.map((rule) => rule.id),
        point.name,
      ).toHaveLength(1);
      expect(fallbacks[0]?.id, point.name).toMatch(/fallback$/);
    }
  });

  it('only decides values the catalog allows', () => {
    for (const rule of pack.rules) {
      expect(valueProblem(rule.point, rule.value), rule.id).toBeUndefined();
    }
  });

  it('covers every decision point of the catalog and nothing else', () => {
    const points = new Set(pack.rules.map((rule) => rule.point));

    expect([...points].sort()).toEqual(DECISION_POINTS.map((point) => point.name).sort());
  });

  it('never puts concepts, coordinates or genre words in the pack file', () => {
    const text = readFileSync(
      fileURLToPath(new URL('../pack/default.rules.yaml', import.meta.url)),
      'utf8',
    );

    expect(text).not.toMatch(/concept\s*:/);
    expect(text).not.toMatch(/英雄|装备|背包|道具|技能|副本|关卡|抽卡|公会|战斗|商城|怪物|红点/);
    expect(text).not.toMatch(/\d+\s*[x×]\s*\d+|\d+\s*px/i);
  });

  it('gives each rule a reason', () => {
    for (const rule of pack.rules) expect(rule.because.length, rule.id).toBeGreaterThan(4);
  });
});

describe('totality of the default pack', () => {
  const roles = [undefined, ...ROLE_NAMES];

  it('decides every applicable point for every primitive type and generic role', () => {
    let checked = 0;
    for (const type of PRIMITIVES) {
      for (const role of roles) {
        for (const isRoot of [false, true]) {
          const facts = makeFacts({
            type,
            role,
            isRoot,
            varies: defaultVaries(role),
            position: isRoot ? undefined : 'center',
            parentType: isRoot ? undefined : 'container',
          });
          for (const { point, outcome } of decideAll(facts)) {
            expect(outcome.status, `${type}/${role ?? '-'} ${point}`).toBe('decided');
            expect(outcome.decision?.by, `${type}/${role ?? '-'} ${point}`).toMatch(/@default$/);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(PRIMITIVES.length * roles.length);
  });

  it('decides naming for every node', () => {
    for (const type of PRIMITIVES) {
      const names = decideAll(makeFacts({ type })).map(({ point }) => point);
      expect(names, type).toContain('naming.node');
    }
  });

  it('never leaves a point ambiguous, whatever the facts', () => {
    let seed = 20260101;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
    const flag = () => next() < 0.5;

    for (let i = 0; i < 20000; i++) {
      const varies = VARIABILITIES.filter(() => next() < 0.3);
      const facts: NodeFacts = {
        type: pick(PRIMITIVES),
        role: next() < 0.2 ? undefined : pick(ROLE_NAMES),
        concept: next() < 0.2 ? undefined : '随便一个概念',
        isRoot: next() < 0.1,
        childCount: Math.floor(next() * 6),
        varies,
        interactive: flag(),
        textKind: next() < 0.5 ? undefined : pick(TEXT_KINDS),
        grouped: flag(),
        repeat: 1 + Math.floor(next() * 5),
        parentType: next() < 0.2 ? undefined : pick(PRIMITIVES),
        parentRole: next() < 0.5 ? undefined : pick(ROLE_NAMES),
        attached: flag(),
        overVariable: flag(),
        position: next() < 0.1 ? undefined : pick(POSITIONS),
        shape: pick(SHAPES),
        childrenEven: flag(),
        touchSmall: flag(),
        lowRes: flag(),
        crossScreen: flag(),
      };
      for (const { point, outcome } of decideAll(facts)) {
        if (outcome.status !== 'decided') {
          expect.fail(`${point} is ${outcome.status} for ${JSON.stringify(facts)}`);
        }
      }
    }
  });

  it('gives equal facts equal decisions', () => {
    const facts = makeFacts({
      type: 'button',
      role: 'button',
      position: 'bottom-left',
      shape: 'wide',
    });

    const first = decideAll(facts);
    const second = decideAll({ ...facts });

    expect(second).toEqual(first);
  });
});

describe('the generic role table', () => {
  it('only uses known variabilities', () => {
    for (const [role, varies] of Object.entries(GENERIC_ROLES)) {
      for (const item of varies) expect(VARIABILITIES, role).toContain(item);
    }
  });

  it('treats an icon in a slot as the slot content', () => {
    expect(defaultVaries('icon', 'slot')).toEqual(['content']);
    expect(defaultVaries('icon', 'panel')).toEqual([]);
    expect(defaultVaries('icon')).toEqual([]);
    expect(defaultVaries(undefined)).toEqual([]);
    expect(defaultVaries('game.specific-role')).toEqual([]);
  });
});

describe('the source of the package', () => {
  const avoid = [
    '特例',
    '原图',
    '规则集',
    '内置规则',
    '素材',
    '切图',
    '工作区',
    '游戏项目',
    '控件',
    '规范包',
  ];

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? sources(path) : /\.(ts|yaml)$/.test(name) ? [path] : [];
    });
  }

  it('avoids the words CONTEXT.md rules out', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    for (const file of [...sources(join(root, 'src')), ...sources(join(root, 'pack'))]) {
      const text = readFileSync(file, 'utf8');
      for (const word of avoid) expect(text, `${file}: ${word}`).not.toContain(word);
    }
  });
});
