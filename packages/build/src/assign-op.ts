import {
  AssetNameSchema,
  ColorSchema,
  defineOp,
  editNodes,
  invalidOp,
  NineSliceSchema,
  type Registry,
  StateNameSchema,
  TextSpecSchema,
  type TxContext,
  type UINode,
} from '@ui-pro/core';
import { z } from 'zod';

const StateAssetSchema = z.strictObject({
  state: StateNameSchema,
  /** `null` removes the state's asset. */
  asset: AssetNameSchema.nullable(),
});

const AssignSchema = z
  .strictObject({
    op: z.literal('asset.assign'),
    /** Selector of the nodes to bind. */
    target: z.string().min(1),
    /** `null` clears the node's asset. */
    asset: AssetNameSchema.nullable().optional(),
    tint: ColorSchema.nullable().optional(),
    nineSlice: NineSliceSchema.nullable().optional(),
    states: StateAssetSchema.array().optional(),
    /** Text appearance measured from the glyphs; applied only where the node has nothing yet. */
    text: TextSpecSchema.pick({ size: true, color: true, stroke: true, shadow: true }).optional(),
  })
  .refine(
    (op) =>
      op.asset !== undefined ||
      op.tint !== undefined ||
      op.nineSlice !== undefined ||
      op.states !== undefined ||
      op.text !== undefined,
    '至少要给出 asset、tint、nineSlice、states、text 之一',
  );
type Assign = z.infer<typeof AssignSchema>;

function manifestAsset(ctx: TxContext, screen: string, name: string) {
  const manifest = ctx.assets(screen);
  if (manifest === null) {
    throw invalidOp(
      `界面 ${screen} 还没有资产清单，不能绑定资产 ${name}`,
      '资产由 ui-pro build 构建并绑定；这个操作只在构建里使用',
    );
  }
  const record = manifest.assets.find((asset) => asset.name === name);
  if (!record) {
    throw invalidOp(
      `界面 ${screen} 的资产清单里没有资产 ${name}`,
      `现有资产：${manifest.assets.map((asset) => asset.name).join('、') || '（无）'}`,
    );
  }
  return record;
}

function sameMargins(a: readonly number[], b: readonly number[]): boolean {
  return (
    a.length === b.length &&
    a.every((value, index) => Math.abs(value - (b[index] ?? Number.NaN)) < 1e-6)
  );
}

function applyStates(
  ctx: TxContext,
  node: UINode,
  screen: string,
  states: NonNullable<Assign['states']>,
): void {
  for (const { state, asset } of states) {
    const current = node.states?.[state];
    if (asset === null) {
      if (current === undefined) continue;
      const { asset: _removed, ...rest } = current;
      node.states = { ...node.states, [state]: rest };
      continue;
    }
    if (current === undefined) {
      throw invalidOp(`节点 #${node.id} 没有声明状态 ${state}，不能给它绑定资产`);
    }
    manifestAsset(ctx, screen, asset);
    node.states = { ...node.states, [state]: { ...current, asset } };
  }
}

function applyText(node: UINode, measured: NonNullable<Assign['text']>): void {
  if (node.text === undefined) {
    throw invalidOp(`节点 #${node.id} 没有 text，不能写入量出的文字样式`);
  }
  const text = { ...node.text };
  if (text.size === undefined && measured.size !== undefined) text.size = measured.size;
  if (text.color === undefined && measured.color !== undefined) text.color = measured.color;
  if (text.stroke === undefined && measured.stroke !== undefined) text.stroke = measured.stroke;
  if (text.shadow === undefined && measured.shadow !== undefined) text.shadow = measured.shadow;
  node.text = text;
}

export const assetAssign = defineOp({
  name: 'asset.assign',
  family: 'build',
  summary:
    '由构建使用，Agent 不需要直接调用：把构建出的资产绑定到节点（asset、tint、nineSlice、状态的资产名），并把量出的文字样式填进 text 里还空着的字段',
  schema: AssignSchema,
  apply(ctx, op) {
    editNodes(ctx, op.target, (node, ref) => {
      if (op.asset === null) {
        node.asset = undefined;
      } else if (op.asset !== undefined) {
        const record = manifestAsset(ctx, ref.screen, op.asset);
        if (op.nineSlice !== undefined && op.nineSlice !== null) {
          if (record.nineSlice === undefined || !sameMargins(record.nineSlice, op.nineSlice)) {
            throw invalidOp(
              `节点 #${node.id} 的 nineSlice 必须与资产 ${op.asset} 记录的九宫边距相等`,
              `资产记录的是 ${record.nineSlice ? `[${record.nineSlice.join(', ')}]` : '没有九宫'}`,
            );
          }
        }
        node.asset = op.asset;
      }
      if (op.tint !== undefined) node.tint = op.tint ?? undefined;
      if (op.nineSlice !== undefined) node.nineSlice = op.nineSlice ?? undefined;
      if (op.states !== undefined) applyStates(ctx, node, ref.screen, op.states);
      if (op.text !== undefined) applyText(node, op.text);
    });
  },
});

/** Adds the build's op to `registry`. Safe to call twice. */
export function registerBuildOps(registry: Registry): void {
  registry.registerOp(assetAssign);
}
