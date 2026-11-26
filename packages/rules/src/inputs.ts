import {
  type AssetManifest,
  type DocKind,
  ErrorCodes,
  isUiProError,
  listScreens,
  loadScreen,
  type Project,
  readAssetManifest,
  readFileIfExistsSync,
  resolveInside,
  type ScreenDoc,
  SINGLETON_KEY,
  type TxContext,
} from '@ui-pro/core';
import { projectRulesKind, screenRulesKind } from './docs';
import { defaultPack } from './layers';
import { emptyProjectRules, emptyScreenRules, type ProjectRules, type ScreenRules } from './schema';

export interface ScreenInput {
  doc: ScreenDoc;
  rules: ScreenRules;
  /** The screen's built assets; `null` or absent before the first build. */
  assets?: AssetManifest | null;
}

/** Everything evaluation needs: the three rule layers and the screens they apply to. */
export interface RuleInputs {
  pack: ProjectRules;
  project: ProjectRules;
  /** By screen name, sorted. */
  screens: ReadonlyMap<string, ScreenInput>;
}

function readOptionalFile<T>(
  project: Project,
  path: string,
  parse: (text: string, label: string) => T,
  empty: () => T,
): T {
  const bytes = readFileIfExistsSync(resolveInside(project.root, path));
  return bytes === null ? empty() : parse(bytes.toString('utf8'), path);
}

/** The documents on disk. A missing rules file counts as an empty one. */
export function readRuleInputs(project: Project): RuleInputs {
  const screens = new Map<string, ScreenInput>();
  for (const name of listScreens(project)) {
    screens.set(name, {
      doc: loadScreen(project, name),
      rules: readOptionalFile(
        project,
        screenRulesKind.path(project, name),
        screenRulesKind.parse,
        emptyScreenRules,
      ),
      assets: readAssetManifest(project, name),
    });
  }
  return {
    pack: defaultPack(),
    project: readOptionalFile(
      project,
      projectRulesKind.path(project, SINGLETON_KEY),
      projectRulesKind.parse,
      emptyProjectRules,
    ),
    screens,
  };
}

/** Reads a document through the transaction; a document that does not exist yet is `undefined`. */
function txDoc<T>(ctx: TxContext, kind: DocKind<T>, key: string): T | undefined {
  try {
    return ctx.doc(kind, key);
  } catch (error) {
    if (isUiProError(error) && error.code === ErrorCodes.docNotFound) return undefined;
    throw error;
  }
}

export function txProjectRules(ctx: TxContext): ProjectRules {
  return txDoc(ctx, projectRulesKind, SINGLETON_KEY) ?? emptyProjectRules();
}

export function txScreenRules(ctx: TxContext, screen: string): ScreenRules {
  return txDoc(ctx, screenRulesKind, screen) ?? emptyScreenRules();
}

/**
 * The drafts of the running transaction, so rules and nodes changed by earlier ops are seen.
 * The returned documents are the drafts themselves: editing them edits the transaction.
 */
export function readTxInputs(ctx: TxContext): RuleInputs {
  const screens = new Map<string, ScreenInput>();
  for (const name of listScreens(ctx.project)) {
    screens.set(name, {
      doc: ctx.screen(name),
      rules: txScreenRules(ctx, name),
      assets: ctx.assets(name),
    });
  }
  return { pack: defaultPack(), project: txProjectRules(ctx), screens };
}
