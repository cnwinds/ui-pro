import {
  type AnalysisReport,
  type AnalyzeOptions,
  applyOps,
  loadScreen,
  type Project,
  referenceImagePath,
  resolveInside,
  UiProError,
} from '@ui-pro/core';
import { buildCandidates } from './candidates';
import { buildDraft } from './draft';
import { PerceptionErrorCodes } from './errors';
import { decodeImage } from './image';
import { edgeStrength } from './ink';
import { lookOverview } from './look';
import { createOcrEngine } from './ocr';
import { precheck } from './precheck';
import { detectStableRegions } from './regions';
import { recognizeText } from './text';

/**
 * Analyzes a screen whose source is a flat image: precheck, candidates from shape detection and
 * text recognition with their visual clusters, then a heuristic draft. Evidence and draft are
 * committed as one version, so `history undo` takes both back. A dry run computes the same
 * report and writes nothing.
 */
export async function analyzeFlatScreen(
  project: Project,
  screen: string,
  options: AnalyzeOptions = {},
): Promise<AnalysisReport> {
  const { dryRun = false } = options;
  const doc = loadScreen(project, screen);
  if (doc.source.kind !== 'flat') {
    throw new UiProError(PerceptionErrorCodes.sourceKind, `界面 ${screen} 的源文件不是拍平图`, {
      hint: 'PSD 源文件走 PSD 分析流程，ui-pro analyze 会按源文件类型自动选择',
    });
  }
  const image = await decodeImage(resolveInside(project.root, referenceImagePath(doc)));
  const edges = { strength: edgeStrength(image), width: image.width, height: image.height };

  const shapes = await detectStableRegions(image);
  const texts = await recognizeText(image, createOcrEngine());
  const evidence = buildCandidates({ shapes, texts, edges, sourceSha256: doc.source.sha256 });
  const draft = buildDraft(evidence, Object.keys(doc.nodes));
  const checked = precheck(doc, evidence, image);

  const result = await applyOps(project, draft.ops, {
    screen,
    dryRun,
    message: `分析拍平图：${screen}`,
    evidence: { [screen]: { candidates: evidence } },
  });

  const warnings = [...result.warnings];
  if (texts.length === 0)
    warnings.push('没有识别到任何文字；如果界面上有文字，请检查源文件是否过小或过糊');
  const views: string[] = [];
  if (!dryRun) {
    try {
      views.push(...(await lookOverview(project, screen)).images.map((view) => view.path));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`分析已提交，但概览图没有生成：${reason}；可以稍后运行 ui-pro look`);
    }
  }

  return {
    screen,
    kind: 'flat',
    precheck: { upscale: checked.upscale, risks: checked.risks },
    candidates: evidence.candidates.length,
    clusters: evidence.clusters.length,
    nodes: draft.nodes.size,
    ...(result.version === undefined ? {} : { version: result.version }),
    warnings,
    ask: [...checked.ask, ...result.ask],
    views,
  };
}
