import type { OpDefinition } from '@ui-pro/core';
import { exceptionAddOp, exceptionRemoveOp } from './exception';
import { ruleAdoptOp } from './rule-adopt';
import { ruleDisableOp, ruleEnableOp } from './rule-disable';
import { ruleProposeOp } from './rule-propose';
import { ruleRecomputeOp } from './rule-recompute';
import { ruleRemoveOp } from './rule-remove';

/** Ops of the `rules` family, in the order `ui-pro schema` lists them. */
export const ruleOps: readonly OpDefinition[] = [
  ruleProposeOp,
  ruleAdoptOp,
  ruleDisableOp,
  ruleEnableOp,
  ruleRemoveOp,
  exceptionAddOp,
  exceptionRemoveOp,
  ruleRecomputeOp,
];
