import { resolve } from 'node:path';
import {
  addScreen,
  createProject,
  type DesignSize,
  ENGINES,
  type ProjectConfig,
  toPosix,
} from '@ui-pro/core';
import { InvalidArgumentError, Option } from 'commander';
import type { CommandContext } from '../context';
import { UsageError } from '../errors';
import type { CommandResult } from '../result';
import type { CommandModule } from './types';

interface InitOptions {
  name?: string;
  design?: DesignSize;
  engine?: ProjectConfig['engine'];
  source?: string;
}

function parseDesign(value: string): DesignSize {
  const match = /^(\d+)x(\d+)$/i.exec(value);
  const [, rawWidth = '', rawHeight = ''] = match ?? [];
  const width = Number(rawWidth);
  const height = Number(rawHeight);
  if (!match || width < 1 || height < 1) {
    throw new InvalidArgumentError('格式应为 <宽>x<高>，如 1080x1920');
  }
  return { width, height };
}

async function initProject(
  ctx: CommandContext,
  dir: string | undefined,
  options: InitOptions,
): Promise<CommandResult> {
  if (options.source !== undefined) {
    throw new UsageError(
      '--source 需要和 --screen <name> 一起使用',
      '新增界面：ui-pro init --screen <name> --source <file>',
    );
  }
  const target = resolve(ctx.cwd, dir ?? ctx.globals.project ?? '.');
  const project = await createProject(target, {
    name: options.name,
    design: options.design,
    engine: options.engine,
  });
  const { name, design, engine } = project.config;
  return {
    summary: `已创建项目 ${name}（设计分辨率 ${design.width}x${design.height}，引擎 ${engine}）`,
    data: { root: toPosix(project.root), name, design, engine },
    next: ['ui-pro init --screen <name> --source <png|psd|交付包目录>'],
  };
}

async function initScreen(
  ctx: CommandContext,
  screen: string,
  dir: string | undefined,
  options: InitOptions,
): Promise<CommandResult> {
  if (dir !== undefined) {
    throw new UsageError('新增界面时不接受目录参数', '用 --project 指定项目目录');
  }
  if (options.name !== undefined || options.design !== undefined || options.engine !== undefined) {
    throw new UsageError('新增界面时不能同时使用 --name、--design、--engine');
  }
  if (options.source === undefined) {
    throw new UsageError('--screen 需要同时给 --source <png|psd|交付包目录>');
  }
  const project = ctx.openProject();
  const added = await addScreen(project, {
    name: screen,
    source: resolve(ctx.cwd, options.source),
  });
  const { source, scale, size } = added.screen;
  return {
    summary: `已新增界面 ${screen}（源文件 ${source.width}x${source.height}，设计尺寸 ${size[0]}x${size[1]}）`,
    data: { screen, version: added.version, source, scale, size, files: added.files },
    next: [`ui-pro query "*" --screen ${screen} --tree`],
  };
}

export const initCommand: CommandModule = {
  name: 'init',
  register(program, host) {
    program
      .command('init')
      .description('创建项目；带 --screen 和 --source 时向现有项目新增一个界面')
      .argument('[dir]', '项目目录（默认取 --project，再默认当前目录）')
      .option('--name <name>', '项目名（默认取目录名）')
      .option('--design <WxH>', '设计分辨率，默认 1080x1920', parseDesign)
      .addOption(new Option('--engine <engine>', '目标引擎').choices(ENGINES))
      .option('--source <path>', '新增界面的源文件：PNG/JPG/WebP 拍平图、.psd 或交付包目录')
      .action(
        host.action(async (ctx, dir: string | undefined, options: InitOptions) =>
          ctx.globals.screen === undefined
            ? initProject(ctx, dir, options)
            : initScreen(ctx, ctx.globals.screen, dir, options),
        ),
      );
  },
};
