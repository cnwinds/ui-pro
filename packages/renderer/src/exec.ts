/**
 * Draws a `DrawList` with nothing but the Canvas 2D interface. It imports no canvas package: the
 * Node session (`session.ts`) passes in a Skia context, Studio will pass the browser's, and both
 * run this same code (ADR 0002).
 */
import type { DrawList, ImageOp, PlaceholderOp, TextOp } from './types';

/** The parts of `CanvasRenderingContext2D` the renderer uses, so any implementation fits. */
export interface Canvas2D {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineJoin: string;
  font: string;
  textAlign: string;
  textBaseline: string;
  globalAlpha: number;
  globalCompositeOperation: string;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: string;
  save(): void;
  restore(): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  clip(): void;
  setLineDash(segments: number[]): void;
  // The image types differ between Skia, the browser and test doubles.
  // biome-ignore lint/suspicious/noExplicitAny: see above
  drawImage(image: any, ...args: number[]): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
}

/** A decoded asset: `source` is whatever `drawImage` takes. */
export interface DecodedImage {
  source: unknown;
  /** Pixels of the file. */
  width: number;
  height: number;
}

/** A scratch surface the size of one tinted asset. */
export interface Scratch {
  /** What `drawImage` takes. */
  canvas: unknown;
  ctx: Canvas2D;
}

export interface ExecEnv {
  image(asset: string): DecodedImage | undefined;
  /**
   * A copy of part of an image, pixel for pixel, kept for reuse. Nine-slice stretches these
   * pieces rather than the file, so smoothing at a piece's edge cannot pull in its neighbour.
   */
  crop(image: DecodedImage, x: number, y: number, width: number, height: number): DecodedImage;
  /** A transparent surface of at least this size; the same one may be handed out again later. */
  surface(width: number, height: number): Scratch;
}

/** Used when `text.font` names no font, or its file is missing: the first one installed wins. */
export const FALLBACK_FONT_STACK =
  '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", "SimHei", sans-serif';

const GENERIC_FAMILIES: ReadonlySet<string> = new Set(['sans-serif', 'serif', 'monospace']);

/** The CSS `font` of a text op at `scale` output pixels per design pixel. */
export function fontCss(font: TextOp['font'], scale: number): string {
  const own = GENERIC_FAMILIES.has(font.family) ? '' : `"${font.family}", `;
  return `${font.size * scale}px ${own}${FALLBACK_FONT_STACK}`;
}

/** Width in design pixels of `content` set in `font` on one line. */
export function measureTextWidth(ctx: Canvas2D, font: TextOp['font'], content: string): number {
  ctx.font = fontCss(font, 1);
  return ctx.measureText(content).width;
}

/** Placeholders are drawn in this colour so they cannot be mistaken for artwork. */
const PLACEHOLDER_COLOR = '#ff00ff';

const hex6 = (color: string): string => (color.length > 7 ? color.slice(0, 7) : color);

type Box = [number, number, number, number];

/** Pixel edges of `[x, y, w, h]` at `scale`, rounded so neighbouring pieces share edges. */
function edges(dest: readonly number[], scale: number): Box {
  const [x, y, w, h] = dest as Box;
  const x0 = Math.round(x * scale);
  const y0 = Math.round(y * scale);
  return [
    x0,
    y0,
    Math.max(1, Math.round((x + w) * scale) - x0),
    Math.max(1, Math.round((y + h) * scale) - y0),
  ];
}

function paintStretched(ctx: Canvas2D, image: DecodedImage, [x, y, w, h]: Box): void {
  ctx.drawImage(image.source, 0, 0, image.width, image.height, x, y, w, h);
}

/**
 * Nine-slice: the four corners keep their size (margins are file pixels, one per design pixel),
 * the four edges and the middle stretch. Margins shrink together when the destination is smaller
 * than they are.
 */
function paintNineSlice(
  ctx: Canvas2D,
  env: ExecEnv,
  image: DecodedImage,
  margins: readonly number[],
  [x, y, w, h]: Box,
  scale: number,
): void {
  const [left = 0, top = 0, right = 0, bottom = 0] = margins.map((margin) => Math.round(margin));
  const sl = Math.min(left, image.width);
  const sr = Math.min(right, image.width - sl);
  const st = Math.min(top, image.height);
  const sb = Math.min(bottom, image.height - st);

  const fit = Math.min(1, w / Math.max(1, (sl + sr) * scale), h / Math.max(1, (st + sb) * scale));
  const dl = Math.round(sl * scale * fit);
  const dr = Math.round(sr * scale * fit);
  const dt = Math.round(st * scale * fit);
  const db = Math.round(sb * scale * fit);

  const columns: Box[] = [
    [0, sl, x, dl],
    [sl, image.width - sl - sr, x + dl, w - dl - dr],
    [image.width - sr, sr, x + w - dr, dr],
  ];
  const rows: Box[] = [
    [0, st, y, dt],
    [st, image.height - st - sb, y + dt, h - dt - db],
    [image.height - sb, sb, y + h - db, db],
  ];
  for (const [sx, sw, dx, dw] of columns) {
    for (const [sy, sh, dy, dh] of rows) {
      if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) continue;
      const piece = env.crop(image, sx, sy, sw, sh);
      ctx.drawImage(piece.source, 0, 0, sw, sh, dx, dy, dw, dh);
    }
  }
}

function drawImageOp(ctx: Canvas2D, op: ImageOp, scale: number, env: ExecEnv): void {
  const image = env.image(op.asset);
  const box = edges(op.dest, scale);
  if (!image) {
    drawPlaceholder(
      ctx,
      { kind: 'placeholder', node: op.node, dest: op.dest, reason: `资产 ${op.asset} 没有加载` },
      scale,
    );
    return;
  }
  const [x, y, w, h] = box;
  const paint = (target: Canvas2D, at: Box) => {
    if (op.nineSlice) paintNineSlice(target, env, image, op.nineSlice, at, scale);
    else paintStretched(target, image, at);
  };

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (op.clip) {
    const [cx, cy, cw, ch] = edges(op.clip, scale);
    ctx.beginPath();
    ctx.rect(cx, cy, cw, ch);
    ctx.clip();
  }
  if (op.tint === undefined) {
    paint(ctx, box);
  } else {
    // Multiply the colour in, then cut the result to the asset's own alpha: RGB multiplies,
    // transparency stays.
    const scratch = env.surface(w, h);
    const target = scratch.ctx;
    const local: Box = [0, 0, w, h];
    target.save();
    target.globalCompositeOperation = 'source-over';
    target.clearRect(0, 0, w, h);
    target.imageSmoothingEnabled = true;
    target.imageSmoothingQuality = 'high';
    paint(target, local);
    target.globalCompositeOperation = 'multiply';
    target.fillStyle = hex6(op.tint);
    target.fillRect(0, 0, w, h);
    target.globalCompositeOperation = 'destination-in';
    paint(target, local);
    target.restore();
    ctx.drawImage(scratch.canvas, 0, 0, w, h, x, y, w, h);
  }
  ctx.restore();
}

function drawTextOp(ctx: Canvas2D, op: TextOp, scale: number): void {
  const [bx, by, bw, bh] = op.box;
  const { h, v } = op.align;
  const x = (h === 'left' ? bx : h === 'right' ? bx + bw : bx + bw / 2) * scale;
  const y = (v === 'top' ? by : v === 'bottom' ? by + bh : by + bh / 2) * scale;

  ctx.save();
  ctx.font = fontCss(op.font, scale);
  ctx.textAlign = h;
  ctx.textBaseline = v === 'center' ? 'middle' : v;
  ctx.lineJoin = 'round';
  if (op.shadow) {
    ctx.shadowColor = op.shadow.color;
    ctx.shadowOffsetX = op.shadow.offset[0] * scale;
    ctx.shadowOffsetY = op.shadow.offset[1] * scale;
    ctx.shadowBlur = (op.shadow.blur ?? 0) * scale;
  }
  if (op.stroke && op.stroke.width > 0) {
    // Godot's outline_size is how far the outline reaches outside the glyph; a canvas stroke is
    // centred on the glyph edge, so twice that width reaches as far (the fill covers the inside).
    ctx.lineWidth = op.stroke.width * 2 * scale;
    ctx.strokeStyle = op.stroke.color;
    ctx.strokeText(op.content, x, y);
    ctx.shadowColor = 'transparent';
  }
  ctx.fillStyle = op.color;
  ctx.fillText(op.content, x, y);
  ctx.restore();
}

function drawPlaceholder(ctx: Canvas2D, op: PlaceholderOp, scale: number): void {
  const [x, y, w, h] = edges(op.dest, scale);
  ctx.save();
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = PLACEHOLDER_COLOR;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = PLACEHOLDER_COLOR;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(x + 1, y + 1, Math.max(1, w - 2), Math.max(1, h - 2));
  ctx.setLineDash([]);
  ctx.font = `12px ${FALLBACK_FONT_STACK}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = PLACEHOLDER_COLOR;
  ctx.fillText(op.node, x + 3, y + 3);
  ctx.restore();
}

/**
 * Draws every op, back to front, onto `ctx`. The list is in design pixels; `scale` is output
 * pixels per design pixel.
 */
export function executeDrawList(ctx: Canvas2D, list: DrawList, scale: number, env: ExecEnv): void {
  for (const op of list.ops) {
    if (op.kind === 'image') drawImageOp(ctx, op, scale, env);
    else if (op.kind === 'text') drawTextOp(ctx, op, scale);
    else drawPlaceholder(ctx, op, scale);
  }
}
