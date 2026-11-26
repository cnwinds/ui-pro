import { defineOp, invalidOp } from '@ui-pro/core';
import { z } from 'zod';
import { evaluate } from '../evaluate';
import { readTxInputs } from '../inputs';
import { getPoint } from '../points';
import { ExceptionSchema } from '../schema';
import { assertDecidable, editScreenRules, ruleNotFound } from './shared';

export const exceptionAddOp = defineOp({
  name: 'exception.add',
  family: 'rules',
  summary:
    '给选择器匹配到的节点写入节点例外：只对这些节点在指定决策点上取指定的值，压过所有规则层；必须写理由',
  schema: z.strictObject({
    op: z.literal('exception.add'),
    target: z.string().min(1),
    point: ExceptionSchema.shape.point,
    value: ExceptionSchema.shape.value,
    because: ExceptionSchema.shape.because,
  }),
  apply(ctx, op) {
    assertDecidable(op.point, op.value);
    const point = getPoint(op.point);
    const refs = ctx.select(op.target, { min: 1 });
    const evaluation = evaluate(readTxInputs(ctx));
    for (const ref of refs) {
      const facts = evaluation.screens.get(ref.screen)?.get(ref.id)?.facts;
      if (facts && point && !point.applies(facts)) {
        throw invalidOp(
          `决策点 ${op.point} 不适用于节点 ${ref.screen}/#${ref.id}`,
          `适用范围：${point.scope}`,
        );
      }
    }
    for (const ref of refs) {
      editScreenRules(ctx, ref.screen, (doc) => {
        const existing = doc.exceptions.find(
          (entry) => entry.node === ref.id && entry.point === op.point,
        );
        if (existing) {
          ctx.warn(
            `节点 ${ref.screen}/#${ref.id} 在 ${op.point} 上原有的节点例外（取值 ${existing.value}）已被替换`,
          );
          existing.value = op.value;
          existing.because = op.because;
          return;
        }
        doc.exceptions.push({
          node: ref.id,
          point: op.point,
          value: op.value,
          because: op.because,
        });
      });
    }
  },
});

export const exceptionRemoveOp = defineOp({
  name: 'exception.remove',
  family: 'rules',
  summary: '移除选择器匹配到的节点上的节点例外；给出 point 时只移除那个决策点上的',
  schema: z.strictObject({
    op: z.literal('exception.remove'),
    target: z.string().min(1),
    point: ExceptionSchema.shape.point.optional(),
  }),
  apply(ctx, op) {
    const refs = ctx.select(op.target, { min: 1 });
    const inputs = readTxInputs(ctx);
    let removed = 0;
    for (const ref of refs) {
      const exceptions = inputs.screens.get(ref.screen)?.rules.exceptions ?? [];
      const doomed = exceptions.filter(
        (entry) => entry.node === ref.id && (op.point === undefined || entry.point === op.point),
      );
      if (doomed.length === 0) continue;
      removed += doomed.length;
      editScreenRules(ctx, ref.screen, (doc) => {
        doc.exceptions = doc.exceptions.filter((entry) => !doomed.includes(entry));
      });
    }
    if (removed === 0) {
      throw ruleNotFound(
        `选择器 ${op.target} 匹配到的节点上没有${op.point === undefined ? '' : ` ${op.point} 的`}节点例外`,
      );
    }
  },
});
