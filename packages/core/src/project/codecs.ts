import { type CandidatesDoc, CandidatesDocSchema } from '../schema/candidates';
import { type Codec, jsonCodec, yamlCodec } from '../schema/codec';
import { GlossarySchema, ProjectConfigSchema } from '../schema/project';

export const projectConfigCodec = yamlCodec(ProjectConfigSchema);
export const glossaryCodec = yamlCodec(GlossarySchema);
export const candidatesCodec: Codec<CandidatesDoc> = jsonCodec(CandidatesDocSchema);

/**
 * Initial text of documents whose schemas belong to other packages (rules, behavior). Core only
 * creates them; it never parses them.
 */
export const INITIAL_PROJECT_RULES = 'format: ui-pro/rules\nversion: 1\nrules: []\n';
export const INITIAL_SCREEN_RULES = 'format: ui-pro/rules\nversion: 1\nrules: []\nexceptions: []\n';
export const INITIAL_BEHAVIOR = 'format: ui-pro/behavior\nversion: 1\nbehaviors: []\n';
export const INITIAL_MOCK = '{}\n';
