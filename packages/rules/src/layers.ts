import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { specificity } from './condition';
import { projectRulesCodec } from './docs';
import { getPoint, valueProblem } from './points';
import type { ProjectRules, Rule, ScreenRules } from './schema';

export type Layer = 'default' | 'project' | 'screen';

/** A rule together with where it lives. */
export interface RuleEntry {
  /** `<id>@default`, `<id>@project` or `<id>@screen:<screen>`; what a decision's `by` holds. */
  ref: string;
  layer: Layer;
  screen?: string;
  rule: Rule;
  specificity: number;
}

export function ruleRef(id: string, layer: Layer, screen?: string): string {
  return layer === 'screen' ? `${id}@screen:${screen}` : `${id}@${layer}`;
}

export function entryOf(rule: Rule, layer: Layer, screen?: string): RuleEntry {
  return {
    ref: ruleRef(rule.id, layer, screen),
    layer,
    screen,
    rule,
    specificity: specificity(rule.when),
  };
}

/** Splits a reference; `layer` is absent when the text has no `@`. */
export function splitRuleRef(text: string): { id: string; layer?: string } {
  const at = text.indexOf('@');
  return at < 0 ? { id: text } : { id: text.slice(0, at), layer: text.slice(at + 1) };
}

const PACK_PATH = '../pack/default.rules.yaml';

let cachedPack: ProjectRules | undefined;

/** The shipped default rule pack, parsed once. Treat it as read-only. */
export function defaultPack(): ProjectRules {
  cachedPack ??= projectRulesCodec.parse(
    readFileSync(fileURLToPath(new URL(PACK_PATH, import.meta.url)), 'utf8'),
    'packages/rules/pack/default.rules.yaml',
  );
  return cachedPack;
}

/** The unconditional rule of a decision point; it keeps every point a total function. */
export function isFallback(entry: RuleEntry): boolean {
  return entry.layer === 'default' && entry.specificity === 0;
}

export interface RuleIndex {
  /** Valid rules by decision point, one map per layer. */
  default: Map<string, RuleEntry[]>;
  project: Map<string, RuleEntry[]>;
  screens: Map<string, Map<string, RuleEntry[]>>;
  /** Every valid rule of every layer by reference. */
  byRef: Map<string, RuleEntry>;
  /** Reference -> reason, for the rules `rules/project.yaml` switches off. */
  disabled: Map<string, string>;
  /** Rules naming an unknown decision point or a value the point does not take. */
  invalid: Array<{ entry: RuleEntry; problem: string }>;
}

export interface LayerDocs {
  pack: ProjectRules;
  project: ProjectRules;
  screens: ReadonlyMap<string, { rules: ScreenRules }>;
}

function add(map: Map<string, RuleEntry[]>, entry: RuleEntry): void {
  const entries = map.get(entry.rule.point) ?? [];
  entries.push(entry);
  map.set(entry.rule.point, entries);
}

/** Indexes the rules of all layers; rules that cannot be evaluated are set aside as `invalid`. */
export function buildRuleIndex(docs: LayerDocs): RuleIndex {
  const index: RuleIndex = {
    default: new Map(),
    project: new Map(),
    screens: new Map(),
    byRef: new Map(),
    disabled: new Map(),
    invalid: [],
  };
  const register = (entry: RuleEntry, target: Map<string, RuleEntry[]>) => {
    const problem = getPoint(entry.rule.point)
      ? valueProblem(entry.rule.point, entry.rule.value)
      : `未知的决策点：${entry.rule.point}`;
    if (problem !== undefined) {
      index.invalid.push({ entry, problem });
      return;
    }
    index.byRef.set(entry.ref, entry);
    add(target, entry);
  };

  for (const rule of docs.pack.rules) register(entryOf(rule, 'default'), index.default);
  for (const rule of docs.project.rules) register(entryOf(rule, 'project'), index.project);
  for (const [screen, input] of docs.screens) {
    const target = new Map<string, RuleEntry[]>();
    index.screens.set(screen, target);
    for (const rule of input.rules.rules) register(entryOf(rule, 'screen', screen), target);
  }
  for (const { rule, because } of docs.project.disabled) {
    const entry = index.byRef.get(rule);
    if (entry && !isFallback(entry) && entry.layer !== 'screen') index.disabled.set(rule, because);
  }
  return index;
}
