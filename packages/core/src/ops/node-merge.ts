import { z } from 'zod';
import { ErrorCodes, UiProError } from '../errors';
import { ConceptNameSchema, NodeIdSchema, PrimitiveSchema, RoleSchema } from '../schema/common';
import { ancestorsOf, detachChild, newNode, requireNode, unionRect } from '../screen/tree';
import { defineOp } from '../tx/registry';
import { assertNotRoot, dropExemplars, invalidOp, singleScreen } from './shared';

export const nodeMerge = defineOp({
  name: 'node.merge',
  family: 'structure',
  summary: '把多个节点合并为一个，取代它们中第一个的位置；矩形与证据取并集',
  schema: z.strictObject({
    op: z.literal('node.merge'),
    targets: z.string().min(1),
    /** Unset fields are inherited from the first target; the id defaults to the first target's. */
    as: z
      .strictObject({
        id: NodeIdSchema.optional(),
        type: PrimitiveSchema.optional(),
        role: RoleSchema.optional(),
        concept: ConceptNameSchema.optional(),
        label: z.string().min(1).optional(),
      })
      .default({}),
  }),
  apply(ctx, op) {
    const refs = ctx.select(op.targets, { min: 2 });
    const screen = singleScreen(refs, 'node.merge');
    const doc = ctx.screen(screen);
    const ids = refs.map((ref) => ref.id);
    for (const id of ids) {
      assertNotRoot(doc, id, 'node.merge');
      const nestedIn = ancestorsOf(doc, id).find((ancestor) => ids.includes(ancestor));
      if (nestedIn !== undefined) {
        throw invalidOp(`node.merge 的目标不能互为祖先：#${id} 在 #${nestedIn} 之内`);
      }
    }

    const targets = ids.map((id) => requireNode(doc, id));
    const [first] = targets;
    if (!first?.parent) throw invalidOp('node.merge 缺少可合并的目标');
    const mergedId = op.as.id ?? first.id;
    if (mergedId in doc.nodes && !ids.includes(mergedId)) {
      throw new UiProError(ErrorCodes.nodeExists, `界面 ${doc.name} 已有节点 #${mergedId}`);
    }

    const parent = requireNode(doc, first.parent);
    const position = parent.children.indexOf(first.id);
    const children = targets.flatMap((target) => target.children);
    const evidence = [...new Set(targets.flatMap((target) => target.evidence))];
    const merged = newNode({
      id: mergedId,
      type: op.as.type ?? first.type,
      parent: parent.id,
      rect: unionRect(targets.map((target) => target.rect)),
      role: op.as.role ?? first.role,
      concept: op.as.concept ?? first.concept,
      label: op.as.label ?? first.label,
      visible: first.visible,
      varies: [...first.varies],
      evidence,
      children,
    });

    for (const target of targets) {
      for (const childId of target.children) requireNode(doc, childId).parent = mergedId;
      detachChild(doc, target.id);
      delete doc.nodes[target.id];
    }
    doc.nodes[mergedId] = merged;
    parent.children.splice(position, 0, mergedId);
    dropExemplars(
      ctx,
      screen,
      ids.filter((id) => id !== mergedId),
    );
  },
});
