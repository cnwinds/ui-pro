import type { NodeFacts } from './facts';
import { matchesRolePattern } from './roles';
import type { When, WhenKey } from './schema';

const many = <T>(value: T | readonly T[]): readonly T[] =>
  Array.isArray(value) ? (value as readonly T[]) : [value as T];

/** Number of predicates; among rules of one layer the larger count wins. */
export function specificity(when: When): number {
  return Object.values(when).filter((value) => value !== undefined).length;
}

function matchesVaries(when: NonNullable<When['varies']>, varies: NodeFacts['varies']): boolean {
  if (when === 'empty') return varies.length === 0;
  if (when === 'non-empty') return varies.length > 0;
  return many(when).some((item) => varies.includes(item));
}

function matchesRole(patterns: string | readonly string[], role: string | undefined): boolean {
  return role !== undefined && many(patterns).some((pattern) => matchesRolePattern(pattern, role));
}

/** Predicate of each `when` key against the facts of one node. */
const PREDICATES: { [K in WhenKey]: (value: NonNullable<When[K]>, facts: NodeFacts) => boolean } = {
  type: (value, facts) => many(value).includes(facts.type),
  role: (value, facts) => matchesRole(value, facts.role),
  concept: (value, facts) => facts.concept !== undefined && many(value).includes(facts.concept),
  varies: (value, facts) => matchesVaries(value, facts.varies),
  interactive: (value, facts) => facts.interactive === value,
  textKind: (value, facts) => facts.textKind !== undefined && many(value).includes(facts.textKind),
  repeat: (value, facts) =>
    facts.repeat >= (value.min ?? 1) && facts.repeat <= (value.max ?? Number.POSITIVE_INFINITY),
  parentType: (value, facts) =>
    facts.parentType !== undefined && many(value).includes(facts.parentType),
  parentRole: (value, facts) => matchesRole(value, facts.parentRole),
  attached: (value, facts) => facts.attached === value,
  overVariable: (value, facts) => facts.overVariable === value,
  position: (value, facts) => facts.position !== undefined && many(value).includes(facts.position),
  shape: (value, facts) => many(value).includes(facts.shape),
  childrenEven: (value, facts) => facts.childrenEven === value,
  touchSmall: (value, facts) => facts.touchSmall === value,
  lowRes: (value, facts) => facts.lowRes === value,
  crossScreen: (value, facts) => facts.crossScreen === value,
};

/** True when every predicate of `when` holds; an empty `when` matches every node. */
export function matchesWhen(when: When, facts: NodeFacts): boolean {
  for (const key of Object.keys(when) as WhenKey[]) {
    const value = when[key];
    if (value === undefined) continue;
    const predicate = PREDICATES[key] as (value: unknown, facts: NodeFacts) => boolean;
    if (!predicate(value, facts)) return false;
  }
  return true;
}

/** Stable text of a `when`, for comparing two conditions. */
export function whenKey(when: When): string {
  const entries = Object.entries(when)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}
