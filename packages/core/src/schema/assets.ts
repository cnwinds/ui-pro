import { z } from 'zod';
import {
  ColorSchema,
  NodeIdSchema,
  PairSchema,
  RectSchema,
  ScreenNameSchema,
  Sha256Schema,
  StateNameSchema,
} from './common';

/** What `naming.asset` produces and `node.asset` / `states.*.asset` refer to. */
export const ASSET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,95}$/;
export const AssetNameSchema = z
  .string()
  .regex(ASSET_NAME_PATTERN, '资产名须匹配 [a-z0-9][a-z0-9_-]{0,95}');

/** Where an asset's pixels came from (CONTEXT 资产：裁切、补全、生成、图层、用户提供). */
export const ASSET_ORIGINS = [
  'crop',
  'layer',
  'derived',
  'generated',
  'user',
  'placeholder',
] as const;

/** The steps of DESIGN §6.5, in the order the build runs them. */
export const BUILD_STEPS = [
  'extract',
  'fill',
  'text-strip',
  'upscale',
  'nine-slice',
  'dedupe',
  'state',
  'tidy',
] as const;
export type BuildStep = (typeof BUILD_STEPS)[number];

export const AssetStepSchema = z.strictObject({
  step: z.enum(BUILD_STEPS),
  /** How, e.g. `grabcut`, `analytic`, `lama`, `dashscope/wanx2.1-imageedit`, `layer-render`. */
  method: z.string().min(1),
  /** Key into `ui-pro.lock` `generated` when the step used a perception model's locked output. */
  generated: Sha256Schema.optional(),
  /** Part of the file the step changed, in file pixels; absent when it applies to all of it. */
  region: RectSchema.optional(),
  detail: z.string().optional(),
});
export type AssetStep = z.infer<typeof AssetStepSchema>;

/** One node (or one state of a node) drawn with the asset. */
export const AssetUseSchema = z.strictObject({
  node: NodeIdSchema,
  /** Absent for the node's default look. */
  state: StateNameSchema.optional(),
  /** Multiply colour for `variant.mode: tint` instances; the same value is on the node. */
  tint: ColorSchema.optional(),
});
export type AssetUse = z.infer<typeof AssetUseSchema>;

/** What the build did with the asset's pixels under an element drawn above it. */
export const AssetHoleSchema = z.strictObject({
  node: NodeIdSchema,
  /** `filled`: invented; `kept`: original pixels left (occlusion.fill none); `stripped`: text removed and filled. */
  handling: z.enum(['filled', 'kept', 'stripped']),
  /** Area in file pixels. */
  region: RectSchema,
});
export type AssetHole = z.infer<typeof AssetHoleSchema>;

export const AssetRecordSchema = z.strictObject({
  name: AssetNameSchema,
  /** Posix path relative to the screen's `assets/` directory. */
  file: z.string().min(1),
  origin: z.enum(ASSET_ORIGINS),
  uses: z.array(AssetUseSchema).min(1),
  /** Width and height of the file in pixels. */
  size: PairSchema,
  /**
   * Design-pixel insets `[left, top, right, bottom]` from each using node's `rect` to the area the
   * file covers; negative values reach outside the rect (glows). Trimming transparent margins
   * makes them positive.
   */
  inset: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  /** Nine-slice margins `[left, top, right, bottom]` in file pixels (engine patch margins). */
  nineSlice: z
    .tuple([
      z.number().nonnegative(),
      z.number().nonnegative(),
      z.number().nonnegative(),
      z.number().nonnegative(),
    ])
    .optional(),
  holes: z.array(AssetHoleSchema).default([]),
  steps: z.array(AssetStepSchema),
  atlas: z.string().optional(),
  sha256: Sha256Schema,
  /** What is only approximately right, in Simplified Chinese; the export report lists these. */
  approximations: z.array(z.string()).default([]),
});
export type AssetRecord = z.infer<typeof AssetRecordSchema>;

/** `screens/<screen>/assets/manifest.json`: every asset of a screen and how it was made. */
export const AssetManifestSchema = z.strictObject({
  format: z.literal('ui-pro/assets'),
  version: z.literal(1),
  screen: ScreenNameSchema,
  /** The source file the assets were cut from. */
  sourceSha256: Sha256Schema,
  /** Hash of everything the build read; a different current value means the assets are stale. */
  inputsSha256: Sha256Schema,
  assets: z
    .array(AssetRecordSchema)
    .refine(
      (assets) => new Set(assets.map((asset) => asset.name)).size === assets.length,
      '资产名不能重复',
    ),
});
export type AssetManifest = z.infer<typeof AssetManifestSchema>;

/** A perception model's output kept with the project (CONTEXT 锁定). */
export const GeneratedEntrySchema = z.strictObject({
  /** Project-relative posix path, under `screens/<screen>/assets/gen/`. */
  file: z.string().min(1),
  sha256: Sha256Schema,
  /** Which model made it: `local:lama`, `cloud:dashscope/wanx2.1-imageedit`. */
  by: z.string().min(1),
  /** ISO 8601 time of the model call. */
  at: z.string().min(1),
  /** Candidates not chosen (constraint 5), so the user can swap one in later. */
  alternatives: z
    .array(z.strictObject({ file: z.string().min(1), sha256: Sha256Schema }))
    .default([]),
});
export type GeneratedEntry = z.infer<typeof GeneratedEntrySchema>;

export const LockedModelSchema = z.strictObject({
  sha256: Sha256Schema,
  /** Where the file was downloaded from. */
  source: z.string().min(1),
});

/** `ui-pro.lock`: tool and model versions, and the hash of every locked model output. */
export const LockDocSchema = z.strictObject({
  format: z.literal('ui-pro/lock'),
  version: z.literal(1),
  /** ui-pro version that last wrote the file. */
  tool: z.string().min(1),
  /** Local perception models by catalog name. */
  models: z.record(z.string(), LockedModelSchema).default({}),
  /** Request key (hash of operation, model, input pixels and parameters) -> locked output. */
  generated: z.record(Sha256Schema, GeneratedEntrySchema).default({}),
});
export type LockDoc = z.infer<typeof LockDocSchema>;
