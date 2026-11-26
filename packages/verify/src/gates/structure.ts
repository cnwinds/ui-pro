import {
  ASSET_NAME_PATTERN,
  intersectRect,
  type Primitive,
  preOrder,
  type Rect,
  validateScreen,
} from '@ui-pro/core';
import { lookupPath } from '@ui-pro/renderer';
import type { GateContext } from '../context';
import type { GateProblem } from '../types';
import { type GateRun, gateResult, listNodes, round } from './types';

/** Design width the touch-size constant is stated for. */
export const TOUCH_REFERENCE_WIDTH = 1080;

/**
 * Smallest comfortable touch target on a screen 1080 design pixels wide: 88 px, which is the usual
 * 44 pt on a 2x display. A screen with another design width scales it in proportion.
 */
export const MIN_TOUCH_SIZE_AT_REFERENCE = 88;

/**
 * A child may lie outside its parent's rectangle by at most this share of its own area (badges and
 * glows overhang; a child mostly outside is misplaced or mis-parented).
 */
export const CHILD_OUTSIDE_MAX = 0.75;

/** Types whose children are expected to lie beyond their rectangle. */
const CLIPPING_PARENTS: ReadonlySet<Primitive> = new Set(['scroll', 'list', 'mask']);

/** Types a user taps or drags; the same set the rules engine treats as interactive. */
const INTERACTIVE: ReadonlySet<Primitive> = new Set([
  'button',
  'toggle',
  'toggle-group',
  'slider',
  'input',
  'scroll',
  'list',
]);

/** Types that draw nothing from the source, so a node with no asset gets a placeholder box. */
const PLACEHOLDER_TYPES: ReadonlySet<Primitive> = new Set(['surface', 'anim']);

const area = (rect: Rect): number => rect[2] * rect[3];

/**
 * 结构: static checks of the screen document against the asset manifest and mock data. Node ids
 * and asset names are well formed and unique; every reference resolves (assets, component
 * instances, bound paths); no child sits mostly outside its parent; no interactive node with a
 * visible-only hit area is smaller than the touch size.
 */
export async function runStructureGate(ctx: GateContext): Promise<GateRun> {
  const { doc, manifest } = ctx;
  const problems: GateProblem[] = [];
  const warnings: string[] = [];
  const add = (node: string | undefined, message: string, fix: string) =>
    problems.push({ ...(node !== undefined ? { node } : {}), message, fix });

  // Document structure: ids, parents, children, rectangles, components.
  for (const problem of validateScreen(doc)) {
    add(problem.node, problem.message, '修正界面规格里的这一处结构错误');
  }

  // Asset names.
  const assetNames = new Set<string>();
  for (const record of manifest.assets) {
    if (!ASSET_NAME_PATTERN.test(record.name)) {
      add(undefined, `资产名 ${record.name} 不合法`, '资产名只能用小写字母、数字、下划线和短横线');
    }
    if (assetNames.has(record.name)) {
      add(undefined, `资产名 ${record.name} 重复`, '重新运行 ui-pro build 让资产改用不同的名字');
    }
    assetNames.add(record.name);
    for (const use of record.uses) {
      const node = doc.nodes[use.node];
      if (!node) {
        add(
          undefined,
          `资产 ${record.name} 的用处里有不存在的节点 #${use.node}`,
          '节点被删掉或改名后要重新运行 ui-pro build',
        );
      } else if (use.state === undefined && node.asset !== record.name) {
        warnings.push(
          `资产 ${record.name} 的清单记着节点 #${use.node} 在用，但节点的 asset 是 ${node.asset ?? '空'}`,
        );
      }
    }
  }

  const mock = ctx.mock();
  const missingAsset: string[] = [];
  for (const id of preOrder(doc)) {
    const node = doc.nodes[id];
    if (!node) continue;

    // References resolve.
    if (node.asset !== undefined && !assetNames.has(node.asset)) {
      add(id, `节点 #${id} 的资产 ${node.asset} 不在资产清单里`, '重新运行 ui-pro build');
    }
    for (const [state, override] of Object.entries(node.states ?? {})) {
      if (override.asset !== undefined && !assetNames.has(override.asset)) {
        add(
          id,
          `节点 #${id} 状态 ${state} 的资产 ${override.asset} 不在资产清单里`,
          '重新运行 ui-pro build',
        );
      }
    }
    for (const [key, binding] of Object.entries(node.bind ?? {})) {
      if (lookupPath(mock, binding.path) === undefined) {
        add(
          id,
          `节点 #${id} 的绑定 ${key} 指向 ${binding.path}，mock.json 里没有这个值`,
          `在 mock.json 里补上 ${binding.path}，或改绑定的路径`,
        );
      }
    }

    // A node that draws an asset has one.
    if (
      node.asset === undefined &&
      ctx.ownership.get(id)?.kind === 'asset' &&
      ctx.shown(id) &&
      !PLACEHOLDER_TYPES.has(node.type)
    ) {
      missingAsset.push(id);
    }

    // The child stays within the parent.
    const parent = node.parent === null ? undefined : doc.nodes[node.parent];
    if (parent && ctx.shown(id) && !CLIPPING_PARENTS.has(parent.type)) {
      const inside = intersectRect(parent.rect, node.rect);
      const outside = 1 - (inside ? area(inside) : 0) / area(node.rect);
      if (outside > CHILD_OUTSIDE_MAX) {
        add(
          id,
          `节点 #${id} 有 ${round(outside * 100, 0)}% 的面积在父节点 #${parent.id} 之外（超过 ${CHILD_OUTSIDE_MAX * 100}%）`,
          `检查 #${id} 的矩形，或把它挂到正确的父节点下`,
        );
      }
    }

    // Hit area.
    if (INTERACTIVE.has(node.type) && ctx.shown(id)) {
      const minimum = (MIN_TOUCH_SIZE_AT_REFERENCE * doc.size[0]) / TOUCH_REFERENCE_WIDTH;
      const shortSide = Math.min(node.rect[2], node.rect[3]);
      if (node.decisions['hit.area']?.value !== 'padded' && shortSide < minimum) {
        add(
          id,
          `节点 #${id} 的点击热区只有可见区域那么大，短边 ${round(shortSide, 0)}，小于最小触控尺寸 ${round(minimum, 0)}`,
          `把 #${id} 的 hit.area 改成 padded（用 exception.add 或规则），让热区比图形大`,
        );
      }
    }
  }
  if (missingAsset.length > 0) {
    add(
      missingAsset[0],
      `${missingAsset.length} 个节点还没有资产：${listNodes(missingAsset)}`,
      '运行 ui-pro build 生成资产',
    );
  }

  return {
    result: gateResult('structure', {
      metrics: {
        nodes: Object.keys(doc.nodes).length,
        assets: manifest.assets.length,
        problems: problems.length,
      },
      problems,
      warnings,
    }),
  };
}
