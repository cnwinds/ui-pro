import {
  type Anchor,
  type AssetManifest,
  type AssetRecord,
  type Ownership,
  type Primitive,
  pixelOwnership,
  preOrder,
  type ScreenDoc,
  type TextSpec,
  type UINode,
} from '@ui-pro/core';
import { assignNodeNames, toFileStem, toPascalCase } from './naming';

export type GodotClass =
  | 'Control'
  | 'TextureRect'
  | 'NinePatchRect'
  | 'TextureButton'
  | 'Button'
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
  /** Name of the tool-owned child that draws the asset when the node cannot (see `ART_SUFFIX`). */
  art?: string;
}

export type ApproximationKind =
  | 'asset'
  | 'font'
  | 'font-size'
  | 'button-text'
  | 'bitmap-font'
  | 'state';

/** What the export only does approximately. `source` says whose limit it is. */
export interface Approximation {
  source: 'assets' | 'export';
  kind: ApproximationKind;
  /** In Simplified Chinese. */
  detail: string;
  /** The nodes concerned. */
  nodes: string[];
}

/** An asset file the export puts into the Godot project. */
export interface PlannedAsset {
  name: string;
  /** Path relative to the Godot project. */
  file: string;
  record: AssetRecord;
  /** Nodes that draw it, default look or a state. */
  nodes: string[];
}

export interface MissingAsset {
  id: string;
  /** In Simplified Chinese. */
  reason: string;
}

export interface ExportPlan {
  screen: string;
  /** Scene path relative to the Godot project. */
  scene: string;
  nodes: BuilderNode[];
  planned: PlannedNode[];
  /** Nodes exported as a bare `Control` because their primitive has no mapping yet. */
  placeholders: { id: string; type: Primitive }[];
  /** Nodes that should draw an asset but have none (or none that can be read). */
  missing: MissingAsset[];
  assets: PlannedAsset[];
  approximations: Approximation[];
}

export interface PlanOptions {
  /** The screen's asset manifest; `null` before the first build. */
  manifest?: AssetManifest | null;
  /** Names of the assets whose files exist; every asset of the manifest when absent. */
  files?: ReadonlySet<string>;
  /** Font name -> `res://` path of the font file the export copies into the Godot project. */
  fonts?: Readonly<Record<string, string>>;
  /** Pixel-art style: textures are sampled with the nearest texel, not blended. */
  pixelArt?: boolean;
}

/** Id and name suffix of the child that draws a node's asset when the node's own rect cannot. */
export const ART_SUFFIX = ':art';
const ART_NAME_SUFFIX = 'Art';

// Godot enum values, passed as numbers because the builder sets them with `Object.set`.
const MOUSE_FILTER_IGNORE = 2;
const FOCUS_NONE = 0;
const EXPAND_IGNORE_SIZE = 1;
const STRETCH_SCALE = 0;
const TEXTURE_FILTER_NEAREST = 1;
const TEXTURE_FILTER_LINEAR = 2;

/** Primitives with no pixels of their own; they are never drawn with an asset. */
const NO_PIXELS: readonly Primitive[] = ['container', 'instance', 'particle'];

/** Button states Godot has a texture for, and the builder key that carries it. */
const STATE_KEYS: Readonly<Record<string, string>> = {
  pressed: 'texture_pressed',
  hover: 'texture_hover',
  disabled: 'texture_disabled',
  focus: 'texture_focused',
  focused: 'texture_focused',
};

/** `Button` draws the four states it has a style for; `focused` is not one of them. */
const STYLE_KEYS: readonly string[] = ['texture_pressed', 'texture_hover', 'texture_disabled'];

/** `layout.anchor` values as horizontal and vertical anchors (DESIGN §9.5, spec 11). */
const POSITION_ANCHORS: Readonly<Record<string, Anchor>> = {
  'top-left': { h: 'left', v: 'top' },
  top: { h: 'center', v: 'top' },
  'top-right': { h: 'right', v: 'top' },
  left: { h: 'left', v: 'center' },
  center: { h: 'center', v: 'center' },
  right: { h: 'right', v: 'center' },
  'bottom-left': { h: 'left', v: 'bottom' },
  bottom: { h: 'center', v: 'bottom' },
  'bottom-right': { h: 'right', v: 'bottom' },
  stretch: { h: 'stretch', v: 'stretch' },
  fill: { h: 'stretch', v: 'stretch' },
};

const TOP_LEFT: Anchor = { h: 'left', v: 'top' };

/**
 * How a node holds on to its parent: its own `anchor`, else the `layout.anchor` decision, else
 * the top-left corner. The reference renderer reads it the same way.
 */
export function anchorOf(node: UINode): Anchor {
  if (node.anchor) return node.anchor;
  const decided = node.decisions['layout.anchor']?.value;
  return (decided === undefined ? undefined : POSITION_ANCHORS[decided]) ?? TOP_LEFT;
}

/** Directory of the screen's files, relative to the Godot project. */
export function screenDir(screen: string): string {
  return `ui/${toFileStem(screen)}`;
}

export function sceneFile(screen: string): string {
  return `${screenDir(screen)}/${toFileStem(screen)}.tscn`;
}

/** An asset's texture, one file per asset however many nodes use it. */
export function assetFile(screen: string, assetName: string): string {
  return `${screenDir(screen)}/assets/${assetName}.png`;
}

/** Fonts are shared by the screens of a Godot project. */
export function fontFile(fontName: string, extension: string): string {
  const stem = fontName.replace(/[\\/:*?"<>|\s]+/g, '_');
  return `ui/fonts/${stem}${extension}`;
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
    case 'Button':
      return { focus_mode: FOCUS_NONE };
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

function textProps(
  node: UINode,
  spec: TextSpec,
  fontPath: string | undefined,
): Record<string, PropValue> {
  const props: Record<string, PropValue> = {
    text: spec.content,
    h_align: spec.align?.h ?? 'center',
    v_align: spec.align?.v ?? 'center',
    font_size: Math.max(1, Math.round(spec.size ?? estimatedFontSize(node))),
    font_color: (spec.color ?? '#ffffffff').toLowerCase(),
    outline_size: Math.round(spec.stroke?.width ?? 0),
    shadow_color: (spec.shadow?.color ?? '#00000000').toLowerCase(),
  };
  if (fontPath !== undefined) props.font = fontPath;
  if (spec.stroke) props.outline_color = spec.stroke.color.toLowerCase();
  if (spec.shadow) {
    props.shadow_offset = [...spec.shadow.offset];
    props.shadow_size = Math.max(1, Math.round(spec.shadow.blur ?? 1));
  }
  return props;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

type Axis = Anchor['h'] | Anchor['v'];

/** Anchors (start, end) and offsets from them, in design pixels, for one axis. */
function axisLayout(
  mode: Axis,
  start: number,
  size: number,
  parentStart: number,
  parentSize: number,
): { anchors: [number, number]; offsets: [number, number] } {
  const end = start + size;
  switch (mode) {
    case 'right':
    case 'bottom': {
      const edge = parentStart + parentSize;
      return { anchors: [1, 1], offsets: [round2(start - edge), round2(end - edge)] };
    }
    case 'center': {
      const middle = parentStart + parentSize / 2;
      return { anchors: [0.5, 0.5], offsets: [round2(start - middle), round2(end - middle)] };
    }
    case 'stretch':
      return {
        anchors: [0, 1],
        offsets: [round2(start - parentStart), round2(end - (parentStart + parentSize))],
      };
    default:
      return { anchors: [0, 0], offsets: [round2(start - parentStart), round2(end - parentStart)] };
  }
}

/**
 * `anchors` (`[left, top, right, bottom]`, 0 / 0.5 / 1) and the `offsets` from them, in design
 * pixels. Godot places a node at anchor + offset, so at the design size the node sits exactly on
 * its `rect`, and when the parent changes size it follows the anchor the way `layoutScreen` does.
 * The scene root fills the viewport.
 */
export function layoutProps(
  node: UINode,
  parent: UINode | undefined,
): { anchors: number[]; rect: number[] } {
  if (parent === undefined) return { anchors: [0, 0, 1, 1], rect: [0, 0, 0, 0] };
  const anchor = anchorOf(node);
  const [x, y, w, h] = node.rect;
  const horizontal = axisLayout(anchor.h, x, w, parent.rect[0], parent.rect[2]);
  const vertical = axisLayout(anchor.v, y, h, parent.rect[1], parent.rect[3]);
  return {
    anchors: [
      horizontal.anchors[0],
      vertical.anchors[0],
      horizontal.anchors[1],
      vertical.anchors[1],
    ],
    rect: [horizontal.offsets[0], vertical.offsets[0], horizontal.offsets[1], vertical.offsets[1]],
  };
}

/** `#rrggbb[aa]` as `#rrggbbff`: a tint multiplies the colour and leaves transparency alone. */
function opaqueTint(color: string): string {
  return `${color.slice(0, 7).toLowerCase()}ff`;
}

const hasInset = (record: AssetRecord): boolean => record.inset.some((value) => value !== 0);

/** Collects approximations, merging the nodes of equal ones. */
class Notes {
  private readonly items = new Map<string, Approximation>();

  add(source: Approximation['source'], kind: ApproximationKind, detail: string, node: string) {
    const key = `${source}|${kind}|${detail}`;
    const found = this.items.get(key);
    if (found) {
      if (!found.nodes.includes(node)) found.nodes.push(node);
    } else {
      this.items.set(key, { source, kind, detail, nodes: [node] });
    }
  }

  list(): Approximation[] {
    return [...this.items.values()];
  }
}

/**
 * Turns a screen into the builder's input. A node draws an asset when `pixelOwnership` says so;
 * `baked` and text nodes are exported without a texture. Nodes whose asset cannot sit in the
 * node's own rectangle (a non-zero `inset`) draw it in a tool-owned child, so the node itself,
 * its anchors and its click area stay on `rect`.
 */
export function planExport(doc: ScreenDoc, options: PlanOptions = {}): ExportPlan {
  const records = new Map((options.manifest?.assets ?? []).map((record) => [record.name, record]));
  const fonts = options.fonts ?? {};
  const ownership = pixelOwnership(doc);
  const ids = preOrder(doc);
  const rootName = toPascalCase(doc.name);
  const names = assignNodeNames(
    ids.filter((id) => id !== doc.root),
    [rootName],
  );
  names.set(doc.root, rootName);
  const usedNames = new Set(names.values());

  const nodes: BuilderNode[] = [];
  const planned: PlannedNode[] = [];
  const placeholders: ExportPlan['placeholders'] = [];
  const missing: MissingAsset[] = [];
  const notes = new Notes();
  const used = new Map<string, PlannedAsset>();

  const lookup = (name: string): { record?: AssetRecord; reason?: string } => {
    const record = records.get(name);
    if (!record) return { reason: `资产 ${name} 不在资产清单里` };
    if (options.files && !options.files.has(name)) {
      return { reason: `资产 ${name} 的文件不存在` };
    }
    return { record };
  };
  const use = (record: AssetRecord, node: string): string => {
    const found = used.get(record.name);
    if (found) {
      if (!found.nodes.includes(node)) found.nodes.push(node);
    } else {
      used.set(record.name, {
        name: record.name,
        file: assetFile(doc.name, record.name),
        record,
        nodes: [node],
      });
    }
    return toResPath(assetFile(doc.name, record.name));
  };

  for (const id of ids) {
    const node = doc.nodes[id];
    if (node === undefined) continue;
    const isRoot = id === doc.root;
    const parent = isRoot || node.parent === null ? undefined : doc.nodes[node.parent];
    const own: Ownership = ownership.get(id) ?? { kind: 'none' };
    const name = names.get(id) ?? toPascalCase(id);
    const draws = own.kind === 'asset' && !NO_PIXELS.includes(node.type);

    // The asset of the default look, and of each state the node has a texture for.
    let normal: AssetRecord | undefined;
    if (draws) {
      if (node.asset === undefined) {
        missing.push({ id, reason: '还没有资产' });
      } else {
        const found = lookup(node.asset);
        normal = found.record;
        if (found.reason) missing.push({ id, reason: found.reason });
      }
    }
    const stateRecords = new Map<string, AssetRecord>();
    for (const [state, override] of Object.entries(node.states ?? {})) {
      const key = STATE_KEYS[state];
      const exported = draws && node.type === 'button' && key !== undefined;
      if (exported && override.asset !== undefined) {
        const found = lookup(override.asset);
        if (found.record) {
          stateRecords.set(key, found.record);
          continue;
        }
        if (found.reason) missing.push({ id, reason: `状态 ${state}：${found.reason}` });
      }
      notes.add(
        'export',
        'state',
        exported
          ? `状态 ${state} 没有资产，M1 不补出这个状态，按 press.feedback 由运行时处理`
          : `状态 ${state} 没有导出：M1 只导出按钮的 pressed、hover、disabled 资产`,
        id,
      );
    }

    // Where an asset cannot sit in the node's own rectangle, or needs margins, a button becomes a
    // `Button` with texture style boxes and anything else draws in a child.
    const nine = normal ? normal.nineSlice : draws ? node.nineSlice : undefined;
    const inset = normal?.inset;
    const insetState = [normal, ...stateRecords.values()].some(
      (record) => record !== undefined && hasInset(record),
    );
    const styled = nine !== undefined || insetState;
    const imageClass: GodotClass = nine ? 'NinePatchRect' : 'TextureRect';

    let godot: GodotClass;
    let art = false;
    switch (node.type) {
      case 'container':
      case 'instance':
      case 'particle':
        godot = 'Control';
        break;
      case 'text':
        godot = own.kind === 'text' ? 'Label' : draws ? imageClass : 'Control';
        break;
      case 'button':
        godot = normal && styled ? 'Button' : 'TextureButton';
        break;
      case 'progress':
        godot = 'TextureProgressBar';
        art = normal !== undefined && styled;
        break;
      case 'image':
        godot = imageClass;
        break;
      default:
        godot = 'Control';
        art = normal !== undefined;
        placeholders.push({ id, type: node.type });
    }
    if (insetState && (godot === 'TextureRect' || godot === 'NinePatchRect')) {
      godot = 'Control';
      art = true;
    }
    if (godot === 'Button' && stateRecords.has('texture_focused')) {
      notes.add('export', 'state', '状态 focus 没有导出：Button 的样式盒没有对应的焦点状态', id);
    }

    const layout = layoutProps(node, parent);
    const props: Record<string, PropValue> = {
      name,
      anchors: layout.anchors,
      rect: layout.rect,
      visible: node.visible,
    };

    const tint = opaqueTint(node.tint ?? '#ffffff');
    const texturePath = normal ? use(normal, id) : '';
    switch (godot) {
      case 'TextureRect':
      case 'NinePatchRect':
        props.texture = texturePath;
        props.tint = tint;
        if (godot === 'NinePatchRect') props.patch_margin = [...(nine ?? [0, 0, 0, 0])];
        break;
      case 'TextureButton':
        props.texture = texturePath;
        for (const key of Object.values(STATE_KEYS)) {
          const record = stateRecords.get(key);
          if (record) props[key] = use(record, id);
        }
        props.tint = tint;
        break;
      case 'Button': {
        props.texture = texturePath;
        for (const key of STYLE_KEYS) {
          const record = stateRecords.get(key);
          props[key] = record ? use(record, id) : texturePath;
          if (record && inset && record.inset.some((value, index) => value !== inset[index])) {
            notes.add(
              'export',
              'state',
              `状态资产的 inset 与常态不同，Button 的样式盒按常态的 inset 画`,
              id,
            );
          }
        }
        props.patch_margin = [...(nine ?? [0, 0, 0, 0])];
        props.expand = (inset ?? [0, 0, 0, 0]).map((value) => (value === 0 ? 0 : -value));
        props.tint = tint;
        break;
      }
      case 'TextureProgressBar':
        if (!art) props.texture = texturePath;
        break;
      default:
        break;
    }

    let fontPath: string | undefined;
    if (godot === 'Label' && node.text) {
      const named = node.text.font;
      if (named !== undefined) {
        fontPath = fonts[named];
        if (fontPath === undefined) {
          notes.add(
            'export',
            'font',
            `字体 ${named} 没有对应的字体文件（项目配置 fonts），文字使用 Godot 默认字体`,
            id,
          );
        }
      }
      Object.assign(props, textProps(node, node.text, fontPath));
      if (node.text.size === undefined) {
        notes.add('export', 'font-size', `没有字号，按框高估算为 ${estimatedFontSize(node)}`, id);
      }
    }
    if (node.type === 'button' && node.text !== undefined) {
      notes.add('export', 'button-text', '按钮自带的文字没有导出；请把文字放到按钮的子节点里', id);
    }
    if (node.type === 'text' && node.decisions['text.mode']?.value === 'bitmap-font') {
      notes.add('export', 'bitmap-font', '位图字体文字按位图图片导出（M1 的近似）', id);
    }
    if (isRoot) {
      props.texture_filter = options.pixelArt ? TEXTURE_FILTER_NEAREST : TEXTURE_FILTER_LINEAR;
    }

    nodes.push({
      id,
      parent: isRoot ? null : node.parent,
      class: godot,
      init: initProps(godot),
      props,
    });
    const entry: PlannedNode = { id, name, type: node.type, godot };

    if (art && normal) {
      const artName = uniqueName(usedNames, `${name}${ART_NAME_SUFFIX}`);
      const artNine = normal.nineSlice;
      const artProps: Record<string, PropValue> = {
        name: artName,
        anchors: [0, 0, 1, 1],
        rect: [
          normal.inset[0],
          normal.inset[1],
          normal.inset[2] === 0 ? 0 : -normal.inset[2],
          normal.inset[3] === 0 ? 0 : -normal.inset[3],
        ],
        visible: true,
        texture: texturePath,
        tint,
      };
      if (artNine) artProps.patch_margin = [...artNine];
      nodes.push({
        id: `${id}${ART_SUFFIX}`,
        parent: id,
        class: artNine ? 'NinePatchRect' : 'TextureRect',
        init: {
          ...initProps(artNine ? 'NinePatchRect' : 'TextureRect'),
          mouse_filter: MOUSE_FILTER_IGNORE,
        },
        props: artProps,
      });
      entry.art = artName;
    }
    planned.push(entry);
  }

  for (const asset of used.values()) {
    for (const detail of asset.record.approximations) {
      for (const node of asset.nodes) notes.add('assets', 'asset', detail, node);
    }
  }
  return {
    screen: doc.name,
    scene: sceneFile(doc.name),
    nodes,
    planned,
    placeholders,
    missing,
    assets: [...used.values()],
    approximations: notes.list(),
  };
}

function uniqueName(used: Set<string>, base: string): string {
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
  used.add(name);
  return name;
}
