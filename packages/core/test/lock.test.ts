import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyOps, ErrorCodes, listHistory, loadScreen, withProjectLock } from '../src';
import { emptyScreenProject, failureOf, useTempDirs } from './helpers';

const makeDir = useTempDirs();

const addNode = (id: string) => ({
  op: 'node.add',
  node: { id, type: 'text', rect: [0, 0, 10, 10] },
});

async function writeLock(root: string, content: string, ageMs = 0): Promise<string> {
  const path = join(root, '.ui-pro', 'lock');
  await writeFile(path, content);
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs);
    await utimes(path, then, then);
  }
  return path;
}

/** A process id that is guaranteed not to belong to a running process. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '0']);
  if (child.pid === undefined) throw new Error('could not spawn a child process');
  return child.pid;
}

const lockPayload = (pid: number) =>
  JSON.stringify({ pid, token: 'foreign', createdAt: new Date().toISOString() });

describe('project lock', () => {
  it('turns away a second writer with E_LOCKED while the first is running', async () => {
    const { project, screen } = await emptyScreenProject(makeDir);

    await withProjectLock(project.root, async () => {
      const error = await failureOf(applyOps(project, [addNode('extra')], { screen }));

      expect(error.code).toBe(ErrorCodes.locked);
      expect(error.hint).toContain('.ui-pro/lock');
      expect(error.details).toMatchObject({ holderPid: process.pid });
    });

    expect(loadScreen(project, screen).nodes.extra).toBeUndefined();
    await applyOps(project, [addNode('extra')], { screen });
    expect(loadScreen(project, screen).nodes.extra).toBeDefined();
  });

  it('removes the lock file when the work succeeds or fails', async () => {
    const { project } = await emptyScreenProject(makeDir);
    const lockFile = join(project.root, '.ui-pro', 'lock');

    await withProjectLock(project.root, async () => {
      expect(existsSync(lockFile)).toBe(true);
    });
    expect(existsSync(lockFile)).toBe(false);

    await expect(
      withProjectLock(project.root, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(existsSync(lockFile)).toBe(false);
  });

  it('breaks a lock whose owner process is gone', async () => {
    const { project, screen } = await emptyScreenProject(makeDir);
    await writeLock(project.root, lockPayload(deadPid()));

    await applyOps(project, [addNode('extra')], { screen });

    expect(loadScreen(project, screen).nodes.extra).toBeDefined();
    expect(existsSync(join(project.root, '.ui-pro', 'lock'))).toBe(false);
  });

  it('keeps a lock of a live owner however old it is', async () => {
    const { project, screen } = await emptyScreenProject(makeDir);
    const lockFile = await writeLock(project.root, lockPayload(process.pid), 60 * 60 * 1000);

    const error = await failureOf(applyOps(project, [addNode('extra')], { screen }));

    expect(error.code).toBe(ErrorCodes.locked);
    expect(await readFile(lockFile, 'utf8')).toContain('foreign');
  });

  it('respects a fresh lock of a live process', async () => {
    const { project, screen } = await emptyScreenProject(makeDir);
    const lockFile = await writeLock(project.root, lockPayload(process.pid));

    const error = await failureOf(applyOps(project, [addNode('extra')], { screen }));

    expect(error.code).toBe(ErrorCodes.locked);
    expect(await readFile(lockFile, 'utf8')).toContain('foreign');
  });

  it('judges an unreadable lock file by its age alone', async () => {
    const { project, screen } = await emptyScreenProject(makeDir);
    await writeLock(project.root, 'not json');
    const fresh = await failureOf(applyOps(project, [addNode('extra')], { screen }));
    expect(fresh.code).toBe(ErrorCodes.locked);

    await writeLock(project.root, 'not json', 11 * 60 * 1000);
    await applyOps(project, [addNode('extra')], { screen });
    expect(loadScreen(project, screen).nodes.extra).toBeDefined();
  });

  it('never removes a lock that another writer put in its place', async () => {
    const { project } = await emptyScreenProject(makeDir);
    const lockFile = join(project.root, '.ui-pro', 'lock');

    await withProjectLock(project.root, async () => {
      await writeFile(lockFile, lockPayload(process.pid));
    });

    expect(await readFile(lockFile, 'utf8')).toContain('foreign');
  });

  it("keeps concurrent writers from losing each other's changes", async () => {
    const { project, screen } = await emptyScreenProject(makeDir);
    const ids = Array.from({ length: 8 }, (_, index) => `node_${index}`);

    const outcomes = await Promise.allSettled(
      ids.map((id) => applyOps(project, [addNode(id)], { screen })),
    );

    const committed = ids.filter((_, index) => outcomes[index]?.status === 'fulfilled');
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected')
        expect(outcome.reason).toMatchObject({ code: ErrorCodes.locked });
    }
    expect(committed.length).toBeGreaterThan(0);
    expect(
      Object.keys(loadScreen(project, screen).nodes)
        .filter((id) => id !== 'root')
        .sort(),
    ).toEqual([...committed].sort());
    // The screen was added as v1; every successful writer made exactly one more version.
    expect(listHistory(project).map((entry) => entry.version)).toEqual(
      Array.from({ length: committed.length + 1 }, (_, index) => index + 1),
    );
  });
});
