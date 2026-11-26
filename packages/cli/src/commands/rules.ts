import { ErrorCodes, projectSelectorEnv, resolveSelector, UiProError } from '@ui-pro/core';
import {
  type CheckItem,
  checkRules,
  explainNodes,
  type Layer,
  lintProject,
  listRules,
  POINT_NAMES,
  RulesErrorCodes,
  readRuleInputs,
} from '@ui-pro/rules';
import { Option } from 'commander';
import { UsageError } from '../errors';
import { integerParser } from './options';
import type { CommandModule } from './types';

interface ListOptions {
  point?: string;
  layer?: Layer;
  pending?: boolean;
  disabled?: boolean;
  limit: number;
  offset: number;
}

interface WhyOptions {
  point?: string;
  limit: number;
}

const LAYER_NAMES: Record<Layer, string> = {
  default: '默认规则包',
  project: '项目规则',
  screen: '界面规则',
};

function assertPoint(point: string | undefined): void {
  if (point !== undefined && !POINT_NAMES.includes(point)) {
    throw new UsageError(`未知的决策点：${point}`, `可用的决策点：${POINT_NAMES.join('、')}`);
  }
}

function describeChecks(items: readonly CheckItem[]): string {
  const count = (status: CheckItem['status']) => items.filter((item) => item.status === status);
  const skipped = count('skipped').map((item) => item.name);
  const skippedText =
    skipped.length > 0 ? `，${skipped.length} 项跳过（${skipped.join('、')}）` : '';
  return `${count('pass').length} 项通过${skippedText}`;
}

export const rulesCommand: CommandModule = {
  name: 'rules',
  register(program, host) {
    const rules = program.command('rules').description('规则的查看、解释与检查');

    rules
      .command('list')
      .description('列出生效的规则；可按决策点、规则层筛选，也能看待定区和已停用的规则')
      .option('--point <name>', '只看某个决策点的规则，如 attach.split')
      .addOption(
        new Option('--layer <layer>', '只看某一层的规则').choices(['default', 'project', 'screen']),
      )
      .option('--pending', '只看项目规则待定区里的规则（尚未生效）')
      .option('--disabled', '只看已停用的规则及停用理由')
      .option('--limit <n>', '最多返回的规则数', integerParser(1), 100)
      .option('--offset <n>', '跳过前 n 条', integerParser(0), 0)
      .action(
        host.action(async (ctx, options: ListOptions) => {
          assertPoint(options.point);
          if (options.pending && options.disabled) {
            throw new UsageError('--pending 和 --disabled 不能同时使用');
          }
          const project = ctx.openProject();
          const mode = options.pending ? 'pending' : options.disabled ? 'disabled' : 'effective';
          const items = listRules(readRuleInputs(project), {
            mode,
            point: options.point,
            layer: options.layer,
            screen: ctx.globals.screen,
          });
          const page = items.slice(options.offset, options.offset + options.limit);
          const end = options.offset + page.length;

          const byLayer = (layer: Layer) => items.filter((item) => item.layer === layer).length;
          const summary =
            mode === 'pending'
              ? `待定区有 ${items.length} 条规则（尚未生效）`
              : mode === 'disabled'
                ? `已停用 ${items.length} 条规则`
                : `共 ${items.length} 条生效的规则（${LAYER_NAMES.default} ${byLayer('default')} 条、${LAYER_NAMES.project} ${byLayer('project')} 条、${LAYER_NAMES.screen} ${byLayer('screen')} 条）`;
          return {
            summary,
            data: {
              total: items.length,
              offset: options.offset,
              limit: options.limit,
              items: page,
            },
            next: end < items.length ? [`ui-pro rules list --offset ${end}`] : undefined,
          };
        }),
      );

    rules
      .command('why')
      .description('逐个决策点解释节点的决定：取值、生效的规则、被压过的规则')
      .argument('<selector>', 'CSS 风格选择器，如 "#badge_dot"')
      .option('--point <name>', '只解释某个决策点')
      .option('--limit <n>', '最多解释的节点数', integerParser(1), 10)
      .action(
        host.action(async (ctx, selector: string, options: WhyOptions) => {
          assertPoint(options.point);
          const project = ctx.openProject();
          const refs = resolveSelector(
            selector,
            projectSelectorEnv(project, ctx.currentScreen(project)),
          );
          if (refs.length === 0) {
            throw new UiProError(
              ErrorCodes.selectorEmpty,
              `选择器没有匹配到任何节点：${selector}`,
              {
                hint: '用 ui-pro query 先确认选择器能选中目标',
              },
            );
          }
          const shown = refs.slice(0, options.limit);
          const items = explainNodes(readRuleInputs(project), shown, { point: options.point });
          const points = items.reduce((sum, item) => sum + item.points.length, 0);
          const [only] = items;
          const summary =
            refs.length === 1 && only
              ? `${only.screen}/#${only.id}：${points} 个适用的决策点${options.point === undefined ? '' : `（只看 ${options.point}）`}`
              : `匹配 ${refs.length} 个节点，解释了其中 ${items.length} 个`;
          return {
            summary,
            data: { total: refs.length, items },
            warnings: items.flatMap((item) =>
              item.points
                .filter((point) => point.status !== 'decided')
                .map(
                  (point) =>
                    `${item.screen}/#${item.id} 的 ${point.point} ${point.status === 'ambiguous' ? '有歧义，没有决定' : '没有任何规则给出决定'}`,
                ),
            ),
          };
        }),
      );

    rules
      .command('check')
      .description('一致性检查：完备、无歧义、无漂移、同形同判、例外有据、规则不回归')
      .action(
        host.action(async (ctx) => {
          const report = checkRules(readRuleInputs(ctx.openProject()));
          const failed = report.items.filter((item) => item.status === 'fail');
          if (failed.length > 0) {
            const problems = failed.reduce((sum, item) => sum + item.problems.length, 0);
            throw new UiProError(
              RulesErrorCodes.checkFailed,
              `规则检查未通过：${failed.map((item) => item.name).join('、')}（共 ${problems} 个问题）`,
              {
                hint: '按 details.checks 里每项的 problems 逐条修正；决定过期时提交 { "op": "rule.recompute" } 刷新',
                details: { checks: report.items },
              },
            );
          }
          return {
            summary: `规则检查通过：${describeChecks(report.items)}`,
            data: { ok: true, checks: report.items },
            warnings: report.items.flatMap((item) => item.warnings),
          };
        }),
      );

    rules
      .command('lint')
      .description('检查规则文件：格式、引用的决策点和取值，以及默认规则包的通用性')
      .action(
        host.action(async (ctx) => {
          const project = ctx.openProject();
          const { problems, files } = lintProject(project);
          const errors = problems.filter((problem) => problem.severity === 'error');
          const warnings = problems.filter((problem) => problem.severity === 'warning');
          if (errors.length > 0) {
            throw new UiProError(
              RulesErrorCodes.lintFailed,
              `规则文件检查未通过：${errors.length} 个错误、${warnings.length} 个警告`,
              { hint: '按 details.problems 逐条修正后重新运行', details: { problems, files } },
            );
          }
          return {
            summary: `规则文件检查通过：${files.length} 个文件，${warnings.length} 个警告`,
            data: { problems, files },
            warnings: warnings.map((problem) => `${problem.file}：${problem.message}`),
          };
        }),
      );
  },
};
