import { intersectRect, type Primitive, preOrder, type Rect } from '@ui-pro/core';
import { layoutScreen, type Viewport } from '@ui-pro/renderer';
import type { GateContext } from '../context';
import { encodePng, outlineBoxes, type PixelBox, pixelBox } from '../raster';
import type { GateProblem } from '../types';
import { type GateRun, gateResult, listNodes } from './types';
import { viewportMatrix } from './viewports';

/**
 * A node counts as out of bounds when it overhangs the viewport by more than this many design
 * pixels more than it does in the design (rounding in the anchors never gets near it).
 */
export const OUT_OF_BOUNDS_TOLERANCE = 2;

/** Two nodes newly overlap when the shared area exceeds this many square design pixels... */
export const OVERLAP_MIN_AREA = 4;

/** ...and this share of the smaller node's area. */
export const OVERLAP_MIN_SHARE = 0.02;

/** Frames of adaptation problems are drawn on this ground. */
const FRAME_GROUND = '#2b2b2b';

/** Most nodes listed in one message. */
const LISTED = 6;

const INTERACTIVE: ReadonlySet<Primitive> = new Set([
  'button',
  'toggle',
  'toggle-group',
  'slider',
  'input',
  'scroll',
  'list',
]);

/** Parents whose children may lie beyond the viewport on purpose (they scroll or are cut off). */
const CLIPPING: ReadonlySet<Primitive> = new Set(['scroll', 'list', 'mask']);

/** How far the rectangle reaches past the viewport; 0 when it lies inside. */
function overhang(rect: Rect, viewport: Viewport): number {
  return Math.max(
    0,
    -rect[0],
    -rect[1],
    rect[0] + rect[2] - viewport.width,
    rect[1] + rect[3] - viewport.height,
  );
}

const area = (rect: Rect): number => rect[2] * rect[3];

function overlapArea(a: Rect, b: Rect): number {
  const shared = intersectRect(a, b);
  return shared ? area(shared) : 0;
}

/**
 * 适配: lays the screen out in the viewport matrix (spec 12) using geometry only and compares each
 * with the design size. A node that newly leaves the viewport, or two interactive or text nodes
 * that newly overlap, fail the gate: the anchors are wrong. Interactive elements and text in a
 * notch or home-bar safe area are only warnings in M1 (the export has no safe-area container).
 * A picture of the viewport is rendered only for a viewport with a problem.
 */
export async function runAdaptationGate(ctx: GateContext): Promise<GateRun> {
  const { doc } = ctx;
  const design: Viewport = { width: doc.size[0], height: doc.size[1] };
  const base = layoutScreen(doc, design);
  const cases = viewportMatrix(doc.size);

  const ids = preOrder(doc).filter((id) => id !== doc.root && ctx.shown(id));
  const clipped = (id: string): boolean => {
    for (let parent = doc.nodes[id]?.parent; parent; parent = doc.nodes[parent]?.parent) {
      if (CLIPPING.has(doc.nodes[parent]?.type as Primitive)) return true;
    }
    return false;
  };
  const drawn = ids.filter((id) => {
    const kind = ctx.ownership.get(id)?.kind;
    return (kind === 'asset' || kind === 'text') && !clipped(id);
  });
  const touchable = ids.filter((id) => {
    const node = doc.nodes[id];
    return (
      node !== undefined && (node.type === 'text' || INTERACTIVE.has(node.type)) && !clipped(id)
    );
  });
  const ancestry = (a: string, b: string): boolean => {
    const chain = (from: string) => {
      const found = new Set<string>();
      for (let parent = doc.nodes[from]?.parent; parent; parent = doc.nodes[parent]?.parent) {
        found.add(parent);
      }
      return found;
    };
    return chain(a).has(b) || chain(b).has(a);
  };

  // Overlaps at the design size, to tell new ones from the design's own.
  const overlapsAtDesign = new Set<string>();
  const pairs: [string, string][] = [];
  for (let i = 0; i < touchable.length; i++) {
    for (let j = i + 1; j < touchable.length; j++) {
      const a = touchable[i] as string;
      const b = touchable[j] as string;
      if (ancestry(a, b)) continue;
      pairs.push([a, b]);
      const ra = base.get(a);
      const rb = base.get(b);
      if (ra && rb && overlapArea(ra, rb) > 0) overlapsAtDesign.add(`${a}|${b}`);
    }
  }

  const problems: GateProblem[] = [];
  const warnings: string[] = [];
  const views: string[] = [];
  let outOfBounds = 0;
  let overlaps = 0;

  for (const { label, viewport } of cases) {
    const laid = layoutScreen(doc, viewport);
    const flagged: string[] = [];

    const leaving = drawn.filter((id) => {
      const now = laid.get(id);
      const before = base.get(id);
      return (
        now &&
        before &&
        overhang(now, viewport) > overhang(before, design) + OUT_OF_BOUNDS_TOLERANCE
      );
    });
    outOfBounds += leaving.length;
    if (leaving.length > 0) {
      flagged.push(...leaving);
      problems.push({
        node: leaving[0] as string,
        message: `视口 ${label}（${viewport.width}×${viewport.height}）里 ${leaving.length} 个节点越出画面：${listNodes(leaving, LISTED)}`,
        fix: `检查这些节点的锚定（layout.anchor）：贴边的元素应该锚到它贴着的那一边`,
        metrics: { count: leaving.length },
      });
    }

    const colliding: [string, string][] = [];
    for (const [a, b] of pairs) {
      if (overlapsAtDesign.has(`${a}|${b}`)) continue;
      const ra = laid.get(a);
      const rb = laid.get(b);
      if (!ra || !rb) continue;
      const shared = overlapArea(ra, rb);
      if (shared > Math.max(OVERLAP_MIN_AREA, OVERLAP_MIN_SHARE * Math.min(area(ra), area(rb)))) {
        colliding.push([a, b]);
      }
    }
    overlaps += colliding.length;
    if (colliding.length > 0) {
      for (const [a, b] of colliding) flagged.push(a, b);
      const named = colliding.slice(0, LISTED).map(([a, b]) => `#${a} 与 #${b}`);
      problems.push({
        node: colliding[0]?.[0] as string,
        message: `视口 ${label}（${viewport.width}×${viewport.height}）里 ${colliding.length} 对可交互或文字节点新出现重叠：${named.join('、')}${colliding.length > LISTED ? ' 等' : ''}`,
        fix: '检查这些节点的锚定（layout.anchor）：设计尺寸下分开的两个元素，应该各自锚到自己靠近的那一边',
        metrics: { count: colliding.length },
      });
    }

    if (viewport.safeArea) {
      const [left, top, right, bottom] = viewport.safeArea;
      const zones: Rect[] = (
        [
          [0, 0, viewport.width, top],
          [0, viewport.height - bottom, viewport.width, bottom],
          [0, 0, left, viewport.height],
          [viewport.width - right, 0, right, viewport.height],
        ] satisfies Rect[]
      ).filter(([, , w, h]) => w > 0 && h > 0);
      const inside = touchable.filter((id) => {
        const rect = laid.get(id);
        return rect !== undefined && zones.some((zone) => overlapArea(rect, zone) > 0);
      });
      if (inside.length > 0) {
        warnings.push(
          `视口 ${label} 的安全区里有 ${inside.length} 个可交互元素或文字：${listNodes(inside, LISTED)}（M1 的导出还没有安全区容器，只提示）`,
        );
      }
    }

    if (flagged.length > 0) {
      const session = await ctx.session();
      const frame = await session.render({ viewport, background: FRAME_GROUND });
      const scale = frame.width / frame.list.width;
      const boxes: PixelBox[] = [];
      for (const id of new Set(flagged)) {
        const rect = laid.get(id);
        const box = rect && pixelBox(rect, scale, frame.width, frame.height);
        if (box) boxes.push(box);
      }
      const marked = await outlineBoxes(
        { width: frame.width, height: frame.height, data: frame.data },
        boxes,
      );
      const view = await ctx.writeView(
        `adaptation-${label.replace(/[:.]/g, '_')}.png`,
        await encodePng(marked),
      );
      views.push(view);
      for (const problem of problems) {
        if (problem.message.startsWith(`视口 ${label}（`)) problem.view = view;
      }
    }
  }

  return {
    result: gateResult('adaptation', {
      metrics: { viewports: cases.length, outOfBounds, overlaps },
      problems,
      warnings,
      views,
    }),
  };
}
