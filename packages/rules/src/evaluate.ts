import { matchesWhen } from './condition';
import {
  buildCrossScreenIndex,
  type CrossScreenIndex,
  computeScreenFacts,
  type NodeFacts,
} from './facts';
import type { RuleInputs } from './inputs';
import { buildRuleIndex, type Layer, type RuleEntry, type RuleIndex } from './layers';
import { DECISION_POINTS, type DecisionPoint, valueProblem } from './points';
import type { NodeException } from './schema';

/** What happened to one rule that matched a node at a decision point. */
export type Verdict =
  /** Gave the decision. */
  | 'winner'
  /** Equally specific as the winner with the same value; the winner is the smaller reference. */
  | 'tied'
  /** Same layer as the winner but fewer predicates. */
  | 'less-specific'
  /** A higher layer has a rule that matches. */
  | 'lower-layer'
  /** A node exception decides instead. */
  | 'exception'
  /** Equally specific as another rule of the layer with a different value: no decision. */
  | 'ambiguous'
  | 'disabled';

export interface RuleTrace {
  ref: string;
  layer: Layer;
  value: string;
  specificity: number;
  because: string;
  verdict: Verdict;
  /** Why the rule is disabled, for `disabled` rules. */
  disabledBecause?: string;
}

export interface Decision {
  value: string;
  by: string;
}

export interface PointOutcome {
  point: string;
  status: 'decided' | 'ambiguous' | 'undecided';
  decision?: Decision;
  /** The reason of the winning rule or exception. */
  because?: string;
  /** Every rule that matched the node, highest layer first. */
  rules: RuleTrace[];
  /** References of the rules that cannot be told apart, when ambiguous. */
  tied: string[];
}

export interface NodeEvaluation {
  id: string;
  facts: NodeFacts;
  /** Applicable decision points only. */
  outcomes: Map<string, PointOutcome>;
}

export interface Evaluation {
  index: RuleIndex;
  /** Screen -> node id -> evaluation, in screen name and tree order. */
  screens: Map<string, Map<string, NodeEvaluation>>;
}

export const EXCEPTION_BY = 'exception';

function byRef(a: RuleEntry, b: RuleEntry): number {
  return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
}

const VERDICT_RANK: Record<Verdict, number> = {
  winner: 0,
  tied: 1,
  ambiguous: 1,
  'less-specific': 2,
  'lower-layer': 3,
  exception: 3,
  disabled: 4,
};
const LAYER_RANK: Record<Layer, number> = { screen: 0, project: 1, default: 2 };

function compareTraces(a: RuleTrace, b: RuleTrace): number {
  return (
    VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] ||
    LAYER_RANK[a.layer] - LAYER_RANK[b.layer] ||
    b.specificity - a.specificity ||
    (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)
  );
}

function traceOf(entry: RuleEntry, verdict: Verdict, disabledBecause?: string): RuleTrace {
  return {
    ref: entry.ref,
    layer: entry.layer,
    value: entry.rule.value,
    specificity: entry.specificity,
    because: entry.rule.because,
    verdict,
    disabledBecause,
  };
}

/**
 * Decides one point for one node: a node exception first, otherwise the most specific rule of
 * the highest layer that has a match. Equal specificity with different values is ambiguous and
 * decides nothing. Only the facts and the rules matter, never the order of the rules in a file.
 */
export function evaluatePoint(
  index: RuleIndex,
  screen: string,
  facts: NodeFacts,
  point: DecisionPoint,
  exception?: NodeException,
): PointOutcome {
  const layers: RuleEntry[][] = [
    index.screens.get(screen)?.get(point.name) ?? [],
    index.project.get(point.name) ?? [],
    index.default.get(point.name) ?? [],
  ];
  const traces: RuleTrace[] = [];
  const matched: RuleEntry[][] = layers.map((entries) => {
    const hits: RuleEntry[] = [];
    for (const entry of [...entries].sort(byRef)) {
      if (!matchesWhen(entry.rule.when, facts)) continue;
      const disabledBecause = index.disabled.get(entry.ref);
      if (disabledBecause !== undefined) traces.push(traceOf(entry, 'disabled', disabledBecause));
      else hits.push(entry);
    }
    return hits;
  });

  const outcome = (partial: Partial<PointOutcome>): PointOutcome => ({
    point: point.name,
    status: 'undecided',
    rules: traces.sort(compareTraces),
    tied: [],
    ...partial,
  });

  if (exception && valueProblem(point.name, exception.value) === undefined) {
    for (const entry of matched.flat()) traces.push(traceOf(entry, 'exception'));
    return outcome({
      status: 'decided',
      decision: { value: exception.value, by: EXCEPTION_BY },
      because: exception.because,
    });
  }

  const winningLayer = matched.findIndex((hits) => hits.length > 0);
  let result: Partial<PointOutcome> = {};
  matched.forEach((hits, layer) => {
    if (hits.length === 0) return;
    if (layer !== winningLayer) {
      for (const entry of hits) traces.push(traceOf(entry, 'lower-layer'));
      return;
    }
    const top = Math.max(...hits.map((entry) => entry.specificity));
    const leaders = hits.filter((entry) => entry.specificity === top);
    const values = new Set(leaders.map((entry) => entry.rule.value));
    for (const entry of hits) {
      if (entry.specificity < top) traces.push(traceOf(entry, 'less-specific'));
    }
    const [winner] = leaders;
    if (values.size > 1 || winner === undefined) {
      for (const entry of leaders) traces.push(traceOf(entry, 'ambiguous'));
      result = { status: 'ambiguous', tied: leaders.map((entry) => entry.ref) };
      return;
    }
    traces.push(traceOf(winner, 'winner'));
    for (const entry of leaders.slice(1)) traces.push(traceOf(entry, 'tied'));
    result = {
      status: 'decided',
      decision: { value: winner.rule.value, by: winner.ref },
      because: winner.rule.because,
    };
  });
  return outcome(result);
}

/** Nodes of every screen, evaluated against all three layers and the node exceptions. */
export function evaluate(inputs: RuleInputs): Evaluation {
  const index = buildRuleIndex({
    pack: inputs.pack,
    project: inputs.project,
    screens: inputs.screens,
  });
  const cross: CrossScreenIndex = buildCrossScreenIndex(
    [...inputs.screens.values()].map((input) => input.doc),
  );
  const screens = new Map<string, Map<string, NodeEvaluation>>();
  for (const [screen, input] of inputs.screens) {
    const exceptions = new Map(
      input.rules.exceptions.map((entry) => [`${entry.node}|${entry.point}`, entry]),
    );
    const nodes = new Map<string, NodeEvaluation>();
    for (const [id, facts] of computeScreenFacts(input.doc, cross)) {
      const outcomes = new Map<string, PointOutcome>();
      for (const point of DECISION_POINTS) {
        if (!point.applies(facts)) continue;
        outcomes.set(
          point.name,
          evaluatePoint(index, screen, facts, point, exceptions.get(`${id}|${point.name}`)),
        );
      }
      nodes.set(id, { id, facts, outcomes });
    }
    screens.set(screen, nodes);
  }
  return { index, screens };
}

/** The `decisions` field a node should have. */
export function decisionsOf(node: NodeEvaluation): Record<string, Decision> {
  const decisions: Record<string, Decision> = {};
  for (const [point, outcome] of node.outcomes) {
    if (outcome.decision) decisions[point] = { ...outcome.decision };
  }
  return decisions;
}

export interface Ambiguity {
  screen: string;
  point: string;
  /** The rules that cannot be told apart, sorted. */
  rules: string[];
  specificity: number;
  nodes: string[];
}

/** Ambiguous points grouped by the pair (set) of rules behind them. */
export function collectAmbiguities(evaluation: Evaluation): Ambiguity[] {
  const groups = new Map<string, Ambiguity>();
  for (const [screen, nodes] of evaluation.screens) {
    for (const node of nodes.values()) {
      for (const outcome of node.outcomes.values()) {
        if (outcome.status !== 'ambiguous') continue;
        const rules = [...outcome.tied].sort();
        const key = `${screen}|${outcome.point}|${rules.join('|')}`;
        const group = groups.get(key) ?? {
          screen,
          point: outcome.point,
          rules,
          specificity: evaluation.index.byRef.get(rules[0] ?? '')?.specificity ?? 0,
          nodes: [],
        };
        group.nodes.push(node.id);
        groups.set(key, group);
      }
    }
  }
  return [...groups.values()];
}
