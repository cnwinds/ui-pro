import type { RgbaImage } from '@ui-pro/perception';
import {
  SHEET_CELL,
  SHEET_CHECKER,
  SHEET_COLUMNS,
  SHEET_LABEL_HEIGHT,
  SHEET_PAD,
} from './constants';
import { blankImage, encodePng, pasteOver, resizeImage } from './raster';

/** 5x7 glyphs, rows separated by `|`. Labels are drawn in capitals; no system font is involved. */
const GLYPHS: Record<string, string> = {
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#',
  B: '####.|#...#|#...#|####.|#...#|#...#|####.',
  C: '.###.|#...#|#....|#....|#....|#...#|.###.',
  D: '####.|#...#|#...#|#...#|#...#|#...#|####.',
  E: '#####|#....|#....|####.|#....|#....|#####',
  F: '#####|#....|#....|####.|#....|#....|#....',
  G: '.###.|#...#|#....|#.###|#...#|#...#|.###.',
  H: '#...#|#...#|#...#|#####|#...#|#...#|#...#',
  I: '.###.|..#..|..#..|..#..|..#..|..#..|.###.',
  J: '..###|...#.|...#.|...#.|...#.|#..#.|.##..',
  K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#',
  L: '#....|#....|#....|#....|#....|#....|#####',
  M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#',
  N: '#...#|##..#|#.#.#|#..##|#...#|#...#|#...#',
  O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.',
  P: '####.|#...#|#...#|####.|#....|#....|#....',
  Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#',
  R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  S: '.####|#....|#....|.###.|....#|....#|####.',
  T: '#####|..#..|..#..|..#..|..#..|..#..|..#..',
  U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.',
  V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
  W: '#...#|#...#|#...#|#.#.#|#.#.#|##.##|#...#',
  X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..',
  Z: '#####|....#|...#.|..#..|.#...|#....|#####',
  '0': '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.',
  '1': '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
  '2': '.###.|#...#|....#|...#.|..#..|.#...|#####',
  '3': '.###.|#...#|....#|..##.|....#|#...#|.###.',
  '4': '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.',
  '5': '#####|#....|####.|....#|....#|#...#|.###.',
  '6': '..##.|.#...|#....|####.|#...#|#...#|.###.',
  '7': '#####|....#|...#.|..#..|.#...|.#...|.#...',
  '8': '.###.|#...#|#...#|.###.|#...#|#...#|.###.',
  '9': '.###.|#...#|#...#|.####|....#|...#.|.##..',
  _: '.....|.....|.....|.....|.....|.....|#####',
  '-': '.....|.....|.....|#####|.....|.....|.....',
  '.': '.....|.....|.....|.....|.....|.##..|.##..',
  '#': '.#.#.|.#.#.|#####|.#.#.|#####|.#.#.|.#.#.',
  ' ': '.....|.....|.....|.....|.....|.....|.....',
};

const GLYPH_SCALE = 2;
const GLYPH_ADVANCE = 6 * GLYPH_SCALE;
const GLYPH_HEIGHT = 7 * GLYPH_SCALE;
const LINES = 2;

const BACKGROUND: [number, number, number] = [43, 43, 46];
const CHECKER: [[number, number, number], [number, number, number]] = [
  [196, 196, 196],
  [150, 150, 150],
];
const INK: [number, number, number] = [240, 240, 240];

function fillRect(
  image: RgbaImage,
  x: number,
  y: number,
  w: number,
  h: number,
  [r, g, b]: [number, number, number],
): void {
  for (let row = Math.max(0, y); row < Math.min(image.height, y + h); row++) {
    for (let col = Math.max(0, x); col < Math.min(image.width, x + w); col++) {
      image.data.set([r, g, b, 255], (row * image.width + col) * 4);
    }
  }
}

function drawText(image: RgbaImage, x: number, y: number, text: string): void {
  let cursor = x;
  for (const char of text.toUpperCase()) {
    const rows = (GLYPHS[char] ?? GLYPHS['.'] ?? '').split('|');
    rows.forEach((row, ry) => {
      [...row].forEach((cell, rx) => {
        if (cell === '#') {
          fillRect(
            image,
            cursor + rx * GLYPH_SCALE,
            y + ry * GLYPH_SCALE,
            GLYPH_SCALE,
            GLYPH_SCALE,
            INK,
          );
        }
      });
    });
    cursor += GLYPH_ADVANCE;
  }
}

/** The label split over `LINES` lines of what fits a cell; the end is marked with `.` if cut. */
function wrap(label: string): string[] {
  const perLine = Math.floor(SHEET_CELL / GLYPH_ADVANCE);
  const lines: string[] = [];
  for (let line = 0; line < LINES; line++) {
    const part = label.slice(line * perLine, (line + 1) * perLine);
    if (part !== '') lines.push(part);
  }
  if (label.length > perLine * LINES) {
    const last = lines.pop() ?? '';
    lines.push(`${last.slice(0, perLine - 1)}.`);
  }
  return lines;
}

async function fitted(image: RgbaImage): Promise<RgbaImage> {
  const scale = Math.min(SHEET_CELL / image.width, SHEET_CELL / image.height);
  if (scale >= 1) {
    const factor = Math.min(4, Math.floor(scale));
    return factor === 1
      ? image
      : resizeImage(image, image.width * factor, image.height * factor, 'nearest');
  }
  return resizeImage(
    image,
    Math.max(1, Math.round(image.width * scale)),
    Math.max(1, Math.round(image.height * scale)),
  );
}

export interface SheetEntry {
  name: string;
  image: RgbaImage;
}

/**
 * The asset overview (DESIGN §6.5 视图): every asset on a checkerboard, so transparency shows,
 * with its name underneath. Small assets are enlarged in whole steps, large ones shrunk to fit.
 */
export async function renderSheet(entries: readonly SheetEntry[]): Promise<Uint8Array> {
  const columns = Math.max(1, Math.min(SHEET_COLUMNS, entries.length));
  const rows = Math.max(1, Math.ceil(entries.length / columns));
  const cellHeight = SHEET_CELL + SHEET_LABEL_HEIGHT;
  const sheet = blankImage(
    columns * (SHEET_CELL + SHEET_PAD) + SHEET_PAD,
    rows * (cellHeight + SHEET_PAD) + SHEET_PAD,
  );
  fillRect(sheet, 0, 0, sheet.width, sheet.height, BACKGROUND);
  if (entries.length === 0) drawText(sheet, SHEET_PAD, SHEET_PAD, 'NO ASSETS');

  for (const [index, entry] of entries.entries()) {
    const x = SHEET_PAD + (index % columns) * (SHEET_CELL + SHEET_PAD);
    const y = SHEET_PAD + Math.floor(index / columns) * (cellHeight + SHEET_PAD);
    for (let cy = 0; cy < SHEET_CELL; cy += SHEET_CHECKER) {
      for (let cx = 0; cx < SHEET_CELL; cx += SHEET_CHECKER) {
        const shade = CHECKER[(cx / SHEET_CHECKER + cy / SHEET_CHECKER) % 2] ?? CHECKER[0];
        fillRect(sheet, x + cx, y + cy, SHEET_CHECKER, SHEET_CHECKER, shade);
      }
    }
    const picture = await fitted(entry.image);
    pasteOver(
      sheet,
      picture,
      x + Math.floor((SHEET_CELL - picture.width) / 2),
      y + Math.floor((SHEET_CELL - picture.height) / 2),
    );
    wrap(entry.name).forEach((line, lineIndex) => {
      drawText(sheet, x, y + SHEET_CELL + 3 + lineIndex * (GLYPH_HEIGHT + 2), line);
    });
  }
  return encodePng(sheet);
}
