import { type BuildOptions, type BuildReport, buildScreen } from '@ui-pro/build';
import { UsageError } from '../errors';
import type { CommandResult } from '../result';
import type { CommandModule } from './types';

interface BuildCommandOptions {
  final?: boolean;
  draft?: boolean;
  locked?: boolean;
  regenerate?: string;
  dryRun?: boolean;
}

function assertCompatible(options: BuildCommandOptions): void {
  if (options.final === true && options.draft === true) {
    throw new UsageError(
      '--final 和 --draft 不能同时使用',
      '终稿用 --final，草稿用 --draft，都不写则按有没有云端图像模型自动选',
    );
  }
  if (options.locked === true && options.regenerate !== undefined) {
    throw new UsageError(
      '--locked 和 --regenerate 不能同时使用',
      '--locked 不允许产生新的模型输出，而 --regenerate 正是要重新生成',
    );
  }
}

function buildOptions(options: BuildCommandOptions): BuildOptions {
  return {
    dryRun: options.dryRun === true,
    locked: options.locked === true,
    ...(options.final === true ? { quality: 'final' as const } : {}),
    ...(options.draft === true ? { quality: 'draft' as const } : {}),
    ...(options.regenerate === undefined ? {} : { regenerate: options.regenerate }),
  };
}

function summarize(report: BuildReport, dryRun: boolean): string {
  const { reused, generated } = report;
  const counts = `资产 ${report.assets} 个（复用锁定输出 ${reused} 次，本地模型 ${generated.local} 次，云端 ${generated.cloud} 次）`;
  if (dryRun) return `预演完成（未写入）：界面 ${report.screen} 会有${counts}`;
  const unchanged = report.version === undefined ? '；资产和决定都没有变化，没有写入新版本' : '';
  return `已构建界面 ${report.screen}：${counts}${unchanged}`;
}

function approximationLines(report: BuildReport): string[] {
  return report.approximations.map((entry) => `近似项 #${entry.node}：${entry.message}`);
}

function followUps(report: BuildReport, dryRun: boolean): string[] {
  if (dryRun) return ['去掉 --dry-run 重新运行即可正式构建'];
  const next = ['ui-pro verify  # 检查资产是否与决定相符、重组后是否还原基准图'];
  if (report.version !== undefined) next.push('ui-pro history undo  # 不满意就撤销这次构建');
  return next;
}

export const buildCommand: CommandModule = {
  name: 'build',
  register(program, host) {
    program
      .command('build')
      .description('按决定构建界面的资产（抠取、补全、文字剥离、九宫、提升分辨率；一个历史版本）')
      .option('--final', '终稿：用云端图像模型精修（需要云端图像模型，外发级别不能是 local）')
      .option('--draft', '草稿：只用本地方法，不调用云端')
      .option('--locked', '不产生任何新的模型输出，缺少锁定输出就报错（CI 用）')
      .option(
        '--regenerate <选择器>',
        '丢掉所选节点的锁定输出，重新生成并换掉锁定记录（旧文件保留）',
      )
      .option('--dry-run', '只计算并报告，不写入任何文件')
      .action(
        host.action(async (ctx, options: BuildCommandOptions): Promise<CommandResult> => {
          assertCompatible(options);
          const project = ctx.openProject();
          const screen = ctx.requireScreen(project);
          const dryRun = options.dryRun === true;

          const report = await buildScreen(project, screen, buildOptions(options));

          return {
            summary: summarize(report, dryRun),
            data: report,
            warnings: [...report.warnings, ...approximationLines(report)],
            ask: report.ask,
            views: report.views,
            next: followUps(report, dryRun),
          };
        }),
      );
  },
};
