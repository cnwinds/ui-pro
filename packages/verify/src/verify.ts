import { type AskQuestion, type Project, readAssetManifest, UiProError } from '@ui-pro/core';
import { createContext, type GateContext } from './context';
import { VerifyErrorCodes } from './errors';
import { runAdaptationGate } from './gates/adaptation';
import { runBudgetGate } from './gates/budget';
import { runEngineGate } from './gates/engine';
import { runFidelityGate } from './gates/fidelity';
import { runHideGate } from './gates/hide';
import { runResourcesGate } from './gates/resources';
import { runRulesGate } from './gates/rules';
import { runStandaloneGate } from './gates/standalone';
import { runStructureGate } from './gates/structure';
import { runTextGate } from './gates/text';
import type { GateRun } from './gates/types';
import { verifyInputsSha256, writeVerifyStamp } from './stamp';
import {
  GATE_IDS,
  type GateId,
  type GateResult,
  type VerifyOptions,
  type VerifyReport,
} from './types';

const RUNNERS: Record<Exclude<GateId, 'engine'>, (ctx: GateContext) => Promise<GateRun>> = {
  fidelity: runFidelityGate,
  standalone: runStandaloneGate,
  hide: runHideGate,
  rules: runRulesGate,
  structure: runStructureGate,
  resources: runResourcesGate,
  adaptation: runAdaptationGate,
  text: runTextGate,
  budget: runBudgetGate,
};

/** The gates a run executes, in `GATE_IDS` order. The engine gate only when asked for. */
function selectGates(options: VerifyOptions): GateId[] {
  const named = options.gates ? new Set<GateId>(options.gates) : undefined;
  return GATE_IDS.filter((id) => {
    if (id === 'engine') return options.engine === true || named?.has('engine') === true;
    return named ? named.has(id) : true;
  });
}

/**
 * Runs the quality gates of DESIGN §13.1 on a built screen. Without `options.gates`, a run of all
 * the non-engine gates is stamped (`.ui-pro/verify/<screen>.json`) for `export`; a partial run
 * is not. Every run writes the full report to `.ui-pro/verify/<screen>/report.json`. A gate that
 * fails is a result, not an error; only a screen that cannot be checked (not built, no reference
 * image) throws.
 */
export async function verifyScreen(
  project: Project,
  screen: string,
  options: VerifyOptions = {},
): Promise<VerifyReport> {
  const manifest = readAssetManifest(project, screen);
  if (manifest === null) {
    throw new UiProError(VerifyErrorCodes.notBuilt, `界面 ${screen} 还没有构建过资产，没法检查`, {
      hint: '先运行 ui-pro build',
    });
  }
  const inputsSha256 = verifyInputsSha256(project, screen);
  const ctx = createContext(project, screen, manifest);
  const gates: GateResult[] = [];
  const ask: AskQuestion[] = [];
  try {
    for (const id of selectGates(options)) {
      if (id === 'engine') {
        gates.push(await runEngineGate(project, screen, await ctx.session()));
        continue;
      }
      const run = await RUNNERS[id](ctx);
      gates.push(run.result);
      for (const question of run.ask ?? []) {
        if (!ask.some((known) => known.id === question.id)) ask.push(question);
      }
    }
  } finally {
    await ctx.dispose();
  }

  const failed = gates.filter((gate) => gate.status === 'fail').map((gate) => gate.id);
  const report: VerifyReport = {
    screen,
    ok: failed.length === 0,
    inputsSha256,
    gates,
    ask,
    views: [...new Set(gates.flatMap((gate) => gate.views))],
  };
  await ctx.writeView('report.json', Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8'));
  if (options.gates === undefined) {
    writeVerifyStamp(project, screen, {
      inputsSha256,
      ok: report.ok,
      at: new Date().toISOString(),
      failed,
    });
  }
  return report;
}
