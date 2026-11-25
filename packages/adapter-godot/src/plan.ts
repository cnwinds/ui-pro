import { type Primitive, preOrder, type ScreenDoc, type TextSpec, type UINode } from '@ui-pro/core';
import { assignNodeNames, toFileStem, toPascalCase } from './naming';

export type GodotClass =
  | 'Control'
  | 'TextureRect'
  | 'NinePatchRect'
  | 'TextureButton'
  | 'TextureProgressBar'
  | 'Label';

export type PropValue = string | number | boolean | number[];

/** One node of the builder's input; `props` are the properties the tool owns on re-export. */
export interface BuilderNode {
  id: string;
  parent: string | null;
  class: GodotClass;
  /** Applied once, when the node is created. */
  init: Record<string, PropValue>;
  props: Record<string, PropValue>;
}

/** The JSON file `builder.gd` reads. */
export interface BuilderSpec {
  version: 1;
  screen: string;
  /** `res://` path of the scene. */
  scene: string;
  /** Absolute path the builder writes its result to. */
  result: string;
  /** Parents before children, siblings back to front. */
  nodes: BuilderNode[];
}

export interface PlannedNode {
  id: string;
  name: string;
  type: Primitive;
  godot: GodotClass;
}

export interface Approximation {
  id: string;
  kind: 'font' | 'font-size' | 'button-text';
  detail: string;
}

export interface ExportPlan {
  screen: string;
  /** Scene path relative to the Godot project. */
  scene: string;
  nodes: BuilderNode[];
  planned: PlannedNode[];
  /** Nodes exported as a bare `Control` because their primitive has no mapping yet. */
  placeholders: { id: string; type: Primitive }[];
  approximations: Approximation[];
}

// Godot enum values, passed as numbers because the builder sets them with `Object.set`.
const MOUSE_FILTER_IGNORE = 2;
const EXPAND_IGNORE_SIZE = 1;
const STRETCH_SCALE = 0;

const TEXTURE_CLASSES: ReadonlySet<GodotClass> = new Set([
  'TextureRect',
  'NinePatchRect',
  'TextureButton',
  'TextureProgressBar',
]);

/** Primitives that map to a Godot class; the others are exported as a bare `Control`. */
const MAPPED_PRIMITIVES: readonly Primitive[] = [
  'container',
  'image',
  'text',
  'button',
  'progress',
];

export function godotClassOf(node: UINode): GodotClass {
  switch (node.type) {
    case 'image':
      return node.nineSlice === undefined ? 'TextureRect' : 'NinePatchRect';
    case 'text':
      return 'Label';
    case 'button':
      return 'TextureButton';
    case 'progress':
      return 'TextureProgressBar';
    default:
      return 'Control';
  }
}

/** Whether the node is drawn from a texture, so the export asks the asset source for one. */
export function wantsAsset(node: UINode): boolean {
  return TEXTURE_CLASSES.has(godotClassOf(node));
}

/** Directory of the screen's files, relative to the Godot project. */
export function screenDir(screen: string): string {
  return `ui/${toFileStem(screen)}`;
}

export function sceneFile(screen: string): string {
  return `${screenDir(screen)}/${toFileStem(screen)}.tscn`;
}

export function assetFile(screen: string, nodeId: string): string {
  return `${screenDir(screen)}/assets/${nodeId}.png`;
}

export function toResPath(relativePath: string): string {
  return `res://${relativePath}`;
}

function initProps(godot: GodotClass): Record<string, PropValue> {
  switch (godot) {
    case 'Control':
      return { mouse_filter: MOUSE_FILTER_IGNORE };
    case 'TextureRect':
      return { expand_mode: EXPAND_IGNORE_SIZE, stretch_mode: STRETCH_SCALE };
    case 'TextureButton':
      return { ignore_texture_size: true, stretch_mode: STRETCH_SCALE };
    case 'TextureProgressBar':
      return { nine_patch_stretch: true, min_value: 0, max_value: 100, value: 100 };
    default:
      return {};
  }
}

/** Font size of a line that fills a box this tall; Godot's line height is about 1.2 em. */
const LINE_FILL = 0.8;

function estimatedFontSize(node: UINode): number {
  return Math.max(1, Math.round(node.rect[3] * LINE_FILL));
}

function textProps(node: UINode, spec: TextSpec): Record<string, PropValue> {
  const props: Record<string, PropValue> = {
    text: spec.content,
    h_align: spec.align?.h ?? 'center',
    v_align: spec.align?.v ?? 'center',
    font_size: Math.max(1, Math.round(spec.size ?? estimatedFontSize(node))),
    font_color: (spec.color ?? '#ffffffff').toLowerCase(),
    outline_size: Math.round(spec.stroke?.width ?? 0),
    shadow_color: (spec.shadow?.color ?? '#00000000').toLowerCase(),
  };
  if (spec.stroke) props.outline_color = spec.stroke.color.toLowerCase();
  if (spec.shadow) {
    props.shadow_offset = [...spec.shadow.offset];
    props.shadow_size = Math.max(1, Math.round(spec.shadow.blur ?? 1));
  }
  return props;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * `[left, top, right, bottom]` offsets from the parent's top-left corner, in design pixels. The
 * scene root has no parent and sits at the origin.
 */
function offsets(node: UINode, parent: UINode | undefined): number[] {
  const [x, y, w, h] = node.rect;
  const [parentX, parentY] = parent === undefined ? [x, y] : parent.rect;
  const left = round2(x - parentX);
  const top = round2(y - parentY);
  return [left, top, round2(left + w), round2(top + h)];
}

/**
 * Turns a screen into the builder's input. `assets` holds the ids of nodes that have a texture
 * file (`assetFile`); texture nodes without one are exported with their texture cleared.
 */
export function planExport(doc: ScreenDoc, assets: ReadonlySet<string>): ExportPlan {
  const ids = preOrder(doc);
  const rootName = toPascalCase(doc.name);
  const names = assignNodeNames(
    ids.filter((id) => id !== doc.root),
    [rootName],
  );
  names.set(doc.root, rootName);

  const nodes: BuilderNode[] = [];
  const planned: PlannedNode[] = [];
  const placeholders: ExportPlan['placeholders'] = [];
  const approximations: Approximation[] = [];

  for (const id of ids) {
    const node = doc.nodes[id];
    if (node === undefined) continue;
    const isRoot = id === doc.root;
    const parent = isRoot || node.parent === null ? undefined : doc.nodes[node.parent];
    const godot = godotClassOf(node);
    const name = names.get(id) ?? toPascalCase(id);

    const props: Record<string, PropValue> = {
      name,
      rect: offsets(node, parent),
      visible: node.visible,
    };
    if (TEXTURE_CLASSES.has(godot)) {
      props.texture = assets.has(id) ? toResPath(assetFile(doc.name, id)) : '';
    }
    if (godot === 'NinePatchRect' && node.nineSlice) props.patch_margin = [...node.nineSlice];
    if (godot === 'Label' && node.text) Object.assign(props, textProps(node, node.text));

    if (node.text?.font !== undefined && godot === 'Label') {
      approximations.push({
        id,
        kind: 'font',
        detail: `字体 ${node.text.font} 没有写入 Godot 工程，文字使用 Godot 默认字体`,
      });
    }
    if (godot === 'Label' && node.text !== undefined && node.text.size === undefined) {
      approximations.push({
        id,
        kind: 'font-size',
        detail: `没有字号，按框高估算为 ${estimatedFontSize(node)}`,
      });
    }
    if (node.type === 'button' && node.text !== undefined) {
      approximations.push({
        id,
        kind: 'button-text',
        detail: '按钮自带的文字没有导出；请把文字放到按钮的子节点里',
      });
    }
    if (!MAPPED_PRIMITIVES.includes(node.type)) placeholders.push({ id, type: node.type });

    nodes.push({
      id,
      parent: isRoot ? null : node.parent,
      class: godot,
      init: initProps(godot),
      props,
    });
    planned.push({ id, name, type: node.type, godot });
  }

  return {
    screen: doc.name,
    scene: sceneFile(doc.name),
    nodes,
    planned,
    placeholders,
    approximations,
  };
}
