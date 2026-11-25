import { initializeCanvas, type Psd, readPsd, writePsdBuffer } from 'ag-psd';
import { describe, expect, it } from 'vitest';

function solid(width: number, height: number, rgba: [number, number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(rgba, offset);
  return { width, height, data };
}

describe('ag-psd in Node', () => {
  it('writes and reads a two-layer document without a canvas implementation', () => {
    const doc: Psd = {
      width: 4,
      height: 4,
      children: [
        { name: 'bg', left: 0, top: 0, imageData: solid(4, 4, [10, 20, 30, 255]) },
        { name: 'dot', left: 1, top: 1, imageData: solid(2, 2, [255, 0, 0, 255]) },
      ],
    };

    const bytes = writePsdBuffer(doc);
    // Reading needs the canvas factory hooks even though no canvas is ever drawn on.
    initializeCanvas(
      () => {
        throw new Error('canvas is not available in Node');
      },
      (width, height) => solid(width, height, [0, 0, 0, 0]) as ImageData,
    );
    const read = readPsd(bytes, { useImageData: true, skipCompositeImageData: true });

    expect([read.width, read.height]).toEqual([4, 4]);
    expect(read.children?.map((layer) => layer.name)).toEqual(['bg', 'dot']);
    const dot = read.children?.[1];
    expect([dot?.left, dot?.top, dot?.imageData?.width]).toEqual([1, 1, 2]);
    expect(Array.from(dot?.imageData?.data.slice(0, 4) ?? [])).toEqual([255, 0, 0, 255]);
  });
});
