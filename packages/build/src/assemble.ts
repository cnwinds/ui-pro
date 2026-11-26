import {
  type AssetFile,
  type AssetRecord,
  type AssetStep,
  type AssetUse,
  STATE_NAME_PATTERN,
  sha256Hex,
} from '@ui-pro/core';
import type { Approximation, FinalAsset } from './model';
import { NameAllocator } from './naming';
import type { SliceMargins } from './nine-slice';
import type { PlannedAsset } from './plan';
import type { DrawnState } from './psd';
import { encodePng } from './raster';
import type { SheetEntry } from './sheet';
import { deriveState } from './states';

/** What `asset.assign` writes into one node. */
export interface Binding {
  asset: string;
  tint?: string;
  nineSlice?: SliceMargins;
  states: Array<{ state: string; asset: string }>;
}

export interface AssembleInput {
  /** Pictures of the default looks, after dedupe, in drawing order. */
  finals: readonly FinalAsset[];
  /** Pictures of states that PSD layers draw. */
  drawn: readonly DrawnState[];
  planByNode: ReadonlyMap<string, PlannedAsset>;
}

export interface Assembled {
  records: AssetRecord[];
  files: AssetFile[];
  /** By node. */
  bindings: Map<string, Binding>;
  /** What states found only approximately right. */
  notes: Approximation[];
  warnings: string[];
  /** Every picture with its name, for the asset sheet. */
  sheet: SheetEntry[];
}

interface StateAsset {
  parent: FinalAsset;
  asset: FinalAsset;
}

type StateMethod = 'derive' | 'generate' | 'placeholder';

function methodOf(
  source: string | undefined,
  fallback: PlannedAsset['stateSource'],
): { method: StateMethod; drawnWithoutLayers: boolean } {
  if (source === 'derived') return { method: 'derive', drawnWithoutLayers: false };
  if (source === 'generated') return { method: 'generate', drawnWithoutLayers: false };
  if (source === 'placeholder') return { method: 'placeholder', drawnWithoutLayers: false };
  return { method: fallback, drawnWithoutLayers: source === 'drawn' };
}

const tintOf = (uses: readonly AssetUse[], node: string): string | undefined =>
  uses.find((use) => use.node === node && use.state === undefined)?.tint;

/**
 * DESIGN §6.5 状态, 整理: gives every state the node declares a picture (drawn in the PSD, derived
 * from the normal look, or the normal look itself as a recorded stand-in), names every asset from
 * `naming.asset`, and writes the manifest records and the files.
 */
export async function assembleAssets(input: AssembleInput): Promise<Assembled> {
  const notes: Approximation[] = [];
  const warnings: string[] = [];
  const drawn = new Map(input.drawn.map((entry) => [`${entry.node}|${entry.state}`, entry]));
  const stateAssets: StateAsset[] = [];

  for (const final of input.finals) {
    const requested = new Map<
      string,
      { nodes: string[]; method: StateMethod; drawnWithoutLayers: boolean }
    >();
    for (const use of [...final.uses]) {
      if (use.state !== undefined) continue;
      const plan = input.planByNode.get(use.node);
      if (plan === undefined) continue;
      for (const state of plan.states) {
        if (!STATE_NAME_PATTERN.test(state.name)) {
          warnings.push(`节点 #${use.node} 的状态名 ${state.name} 不符合命名规则，没有给它出图`);
          continue;
        }
        const picture = drawn.get(`${use.node}|${state.name}`);
        if (picture !== undefined) {
          const built = picture.built;
          stateAssets.push({
            parent: final,
            asset: {
              origin: built.origin === 'placeholder' ? 'placeholder' : 'layer',
              image: built.image,
              inset: built.inset,
              nineSlice: built.nineSlice,
              holes: [],
              steps: built.steps,
              approximations: built.approximations,
              uses: [
                { node: use.node, state: state.name, ...tintField(tintOf(final.uses, use.node)) },
              ],
              atlas: final.atlas,
              owner: final.owner,
              state: state.name,
            },
          });
          continue;
        }
        const { method, drawnWithoutLayers } = methodOf(state.source, plan.stateSource);
        const entry = requested.get(state.name);
        if (entry === undefined) {
          requested.set(state.name, { nodes: [use.node], method, drawnWithoutLayers });
        } else {
          entry.nodes.push(use.node);
        }
      }
    }

    for (const [state, entry] of requested) {
      const messages: string[] = [];
      if (entry.drawnWithoutLayers) {
        messages.push(
          `state.source：状态 ${state} 标为画好的，但没有找到对应的图层，按 ${entry.method} 处理`,
        );
      }
      const derived = entry.method === 'placeholder' ? undefined : deriveState(state, final.image);
      if (derived === undefined) {
        const why =
          entry.method === 'placeholder'
            ? `状态 ${state} 没有单独的图，用常态的图占位`
            : `状态 ${state} 没有推导方法，暂用常态的图`;
        messages.push(`state.source：${why}`);
        for (const node of entry.nodes) {
          final.uses.push({ node, state, ...tintField(tintOf(final.uses, node)) });
        }
        final.approximations = unique([...final.approximations, ...messages]);
        for (const message of messages) {
          for (const node of entry.nodes) notes.push({ node, message });
        }
        continue;
      }
      if (entry.method === 'generate')
        messages.push(`state.source：状态生成在 M2，状态 ${state} 按推导处理`);
      for (const message of messages) {
        for (const node of entry.nodes) notes.push({ node, message });
      }
      stateAssets.push({
        parent: final,
        asset: {
          origin: 'derived',
          image: derived.image,
          inset: final.inset,
          nineSlice: final.nineSlice,
          holes: final.holes.map((hole) => ({ ...hole })),
          steps: [{ step: 'state', method: derived.method, detail: derived.detail }],
          approximations: messages,
          uses: entry.nodes.map((node) => ({
            node,
            state,
            ...tintField(tintOf(final.uses, node)),
          })),
          atlas: final.atlas,
          owner: final.owner,
          state,
        },
      });
    }
  }

  const names = new NameAllocator();
  const named = new Map<FinalAsset, string>();
  for (const final of input.finals) {
    const [first] = final.uses;
    named.set(
      final,
      names.forNode(final.owner.nameTemplate, first?.node ?? final.owner.node, final.owner.type),
    );
  }
  for (const { parent, asset } of stateAssets) {
    named.set(asset, names.forState(named.get(parent) ?? 'asset', asset.state ?? 'state'));
  }

  const ordered: FinalAsset[] = [];
  for (const final of input.finals) {
    ordered.push(
      final,
      ...stateAssets.filter((entry) => entry.parent === final).map((e) => e.asset),
    );
  }

  const records: AssetRecord[] = [];
  const files: AssetFile[] = [];
  const bindings = new Map<string, Binding>();
  const sheet: SheetEntry[] = [];
  for (const asset of ordered) {
    const name = named.get(asset) ?? 'asset';
    const png = await encodePng(asset.image);
    files.push({ path: `${name}.png`, content: png });
    sheet.push({ name, image: asset.image });
    const defaultUses = asset.uses.filter((use) => use.state === undefined);
    records.push({
      name,
      file: `${name}.png`,
      origin: asset.origin,
      uses: asset.uses,
      size: [asset.image.width, asset.image.height],
      inset: asset.inset,
      ...(asset.nineSlice === undefined ? {} : { nineSlice: asset.nineSlice }),
      holes: asset.holes,
      steps: defaultUses.length > 1 ? withDedupeStep(asset.steps, defaultUses) : asset.steps,
      ...(asset.atlas === undefined ? {} : { atlas: asset.atlas }),
      sha256: sha256Hex(png),
      approximations: asset.approximations,
    });
    for (const use of asset.uses) {
      const binding = bindings.get(use.node) ?? { asset: '', states: [] };
      if (use.state === undefined) {
        binding.asset = name;
        binding.tint = use.tint;
        binding.nineSlice = asset.nineSlice;
      } else {
        binding.states.push({ state: use.state, asset: name });
      }
      bindings.set(use.node, binding);
    }
  }
  return { records, files, bindings, notes, warnings, sheet };
}

function tintField(tint: string | undefined): { tint?: string } {
  return tint === undefined ? {} : { tint };
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/** The dedupe step goes in before the closing tidy step, where the build runs it. */
function withDedupeStep(steps: readonly AssetStep[], uses: readonly AssetUse[]): AssetStep[] {
  const step: AssetStep = {
    step: 'dedupe',
    method: 'perceptual-hash',
    detail: `${uses.length} 个节点共用：${uses.map((use) => `#${use.node}`).join('、')}`,
  };
  const last = steps.length - 1;
  return steps[last]?.step === 'tidy'
    ? [...steps.slice(0, last), step, steps[last] as AssetStep]
    : [...steps, step];
}
