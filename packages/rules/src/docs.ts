import {
  assertScreenName,
  type Codec,
  type DocKind,
  PROJECT_FILES,
  screenRelPath,
  yamlCodec,
} from '@ui-pro/core';
import {
  type ProjectRules,
  ProjectRulesSchema,
  type ScreenRules,
  ScreenRulesSchema,
} from './schema';

export const projectRulesCodec: Codec<ProjectRules> = yamlCodec(ProjectRulesSchema);
export const screenRulesCodec: Codec<ScreenRules> = yamlCodec(ScreenRulesSchema);

/** `rules/project.yaml`, a singleton. */
export const projectRulesKind: DocKind<ProjectRules> = {
  kind: 'project-rules',
  path: () => PROJECT_FILES.projectRules,
  ...projectRulesCodec,
};

/** `screens/<screen>/rules.yaml`, keyed by screen name. */
export const screenRulesKind: DocKind<ScreenRules> = {
  kind: 'screen-rules',
  path: (project, key) => screenRelPath(assertScreenName(project, key), 'rules'),
  ...screenRulesCodec,
};
