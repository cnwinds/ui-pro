import { readFile } from 'node:fs/promises';
import {
  type AnalysisReport,
  type AnalyzeOptions,
  applyOps,
  COMPOSITE_EVIDENCE,
  ErrorCodes,
  type EvidenceFile,
  ioError,
  loadScreen,
  type Project,
  referenceImagePath,
  resolveInside,
  screenRelDir,
  toPosix,
  UiProError,
} from '@ui-pro/core';
import { buildDraft } from './draft';
import { PsdErrorCodes } from './errors';
import { buildEvidence } from './evidence';
import { encodePng } from './image';
import { type Inspection, inspectPsd } from './inspect';
import { fixListLines, type InputGrade } from './report';

async function readSource(project: Project, screen: string, file: string): Promise<Uint8Array> {
  const path = resolveInside(project.root, `${screenRelDir(screen)}/${file}`);
  try {
    return await readFile(path);
  } catch (cause) {
    throw ioError('读取 PSD 源文件', path, cause);
  }
}

function gradeError(screen: string, grade: InputGrade | null, inspection: Inspection): UiProError {
  const musts = inspection.issues.filter((issue) => issue.severity === 'must').length;
  return new UiProError(
    PsdErrorCodes.grade,
    `界面 ${screen} 的 PSD 输入等级是 ${grade ?? '待定'}，低于 A，不能直接分析（必须修改 ${musts} 项）`,
    {
      hint: '按 details.fixList 修改 PSD 后重新添加源文件；或加 --allow-degraded 降级处理，不合规的图层会按整图像素处理',
      details: {
        grade,
        fixList: fixListLines(inspection.issues),
        issues: inspection.issues,
      },
    },
  );
}

/**
 * Analyzes a screen whose source is a PSD or a delivery package: grades the input, extracts the
 * composite as the reference image, turns layers into candidates and named groups into the draft,
 * and commits evidence plus draft as one version.
 */
export async function analyzePsdScreen(
  project: Project,
  screen: string,
  options: AnalyzeOptions = {},
): Promise<AnalysisReport> {
  const { allowDegraded = false, dryRun = false } = options;
  const doc = loadScreen(project, screen);
  const { source } = doc;
  if (source.kind !== 'psd') {
    throw new UiProError(PsdErrorCodes.source, `界面 ${screen} 的源文件不是 PSD`, {
      hint: '图片源文件走 ui-pro analyze 的图片分析流程',
    });
  }
  if (!source.file.toLowerCase().endsWith('.psd')) {
    throw new UiProError(ErrorCodes.notImplemented, `交付包的分析尚未实现（界面 ${screen}）`, {
      hint: '请改交 PSD 源文件：交付包需要 Photoshop 交付助手导出，目前只支持 PSD',
    });
  }

  const bytes = await readSource(project, screen, source.file);
  const inspection = await inspectPsd(bytes, {
    project,
    scratchRoot: project.root,
    render: true,
    onRendererUnavailable: allowDegraded ? 'fallback' : 'throw',
    cacheWrite: !dryRun,
    stopOnMust: !allowDegraded,
  });
  const { document, rendered, reference } = inspection;
  if (document.sha256 !== source.sha256) {
    throw new UiProError(PsdErrorCodes.source, `界面 ${screen} 的 PSD 与记录的哈希不一致`, {
      hint: '源文件在添加之后被改动过，请重新添加源文件',
    });
  }
  if (inspection.grade !== 'A' && !allowDegraded)
    throw gradeError(screen, inspection.grade, inspection);
  if (rendered === undefined || reference === null) {
    throw new UiProError(PsdErrorCodes.renderFailed, `界面 ${screen} 的图层没有渲染成功`);
  }
  // Without a check against the composite the input cannot be called better than B.
  const grade: InputGrade = inspection.grade ?? 'B';

  const ignored = new Set(rendered.units.filter((unit) => unit.ignored).map((unit) => unit.id));
  const failed = new Set(
    (rendered.verification?.checks ?? [])
      .filter((check) => !check.pass && !ignored.has(check.id))
      .map((check) => check.id),
  );
  const evidence = buildEvidence(document, rendered.stored, source.sha256);
  const draft = buildDraft({
    document,
    prefixes: inspection.prefixes,
    evidence,
    usedNodeIds: Object.keys(doc.nodes),
    scale: doc.scale,
    failed,
  });

  const warnings: string[] = [];
  const risks: string[] = [];
  if (doc.scale > 1) {
    risks.push(
      `PSD 画布宽 ${document.width}px，小于设计宽度，要放大 ${doc.scale.toFixed(2)} 倍，边缘会变软`,
    );
  }
  if (grade !== 'A') risks.push(`输入等级 ${grade}，按降级处理：有问题的图层按整图像素处理`);
  if (inspection.restoreSkipped !== undefined) risks.push(inspection.restoreSkipped);
  for (const issue of inspection.issues) {
    warnings.push(`PSD ${issue.layer === undefined ? '' : `${issue.layer}：`}${issue.message}`);
  }
  if (Object.keys(doc.nodes).length > 1) {
    warnings.push('界面里已经有节点，草稿的节点追加在它们之后');
  }
  warnings.push(...draft.warnings);

  const files: EvidenceFile[] = [
    { path: COMPOSITE_EVIDENCE, content: await encodePng(reference) },
    ...evidence.files,
  ];
  const result = await applyOps(project, draft.ops, {
    screen,
    dryRun,
    message: `分析 PSD：${screen}`,
    evidence: { [screen]: { candidates: evidence.doc, files } },
  });

  return {
    screen,
    kind: 'psd',
    grade,
    precheck: { upscale: doc.scale, risks },
    candidates: evidence.doc.candidates.length,
    clusters: evidence.doc.clusters.length,
    nodes: draft.nodes,
    ...(result.version === undefined ? {} : { version: result.version }),
    warnings: [...warnings, ...result.warnings],
    ask: [...draft.ask, ...result.ask],
    views: dryRun ? [] : [toPosix(resolveInside(project.root, referenceImagePath(doc)))],
  };
}
