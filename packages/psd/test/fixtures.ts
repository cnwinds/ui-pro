import { type Layer, type Psd, writePsdBuffer } from 'ag-psd';

export type Rgba = [number, number, number, number];
export type Box = [number, number, number, number];

export const SMART_SOURCE = '20953ddb-9391-11ec-b4f1-c15674f50bc4';

function solid(width: number, height: number, rgba: Rgba) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(rgba, offset);
  return { width, height, data };
}

export function pixel(name: string, [x, y, w, h]: Box, rgba: Rgba, extra: Layer = {}): Layer {
  return { name, left: x, top: y, imageData: solid(w, h, rgba), ...extra };
}

export function group(name: string, children: Layer[], extra: Layer = {}): Layer {
  return { name, children, ...extra };
}

/** An instance of the smart object `source`; instances share the id. */
export function smart(name: string, box: Box, rgba: Rgba, source = SMART_SOURCE): Layer {
  const [x, y, w, h] = box;
  return pixel(name, box, rgba, {
    placedLayer: {
      id: source,
      placed: source,
      type: 'unknown',
      transform: [x, y, x + w, y, x + w, y + h, x, y + h],
      width: w,
      height: h,
      resolution: { value: 72, units: 'Pixels' },
    },
  });
}

export function text(
  name: string,
  box: Box,
  content: string,
  rgba: Rgba = [255, 220, 80, 255],
  fontSize = 24,
): Layer {
  const [x, y] = box;
  return pixel(name, box, rgba, {
    text: {
      text: content,
      transform: [1, 0, 0, 1, x, y + fontSize],
      style: {
        font: { name: 'ArialMT' },
        fontSize,
        fillColor: { r: rgba[0], g: rgba[1], b: rgba[2] },
      },
    },
  });
}

interface Pixels {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

function drawLayer(canvas: Float32Array, width: number, height: number, layer: Layer): void {
  const image = layer.imageData as Pixels | undefined;
  if (image === undefined || layer.hidden === true) return;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const px = (layer.left ?? 0) + x;
      const py = (layer.top ?? 0) + y;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const from = (y * image.width + x) * 4;
      const to = (py * width + px) * 4;
      const alpha = (image.data[from + 3] ?? 0) / 255;
      for (let c = 0; c < 3; c++) {
        canvas[to + c] = (image.data[from + c] ?? 0) * alpha + (canvas[to + c] ?? 0) * (1 - alpha);
      }
      canvas[to + 3] = alpha + (canvas[to + 3] ?? 0) * (1 - alpha);
    }
  }
}

function flatten(layers: Layer[], canvas: Float32Array, width: number, height: number): void {
  for (const layer of layers) {
    if (layer.hidden === true) continue;
    if (layer.children !== undefined) flatten(layer.children, canvas, width, height);
    else drawLayer(canvas, width, height, layer);
  }
}

/** The composite of opaque, unstyled layers: what Photoshop would store. */
function composite(width: number, height: number, layers: Layer[]) {
  const canvas = new Float32Array(width * height * 4);
  flatten(layers, canvas, width, height);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex++) {
    const at = pixelIndex * 4;
    const alpha = canvas[at + 3] ?? 0;
    if (alpha === 0) continue;
    for (let c = 0; c < 3; c++) data[at + c] = Math.round((canvas[at + c] ?? 0) / alpha);
    data[at + 3] = Math.round(alpha * 255);
  }
  return { width, height, data };
}

export interface PsdOptions {
  width: number;
  height: number;
  /** Mark the file as saved without a usable composite (no "maximize compatibility"). */
  noComposite?: boolean;
  /** Changes the stored composite, to make it differ from what the layers add up to. */
  alter?: (composite: { width: number; height: number; data: Uint8ClampedArray }) => void;
}

/** Paints a block of the composite with an opaque colour. */
export function paintBlock(
  image: { width: number; data: Uint8ClampedArray },
  [x, y, w, h]: Box,
  rgba: Rgba,
): void {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) image.data.set(rgba, (row * image.width + col) * 4);
  }
}

export function psdBytes(layers: Layer[], options: PsdOptions): Uint8Array {
  const { width, height } = options;
  const stored = composite(width, height, layers);
  options.alter?.(stored);
  const doc: Psd = {
    width,
    height,
    children: layers,
    imageData: stored,
    ...(options.noComposite
      ? {
          imageResources: {
            versionInfo: {
              hasRealMergedData: false,
              writerName: 'test',
              readerName: 'test',
              fileVersion: 1,
            },
          },
        }
      : {}),
  };
  return writePsdBuffer(doc);
}

export const DESIGN = { width: 200, height: 320 };

/**
 * A file that follows the delivery spec, on a 200x320 canvas:
 *
 *     bg_main
 *     btn_upgrade
 *     |- base, badge_dot (dot), @pressed (hidden)
 *     txt_gold
 *     slot_equip_1..3 (each an instance of one smart object)
 */
export function compliantLayers(): Layer[] {
  return [
    pixel('bg_main', [0, 0, 200, 320], [20, 24, 40, 255]),
    group('btn_upgrade', [
      pixel('base', [20, 240, 120, 40], [40, 120, 220, 255]),
      group('badge_dot', [pixel('dot', [130, 236, 12, 12], [230, 40, 40, 255])]),
      pixel('@pressed', [20, 240, 120, 40], [20, 70, 150, 255], { hidden: true }),
    ]),
    text('txt_gold', [20, 20, 90, 30], '12,345'),
    group('slot_equip_1', [smart('icon', [20, 100, 40, 40], [200, 160, 40, 255])]),
    group('slot_equip_2', [smart('icon', [80, 100, 40, 40], [200, 160, 40, 255])]),
    group('slot_equip_3', [smart('icon', [140, 100, 40, 40], [200, 160, 40, 255])]),
  ];
}

export function compliantPsd(): Uint8Array {
  return psdBytes(compliantLayers(), DESIGN);
}

/**
 * Breaks the delivery spec three ways: a group without a prefix, a canvas that is not the design
 * resolution, and no composite.
 */
export function brokenPsd(): Uint8Array {
  return psdBytes(
    [
      pixel('bg_main', [0, 0, 100, 160], [20, 24, 40, 255]),
      group('Group 1', [pixel('Layer 2', [10, 100, 60, 20], [40, 120, 220, 255])]),
    ],
    { width: 100, height: 160, noComposite: true },
  );
}
