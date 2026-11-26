import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ART_SUFFIX,
  type ExportReport,
  exportProjectScreen,
  GodotErrorCodes,
} from '@ui-pro/adapter-godot';
import {
  formatJson,
  loadScreen,
  PROJECT_FILES,
  type Project,
  readFileIfExistsSync,
  referenceImagePath,
  resolveInside,
  scratchPath,
  toPosix,
  UiProError,
  writeFileAtomic,
} from '@ui-pro/core';
import { readRuleInputs } from '@ui-pro/rules';
import { assertVerified, type GateResult, type VerifyReport } from '@ui-pro/verify';
import type { CommandResult } from '../result';
import type { CommandModule } from './types';

interface ExportGodotOptions {
  to?: string;
  shot?: boolean;
}

/** One gate as the export report records it. */
export interface ReportGate {
  id: string;
  name: string;
  status: GateResult['status'];
  reason?: string;
  metrics: Record<string, number>;
}

export interface NodeExceptionEntry {
  node: string;
  point: string;
  value: string;
  because: string;
}

/**
 * `export/<screen>.godot.json`: the adapter's report plus what the project knows about the
 * delivery (DESIGN §13): the gate results, the exceptions the rules document grants, and how many
 * cloud image-model calls the screen made.
 */
export interface DeliveryReport extends ExportReport {
  verification: { ok: boolean; gates: ReportGate[] } | null;
  nodeExceptions: NodeExceptionEntry[];
  cloudImageCalls: number;
}

function resolveTarget(project: Project, cwd: string, option: string | undefined): string {
  const to = option?.trim();
  if (to) return resolve(cwd, to);
  const configured = project.config.export.godot?.project;
  if (configured) return resolve(project.root, configured);
  throw new UiProError(GodotErrorCodes.noTarget, '没有指定要导出到的 Godot 工程目录', {
    hint: '用 --to <目录> 指定，或在 ui-pro.yaml 的 export.godot.project 里设置',
  });
}

/** The gate results of the last verify run, from its report file; `null` when it has none. */
function readGateRecord(project: Project, screen: string): DeliveryReport['verification'] {
  const bytes = readFileIfExistsSync(scratchPath(project.root, 'verify', screen, 'report.json'));
  if (bytes === null) return null;
  try {
    const report = JSON.parse(Buffer.from(bytes).toString('utf8')) as Partial<VerifyReport>;
    if (!Array.isArray(report.gates)) return null;
    return {
      ok: report.ok === true,
      gates: report.gates.map((gate) => ({
        id: gate.id,
        name: gate.name,
        status: gate.status,
        ...(gate.reason === undefined ? {} : { reason: gate.reason }),
        metrics: gate.metrics ?? {},
      })),
    };
  } catch {
    return null;
  }
}

/** The node exceptions of the screen's rules document, each with its reason. */
function readNodeExceptions(project: Project, screen: string): NodeExceptionEntry[] {
  const rules = readRuleInputs(project).screens.get(screen)?.rules;
  return (rules?.exceptions ?? []).map(({ node, point, value, because }) => ({
    node,
    point,
    value,
    because,
  }));
}

/** Calls of the cloud image model recorded for this screen in `history/egress.jsonl`. */
function countCloudImageCalls(project: Project, screen: string): number {
  let text: string;
  try {
    text = readFileSync(resolveInside(project.root, PROJECT_FILES.egress), 'utf8');
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const record: unknown = JSON.parse(line);
      if (typeof record === 'object' && record !== null && 'screen' in record) {
        if (record.screen === screen) count++;
      }
    } catch {
      // A damaged line proves no call; skip it.
    }
  }
  return count;
}

/** A short list of ids for a warning line: the first few, then how many more. */
function brief(ids: string[], limit = 5): string {
  const shown = ids.slice(0, limit).map((id) => `#${id}`);
  const more = ids.length > limit ? `等 ${ids.length} 个` : '';
  return `${shown.join('、')}${more}`;
}

function warningsOf(report: DeliveryReport, reportPath: string): string[] {
  const warnings: string[] = [];
  if (report.placeholders.length > 0) {
    warnings.push(
      `${report.placeholders.length} 个节点的基元类型还没有对应的 Godot 控件，已导出为占位 Control：${brief(report.placeholders.map((item) => item.id))}`,
    );
  }
  if (report.missingAssets.length > 0) {
    warnings.push(
      `${report.missingAssets.length} 个节点该画资产但没有可用的资产，导出的节点是空的：${brief(report.missingAssets.map((item) => item.id))}`,
    );
  }
  if (report.approximations.length > 0) {
    const nodes = new Set(report.approximations.flatMap((item) => item.nodes));
    warnings.push(
      `${report.approximations.length} 处近似项，涉及 ${nodes.size} 个节点，明细见 ${reportPath}`,
    );
  }
  for (const conflict of report.conflicts) {
    warnings.push(`冲突 #${conflict.id} ${conflict.key}：${conflict.message}`);
  }
  if (report.nodeExceptions.length > 0) {
    warnings.push(
      `${report.nodeExceptions.length} 个节点例外（规则文档里写了理由），明细见 ${reportPath}`,
    );
  }
  if (report.cloudImageCalls > 0) {
    warnings.push(`这个界面调用过云端图像模型 ${report.cloudImageCalls} 次`);
  }
  for (const gate of report.verification?.gates ?? []) {
    if (gate.status === 'skipped') {
      warnings.push(`门禁「${gate.name}」被跳过${gate.reason ? `：${gate.reason}` : ''}`);
    }
  }
  if (report.verification === null) {
    warnings.push('找不到门禁的完整报告，导出报告里没有门禁结果；重新运行 ui-pro verify 可生成');
  }
  return warnings;
}

export const exportCommand: CommandModule = {
  name: 'export',
  register(program, host) {
    const group = program.command('export').description('把界面导出到引擎');

    group
      .command('godot')
      .description('导出到 Godot 工程：写入资产，由引擎内的构建器生成或就地更新场景')
      .option('--to <dir>', 'Godot 工程目录（默认取 ui-pro.yaml 的 export.godot.project）')
      .option('--shot', '导出后带窗口运行一次，截图并与基准图比对')
      .action(
        host.action(async (ctx, options: ExportGodotOptions): Promise<CommandResult> => {
          const project = ctx.openProject();
          const screen = ctx.requireScreen(project);
          // The only way in: no switch skips it.
          assertVerified(project, screen);
          const doc = loadScreen(project, screen);
          const target = resolveTarget(project, ctx.cwd, options.to);

          const result = await exportProjectScreen(project, screen, {
            target,
            shot: options.shot
              ? {
                  file: scratchPath(project.root, 'look', `${screen}-godot.png`),
                  reference: resolveInside(project.root, referenceImagePath(doc)),
                }
              : undefined,
          });

          const report: DeliveryReport = {
            ...result.report,
            verification: readGateRecord(project, screen),
            nodeExceptions: readNodeExceptions(project, screen),
            cloudImageCalls: countCloudImageCalls(project, screen),
          };
          const reportPath = `export/${screen}.godot.json`;
          await writeFileAtomic(
            join(project.root, 'export', `${screen}.godot.json`),
            formatJson(report),
          );

          // The tool-owned art children are part of their node, not nodes of their own.
          const created = report.created.filter((id) => !id.endsWith(ART_SUFFIX)).length;
          const updated = report.updated.filter((item) => !item.id.endsWith(ART_SUFFIX)).length;
          const removed = report.removed.filter((id) => !id.endsWith(ART_SUFFIX));
          const counts = `节点 ${report.nodes.length} 个（新增 ${created}、更新 ${updated}、移除 ${removed.length}）`;
          return {
            summary: `已导出界面 ${screen} 到 Godot 工程 ${toPosix(target)}：${counts}${result.createdProject ? '；新建了 Godot 工程' : ''}`,
            data: {
              screen,
              target: toPosix(target),
              createdProject: result.createdProject,
              godot: result.godot.version,
              scene: report.scene,
              nodes: report.nodes.length,
              assets: report.assets.length,
              created,
              updated,
              removed,
              placeholders: report.placeholders.length,
              missingAssets: report.missingAssets.length,
              approximations: report.approximations.length,
              nodeExceptions: report.nodeExceptions.length,
              cloudImageCalls: report.cloudImageCalls,
              conflicts: report.conflicts.length,
              report: reportPath,
              timings: result.timings,
              shot: result.shot,
            },
            warnings: warningsOf(report, reportPath),
            views: result.shot ? [result.shot.file] : undefined,
            next: options.shot ? undefined : ['ui-pro export godot --shot  # 截图并与基准图比对'],
          };
        }),
      );
  },
};
