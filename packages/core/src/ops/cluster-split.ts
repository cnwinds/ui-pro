import { z } from 'zod';
import type { ScreenDoc } from '../schema/screen';
import { requireNode } from '../screen/tree';
import { defineOp } from '../tx/registry';
import { invalidOp, singleScreen } from './shared';

/** First `<cluster>~<n>` no node of the screen uses. */
function freeSubCluster(doc: ScreenDoc, cluster: string): string {
  const used = new Set(Object.values(doc.nodes).map((node) => node.cluster));
  let n = 1;
  while (used.has(`${cluster}~${n}`)) n += 1;
  return `${cluster}~${n}`;
}

export const clusterSplit = defineOp({
  name: 'cluster.split',
  family: 'structure',
  summary:
    '把节点移出它们所在的相似簇，并记下理由（同形同判认可带理由的拆簇）；into 为 new 时它们组成一个新簇，为 none 时各自离开',
  schema: z.strictObject({
    op: z.literal('cluster.split'),
    target: z.string().min(1),
    because: z.string().trim().min(1, 'because 不能为空：拆簇必须写明理由'),
    into: z.enum(['new', 'none']).default('new'),
  }),
  apply(ctx, op) {
    const refs = ctx.select(op.target, { min: 1 });
    const screen = singleScreen(refs, 'cluster.split');
    const doc = ctx.screen(screen);
    const nodes = refs.map((ref) => requireNode(doc, ref.id));
    const clusters = new Set(nodes.map((node) => node.cluster));
    const [from] = clusters;
    if (from === undefined) {
      const loose = nodes.filter((node) => node.cluster === undefined).map((node) => `#${node.id}`);
      throw invalidOp(`这些节点不属于任何相似簇：${loose.join('、')}`);
    }
    if (clusters.size > 1) {
      throw invalidOp(
        `要拆出的节点必须来自同一个相似簇（现为 ${[...clusters].map(String).join('、')}）`,
        '按簇分成几个 cluster.split 操作',
      );
    }
    const members = Object.values(doc.nodes).filter((node) => node.cluster === from);
    const alone = op.into === 'none' || nodes.length === 1;
    if (!alone && nodes.length === members.length) {
      throw invalidOp(
        `目标包含相似簇 ${from} 的全部 ${members.length} 个成员，组成新簇等于没拆`,
        '要解散这个簇，用 "into": "none"',
      );
    }
    const target = alone ? undefined : freeSubCluster(doc, from);
    for (const node of nodes) {
      node.cluster = target;
      node.clusterSplit = { from, because: op.because };
    }
  },
});
