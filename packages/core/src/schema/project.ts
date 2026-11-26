import { z } from 'zod';
import { NodeRefSchema, RoleSchema } from './common';

export const DesignSizeSchema = z.strictObject({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type DesignSize = z.infer<typeof DesignSizeSchema>;

export const DEFAULT_DESIGN: DesignSize = { width: 1080, height: 1920 };

export const ENGINES = ['godot'] as const;
export const EGRESS_LEVELS = ['cloud', 'hybrid', 'local'] as const;
export type EgressLevel = (typeof EGRESS_LEVELS)[number];
export const IMAGE_MODEL_PROVIDERS = ['dashscope', 'none'] as const;

/** The cloud image model. The API key is never stored here: it comes from the environment. */
export const ImageModelConfigSchema = z.strictObject({
  provider: z.enum(IMAGE_MODEL_PROVIDERS).default('dashscope'),
  /** Service base URL, e.g. a DashScope workspace domain; the provider's public default otherwise. */
  endpoint: z.url().optional(),
});
export type ImageModelConfig = z.infer<typeof ImageModelConfigSchema>;

export const ProjectConfigSchema = z.strictObject({
  format: z.literal('ui-pro/project'),
  version: z.literal(1),
  name: z.string().min(1),
  design: DesignSizeSchema.default(DEFAULT_DESIGN),
  engine: z.enum(ENGINES).default('godot'),
  egress: z.enum(EGRESS_LEVELS).default('cloud'),
  image_model: ImageModelConfigSchema.default({ provider: 'dashscope' }),
  budget: z
    .strictObject({ image_calls_per_screen: z.number().int().positive() })
    .default({ image_calls_per_screen: 200 }),
  /** Font name (what `text.font` holds) -> project-relative font file, e.g. under `resources/fonts/`. */
  fonts: z.record(z.string().min(1), z.string().min(1)).default({}),
  psd: z.strictObject({ prefixes: z.record(z.string(), z.string()).optional() }).default({}),
  export: z
    .strictObject({
      godot: z.strictObject({ project: z.string().optional() }).optional(),
    })
    .default({}),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const GlossaryConceptSchema = z.strictObject({
  name: z.string().min(1),
  role: RoleSchema.optional(),
  description: z.string().optional(),
  /** Qualified node refs, `<screen>/#<id>`. */
  exemplars: z.array(NodeRefSchema),
});
export type GlossaryConcept = z.infer<typeof GlossaryConceptSchema>;

export const GlossarySchema = z.strictObject({
  format: z.literal('ui-pro/glossary'),
  version: z.literal(1),
  concepts: z
    .array(GlossaryConceptSchema)
    .refine(
      (concepts) => new Set(concepts.map((c) => c.name)).size === concepts.length,
      '概念名不能重复',
    ),
});
export type Glossary = z.infer<typeof GlossarySchema>;
