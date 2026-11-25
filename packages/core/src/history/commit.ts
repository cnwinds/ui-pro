import { ErrorCodes, UiProError } from '../errors';
import { applyStagedWrites, pruneEmptyDirs, type StagedWrite } from '../fs/atomic';
import { readFileIfExists } from '../fs/files';
import { sha256OrNull } from '../hash';
import { resolveInside } from '../paths';
import type { Project } from '../project/project';
import { storeBlob } from './blobs';
import { appendLog, type ChangeSource, type HistoryEntry, readLog } from './log';

export interface FileWrite {
  /** Project-relative posix path. */
  path: string;
  /** New content; `null` deletes the file. */
  content: Uint8Array | null;
}

export interface CommitRequest {
  writes: readonly FileWrite[];
  source: ChangeSource;
  message: string;
  ops: readonly unknown[];
  revertOf?: number;
}

function sameContent(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(b);
}

/**
 * Writes the files atomically as one unit and records them as the next history version.
 * Returns `null` (and writes nothing) when no file would change.
 * The caller must hold the project lock.
 */
export async function commitVersion(
  project: Project,
  request: CommitRequest,
): Promise<HistoryEntry | null> {
  const paths = request.writes.map((write) => write.path);
  if (new Set(paths).size !== paths.length) {
    throw new UiProError(ErrorCodes.invariant, '同一次提交中不能重复写入同一个文件');
  }

  const staged: Array<StagedWrite & { rel: string }> = [];
  for (const write of request.writes) {
    const path = resolveInside(project.root, write.path);
    const before = await readFileIfExists(path);
    if (!sameContent(before, write.content)) {
      staged.push({ rel: write.path, path, before, after: write.content });
    }
  }
  if (staged.length === 0) return null;
  staged.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  for (const { before, after } of staged) {
    if (before !== null) await storeBlob(project, before);
    if (after !== null) await storeBlob(project, after);
  }

  const lastVersion = readLog(project).at(-1)?.version ?? 0;
  const entry: HistoryEntry = {
    version: lastVersion + 1,
    time: new Date().toISOString(),
    source: request.source,
    message: request.message,
    ops: [...request.ops],
    docs: Object.fromEntries(
      staged.map(({ rel, before, after }) => [
        rel,
        { before: sha256OrNull(before), after: sha256OrNull(after) },
      ]),
    ),
    revertOf: request.revertOf,
  };

  await applyStagedWrites(staged);
  try {
    await appendLog(project, entry);
  } catch (error) {
    const inverse = staged.map(({ path, before, after }) => ({
      path,
      before: after,
      after: before,
    }));
    await applyStagedWrites(inverse);
    throw error;
  }
  for (const { path, after } of staged) {
    if (after === null) await pruneEmptyDirs(project.root, path);
  }
  return entry;
}
