import { screenRelDir } from '../paths';
import type { ScreenDoc } from '../schema/screen';
import type { AskQuestion } from '../tx/types';

/** Evidence file holding a PSD's embedded composite, written by PSD analysis. */
export const COMPOSITE_EVIDENCE = 'composite.png';

/**
 * Project-relative path of the screen's reference image (基准图), the image every fidelity
 * measurement compares against: the flat image itself, or the composite PSD analysis extracts.
 */
export function referenceImagePath(screen: ScreenDoc): string {
  const dir = screenRelDir(screen.name);
  return screen.source.kind === 'flat'
    ? `${dir}/${screen.source.file}`
    : `${dir}/evidence/${COMPOSITE_EVIDENCE}`;
}

export interface AnalyzeOptions {
  /** Accept PSD input below grade A; affected layers are handled as flat pixels. */
  allowDegraded?: boolean;
  /** Compute everything and report it, but write nothing. */
  dryRun?: boolean;
}

/** What one `ui-pro analyze` run found and wrote, whatever the source kind. */
export interface AnalysisReport {
  screen: string;
  kind: ScreenDoc['source']['kind'];
  /** PSD input grade; absent for flat images. */
  grade?: 'A' | 'B' | 'C';
  precheck: {
    /** Factor from source pixels to design pixels; above 1 means the source must be upscaled. */
    upscale: number;
    /** Risks to tell the user about, in Simplified Chinese. */
    risks: string[];
  };
  candidates: number;
  clusters: number;
  /** Nodes in the draft, root excluded. */
  nodes: number;
  /** History version written; absent for dry runs. */
  version?: number;
  warnings: string[];
  ask: AskQuestion[];
  /** Absolute paths of images worth looking at next. */
  views: string[];
}
