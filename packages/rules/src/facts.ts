import {
  allIdsInOrder,
  ancestorsOf,
  PRIMITIVES,
  type Primitive,
  preOrder,
  type Rect,
  type ScreenDoc,
  type UINode,
  type Variability,
} from '@ui-pro/core';
import { defaultVaries, INTERACTIVE_ROLES } from './roles';
import type { Position, Shape } from './schema';

/** Design pixels; the shorter side of a hit area below this is "small". */
export const MIN_TOUCH_SIZE = 44;
/** A node is "attached" to its host when it is at most this share of the host's area. */
export const ATTACHED_MAX_AREA_RATIO = 0.25;
/** A node "fills" its parent when it covers at least this share of both sides. */
export const FILL_RATIO = 0.95;
/** Longer side over shorter side up to this still counts as square. */
export const SQUARE_RATIO = 1.2;
/** Design pixels two edges may differ by and still count as aligned or equally spaced. */
export const ALIGN_TOLERANCE = 2;

export const INTERACTIVE_TYPES: ReadonlySet<Primitive> = new Set([
  'button',
  'toggle',
  'toggle-group',
  'slider',
  'input',
  'scroll',
  'list',
]);

/** Types that carry pixels of their own cut from the source (or a layer render). */
export const PIXEL_TYPES: ReadonlySet<Primitive> = new Set(
  PRIMITIVES.filter((type) => !['container', 'text', 'instance', 'particle'].includes(type)),
);

/**
 * Everything rules may look at, derived from a node, its surroundings and its screen. Evaluation
 * only reads these facts, which is what makes equal facts get equal decisions.
 */
export interface NodeFacts {
  type: Primitive;
  role?: string;
  concept?: string;
  isRoot: boolean;
  childCount: number;
  /** The node's own `varies`, or the default of its role when that is empty. */
  varies: readonly Variability[];
  interactive: boolean;
  textKind?: 'value' | 'label' | 'title';
  /** Belongs to a similarity cluster or is an instance of a component. */
  grouped: boolean;
  /** Nodes of the same screen in the same cluster (or instances of the same component); 1 alone. */
  repeat: number;
  parentType?: Primitive;
  parentRole?: string;
  attached: boolean;
  overVariable: boolean;
  /** Where the node sits in its parent; absent for the root. */
  position?: Position;
  shape: Shape;
  childrenEven: boolean;
  touchSmall: boolean;
  lowRes: boolean;
  crossScreen: boolean;
}

export function makeFacts(overrides: Partial<NodeFacts> & { type: Primitive }): NodeFacts {
  return {
    isRoot: false,
    childCount: 0,
    varies: [],
    interactive: INTERACTIVE_TYPES.has(overrides.type),
    grouped: false,
    repeat: 1,
    attached: false,
    overVariable: false,
    shape: 'wide',
    childrenEven: false,
    touchSmall: false,
    lowRes: false,
    crossScreen: false,
    ...overrides,
  };
}

/** Facts without the absent ones, for output. */
export function describeFacts(facts: NodeFacts): Record<string, unknown> {
  return Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== undefined));
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a[0], b[0]);
  const y = Math.max(a[1], b[1]);
  const right = Math.min(a[0] + a[2], b[0] + b[2]);
  const bottom = Math.min(a[1] + a[3], b[1] + b[3]);
  return right > x && bottom > y ? [x, y, right - x, bottom - y] : null;
}

const area = (rect: Rect): number => rect[2] * rect[3];

function positionIn(rect: Rect, host: Rect): Position {
  const overlap = intersect(rect, host);
  if (overlap && overlap[2] >= host[2] * FILL_RATIO && overlap[3] >= host[3] * FILL_RATIO) {
    return 'fill';
  }
  const across = (rect[0] + rect[2] / 2 - host[0]) / host[2];
  const down = (rect[1] + rect[3] / 2 - host[1]) / host[3];
  const h = across < 1 / 3 ? 'left' : across > 2 / 3 ? 'right' : 'center';
  const v = down < 1 / 3 ? 'top' : down > 2 / 3 ? 'bottom' : 'center';
  if (h === 'center' && v === 'center') return 'center';
  if (h === 'center') return v;
  if (v === 'center') return h;
  return `${v}-${h}`;
}

function shapeOf(rect: Rect): Shape {
  const ratio = rect[2] / rect[3];
  if (ratio <= SQUARE_RATIO && ratio >= 1 / SQUARE_RATIO) return 'square';
  return ratio > 1 ? 'wide' : 'tall';
}

/** Distinct coordinates, with values within the tolerance of each other merged. */
function mergeAligned(values: readonly number[]): number[] {
  const merged: number[] = [];
  for (const value of [...values].sort((a, b) => a - b)) {
    const last = merged[merged.length - 1];
    if (last === undefined || value - last > ALIGN_TOLERANCE) merged.push(value);
  }
  return merged;
}

function evenlySpaced(values: readonly number[]): boolean {
  const [first, second] = values;
  if (first === undefined || second === undefined) return true;
  const step = second - first;
  return values.every(
    (value, i) => i === 0 || Math.abs(value - (values[i - 1] ?? value) - step) <= ALIGN_TOLERANCE,
  );
}

function nearestIndex(values: readonly number[], value: number): number {
  return values.findIndex((candidate) => Math.abs(candidate - value) <= ALIGN_TOLERANCE);
}

/** Three or more children of one size, each in its own cell of an evenly spaced row or grid. */
function childrenEvenly(children: readonly UINode[]): boolean {
  const [first] = children;
  if (children.length < 3 || first === undefined) return false;
  const sameSize = children.every(
    (child) =>
      Math.abs(child.rect[2] - first.rect[2]) <= ALIGN_TOLERANCE &&
      Math.abs(child.rect[3] - first.rect[3]) <= ALIGN_TOLERANCE,
  );
  if (!sameSize) return false;
  const xs = mergeAligned(children.map((child) => child.rect[0]));
  const ys = mergeAligned(children.map((child) => child.rect[1]));
  if (!evenlySpaced(xs) || !evenlySpaced(ys)) return false;
  const cells = new Set(
    children.map(
      (child) => `${nearestIndex(xs, child.rect[0])}|${nearestIndex(ys, child.rect[1])}`,
    ),
  );
  return cells.size === children.length;
}

/** Keys a node is known by in other screens; sharing any of them across screens means sharing. */
function identityKeys(node: UINode): string[] {
  const keys: string[] = [];
  if (node.asset !== undefined) keys.push(`asset:${node.asset}`);
  if (node.instanceOf !== undefined) keys.push(`component:${node.instanceOf}`);
  if (node.concept !== undefined) keys.push(`concept:${node.concept}`);
  return keys;
}

/** Identity key -> names of the screens that have a node with it. */
export type CrossScreenIndex = ReadonlyMap<string, ReadonlySet<string>>;

export function buildCrossScreenIndex(docs: Iterable<ScreenDoc>): CrossScreenIndex {
  const index = new Map<string, Set<string>>();
  for (const doc of docs) {
    for (const node of Object.values(doc.nodes)) {
      for (const key of identityKeys(node)) {
        const screens = index.get(key) ?? new Set<string>();
        screens.add(doc.name);
        index.set(key, screens);
      }
    }
  }
  return index;
}

function groupKey(node: UINode): string | undefined {
  if (node.cluster !== undefined) return `cluster:${node.cluster}`;
  if (node.instanceOf !== undefined) return `component:${node.instanceOf}`;
  return undefined;
}

function isInteractive(node: UINode): boolean {
  return (
    INTERACTIVE_TYPES.has(node.type) ||
    (node.role !== undefined && INTERACTIVE_ROLES.has(node.role))
  );
}

/** Facts of every node of one screen. Pure: the same documents always give the same facts. */
export function computeScreenFacts(
  doc: ScreenDoc,
  cross: CrossScreenIndex,
): Map<string, NodeFacts> {
  const ids = allIdsInOrder(doc);
  const paintOrder = new Map(preOrder(doc).map((id, index) => [id, index]));
  const varies = new Map<string, Variability[]>();
  for (const id of ids) {
    const node = doc.nodes[id];
    if (!node) continue;
    const parentRole = node.parent === null ? undefined : doc.nodes[node.parent]?.role;
    varies.set(
      id,
      node.varies.length > 0 ? [...node.varies] : defaultVaries(node.role, parentRole),
    );
  }

  const groupSizes = new Map<string, number>();
  for (const id of ids) {
    const key = groupKey(doc.nodes[id] as UINode);
    if (key !== undefined) groupSizes.set(key, (groupSizes.get(key) ?? 0) + 1);
  }

  const variable = ids.filter((id) => {
    const node = doc.nodes[id];
    return node !== undefined && node.type !== 'container' && (varies.get(id)?.length ?? 0) > 0;
  });

  const result = new Map<string, NodeFacts>();
  for (const id of ids) {
    const node = doc.nodes[id];
    if (!node) continue;
    const parent = node.parent === null ? undefined : doc.nodes[node.parent];
    const key = groupKey(node);
    const painted = paintOrder.get(id) ?? Number.POSITIVE_INFINITY;
    const ancestors = new Set(ancestorsOf(doc, id));

    const overVariable = variable.some((otherId) => {
      const other = doc.nodes[otherId];
      return (
        other !== undefined &&
        otherId !== id &&
        (paintOrder.get(otherId) ?? Number.POSITIVE_INFINITY) < painted &&
        !ancestors.has(otherId) &&
        intersect(node.rect, other.rect) !== null
      );
    });
    const attached =
      parent !== undefined &&
      parent.id !== doc.root &&
      parent.type !== 'container' &&
      intersect(node.rect, parent.rect) !== null &&
      area(node.rect) <= area(parent.rect) * ATTACHED_MAX_AREA_RATIO;

    result.set(id, {
      type: node.type,
      role: node.role,
      concept: node.concept,
      isRoot: id === doc.root,
      childCount: node.children.length,
      varies: varies.get(id) ?? [],
      interactive: isInteractive(node),
      textKind: node.text?.kind,
      grouped: key !== undefined,
      repeat: key === undefined ? 1 : (groupSizes.get(key) ?? 1),
      parentType: parent?.type,
      parentRole: parent?.role,
      attached,
      overVariable,
      position: parent === undefined ? undefined : positionIn(node.rect, parent.rect),
      shape: shapeOf(node.rect),
      childrenEven: childrenEvenly(
        node.children.flatMap((childId) => {
          const child = doc.nodes[childId];
          return child ? [child] : [];
        }),
      ),
      touchSmall: Math.min(node.rect[2], node.rect[3]) < MIN_TOUCH_SIZE,
      lowRes: doc.scale > 1 + 1e-9,
      crossScreen: identityKeys(node).some((identity) => (cross.get(identity)?.size ?? 0) > 1),
    });
  }
  return result;
}
