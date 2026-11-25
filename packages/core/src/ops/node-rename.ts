import { z } from 'zod';
import { ErrorCodes, UiProError } from '../errors';
import { NodeIdSchema } from '../schema/common';
import { requireNode } from '../screen/tree';
import { formatRef } from '../selector/ref';
import { defineOp } from '../tx/registry';
import { selectOne } from './shared';

export const nodeRename = defineOp({
  name: 'node.rename',
  family: 'structure',
  summary: '修改节点 id，并同步更新父子关系、组件 master、概念库样例以及其他文档里的引用',
  schema: z.strictObject({
    op: z.literal('node.rename'),
    target: z.string().min(1),
    id: NodeIdSchema,
  }),
  apply(ctx, op) {
    const ref = selectOne(ctx, op.target);
    const from = ref.id;
    const to = op.id;
    if (from === to) return;

    const doc = ctx.screen(ref.screen);
    const node = requireNode(doc, from);
    if (to in doc.nodes) {
      throw new UiProError(ErrorCodes.nodeExists, `界面 ${doc.name} 已有节点 #${to}`);
    }

    delete doc.nodes[from];
    node.id = to;
    doc.nodes[to] = node;
    if (doc.root === from) doc.root = to;
    if (node.parent !== null) {
      const siblings = requireNode(doc, node.parent).children;
      siblings[siblings.indexOf(from)] = to;
    }
    for (const childId of node.children) requireNode(doc, childId).parent = to;
    for (const component of Object.values(doc.components)) {
      if (component.master === from) component.master = to;
    }

    const oldRef = formatRef(ref);
    const newRef = formatRef({ screen: ref.screen, id: to });
    for (const concept of ctx.glossary().concepts) {
      concept.exemplars = concept.exemplars.map((exemplar) =>
        exemplar === oldRef ? newRef : exemplar,
      );
    }
    ctx.runRenameHooks({ screen: ref.screen, from, to });
  },
});
