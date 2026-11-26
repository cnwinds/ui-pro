import type { AskQuestion } from '@ui-pro/core';

export interface BuildOptions {
  /** Compute everything and report it, but write nothing. */
  dryRun?: boolean;
  /** `draft` stays local; `final` (default when a cloud image model is configured) refines with it. */
  quality?: 'draft' | 'final';
  /** Never call a perception model: every model output must already be locked. */
  locked?: boolean;
  /** Selector of nodes whose locked model outputs are discarded and made again. */
  regenerate?: string;
  onProgress?: (message: string) => void;
}

export interface BuildApproximation {
  node: string;
  /** In Simplified Chinese; the export report lists these. */
  message: string;
}

export interface BuildReport {
  screen: string;
  /** History version written; absent for dry runs and builds that change nothing. */
  version?: number;
  assets: number;
  /** Model outputs taken from the lock instead of running the model. */
  reused: number;
  /** Model runs this build made. */
  generated: { local: number; cloud: number };
  approximations: BuildApproximation[];
  warnings: string[];
  ask: AskQuestion[];
  /** Absolute paths of images worth looking at: the asset sheet and the recomposition. */
  views: string[];
}
