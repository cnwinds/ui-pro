import type { AskQuestion } from '@ui-pro/core';
import { GATE_NAMES, type GateId, type GateResult } from '../types';

/** What one gate hands back: its result, and questions for the user that do not fail it. */
export interface GateRun {
  result: GateResult;
  ask?: AskQuestion[];
}

export type GateFields = Partial<Omit<GateResult, 'id' | 'name'>>;

/** A gate result with the defaults filled in: passes unless it has problems. */
export function gateResult(id: GateId, fields: GateFields = {}): GateResult {
  const problems = fields.problems ?? [];
  const result: GateResult = {
    id,
    name: GATE_NAMES[id],
    status: fields.status ?? (problems.length > 0 ? 'fail' : 'pass'),
    metrics: fields.metrics ?? {},
    problems,
    warnings: fields.warnings ?? [],
    views: fields.views ?? [],
  };
  if (fields.reason !== undefined) result.reason = fields.reason;
  return result;
}

/** Rounds a metric for the report. */
export const round = (value: number, digits = 3): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** `#a、#b、#c 等 n 个`: node ids for a sentence. */
export function listNodes(ids: readonly string[], limit = 6): string {
  const shown = ids.slice(0, limit).map((id) => `#${id}`);
  return ids.length > limit ? `${shown.join('、')} 等 ${ids.length} 个` : shown.join('、');
}
