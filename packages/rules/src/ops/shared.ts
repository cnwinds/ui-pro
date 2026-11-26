import { invalidOp, parseRef, SINGLETON_KEY, type TxContext, UiProError } from '@ui-pro/core';
import { projectRulesKind, screenRulesKind } from '../docs';
import { RulesErrorCodes } from '../errors';
import { type Evaluation, evaluate, type PointOutcome } from '../evaluate';
import { type RuleInputs, txProjectRules, txScreenRules } from '../inputs';
import { getPoint, unknownPointHint, valueProblem } from '../points';
import type { ProjectRules, Rule, ScreenRules } from '../schema';

export function invalidRule(message: string, hint?: string): UiProError {
  return new UiProError(RulesErrorCodes.invalid, message, { hint });
}

export function ruleNotFound(message: string, hint?: string): UiProError {
  return new UiProError(RulesErrorCodes.notFound, message, { hint });
}

/** The point must exist and take the value. */
export function assertDecidable(point: string, value: string): void {
  if (getPoint(point) === undefined) {
    throw invalidRule(`未知的决策点：${point}`, unknownPointHint());
  }
  const problem = valueProblem(point, value);
  if (problem !== undefined) throw invalidRule(problem, 'ui-pro rules list 可以看到现有规则的写法');
}

/** Edits `rules/project.yaml` in the transaction and stores the result. */
export function editProjectRules(ctx: TxContext, edit: (doc: ProjectRules) => void): void {
  const doc = txProjectRules(ctx);
  edit(doc);
  ctx.setDoc(projectRulesKind, SINGLETON_KEY, doc);
}

/** Edits `screens/<screen>/rules.yaml` in the transaction and stores the result. */
export function editScreenRules(
  ctx: TxContext,
  screen: string,
  edit: (doc: ScreenRules) => void,
): void {
  const doc = txScreenRules(ctx, screen);
  edit(doc);
  ctx.setDoc(screenRulesKind, screen, doc);
}

/** Screen for `scope: screen`: the one named in the op, else the current one. */
export function scopeScreen(ctx: TxContext, named: string | undefined): string {
  const screen = named ?? ctx.currentScreen;
  if (screen === undefined) {
    throw invalidOp(
      'scope 为 screen 时需要指定界面',
      '在操作里写 "screen": "<界面名>"，或用 --screen 指定当前界面',
    );
  }
  ctx.screen(screen);
  return screen;
}

/** Examples must point at nodes that exist now. */
export function assertExamplesExist(inputs: RuleInputs, rule: Rule): void {
  for (const ref of rule.examples ?? []) {
    const { screen, id } = parseRef(ref);
    if (!inputs.screens.get(screen)?.doc.nodes[id]) {
      throw invalidOp(`样例节点不存在：${ref}`, '样例必须是现有节点，形如 <界面>/#<id>');
    }
  }
}

export function describeOutcome(outcome: PointOutcome | undefined): string {
  if (outcome?.decision) return outcome.decision.value;
  return outcome?.status === 'ambiguous' ? '歧义（无决定）' : '无决定';
}

export interface DecisionChange {
  screen: string;
  node: string;
  point: string;
  from: string;
  to: string;
}

/** Every (node, point) whose decision differs between two evaluations. */
export function diffEvaluations(before: Evaluation, after: Evaluation): DecisionChange[] {
  const changes: DecisionChange[] = [];
  for (const [screen, nodes] of after.screens) {
    for (const [id, node] of nodes) {
      const previous = before.screens.get(screen)?.get(id);
      for (const [point, outcome] of node.outcomes) {
        const from = describeOutcome(previous?.outcomes.get(point));
        const to = describeOutcome(outcome);
        if (from !== to) changes.push({ screen, node: id, point, from, to });
      }
    }
  }
  return changes;
}

/** What the project would decide if `rule` were a project rule, against what it decides now. */
export function projectImpact(inputs: RuleInputs, rule: Rule): DecisionChange[] {
  const adopted: RuleInputs = {
    ...inputs,
    project: { ...inputs.project, rules: [...inputs.project.rules, rule] },
  };
  return diffEvaluations(evaluate(inputs), evaluate(adopted));
}
