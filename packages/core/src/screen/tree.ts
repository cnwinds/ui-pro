import { ErrorCodes, UiProError } from '../errors';
import type { Primitive, Rect } from '../schema/common';
import type { ScreenDoc, ScreenSource, UINode } from '../schema/screen';

export const ROOT_ID = 'root';

export interface NewNodeFields extends Partial<UINode> {
  id: string;
  type: Primitive;
  parent: string | null;
  rect: Rect;
}

function omitUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** Builds a node with every required field defaulted; `undefined` fields keep the default. */
export function newNode(fields: NewNodeFields): UINode {
  return {
    children: [],
    visible: true,
    varies: [],
    evidence: [],
    decisions: {},
    pins: {},
    ...omitUndefined(fields),
  };
}

export function createScreenDoc(input: {
  name: string;
  source: ScreenSource;
  scale: number;
  size: [number, number];
}): ScreenDoc {
  const root = newNode({
    id: ROOT_ID,
    type: 'container',
    parent: null,
    rect: [0, 0, input.size[0], input.size[1]],
  });
  return {
    format: 'ui-pro/screen',
    version: 1,
    name: input.name,
    source: input.source,
    scale: input.scale,
    size: input.size,
    root: ROOT_ID,
    nodes: { [ROOT_ID]: root },
    components: {},
    exclusions: [],
  };
}

export function requireNode(doc: ScreenDoc, id: string): UINode {
  const node = doc.nodes[id];
  if (!node) {
    throw new UiProError(ErrorCodes.nodeNotFound, `界面 ${doc.name} 中没有节点 #${id}`);
  }
  return node;
}

/** `id` and all its descendants: parents before children, siblings back-to-front. */
export function subtreeIds(doc: ScreenDoc, id: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    const node = doc.nodes[current];
    if (!node) continue;
    seen.add(current);
    order.push(current);
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i];
      if (child !== undefined) stack.push(child);
    }
  }
  return order;
}

/** Node ids reachable from the root in tree pre-order. */
export function preOrder(doc: ScreenDoc): string[] {
  return subtreeIds(doc, doc.root);
}

/** Every node id exactly once: the pre-order first, then any unreachable ids, sorted. */
export function allIdsInOrder(doc: ScreenDoc): string[] {
  const ordered = preOrder(doc);
  const seen = new Set(ordered);
  return [
    ...ordered,
    ...Object.keys(doc.nodes)
      .filter((id) => !seen.has(id))
      .sort(),
  ];
}

/** Ancestors of `id`, nearest first. Stops on a cycle or a dangling parent link. */
export function ancestorsOf(doc: ScreenDoc, id: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>([id]);
  let current = doc.nodes[id]?.parent ?? null;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    result.push(current);
    current = doc.nodes[current]?.parent ?? null;
  }
  return result;
}

export function isInSubtree(doc: ScreenDoc, ancestorId: string, id: string): boolean {
  return id === ancestorId || ancestorsOf(doc, id).includes(ancestorId);
}

/** Smallest id `<type>_<n>` (n from 1) not yet used in the screen. */
export function freeNodeId(doc: ScreenDoc, type: Primitive): string {
  const base = type.replaceAll('-', '_');
  for (let n = 1; ; n++) {
    const candidate = `${base}_${n}`;
    if (!(candidate in doc.nodes)) return candidate;
  }
}

/** Inserts `childId` into `parentId`'s children at `index` (append when omitted). */
export function attachChild(doc: ScreenDoc, parentId: string, childId: string, index?: number) {
  const parent = requireNode(doc, parentId);
  const child = requireNode(doc, childId);
  if (index === undefined) parent.children.push(childId);
  else parent.children.splice(index, 0, childId);
  child.parent = parentId;
}

/** Removes `id` from its parent's children and returns the index it occupied. */
export function detachChild(doc: ScreenDoc, id: string): number {
  const node = requireNode(doc, id);
  const parent = node.parent === null ? undefined : doc.nodes[node.parent];
  if (!parent) return -1;
  const index = parent.children.indexOf(id);
  if (index >= 0) parent.children.splice(index, 1);
  node.parent = null;
  return index;
}

export function unionRect(rects: readonly Rect[]): Rect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y, w, h] of rects) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }
  return [minX, minY, maxX - minX, maxY - minY];
}
