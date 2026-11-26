import { defineOp } from '@ui-pro/core';
import { z } from 'zod';

/** Changes nothing itself: the `beforeCommit` hook that follows every op does the work. */
export const ruleRecomputeOp = defineOp({
  name: 'rule.recompute',
  family: 'rules',
  summary: '按现行规则重算全部节点的决定；手工改过规则文件后用它刷新',
  schema: z.strictObject({ op: z.literal('rule.recompute') }),
  apply() {},
});
