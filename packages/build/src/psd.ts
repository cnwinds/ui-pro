import {
  type Candidate,
  type CandidatesDoc,
  type Project,
  readFileIfExistsSync,
  resolveInside,
  type ScreenDoc,
  screenRelDir,
} from '@ui-pro/core';
import type { ArtStyle, RgbaImage } from '@ui-pro/perception';
import { finishAsset } from './finish';
import type { BuiltAsset } from './model';
import type { SliceMargins } from './nine-slice';
import type { PlannedAsset } from './plan';
import { blankImage, decodePng, pasteOver } from './raster';
import type { PixelRunner } from './runner';

export interface LayerContext {
  project: Project;
  screen: string;
  doc: ScreenDoc;
  evidence: CandidatesDoc;
  runner: PixelRunner;
  style: ArtStyle;
  /** Reported by the build as warnings. */
  warnings: string[];
}

/** The picture a hidden `@name` layer group gives one state of a node. */
export interface DrawnState {
  node: string;
  state: string;
  built: BuiltAsset;
}

export interface LayerAssets {
  asset: BuiltAsset;
  states: DrawnState[];
}

/** Leaves of the layer tree: candidates that have a render, found under `id` in drawing order. */
function leavesUnder(
  id: string,
  children: ReadonlyMap<string, readonly Candidate[]>,
  byId: ReadonlyMap<string, Candidate>,
): Candidate[] {
  const candidate = byId.get(id);
  if (candidate === undefined) return [];
  if (candidate.mask !== undefined) return [candidate];
  return (children.get(id) ?? []).flatMap((child) => leavesUnder(child.id, children, byId));
}

async function compose(
  ctx: LayerContext,
  node: string,
  leaves: readonly Candidate[],
): Promise<{ image: RgbaImage; origin: [number, number] } | undefined> {
  const placed: Array<{ image: RgbaImage; x: number; y: number }> = [];
  for (const leaf of leaves) {
    const bytes = readFileIfExistsSync(
      resolveInside(ctx.project.root, `${screenRelDir(ctx.screen)}/evidence/${leaf.mask ?? ''}`),
    );
    if (bytes === null) {
      ctx.warnings.push(`图层 ${leaf.id} 的渲染文件 ${leaf.mask} 不存在，#${node} 改按基准图裁切`);
      return undefined;
    }
    placed.push({
      image: await decodePng(bytes),
      x: Math.round(leaf.bbox[0]),
      y: Math.round(leaf.bbox[1]),
    });
  }
  if (placed.length === 0) return undefined;
  const left = Math.min(...placed.map((part) => part.x));
  const top = Math.min(...placed.map((part) => part.y));
  const right = Math.max(...placed.map((part) => part.x + part.image.width));
  const bottom = Math.max(...placed.map((part) => part.y + part.image.height));
  const canvas = blankImage(right - left, bottom - top);
  for (const part of placed) pasteOver(canvas, part.image, part.x - left, part.y - top);
  return { image: canvas, origin: [left, top] };
}

function stateName(layerName: string): string {
  return layerName
    .slice(1)
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]/g, '_');
}

/**
 * The layers that draw a node's default look: its own evidence plus that of the nodes baked into
 * it, without hidden layers, in the PSD's drawing order.
 */
function lookLayers(
  ctx: LayerContext,
  plan: PlannedAsset,
  children: ReadonlyMap<string, readonly Candidate[]>,
  byId: ReadonlyMap<string, Candidate>,
): Candidate[] {
  const wanted = new Set<string>();
  for (const id of [plan.node, ...plan.hosted]) {
    const node = ctx.doc.nodes[id];
    if (node === undefined || node.visible === false) continue;
    for (const ref of node.evidence) {
      for (const leaf of leavesUnder(ref, children, byId)) {
        if (leaf.layer?.hidden !== true) wanted.add(leaf.id);
      }
    }
  }
  return ctx.evidence.candidates.filter((candidate) => wanted.has(candidate.id));
}

/** Hidden `@name` layers next to the node's own layers, by the state name they stand for. */
function stateLayers(
  ctx: LayerContext,
  plan: PlannedAsset,
  children: ReadonlyMap<string, readonly Candidate[]>,
  byId: ReadonlyMap<string, Candidate>,
): Map<string, Candidate[]> {
  const parents = new Set<string>();
  for (const ref of ctx.doc.nodes[plan.node]?.evidence ?? []) {
    const candidate = byId.get(ref);
    if (candidate === undefined) continue;
    if (candidate.parent !== undefined) parents.add(candidate.parent);
    if (candidate.layer?.kind === 'group') parents.add(candidate.id);
  }
  const wanted = new Set(
    plan.states.filter((state) => state.source === 'drawn').map((s) => s.name),
  );
  const found = new Map<string, Candidate[]>();
  for (const candidate of ctx.evidence.candidates) {
    const name = candidate.layer?.name;
    if (candidate.parent === undefined || !parents.has(candidate.parent)) continue;
    if (name === undefined || !name.startsWith('@')) continue;
    const state = stateName(name);
    if (!wanted.has(state)) continue;
    found.set(state, [...(found.get(state) ?? []), ...leavesUnder(candidate.id, children, byId)]);
  }
  return found;
}

/**
 * DESIGN §6.8 PSD 的像素从哪来: the asset of a node is the render of its layers, composed with
 * those of the nodes baked into it. There is no extraction and no fill: the artist drew what lies
 * beneath. Hidden `@state` layers become the pictures of those states. `undefined` when the node
 * has no layers with renders: it is then cut from the composite like a flat source.
 */
export async function buildLayerAsset(
  ctx: LayerContext,
  plan: PlannedAsset,
): Promise<LayerAssets | undefined> {
  const children = new Map<string, Candidate[]>();
  for (const candidate of ctx.evidence.candidates) {
    if (candidate.parent === undefined) continue;
    children.set(candidate.parent, [...(children.get(candidate.parent) ?? []), candidate]);
  }
  const byId = new Map(ctx.evidence.candidates.map((candidate) => [candidate.id, candidate]));

  const leaves = lookLayers(ctx, plan, children, byId);
  if (leaves.length === 0) return undefined;
  const composed = await compose(ctx, plan.node, leaves);
  if (composed === undefined) return undefined;

  const names = leaves.map((leaf) => leaf.layer?.name ?? leaf.id).join('、');
  const finished = await finishAsset({
    plan,
    scale: ctx.doc.scale,
    style: ctx.style,
    image: composed.image,
    origin: composed.origin,
    runner: ctx.runner,
    tidy: { method: 'layer-render', detail: `由 ${leaves.length} 个图层的渲染合成（${names}）` },
  });
  const asset: BuiltAsset = {
    node: plan.node,
    plan,
    origin: finished.empty ? 'placeholder' : 'layer',
    image: finished.image,
    inset: finished.inset,
    nineSlice: finished.nineSlice,
    holes: [],
    steps: finished.steps,
    approximations: [...plan.approximations, ...finished.approximations],
    invented: 0,
  };

  const states: DrawnState[] = [];
  for (const [state, layers] of stateLayers(ctx, plan, children, byId)) {
    const picture = await compose(ctx, plan.node, layers);
    if (picture === undefined) continue;
    const margins: SliceMargins | undefined = asset.nineSlice;
    const done = await finishAsset({
      plan: margins === undefined ? { ...plan, stretch: 'fixed' } : plan,
      scale: ctx.doc.scale,
      style: ctx.style,
      image: picture.image,
      origin: picture.origin,
      runner: ctx.runner,
      margins,
      tidy: {
        method: 'layer-render',
        detail: `状态 ${state} 由图层 ${layers.map((layer) => layer.layer?.name ?? layer.id).join('、')} 的渲染得到`,
      },
    });
    states.push({
      node: plan.node,
      state,
      built: {
        node: plan.node,
        plan,
        origin: done.empty ? 'placeholder' : 'layer',
        image: done.image,
        inset: done.inset,
        nineSlice: done.nineSlice,
        holes: [],
        steps: done.steps,
        approximations: done.approximations,
        invented: 0,
      },
    });
  }
  return { asset, states };
}
