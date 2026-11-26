import type { Registry } from '@ui-pro/core';
import { registerBuildOps } from './assign-op';

export type { BuildDeps } from './build';
export { buildScreen } from './build';
export { BuildErrorCodes } from './errors';
export { buildInputsSha256 } from './hash';
export type * from './types';

/** Adds the build's ops (and hooks, if any) to a registry. Safe to call twice. */
export function registerBuild(registry: Registry): void {
  registerBuildOps(registry);
}
