import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  type ApplyResult,
  applyOps,
  ErrorCodes,
  ioError,
  stripBom,
  toPosix,
  UiProError,
} from '@ui-pro/core';
import type { CommandModule } from './types';

interface ApplyCommandOptions {
  dryRun?: boolean;
  message?: string;
}

function invalidBatch(message: string): UiProError {
  return new UiProError(ErrorCodes.opInvalid, message, {
    hint: '操作文件是 JSON：一个操作数组，或 { "ops": [...] }；ui-pro schema 列出所有操作',
  });
}

/** Accepts `[op, ...]` or `{ "ops": [op, ...] }`. */
function parseBatch(text: string, label: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw invalidBatch(`${label} 不是合法的 JSON：${reason}`);
  }
  const ops =
    typeof parsed === 'object' && parsed !== null && 'ops' in parsed ? parsed.ops : parsed;
  if (!Array.isArray(ops)) throw invalidBatch(`${label} 需要是操作数组，或带 ops 数组的对象`);
  if (ops.length === 0) throw invalidBatch(`${label} 里没有任何操作`);
  return ops;
}

async function readBatchFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw ioError('读取操作文件', toPosix(path), error);
  }
}

function summarize(result: ApplyResult): string {
  let added = 0;
  let modified = 0;
  let removed = 0;
  for (const screen of Object.values(result.changes.screens)) {
    added += screen.added.length;
    modified += Object.keys(screen.modified).length;
    removed += screen.removed.length;
  }
  const { docs } = result.changes;
  const counts =
    added + modified + removed === 0 && docs.length > 0
      ? `改动 ${docs.join('、')}`
      : `节点新增 ${added}、修改 ${modified}、删除 ${removed}`;
  const changed = docs.length > 0;
  if (result.dryRun) return `预演通过（未写入）：${changed ? counts : '没有变化'}`;
  if (result.version === undefined) return '没有产生任何变化，未创建新版本';
  return `已提交 v${result.version}：${counts}`;
}

function followUps(result: ApplyResult): string[] | undefined {
  if (result.dryRun) return ['去掉 --dry-run 重新运行即可正式应用'];
  return result.version === undefined ? undefined : ['ui-pro history undo  # 撤销这次修改'];
}

export const applyCommand: CommandModule = {
  name: 'apply',
  register(program, host) {
    program
      .command('apply')
      .description('把一批操作作为一个事务应用到项目（全部成功或全部不生效）')
      .argument('<file>', '操作文件（JSON）；- 表示从标准输入读取')
      .option('--dry-run', '只检查和预演，不写入任何文件')
      .option('--message <text>', '历史版本的说明')
      .action(
        host.action(async (ctx, file: string, options: ApplyCommandOptions) => {
          const project = ctx.openProject();
          const path = resolve(ctx.cwd, file);
          const label = file === '-' ? '标准输入' : toPosix(path);
          const text = file === '-' ? await ctx.readStdin() : await readBatchFile(path);

          const result = await applyOps(project, parseBatch(text, label), {
            screen: ctx.currentScreen(project),
            dryRun: options.dryRun === true,
            message: options.message,
            source: 'cli',
          });
          return {
            summary: summarize(result),
            data: { dryRun: result.dryRun, version: result.version, changes: result.changes },
            warnings: result.warnings,
            ask: result.ask,
            next: followUps(result),
          };
        }),
      );
  },
};
