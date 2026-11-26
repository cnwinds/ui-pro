import type { RuleInputs } from './inputs';
import { entryOf, isFallback, type Layer, type RuleEntry } from './layers';
import type { Rule } from './schema';

export type ListMode = 'effective' | 'pending' | 'disabled';

export interface ListFilter {
  mode?: ListMode;
  point?: string;
  layer?: Layer;
  /** Of the screen rules, keep only this screen's. */
  screen?: string;
}

export interface RuleListItem {
  ref: string;
  layer: Layer;
  screen?: string;
  id: string;
  point: string;
  when: Rule['when'];
  value: string;
  because: string;
  examples?: string[];
  /** The unconditional rule of a decision point; it cannot be disabled. */
  fallback?: boolean;
  /** Why the rule is switched off, in `disabled` mode. */
  disabledBecause?: string;
}

function itemOf(entry: RuleEntry, extra: Partial<RuleListItem> = {}): RuleListItem {
  const { rule } = entry;
  return {
    ref: entry.ref,
    layer: entry.layer,
    screen: entry.screen,
    id: rule.id,
    point: rule.point,
    when: rule.when,
    value: rule.value,
    because: rule.because,
    examples: rule.examples,
    fallback: isFallback(entry) ? true : undefined,
    ...extra,
  };
}

/**
 * The rules in force (default pack, project rules, then each screen's rules), or the pending
 * area, or the disabled ones. Rules appear in file order within a layer.
 */
export function listRules(inputs: RuleInputs, filter: ListFilter = {}): RuleListItem[] {
  const mode = filter.mode ?? 'effective';
  const disabled = new Map(inputs.project.disabled.map((entry) => [entry.rule, entry.because]));
  const all: RuleEntry[] = [
    ...inputs.pack.rules.map((rule) => entryOf(rule, 'default')),
    ...inputs.project.rules.map((rule) => entryOf(rule, 'project')),
    ...[...inputs.screens].flatMap(([screen, { rules }]) =>
      rules.rules.map((rule) => entryOf(rule, 'screen', screen)),
    ),
  ];

  let items: RuleListItem[];
  if (mode === 'pending') {
    items = inputs.project.pending.map((rule) => itemOf(entryOf(rule, 'project')));
  } else if (mode === 'disabled') {
    items = all.flatMap((entry) => {
      const because = disabled.get(entry.ref);
      return because === undefined ? [] : [itemOf(entry, { disabledBecause: because })];
    });
  } else {
    items = all.filter((entry) => !disabled.has(entry.ref)).map((entry) => itemOf(entry));
  }
  return items.filter(
    (item) =>
      (filter.point === undefined || item.point === filter.point) &&
      (filter.layer === undefined || item.layer === filter.layer) &&
      (filter.screen === undefined || item.layer !== 'screen' || item.screen === filter.screen),
  );
}
