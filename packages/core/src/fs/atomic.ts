import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { ioError } from '../errors';
import { isNodeError } from './files';

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 6;
const RENAME_BACKOFF_MS = 25;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** `rename` that retries on the transient sharing violations Windows reports under load. */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const retryable = isNodeError(error) && RETRYABLE_RENAME_CODES.has(error.code ?? '');
      if (!retryable || attempt >= RENAME_ATTEMPTS) throw ioError('替换文件', to, error);
      await sleep(RENAME_BACKOFF_MS * attempt);
    }
  }
}

function tempPathFor(path: string): string {
  return join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
}

async function writeTemp(path: string, content: Uint8Array | string): Promise<string> {
  const temp = tempPathFor(path);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temp, content);
  } catch (error) {
    await rm(temp, { force: true });
    throw ioError('写入文件', path, error);
  }
  return temp;
}

/** Writes through a temp file in the same directory, then renames over `path`. */
export async function writeFileAtomic(path: string, content: Uint8Array | string): Promise<void> {
  const temp = await writeTemp(path, content);
  try {
    await renameWithRetry(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export interface StagedWrite {
  /** Absolute path. */
  path: string;
  before: Uint8Array | null;
  /** `null` deletes the file. */
  after: Uint8Array | null;
}

async function restore(write: StagedWrite): Promise<void> {
  if (write.before === null) await rm(write.path, { force: true });
  else await writeFileAtomic(write.path, write.before);
}

/**
 * Applies several file changes as one unit: every new content is written to a temp file first,
 * then the renames/deletions run; if any step fails the ones already applied are restored.
 */
export async function applyStagedWrites(writes: readonly StagedWrite[]): Promise<void> {
  const temps = new Map<StagedWrite, string>();
  const discardTemps = () =>
    Promise.all([...temps.values()].map((temp) => rm(temp, { force: true })));

  try {
    for (const write of writes) {
      if (write.after !== null) temps.set(write, await writeTemp(write.path, write.after));
    }
  } catch (error) {
    await discardTemps();
    throw error;
  }

  const applied: StagedWrite[] = [];
  try {
    for (const write of writes) {
      const temp = temps.get(write);
      if (temp === undefined) await rm(write.path, { force: true });
      else await renameWithRetry(temp, write.path);
      temps.delete(write);
      applied.push(write);
    }
  } catch (error) {
    await discardTemps();
    for (const write of applied.reverse()) await restore(write);
    throw error;
  }
}

async function containsFile(dir: string): Promise<boolean> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) return true;
    if (await containsFile(join(dir, entry.name))) return true;
  }
  return false;
}

/**
 * After files were deleted, removes the directories they leave without any file, walking up
 * from `file` but never removing `root` or its direct children (the project skeleton).
 */
export async function pruneEmptyDirs(root: string, file: string): Promise<void> {
  let dir = dirname(file);
  while (relative(root, dir).split(sep).length > 1) {
    try {
      if (await containsFile(dir)) return;
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        dir = dirname(dir);
        continue;
      }
      throw ioError('清理空目录', dir, error);
    }
    dir = dirname(dir);
  }
}
