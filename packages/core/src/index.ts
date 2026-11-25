export type { UiProErrorOptions } from './errors';
export { ErrorCodes, ioError, isUiProError, UiProError, withErrorDetails } from './errors';
export { writeFileAtomic } from './fs/atomic';
export { readFileIfExists, readFileIfExistsSync } from './fs/files';
export { withProjectLock } from './fs/lock';
export { sha256Hex, sha256OrNull } from './hash';
export type { CommitRequest, FileWrite } from './history/commit';
export { commitVersion } from './history/commit';
export type { HistoryListItem, RevertedEntry, RevertOptions } from './history/history';
export { listHistory, redo, showVersion, undo } from './history/history';
export type { ChangeSource, HistoryEntry } from './history/log';
export { CHANGE_SOURCES, HistoryEntrySchema } from './history/log';
export { formatJson } from './json';
export { builtinOps } from './ops';
export { editNodes, invalidOp, selectOne, singleScreen } from './ops/shared';
export {
  PROJECT_DIRS,
  PROJECT_FILES,
  resolveInside,
  SCRATCH_DIR,
  SCREEN_FILES,
  scratchPath,
  screenRelDir,
  screenRelPath,
  toPosix,
  toRelativePosix,
} from './paths';
export type { AddScreenInput, AddScreenResult } from './project/add-screen';
export { addScreen } from './project/add-screen';
export type { AnalysisReport, AnalyzeOptions } from './project/analysis';
export { COMPOSITE_EVIDENCE, referenceImagePath } from './project/analysis';
export {
  candidatesCodec,
  glossaryCodec,
  INITIAL_BEHAVIOR,
  INITIAL_MOCK,
  INITIAL_PROJECT_RULES,
  INITIAL_SCREEN_RULES,
  projectConfigCodec,
} from './project/codecs';
export { glossaryKind, projectConfigKind, SINGLETON_KEY, screenKind } from './project/docs';
export type { EvidenceFile, EvidenceUpdate } from './project/evidence';
export { readCandidates, roundRect, sourceToDesign } from './project/evidence';
export type { CreateProjectOptions, Project } from './project/project';
export { createProject, findProjectRoot, loadProject, openProject } from './project/project';
export {
  assertScreenName,
  defaultScreen,
  listScreens,
  loadScreen,
  screenNotFoundError,
} from './project/screens';
export { readSelection } from './project/selection';
export type { InspectedSource, SourceFile } from './project/source';
export { inspectSource, readPsdHeader } from './project/source';
export * from './schema/candidates';
export type { CanonicalOptions } from './schema/canonical';
export { canonicalize } from './schema/canonical';
export type { Codec } from './schema/codec';
export { formatIssues, jsonCodec, parseWithSchema, yamlCodec } from './schema/codec';
export * from './schema/common';
export * from './schema/project';
export * from './schema/screen';
export { parseScreen, screenCodec, serializeScreen } from './screen/serialize';
export type { NewNodeFields } from './screen/tree';
export {
  allIdsInOrder,
  ancestorsOf,
  attachChild,
  createScreenDoc,
  detachChild,
  freeNodeId,
  isInSubtree,
  newNode,
  preOrder,
  ROOT_ID,
  requireNode,
  subtreeIds,
  unionRect,
} from './screen/tree';
export type { ScreenProblem, ScreenProblemCode } from './screen/validate';
export { validateScreen } from './screen/validate';
export type {
  AttributeOperator,
  ComplexSelector,
  Compound,
  SelectorAttribute,
  SelectorList,
  SimpleSelector,
  Step,
} from './selector/ast';
export { SELECTOR_ATTRIBUTES } from './selector/ast';
export { projectSelectorEnv } from './selector/env';
export { parseSelector } from './selector/parse';
export type { NodeRef } from './selector/ref';
export { formatRef, parseRef } from './selector/ref';
export type { Selection, SelectorEnv } from './selector/resolve';
export { resolveSelector } from './selector/resolve';
export type { ApplyOptions, ApplyResult } from './tx/apply';
export { applyOps } from './tx/apply';
export type { ChangeSet, ScreenChanges } from './tx/changes';
export { diffScreens, SCREEN_LEVEL_KEY } from './tx/changes';
export {
  createCoreRegistry,
  defaultRegistry,
  getOp,
  listOps,
  registerDocKind,
  registerHook,
  registerOp,
} from './tx/default-registry';
export type { OpSummary } from './tx/op-schema';
export { describeOps, opJsonSchema, suggestOps, unknownOpError } from './tx/op-schema';
export { defineOp, Registry } from './tx/registry';
export type {
  AskQuestion,
  DocKind,
  HookMap,
  HookName,
  OpDefinition,
  OpFamily,
  RenameEvent,
  SelectLimits,
  TxContext,
} from './tx/types';
