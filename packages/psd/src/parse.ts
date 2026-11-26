import { type Rect, sha256Hex, UiProError } from '@ui-pro/core';
import {
  type Color,
  initializeCanvas,
  type Layer,
  type LayerEffectsInfo,
  type Psd,
  type ReadOptions,
  readPsd,
} from 'ag-psd';
import { PsdErrorCodes } from './errors';
import type { RgbaImage } from './image';
import type { LayerKind, PsdDocument, PsdLayer, PsdText } from './model';

let canvasReady = false;

/** ag-psd needs the canvas hooks even when no canvas is ever drawn on. */
function ensureCanvasHooks(): void {
  if (canvasReady) return;
  canvasReady = true;
  initializeCanvas(
    () => {
      throw new Error('canvas is not available in Node');
    },
    (width, height) =>
      ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData,
  );
}

function assignMissingIds(layers: Layer[]): void {
  const used = new Set<number>();
  const missing: Layer[] = [];
  let max = 0;
  const visit = (list: Layer[]) => {
    for (const layer of list) {
      if (layer.id === undefined || used.has(layer.id)) missing.push(layer);
      else {
        used.add(layer.id);
        max = Math.max(max, layer.id);
      }
      if (layer.children) visit(layer.children);
    }
  };
  visit(layers);
  for (const layer of missing) layer.id = ++max;
}

/** Reads a PSD with ag-psd; every layer of the result has a unique `id`. */
export function readAgPsd(bytes: Uint8Array, options: ReadOptions = {}): Psd {
  ensureCanvasHooks();
  let psd: Psd;
  try {
    psd = readPsd(bytes, { useImageData: true, skipThumbnail: true, ...options });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new UiProError(PsdErrorCodes.unreadable, `无法读取 PSD：${reason}`, {
      hint: '确认文件是 Photoshop 保存的 .psd（不是 .psb，也没有损坏）',
      cause,
    });
  }
  assignMissingIds(psd.children ?? []);
  return psd;
}

function kindOf(layer: Layer): LayerKind {
  if (layer.children !== undefined) return 'group';
  if (layer.text !== undefined) return 'text';
  if (layer.placedLayer !== undefined) return 'smart';
  if (layer.vectorFill !== undefined || layer.vectorOrigination !== undefined) return 'shape';
  return 'pixel';
}

const EFFECT_FLAG_KEYS = new Set(['scale', 'disabled']);

function hasEnabledEffects(effects: LayerEffectsInfo | undefined): boolean {
  if (effects === undefined || effects.disabled) return false;
  return Object.entries(effects).some(([key, value]) => {
    if (EFFECT_FLAG_KEYS.has(key) || typeof value !== 'object' || value === null) return false;
    const items: { enabled?: boolean }[] = Array.isArray(value) ? value : [value];
    return items.some((item) => item.enabled !== false);
  });
}

function hex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, '0');
}

function colorHex(color: Color | undefined): string | undefined {
  if (color === undefined) return undefined;
  if ('r' in color && 'g' in color && 'b' in color) {
    return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
  }
  if ('fr' in color) return `#${hex(color.fr * 255)}${hex(color.fg * 255)}${hex(color.fb * 255)}`;
  return undefined;
}

/** Vertical scale of the text transform; Photoshop stores the document resolution in it. */
function textScale(transform: number[] | undefined): number {
  if (transform === undefined || transform.length < 4) return 1;
  const scale = Math.hypot(transform[2] ?? 0, transform[3] ?? 1);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function textOf(layer: Layer): PsdText | undefined {
  const text = layer.text;
  if (text === undefined) return undefined;
  const runs = (text.styleRuns ?? []).filter((run) => run.length > 0);
  const styles = (runs.length > 0 ? runs : [{ length: 1, style: {} }]).map((run) => ({
    ...text.style,
    ...run.style,
  }));
  const first = styles[0] ?? {};
  const distinct = new Set(styles.map((style) => `${style.font?.name}|${style.fontSize}`));
  const size =
    first.fontSize === undefined ? undefined : first.fontSize * textScale(text.transform);
  return {
    content: text.text.replaceAll('\r', '\n').replaceAll('\u0003', '\n'),
    font: first.font?.name,
    size: size === undefined ? undefined : Math.round(size * 100) / 100,
    color: colorHex(first.fillColor),
    mixedStyles: distinct.size > 1,
  };
}

function boxOf(layer: Layer): Rect | null {
  const { left = 0, top = 0, right = 0, bottom = 0 } = layer;
  return right > left && bottom > top ? [left, top, right - left, bottom - top] : null;
}

function convertLayers(layers: Layer[], index: number[], path: string[]): PsdLayer[] {
  return layers.map((layer, position) => {
    const name = layer.name ?? '';
    const here = { index: [...index, position], path: [...path, name] };
    const kind = kindOf(layer);
    return {
      id: layer.id ?? 0,
      name,
      kind,
      hidden: layer.hidden === true,
      hasEffects: hasEnabledEffects(layer.effects),
      blendMode: layer.blendMode ?? 'normal',
      clipping: layer.clipping === true,
      hasMask: layer.mask !== undefined,
      adjustment: layer.adjustment !== undefined,
      artboard: layer.artboard !== undefined,
      box: kind === 'group' ? null : boxOf(layer),
      text: textOf(layer),
      smartSource: layer.placedLayer?.id,
      children: layer.children && convertLayers(layer.children, here.index, here.path),
      ...here,
    };
  });
}

function compositeOf(psd: Psd): RgbaImage | null {
  const image = psd.imageData;
  if (image === undefined || psd.imageResources?.versionInfo?.hasRealMergedData === false) {
    return null;
  }
  if (image.width !== psd.width || image.height !== psd.height) return null;
  if (!(image.data instanceof Uint8ClampedArray || image.data instanceof Uint8Array)) return null;
  const { data } = image;
  return {
    width: image.width,
    height: image.height,
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  };
}

function hasArtboards(psd: Psd): boolean {
  const found = (layers: Layer[]): boolean =>
    layers.some((layer) => layer.artboard !== undefined || found(layer.children ?? []));
  return (psd.artboards?.count ?? 0) > 0 || found(psd.children ?? []);
}

/** The PSD's structure, file properties and embedded composite; layer pixels are not read. */
export function parsePsd(bytes: Uint8Array): PsdDocument {
  const psd = readAgPsd(bytes, { skipLayerImageData: true });
  return {
    bytes,
    sha256: sha256Hex(bytes),
    width: psd.width,
    height: psd.height,
    colorMode: psd.colorMode ?? 3,
    bitsPerChannel: psd.bitsPerChannel ?? 8,
    iccProfile: psd.imageResources?.iccProfile,
    hasArtboards: hasArtboards(psd),
    composite: compositeOf(psd),
    layers: convertLayers(psd.children ?? [], [], []),
  };
}
