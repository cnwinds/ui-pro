import { createCanvas, ImageData } from '@napi-rs/canvas';
import { FALLBACK_FONT_STACK } from './exec';

/** Straight (not premultiplied) RGBA pixels. */
export interface SheetImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface SheetCell {
  image: SheetImage;
  label?: string;
  /** Fill under the image, `#rrggbb`; transparent when absent. */
  backdrop?: string;
  /** Whole-number magnification, nearest neighbour; 1 by default. */
  zoom?: number;
}

export interface SheetOptions {
  /** Cells per row; all of them in one row by default. */
  columns?: number;
  gap?: number;
  /** Colour behind the cells. */
  background?: string;
  labelSize?: number;
}

export interface Sheet {
  png: Uint8Array;
  width: number;
  height: number;
}

/**
 * Lays images out on a grid with labels, for pictures the gates hand to people (reference |
 * rebuild | difference, assets on dark and light grounds). Cells share one size, the largest.
 */
export function composeSheet(cells: readonly SheetCell[], options: SheetOptions = {}): Sheet {
  const gap = options.gap ?? 8;
  const labelSize = options.labelSize ?? 14;
  const columns = Math.max(1, Math.min(options.columns ?? cells.length, cells.length));
  const rows = Math.max(1, Math.ceil(cells.length / columns));
  const zoomOf = (cell: SheetCell) => Math.max(1, Math.round(cell.zoom ?? 1));

  const cellWidth = Math.max(1, ...cells.map((cell) => cell.image.width * zoomOf(cell)));
  const cellHeight = Math.max(1, ...cells.map((cell) => cell.image.height * zoomOf(cell)));
  const labelHeight = cells.some((cell) => cell.label) ? labelSize + 6 : 0;
  const width = columns * cellWidth + (columns + 1) * gap;
  const height = rows * (cellHeight + labelHeight) + (rows + 1) * gap;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = options.background ?? '#3a3a3a';
  ctx.fillRect(0, 0, width, height);
  ctx.font = `${labelSize}px ${FALLBACK_FONT_STACK}`;
  ctx.textBaseline = 'top';

  cells.forEach((cell, index) => {
    const x = gap + (index % columns) * (cellWidth + gap);
    const y = gap + Math.floor(index / columns) * (cellHeight + labelHeight + gap);
    const zoom = zoomOf(cell);
    if (cell.label) {
      ctx.fillStyle = '#ffffff';
      ctx.fillText(cell.label, x, y);
    }
    const top = y + labelHeight;
    const { image } = cell;
    if (cell.backdrop) {
      ctx.fillStyle = cell.backdrop;
      ctx.fillRect(x, top, image.width * zoom, image.height * zoom);
    }
    const source = createCanvas(image.width, image.height);
    source
      .getContext('2d')
      .putImageData(
        new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
        0,
        0,
      );
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(source, x, top, image.width * zoom, image.height * zoom);
  });

  return { png: canvas.toBuffer('image/png'), width, height };
}
