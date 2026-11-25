import { z } from 'zod';
import { defineOp } from '../tx/registry';
import { EvidenceRefsSchema, NodeSpecSchema } from './node-spec';
import { addNode } from './shared';

export const nodeAdd = defineOp({
  name: 'node.add',
  family: 'structure',
  summary: '新增节点；省略 rect 时由 from 指向的证据区域推算',
  schema: z.strictObject({
    op: z.literal('node.add'),
    node: NodeSpecSchema,
    /** Evidence refs (`cand#12`, `layer#34`) backing the node. */
    from: EvidenceRefsSchema.optional(),
  }),
  apply(ctx, op) {
    addNode(ctx, { spec: op.node, evidence: op.from ?? [] });
  },
});
