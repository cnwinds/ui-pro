import { z } from 'zod';
import { RectSchema, Sha256Schema } from './common';

export const CANDIDATE_SOURCES = ['cv', 'seg', 'ocr', 'layer', 'agent', 'glossary'] as const;

export const LayerInfoSchema = z.strictObject({
  psdId: z.number().int(),
  name: z.string(),
  path: z.array(z.string()),
  kind: z.enum(['pixel', 'text', 'smart', 'shape', 'group']),
  hidden: z.boolean(),
  hasEffects: z.boolean(),
});

export const CandidateSchema = z.strictObject({
  /** `cand#<n>` for detected regions, `layer#<psdLayerId>` for PSD layers. */
  id: z.string().min(1),
  source: z.enum(CANDIDATE_SOURCES),
  /** SOURCE pixel space, not design space. */
  bbox: RectSchema,
  /** Path relative to the evidence directory. */
  mask: z.string().optional(),
  score: z.number().optional(),
  text: z.string().optional(),
  parent: z.string().optional(),
  cluster: z.string().optional(),
  layer: LayerInfoSchema.optional(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const ClusterSchema = z.strictObject({
  id: z.string().min(1),
  members: z.array(z.string()),
  kind: z.enum(['visual', 'smart-object', 'name']),
});
export type Cluster = z.infer<typeof ClusterSchema>;

export const CandidatesDocSchema = z.strictObject({
  format: z.literal('ui-pro/candidates'),
  version: z.literal(1),
  sourceSha256: Sha256Schema,
  candidates: z.array(CandidateSchema),
  clusters: z.array(ClusterSchema),
});
export type CandidatesDoc = z.infer<typeof CandidatesDocSchema>;
