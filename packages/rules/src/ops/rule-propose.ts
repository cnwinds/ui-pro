import { defineOp, UiProError } from '@ui-pro/core';
import { z } from 'zod';
import { RulesErrorCodes } from '../errors';
import { readTxInputs } from '../inputs';
import { RuleSchema } from '../schema';
import {
  assertDecidable,
  assertExamplesExist,
  type DecisionChange,
  editProjectRules,
  projectImpact,
} from './shared';

const MAX_LISTED_CHANGES = 20;

function describeImpact(changes: readonly DecisionChange[]): string[] {
  if (changes.length === 0) return ['这条规则按整个项目生效，不会改变任何节点的任何决定'];
  const screens = new Set(changes.map((change) => change.screen));
  const lines = changes
    .slice(0, MAX_LISTED_CHANGES)
    .map(
      (change) =>
        `${change.screen}/#${change.node} 的 ${change.point}：${change.from} → ${change.to}`,
    );
  if (changes.length > lines.length) lines.push(`…另有 ${changes.length - lines.length} 处`);
  return [
    `这条规则按整个项目生效，会改变 ${changes.length} 处决定，涉及 ${screens.size} 个界面`,
    ...lines,
  ];
}

export const ruleProposeOp = defineOp({
  name: 'rule.propose',
  family: 'rules',
  summary:
    '提出一条规则：写入项目规则的待定区（暂不生效），列出它按整个项目生效时的影响清单，并询问适用范围',
  schema: z.strictObject({
    op: z.literal('rule.propose'),
    rule: RuleSchema,
  }),
  apply(ctx, op) {
    const rule = structuredClone(op.rule);
    assertDecidable(rule.point, rule.value);
    const inputs = readTxInputs(ctx);
    assertExamplesExist(inputs, rule);
    if (
      inputs.project.rules.some((existing) => existing.id === rule.id) ||
      inputs.project.pending.some((existing) => existing.id === rule.id)
    ) {
      throw new UiProError(RulesErrorCodes.exists, `项目规则里已有规则 ${rule.id}`, {
        hint: '换一个 id，或先用 rule.remove 移除旧的',
      });
    }

    for (const line of describeImpact(projectImpact(inputs, rule))) ctx.warn(line);
    editProjectRules(ctx, (doc) => {
      doc.pending.push(rule);
    });
    ctx.ask({
      id: 'scope',
      question: `规则 ${rule.id} 的适用范围：整个项目（project）、仅本界面（screen），还是仅这一个节点（node，写成节点例外，必须给理由）？`,
      options: ['project', 'screen', 'node'],
      default: 'project',
    });
  },
});
