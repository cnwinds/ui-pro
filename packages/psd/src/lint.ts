import { type Project, scratchPath, writeFileAtomic } from '@ui-pro/core';
import type { PsdIssue } from './compliance';
import { inspectPsd } from './inspect';
import { walkLayers } from './model';
import type { RenderStats } from './renderer';
import { type InputGrade, renderChecklist } from './report';

export interface LintOptions {
  /** Gives the design resolution and the prefix table; without it neither is checked. */
  project?: Project;
  /** Directory whose `.ui-pro/` receives the checklist and the render cache. */
  scratchRoot: string;
  /** Name of the file, used in the checklist's title and file name. */
  label: string;
  /** Render every layer and compare with the composite; on by default. */
  render?: boolean;
}

export interface PsdLintResult {
  /** `null` when the render check was not made and the file has no "must" problem. */
  grade: InputGrade | null;
  canvas: { width: number; height: number };
  layers: number;
  issues: PsdIssue[];
  unchecked: string[];
  restore: {
    /** Layers compared with the composite. */
    checked: number;
    failed: number;
    /** Why the comparison was not made; absent when it was. */
    skipped?: string;
    renderer?: string;
    stats?: RenderStats;
    fromCache?: number;
  };
  /** Absolute path of the Markdown checklist. */
  checklistPath: string;
  checklist: string;
}

const safeName = (label: string): string =>
  label.replace(/\.[^.]*$/, '').replace(/[^\w-]+/g, '_') || 'psd';

/**
 * Checks a PSD against the delivery spec (appendix C) and writes the artist's change list to
 * `.ui-pro/psd-lint/`. A file that fails the check is a result, not an error.
 */
export async function lintPsd(bytes: Uint8Array, options: LintOptions): Promise<PsdLintResult> {
  const render = options.render ?? true;
  const inspection = await inspectPsd(bytes, {
    project: options.project,
    scratchRoot: options.scratchRoot,
    render,
    onRendererUnavailable: 'skip',
    cacheWrite: true,
    stopOnMust: false,
  });
  const { document, issues, grade, rendered } = inspection;
  const verification = rendered?.verification;
  const canvas = { width: document.width, height: document.height };

  const checklist = renderChecklist({
    label: options.label,
    grade,
    canvas,
    issues,
    unchecked: inspection.unchecked,
    ...(inspection.restoreSkipped === undefined
      ? {}
      : { restoreSkipped: inspection.restoreSkipped }),
  });
  const checklistPath = scratchPath(
    options.scratchRoot,
    'psd-lint',
    `${safeName(options.label)}.md`,
  );
  await writeFileAtomic(checklistPath, checklist);

  return {
    grade,
    canvas,
    layers: [...walkLayers(document.layers)].length,
    issues,
    unchecked: inspection.unchecked,
    restore: {
      checked: verification?.checks.length ?? 0,
      failed: verification?.checks.filter((check) => !check.pass).length ?? 0,
      ...(inspection.restoreSkipped === undefined ? {} : { skipped: inspection.restoreSkipped }),
      ...(rendered === undefined
        ? {}
        : {
            renderer: rendered.renderer,
            fromCache: rendered.outcome.cached,
            ...(rendered.outcome.stats === undefined ? {} : { stats: rendered.outcome.stats }),
          }),
    },
    checklistPath,
    checklist,
  };
}
