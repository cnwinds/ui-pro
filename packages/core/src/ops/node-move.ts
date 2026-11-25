import { z } from 'zod';
import { attachChild, detachChild, isInSubtree, requireNode } from '../screen/tree';
import { defineOp } from '../tx/registry';
import { assertNotRoot, invalidOp, selectOne } from './shared';

export const nodeMove = defineOp({
  name: 'node.move',
  family: 'structure',
  summary: '把节点移到另一个父节点之下；矩形保持不变（坐标是绝对的）',
  schema: z.strictObject({
    op: z.literal('node.move'),
    target: z.string().min(1),
    parent: z.string().min(1),
    /** Position among the new parent's children, counted after the moved nodes are lifted out. */
    index: z.number().int().nonnegative().optional(),
  }),
  apply(ctx, op) {
    const parentRef = selectOne(ctx, op.parent);
    const targets = ctx.select(op.target, { min: 1 });
    const doc = ctx.screen(parentRef.screen);

    for (const ref of targets) {
      if (ref.screen !== parentRef.screen) {
        throw invalidOp(`不能把 ${ref.screen}/#${ref.id} 移到另一个界面 ${parentRef.screen}`);
      }
      assertNotRoot(doc, ref.id, 'node.move');
      if (isInSubtree(doc, ref.id, parentRef.id)) {
        throw invalidOp(`不能把 #${ref.id} 移入它自己或它的子孙 #${parentRef.id}`);
      }
    }

    let index = op.index;
    for (const ref of targets) {
      detachChild(doc, ref.id);
      const parent = requireNode(doc, parentRef.id);
      if (index !== undefined && index > parent.children.length) {
        throw invalidOp(`index ${index} 超出 #${parent.id} 的子节点数 ${parent.children.length}`);
      }
      attachChild(doc, parentRef.id, ref.id, index);
      if (index !== undefined) index += 1;
    }
  },
});
