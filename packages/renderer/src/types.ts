import type { Rect, TextSpec } from '@ui-pro/core';

/** Design-space screen size to lay the screen out in; the screen's design size by default. */
export interface Viewport {
  width: number;
  height: number;
  /** Insets `[left, top, right, bottom]` in design pixels that notches and bars cover. */
  safeArea?: [number, number, number, number];
}

export interface RenderOptions {
  /** Output pixels per design pixel; defaults to `1 / screen.scale`, the reference image's size. */
  scale?: number;
  viewport?: Viewport;
  /** Nodes drawn hidden, with their subtrees (hide test). */
  hidden?: readonly string[];
  /** Node id -> state name whose overrides apply. */
  states?: Readonly<Record<string, string>>;
  /** Node id -> text content, replacing `text.content` and bindings (text gate). */
  text?: Readonly<Record<string, string>>;
  /** Data for bindings; defaults to the screen's `mock.json`. */
  mock?: unknown;
  /** Fill behind everything, `#rrggbb[aa]`; transparent when absent. */
  background?: string;
}

/** An asset drawn into a design-space rectangle. */
export interface ImageOp {
  kind: 'image';
  node: string;
  asset: string;
  dest: Rect;
  /** Margins `[left, top, right, bottom]` in file pixels; stretches the middle only. */
  nineSlice?: [number, number, number, number];
  /** Multiply colour. */
  tint?: string;
  /** Only this design-space part is drawn (progress fill, masks). */
  clip?: Rect;
}

export interface TextOp {
  kind: 'text';
  node: string;
  content: string;
  box: Rect;
  /** Family name; `file` is set when the project's `fonts` maps it to a font file. */
  font: { family: string; file?: string; size: number };
  color: string;
  stroke?: NonNullable<TextSpec['stroke']>;
  shadow?: NonNullable<TextSpec['shadow']>;
  align: NonNullable<TextSpec['align']>;
}

/** A node with nothing to draw yet (no asset built, `surface`, `anim`): an outlined box. */
export interface PlaceholderOp {
  kind: 'placeholder';
  node: string;
  dest: Rect;
  reason: string;
}

export type DrawOp = ImageOp | TextOp | PlaceholderOp;

/** Everything one frame draws, back to front, in design pixels. Pure data, shared with Studio. */
export interface DrawList {
  width: number;
  height: number;
  ops: DrawOp[];
  /** Approximations made while building the list, in Simplified Chinese (missing font, asset). */
  warnings: string[];
}

export interface RenderResult {
  png: Uint8Array;
  /** The same pixels, straight RGBA. */
  width: number;
  height: number;
  data: Uint8Array;
  list: DrawList;
  /** Node id -> laid-out rectangle in design pixels for this viewport. */
  rects: ReadonlyMap<string, Rect>;
}

/** Assets and fonts loaded once, then many frames rendered (the hide test renders one per node). */
export interface RenderSession {
  render(options?: RenderOptions): Promise<RenderResult>;
  dispose(): void;
}
