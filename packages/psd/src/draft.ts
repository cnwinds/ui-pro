import { type AskQuestion, NODE_ID_PATTERN, type Primitive, type TextSpec } from '@ui-pro/core';
import { candidateIdOf, type LayerEvidence } from './evidence';
import { layerPath, type PsdDocument, type PsdLayer, walkLayers } from './model';
import type { PrefixEntry, PrefixTable } from './prefixes';
import { isIgnored, isValidStateName, stateNameOf } from './structure';

export interface DraftInput {
  document: PsdDocument;
  prefixes: PrefixTable;
  evidence: LayerEvidence;
  /** Ids already taken in the screen, the root included. */
  usedNodeIds: Iterable<string>;
  /** Source pixels to design pixels. */
  scale: number;
  /** Layers whose render did not match the composite; they become image nodes of their own. */
  failed: ReadonlySet<number>;
}

export interface Draft {
  ops: unknown[];
  /** Number of `node.add` ops. */
  nodes: number;
  warnings: string[];
  ask: AskQuestion[];
}

type Item =
  | { kind: 'element'; layer: PsdLayer; entry: PrefixEntry }
  | { kind: 'part'; layer: PsdLayer }
  | { kind: 'state'; layer: PsdLayer; name: string };

/** Numbers, thousands separators and `Lv.` prefixes: text that shows a value. */
const VALUE_TEXT = /^\s*(?:lv\.?\s*)?[+-]?[\d.,:/%\s]+$/i;

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * What a group holds, in z-order. Groups without a prefix are not elements: their contents are
 * read as if they sat in the enclosing element.
 */
function scan(layers: readonly PsdLayer[], prefixes: PrefixTable, items: Item[] = []): Item[] {
  for (const layer of layers) {
    if (isIgnored(layer)) continue;
    const state = stateNameOf(layer);
    if (state !== undefined) {
      items.push({ kind: 'state', layer, name: state });
      continue;
    }
    const entry = prefixes.match(layer.name);
    if (entry !== undefined) {
      items.push({ kind: 'element', layer, entry });
    } else if (layer.kind === 'group') {
      if (!layer.hidden) scan(layer.children ?? [], prefixes, items);
    } else if (!layer.hidden) {
      items.push({ kind: 'part', layer });
    }
  }
  return items;
}

class DraftBuilder {
  readonly ops: unknown[] = [];
  readonly warnings: string[] = [];
  readonly badges: string[] = [];
  nodes = 0;
  private readonly used: Set<string>;

  constructor(private readonly input: DraftInput) {
    this.used = new Set(input.usedNodeIds);
  }

  /** The group's name when it can be a node id and is free; otherwise `<type>_<n>`. */
  private allocate(preferred: string | undefined, type: Primitive): string {
    if (preferred !== undefined && NODE_ID_PATTERN.test(preferred) && !this.used.has(preferred)) {
      this.used.add(preferred);
      return preferred;
    }
    const base = type.replaceAll('-', '_');
    for (let n = 1; ; n++) {
      const id = `${base}_${n}`;
      if (!this.used.has(id)) {
        this.used.add(id);
        return id;
      }
    }
  }

  private evidenceOf(layers: readonly PsdLayer[]): string[] {
    return layers.map(candidateIdOf).filter((id) => this.input.evidence.candidateIds.has(id));
  }

  private textSpec(layer: PsdLayer): TextSpec | undefined {
    const text = layer.text;
    if (text === undefined) return undefined;
    const { scale } = this.input;
    return {
      content: text.content,
      ...(VALUE_TEXT.test(text.content) ? { kind: 'value' as const } : {}),
      ...(text.font === undefined ? {} : { font: text.font }),
      ...(text.size === undefined ? {} : { size: round2(text.size * scale) }),
      ...(text.color === undefined ? {} : { color: text.color }),
    };
  }

  /** The text layer a `txt_` element shows: its own, or the topmost visible one inside it. */
  private textLayerOf(layer: PsdLayer): PsdLayer | undefined {
    if (layer.kind === 'text') return layer;
    const inside = [...walkLayers(layer.children ?? [])]
      .map((visit) => visit.layer)
      .filter((candidate) => candidate.kind === 'text' && !candidate.hidden);
    return inside.at(-1);
  }

  private imageNode(layer: PsdLayer, parent: string | undefined, why: string): void {
    const from = this.evidenceOf([layer]);
    if (from.length === 0) return;
    const id = this.allocate(undefined, 'image');
    this.ops.push({
      op: 'node.add',
      node: { id, type: 'image', ...(parent === undefined ? {} : { parent: `#${parent}` }) },
      from,
    });
    this.nodes++;
    this.warnings.push(`图层「${layerPath(layer)}」${why}，按图片节点 #${id} 处理`);
  }

  /** Adds one element and, below it, everything it holds. */
  element(layer: PsdLayer, entry: PrefixEntry, parent: string | undefined): void {
    const items = layer.kind === 'group' ? scan(layer.children ?? [], this.input.prefixes) : [];
    const parts =
      layer.kind === 'group'
        ? items.flatMap((item) => (item.kind === 'part' ? [item.layer] : []))
        : [layer];
    const states = items.flatMap((item) => (item.kind === 'state' ? [item] : []));
    const children = items.flatMap((item) => (item.kind === 'element' ? [item.layer] : []));
    const sound = parts.filter((part) => !this.input.failed.has(part.id));
    const unsound = parts.filter((part) => this.input.failed.has(part.id));

    // Where the node's rectangle comes from: its own art, falling back to what is inside it.
    const sources = [sound, unsound, children, states.map((state) => state.layer)];
    const source = sources.find((layers) => this.evidenceOf(layers).length > 0);
    const from = source === undefined ? undefined : this.evidenceOf(source);
    if (source === undefined || from === undefined) {
      this.warnings.push(`「${layerPath(layer)}」里没有可见的图层内容，没有生成节点`);
      return;
    }

    let type = entry.type;
    let text: TextSpec | undefined;
    if (type === 'text') {
      const source = this.textLayerOf(layer);
      text = source === undefined ? undefined : this.textSpec(source);
      if (text === undefined) {
        type = 'image';
        this.warnings.push(
          `「${layerPath(layer)}」用了 ${entry.prefix} 前缀，但里面没有文字图层，按图片处理`,
        );
      }
    } else if (entry.typeWithChildren !== undefined && children.length > 0) {
      type = entry.typeWithChildren;
    }

    const id = this.allocate(layer.name, type);
    if (entry.roleFromContent) this.badges.push(id);
    this.ops.push({
      op: 'node.add',
      node: {
        id,
        type,
        ...(entry.role === undefined ? {} : { role: entry.role }),
        ...(entry.varies === undefined ? {} : { varies: [...entry.varies] }),
        ...(parent === undefined ? {} : { parent: `#${parent}` }),
        ...(layer.hidden ? { visible: false } : {}),
        ...(text === undefined ? {} : { text }),
      },
      from,
    });
    this.nodes++;

    const seen = new Set<string>();
    for (const state of states) {
      if (!isValidStateName(state.name) || seen.has(state.name)) {
        this.warnings.push(
          `状态图层「${layerPath(state.layer)}」的状态名不合法或重复，没有记为状态`,
        );
        continue;
      }
      seen.add(state.name);
      this.ops.push({
        op: 'state.set',
        target: `#${id}`,
        state: state.name,
        set: { source: 'drawn' },
      });
    }
    // Layers that failed the check are this node's own art when it has no sound ones.
    this.children(
      items,
      id,
      source === unsound ? new Set(unsound.map((part) => part.id)) : undefined,
    );
  }

  /** Elements below `parent`, in z-order, with the layers that need a node of their own. */
  children(
    items: readonly Item[],
    parent: string | undefined,
    covered?: ReadonlySet<number>,
  ): void {
    for (const item of items) {
      if (item.kind === 'element') this.element(item.layer, item.entry, parent);
      else if (item.kind === 'part' && covered?.has(item.layer.id)) continue;
      else if (item.kind === 'part' && this.input.failed.has(item.layer.id)) {
        this.imageNode(item.layer, parent, '核对不通过');
      } else if (item.kind === 'part' && parent === undefined) {
        this.imageNode(item.layer, parent, '不在任何元素的图层组里');
      } else if (item.kind === 'state' && parent === undefined) {
        this.warnings.push(`状态图层「${layerPath(item.layer)}」不在元素的图层组里，没有记为状态`);
      }
    }
  }
}

/**
 * The draft from the named groups (§6.3, appendix C.3): prefixed groups become nodes and their
 * nesting the hierarchy, their plain layers its evidence, hidden `@状态名` layers drawn states.
 * Layers that cannot be attributed to an element, or whose render failed the check, become image
 * nodes so that nothing visible is lost.
 */
export function buildDraft(input: DraftInput): Draft {
  const builder = new DraftBuilder(input);
  builder.children(scan(input.document.layers, input.prefixes), undefined);
  const ask: AskQuestion[] =
    builder.badges.length === 0
      ? []
      : [
          {
            id: 'psd.badge-role',
            question: `角标 ${builder.badges.map((id) => `#${id}`).join('、')} 的种类要由内容判断，请看图确认`,
            options: ['badge.notification', 'badge.count', 'badge.mark'],
          },
        ];
  return { ops: builder.ops, nodes: builder.nodes, warnings: builder.warnings, ask };
}
