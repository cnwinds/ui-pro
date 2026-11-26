import { type CheckProblem, checkRules, readRuleInputs } from '@ui-pro/rules';
import type { GateContext } from '../context';
import type { GateProblem } from '../types';
import { type GateRun, gateResult } from './types';

/** What to do about each kind of rule-check problem. */
function fixFor(problem: CheckProblem): string {
  switch (problem.kind) {
    case 'dangling':
      // A decision whose rule is gone is refreshed; an exception whose node is gone is dropped.
      return problem.message.includes('不存在的节点')
        ? '用 exception.remove 删掉指向不存在节点的例外'
        : '提交 { "op": "rule.recompute" } 按现行规则刷新决定';
    case 'missing':
    case 'stale':
    case 'extra':
      return '提交 { "op": "rule.recompute" } 按现行规则刷新决定';
    case 'undecided':
      return '用 rule.propose 加一条适用的规则，或用 exception.add 给这个节点写例外';
    case 'ambiguous':
      return '改其中一条规则的条件，让它们的具体程度不同；或用 exception.add 给受影响的节点写例外';
    case 'cluster':
      return '统一同一相似簇里节点的类型和角色，或把偏离的节点拆出这个簇';
    case 'no-reason':
      return '补上理由（because）';
    case 'invalid':
      return '改成这个决策点允许的取值';
    case 'inapplicable':
    case 'regression':
      return '检查这条规则的样例：改规则的条件，或把不再适用的样例删掉';
    default:
      return '按提示修正后重新运行 ui-pro verify';
  }
}

/**
 * 规则一致: the project's rule checks, narrowed to this screen. The checks run over the whole
 * project; a problem with another screen is that screen's to fix. A check that is not
 * implemented yet (the no-drift check waits on built assets) is a warning, not a pass or a fail.
 */
export async function runRulesGate(ctx: GateContext): Promise<GateRun> {
  const report = checkRules(readRuleInputs(ctx.project));
  const problems: GateProblem[] = [];
  const warnings: string[] = [];
  let checked = 0;
  let failed = 0;
  for (const item of report.items) {
    if (item.status === 'skipped') {
      warnings.push(`检查「${item.name}」没有运行：${item.reason ?? '未实现'}`);
      continue;
    }
    checked++;
    const mine = item.problems.filter(
      (problem) => problem.screen === undefined || problem.screen === ctx.screen,
    );
    if (mine.length > 0) failed++;
    for (const problem of mine) {
      problems.push({
        ...(problem.node !== undefined ? { node: problem.node } : {}),
        message: `${item.name}：${problem.message}`,
        fix: fixFor(problem),
      });
    }
    for (const warning of item.warnings) warnings.push(`${item.name}：${warning}`);
  }
  return {
    result: gateResult('rules', {
      metrics: { checks: checked, failed },
      problems,
      warnings,
    }),
  };
}
