import { ErrorCodes, type Project, UiProError } from '@ui-pro/core';
import type { VerifyOptions, VerifyReport, VerifyStamp } from './types';

export * from './types';

const notYet = (what: string) =>
  new UiProError(ErrorCodes.notImplemented, `${what}尚未实现（第 3 批工单 08）`);

/** Runs the quality gates of DESIGN §13.1 on a built screen and stamps the result. */
export async function verifyScreen(
  _project: Project,
  _screen: string,
  _options: VerifyOptions = {},
): Promise<VerifyReport> {
  throw notYet('质量门禁');
}

/**
 * Hash of everything a verify result depends on: the screen document, its asset manifest, the
 * rule documents, the glossary and the project config. A different value means stale.
 */
export function verifyInputsSha256(_project: Project, _screen: string): string {
  throw notYet('门禁输入哈希');
}

/** The last verify result of the screen, or `null` when it was never verified. */
export function readVerifyStamp(_project: Project, _screen: string): VerifyStamp | null {
  throw notYet('门禁记录');
}

/** Throws `E_NOT_VERIFIED` unless the last verify passed and nothing changed since. */
export function assertVerified(_project: Project, _screen: string): void {
  throw notYet('导出前的门禁检查');
}
