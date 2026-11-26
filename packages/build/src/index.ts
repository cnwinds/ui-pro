import { ErrorCodes, type Project, type Registry, UiProError } from '@ui-pro/core';
import type { BuildOptions, BuildReport } from './types';

export type * from './types';

const notYet = (what: string) =>
  new UiProError(ErrorCodes.notImplemented, `${what}尚未实现（第 3 批工单 06）`);

/** Builds the screen's assets from its decisions (DESIGN §6.5) as one undoable version. */
export async function buildScreen(
  _project: Project,
  _screen: string,
  _options: BuildOptions = {},
): Promise<BuildReport> {
  throw notYet('资产构建');
}

/**
 * Hash of everything the build reads, excluding the node fields the build itself writes; the
 * manifest stores it, and a different current value means the assets are stale.
 */
export function buildInputsSha256(_project: Project, _screen: string): string {
  throw notYet('构建输入哈希');
}

/** Adds the build's ops (and hooks, if any) to a registry. Safe to call twice. */
export function registerBuild(_registry: Registry): void {}
