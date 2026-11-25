import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { meanAbsDiff, referenceCropSource } from '../src';
import { makeDoc, nodeAt } from './helpers';

/** 100x100 reference: left half red, right half green; the bottom row blue. */
async function reference(): Promise<Buffer> {
  const width = 100;
  const height = 100;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      const color = y === height - 1 ? [0, 0, 255] : x < 50 ? [255, 0, 0] : [0, 255, 0];
      pixels.set(color, at);
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

function png(asset: { png: Uint8Array } | undefined): Uint8Array {
  if (asset === undefined) throw new Error('expected an asset');
  return asset.png;
}

async function pixelAt(png: Uint8Array, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return [...data.subarray(at, at + 3)];
}

describe('referenceCropSource', () => {
  // Source 100px wide, design 200px wide: design pixels are twice the source pixels.
  const doc = makeDoc(
    [
      { id: 'right', type: 'image', parent: 'root', rect: [100, 0, 100, 100] },
      { id: 'left_btn', type: 'button', parent: 'root', rect: [0, 0, 60, 40] },
      { id: 'group', type: 'container', parent: 'root', rect: [0, 0, 200, 200] },
      { id: 'parent_img', type: 'image', parent: 'root', rect: [0, 100, 50, 50] },
      { id: 'child', type: 'image', parent: 'parent_img', rect: [0, 100, 10, 10] },
      { id: 'label', type: 'text', parent: 'root', rect: [0, 0, 40, 20], text: { content: 'x' } },
      { id: 'outside', type: 'image', parent: 'root', rect: [500, 500, 20, 20] },
      { id: 'edge', type: 'image', parent: 'root', rect: [180, 190, 60, 40] },
    ],
    { scale: 2, size: [200, 200] },
  );

  it('cuts the node box out of the reference and scales it to design pixels', async () => {
    const source = await referenceCropSource(doc, await reference());

    const asset = await source(nodeAt(doc, 'right'));

    expect(asset?.approximate).toBe(true);
    const meta = await sharp(png(asset)).metadata();
    expect([meta.width, meta.height]).toEqual([100, 100]);
    expect(await pixelAt(png(asset), 5, 5)).toEqual([0, 255, 0]);
    expect(await pixelAt(png(asset), 95, 40)).toEqual([0, 255, 0]);
  });

  it('crops a button the same way', async () => {
    const source = await referenceCropSource(doc, await reference());

    const asset = await source(nodeAt(doc, 'left_btn'));

    const meta = await sharp(png(asset)).metadata();
    expect([meta.width, meta.height]).toEqual([60, 40]);
    expect(await pixelAt(png(asset), 30, 20)).toEqual([255, 0, 0]);
  });

  it('gives nothing to containers and text', async () => {
    const source = await referenceCropSource(doc, await reference());

    expect(await source(nodeAt(doc, 'group'))).toBeUndefined();
    expect(await source(nodeAt(doc, 'label'))).toBeUndefined();
  });

  it('crops a node that has children, child pixels included', async () => {
    const source = await referenceCropSource(doc, await reference());

    const parent = await source(nodeAt(doc, 'parent_img'));

    expect(await pixelAt(png(parent), 2, 2)).toEqual([255, 0, 0]);
    expect(await source(nodeAt(doc, 'child'))).toBeDefined();
  });

  it('gives nothing for a box entirely outside the reference', async () => {
    const source = await referenceCropSource(doc, await reference());

    expect(await source(nodeAt(doc, 'outside'))).toBeUndefined();
  });

  it('clips a box that sticks out and still returns design-sized pixels', async () => {
    const source = await referenceCropSource(doc, await reference());

    const asset = await source(nodeAt(doc, 'edge'));

    const meta = await sharp(png(asset)).metadata();
    expect([meta.width, meta.height]).toEqual([60, 40]);
  });
});

describe('meanAbsDiff', () => {
  const solid = (value: number, width = 4, height = 4) =>
    sharp({ create: { width, height, channels: 3, background: { r: value, g: value, b: value } } })
      .png()
      .toBuffer();

  it('is 0 for identical images and 1 for black against white', async () => {
    expect(await meanAbsDiff(await solid(90), await solid(90), 4, 4)).toBe(0);
    expect(await meanAbsDiff(await solid(0), await solid(255), 4, 4)).toBe(1);
  });

  it('scales the images to the same size first', async () => {
    const diff = await meanAbsDiff(await solid(0, 2, 2), await solid(51, 10, 10), 8, 8);

    expect(diff).toBeCloseTo(0.2, 5);
  });

  it('puts transparent pixels on black', async () => {
    const clear = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 0 },
      },
    })
      .png()
      .toBuffer();

    expect(await meanAbsDiff(clear, await solid(0, 2, 2), 2, 2)).toBe(0);
  });
});
