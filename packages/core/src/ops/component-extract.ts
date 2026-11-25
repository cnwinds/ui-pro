import { z } from 'zod';
import { ComponentNameSchema } from '../schema/common';
import { requireNode } from '../screen/tree';
import { defineOp } from '../tx/registry';
import { assertNotRoot, invalidOp, selectOne, singleScreen } from './shared';

export const componentExtract = defineOp({
  name: 'component.extract',
  family: 'structure',
  summary: '把一组同形节点提取为组件：登记组件定义，并把这些节点标为它的实例',
  schema: z.strictObject({
    op: z.literal('component.extract'),
    name: ComponentNameSchema,
    /** Roots of the instances; all must be in one screen. */
    targets: z.string().min(1),
    /** The node that serves as the component's template; defaults to the first target. */
    master: z.string().min(1).optional(),
  }),
  apply(ctx, op) {
    const refs = ctx.select(op.targets, { min: 1 });
    const screen = singleScreen(refs, 'component.extract');
    const doc = ctx.screen(screen);
    for (const ref of refs) assertNotRoot(doc, ref.id, 'component.extract');

    let masterId = doc.components[op.name]?.master ?? refs[0]?.id;
    if (op.master !== undefined) {
      const master = selectOne(ctx, op.master);
      if (master.screen !== screen) {
        throw invalidOp(`master 必须和实例在同一个界面（${screen}），而它在 ${master.screen}`);
      }
      masterId = master.id;
    }
    if (masterId === undefined) throw invalidOp('component.extract 缺少 master');

    const existing = doc.components[op.name];
    doc.components[op.name] = existing
      ? { ...existing, master: masterId }
      : { name: op.name, master: masterId, props: {}, events: [] };
    for (const ref of refs) requireNode(doc, ref.id).instanceOf = op.name;
  },
});
