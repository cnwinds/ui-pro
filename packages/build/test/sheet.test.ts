import { describe, expect, it } from 'vitest';
import { decodePng } from '../src/raster';
import { renderSheet } from '../src/sheet';
import { makeImage, pixelAt } from './support';

const BACKGROUND = [43, 43, 46, 255];
const LIGHT = [196, 196, 196, 255];
const DARK = [150, 150, 150, 255];
const INK = [240, 240, 240, 255];

/** The sheet of one and two assets: 12 px padding, 168 px cells with a 36 px label under each. */
describe('renderSheet', () => {
  const red = makeImage(4, 4, () => [255, 0, 0]);

  it('lays assets out on a checkerboard so transparency shows', async () => {
    const sheet = await decodePng(await renderSheet([{ name: 'img_red', image: red }]));

    expect([sheet.width, sheet.height]).toEqual([192, 228]);
    expect(pixelAt(sheet, 0, 0)).toEqual(BACKGROUND);
    expect(pixelAt(sheet, 12, 12)).toEqual(LIGHT);
    expect(pixelAt(sheet, 12 + 8, 12)).toEqual(DARK);
    expect(pixelAt(sheet, 12, 12 + 8)).toEqual(DARK);
  });

  it('centres a small asset, enlarged in whole steps, and a large one shrunk to fit', async () => {
    const big = makeImage(400, 100, () => [0, 0, 255]);

    const sheet = await decodePng(
      await renderSheet([
        { name: 'small', image: red },
        { name: 'big', image: big },
      ]),
    );

    expect(sheet.width).toBe(2 * 168 + 3 * 12);
    // 4x4 enlarged four times is 16x16, centred in the first cell.
    expect(pixelAt(sheet, 12 + 84, 12 + 84)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(sheet, 12 + 84 - 9, 12 + 84)).not.toEqual([255, 0, 0, 255]);
    // 400x100 shrinks to 168x42 in the second cell.
    const x = 12 + 168 + 12;
    expect(pixelAt(sheet, x + 84, 12 + 84)).toEqual([0, 0, 255, 255]);
    expect(pixelAt(sheet, x + 84, 12 + 84 + 30)).toEqual(LIGHT);
  });

  it('writes the asset name under each cell', async () => {
    const sheet = await decodePng(await renderSheet([{ name: 'img_red', image: red }]));

    let ink = 0;
    for (let y = 12 + 168; y < 12 + 168 + 36; y++) {
      for (let x = 12; x < 12 + 168; x++) {
        if (pixelAt(sheet, x, y).join() === INK.join()) ink++;
      }
    }
    const above = (() => {
      let count = 0;
      for (let x = 0; x < sheet.width; x++) if (pixelAt(sheet, x, 4).join() === INK.join()) count++;
      return count;
    })();
    expect(ink).toBeGreaterThan(40);
    expect(above).toBe(0);
  });

  it('wraps a long name over two lines and marks where it was cut', async () => {
    const sheet = await decodePng(
      await renderSheet([{ name: `img_${'x'.repeat(60)}`, image: red }]),
    );

    const rowHasInk = (y: number) => {
      for (let x = 12; x < 12 + 168; x++)
        if (pixelAt(sheet, x, y).join() === INK.join()) return true;
      return false;
    };
    // Two lines of text: ink on both the first and the second line's rows.
    expect(rowHasInk(12 + 168 + 3 + 6)).toBe(true);
    expect(rowHasInk(12 + 168 + 3 + 16 + 6)).toBe(true);
  });

  it('says there is nothing to show for an empty build', async () => {
    const sheet = await decodePng(await renderSheet([]));

    let ink = 0;
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < sheet.width; x++) if (pixelAt(sheet, x, y).join() === INK.join()) ink++;
    }
    expect(ink).toBeGreaterThan(30);
  });

  it('uses at most six columns', async () => {
    const entries = Array.from({ length: 9 }, (_, index) => ({ name: `a${index}`, image: red }));

    const sheet = await decodePng(await renderSheet(entries));

    expect(sheet.width).toBe(6 * 180 + 12);
    expect(sheet.height).toBe(2 * 216 + 12);
  });
});
