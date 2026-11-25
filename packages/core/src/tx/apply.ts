import { ErrorCodes, isUiProError, UiProError, withErrorDetails } from '../errors';
import { withProjectLock } from '../fs/lock';
import { commitVersion, type FileWrite } from '../history/commit';
import type { ChangeSource } from '../history/log';
import { screenRelPath } from '../paths';
import { checkEvidence, type EvidenceUpdate, evidenceWrites } from '../project/evidence';
import type { Project } from '../project/project';
import type { CandidatesDoc } from '../schema/candidates';
import { formatIssues } from '../schema/codec';
import type { ChangeSet } from './changes';
import { defaultRegistry } from './default-registry';
import { unknownOpError } from './op-schema';
import type { Registry } from './registry';
import { Transaction } from './transaction';
import type { AskQuestion, OpDefinition } from './types';

export interface ApplyOptions {
  /** Screen that unqualified selectors apply to. */
  screen?: string;
  /** Run everything, including hooks and validation, but write nothing. */
  dryRun?: boolean;
  /** History message; defaults to a summary of the ops. */
  message?: string;
  source?: ChangeSource;
  /** Defaults to the registry other packages register into. */
  registry?: Registry;
  /**
   * Screen name -> new evidence, committed in the same version as the ops. The ops already see it,
   * so an analysis can write its candidates and the draft built on them as one undoable step.
   */
  evidence?: Readonly<Record<string, EvidenceUpdate>>;
}

export interface ApplyResult {
  ok: true;
  dryRun: boolean;
  /** The new history version; absent for dry runs and for batches that change nothing. */
  version?: number;
  changes: ChangeSet;
  warnings: string[];
  ask: AskQuestion[];
}

function opName(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || !('op' in raw)) return undefined;
  return typeof raw.op === 'string' ? raw.op : undefined;
}

function lookup(registry: Registry, raw: unknown, index: number): OpDefinition {
  const name = opName(raw);
  if (name === undefined) {
    throw new UiProError(ErrorCodes.opInvalid, `操作 #${index} 必须是带 "op" 字段的对象`, {
      hint: '例如 { "op": "node.add", "node": { … } }，ui-pro schema 查看各操作的参数',
    });
  }
  const definition = registry.getOp(name);
  if (!definition) throw unknownOpError(registry, name);
  return definition;
}

function runOp(tx: Transaction, registry: Registry, raw: unknown, index: number): void {
  const definition = lookup(registry, raw, index);
  const parsed = definition.schema.safeParse(raw);
  if (!parsed.success) {
    throw new UiProError(
      ErrorCodes.opInvalid,
      `操作 #${index}（${definition.name}）参数不正确：\n${formatIssues(parsed.error).join('\n')}`,
      {
        hint: `ui-pro schema ${definition.name} 查看参数定义`,
        details: { issues: formatIssues(parsed.error) },
      },
    );
  }
  definition.apply(tx, parsed.data);
  tx.checkTouchedScreens();
}

/** Runs all ops, then the `beforeCommit` hooks, against draft copies; nothing is written. */
function execute(
  project: Project,
  registry: Registry,
  ops: readonly unknown[],
  screen: string | undefined,
  evidence: ReadonlyMap<string, CandidatesDoc>,
): Transaction {
  const tx = new Transaction(project, registry, screen, evidence);
  ops.forEach((raw, index) => {
    try {
      runOp(tx, registry, raw, index);
    } catch (error) {
      if (!isUiProError(error)) throw error;
      throw withErrorDetails(error, { opIndex: index, op: opName(raw) ?? null });
    }
  });
  tx.runBeforeCommitHooks();
  tx.checkAllScreens();
  return tx;
}

function defaultMessage(ops: readonly unknown[]): string {
  const counts = new Map<string, number>();
  for (const raw of ops) {
    const name = opName(raw) ?? '?';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join('、');
}

/**
 * Applies a batch of typed ops as one all-or-nothing transaction. Every op is validated against
 * its schema, applied to draft copies, and the touched screens are re-validated after each op.
 * On success the changed documents are written atomically and recorded as one history version;
 * on any error nothing is written and the error carries `opIndex` in its details.
 */
export async function applyOps(
  project: Project,
  ops: readonly unknown[],
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const registry = options.registry ?? defaultRegistry;
  const updates = Object.entries(options.evidence ?? {}).map(([screen, update]) => ({
    screen,
    candidates: checkEvidence(project, screen, update),
    files: update.files,
  }));
  const evidence = new Map(updates.map((update) => [update.screen, update.candidates]));
  const evidenceDocs = updates.map((update) => screenRelPath(update.screen, 'candidates'));
  const result = (tx: Transaction, dryRun: boolean, version?: number): ApplyResult => {
    const changes = tx.changes();
    const docs = [...new Set([...changes.docs, ...evidenceDocs])].sort();
    return {
      ok: true,
      dryRun,
      version,
      changes: { ...changes, docs },
      warnings: [...tx.warnings],
      ask: [...tx.asks],
    };
  };

  if (options.dryRun) {
    return result(execute(project, registry, ops, options.screen, evidence), true);
  }

  return withProjectLock(project.root, async () => {
    const tx = execute(project, registry, ops, options.screen, evidence);
    const writes: FileWrite[] = [...tx.pendingWrites()];
    for (const { screen, candidates, files } of updates) {
      writes.push(...(await evidenceWrites(project, screen, candidates, files)));
    }
    const entry = await commitVersion(project, {
      writes,
      source: options.source ?? 'cli',
      message: options.message ?? defaultMessage(ops),
      ops,
    });
    return result(tx, false, entry?.version);
  });
}
