import { z } from 'zod';
import { PositiveRectSchema } from '../schema/common';
import { defineOp } from '../tx/registry';
import { EvidenceRefsSchema, NodeSpecSchema } from './node-spec';
import { addNode, selectOne } from './shared';

const PartSchema = z
  .strictObject({
    evidence: EvidenceRefsSchema.optional(),
    rect: PositiveRectSchema.optional(),
  })
  .refine(
    (part) => part.evidence !== undefined || part.rect !== undefined,
    'part 需要 evidence 或 rect',
  );

export const nodeSplit = defineOp({
  name: 'node.split',
  family: 'structure',
  summary: '从一个节点里拆出一部分作为新节点（默认成为它的子节点）',
  schema: z.strictObject({
    op: z.literal('node.split'),
    from: z.string().min(1),
    part: PartSchema,
    as: NodeSpecSchema.omit({ rect: true }),
  }),
  apply(ctx, op) {
    const host = selectOne(ctx, op.from);
    addNode(ctx, {
      spec: op.as,
      evidence: op.part.evidence ?? [],
      rect: op.part.rect,
      defaultParent: host,
      screen: host.screen,
    });
  },
});
