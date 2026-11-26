import { scratchPath, toPosix } from '@ui-pro/core';
import {
  GATE_IDS,
  GATE_NAMES,
  type GateId,
  type GateResult,
  type VerifyReport,
  verifyScreen,
} from '@ui-pro/verify';
import { InvalidArgumentError } from 'commander';
import type { CommandResult } from '../result';
import type { CommandModule } from './types';

/** Problems per gate in the response; the full list is in `report.json`. */
export const MAX_PROBLEMS_PER_GATE = 10;

/** Warnings in the response, over all gates. */
const MAX_WARNINGS = 30;

interface VerifyCommandOptions {
  gate?: GateId[];
  engine?: boolean;
}

/** `--gate a --gate b,c` collected into one list, each name checked. */
function collectGates(value: string, previous: GateId[] = []): GateId[] {
  const found = [...previous];
  for (const name of value.split(',')) {
    const id = GATE_IDS.find((gate) => gate === name.trim());
    if (id === undefined) {
      throw new InvalidArgumentError(`没有这道门禁：${name}；可用的：${GATE_IDS.join('、')}`);
    }
    if (!found.includes(id)) found.push(id);
  }
  return found;
}

/** What went wrong with a failed gate, in a few words for the summary. */
function headline(gate: GateResult): string {
  const metric = (name: string): number => gate.metrics[name] ?? 0;
  switch (gate.id) {
    case 'fidelity': {
      const overall = gate.problems.find((problem) => problem.node === undefined);
      const inside = overall?.message.match(/（(.*)）$/)?.[1];
      const nodes = metric('nodesFailed');
      return (
        [inside, nodes > 0 ? `${nodes} 个节点与基准图不一致` : undefined]
          .filter((part) => part !== undefined)
          .join('；') || `${gate.problems.length} 个问题`
      );
    }
    case 'standalone':
      return `${metric('failed')} 个资产有问题`;
    case 'hide': {
      const parts = [
        metric('ghosts') > 0 ? `${metric('ghosts')} 处残影` : undefined,
        metric('seams') > 0 ? `${metric('seams')} 处接缝` : undefined,
      ].filter((part) => part !== undefined);
      return parts.join('、') || `${gate.problems.length} 个问题`;
    }
    case 'adaptation': {
      const parts = [
        metric('overlaps') > 0 ? `${metric('overlaps')} 对节点新出现重叠` : undefined,
        metric('outOfBounds') > 0 ? `${metric('outOfBounds')} 个节点越出画面` : undefined,
      ].filter((part) => part !== undefined);
      return parts.join('、') || `${gate.problems.length} 个问题`;
    }
    default:
      return `${gate.problems.length} 个问题`;
  }
}

function summarize(report: VerifyReport): string {
  const failed = report.gates.filter((gate) => gate.status === 'fail');
  const skipped = report.gates.filter((gate) => gate.status === 'skipped');
  if (failed.length > 0) {
    const named = failed.map((gate) => `${gate.name}（${headline(gate)}）`).join('、');
    return `界面 ${report.screen} 有 ${failed.length} 道门禁未通过：${named}`;
  }
  const passed = report.gates.length - skipped.length;
  const skippedText =
    skipped.length > 0
      ? `，${skipped.length} 道跳过（${skipped.map((gate) => gate.name).join('、')}）`
      : '';
  return `界面 ${report.screen} 通过 ${passed} 道门禁${skippedText}`;
}

function followUps(report: VerifyReport, partial: boolean): string[] {
  const failed = report.gates.filter((gate) => gate.status === 'fail');
  if (failed.length === 0) {
    return partial ? ['ui-pro verify  # 跑全部门禁，通过之后才能导出'] : ['ui-pro export godot'];
  }
  const fix = failed
    .flatMap((gate) => gate.problems)
    .find((problem) => problem.fix !== undefined)?.fix;
  const again = `ui-pro verify --gate ${failed.map((gate) => gate.id).join(',')}  # 修好之后只重跑没通过的门禁`;
  return fix === undefined ? [again] : [fix, again];
}

export const verifyCommand: CommandModule = {
  name: 'verify',
  register(program, host) {
    program
      .command('verify')
      .description('跑质量门禁：重组图与基准图比对、显隐测试、规则一致、适配、文本、性能预算等')
      .option(
        '--gate <id>',
        `只跑指定的门禁，可重复或用逗号分隔（${GATE_IDS.map((id) => `${id} ${GATE_NAMES[id]}`).join('、')}）；只跑部分门禁不写门禁记录`,
        collectGates,
      )
      .option('--engine', '最后加跑引擎一致门禁（需要 Godot，没有时跳过）')
      .action(
        host.action(async (ctx, options: VerifyCommandOptions): Promise<CommandResult> => {
          const project = ctx.openProject();
          const screen = ctx.requireScreen(project);
          const report = await verifyScreen(project, screen, {
            ...(options.gate ? { gates: options.gate } : {}),
            ...(options.engine ? { engine: true } : {}),
          });

          const shown = report.gates.map((gate) => ({
            ...gate,
            problemCount: gate.problems.length,
            problems: gate.problems.slice(0, MAX_PROBLEMS_PER_GATE),
          }));
          const reportFile = toPosix(scratchPath(project.root, 'verify', screen, 'report.json'));
          const warnings = report.gates.flatMap((gate) =>
            gate.warnings.map((warning) => `${gate.name}：${warning}`),
          );
          return {
            summary: summarize(report),
            data: {
              ...report,
              gates: shown,
              report: reportFile,
              stamped: options.gate === undefined,
            },
            warnings: warnings.slice(0, MAX_WARNINGS),
            ask: report.ask,
            views: report.views,
            next: followUps(report, options.gate !== undefined),
          };
        }),
      );
  },
};
