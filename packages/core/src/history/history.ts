import { ErrorCodes, UiProError } from '../errors';
import { readFileIfExists } from '../fs/files';
import { withProjectLock } from '../fs/lock';
import { sha256OrNull } from '../hash';
import { resolveInside } from '../paths';
import type { Project } from '../project/project';
import { readBlob } from './blobs';
import { commitVersion, type FileWrite } from './commit';
import { type ChangeSource, type HistoryEntry, readLog } from './log';
import { analyzeHistory, type HistoryState } from './state';

export interface HistoryListItem {
  version: number;
  time: string;
  source: ChangeSource;
  message: string;
  opCount: number;
  docCount: number;
  revertOf?: number;
  live: boolean;
}

export interface RevertOptions {
  source?: ChangeSource;
}

/** The version an undo or redo created; `revertOf` is the version whose changes it reverted. */
export type RevertedEntry = HistoryEntry & { revertOf: number };

/** Oldest first; `limit` keeps only the newest N versions. */
export function listHistory(project: Project, options: { limit?: number } = {}): HistoryListItem[] {
  const entries = readLog(project);
  const { live } = analyzeHistory(entries);
  const items = entries.map((entry) => ({
    version: entry.version,
    time: entry.time,
    source: entry.source,
    message: entry.message,
    opCount: entry.ops.length,
    docCount: Object.keys(entry.docs).length,
    revertOf: entry.revertOf,
    live: live.has(entry.version),
  }));
  return options.limit === undefined ? items : items.slice(-options.limit);
}

export function showVersion(project: Project, version: number): HistoryEntry & { live: boolean } {
  const entries = readLog(project);
  const entry = entries.find((candidate) => candidate.version === version);
  if (!entry) {
    throw new UiProError(ErrorCodes.versionNotFound, `没有版本 v${version}`, {
      hint: '用 ui-pro history list 查看现有版本',
    });
  }
  return { ...entry, live: analyzeHistory(entries).live.has(version) };
}

interface RevertPlan {
  pick(state: HistoryState): HistoryEntry | undefined;
  nothingToDo: string;
  describe(target: HistoryEntry): string;
}

/** Commits a new version that restores the `before` contents of the target version. */
async function revert(
  project: Project,
  plan: RevertPlan,
  options: RevertOptions,
): Promise<RevertedEntry> {
  return withProjectLock(project.root, async () => {
    const target = plan.pick(analyzeHistory(readLog(project)));
    if (!target) throw new UiProError(ErrorCodes.historyEmpty, plan.nothingToDo);

    const writes: FileWrite[] = [];
    for (const [path, { before, after }] of Object.entries(target.docs)) {
      const current = await readFileIfExists(resolveInside(project.root, path));
      if (sha256OrNull(current) !== after) {
        throw new UiProError(
          ErrorCodes.historyConflict,
          `文件在 ui-pro 之外被修改，无法安全还原 v${target.version}：${path}`,
          { hint: '先处理该文件的外部改动（或用版本管理还原它），再重试' },
        );
      }
      writes.push({ path, content: before === null ? null : await readBlob(project, before) });
    }

    const entry = await commitVersion(project, {
      writes,
      source: options.source ?? 'cli',
      message: plan.describe(target),
      ops: [],
      revertOf: target.version,
    });
    if (!entry) {
      throw new UiProError(ErrorCodes.invariant, `v${target.version} 没有产生任何文件变化`);
    }
    return { ...entry, revertOf: target.version };
  });
}

export function undo(project: Project, options: RevertOptions = {}): Promise<RevertedEntry> {
  return revert(
    project,
    {
      pick: (state) => state.undoTarget,
      nothingToDo: '没有可撤销的版本',
      describe: (target) => `撤销 v${target.version}`,
    },
    options,
  );
}

export function redo(project: Project, options: RevertOptions = {}): Promise<RevertedEntry> {
  return revert(
    project,
    {
      pick: (state) => state.redoTarget,
      nothingToDo: '没有可重做的版本',
      describe: (target) => `重做 v${target.revertOf ?? target.version}`,
    },
    options,
  );
}
