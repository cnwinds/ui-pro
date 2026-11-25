import { z } from 'zod';
import { detachChild, requireNode, subtreeIds } from '../screen/tree';
import { defineOp } from '../tx/registry';
import { assertNotRoot, dropExemplars, invalidOp } from './shared';

export const nodeRemove = defineOp({
  name: 'node.remove',
  family: 'structure',
  summary: '删除节点；子节点默认并入它的父节点（reparent），或一并删除（delete）',
  schema: z.strictObject({
    op: z.literal('node.remove'),
    target: z.string().min(1),
    children: z.enum(['reparent', 'delete']).default('reparent'),
  }),
  apply(ctx, op) {
    for (const ref of ctx.select(op.target, { min: 1 })) {
      const doc = ctx.screen(ref.screen);
      const node = doc.nodes[ref.id];
      if (!node) continue; // already removed together with an ancestor in this op
      assertNotRoot(doc, ref.id, 'node.remove');
      if (node.parent === null) throw invalidOp(`节点 #${ref.id} 没有父节点`);

      let removed: string[];
      if (op.children === 'delete') {
        removed = subtreeIds(doc, ref.id);
        detachChild(doc, ref.id);
      } else {
        const parent = requireNode(doc, node.parent);
        const index = detachChild(doc, ref.id);
        parent.children.splice(index, 0, ...node.children);
        for (const childId of node.children) requireNode(doc, childId).parent = parent.id;
        removed = [ref.id];
      }
      for (const id of removed) delete doc.nodes[id];
      dropExemplars(ctx, ref.screen, removed);
    }
  },
});
