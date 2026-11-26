import type { Registry } from '@ui-pro/core';
import { projectRulesKind, screenRulesKind } from './docs';
import { followRename, recomputeDecisions } from './hooks';
import { ruleOps } from './ops';

/** Adds the rule document kinds, the `rules` ops and the decision hooks. Safe to call twice. */
export function registerRules(registry: Registry): void {
  registry.registerDocKind(projectRulesKind);
  registry.registerDocKind(screenRulesKind);
  for (const op of ruleOps) registry.registerOp(op);
  registry.registerHook('beforeCommit', recomputeDecisions);
  registry.registerHook('rename', followRename);
}
