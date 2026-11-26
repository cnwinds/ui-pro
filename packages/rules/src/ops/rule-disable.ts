import { defineOp, type TxContext, UiProError } from '@ui-pro/core';
import { z } from 'zod';
import { RulesErrorCodes } from '../errors';
import { readTxInputs } from '../inputs';
import { buildRuleIndex, isFallback, type RuleEntry, splitRuleRef } from '../layers';
import { editProjectRules, ruleNotFound } from './shared';

const REF_HINT = '规则写成 <id>@default 或 <id>@project；ui-pro rules list 列出现有规则';

/** `<id>` alone is enough when only one of the default pack and the project rules has it. */
function findShared(ctx: TxContext, text: string): RuleEntry {
  const inputs = readTxInputs(ctx);
  const index = buildRuleIndex(inputs);
  const { id, layer } = splitRuleRef(text);
  if (layer?.startsWith('screen:')) {
    throw new UiProError(RulesErrorCodes.invalid, `不能停用界面规则 ${text}`, {
      hint: '界面规则用 rule.remove 移除；停用只针对默认规则包和项目规则',
    });
  }
  const refs = layer === undefined ? [`${id}@default`, `${id}@project`] : [`${id}@${layer}`];
  const found = refs.flatMap((ref) => {
    const entry = index.byRef.get(ref);
    return entry ? [entry] : [];
  });
  const [only] = found;
  if (only === undefined) throw ruleNotFound(`找不到规则 ${text}`, REF_HINT);
  if (found.length > 1) {
    throw new UiProError(RulesErrorCodes.invalid, `规则 ${id} 同时存在于默认规则包和项目规则`, {
      hint: `写明层：${found.map((entry) => entry.ref).join(' 或 ')}`,
    });
  }
  return only;
}

export const ruleDisableOp = defineOp({
  name: 'rule.disable',
  family: 'rules',
  summary: '停用默认规则包或项目规则里的一条规则（必须写理由）；每个决策点的兜底规则不能停用',
  schema: z.strictObject({
    op: z.literal('rule.disable'),
    rule: z.string().min(1),
    because: z.string().trim().min(1, '停用规则必须写理由（because 不能为空）'),
  }),
  apply(ctx, op) {
    const entry = findShared(ctx, op.rule);
    if (isFallback(entry)) {
      throw new UiProError(
        RulesErrorCodes.protected,
        `规则 ${entry.ref} 是决策点 ${entry.rule.point} 的兜底规则，不能停用`,
        {
          hint: '没有兜底规则，这个决策点就不再对每个节点都有决定；要换取值，请写一条更具体的规则',
        },
      );
    }
    editProjectRules(ctx, (doc) => {
      doc.disabled = [
        ...doc.disabled.filter((existing) => existing.rule !== entry.ref),
        { rule: entry.ref, because: op.because },
      ];
    });
  },
});

export const ruleEnableOp = defineOp({
  name: 'rule.enable',
  family: 'rules',
  summary: '恢复一条被停用的规则',
  schema: z.strictObject({
    op: z.literal('rule.enable'),
    rule: z.string().min(1),
  }),
  apply(ctx, op) {
    const { id, layer } = splitRuleRef(op.rule);
    const wanted = layer === undefined ? [`${id}@default`, `${id}@project`] : [op.rule];
    const disabled = readTxInputs(ctx).project.disabled.filter((entry) =>
      wanted.includes(entry.rule),
    );
    if (disabled.length === 0) {
      throw ruleNotFound(
        `规则 ${op.rule} 没有被停用`,
        'ui-pro rules list --disabled 列出被停用的规则',
      );
    }
    editProjectRules(ctx, (doc) => {
      doc.disabled = doc.disabled.filter((entry) => !wanted.includes(entry.rule));
    });
  },
});
