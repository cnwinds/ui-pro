import { z } from 'zod';
import { PositiveRectSchema } from '../schema/common';
import { defineOp } from '../tx/registry';
import { EvidenceRefsSchema } from './node-spec';
import { invalidOp, rectFromEvidence } from './shared';

export const exclusionAdd = defineOp({
  name: 'exclusion.add',
  family: 'structure',
  summary:
    '把源文件里不属于界面的一块（截图带入的系统按钮、水印）标为排除区：构建时在覆盖它的资产里补全，保真度量跳过它',
  schema: z
    .strictObject({
      op: z.literal('exclusion.add'),
      rect: PositiveRectSchema.optional(),
      evidence: EvidenceRefsSchema.optional(),
      because: z.string().trim().min(1, 'because 不能为空：排除必须写明理由'),
    })
    .refine((op) => op.rect !== undefined || op.evidence !== undefined, '需要 rect 或 evidence'),
  apply(ctx, op) {
    const doc = ctx.screen();
    const evidence = op.evidence ?? [];
    const rect = op.rect ?? rectFromEvidence(ctx, doc, evidence);
    const used = new Set(doc.exclusions.map((exclusion) => exclusion.id));
    let n = 1;
    while (used.has(`ex_${n}`)) n += 1;
    doc.exclusions.push({ id: `ex_${n}`, rect, because: op.because, evidence: [...evidence] });
  },
});

export const exclusionRemove = defineOp({
  name: 'exclusion.remove',
  family: 'structure',
  summary: '撤销一个排除区，这块像素重新算作界面的一部分',
  schema: z.strictObject({
    op: z.literal('exclusion.remove'),
    id: z.string().min(1),
  }),
  apply(ctx, op) {
    const doc = ctx.screen();
    const index = doc.exclusions.findIndex((exclusion) => exclusion.id === op.id);
    if (index < 0) {
      const known = doc.exclusions.map((exclusion) => exclusion.id).join('、') || '（无）';
      throw invalidOp(`界面 ${doc.name} 没有排除区 ${op.id}`, `现有排除区：${known}`);
    }
    doc.exclusions.splice(index, 1);
  },
});
