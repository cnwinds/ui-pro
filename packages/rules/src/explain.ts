import type { NodeRef } from '@ui-pro/core';
import { type Decision, evaluate, type PointOutcome } from './evaluate';
import { describeFacts } from './facts';
import type { RuleInputs } from './inputs';
import { getPoint } from './points';

export interface PointExplanation {
  point: string;
  /** What the decision point decides, in Simplified Chinese. */
  summary: string;
  status: PointOutcome['status'];
  value?: string;
  /** The rule reference or `exception` behind the value. */
  by?: string;
  because?: string;
  /** Every rule that matched, highest layer first; those after the winner were overridden. */
  rules: PointOutcome['rules'];
  /** The decision stored in the node when it differs from the one the current rules give. */
  stored?: Decision | null;
}

export interface NodeExplanation {
  screen: string;
  id: string;
  type: string;
  role?: string;
  concept?: string;
  facts: Record<string, unknown>;
  points: PointExplanation[];
}

/** For each node, each applicable decision point with its value and the rules for and against. */
export function explainNodes(
  inputs: RuleInputs,
  refs: readonly NodeRef[],
  options: { point?: string } = {},
): NodeExplanation[] {
  const evaluation = evaluate(inputs);
  const result: NodeExplanation[] = [];
  for (const ref of refs) {
    const node = evaluation.screens.get(ref.screen)?.get(ref.id);
    const doc = inputs.screens.get(ref.screen)?.doc;
    const uinode = doc?.nodes[ref.id];
    if (!node || !uinode) continue;
    const points: PointExplanation[] = [];
    for (const [name, outcome] of node.outcomes) {
      if (options.point !== undefined && name !== options.point) continue;
      const stored = uinode.decisions[name];
      const differs =
        stored?.value !== outcome.decision?.value || stored?.by !== outcome.decision?.by;
      points.push({
        point: name,
        summary: getPoint(name)?.summary ?? name,
        status: outcome.status,
        value: outcome.decision?.value,
        by: outcome.decision?.by,
        because: outcome.because,
        rules: outcome.rules,
        stored: differs ? (stored ?? null) : undefined,
      });
    }
    result.push({
      screen: ref.screen,
      id: ref.id,
      type: uinode.type,
      role: uinode.role,
      concept: uinode.concept,
      facts: describeFacts(node.facts),
      points,
    });
  }
  return result;
}
