import { z } from 'zod';
import { ConceptNameSchema, RoleSchema } from '../schema/common';
import { requireNode } from '../screen/tree';
import { formatRef } from '../selector/ref';
import { defineOp } from '../tx/registry';

export const conceptDefine = defineOp({
  name: 'concept.define',
  family: 'structure',
  summary: '在概念库里定义或更新概念，并把概念（及角色）标到样例节点上',
  schema: z.strictObject({
    op: z.literal('concept.define'),
    name: ConceptNameSchema,
    role: RoleSchema.optional(),
    description: z.string().optional(),
    /** Selector for the example nodes; they are added to the concept's exemplars. */
    exemplars: z.string().min(1).optional(),
  }),
  apply(ctx, op) {
    const examples = op.exemplars === undefined ? [] : ctx.select(op.exemplars, { min: 1 });
    const glossary = ctx.glossary();
    let concept = glossary.concepts.find((candidate) => candidate.name === op.name);
    if (!concept) {
      concept = { name: op.name, exemplars: [] };
      glossary.concepts.push(concept);
    }
    if (op.role !== undefined) concept.role = op.role;
    if (op.description !== undefined) concept.description = op.description;

    for (const ref of examples) {
      const node = requireNode(ctx.screen(ref.screen), ref.id);
      node.concept = op.name;
      if (op.role !== undefined) node.role = op.role;
      const text = formatRef(ref);
      if (!concept.exemplars.includes(text)) concept.exemplars.push(text);
    }
  },
});
