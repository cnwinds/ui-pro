import type { AssetManifest, ScreenDoc, TextSpec } from '@ui-pro/core';
import type { Binding } from './assemble';
import type { TextMeasurement } from './model';

type AssignOp = Record<string, unknown>;

const round2 = (value: number): number => Math.round(value * 100) / 100;

function sameMargins(a: readonly number[] | undefined, b: readonly number[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.length === b.length &&
    a.every((value, index) => Math.abs(value - (b[index] ?? Number.NaN)) < 1e-6)
  );
}

export interface BindingResult {
  ops: AssignOp[];
  warnings: string[];
}

/**
 * The `asset.assign` ops that make the nodes match a build: bind what the build made, clear what an
 * earlier build bound to nodes that no longer draw an asset, and fill text styles measured from the
 * glyphs. Fields a node already has the right value for are left out, so a build that changes
 * nothing yields no ops at all.
 */
export function bindingOps(input: {
  doc: ScreenDoc;
  bindings: ReadonlyMap<string, Binding>;
  stale: readonly string[];
  previous: AssetManifest | null;
  measurements: readonly TextMeasurement[];
}): BindingResult {
  const { doc, bindings, stale, previous, measurements } = input;
  const ops: AssignOp[] = [];
  const warnings: string[] = [];
  const builtBefore = new Set(previous?.assets.map((asset) => asset.name) ?? []);

  for (const [id, binding] of bindings) {
    const node = doc.nodes[id];
    if (node === undefined) continue;
    const op: AssignOp = { op: 'asset.assign', target: `#${id}` };
    if (node.asset !== binding.asset) op.asset = binding.asset;
    if ((node.tint ?? null) !== (binding.tint ?? null)) op.tint = binding.tint ?? null;
    if (!sameMargins(node.nineSlice, binding.nineSlice)) op.nineSlice = binding.nineSlice ?? null;

    const states: Array<{ state: string; asset: string | null }> = [];
    const wanted = new Map(binding.states.map((entry) => [entry.state, entry.asset]));
    for (const [state, asset] of wanted) {
      if (node.states?.[state]?.asset !== asset) states.push({ state, asset });
    }
    for (const [state, override] of Object.entries(node.states ?? {})) {
      if (wanted.has(state) || override.asset === undefined) continue;
      if (builtBefore.has(override.asset)) states.push({ state, asset: null });
    }
    if (states.length > 0) op.states = states;
    if (Object.keys(op).length > 2) ops.push(op);
  }

  for (const id of stale) {
    const node = doc.nodes[id];
    if (node === undefined) continue;
    const op: AssignOp = { op: 'asset.assign', target: `#${id}` };
    if (node.asset !== undefined) {
      if (builtBefore.has(node.asset)) {
        op.asset = null;
        if (node.tint !== undefined) op.tint = null;
        if (node.nineSlice !== undefined) op.nineSlice = null;
      } else {
        warnings.push(
          `节点 #${id} 按决定不画资产，但带着资产 ${node.asset}；它不是构建写入的，没有清除`,
        );
      }
    }
    const states = Object.entries(node.states ?? {})
      .filter(([, override]) => override.asset !== undefined && builtBefore.has(override.asset))
      .map(([state]) => ({ state, asset: null }));
    if (states.length > 0) op.states = states;
    if (Object.keys(op).length > 2) ops.push(op);
  }

  const best = new Map<string, TextMeasurement>();
  for (const measurement of measurements) {
    const current = best.get(measurement.node);
    if (current === undefined || measurement.ownerArea < current.ownerArea) {
      best.set(measurement.node, measurement);
    }
  }
  for (const [id, { measured }] of best) {
    const node = doc.nodes[id];
    if (node?.text === undefined) continue;
    const scale = doc.scale;
    const text: Partial<Pick<TextSpec, 'size' | 'color' | 'stroke' | 'shadow'>> = {};
    const size = round2(measured.size * scale);
    if (node.text.size === undefined && size > 0) text.size = size;
    if (node.text.color === undefined) text.color = measured.color;
    if (node.text.stroke === undefined && measured.stroke !== undefined) {
      text.stroke = { color: measured.stroke.color, width: round2(measured.stroke.width * scale) };
    }
    if (node.text.shadow === undefined && measured.shadow !== undefined) {
      const { color, offset, blur } = measured.shadow;
      text.shadow = {
        color,
        offset: [round2(offset[0] * scale), round2(offset[1] * scale)],
        ...(blur === undefined ? {} : { blur: round2(blur * scale) }),
      };
    }
    if (Object.keys(text).length > 0) ops.push({ op: 'asset.assign', target: `#${id}`, text });
  }
  return { ops, warnings };
}
