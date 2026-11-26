import {
  type AnalysisReport,
  ErrorCodes,
  loadScreen,
  type Project,
  UiProError,
} from '@ui-pro/core';
import { analyzeFlatScreen, PerceptionErrorCodes } from '@ui-pro/perception';
import { analyzePsdScreen } from '@ui-pro/psd';
import type { CommandResult } from '../result';
import type { CommandModule } from './types';

interface AnalyzeCommandOptions {
  update?: boolean;
  allowDegraded?: boolean;
  dryRun?: boolean;
}

function assertNotAnalyzed(project: Project, screen: string): void {
  const doc = loadScreen(project, screen);
  const nodes = Object.keys(doc.nodes).filter((id) => id !== doc.root).length;
  if (nodes > 0) {
    throw new UiProError(
      PerceptionErrorCodes.alreadyAnalyzed,
      `界面 ${screen} 已经有 ${nodes} 个节点，不能再次分析`,
      { hint: '要重新分析，先用 ui-pro history undo 撤销上次分析（--update 增量分析尚未实现）' },
    );
  }
}

function summarize(report: AnalysisReport): string {
  const counts = `候选 ${report.candidates} 个、相似簇 ${report.clusters} 个、草稿节点 ${report.nodes} 个`;
  const grade = report.grade === undefined ? '' : `，输入等级 ${report.grade}`;
  const risk =
    report.precheck.risks.length > 0
      ? `；风险：${report.precheck.risks.join('；')}`
      : '；预检没有发现风险';
  if (report.version === undefined) return `预演完成（未写入）：${counts}${grade}${risk}`;
  return `已分析界面 ${report.screen}（v${report.version}）：${counts}${grade}${risk}`;
}

function followUps(report: AnalysisReport): string[] {
  if (report.version === undefined) return ['去掉 --dry-run 重新运行即可正式分析'];
  return [
    'ui-pro look  # 看概览图和分区放大图，图上的编号就是候选编号',
    'ui-pro look cand#<编号>  # 放大看某一个候选',
    'ui-pro history undo  # 不满意就撤销这次分析',
  ];
}

export const analyzeCommand: CommandModule = {
  name: 'analyze',
  register(program, host) {
    program
      .command('analyze')
      .description('分析界面的源文件，生成候选、相似簇和节点草稿（一个历史版本）')
      .option('--update', '源文件更新后保留已有工作的重新分析（尚未实现）')
      .option('--allow-degraded', 'PSD 输入低于 A 级时也分析，受影响的图层按整图像素处理')
      .option('--dry-run', '只计算并报告，不写入任何文件')
      .action(
        host.action(async (ctx, options: AnalyzeCommandOptions): Promise<CommandResult> => {
          const project = ctx.openProject();
          const screen = ctx.requireScreen(project);
          if (options.update === true) {
            throw new UiProError(ErrorCodes.notImplemented, '--update 增量分析尚未实现', {
              hint: '现在要重新分析，请先 ui-pro history undo 撤销上次分析',
            });
          }
          assertNotAnalyzed(project, screen);

          const analyzeOptions = {
            allowDegraded: options.allowDegraded === true,
            dryRun: options.dryRun === true,
          };
          const source = loadScreen(project, screen).source;
          const report =
            source.kind === 'flat'
              ? await analyzeFlatScreen(project, screen, analyzeOptions)
              : await analyzePsdScreen(project, screen, analyzeOptions);
          return {
            summary: summarize(report),
            data: report,
            warnings: report.warnings,
            ask: report.ask,
            views: report.views,
            next: followUps(report),
          };
        }),
      );
  },
};
