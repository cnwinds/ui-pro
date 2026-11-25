import { z } from 'zod';
import {
  ConceptNameSchema,
  PairSchema,
  PositiveRectSchema,
  PrimitiveSchema,
  RoleSchema,
  VariesSchema,
} from '../schema/common';
import { AnchorSchema, TextSpecSchema, type UINode } from '../schema/screen';
import { defineOp } from '../tx/registry';
import { EvidenceRefsSchema } from './node-spec';
import { editNodes } from './shared';

/** Fields `node.set` can change. `null` clears an optional field; omitted fields stay as they are. */
const NodeSetSchema = z
  .strictObject({
    type: PrimitiveSchema.optional(),
    role: RoleSchema.nullable().optional(),
    concept: ConceptNameSchema.nullable().optional(),
    varies: VariesSchema.optional(),
    text: TextSpecSchema.nullable().optional(),
    visible: z.boolean().optional(),
    confidence: z.number().min(0).max(1).nullable().optional(),
    rect: PositiveRectSchema.optional(),
    evidence: EvidenceRefsSchema.optional(),
    anchor: AnchorSchema.nullable().optional(),
    pivot: PairSchema.nullable().optional(),
  })
  .refine((fields) => Object.values(fields).some((value) => value !== undefined), 'set 不能为空');
type NodeSet = z.infer<typeof NodeSetSchema>;

function applySet(node: UINode, set: NodeSet): void {
  if (set.type !== undefined) node.type = set.type;
  if (set.role !== undefined) node.role = set.role ?? undefined;
  if (set.concept !== undefined) node.concept = set.concept ?? undefined;
  if (set.varies !== undefined) node.varies = set.varies;
  if (set.text !== undefined) node.text = set.text ?? undefined;
  if (set.visible !== undefined) node.visible = set.visible;
  if (set.confidence !== undefined) node.confidence = set.confidence ?? undefined;
  if (set.rect !== undefined) node.rect = set.rect;
  if (set.evidence !== undefined) node.evidence = set.evidence;
  if (set.anchor !== undefined) node.anchor = set.anchor ?? undefined;
  if (set.pivot !== undefined) node.pivot = set.pivot ?? undefined;
}

export const nodeSet = defineOp({
  name: 'node.set',
  family: 'structure',
  summary:
    '修改匹配到的每个节点的字段（类型、角色、概念、可变性、文字、显隐、置信度、矩形、证据、锚点、轴心）；null 表示清除',
  schema: z.strictObject({
    op: z.literal('node.set'),
    target: z.string().min(1),
    set: NodeSetSchema,
  }),
  apply(ctx, op) {
    editNodes(ctx, op.target, (node) => applySet(node, op.set));
  },
});
