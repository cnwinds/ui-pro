import { Command, Option } from 'commander';
import { commandModules } from './commands';
import { createHost, type ResultSlot } from './host';
import type { CliIo, TextSink } from './io';
import { registerPlugins } from './plugins';

/** The commander tree: global options plus every registered command module. */
export function buildProgram(io: CliIo, stdout: TextSink, slot: ResultSlot): Command {
  registerPlugins();
  const program = new Command('ui-pro')
    .description('把游戏界面的拍平图或 PSD 还原为可交互、可导出到 Godot 的界面')
    .exitOverride()
    // Usage problems are reported through the response envelope, not as raw stderr text.
    .configureOutput({ writeOut: (text) => stdout.write(text), writeErr: () => undefined })
    .option('--project <dir>', '项目目录（默认从当前目录向上查找 ui-pro.yaml）')
    .option('--screen <name>', '当前界面（项目只有一个界面时可省略）')
    .addOption(
      new Option('--format <format>', '输出格式').choices(['json', 'text']).default('json'),
    )
    .option('--debug', '失败时输出更多诊断信息（内部错误会带上调用栈）', false);

  const host = createHost(program, io, slot);
  for (const module of commandModules) module.register(program, host);
  return program;
}
