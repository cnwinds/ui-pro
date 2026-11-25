import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { ErrorCodes, ioError, UiProError } from '../errors';
import { scratchPath, toPosix } from '../paths';
import { isNodeError } from './files';

const STALE_AFTER_MS = 10 * 60 * 1000;

interface LockPayload {
  pid: number;
  token: string;
  createdAt: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === 'EPERM';
  }
}

async function readPayload(lockFile: string): Promise<LockPayload | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(lockFile, 'utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'pid' in parsed &&
      typeof parsed.pid === 'number'
    ) {
      return parsed as LockPayload;
    }
  } catch {
    // A half-written or foreign lock file is judged by its age alone.
  }
  return null;
}

type LockState = 'gone' | 'stale' | 'held';

/**
 * Who owns an existing lock file: nobody anymore, a dead writer, or a live one. A live owner keeps
 * its lock however long it runs (builds wait on cloud models); age only judges unreadable locks.
 */
async function inspectLock(lockFile: string): Promise<LockState> {
  try {
    const ageMs = Date.now() - (await stat(lockFile)).mtimeMs;
    const payload = await readPayload(lockFile);
    if (payload === null) return ageMs > STALE_AFTER_MS ? 'stale' : 'held';
    return isProcessAlive(payload.pid) ? 'held' : 'stale';
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return 'gone';
    throw ioError('检查锁文件', lockFile, error);
  }
}

async function tryCreate(lockFile: string, payload: LockPayload): Promise<boolean> {
  try {
    const handle = await open(lockFile, 'wx');
    try {
      await handle.writeFile(JSON.stringify(payload));
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') return false;
    throw ioError('创建锁文件', lockFile, error);
  }
}

async function release(lockFile: string, token: string): Promise<void> {
  const payload = await readPayload(lockFile);
  if (payload?.token === token) await rm(lockFile, { force: true });
}

/**
 * Runs `fn` while holding the project's exclusive write lock (`.ui-pro/lock`). Fails fast with
 * `E_LOCKED` when another live writer holds it; a lock owned by a dead process, or an unreadable
 * one older than 10 minutes, is broken. Breaking a stale lock is not atomic against a second breaker, which is
 * acceptable for the single-user, few-writers setting this tool targets.
 */
export async function withProjectLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const lockFile = scratchPath(root, 'lock');
  await mkdir(scratchPath(root), { recursive: true });
  const payload: LockPayload = {
    pid: process.pid,
    token: randomBytes(8).toString('hex'),
    createdAt: new Date().toISOString(),
  };

  let acquired = await tryCreate(lockFile, payload);
  if (!acquired) {
    const state = await inspectLock(lockFile);
    // A lock that vanished meanwhile is simply retried; removing is only for dead owners.
    if (state === 'stale') await rm(lockFile, { force: true });
    if (state !== 'held') acquired = await tryCreate(lockFile, payload);
  }
  if (!acquired) {
    const holder = await readPayload(lockFile);
    const shown = toPosix(lockFile);
    throw new UiProError(ErrorCodes.locked, '项目正被另一个写入者占用', {
      hint: `等待其完成后重试；确认没有 ui-pro 进程在运行时，可删除 ${shown}`,
      details: { lockFile: shown, holderPid: holder?.pid ?? null },
    });
  }

  try {
    return await fn();
  } finally {
    await release(lockFile, payload.token);
  }
}
