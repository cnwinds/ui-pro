import type { PsdIssue } from './compliance';
import { layerPath, type PsdLayer } from './model';
import { MAX_UNEXPLAINED_RATIO, PIXEL_TOLERANCE, type Verification } from './verify';

export type InputGrade = 'A' | 'B' | 'C';

const RESTORE_FIX =
  '程序侧渲染器（Photopea）对这个图层的样式或混合模式的实现与 Photoshop 不同。建议把这个图层的图层样式栅格化进图层；由 Photoshop 自己渲染的交付包暂未支持';

/**
 * C when a "must" item of the delivery spec fails, B when the file complies but some layer's
 * render does not match the composite, A otherwise. `null` when the render check was not run, so
 * a compliant file cannot be called A yet.
 */
export function gradeOf(issues: readonly PsdIssue[], verified: boolean): InputGrade | null {
  if (issues.some((issue) => issue.severity === 'must')) return 'C';
  if (issues.some((issue) => issue.category === 'restore')) return 'B';
  return verified ? 'A' : null;
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(ratio < 0.001 ? 2 : 1)}%`;
}

/** The "还原" findings: layers whose render does not reproduce the composite. */
export function restoreIssues(
  verification: Verification,
  layers: ReadonlyMap<number, PsdLayer>,
  ignored: ReadonlySet<number>,
): PsdIssue[] {
  const issues: PsdIssue[] = [];
  for (const check of verification.checks) {
    const layer = layers.get(check.id);
    if (check.pass || layer === undefined || ignored.has(check.id)) continue;
    issues.push({
      severity: 'should',
      category: 'restore',
      code: 'restore-mismatch',
      layer: layerPath(layer),
      layerId: layer.id,
      message: `图层「${layerPath(layer)}」按顺序合成后与合成图有出入：${percent(check.diffRatio)} 的像素差异超过 ${PIXEL_TOLERANCE}/255，最大差值 ${check.maxDelta}`,
      fix: RESTORE_FIX,
    });
  }
  const { unexplained } = verification;
  if (!unexplained.pass) {
    issues.push({
      severity: 'should',
      category: 'restore',
      code: 'restore-unexplained',
      message: `合成图里有 ${unexplained.pixels} 个像素（${percent(unexplained.ratio)}，超过 ${percent(MAX_UNEXPLAINED_RATIO)}）不是任何图层渲染出来的，最大差值 ${unexplained.maxDelta}`,
      fix: '检查是否有渲染器不支持的图层类型（例如调整图层），或者盖住整个界面的效果，把它们栅格化；由 Photoshop 自己渲染的交付包暂未支持',
    });
  }
  return issues;
}

const SEVERITY_LABEL = { must: '必须', should: '建议' } as const;

/** One line per issue for the error `details` and plain-text output. */
export function fixListLines(issues: readonly PsdIssue[]): string[] {
  return issues.map((issue) => {
    const where = issue.layer === undefined ? '' : `${issue.layer}：`;
    return `【${SEVERITY_LABEL[issue.severity]}】${where}${issue.message}。改法：${issue.fix}`;
  });
}

const GRADE_TEXT: Record<InputGrade | 'unknown', string> = {
  A: 'A（合规，逐图层核对全部通过）',
  B: 'B（合规，但有图层核对不通过；默认只接受 A）',
  C: 'C（不合规，有必须修改的项；默认只接受 A）',
  unknown: '待定（文件结构合规，但还原核对没有做）',
};

export interface ChecklistInput {
  /** What the checklist is about, usually the file name. */
  label: string;
  grade: InputGrade | null;
  canvas: { width: number; height: number };
  issues: readonly PsdIssue[];
  unchecked: readonly string[];
  /** Why the render check was skipped; absent when it ran. */
  restoreSkipped?: string;
}

function section(title: string, issues: readonly PsdIssue[]): string[] {
  if (issues.length === 0) return [];
  const lines = [`## ${title}（${issues.length} 项）`, ''];
  issues.forEach((issue, index) => {
    const where = issue.layer === undefined ? '整个文件' : `\`${issue.layer}\``;
    lines.push(`${index + 1}. **${where}**：${issue.message}`, `   - 改法：${issue.fix}`);
  });
  lines.push('');
  return lines;
}

/** The change list for the artist, as Markdown. */
export function renderChecklist(input: ChecklistInput): string {
  const { issues } = input;
  const lines = [
    `# PSD 修改清单：${input.label}`,
    '',
    `- 输入等级：${GRADE_TEXT[input.grade ?? 'unknown']}`,
    `- 画布：${input.canvas.width}×${input.canvas.height}`,
    `- 问题：必须 ${issues.filter((i) => i.severity === 'must').length} 项，建议 ${issues.filter((i) => i.severity === 'should').length} 项`,
    '',
  ];
  if (issues.length === 0) lines.push('没有发现需要修改的地方。', '');
  lines.push(
    ...section(
      '必须修改',
      issues.filter((issue) => issue.severity === 'must'),
    ),
    ...section(
      '建议修改',
      issues.filter((issue) => issue.severity === 'should' && issue.category !== 'restore'),
    ),
    ...section(
      '还原核对不通过',
      issues.filter((issue) => issue.category === 'restore'),
    ),
  );
  const notes = [
    ...input.unchecked,
    ...(input.restoreSkipped === undefined ? [] : [`还原：没有核对（${input.restoreSkipped}）`]),
  ];
  if (notes.length > 0)
    lines.push('## 本次没有检查的项', '', ...notes.map((note) => `- ${note}`), '');
  return lines.join('\n');
}
