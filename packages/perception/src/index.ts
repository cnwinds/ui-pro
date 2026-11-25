import {
  type AnalysisReport,
  type AnalyzeOptions,
  ErrorCodes,
  type Project,
  UiProError,
} from '@ui-pro/core';

/**
 * Analyzes a screen whose source is a flat image: precheck, candidates from detection, text
 * recognition and self-similarity clusters, then a heuristic draft, committed as one version.
 */
export async function analyzeFlatScreen(
  _project: Project,
  screen: string,
  _options: AnalyzeOptions = {},
): Promise<AnalysisReport> {
  throw new UiProError(ErrorCodes.notImplemented, `拍平图分析尚未实现（界面 ${screen}）`);
}
