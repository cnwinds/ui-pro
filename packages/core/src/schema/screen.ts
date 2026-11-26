import { z } from 'zod';
import {
  ColorSchema,
  ComponentNameSchema,
  ConceptNameSchema,
  PairSchema,
  PrimitiveSchema,
  RectSchema,
  RoleSchema,
  Sha256Schema,
  VariesSchema,
} from './common';

export const TextSpecSchema = z.strictObject({
  content: z.string(),
  kind: z.enum(['value', 'label', 'title']).optional(),
  font: z.string().optional(),
  size: z.number().positive().optional(),
  color: ColorSchema.optional(),
  stroke: z.strictObject({ color: ColorSchema, width: z.number().nonnegative() }).optional(),
  shadow: z
    .strictObject({
      color: ColorSchema,
      offset: PairSchema,
      blur: z.number().nonnegative().optional(),
    })
    .optional(),
  align: z
    .strictObject({
      h: z.enum(['left', 'center', 'right']),
      v: z.enum(['top', 'center', 'bottom']),
    })
    .optional(),
});
export type TextSpec = z.infer<typeof TextSpecSchema>;

export const AnchorSchema = z.strictObject({
  h: z.enum(['left', 'center', 'right', 'stretch']),
  v: z.enum(['top', 'center', 'bottom', 'stretch']),
});
export type Anchor = z.infer<typeof AnchorSchema>;

export const NineSliceSchema = z.tuple([
  z.number().nonnegative(),
  z.number().nonnegative(),
  z.number().nonnegative(),
  z.number().nonnegative(),
]);

export const StateOverrideSchema = z.strictObject({
  asset: z.string().optional(),
  visible: z.boolean().optional(),
  tint: ColorSchema.optional(),
  text: z
    .strictObject({ content: z.string().optional(), color: ColorSchema.optional() })
    .optional(),
  source: z.enum(['drawn', 'derived', 'generated', 'placeholder']).optional(),
});
export type StateOverride = z.infer<typeof StateOverrideSchema>;

export const BindingSchema = z.strictObject({
  path: z.string().min(1),
  format: z.string().optional(),
});

export const DecisionSchema = z.strictObject({ value: z.string(), by: z.string() });

/** Why a node left the similarity cluster analysis put it in (DESIGN §5.6 同形同判). */
export const ClusterSplitSchema = z.strictObject({
  /** The cluster it was split out of. */
  from: z.string().min(1),
  because: z.string().min(1),
});
export type ClusterSplit = z.infer<typeof ClusterSplitSchema>;

export const UINodeSchema = z.strictObject({
  id: z.string(),
  type: PrimitiveSchema,
  role: RoleSchema.optional(),
  concept: ConceptNameSchema.optional(),
  parent: z.string().nullable(),
  children: z.array(z.string()),
  rect: RectSchema,
  anchor: AnchorSchema.optional(),
  pivot: PairSchema.optional(),
  visible: z.boolean().default(true),
  varies: VariesSchema.default([]),
  /** Name of the asset drawn for the default look; set by the build. */
  asset: z.string().optional(),
  /** Multiply colour applied to the asset (`variant.mode: tint`); set by the build. */
  tint: ColorSchema.optional(),
  text: TextSpecSchema.optional(),
  states: z.record(z.string(), StateOverrideSchema).optional(),
  bind: z.record(z.string(), BindingSchema).optional(),
  instanceOf: z.string().optional(),
  props: z.record(z.string(), z.unknown()).optional(),
  /** Nine-slice insets `[left, top, right, bottom]` in design pixels; set by the build. */
  nineSlice: NineSliceSchema.optional(),
  cluster: z.string().optional(),
  clusterSplit: ClusterSplitSchema.optional(),
  evidence: z.array(z.string()).default([]),
  decisions: z.record(z.string(), DecisionSchema).default({}),
  pins: z.record(z.string(), z.unknown()).default({}),
  confidence: z.number().min(0).max(1).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type UINode = z.infer<typeof UINodeSchema>;
export const UINODE_FIELDS = Object.keys(UINodeSchema.shape) as ReadonlyArray<keyof UINode>;

export const ComponentPropSchema = z.strictObject({
  type: z.enum(['string', 'number', 'bool', 'texture', 'enum']),
  default: z.unknown().optional(),
  values: z.array(z.string()).optional(),
});

export const ComponentSchema = z.strictObject({
  name: ComponentNameSchema,
  master: z.string(),
  props: z.record(z.string(), ComponentPropSchema),
  events: z.array(z.string()),
});
export type Component = z.infer<typeof ComponentSchema>;

export const ScreenSourceSchema = z.strictObject({
  kind: z.enum(['flat', 'psd']),
  file: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  sha256: Sha256Schema,
});
export type ScreenSource = z.infer<typeof ScreenSourceSchema>;

export const ScreenNodesSchema = z.record(z.string(), UINodeSchema);

/**
 * A part of the source that is not part of the screen (screenshot residue, watermarks). The
 * build fills it in every asset that covers it; fidelity is not measured there.
 */
export const ExclusionSchema = z.strictObject({
  id: z.string().regex(/^ex_[0-9]+$/, '排除区 id 须形如 ex_1'),
  /** Design pixels. */
  rect: RectSchema,
  because: z.string().min(1),
  evidence: z.array(z.string()).default([]),
});
export type Exclusion = z.infer<typeof ExclusionSchema>;

export const ScreenDocSchema = z.strictObject({
  format: z.literal('ui-pro/screen'),
  version: z.literal(1),
  name: z.string(),
  source: ScreenSourceSchema,
  scale: z.number().positive(),
  size: PairSchema,
  root: z.string(),
  nodes: ScreenNodesSchema,
  components: z.record(z.string(), ComponentSchema),
  exclusions: z.array(ExclusionSchema).default([]),
});
export type ScreenDoc = z.infer<typeof ScreenDocSchema>;
