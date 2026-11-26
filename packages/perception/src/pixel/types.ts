import type { EgressLevel, Rect } from '@ui-pro/core';

/** Straight (not premultiplied) RGBA pixels, row-major, 4 bytes per pixel. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** One byte per pixel; 255 is inside, 0 outside, values between are partial. */
export interface GrayMask {
  width: number;
  height: number;
  data: Uint8Array;
}

/** From the precheck's style profile: pixel art gets hard edges and nearest-neighbour scaling. */
export type ArtStyle = 'smooth' | 'pixel';

/** `draft` stays local and takes seconds; `final` may also use the cloud image model. */
export type Quality = 'draft' | 'final';

/** Who a request is for, written to the egress log and to error messages. */
export interface RequestLabel {
  screen: string;
  node: string;
}

/** A model output kept with the project (CONTEXT 锁定). */
export interface LockedOutput {
  /** Request key: hash of operation, model, input pixels and parameters. */
  key: string;
  /** `local:<catalog name>` or `cloud:<provider>/<model>`. */
  by: string;
  png: Uint8Array;
}

/**
 * Where model outputs are locked. The build implements it over `ui-pro.lock` and
 * `assets/gen/`; pixel ops look a request up before running any model and store what they ran.
 */
export interface GenerationStore {
  get(key: string): Promise<LockedOutput | undefined>;
  /** Locks a new output; `alternatives` are the candidates not chosen (constraint 5). */
  put(output: LockedOutput, alternatives?: readonly Uint8Array[]): Promise<void>;
  /** False under `build --locked`: a missing key is then an error instead of a model call. */
  readonly allowNew: boolean;
}

/** What every step reports besides its pixels; the build copies it into the asset's steps. */
export interface StepOutcome {
  /** e.g. `analytic`, `lama`, `grabcut`, `anime-seg`, `dashscope/wanx2.1-imageedit`. */
  method: string;
  /** Lock key of the model output used, when a model ran or a locked output was reused. */
  generated?: string;
  /** In Simplified Chinese. */
  warnings: string[];
}

export interface ExtractRequest {
  /** Pixels around the element at the working resolution, with some margin of what is beneath. */
  image: RgbaImage;
  /** The element's bounding box inside `image`. */
  box: Rect;
  /** A mask from analysis or from the build, same size as `image`, when one exists. */
  hint?: GrayMask;
  /**
   * `ui`: contours and GrabCut; `figure` (characters, mascots): the segmentation model; `text`
   * (bitmap text): the glyph ink, stroke and shadow included.
   */
  subject: 'ui' | 'figure' | 'text';
  style: ArtStyle;
  label: RequestLabel;
}

export interface ExtractResult extends StepOutcome {
  /** Same size as the request image: the element alone, background colour removed from soft edges. */
  image: RgbaImage;
  alpha: GrayMask;
}

export interface FillRequest {
  image: RgbaImage;
  /** 255 where pixels must be invented; same size as `image`. */
  hole: GrayMask;
  /** What belongs there, for the image model. */
  prompt?: string;
  quality: Quality;
  style: ArtStyle;
  label: RequestLabel;
}

export interface FillResult extends StepOutcome {
  /** Same size as the request; pixels outside the hole are exactly the input's. */
  image: RgbaImage;
  tier: 'analytic' | 'local' | 'cloud';
}

/** Text appearance measured from the glyph pixels, in the request image's pixels. */
export interface MeasuredTextStyle {
  /** `#rrggbb` of the glyph fill. */
  color: string;
  /** Font size in pixels that reproduces the glyph height. */
  size: number;
  stroke?: { color: string; width: number };
  shadow?: { color: string; offset: [number, number]; blur?: number };
}

export interface TextStripRequest {
  image: RgbaImage;
  /** Glyph pixels including stroke and shadow, same size as `image`; computed inside `box` when absent. */
  ink?: GrayMask;
  /** The text's bounding box inside `image`. */
  box: Rect;
  prompt?: string;
  quality: Quality;
  style: ArtStyle;
  label: RequestLabel;
}

export interface TextStripResult extends StepOutcome {
  /** The image with the text removed and what was under it filled in. */
  image: RgbaImage;
  measured: MeasuredTextStyle;
  tier: FillResult['tier'];
}

export interface UpscaleRequest {
  image: RgbaImage;
  /** Output size divided by input size; above 1. */
  factor: number;
  quality: Quality;
  style: ArtStyle;
  label: RequestLabel;
}

export interface UpscaleResult extends StepOutcome {
  /** `round(width * factor)` by `round(height * factor)`. */
  image: RgbaImage;
  /** SSIM of the result scaled back down against the input (detail must not be rewritten). */
  fidelity: number;
  tier: 'resample' | 'local' | 'cloud';
}

/** DESIGN §6.5 steps that need perception models; each tries the simplest method that works first. */
export interface PixelOps {
  extract(request: ExtractRequest): Promise<ExtractResult>;
  fill(request: FillRequest): Promise<FillResult>;
  stripText(request: TextStripRequest): Promise<TextStripResult>;
  upscale(request: UpscaleRequest): Promise<UpscaleResult>;
}

/** Capability declaration of a cloud image model (DESIGN §6.6). */
export interface ImageModelCapabilities {
  maskInput: boolean;
  transparentOutput: boolean;
  layerDecomposition: boolean;
  /** Each side of a sent image must be within these bounds, in pixels. */
  minSide: number;
  maxSide: number;
  /** Most candidates one call can return. */
  maxCandidates: number;
}

/** A cloud image model behind the Provider interface; raw service calls, no project knowledge. */
export interface CloudImageModel {
  /** `<provider>/<model>`, e.g. `dashscope/wanx2.1-imageedit`. */
  readonly id: string;
  readonly capabilities: ImageModelCapabilities;
  /** `mask` is white where to repaint; returns one PNG per candidate. */
  inpaint(request: {
    image: Uint8Array;
    mask: Uint8Array;
    prompt: string;
    candidates: number;
  }): Promise<Uint8Array[]>;
  removeText(request: {
    image: Uint8Array;
    prompt?: string;
    candidates: number;
  }): Promise<Uint8Array[]>;
  /** `factor` is an integer the service supports. */
  upscale(request: { image: Uint8Array; factor: number }): Promise<Uint8Array>;
}

/** One image or crop sent to a cloud service (constraint 8). */
export interface EgressRecord {
  /** ISO 8601. */
  at: string;
  /** `<provider>/<model>`. */
  model: string;
  purpose: 'inpaint' | 'remove-text' | 'upscale';
  screen: string;
  node: string;
  /** SHA-256 of every image sent in the call. */
  sha256: string[];
  bytes: number;
}

/** Project-level record of cloud calls; the build implements it over `history/egress.jsonl`. */
export interface EgressLog {
  append(record: EgressRecord): Promise<void>;
  /** Calls already made for a screen, for the per-screen budget (constraint 7). */
  count(screen: string): Promise<number>;
}

export interface PixelContext {
  store: GenerationStore;
  /** Null when the project's egress level is `local`, the provider is `none`, or no key is set. */
  cloud: CloudImageModel | null;
  egress: EgressLevel;
  log: EgressLog;
  /** `budget.image_calls_per_screen` from the project config. */
  budget: number;
  models: ModelStore;
  onProgress?: (message: string) => void;
}

/** Local perception model files, downloaded and verified on first use. */
export interface ModelStore {
  /** Absolute path of the model file; downloads it first when missing. */
  path(name: ModelName): Promise<string>;
  /** Whether the file is already present and verified, without downloading. */
  has(name: ModelName): Promise<boolean>;
}

export type ModelName = 'lama' | 'realesr-animevideov3' | 'anime-seg';
