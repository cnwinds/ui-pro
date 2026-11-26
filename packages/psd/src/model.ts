import type { Rect } from '@ui-pro/core';
import type { RgbaImage } from './image';

export type LayerKind = 'pixel' | 'text' | 'smart' | 'shape' | 'group';

/** Text properties in source pixels; `color` is `#rrggbb`. */
export interface PsdText {
  content: string;
  font?: string;
  size?: number;
  color?: string;
  stroke?: { color: string; width: number };
  shadow?: { color: string; offset: [number, number]; blur: number };
  /** The layer mixes fonts or sizes; the first run is what the fields above describe. */
  mixedStyles: boolean;
}

export interface PsdLayer {
  /** The PSD's layer identifier, or a number assigned here for files that lack one. */
  id: number;
  name: string;
  kind: LayerKind;
  hidden: boolean;
  /** At least one layer style is switched on. */
  hasEffects: boolean;
  blendMode: string;
  /** Clipped to the layer below it. */
  clipping: boolean;
  hasMask: boolean;
  adjustment: boolean;
  artboard: boolean;
  /** The layer's own pixel box in source pixels; `null` for groups and empty layers. */
  box: Rect | null;
  text?: PsdText;
  /** Identifier of the smart object source, shared by all instances of it. */
  smartSource?: string;
  /** Bottom to top, as the PSD stores them. */
  children?: PsdLayer[];
  /** Position in `children` order from the document root down to this layer. */
  index: number[];
  /** Layer names from the top-level layer down to this one. */
  path: string[];
}

export interface PsdDocument {
  bytes: Uint8Array;
  sha256: string;
  width: number;
  height: number;
  colorMode: number;
  bitsPerChannel: number;
  iccProfile?: Uint8Array;
  hasArtboards: boolean;
  /** The embedded composite, `null` when the file carries none that can be used. */
  composite: RgbaImage | null;
  /** Top-level layers, bottom to top. */
  layers: PsdLayer[];
}

export interface LayerVisit {
  layer: PsdLayer;
  /** Enclosing groups, outermost first. */
  ancestors: PsdLayer[];
}

/** Every layer in z-order (bottom to top), a group before its children. */
export function* walkLayers(
  layers: readonly PsdLayer[],
  ancestors: PsdLayer[] = [],
): Generator<LayerVisit> {
  for (const layer of layers) {
    yield { layer, ancestors };
    if (layer.children) yield* walkLayers(layer.children, [...ancestors, layer]);
  }
}

export function layersById(layers: readonly PsdLayer[]): Map<number, PsdLayer> {
  return new Map([...walkLayers(layers)].map(({ layer }) => [layer.id, layer]));
}

export function layerPath(layer: PsdLayer): string {
  return layer.path.join(' / ');
}

/** Whether the layer is shown in the PSD's saved state: it and its groups are all visible. */
export function isDefaultVisible({ layer, ancestors }: LayerVisit): boolean {
  return !layer.hidden && ancestors.every((group) => !group.hidden);
}
