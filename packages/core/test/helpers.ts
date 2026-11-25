import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { afterEach } from 'vitest';
import {
  addScreen,
  applyOps,
  createProject,
  loadScreen,
  type Project,
  type ScreenDoc,
  screenRelPath,
  serializeScreen,
  UiProError,
} from '../src';

/** Registers cleanup for every directory the returned factory creates under the OS temp dir. */
export function useTempDirs(): () => Promise<string> {
  const created: string[] = [];
  afterEach(async () => {
    await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ui-pro-test-'));
    created.push(dir);
    return dir;
  };
}

export async function writePng(path: string, width: number, height: number): Promise<void> {
  const png = await sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 90, b: 160 } },
  })
    .png()
    .toBuffer();
  await writeFile(path, png);
}

/** Relative posix path -> sha256 of every file under `root`, for byte-exact comparisons. */
export async function snapshotTree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else
        result[rel] = createHash('sha256')
          .update(await readFile(join(dir, entry.name)))
          .digest('hex');
    }
  }
  await walk(root, '');
  return result;
}

export async function readText(project: Project, relPath: string): Promise<string> {
  return readFile(join(project.root, ...relPath.split('/')), 'utf8');
}

export interface Fixture {
  project: Project;
  /** Name of the one screen, which is 1080x1920 so design and source pixels coincide. */
  screen: string;
}

/**
 * A project whose only screen `main` is empty apart from its root. The default source is
 * 1080x1920, so design and source pixels coincide.
 */
export async function emptyScreenProject(
  makeDir: () => Promise<string>,
  source = { width: 1080, height: 1920 },
): Promise<Fixture> {
  const root = await makeDir();
  const project = await createProject(join(root, 'proj'), { name: 'demo' });
  const png = join(root, 'main.png');
  await writePng(png, source.width, source.height);
  await addScreen(project, { name: 'main', source: png });
  return { project, screen: 'main' };
}

/** Adds another empty screen, with a 100x100 source, to the project. */
export async function addEmptyScreen(project: Project, name: string): Promise<void> {
  const png = join(project.root, `${name}.png`);
  await writePng(png, 100, 100);
  await addScreen(project, { name, source: png });
}

/** Writes `evidence/candidates.json` for a screen; boxes are in source pixels. */
export async function writeCandidates(
  project: Project,
  screen: string,
  boxes: Record<string, [number, number, number, number]>,
): Promise<void> {
  const doc = {
    format: 'ui-pro/candidates',
    version: 1,
    sourceSha256: 'c'.repeat(64),
    candidates: Object.entries(boxes).map(([id, bbox]) => ({ id, source: 'cv', bbox })),
    clusters: [],
  };
  const path = join(project.root, ...screenRelPath(screen, 'candidates').split('/'));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(doc));
}

/** The error a promise rejects with; fails the test if it resolves or throws something else. */
export async function failureOf(promise: Promise<unknown>): Promise<UiProError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UiProError) return error;
    throw error;
  }
  throw new Error('expected the promise to reject with a UiProError');
}

export function failureOfSync(fn: () => unknown): UiProError {
  try {
    fn();
  } catch (error) {
    if (error instanceof UiProError) return error;
    throw error;
  }
  throw new Error('expected the function to throw a UiProError');
}

/**
 * `main` with a small tree:
 *
 *     root
 *     |- topbar (container)
 *     |  |- btn_shop (button)
 *     |  `- btn_mail (button)
 *     |- btn_upgrade (button)
 *     |  `- badge_dot (image, badge.notification)
 *     `- title (text)
 */
export async function treeFixture(makeDir: () => Promise<string>): Promise<Fixture> {
  const fixture = await emptyScreenProject(makeDir);
  const node = (
    id: string,
    type: string,
    rect: number[],
    parent: string,
    extra: Record<string, unknown> = {},
  ) => ({ op: 'node.add', node: { id, type, rect, parent: `#${parent}`, ...extra } });
  await applyOps(
    fixture.project,
    [
      node('topbar', 'container', [0, 0, 1080, 200], 'root'),
      node('btn_shop', 'button', [800, 20, 200, 80], 'topbar', { role: 'nav.shop' }),
      node('btn_mail', 'button', [600, 20, 150, 80], 'topbar', { role: 'nav.mail' }),
      node('btn_upgrade', 'button', [100, 1500, 300, 120], 'root'),
      node('badge_dot', 'image', [380, 1490, 36, 36], 'btn_upgrade', {
        role: 'badge.notification',
        concept: '红点',
      }),
      node('title', 'text', [300, 300, 480, 80], 'root', { text: { content: '标题' } }),
    ],
    { screen: fixture.screen, message: 'seed tree' },
  );
  return fixture;
}

/** Edits a screen document directly on disk, outside history; for setting up odd fixtures. */
export async function patchScreen(
  project: Project,
  name: string,
  mutate: (doc: ScreenDoc) => void,
): Promise<void> {
  const doc = loadScreen(project, name);
  mutate(doc);
  await writeFile(
    join(project.root, ...screenRelPath(name, 'doc').split('/')),
    serializeScreen(doc),
  );
}
