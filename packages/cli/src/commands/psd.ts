import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import {
  ErrorCodes,
  ioError,
  isUiProError,
  loadScreen,
  type Project,
  resolveInside,
  screenRelDir,
  toPosix,
  UiProError,
} from '@ui-pro/core';
import { lintPsd, PsdErrorCodes, type PsdIssue, type PsdLintResult } from '@ui-pro/psd';
import type { CommandContext } from '../context';
import type { CommandResult } from '../result';
import type { CommandModule } from './types';

interface LintCommandOptions {
  /** `--no-render` sets this to `false`. */
  render?: boolean;
}

const SEVERITY_NAMES = { must: '必须', should: '建议' } as const;

/** The project around the working directory, when there is one; `lint` also runs without. */
function openProjectIfAny(ctx: CommandContext): Project | undefined {
  try {
    return ctx.openProject();
  } catch (error) {
    const missing = isUiProError(error) && error.code === ErrorCodes.projectNotFound;
    if (missing && ctx.globals.project === undefined) return undefined;
    throw error;
  }
}

interface LintTarget {
  bytes: Uint8Array;
  label: string;
}

async function readTarget(path: string, label: string): Promise<LintTarget> {
  try {
    return { bytes: await readFile(path), label };
  } catch (cause) {
    throw ioError('读取 PSD 文件', toPosix(path), cause);
  }
}

async function resolveTarget(
  ctx: CommandContext,
  project: Project | undefined,
  file: string | undefined,
): Promise<LintTarget> {
  if (file !== undefined) {
    const path = resolve(ctx.cwd, file);
    return readTarget(path, basename(path));
  }
  const opened = project ?? ctx.openProject();
  const screen = ctx.requireScreen(opened);
  const { source } = loadScreen(opened, screen);
  if (source.kind !== 'psd' || !source.file.toLowerCase().endsWith('.psd')) {
    throw new UiProError(PsdErrorCodes.source, `界面 ${screen} 的源文件不是 PSD 文件`, {
      hint: '直接给出 PSD 文件的路径：ui-pro psd lint <file>',
    });
  }
  const path = resolveInside(opened.root, `${screenRelDir(screen)}/${source.file}`);
  return readTarget(path, basename(path));
}

function issueData(issue: PsdIssue) {
  return {
    severity: SEVERITY_NAMES[issue.severity],
    category: issue.category,
    code: issue.code,
    ...(issue.layer === undefined ? {} : { layer: issue.layer }),
    message: issue.message,
    fix: issue.fix,
  };
}

function summarize(result: PsdLintResult, label: string): string {
  const musts = result.issues.filter((issue) => issue.severity === 'must').length;
  const shoulds = result.issues.length - musts;
  const grade = result.grade === null ? '待定（没有核对还原）' : result.grade;
  return `${label}：输入等级 ${grade}，必须修改 ${musts} 项，建议修改 ${shoulds} 项`;
}

export const psdCommand: CommandModule = {
  name: 'psd',
  register(program, host) {
    const group = program.command('psd').description('PSD 源文件相关检查');
    group
      .command('lint')
      .description('检查 PSD 的图层命名与结构是否符合交付规范，并给出美术要改的清单')
      .argument('[file]', 'PSD 文件；省略时检查当前界面的源文件')
      .option('--no-render', '不渲染图层，只检查文件和结构（不核对还原，等级待定）')
      .action(
        host.action(async (ctx, file: string | undefined, options: LintCommandOptions) => {
          const project = openProjectIfAny(ctx);
          const target = await resolveTarget(ctx, project, file);
          const result = await lintPsd(target.bytes, {
            project,
            scratchRoot: project?.root ?? ctx.cwd,
            label: target.label,
            render: options.render !== false,
          });

          const warnings =
            result.restore.skipped === undefined ? [] : [`还原没有核对：${result.restore.skipped}`];
          const output: CommandResult = {
            summary: summarize(result, target.label),
            data: {
              file: target.label,
              grade: result.grade,
              canvas: result.canvas,
              layers: result.layers,
              issues: result.issues.map(issueData),
              restore: result.restore,
              unchecked: result.unchecked,
            },
            warnings,
            views: [toPosix(result.checklistPath)],
            next:
              result.issues.length > 0
                ? [`按清单修改后重新运行：ui-pro psd lint ${target.label}`]
                : undefined,
          };
          return output;
        }),
      );
  },
};
