import { type Project, scratchPath, UiProError } from '@ui-pro/core';
import { checkCompliance, type PsdIssue } from './compliance';
import { EmbeddedRenderer } from './embedded-renderer';
import { RENDERER_UNAVAILABLE_CODES } from './errors';
import type { RgbaImage } from './image';
import { layersById, type PsdDocument } from './model';
import { parsePsd } from './parse';
import { type PrefixTable, prefixTableFor } from './prefixes';
import { type RenderOutcome, renderUnits, type StoredRender } from './render-store';
import { type LayerRenderer, planRenderUnits, type RenderUnit } from './renderer';
import { assertEgressAllows, createRenderer } from './renderers';
import { gradeOf, type InputGrade, restoreIssues } from './report';
import { recompose, toImage, type Verification, verify } from './verify';

export interface InspectOptions {
  project?: Project;
  /** Directory whose `.ui-pro/` holds the render cache. */
  scratchRoot: string;
  render: boolean;
  /** What to do when the renderer cannot run. */
  onRendererUnavailable: 'skip' | 'fallback' | 'throw';
  /** Store new renders in the cache; off for dry runs. */
  cacheWrite: boolean;
  /** Skip rendering when the file already fails a "must" item: the grade is C either way. */
  stopOnMust: boolean;
}

export interface Rendered {
  units: RenderUnit[];
  stored: Map<number, StoredRender>;
  outcome: RenderOutcome;
  renderer: string;
  verification?: Verification;
}

export interface Inspection {
  document: PsdDocument;
  prefixes: PrefixTable;
  issues: PsdIssue[];
  unchecked: string[];
  /** `null` while the render check was not made. */
  grade: InputGrade | null;
  /** Why the render check was not made; absent when it was. */
  restoreSkipped?: string;
  rendered?: Rendered;
  /** The composite in the file, or the recomposition standing in for a missing one. */
  reference: RgbaImage | null;
}

const cacheDir = (root: string): string => scratchPath(root, 'psd-render');

async function renderWith(
  renderer: LayerRenderer,
  document: PsdDocument,
  units: RenderUnit[],
  options: InspectOptions,
): Promise<Rendered> {
  try {
    const outcome = await renderUnits({
      document,
      units,
      renderer,
      cache: { dir: cacheDir(options.scratchRoot), write: options.cacheWrite },
    });
    return { units, stored: outcome.stored, outcome, renderer: renderer.name };
  } finally {
    await renderer.close();
  }
}

function unavailable(error: unknown): error is UiProError {
  return error instanceof UiProError && RENDERER_UNAVAILABLE_CODES.has(error.code);
}

/**
 * Reads the file, checks it against the delivery spec and, unless told not to, renders every
 * layer and compares the recomposition with the composite. Shared by `analyze` and `psd lint`.
 */
export async function inspectPsd(bytes: Uint8Array, options: InspectOptions): Promise<Inspection> {
  const { project } = options;
  const document = parsePsd(bytes);
  const prefixes = prefixTableFor(project);
  const compliance = checkCompliance(document, prefixes, project?.config.design);
  const issues = [...compliance.issues];
  const result: Inspection = {
    document,
    prefixes,
    issues,
    unchecked: compliance.unchecked,
    grade: null,
    reference: document.composite,
  };
  const blocked = options.stopOnMust && issues.some((issue) => issue.severity === 'must');
  if (!options.render || blocked) {
    result.restoreSkipped = blocked
      ? '文件有必须修改的项，不必渲染就已经是 C'
      : '按要求没有渲染图层';
    result.grade = gradeOf(issues, false);
    return result;
  }

  const units = planRenderUnits(document);
  let rendered: Rendered | undefined;
  let embedded = false;
  try {
    const renderer = createRenderer({ project, scratchRoot: options.scratchRoot });
    assertEgressAllows(renderer, project);
    rendered = await renderWith(renderer, document, units, options);
  } catch (error) {
    if (!unavailable(error) || options.onRendererUnavailable === 'throw') throw error;
    result.restoreSkipped = `渲染器不可用：${error.message}`;
    if (options.onRendererUnavailable === 'fallback') {
      rendered = await renderWith(new EmbeddedRenderer(), document, units, options);
      embedded = true;
      result.restoreSkipped += '；改用文件自带的图层像素，没有逐图层核对';
    }
  }
  if (rendered === undefined) {
    result.grade = gradeOf(issues, false);
    return result;
  }

  result.rendered = rendered;
  const composition = await recompose(document.width, document.height, units, rendered.stored);
  if (document.composite === null) {
    result.reference = toImage(document.width, document.height, composition);
    result.restoreSkipped ??= '文件没有可用的合成图，没有基准可以对照';
  } else if (!embedded) {
    const verification = verify(document.composite, composition);
    rendered.verification = verification;
    const ignored = new Set(units.filter((unit) => unit.ignored).map((unit) => unit.id));
    issues.push(...restoreIssues(verification, layersById(document.layers), ignored));
  }
  result.grade = gradeOf(issues, rendered.verification !== undefined);
  return result;
}
