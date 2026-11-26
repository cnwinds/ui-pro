import type { AskQuestion } from '@ui-pro/core';

/** DESIGN §13.1, in the order `ui-pro verify` runs them. `engine` runs only when asked. */
export const GATE_IDS = [
  'fidelity',
  'standalone',
  'hide',
  'rules',
  'structure',
  'resources',
  'adaptation',
  'text',
  'budget',
  'engine',
] as const;
export type GateId = (typeof GATE_IDS)[number];

/** Gate names as DESIGN §13.1 lists them, for summaries. */
export const GATE_NAMES: Readonly<Record<GateId, string>> = {
  fidelity: '重组保真',
  standalone: '独立可用',
  hide: '显隐测试',
  rules: '规则一致',
  structure: '结构',
  resources: '资源',
  adaptation: '适配',
  text: '文本',
  budget: '性能预算',
  engine: '引擎一致',
};

export interface GateProblem {
  node?: string;
  /** What is wrong, in Simplified Chinese. */
  message: string;
  /** What to do about it: a command, an op, or a question for the user. */
  fix?: string;
  metrics?: Record<string, number>;
  /** Absolute path of an image showing the problem. */
  view?: string;
}

export interface GateResult {
  id: GateId;
  name: string;
  status: 'pass' | 'fail' | 'skipped';
  /** Why the gate was skipped. */
  reason?: string;
  /** Headline numbers, e.g. `{ ssim: 0.991, deltaE: 1.8 }`. */
  metrics: Record<string, number>;
  problems: GateProblem[];
  /** Worth knowing; does not fail the gate. */
  warnings: string[];
  views: string[];
}

export interface VerifyReport {
  screen: string;
  /** Every gate that ran passed. */
  ok: boolean;
  /** Hash of what was verified; `export` compares it with the current one. */
  inputsSha256: string;
  gates: GateResult[];
  /** Questions for the user, e.g. confirming a large generated area. */
  ask: AskQuestion[];
  views: string[];
}

export interface VerifyOptions {
  /** Run only these gates; all non-engine gates by default. */
  gates?: readonly GateId[];
  /** Also run the engine gate (needs Godot). */
  engine?: boolean;
}

/** Written by every `verify` run to `.ui-pro/verify/<screen>.json`; `export` reads it. */
export interface VerifyStamp {
  inputsSha256: string;
  ok: boolean;
  /** ISO 8601. */
  at: string;
  failed: GateId[];
}
