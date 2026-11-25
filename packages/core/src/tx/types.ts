import type { z } from 'zod';
import type { UiProError } from '../errors';
import type { Project } from '../project/project';
import type { CandidatesDoc } from '../schema/candidates';
import type { Glossary } from '../schema/project';
import type { ScreenDoc } from '../schema/screen';
import type { NodeRef } from '../selector/ref';

export type OpFamily = 'structure' | 'measure' | 'rules' | 'presentation';

/** A question the agent must put to the user; surfaced in the `ask` field of responses. */
export interface AskQuestion {
  id: string;
  question: string;
  options?: string[];
  default?: string;
}

export interface SelectLimits {
  /** Fewer matches fail with `E_SELECTOR_EMPTY`. */
  min?: number;
  /** More matches fail with `E_SELECTOR_AMBIGUOUS`. */
  max?: number;
}

export interface RenameEvent {
  screen: string;
  from: string;
  to: string;
}

/**
 * A kind of persisted document. `path` is project-relative with forward slashes. Declared with
 * method syntax so a `DocKind<ScreenDoc>` is usable wherever a `DocKind` is expected.
 */
export interface DocKind<T = unknown> {
  readonly kind: string;
  path(project: Project, key: string): string;
  /** `label` is the project-relative path, for error messages. */
  parse(text: string, label: string): T;
  serialize(value: T): string;
  /** Error to throw when the document does not exist; defaults to `E_DOC_NOT_FOUND`. */
  missing?(project: Project, key: string): UiProError;
}

/** The mutable view of the project that ops and hooks work on during one transaction. */
export interface TxContext {
  readonly project: Project;
  /** Screen that unqualified selectors and `screen()` default to. */
  readonly currentScreen: string | undefined;
  /** Draft of a screen document; edits are discarded unless the whole transaction commits. */
  screen(name?: string): ScreenDoc;
  glossary(): Glossary;
  /** Draft of any registered document. Singleton documents use the key `''`. */
  doc<T>(kind: DocKind<T>, key: string): T;
  doc(kind: string, key: string): unknown;
  /** Replaces (or creates) a document. */
  setDoc<T>(kind: DocKind<T>, key: string, value: T): void;
  setDoc(kind: string, key: string, value: unknown): void;
  select(selector: string, limits?: SelectLimits): NodeRef[];
  warn(message: string): void;
  ask(question: AskQuestion): void;
  /** Read-only candidate evidence of a screen, `null` before analysis. */
  evidence(screen: string): CandidatesDoc | null;
  /** Lets other document kinds follow a node id change. */
  runRenameHooks(event: RenameEvent): void;
}

export interface OpDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  family: OpFamily;
  /** One-line description in Simplified Chinese. */
  summary: string;
  schema: S;
  apply(ctx: TxContext, op: z.infer<S>): void;
}

export interface HookMap {
  /** Runs after all ops, inside the transaction, so dry-runs include its effects. */
  beforeCommit: (ctx: TxContext) => void;
  rename: (ctx: TxContext, event: RenameEvent) => void;
}
export type HookName = keyof HookMap;
