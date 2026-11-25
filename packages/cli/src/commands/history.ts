import { listHistory, type RevertedEntry, redo, showVersion, undo } from '@ui-pro/core';
import type { Command } from 'commander';
import type { CommandResult } from '../result';
import { integerParser } from './options';
import type { CommandModule } from './types';

function parseVersion(text: string): number {
  return integerParser(1)(text.replace(/^v/i, ''));
}

function revertData(entry: RevertedEntry): CommandResult['data'] {
  return { version: entry.version, revertOf: entry.revertOf, docs: Object.keys(entry.docs) };
}

export const historyCommand: CommandModule = {
  name: 'history',
  register(program, host) {
    const history: Command = program
      .command('history')
      .description('查看、撤销、重做工程的修改历史');

    history
      .command('list')
      .description('列出历史版本（最旧在前）')
      .option('--limit <n>', '只显示最新的 n 个版本', integerParser(1))
      .action(
        host.action(async (ctx, options: { limit?: number }) => {
          const items = listHistory(ctx.openProject(), { limit: options.limit });
          return { summary: `共 ${items.length} 个版本`, data: { items } };
        }),
      );

    history
      .command('show')
      .description('显示一个版本的详情：说明、操作与涉及的文件')
      .argument('<version>', '版本号，如 3 或 v3', parseVersion)
      .action(
        host.action(async (ctx, version: number) => {
          const entry = showVersion(ctx.openProject(), version);
          return { summary: `v${entry.version}：${entry.message}`, data: entry };
        }),
      );

    history
      .command('undo')
      .description('撤销最近一次尚未撤销的修改（作为新版本记录）')
      .action(
        host.action(async (ctx) => {
          const entry = await undo(ctx.openProject());
          return {
            summary: `已撤销 v${entry.revertOf}，生成 v${entry.version}`,
            data: revertData(entry),
            next: ['ui-pro history redo  # 重做被撤销的修改'],
          };
        }),
      );

    history
      .command('redo')
      .description('重做最近一次被撤销的修改')
      .action(
        host.action(async (ctx) => {
          const entry = await redo(ctx.openProject());
          return {
            summary: `已重做（回退了 v${entry.revertOf} 的撤销），生成 v${entry.version}`,
            data: revertData(entry),
          };
        }),
      );
  },
};
