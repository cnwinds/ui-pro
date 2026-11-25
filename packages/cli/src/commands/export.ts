import { join, resolve } from 'node:path';
import { exportScreen, GodotErrorCodes, referenceCropSource } from '@ui-pro/adapter-godot';
import {
  ErrorCodes,
  formatJson,
  loadScreen,
  type Project,
  readFileIfExists,
  referenceImagePath,
  resolveInside,
  scratchPath,
  toPosix,
  UiProError,
  writeFileAtomic,
} from '@ui-pro/core';
import type { CommandResult } from '../result';
import type { CommandModule } from './types';

interface ExportGodotOptions {
  to?: string;
  shot?: boolean;
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

async function readReference(project: Project, relativePath: string): Promise<Buffer> {
  const bytes = await readFileIfExists(resolveInside(project.root, relativePath));
  if (bytes === null) {
    throw new UiProError(ErrorCodes.io, `找不到基准图：${relativePath}`, {
      hint: 'PSD 源文件要先运行 ui-pro analyze 生成合成图',
    });
  }
  return bytes;
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
          const doc = loadScreen(project, screen);
          const target = resolveTarget(project, ctx.cwd, options.to);
          const referenceRel = referenceImagePath(doc);
          const reference = await readReference(project, referenceRel);

          const result = await exportScreen({
            doc,
            projectName: project.config.name,
            design: project.config.design,
            target,
            assets: await referenceCropSource(doc, reference),
            shot: options.shot
              ? {
                  file: scratchPath(project.root, 'look', `${screen}-godot.png`),
                  reference: resolveInside(project.root, referenceRel),
                }
              : undefined,
          });

          const { report } = result;
          const reportPath = `export/${screen}.godot.json`;
          await writeFileAtomic(
            join(project.root, 'export', `${screen}.godot.json`),
            formatJson(report),
          );

          const approximateAssets = report.assets.filter((asset) => asset.approximate).length;
          const warnings: string[] = [];
          if (report.placeholders.length > 0) {
            const list = report.placeholders
              .map((item) => `#${item.id}（${item.type}）`)
              .join('、');
            warnings.push(
              `${report.placeholders.length} 个节点的基元类型还没有对应的 Godot 控件，已导出为占位 Control：${list}`,
            );
          }
          if (approximateAssets > 0) {
            warnings.push(
              `${approximateAssets} 个资产是按节点框从基准图裁出的近似图，待资产构建后替换`,
            );
          }
          for (const item of report.approximations) warnings.push(`#${item.id}：${item.detail}`);
          for (const conflict of report.conflicts) {
            warnings.push(`冲突 #${conflict.id} ${conflict.key}：${conflict.message}`);
          }

          const counts = `节点 ${report.nodes.length} 个（新增 ${report.created.length}、更新 ${report.updated.length}、移除 ${report.removed.length}）`;
          return {
            summary: `已导出界面 ${screen} 到 Godot 工程 ${toPosix(target)}：${counts}${result.createdProject ? '；新建了 Godot 工程' : ''}`,
            data: {
              screen,
              target: toPosix(target),
              createdProject: result.createdProject,
              godot: result.godot.version,
              scene: report.scene,
              nodes: report.nodes.length,
              created: report.created.length,
              updated: report.updated.length,
              removed: report.removed,
              placeholders: report.placeholders.length,
              approximateAssets,
              approximations: report.approximations.length,
              conflicts: report.conflicts.length,
              report: reportPath,
              timings: result.timings,
              shot: result.shot,
            },
            warnings,
            views: result.shot ? [result.shot.file] : undefined,
            next: options.shot ? undefined : ['ui-pro export godot --shot  # 截图并与基准图比对'],
          };
        }),
      );
  },
};
