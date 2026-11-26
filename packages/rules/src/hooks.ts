import { isDeepStrictEqual } from 'node:util';
import { formatRef, listScreens, type RenameEvent, type TxContext } from '@ui-pro/core';
import { collectAmbiguities, decisionsOf, type Evaluation, evaluate } from './evaluate';
import { type RuleInputs, readTxInputs, txProjectRules, txScreenRules } from './inputs';
import type { Rule } from './schema';

const MAX_LISTED_NODES = 8;

function listNodes(ids: readonly string[]): string {
  const shown = ids
    .slice(0, MAX_LISTED_NODES)
    .map((id) => `#${id}`)
    .join('、');
  return ids.length > MAX_LISTED_NODES ? `${shown} 等 ${ids.length} 个节点` : shown;
}

/** Exceptions of nodes that no longer exist are removed, each with a warning. */
function dropDeadExceptions(ctx: TxContext, inputs: RuleInputs): void {
  for (const [screen, { doc, rules }] of inputs.screens) {
    const dead = rules.exceptions.filter((entry) => !(entry.node in doc.nodes));
    if (dead.length === 0) continue;
    rules.exceptions = rules.exceptions.filter((entry) => entry.node in doc.nodes);
    for (const entry of dead) {
      ctx.warn(
        `界面 ${screen} 的节点 #${entry.node} 已不存在，它在 ${entry.point} 上的节点例外（取值 ${entry.value}，理由：${entry.because}）已一并移除`,
      );
    }
  }
}

function warnAmbiguities(ctx: TxContext, evaluation: Evaluation): void {
  for (const ambiguity of collectAmbiguities(evaluation)) {
    ctx.warn(
      `界面 ${ambiguity.screen} 的决策点 ${ambiguity.point} 有歧义，没有写入决定：规则 ${ambiguity.rules.join('、')} 同样具体（各 ${ambiguity.specificity} 个条件）但取值不同；受影响：${listNodes(ambiguity.nodes)}`,
    );
  }
}

/**
 * `beforeCommit`: rewrites every node's `decisions` from the current facts and rules, so every
 * commit leaves them up to date and a dry run shows which nodes a rule change would touch.
 */
export function recomputeDecisions(ctx: TxContext): void {
  const inputs = readTxInputs(ctx);
  dropDeadExceptions(ctx, inputs);
  const evaluation = evaluate(inputs);
  for (const [screen, nodes] of evaluation.screens) {
    const doc = inputs.screens.get(screen)?.doc;
    if (!doc) continue;
    for (const [id, node] of nodes) {
      const target = doc.nodes[id];
      if (!target) continue;
      const decisions = decisionsOf(node);
      if (!isDeepStrictEqual(target.decisions, decisions)) target.decisions = decisions;
    }
  }
  warnAmbiguities(ctx, evaluation);
}

function renameExamples(rules: readonly Rule[], from: string, to: string): void {
  for (const rule of rules) {
    if (rule.examples) rule.examples = rule.examples.map((ref) => (ref === from ? to : ref));
  }
}

/** `rename`: node exceptions, and the examples of rules, follow the node to its new id. */
export function followRename(ctx: TxContext, event: RenameEvent): void {
  const from = formatRef({ screen: event.screen, id: event.from });
  const to = formatRef({ screen: event.screen, id: event.to });

  for (const entry of txScreenRules(ctx, event.screen).exceptions) {
    if (entry.node === event.from) entry.node = event.to;
  }
  const project = txProjectRules(ctx);
  renameExamples(project.rules, from, to);
  renameExamples(project.pending, from, to);
  for (const name of listScreens(ctx.project)) {
    renameExamples(txScreenRules(ctx, name).rules, from, to);
  }
}
