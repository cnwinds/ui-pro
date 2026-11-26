import { defineOp, ScreenNameSchema } from '@ui-pro/core';
import { z } from 'zod';
import { readTxInputs } from '../inputs';
import { RuleIdSchema } from '../schema';
import { editProjectRules, editScreenRules, ruleNotFound, scopeScreen } from './shared';

export const ruleRemoveOp = defineOp({
  name: 'rule.remove',
  family: 'rules',
  summary: '删除项目规则（含待定区）或界面规则里的一条规则；默认规则包里的规则只能停用，不能删除',
  schema: z.strictObject({
    op: z.literal('rule.remove'),
    id: RuleIdSchema,
    scope: z.enum(['project', 'screen']).default('project'),
    /** Screen for `scope: screen`; defaults to the current screen. */
    screen: ScreenNameSchema.optional(),
  }),
  apply(ctx, op) {
    const inputs = readTxInputs(ctx);
    if (op.scope === 'project') {
      const { rules, pending } = inputs.project;
      if (![...rules, ...pending].some((rule) => rule.id === op.id)) {
        throw ruleNotFound(
          `项目规则和待定区里都没有规则 ${op.id}`,
          '默认规则包的规则不能删除，用 rule.disable 停用',
        );
      }
      editProjectRules(ctx, (doc) => {
        doc.rules = doc.rules.filter((rule) => rule.id !== op.id);
        doc.pending = doc.pending.filter((rule) => rule.id !== op.id);
        doc.disabled = doc.disabled.filter((entry) => entry.rule !== `${op.id}@project`);
      });
      return;
    }
    const screen = scopeScreen(ctx, op.screen);
    if (!inputs.screens.get(screen)?.rules.rules.some((rule) => rule.id === op.id)) {
      throw ruleNotFound(`界面 ${screen} 的规则里没有 ${op.id}`);
    }
    editScreenRules(ctx, screen, (doc) => {
      doc.rules = doc.rules.filter((rule) => rule.id !== op.id);
    });
  },
});
