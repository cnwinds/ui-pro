import { z } from 'zod';
import { formatIssues } from '../schema/codec';
import { FreeKeySchema, PairSchema, PositiveRectSchema } from '../schema/common';
import { AnchorSchema, NineSliceSchema } from '../schema/screen';
import { defineOp } from '../tx/registry';
import { editNodes, invalidOp } from './shared';

/** Pin keys whose value shape is known; any other key holds free-form data. */
const PIN_VALUE_SCHEMAS: ReadonlyMap<string, z.ZodType> = new Map<string, z.ZodType>([
  ['rect', PositiveRectSchema],
  ['nineSlice', NineSliceSchema],
  ['anchor', AnchorSchema],
  ['pivot', PairSchema],
]);

export const pinSet = defineOp({
  name: 'pin.set',
  family: 'measure',
  summary: '钉住一个测量值（如 rect、nineSlice），之后的构建不再重新测量它',
  schema: z.strictObject({
    op: z.literal('pin.set'),
    target: z.string().min(1),
    key: FreeKeySchema,
    value: z.unknown(),
  }),
  apply(ctx, op) {
    const schema = PIN_VALUE_SCHEMAS.get(op.key);
    let value: unknown = op.value;
    if (schema) {
      const parsed = schema.safeParse(op.value);
      if (!parsed.success) {
        throw invalidOp(`pin ${op.key} 的值不合法：${formatIssues(parsed.error).join('；')}`);
      }
      value = parsed.data;
    }
    editNodes(ctx, op.target, (node) => {
      node.pins[op.key] = value;
    });
  },
});

export const pinClear = defineOp({
  name: 'pin.clear',
  family: 'measure',
  summary: '取消钉住的测量值；省略 key 时取消该节点的全部钉住项',
  schema: z.strictObject({
    op: z.literal('pin.clear'),
    target: z.string().min(1),
    key: FreeKeySchema.optional(),
  }),
  apply(ctx, op) {
    editNodes(ctx, op.target, (node) => {
      if (op.key === undefined) node.pins = {};
      else delete node.pins[op.key];
    });
  },
});
