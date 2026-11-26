import { type LookOptions, type LookResult, lookOverview, lookTarget } from '@ui-pro/perception';
import { InvalidArgumentError } from 'commander';
import { UsageError } from '../errors';
import type { CommandResult } from '../result';
import type { CommandModule } from './types';

interface LookCommandOptions {
  nodesOnly?: boolean;
  candidatesOnly?: boolean;
  zoom?: number;
  /** `--no-zones` sets this to `false`. */
  zones?: boolean;
}

function zoomParser(value: string): number {
  const zoom = Number(value);
  if (!Number.isFinite(zoom) || zoom <= 0) throw new InvalidArgumentError('需要大于 0 的数');
  return zoom;
}

function toLookOptions(options: LookCommandOptions): LookOptions {
  if (options.nodesOnly === true && options.candidatesOnly === true) {
    throw new UsageError('--nodes-only 和 --candidates-only 不能同时使用');
  }
  return {
    nodes: options.candidatesOnly === true ? false : undefined,
    candidates: options.nodesOnly === true ? false : undefined,
    zoom: options.zoom,
    zones: options.zones,
  };
}

function describe(result: LookResult, target: string | undefined): string {
  const [first] = result.images;
  const shown = Object.keys(result.legend).length;
  if (target !== undefined && first) {
    return `已生成 ${target} 的放大图（放大 ${first.zoom} 倍，图中 ${shown} 个框）`;
  }
  const zones = result.images.length - 1;
  const zoneText = zones > 0 ? `和 ${zones} 张分区放大图` : '';
  return `已生成概览图${zoneText}（共 ${shown} 个框，编号见 data.legend）`;
}

export const lookCommand: CommandModule = {
  name: 'look',
  register(program, host) {
    program
      .command('look')
      .description('把候选和节点编号后叠在基准图上输出，供人或 Agent 看图（不进历史）')
      .argument('[target]', '选择器（节点）或 cand#<编号>；省略则输出概览和分区放大图')
      .option('--nodes-only', '只画节点')
      .option('--candidates-only', '只画候选')
      .option('--zoom <factor>', '放大倍数；省略则按图的大小自动选', zoomParser)
      .option('--no-zones', '概览之外不输出分区放大图')
      .action(
        host.action(
          async (
            ctx,
            target: string | undefined,
            options: LookCommandOptions,
          ): Promise<CommandResult> => {
            const project = ctx.openProject();
            const screen = ctx.requireScreen(project);
            const lookOptions = toLookOptions(options);
            const result =
              target === undefined
                ? await lookOverview(project, screen, lookOptions)
                : await lookTarget(project, screen, target, lookOptions);
            return {
              summary: describe(result, target),
              data: result,
              views: result.images.map((image) => image.path),
              next:
                target === undefined
                  ? ['ui-pro look cand#<编号>  # 放大看某一个候选，小元素在分区放大图里更清楚']
                  : undefined,
            };
          },
        ),
      );
  },
};
