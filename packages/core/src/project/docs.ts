import { PROJECT_FILES, screenRelPath } from '../paths';
import type { Glossary, ProjectConfig } from '../schema/project';
import type { ScreenDoc } from '../schema/screen';
import { parseScreen, serializeScreen } from '../screen/serialize';
import type { DocKind } from '../tx/types';
import { glossaryCodec, projectConfigCodec } from './codecs';
import { assertScreenName, screenNotFoundError } from './screens';

/** Key of documents that exist once per project. */
export const SINGLETON_KEY = '';

export const projectConfigKind: DocKind<ProjectConfig> = {
  kind: 'project-config',
  path: () => PROJECT_FILES.config,
  ...projectConfigCodec,
};

export const glossaryKind: DocKind<Glossary> = {
  kind: 'glossary',
  path: () => PROJECT_FILES.glossary,
  ...glossaryCodec,
};

/** Keyed by screen name. */
export const screenKind: DocKind<ScreenDoc> = {
  kind: 'screen',
  path: (project, key) => screenRelPath(assertScreenName(project, key), 'doc'),
  parse: parseScreen,
  serialize: serializeScreen,
  missing: screenNotFoundError,
};

export const builtinDocKinds: readonly DocKind[] = [projectConfigKind, glossaryKind, screenKind];
