import {
  type AnalysisReport,
  type AnalyzeOptions,
  ErrorCodes,
  type Project,
  UiProError,
} from '@ui-pro/core';

/**
 * Analyzes a screen whose source is a PSD or a delivery package: grades the input, extracts the
 * composite as the reference image, turns layers into candidates and named groups into the draft,
 * and commits evidence plus draft as one version.
 */
export async function analyzePsdScreen(
  _project: Project,
  screen: string,
  _options: AnalyzeOptions = {},
): Promise<AnalysisReport> {
  throw new UiProError(ErrorCodes.notImplemented, `PSD 分析尚未实现（界面 ${screen}）`);
}
