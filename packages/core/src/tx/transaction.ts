import { ErrorCodes, UiProError } from '../errors';
import { readFileIfExistsSync } from '../fs/files';
import type { FileWrite } from '../history/commit';
import { resolveInside } from '../paths';
import { readAssetManifest } from '../project/assets';
import { glossaryKind, SINGLETON_KEY, screenKind } from '../project/docs';
import { readCandidates } from '../project/evidence';
import type { Project } from '../project/project';
import { listScreens } from '../project/screens';
import { readSelection } from '../project/selection';
import type { AssetManifest } from '../schema/assets';
import type { CandidatesDoc } from '../schema/candidates';
import type { Glossary } from '../schema/project';
import type { ScreenDoc } from '../schema/screen';
import { validateScreen } from '../screen/validate';
import type { NodeRef } from '../selector/ref';
import { resolveSelector, type SelectorEnv } from '../selector/resolve';
import { type ChangeSet, diffScreens } from './changes';
import type { Registry } from './registry';
import type { AskQuestion, DocKind, RenameEvent, SelectLimits, TxContext } from './types';

interface Draft {
  kind: DocKind;
  key: string;
  path: string;
  /** Parsed content when the transaction started; `undefined` for a document it creates. */
  original: unknown;
  value: unknown;
}

const MAX_REPORTED_PROBLEMS = 8;

/**
 * One transaction's working state: lazily loaded draft copies of every document it touches.
 * Nothing reaches disk from here; `pendingWrites` hands the changed documents to the committer.
 */
export class Transaction implements TxContext {
  readonly #drafts = new Map<string, Draft>();
  readonly #evidence = new Map<string, CandidatesDoc | null>();
  readonly #assets = new Map<string, AssetManifest | null>();
  readonly #touchedScreens = new Set<string>();
  readonly #warnings: string[] = [];
  readonly #asks: AskQuestion[] = [];
  readonly #env: SelectorEnv;
  readonly #registry: Registry;
  readonly project: Project;
  readonly currentScreen: string | undefined;

  /**
   * `evidence` and `assets` replace the on-disk evidence and asset manifests of those screens for
   * the whole transaction.
   */
  constructor(
    project: Project,
    registry: Registry,
    currentScreen: string | undefined,
    evidence: ReadonlyMap<string, CandidatesDoc> = new Map(),
    assets: ReadonlyMap<string, AssetManifest> = new Map(),
  ) {
    this.project = project;
    this.currentScreen = currentScreen;
    this.#registry = registry;
    for (const [screen, doc] of evidence) this.#evidence.set(screen, doc);
    for (const [screen, manifest] of assets) this.#assets.set(screen, manifest);
    this.#env = {
      currentScreen,
      listScreens: () => this.#screenNames(),
      loadScreen: (name) => this.screen(name),
      selection: () => readSelection(project),
    };
  }

  get warnings(): readonly string[] {
    return this.#warnings;
  }

  get asks(): readonly AskQuestion[] {
    return this.#asks;
  }

  screen(name?: string): ScreenDoc {
    const screen = name ?? this.currentScreen;
    if (screen === undefined) {
      const available = listScreens(this.project).join('、') || '（无）';
      throw new UiProError(ErrorCodes.screenNotFound, '没有指定界面', {
        hint: `用 --screen 指定界面；现有界面：${available}`,
      });
    }
    this.#touchedScreens.add(screen);
    return this.doc(screenKind, screen);
  }

  glossary(): Glossary {
    return this.doc(glossaryKind, SINGLETON_KEY);
  }

  doc<T>(kind: DocKind<T>, key: string): T;
  doc(kind: string, key: string): unknown;
  doc(kind: DocKind | string, key: string): unknown {
    return this.#draft(this.#resolveKind(kind), key, false).value;
  }

  setDoc<T>(kind: DocKind<T>, key: string, value: T): void;
  setDoc(kind: string, key: string, value: unknown): void;
  setDoc(kind: DocKind | string, key: string, value: unknown): void {
    this.#draft(this.#resolveKind(kind), key, true).value = value;
  }

  select(selector: string, limits: SelectLimits = {}): NodeRef[] {
    const refs = resolveSelector(selector, this.#env);
    const { min, max } = limits;
    if (min !== undefined && refs.length < min) {
      throw new UiProError(
        ErrorCodes.selectorEmpty,
        refs.length === 0
          ? `选择器没有匹配到任何节点：${selector}`
          : `选择器 ${selector} 只匹配到 ${refs.length} 个节点，至少需要 ${min} 个`,
        { hint: '用 ui-pro query 先确认选择器能选中目标' },
      );
    }
    if (max !== undefined && refs.length > max) {
      throw new UiProError(
        ErrorCodes.selectorAmbiguous,
        `选择器 ${selector} 匹配到 ${refs.length} 个节点，这个操作只能作用于 ${max === 1 ? '一个' : `最多 ${max} 个`}`,
        { hint: '收紧选择器，例如加上 #id', details: { matches: refs } },
      );
    }
    return refs;
  }

  warn(message: string): void {
    if (!this.#warnings.includes(message)) this.#warnings.push(message);
  }

  ask(question: AskQuestion): void {
    if (!this.#asks.some((existing) => existing.id === question.id)) this.#asks.push(question);
  }

  evidence(screen: string): CandidatesDoc | null {
    let doc = this.#evidence.get(screen);
    if (doc === undefined) {
      doc = readCandidates(this.project, screen);
      this.#evidence.set(screen, doc);
    }
    return doc;
  }

  assets(screen: string): AssetManifest | null {
    let manifest = this.#assets.get(screen);
    if (manifest === undefined) {
      manifest = readAssetManifest(this.project, screen);
      this.#assets.set(screen, manifest);
    }
    return manifest;
  }

  runRenameHooks(event: RenameEvent): void {
    for (const hook of this.#registry.hooks('rename')) hook(this, event);
  }

  runBeforeCommitHooks(): void {
    for (const hook of this.#registry.hooks('beforeCommit')) hook(this);
  }

  /** Validates the screens the op just handled (only those it actually changed). */
  checkTouchedScreens(): void {
    for (const screen of this.#touchedScreens) {
      const draft = this.#drafts.get(draftId(screenKind, screen));
      if (draft && isChanged(draft)) assertScreenValid(screen, draft.value as ScreenDoc);
    }
    this.#touchedScreens.clear();
  }

  checkAllScreens(): void {
    for (const draft of this.#changedDrafts()) {
      if (draft.kind.kind === screenKind.kind)
        assertScreenValid(draft.key, draft.value as ScreenDoc);
    }
  }

  changes(): ChangeSet {
    const changed = this.#changedDrafts();
    const screens: ChangeSet['screens'] = {};
    for (const draft of changed) {
      if (draft.kind.kind === screenKind.kind) {
        screens[draft.key] = diffScreens(
          draft.original as ScreenDoc | undefined,
          draft.value as ScreenDoc,
        );
      }
    }
    return { docs: changed.map((draft) => draft.path).sort(), screens };
  }

  pendingWrites(): FileWrite[] {
    return this.#changedDrafts().map((draft) => ({
      path: draft.path,
      content: Buffer.from(draft.kind.serialize(draft.value), 'utf8'),
    }));
  }

  #changedDrafts(): Draft[] {
    return [...this.#drafts.values()].filter(isChanged);
  }

  #screenNames(): string[] {
    const names = new Set(listScreens(this.project));
    for (const draft of this.#drafts.values()) {
      if (draft.kind.kind === screenKind.kind) names.add(draft.key);
    }
    return [...names].sort();
  }

  #resolveKind(kind: DocKind | string): DocKind {
    return typeof kind === 'string' ? this.#registry.getDocKind(kind) : kind;
  }

  #draft(kind: DocKind, key: string, allowMissing: boolean): Draft {
    const id = draftId(kind, key);
    const existing = this.#drafts.get(id);
    if (existing) return existing;

    const path = kind.path(this.project, key);
    const bytes = readFileIfExistsSync(resolveInside(this.project.root, path));
    if (bytes === null && !allowMissing) {
      throw (
        kind.missing?.(this.project, key) ??
        new UiProError(ErrorCodes.docNotFound, `文档不存在：${path}`)
      );
    }
    const original = bytes === null ? undefined : kind.parse(bytes.toString('utf8'), path);
    const draft: Draft = { kind, key, path, original, value: structuredClone(original) };
    this.#drafts.set(id, draft);
    return draft;
  }
}

const draftId = (kind: DocKind, key: string) => `${kind.kind}:${key}`;

function isChanged(draft: Draft): boolean {
  return (
    draft.original === undefined ||
    draft.kind.serialize(draft.original) !== draft.kind.serialize(draft.value)
  );
}

function assertScreenValid(screen: string, doc: ScreenDoc): void {
  const problems = validateScreen(doc);
  if (problems.length === 0) return;
  const shown = problems.slice(0, MAX_REPORTED_PROBLEMS).map((problem) => `- ${problem.message}`);
  const more =
    problems.length > shown.length ? [`- …另有 ${problems.length - shown.length} 个问题`] : [];
  throw new UiProError(
    ErrorCodes.invariant,
    `修改会让界面 ${screen} 不再合法：\n${[...shown, ...more].join('\n')}`,
    { details: { screen, problems } },
  );
}
