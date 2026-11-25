import { z } from 'zod';
import {
  ConceptNameSchema,
  NodeIdSchema,
  PositiveRectSchema,
  PrimitiveSchema,
  RoleSchema,
  VariesSchema,
} from '../schema/common';
import { TextSpecSchema } from '../schema/screen';

/** The node description shared by `node.add` and `node.split`. */
export const NodeSpecSchema = z.strictObject({
  id: NodeIdSchema.optional(),
  type: PrimitiveSchema,
  role: RoleSchema.optional(),
  concept: ConceptNameSchema.optional(),
  rect: PositiveRectSchema.optional(),
  /** Selector for the parent; defaults to the screen root (or the split source). */
  parent: z.string().min(1).optional(),
  /** Position among the parent's children, back-to-front; defaults to the top. */
  index: z.number().int().nonnegative().optional(),
  varies: VariesSchema.optional(),
  text: TextSpecSchema.optional(),
  visible: z.boolean().optional(),
});
export type NodeSpec = z.infer<typeof NodeSpecSchema>;

export const EvidenceRefsSchema = z.array(z.string().min(1));
