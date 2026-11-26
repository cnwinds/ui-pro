import { registerBuild } from '@ui-pro/build';
import { defaultRegistry } from '@ui-pro/core';
import { registerRules } from '@ui-pro/rules';

let registered = false;

/**
 * Registers what other packages contribute to the kernel (ops, hooks, document kinds) into the
 * default registry. Idempotent, because tests build many programs in one process.
 */
export function registerPlugins(): void {
  if (registered) return;
  registered = true;
  registerRules(defaultRegistry);
  registerBuild(defaultRegistry);
}
