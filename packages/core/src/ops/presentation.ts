import { z } from 'zod';
import { FreeKeySchema, PairSchema, StateNameSchema } from '../schema/common';
import { AnchorSchema, StateOverrideSchema } from '../schema/screen';
import { defineOp } from '../tx/registry';
import { editNodes, invalidOp } from './shared';

export const layoutSet = defineOp({
  name: 'layout.set',
  family: 'presentation',
  summary: '设置锚点和轴心，并把它们钉住（pins.anchor / pins.pivot）',
  schema: z
    .strictObject({
      op: z.literal('layout.set'),
      target: z.string().min(1),
      anchor: AnchorSchema.optional(),
      pivot: PairSchema.optional(),
    })
    .refine((op) => op.anchor !== undefined || op.pivot !== undefined, '需要 anchor 或 pivot'),
  apply(ctx, op) {
    editNodes(ctx, op.target, (node) => {
      if (op.anchor !== undefined) {
        node.anchor = op.anchor;
        node.pins.anchor = op.anchor;
      }
      if (op.pivot !== undefined) {
        node.pivot = op.pivot;
        node.pins.pivot = op.pivot;
      }
    });
  },
});

export const stateSet = defineOp({
  name: 'state.set',
  family: 'presentation',
  summary: '设置节点的具名状态覆盖（整体替换）；set 为 null 时删除该状态',
  schema: z.strictObject({
    op: z.literal('state.set'),
    target: z.string().min(1),
    state: StateNameSchema,
    set: StateOverrideSchema.nullable(),
  }),
  apply(ctx, op) {
    editNodes(ctx, op.target, (node) => {
      const states = { ...node.states };
      if (op.set === null) delete states[op.state];
      else states[op.state] = op.set;
      node.states = Object.keys(states).length > 0 ? states : undefined;
    });
  },
});

export const bindSet = defineOp({
  name: 'bind.set',
  family: 'presentation',
  summary: '把节点属性绑定到数据路径（可带格式化）；path 为 null 时解除绑定',
  schema: z.strictObject({
    op: z.literal('bind.set'),
    target: z.string().min(1),
    prop: FreeKeySchema,
    path: z.string().min(1).nullable(),
    format: z.string().min(1).optional(),
  }),
  apply(ctx, op) {
    if (op.path === null && op.format !== undefined) {
      throw invalidOp('解除绑定（path 为 null）时不能同时给 format');
    }
    editNodes(ctx, op.target, (node) => {
      const bind = { ...node.bind };
      if (op.path === null) delete bind[op.prop];
      else
        bind[op.prop] =
          op.format === undefined ? { path: op.path } : { path: op.path, format: op.format };
      node.bind = Object.keys(bind).length > 0 ? bind : undefined;
    });
  },
});
