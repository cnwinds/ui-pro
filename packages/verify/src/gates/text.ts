import { ancestorsOf, intersectRect, preOrder, type Rect } from '@ui-pro/core';
import { lookupPath, type RenderResult, type TextOp } from '@ui-pro/renderer';
import type { GateContext } from '../context';
import { pixelBox, type Raster } from '../raster';
import type { GateProblem } from '../types';
import { compareSheet } from '../views';
import { type GateRun, gateResult, listNodes, round } from './types';

/** Pseudo-localization: the text gets this much longer (German and Russian run 30–40% longer). */
export const LENGTHEN_RATIO = 0.4;

/** What is added to a lengthened text: wide full-width characters, cycled, as pseudo-localization does. */
export const FILLER = 'ＷｉＭｍ';

/** A value shows at least this many digits at the extreme (9,999,999). */
export const EXTREME_DIGITS = 7;

/** A short number without separators (a level, a count) goes to this many digits (Lv.999). */
export const SHORT_NUMBER_DIGITS = 3;

/** Width beyond the box up to this many design pixels is rounding, not overflow. */
export const OVERFLOW_TOLERANCE = 1;

/** Most pictures of failures in a report. */
const MAX_VIEWS = 6;

/** Design pixels shown round a text in a picture. */
const VIEW_MARGIN = 24;

type Variant = 'lengthened' | 'extreme';

const VARIANT_NAMES: Record<Variant, string> = { lengthened: '加长文案', extreme: '极值' };

const rasterOf = (frame: RenderResult): Raster => ({
  width: frame.width,
  height: frame.height,
  data: frame.data,
});

/** `Lv.5` -> `Lv.999`, `1,234` -> `9,999,999`: digit runs grow to their extreme, separators stay. */
export function extremeOf(content: string): string | undefined {
  let changed = false;
  const result = content.replace(/\d[\d,]*\d|\d/g, (token) => {
    const digits = token.replaceAll(',', '').length;
    const grouped = token.includes(',');
    const target = grouped
      ? Math.max(EXTREME_DIGITS, digits)
      : digits <= SHORT_NUMBER_DIGITS
        ? SHORT_NUMBER_DIGITS
        : Math.max(EXTREME_DIGITS, digits);
    changed = true;
    const nines = '9'.repeat(target);
    return grouped ? nines.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : nines;
  });
  return changed ? result : undefined;
}

/** The text plus 40% filler (at least one character). */
export function lengthenedOf(content: string): string {
  const extra = Math.max(1, Math.ceil([...content].length * LENGTHEN_RATIO));
  let filler = '';
  for (let i = 0; i < extra; i++) filler += [...FILLER][i % [...FILLER].length];
  return content + filler;
}

/** Where the text's line lies, given its width and alignment inside the box. */
function extentOf(op: TextOp, width: number): [number, number] {
  const [x, , w] = op.box;
  if (op.align.h === 'left') return [x, x + width];
  if (op.align.h === 'right') return [x + w - width, x + w];
  const middle = x + w / 2;
  return [middle - width / 2, middle + width / 2];
}

/**
 * 文本: every dynamic text is measured with a pseudo-localized longer text and, for a value
 * (`kind: value`, or bound to a number), with its extreme digits. Only the width is checked: the
 * renderer draws one line. Overflow that reaches another visible node, or the edge of the screen,
 * fails; overflow into blank space only warns. The replacement goes in through `RenderOptions.text`;
 * the screen is not touched.
 */
export async function runTextGate(ctx: GateContext): Promise<GateRun> {
  const session = await ctx.session();
  const baseline = await ctx.baseline();
  const { doc } = ctx;
  const mock = ctx.mock();
  const scale = baseline.width / baseline.list.width;
  const problems: GateProblem[] = [];
  const blank: Record<Variant, string[]> = { lengthened: [], extreme: [] };
  const views: string[] = [];
  let measured = 0;
  let failed = 0;

  const textOps = baseline.list.ops.filter((op): op is TextOp => op.kind === 'text');
  const order = preOrder(doc);
  const solid = order.filter((id) => {
    const kind = ctx.ownership.get(id)?.kind;
    return ctx.shown(id) && (kind === 'asset' || kind === 'text');
  });

  for (const op of textOps) {
    const node = doc.nodes[op.node];
    if (!node || op.content === '') continue;
    const numeric =
      node.text?.kind === 'value' ||
      Object.values(node.bind ?? {}).some((binding) => {
        const value = lookupPath(mock, binding.path);
        return typeof value === 'number' || (typeof value === 'string' && /^[\d,.]+$/.test(value));
      });
    const variants: [Variant, string][] = [];
    if (numeric) {
      const extreme = extremeOf(op.content);
      if (extreme !== undefined) variants.push(['extreme', extreme]);
    } else {
      variants.push(['lengthened', lengthenedOf(op.content)]);
    }

    const ancestors = new Set(ancestorsOf(doc, op.node));
    for (const [variant, content] of variants) {
      measured++;
      const width = session.measureText(op.font, content);
      const [x0, x1] = extentOf(op, width);
      const [bx, by, bw, bh] = op.box;
      const over = Math.max(0, width - bw);
      if (over <= OVERFLOW_TOLERANCE) continue;

      // The part of the line outside the box, as rectangles, and what it lands on.
      const spill: Rect[] = [];
      if (x0 < bx) spill.push([x0, by, bx - x0, bh]);
      if (x1 > bx + bw) spill.push([bx + bw, by, x1 - bx - bw, bh]);
      const hit = new Set<string>();
      for (const id of solid) {
        if (id === op.node || ancestors.has(id)) continue;
        const rect = baseline.rects.get(id);
        if (!rect || !spill.some((part) => intersectRect(part, rect))) continue;
        // A node that holds the box (a plate, a panel) is where the text lives, not an obstacle.
        const holdsBox =
          rect[0] <= bx &&
          rect[1] <= by &&
          rect[0] + rect[2] >= bx + bw &&
          rect[1] + rect[3] >= by + bh;
        if (!holdsBox && !intersectRect(rect, op.box)) hit.add(id);
      }
      const offscreen = x0 < 0 || x1 > baseline.list.width;

      if (hit.size === 0 && !offscreen) {
        blank[variant].push(op.node);
        continue;
      }
      failed++;
      const where = [
        ...(hit.size > 0 ? [`压到了 ${listNodes([...hit], 4)}`] : []),
        ...(offscreen ? ['超出了画面'] : []),
      ].join('，');
      let view: string | undefined;
      const left = Math.min(x0, bx);
      const area = pixelBox(
        [
          left - VIEW_MARGIN,
          by - VIEW_MARGIN,
          Math.max(x1, bx + bw) - left + 2 * VIEW_MARGIN,
          bh + 2 * VIEW_MARGIN,
        ],
        scale,
        baseline.width,
        baseline.height,
      );
      if (views.length < MAX_VIEWS && area) {
        const frame = await session.render({ text: { [op.node]: content } });
        view = await ctx.writeView(
          `text-${op.node}-${variant}.png`,
          compareSheet(area, [
            { label: '正常文案', raster: rasterOf(baseline) },
            { label: `${VARIANT_NAMES[variant]}：${content}`, raster: rasterOf(frame) },
          ]),
        );
        views.push(view);
      }
      problems.push({
        node: op.node,
        message: `节点 #${op.node} 的文字在${VARIANT_NAMES[variant]}（${content}）下宽 ${round(width, 0)}，比文字框（宽 ${round(bw, 0)}）宽出 ${round(over, 0)}，${where}`,
        fix: `加宽 #${op.node} 的文字框，或缩小字号（text.size），或让文字框周围留出空间`,
        metrics: { width: round(width, 1), box: round(bw, 1), over: round(over, 1) },
        ...(view ? { view } : {}),
      });
    }
  }

  const warnings: string[] = [];
  for (const variant of ['lengthened', 'extreme'] as const) {
    const ids = blank[variant];
    if (ids.length > 0) {
      warnings.push(
        `${ids.length} 个文字在${VARIANT_NAMES[variant]}下比文字框宽，但溢出的是空白处：${listNodes(ids, 6)}`,
      );
    }
  }

  return {
    result: gateResult('text', {
      metrics: { texts: textOps.length, measured, failed },
      problems,
      warnings,
      views,
    }),
  };
}
