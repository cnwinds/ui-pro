import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  assetRelPath,
  createProject,
  type LockDoc,
  PROJECT_FILES,
  type Project,
  readLock,
  sha256Hex,
} from '@ui-pro/core';
import { describe, expect, it } from 'vitest';
import { BuildErrorCodes } from '../src/errors';
import { FileEgressLog, LockedStore } from '../src/store';
import { FIXED_NOW, failureOf, useTempDirs } from './support';

const makeDir = useTempDirs();
const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);
const png = (text: string) => new Uint8Array(Buffer.from(text));

async function newProject(): Promise<Project> {
  return createProject(join(await makeDir(), 'proj'), { name: 'demo' });
}

const storeOf = (
  project: Project,
  options: { allowNew?: boolean; bypass?: () => boolean } = {},
  lock?: LockDoc,
) =>
  new LockedStore(project, 'main', lock ?? readLock(project), {
    allowNew: options.allowNew ?? true,
    bypass: options.bypass,
    now: () => FIXED_NOW,
  });

describe('LockedStore.put', () => {
  it('places an output under gen/ and records it in the lock with the local model it came from', async () => {
    const project = await newProject();
    const store = storeOf(project);

    await store.put({ key: KEY, by: 'local:lama', png: png('one') });

    expect(store.stats).toEqual({ reused: 0, local: 1, cloud: 0 });
    expect(store.generatedFiles()).toEqual([{ path: `gen/${KEY}.png`, content: png('one') }]);
    const lock = store.lock(readLock(project), '1.2.3');
    expect(lock.tool).toBe('1.2.3');
    expect(lock.generated[KEY]).toEqual({
      file: assetRelPath('main', `gen/${KEY}.png`),
      sha256: sha256Hex(png('one')),
      by: 'local:lama',
      at: FIXED_NOW,
      alternatives: [],
    });
    expect(Object.keys(lock.models)).toEqual(['lama']);
    expect(lock.models.lama?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('counts cloud outputs apart and adds no model to the lock for them', async () => {
    const project = await newProject();
    const store = storeOf(project);

    await store.put({ key: KEY, by: 'cloud:dashscope/wanx2.1-imageedit', png: png('cloud') });

    expect(store.stats).toEqual({ reused: 0, local: 0, cloud: 1 });
    expect(store.lock(readLock(project), '0.0.0').models).toEqual({});
  });

  it('hands back the same lock when nothing was added', async () => {
    const project = await newProject();
    const base = readLock(project);

    expect(storeOf(project).lock(base, '9.9.9')).toBe(base);
  });

  it('never writes over an older output with different content', async () => {
    const project = await newProject();
    const store = storeOf(project);

    await store.put({ key: KEY, by: 'local:lama', png: png('first') });
    await store.put({ key: KEY, by: 'local:lama', png: png('second') });
    await store.put({ key: OTHER_KEY, by: 'local:lama', png: png('first') });

    expect(
      store
        .generatedFiles()
        .map((file) => file.path)
        .sort(),
    ).toEqual([`gen/${KEY}-r2.png`, `gen/${KEY}.png`, `gen/${OTHER_KEY}.png`]);
    expect(store.lock(readLock(project), '0.0.0').generated[KEY]?.file).toBe(
      assetRelPath('main', `gen/${KEY}-r2.png`),
    );
  });

  it('keeps the alternatives it was given next to the chosen output', async () => {
    const project = await newProject();
    const store = storeOf(project);

    await store.put({ key: KEY, by: 'cloud:dashscope/x', png: png('chosen') }, [
      png('b'),
      png('c'),
    ]);

    expect(
      store
        .generatedFiles()
        .map((file) => file.path)
        .sort(),
    ).toEqual([`gen/${KEY}-alt1.png`, `gen/${KEY}-alt2.png`, `gen/${KEY}.png`]);
    const entry = store.lock(readLock(project), '0.0.0').generated[KEY];
    expect(entry?.alternatives.map((alt) => alt.sha256)).toEqual([
      sha256Hex(png('b')),
      sha256Hex(png('c')),
    ]);
  });
});

describe('LockedStore.get', () => {
  async function lockedProject(content: string, recorded = content) {
    const project = await newProject();
    const file = assetRelPath('main', `gen/${KEY}.png`);
    await mkdir(dirname(join(project.root, ...file.split('/'))), { recursive: true });
    await writeFile(join(project.root, ...file.split('/')), content);
    const lock: LockDoc = {
      ...readLock(project),
      generated: {
        [KEY]: {
          file,
          sha256: sha256Hex(png(recorded)),
          by: 'local:lama',
          at: FIXED_NOW,
          alternatives: [],
        },
      },
    };
    return { project, lock };
  }

  it('answers from the lock and counts the reuse', async () => {
    const { project, lock } = await lockedProject('locked');
    const store = storeOf(project, {}, lock);

    const output = await store.get(KEY);

    expect(output).toEqual({ key: KEY, by: 'local:lama', png: png('locked') });
    expect(store.stats.reused).toBe(1);
    expect(await store.get(OTHER_KEY)).toBeUndefined();
    expect(store.stats.reused).toBe(1);
  });

  it('fails when the locked file is no longer what the lock recorded', async () => {
    const { project, lock } = await lockedProject('edited', 'original');
    const store = storeOf(project, {}, lock);

    const error = await failureOf(store.get(KEY));

    expect(error.code).toBe(BuildErrorCodes.lockMismatch);
    expect(error.message).toContain('哈希不一致');
    expect(error.hint).toContain('--regenerate');
  });

  it('answers nothing for a node being regenerated, without counting a reuse', async () => {
    const { project, lock } = await lockedProject('locked');
    const store = storeOf(project, { bypass: () => true }, lock);

    expect(await store.get(KEY)).toBeUndefined();
    expect(store.stats.reused).toBe(0);
  });

  it('answers nothing when the locked file is missing', async () => {
    const project = await newProject();
    const lock: LockDoc = {
      ...readLock(project),
      generated: {
        [KEY]: {
          file: assetRelPath('main', `gen/${KEY}.png`),
          sha256: sha256Hex(png('x')),
          by: 'local:lama',
          at: FIXED_NOW,
          alternatives: [],
        },
      },
    };

    expect(await storeOf(project, {}, lock).get(KEY)).toBeUndefined();
  });

  it('sees what this build already stored', async () => {
    const project = await newProject();
    const store = storeOf(project);
    await store.put({ key: KEY, by: 'local:lama', png: png('new') });

    expect((await store.get(KEY))?.png).toEqual(png('new'));
  });

  it('says whether new outputs may be made', async () => {
    const project = await newProject();

    expect(storeOf(project, { allowNew: false }).allowNew).toBe(false);
    expect(storeOf(project).allowNew).toBe(true);
  });
});

describe('FileEgressLog', () => {
  const record = (screen: string) => ({
    at: FIXED_NOW,
    model: 'dashscope/wanx2.1-imageedit',
    purpose: 'inpaint' as const,
    screen,
    node: 'panel',
    sha256: ['c'.repeat(64)],
    bytes: 1234,
  });

  it('appends one JSON line per call and counts them per screen', async () => {
    const project = await newProject();
    const log = new FileEgressLog(project);

    await log.append(record('main'));
    await log.append(record('main'));
    await log.append(record('shop'));

    const lines = (await readFile(join(project.root, PROJECT_FILES.egress), 'utf8'))
      .trim()
      .split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? '')).toEqual(record('main'));
    expect(await log.count('main')).toBe(2);
    expect(await log.count('shop')).toBe(1);
    expect(await log.count('other')).toBe(0);
  });

  it('counts nothing before the first call', async () => {
    const project = await newProject();

    expect(await new FileEgressLog(project).count('main')).toBe(0);
  });

  it('skips a damaged line instead of failing the build', async () => {
    const project = await newProject();
    const log = new FileEgressLog(project);
    await log.append(record('main'));
    await appendFile(join(project.root, PROJECT_FILES.egress), '{broken\n\n', 'utf8');
    await log.append(record('main'));

    expect(await log.count('main')).toBe(2);
  });
});
