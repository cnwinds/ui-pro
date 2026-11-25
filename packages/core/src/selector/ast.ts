import type { Primitive } from '../schema/common';

/** Node attributes selectable with `[name…]`. */
export const SELECTOR_ATTRIBUTES = [
  'id',
  'type',
  'role',
  'concept',
  /** Matches the node's `text.content`. */
  'text',
  'parent',
  'visible',
  'varies',
  'instanceOf',
  'cluster',
] as const;
export type SelectorAttribute = (typeof SELECTOR_ATTRIBUTES)[number];

/** `exists` is the bare `[name]` form; `~=` is "contains" (array member or whitespace word). */
export type AttributeOperator = 'exists' | '=' | '^=' | '~=';

export type SimpleSelector =
  | { kind: 'type'; type: Primitive }
  | { kind: 'id'; id: string }
  | { kind: 'attribute'; name: SelectorAttribute; operator: AttributeOperator; value: string }
  | { kind: 'selection' }
  | { kind: 'like'; inner: SelectorList };

/** Simple selectors that must all match the same node. `*` is the empty compound. */
export interface Compound {
  tests: SimpleSelector[];
}

export interface Step {
  /** How this compound relates to the previous step; `null` for the first step. */
  combinator: 'descendant' | 'child' | null;
  compound: Compound;
}

export interface ComplexSelector {
  /** Screen qualifier: a screen name, `*` for all screens, absent for the current screen. */
  screen?: string;
  steps: Step[];
}

export interface SelectorList {
  items: ComplexSelector[];
}
