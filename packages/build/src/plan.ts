import {
  type AssetManifest,
  expectedHoles,
  type Primitive,
  pixelOwnership,
  preOrder,
  type Rect,
  type ScreenDoc,
  type StateOverride,
  type UINode,
} from '@ui-pro/core';
import { FULL_BLEED_RATIO } from './constants';

/** What one hole of an asset needs (DESIGN §6.5), from the shared `expectedHoles`. */
export interface PlannedHole {
  /** The node drawn above, or an exclusion id (`ex_1`). */
  node: string;
  handling: 'filled' | 'kept' | 'stripped';
  /** Overlap with the asset owner's rect, design pixels. */
  rect: Rect;
}

export interface PlannedState {
  name: string;
  /** The state's own `source`; the rule's `state.source` decides when it has none. */
  source?: StateOverride['source'];
}

export const DEFAULT_NAME_TEMPLATE = '{prefix}_{semantic}_{index}';

/** Everything the build needs to know about one node that draws an asset. */
export interface PlannedAsset {
  node: string;
  type: Primitive;
  /** Design pixels. */
  rect: Rect;
  /** Which segmentation the extract step uses. */
  subject: 'ui' | 'figure' | 'text';
  /** Covers the whole screen: nothing to cut out. */
  fullBleed: boolean;
  holes: PlannedHole[];
  /** Nodes whose pixels stay inside this asset (`baked`), in drawing order. */
  hosted: string[];
  /** `native` keeps the source's density; `design` makes it one file pixel per design pixel. */
  density: 'native' | 'design';
  stretch: 'nine-slice' | 'three-slice' | 'fixed';
  /** Similarity cluster or component the node repeats in. */
  group?: string;
  repeat: 'component' | 'independent';
  variant: 'tint' | 'variant-assets';
  /** States the node declares and that still need a picture. */
  states: PlannedState[];
  stateSource: 'derive' | 'generate' | 'placeholder';
  nameTemplate: string;
  atlas?: 'screen' | 'shared';
  /** What planning already knows is only approximately right, in the §5.2 prefix form. */
  approximations: string[];
}

export interface BuildPlan {
  /** In drawing order. */
  assets: PlannedAsset[];
  /** Nodes that do not draw an asset but still carry asset fields from an earlier build. */
  stale: string[];
}

export interface PlanContext {
  /** The screen's current manifest: tells states the build made from states the user supplied. */
  previous?: AssetManifest | null;
}

const decided = (node: UINode, point: string): string | undefined => node.decisions[point]?.value;

export function groupKey(node: UINode): string | undefined {
  if (node.cluster !== undefined) return `cluster:${node.cluster}`;
  if (node.instanceOf !== undefined) return `component:${node.instanceOf}`;
  return undefined;
}

function subjectOf(node: UINode): PlannedAsset['subject'] {
  if (node.type === 'text') return 'text';
  const role = node.role;
  return role === 'figure' || role?.startsWith('figure.') === true ? 'figure' : 'ui';
}

function coversScreen(doc: ScreenDoc, rect: Rect): boolean {
  return rect[2] >= doc.size[0] * FULL_BLEED_RATIO && rect[3] >= doc.size[1] * FULL_BLEED_RATIO;
}

/** A state that has no picture yet: one the build made earlier counts as not having one. */
function needsPicture(state: StateOverride, builtBefore: boolean): boolean {
  if (state.asset !== undefined && !builtBefore) return false;
  return (
    state.source !== undefined ||
    (state.visible === undefined && state.tint === undefined && state.text === undefined)
  );
}

function builtStates(previous: AssetManifest | null | undefined, node: string): Set<string> {
  const names = new Set<string>();
  for (const asset of previous?.assets ?? []) {
    for (const use of asset.uses) {
      if (use.node === node && use.state !== undefined) names.add(use.state);
    }
  }
  return names;
}

/** The progress bar's fill: its first image child that draws an asset (spec 第 8 条). */
function progressFill(
  doc: ScreenDoc,
  node: UINode,
  owned: ReadonlyMap<string, { kind: string }>,
): string | undefined {
  return node.children.find(
    (id) => doc.nodes[id]?.type === 'image' && owned.get(id)?.kind === 'asset',
  );
}

function noHostPoint(node: UINode): string {
  if (decided(node, 'attach.split') === 'baked') return 'attach.split';
  if (decided(node, 'decor.merge') === 'merge') return 'decor.merge';
  return 'content.split';
}

/**
 * The asset plan of a screen: for every node that draws an asset, which pixels it takes, what is
 * filled or stripped, at what density, and how it stretches and repeats. A pure function of the
 * screen document (and, for states, the previous manifest); it reads and writes no files.
 */
export function planAssets(doc: ScreenDoc, context: PlanContext = {}): BuildPlan {
  const ownership = pixelOwnership(doc);
  const holes = expectedHoles(doc, ownership);
  const order = preOrder(doc);

  const hosted = new Map<string, string[]>();
  for (const id of order) {
    const owned = ownership.get(id);
    if (owned?.kind === 'baked') hosted.set(owned.host, [...(hosted.get(owned.host) ?? []), id]);
  }

  const assets: PlannedAsset[] = [];
  const stale: string[] = [];
  for (const id of order) {
    const node = doc.nodes[id];
    const owned = ownership.get(id);
    if (!node || !owned) continue;
    if (owned.kind !== 'asset') {
      const states = Object.values(node.states ?? {});
      if (
        node.asset !== undefined ||
        node.tint !== undefined ||
        node.nineSlice !== undefined ||
        states.some((state) => state.asset !== undefined)
      ) {
        stale.push(id);
      }
      continue;
    }

    const approximations: string[] = [];
    if (node.type === 'text' && decided(node, 'text.mode') === 'bitmap-font') {
      approximations.push('text.mode：bitmap-font 在 M1 等同 bitmap，按图片处理');
    }
    if (owned.noHost === true) {
      approximations.push(
        `${noHostPoint(node)}：按决定应并入宿主，但没有找到宿主，保留了自己的资产`,
      );
    }

    const plannedHoles: PlannedHole[] = (holes.get(id) ?? []).map((hole) => ({ ...hole }));
    const fill = node.type === 'progress' ? progressFill(doc, node, ownership) : undefined;
    for (const hole of plannedHoles) {
      if (hole.node !== fill || hole.handling !== 'kept') continue;
      hole.handling = 'filled';
      approximations.push(
        `occlusion.fill：进度条的底槽在填充 #${fill} 下面的部分一律补全，引擎才能缩短填充（#${fill} 的决定是 none）`,
      );
    }

    const stretchDecision = decided(node, 'stretch.mode');
    const stretch =
      stretchDecision === 'nine-slice' || stretchDecision === 'three-slice'
        ? stretchDecision
        : 'fixed';
    const scale = decided(node, 'scale.source');
    const builtBefore = builtStates(context.previous, id);
    const stateSource = decided(node, 'state.source');
    const atlas = decided(node, 'atlas.group');

    assets.push({
      node: id,
      type: node.type,
      rect: node.rect,
      subject: subjectOf(node),
      fullBleed: coversScreen(doc, node.rect),
      holes: plannedHoles,
      hosted: hosted.get(id) ?? [],
      density:
        scale === 'upscale' || scale === 'redraw' || stretch !== 'fixed' ? 'design' : 'native',
      stretch,
      group: groupKey(node),
      repeat: decided(node, 'repeat.mode') === 'component' ? 'component' : 'independent',
      variant: decided(node, 'variant.mode') === 'tint' ? 'tint' : 'variant-assets',
      states: Object.entries(node.states ?? {})
        .filter(([name, state]) => needsPicture(state, builtBefore.has(name)))
        .map(([name, state]) => ({ name, source: state.source })),
      stateSource:
        stateSource === 'generate' || stateSource === 'placeholder' ? stateSource : 'derive',
      nameTemplate: decided(node, 'naming.asset') ?? DEFAULT_NAME_TEMPLATE,
      atlas: atlas === 'shared' || atlas === 'screen' ? atlas : undefined,
      approximations,
    });
  }
  return { assets, stale };
}
