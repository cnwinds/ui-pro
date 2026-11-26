import { defineOp, parseRef, ScreenNameSchema, type TxContext, UiProError } from '@ui-pro/core';
import { z } from 'zod';
import { RulesErrorCodes } from '../errors';
import { evaluate } from '../evaluate';
import { readTxInputs } from '../inputs';
import { type Rule, RuleIdSchema, RuleSchema } from '../schema';
import {
  assertDecidable,
  assertExamplesExist,
  editProjectRules,
  editScreenRules,
  ruleNotFound,
  scopeScreen,
} from './shared';

const exists = (id: string, where: string) =>
  new UiProError(RulesErrorCodes.exists, `${where}里已有规则 ${id}`, {
    hint: '换一个 id，或先用 rule.remove 移除旧的',
  });

export const ruleAdoptOp = defineOp({
  name: 'rule.adopt',
  family: 'rules',
  summary:
    '让一条规则生效：scope 为 project 时写入项目规则，为 screen 时写入指定界面的界面规则；可引用待定区里的规则，也可直接给出规则',
  schema: z
    .strictObject({
      op: z.literal('rule.adopt'),
      /** A rule in the pending area of the project rules. */
      id: RuleIdSchema.optional(),
      rule: RuleSchema.optional(),
      scope: z.enum(['project', 'screen']).default('project'),
      /** Screen for `scope: screen`; defaults to the current screen. */
      screen: ScreenNameSchema.optional(),
    })
    .refine(
      (op) => (op.id === undefined) !== (op.rule === undefined),
      '须且只能给出 id 或 rule 之一',
    ),
  apply(ctx, op) {
    const inputs = readTxInputs(ctx);
    let rule = op.rule;
    if (op.id !== undefined) {
      rule = inputs.project.pending.find((pending) => pending.id === op.id);
      if (!rule) {
        throw ruleNotFound(
          `待定区里没有规则 ${op.id}`,
          '先用 rule.propose 提出，或直接在 rule 里给出规则',
        );
      }
    }
    if (!rule) return;
    rule = structuredClone(rule);
    assertDecidable(rule.point, rule.value);
    assertExamplesExist(inputs, rule);
    const adopted = rule;

    if (op.scope === 'project') {
      if (inputs.project.rules.some((existing) => existing.id === adopted.id)) {
        throw exists(adopted.id, '项目规则');
      }
      editProjectRules(ctx, (doc) => {
        doc.rules.push(adopted);
        doc.pending = doc.pending.filter((pending) => pending.id !== adopted.id);
      });
    } else {
      const screen = scopeScreen(ctx, op.screen);
      if (inputs.screens.get(screen)?.rules.rules.some((existing) => existing.id === adopted.id)) {
        throw exists(adopted.id, `界面 ${screen} 的规则`);
      }
      editScreenRules(ctx, screen, (doc) => {
        doc.rules.push(adopted);
      });
      editProjectRules(ctx, (doc) => {
        doc.pending = doc.pending.filter((pending) => pending.id !== adopted.id);
      });
    }

    warnUnmetExamples(ctx, adopted);
  },
});

/** An example that does not get the rule's value even with the rule in force says it is shadowed. */
function warnUnmetExamples(ctx: TxContext, rule: Rule): void {
  if (!rule.examples || rule.examples.length === 0) return;
  const evaluation = evaluate(readTxInputs(ctx));
  for (const ref of rule.examples) {
    const { screen, id } = parseRef(ref);
    const outcome = evaluation.screens.get(screen)?.get(id)?.outcomes.get(rule.point);
    if (outcome?.decision?.value === rule.value) continue;
    const actual = outcome?.decision
      ? `${outcome.decision.value}（${outcome.decision.by}）`
      : '没有决定';
    ctx.warn(
      `规则 ${rule.id} 生效后，样例 ${ref} 在 ${rule.point} 上仍是${actual}，而不是 ${rule.value}`,
    );
  }
}
