import { type Anchor, preOrder, type Rect, type ScreenDoc, type UINode } from '@ui-pro/core';
import type { Viewport } from './types';

/** `layout.anchor` values (the nine positions plus `stretch`) as a horizontal and vertical anchor. */
const POSITION_ANCHORS: Readonly<Record<string, Anchor>> = {
  'top-left': { h: 'left', v: 'top' },
  top: { h: 'center', v: 'top' },
  'top-right': { h: 'right', v: 'top' },
  left: { h: 'left', v: 'center' },
  center: { h: 'center', v: 'center' },
  right: { h: 'right', v: 'center' },
  'bottom-left': { h: 'left', v: 'bottom' },
  bottom: { h: 'center', v: 'bottom' },
  'bottom-right': { h: 'right', v: 'bottom' },
  stretch: { h: 'stretch', v: 'stretch' },
  fill: { h: 'stretch', v: 'stretch' },
};

const TOP_LEFT: Anchor = { h: 'left', v: 'top' };

/**
 * How a node holds on to its parent: the explicit `anchor`, else the `layout.anchor` decision,
 * else the top-left corner (what a node with neither would get from a plain offset).
 */
export function anchorOf(node: UINode): Anchor {
  if (node.anchor) return node.anchor;
  const decided = node.decisions['layout.anchor']?.value;
  return (decided === undefined ? undefined : POSITION_ANCHORS[decided]) ?? TOP_LEFT;
}

type Axis = Anchor['h'] | Anchor['v'];

/**
 * One axis of a child's layout. `start`/`size` are the child's design position and size;
 * `shift` and `grow` are how far the parent's start moved and how much its size changed against
 * its design rectangle. Written as deltas so that an unchanged parent gives the design values
 * back bit for bit.
 */
function place(mode: Axis, start: number, size: number, shift: number, grow: number) {
  switch (mode) {
    case 'right':
    case 'bottom':
      return { start: start + shift + grow, size };
    case 'center':
      return { start: start + shift + grow / 2, size };
    case 'stretch':
      return { start: start + shift, size: size + grow };
    default:
      return { start: start + shift, size };
  }
}

/**
 * Lays the screen out in `viewport`, every rectangle in design pixels. The root fills the
 * viewport; each other node keeps its distance to the parent's edges (`left`/`right`,
 * `top`/`bottom`), its offset from the parent's middle (`center`), or both distances with its size
 * following the parent (`stretch`). This is what Godot's anchors plus offsets do (anchor 0, 0.5, 1;
 * offsets measured at the design size). In a viewport equal to the screen's design size every
 * node's rectangle is its `rect`.
 */
export function layoutScreen(doc: ScreenDoc, viewport: Viewport): Map<string, Rect> {
  const result = new Map<string, Rect>();
  const root = doc.nodes[doc.root];
  if (!root) return result;

  const atDesign = viewport.width === doc.size[0] && viewport.height === doc.size[1];
  result.set(doc.root, atDesign ? [...root.rect] : [0, 0, viewport.width, viewport.height]);

  for (const id of preOrder(doc)) {
    if (id === doc.root) continue;
    const node = doc.nodes[id];
    const parent = node?.parent === null || !node ? undefined : doc.nodes[node.parent];
    const parentNow = parent && result.get(parent.id);
    if (!node || !parent || !parentNow) continue;

    const anchor = anchorOf(node);
    const [x, y, w, h] = node.rect;
    const horizontal = place(
      anchor.h,
      x,
      w,
      parentNow[0] - parent.rect[0],
      parentNow[2] - parent.rect[2],
    );
    const vertical = place(
      anchor.v,
      y,
      h,
      parentNow[1] - parent.rect[1],
      parentNow[3] - parent.rect[3],
    );
    result.set(id, [horizontal.start, vertical.start, horizontal.size, vertical.size]);
  }
  return result;
}
