import {
  type AssetManifest,
  type AssetRecord,
  pixelOwnership,
  type Rect,
  type ScreenDoc,
  type StateOverride,
  type UINode,
} from '@ui-pro/core';
import { boundText } from './bindings';
import { layoutScreen } from './layout';
import type { DrawList, DrawOp, ImageOp, RenderOptions, TextOp } from './types';

/** Font size of a line that fills a box this tall; the same estimate the Godot export uses. */
export const LINE_FILL = 0.8;

/** The text colour of a node that gives none. */
export const DEFAULT_TEXT_COLOR = '#ffffff';

/** Family name of a text node that names no font; resolved to the system fallback at draw time. */
export const DEFAULT_FAMILY = 'sans-serif';

const MAX_LISTED = 6;

/** Keys of a node's `bind` that supply its text. */
const TEXT_BINDINGS = ['text', 'content'] as const;

function listed(ids: readonly string[]): string {
  const shown = ids.slice(0, MAX_LISTED).map((id) => `#${id}`);
  return ids.length > MAX_LISTED ? `${shown.join('、')} 等 ${ids.length} 个` : shown.join('、');
}

type Describe = (ids: string, count: number) => string;

/** Approximations of one frame, grouped by kind so a hundred placeholders are one line. */
class Approximations {
  private readonly groups = new Map<string, { ids: string[]; describe: Describe }>();

  add(key: string, id: string, describe: Describe): void {
    const group = this.groups.get(key);
    if (group) group.ids.push(id);
    else this.groups.set(key, { ids: [id], describe });
  }

  lines(): string[] {
    return [...this.groups.values()].map((group) =>
      group.describe(listed(group.ids), group.ids.length),
    );
  }
}

/** The area the asset file covers: the node's rectangle less the record's insets. */
function coveredRect(rect: Rect, inset: AssetRecord['inset']): Rect {
  return [
    rect[0] + inset[0],
    rect[1] + inset[1],
    rect[2] - inset[0] - inset[2],
    rect[3] - inset[1] - inset[3],
  ];
}

/** The text a node shows: state, then render option, then binding, then `text.content`. */
function textContent(
  node: UINode,
  state: StateOverride | undefined,
  options: RenderOptions & { mock: unknown },
): string | undefined {
  if (state?.text?.content !== undefined) return state.text.content;
  const replaced = options.text?.[node.id];
  if (replaced !== undefined) return replaced;
  for (const key of TEXT_BINDINGS) {
    const binding = node.bind?.[key];
    const bound = binding && boundText(options.mock, binding);
    if (bound !== undefined) return bound;
  }
  return node.text?.content;
}

/**
 * The frame's draw list: what each node draws (by `pixelOwnership`), back to front, in design
 * pixels of the laid-out viewport. Pure: no files, no Node APIs, so Studio builds the same list
 * in the browser. `fonts` maps a font name to its project file; `options.mock` is the data the
 * bindings read.
 */
export function buildDrawList(
  doc: ScreenDoc,
  manifest: AssetManifest | null,
  fonts: Readonly<Record<string, string>>,
  options: RenderOptions & { mock: unknown },
): DrawList {
  const viewport = options.viewport ?? { width: doc.size[0], height: doc.size[1] };
  const rects = layoutScreen(doc, viewport);
  const ownership = pixelOwnership(doc);
  const records = new Map((manifest?.assets ?? []).map((record) => [record.name, record]));
  const hidden = new Set(options.hidden ?? []);
  const approximations = new Approximations();
  const warnings: string[] = [];
  const ops: DrawOp[] = [];

  const stateOf = (node: UINode): StateOverride | undefined => {
    const name = options.states?.[node.id];
    if (name === undefined) return undefined;
    const state = node.states?.[name];
    if (!state) warnings.push(`节点 #${node.id} 没有状态 ${name}，按常态画`);
    return state;
  };

  const drawAsset = (node: UINode, state: StateOverride | undefined, rect: Rect): void => {
    const name = state?.asset ?? node.asset;
    const record = name === undefined ? undefined : records.get(name);
    if (name === undefined || !record) {
      const reason = name === undefined ? '还没有资产' : `资产 ${name} 不在资产清单里`;
      ops.push({ kind: 'placeholder', node: node.id, dest: rect, reason });
      approximations.add(
        name === undefined ? 'no-asset' : `unlisted:${name}`,
        node.id,
        name === undefined
          ? (ids, count) => `${count} 个节点还没有资产，画占位框：${ids}`
          : (ids) => `${ids} 用的资产 ${name} 不在资产清单里，画占位框`,
      );
      return;
    }

    const dest = coveredRect(rect, record.inset);
    if (dest[2] <= 0 || dest[3] <= 0) return;
    const op: ImageOp = { kind: 'image', node: node.id, asset: record.name, dest };
    if (record.nineSlice) {
      op.nineSlice = [...record.nineSlice];
      const own = node.nineSlice;
      if (own?.some((value, index) => value !== record.nineSlice?.[index])) {
        warnings.push(`节点 #${node.id} 的九宫边距与资产清单不一致，按资产清单画`);
      }
    } else if (node.nineSlice) {
      warnings.push(`节点 #${node.id} 的资产清单里没有九宫边距，整张拉伸`);
    }
    const tint = state?.tint ?? node.tint;
    if (tint !== undefined) op.tint = tint;
    ops.push(op);

    if (node.type === 'text' && node.decisions['text.mode']?.value === 'bitmap-font') {
      approximations.add(
        'bitmap-font',
        node.id,
        (ids, count) => `${count} 个位图字体文字按位图画（M1 的近似）：${ids}`,
      );
    }
  };

  const drawText = (node: UINode, state: StateOverride | undefined, rect: Rect): void => {
    const spec = node.text;
    const content = textContent(node, state, options);
    if (spec === undefined || content === undefined) {
      warnings.push(`文字节点 #${node.id} 没有文字内容，没有画`);
      return;
    }
    const named = spec.font;
    const file = named === undefined ? undefined : fonts[named];
    if (file === undefined) {
      approximations.add(
        `font:${named ?? ''}`,
        node.id,
        named === undefined
          ? (ids, count) => `${count} 个文字没有指定字体，用系统字体兜底：${ids}`
          : (ids, count) =>
              `字体 ${named} 没有对应的字体文件（项目配置 fonts），${count} 个文字用系统字体兜底：${ids}`,
      );
    }
    const op: TextOp = {
      kind: 'text',
      node: node.id,
      content,
      box: rect,
      font: {
        family: named ?? DEFAULT_FAMILY,
        size: Math.max(1, Math.round(spec.size ?? node.rect[3] * LINE_FILL)),
      },
      color: state?.text?.color ?? spec.color ?? DEFAULT_TEXT_COLOR,
      align: spec.align ?? { h: 'center', v: 'center' },
    };
    if (file !== undefined) op.font.file = file;
    if (spec.stroke) op.stroke = spec.stroke;
    if (spec.shadow) op.shadow = spec.shadow;
    ops.push(op);
  };

  const seen = new Set<string>();
  const visit = (id: string): void => {
    const node = doc.nodes[id];
    const rect = rects.get(id);
    if (!node || !rect || hidden.has(id) || seen.has(id)) return;
    seen.add(id);
    const state = stateOf(node);
    if (!(state?.visible ?? node.visible)) return;

    const owned = ownership.get(id);
    if (owned?.kind === 'asset') drawAsset(node, state, rect);
    else if (owned?.kind === 'text') drawText(node, state, rect);
    for (const child of node.children) visit(child);
  };
  visit(doc.root);

  return {
    width: viewport.width,
    height: viewport.height,
    ops,
    warnings: [...approximations.lines(), ...warnings],
  };
}
