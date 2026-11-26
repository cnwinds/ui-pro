import type { AssetHole, AssetStep, AssetUse } from '@ui-pro/core';
import type { MeasuredTextStyle, RgbaImage } from '@ui-pro/perception';
import type { SliceMargins } from './nine-slice';
import type { PlannedAsset } from './plan';

export type Inset = [number, number, number, number];

/** One asset's pixels and everything the manifest will say about them, before dedupe. */
export interface BuiltAsset {
  node: string;
  plan: PlannedAsset;
  origin: 'crop' | 'layer' | 'generated' | 'placeholder';
  /** The file: after the nine-slice cut, with bleed. */
  image: RgbaImage;
  /** Design-pixel insets from the node's rect to the area the file covers. */
  inset: Inset;
  nineSlice?: SliceMargins;
  holes: AssetHole[];
  steps: AssetStep[];
  /** Each begins with the decision point it is about. */
  approximations: string[];
  /** Pixels that had to be invented (hole area); the fewer, the better a master. */
  invented: number;
}

/** An asset of the manifest, with every node (and state) that draws it. */
export interface FinalAsset {
  origin: 'crop' | 'layer' | 'generated' | 'placeholder' | 'derived';
  image: RgbaImage;
  inset: Inset;
  nineSlice?: SliceMargins;
  holes: AssetHole[];
  steps: AssetStep[];
  approximations: string[];
  uses: AssetUse[];
  atlas?: string;
  /** The plan of the node that owns the picture: its name template and type. */
  owner: PlannedAsset;
  /** The state this asset is the picture of, when it is not the default look. */
  state?: string;
}

/** An approximation with the node it was found for, for the report. */
export interface Approximation {
  node: string;
  message: string;
}

/** What a text strip measured, with the area of the asset it was measured on. */
export interface TextMeasurement {
  node: string;
  /** Area of the owner's rect in design pixels: the smaller, the closer the backdrop. */
  ownerArea: number;
  measured: MeasuredTextStyle;
}
