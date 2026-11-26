import type { Primitive, Rect } from '../schema/common';
import type { ScreenDoc, UINode } from '../schema/screen';
import { ancestorsOf, preOrder } from './tree';

/**
 * Who carries a node's pixels, read from its decisions (DESIGN §5.2). Build, the no-drift check
 * and the reference renderer all use this, so they agree on what each node draws.
 *
 * - `asset`: the node draws an asset of its own.
 * - `baked`: its pixels stay inside `host`'s asset (`attach.split: baked`, `decor.merge: merge`,
 *   or the parent's `content.split: baked`).
 * - `text`: dynamic text the engine draws; its glyphs are stripped from every asset beneath it.
 * - `none`: no pixels of its own (`container`, `instance`, `particle`).
 */
export type Ownership =
  | { kind: 'asset'; noHost?: true }
  | { kind: 'baked'; host: string }
  | { kind: 'text' }
  | { kind: 'none' };

/** Types without pixels of their own; `text` is decided by `text.mode`. */
const NO_PIXELS: ReadonlySet<Primitive> = new Set(['container', 'instance', 'particle']);

const decided = (node: UINode | undefined, point: string): string | undefined =>
  node?.decisions[point]?.value;

function isDynamicText(node: UINode): boolean {
  return node.type === 'text' && (decided(node, 'text.mode') ?? 'dynamic') === 'dynamic';
}

function bakedByDecision(doc: ScreenDoc, node: UINode): boolean {
  if (node.parent === null) return false;
  const attach = decided(node, 'attach.split');
  if (attach === 'baked' || decided(node, 'decor.merge') === 'merge') return true;
  return attach !== 'independent' && decided(doc.nodes[node.parent], 'content.split') === 'baked';
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner[0] >= outer[0] &&
    inner[1] >= outer[1] &&
    inner[0] + inner[2] <= outer[0] + outer[2] &&
    inner[1] + inner[3] <= outer[1] + outer[3]
  );
}

/** Intersection of two rectangles, or `undefined` when they do not overlap. */
export function intersectRect(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a[0], b[0]);
  const y = Math.max(a[1], b[1]);
  const right = Math.min(a[0] + a[2], b[0] + b[2]);
  const bottom = Math.min(a[1] + a[3], b[1] + b[3]);
  return right > x && bottom > y ? [x, y, right - x, bottom - y] : undefined;
}

/**
 * Ownership of every node reachable from the root. A baked node's host is its nearest ancestor
 * that draws an asset; failing that (decor over a sibling background), the last asset drawn
 * before it whose rect contains it. With no host at all it keeps an asset of its own (`noHost`).
 */
export function pixelOwnership(doc: ScreenDoc): Map<string, Ownership> {
  const result = new Map<string, Ownership>();
  const drawn: string[] = [];
  for (const id of preOrder(doc)) {
    const node = doc.nodes[id];
    if (!node) continue;
    if (NO_PIXELS.has(node.type)) {
      result.set(id, { kind: 'none' });
      continue;
    }
    if (isDynamicText(node)) {
      result.set(id, { kind: 'text' });
      continue;
    }
    if (!bakedByDecision(doc, node)) {
      result.set(id, { kind: 'asset' });
      drawn.push(id);
      continue;
    }
    const ancestor = ancestorsOf(doc, id).find((a) => result.get(a)?.kind === 'asset');
    const beneath = [...drawn]
      .reverse()
      .find((other) => contains(doc.nodes[other]?.rect ?? [0, 0, 0, 0], node.rect));
    const host = ancestor ?? beneath;
    if (host === undefined) {
      result.set(id, { kind: 'asset', noHost: true });
      drawn.push(id);
    } else {
      result.set(id, { kind: 'baked', host });
    }
  }
  return result;
}

/** What a flat-source asset must do with the pixels of something drawn above it. */
export interface ExpectedHole {
  /** The node above, or an exclusion id (`ex_1`). */
  node: string;
  handling: 'filled' | 'kept' | 'stripped';
  /** Overlap with the asset owner's rect, design pixels. */
  rect: Rect;
}

/**
 * For each node that draws an asset, the visible nodes drawn after it that overlap it and are not
 * baked into it, with what its pixels there need: dynamic text is stripped; an asset follows the
 * occluder's `occlusion.fill` (`fill` → filled, `none` → kept). Exclusions are always filled.
 * Hidden nodes are not in the source pixels: they leave no hole, and have none themselves. PSD
 * assets made from separate layers have no holes at all: the artist drew what is underneath.
 */
export function expectedHoles(
  doc: ScreenDoc,
  ownership: ReadonlyMap<string, Ownership> = pixelOwnership(doc),
): Map<string, ExpectedHole[]> {
  const holes = new Map<string, ExpectedHole[]>();
  for (const [id, owned] of ownership) {
    if (owned.kind === 'asset') holes.set(id, []);
  }
  const order = preOrder(doc).filter((id) => isShown(doc, id));
  order.forEach((id, index) => {
    if (ownership.get(id)?.kind !== 'asset') return;
    const owner = doc.nodes[id];
    if (!owner) return;
    const list: ExpectedHole[] = [];
    for (const above of order.slice(index + 1)) {
      const kind = ownership.get(above)?.kind;
      if (kind !== 'asset' && kind !== 'text') continue;
      const node = doc.nodes[above];
      const rect = node && intersectRect(owner.rect, node.rect);
      if (!node || !rect) continue;
      const handling =
        kind === 'text'
          ? 'stripped'
          : decided(node, 'occlusion.fill') === 'none'
            ? 'kept'
            : 'filled';
      list.push({ node: above, handling, rect });
    }
    for (const exclusion of doc.exclusions) {
      const rect = intersectRect(owner.rect, exclusion.rect);
      if (rect) list.push({ node: exclusion.id, handling: 'filled', rect });
    }
    holes.set(id, list);
  });
  return holes;
}

function isShown(doc: ScreenDoc, id: string): boolean {
  if (doc.nodes[id]?.visible === false) return false;
  return ancestorsOf(doc, id).every((ancestor) => doc.nodes[ancestor]?.visible !== false);
}
