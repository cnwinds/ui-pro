import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import {
  type ApplyOptions,
  type ApplyResult,
  addScreen,
  applyOps,
  createCoreRegistry,
  createProject,
  loadScreen,
  type Project,
  type Registry,
  type ScreenDoc,
  UiProError,
} from '@ui-pro/core';
import { afterEach } from 'vitest';
import { registerRules } from '../src';

/** Registers cleanup for every directory the returned factory creates under the OS temp dir. */
export function useTempDirs(): () => Promise<string> {
  const created: string[] = [];
  afterEach(async () => {
    await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ui-pro-rules-test-'));
    created.push(dir);
    return dir;
  };
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

let cachedPng: Buffer | undefined;

/** A flat 1080x1920 PNG, built by hand so tests need no image library. */
function flatPng(): Buffer {
  if (cachedPng) return cachedPng;
  const width = 1080;
  const height = 1920;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height);
  cachedPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return cachedPng;
}

export interface Fixture {
  project: Project;
  /** The core registry plus the rules package. */
  registry: Registry;
  screen: string;
  apply(ops: unknown[], options?: ApplyOptions): Promise<ApplyResult>;
  /** The screen as stored on disk. */
  load(name?: string): ScreenDoc;
  readText(relPath: string): Promise<string>;
}

export function newRegistry(): Registry {
  const registry = createCoreRegistry();
  registerRules(registry);
  return registry;
}

/** Project `demo` with the 1080x1920 screen `main`, holding only its root node. */
export async function emptyFixture(makeDir: () => Promise<string>): Promise<Fixture> {
  const root = await makeDir();
  const project = await createProject(join(root, 'proj'), { name: 'demo' });
  const registry = newRegistry();
  await writeFile(join(root, 'main.png'), flatPng());
  await addScreen(project, { name: 'main', source: join(root, 'main.png') });
  const fixture: Fixture = {
    project,
    registry,
    screen: 'main',
    apply: (ops, options = {}) => applyOps(project, ops, { screen: 'main', registry, ...options }),
    load: (name = 'main') => loadScreen(project, name),
    readText: (relPath) => readFile(join(project.root, ...relPath.split('/')), 'utf8'),
  };
  return fixture;
}

/** Adds another screen of the same size. */
export async function addSecondScreen(fixture: Fixture, name: string): Promise<void> {
  const path = join(fixture.project.root, `${name}.png`);
  await writeFile(path, flatPng());
  await addScreen(fixture.project, { name, source: path });
}

export const node = (
  id: string,
  type: string,
  rect: number[],
  parent: string,
  extra: Record<string, unknown> = {},
) => ({ op: 'node.add', node: { id, type, rect, parent: `#${parent}`, ...extra } });

/**
 * `main` with the tree the CLI tests use:
 *
 *     root
 *     |- topbar (container)
 *     |  |- btn_shop (button, nav.shop)
 *     |  `- btn_mail (button, nav.mail)
 *     |- btn_upgrade (button)
 *     |  `- badge_dot (image, badge.notification, concept 红点)
 *     `- title (text)
 */
export async function treeFixture(makeDir: () => Promise<string>): Promise<Fixture> {
  const fixture = await emptyFixture(makeDir);
  await fixture.apply(
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
    { message: 'seed tree' },
  );
  return fixture;
}

/** A rule as the ops take it; `when` defaults to no conditions. */
export const ruleOf = (
  id: string,
  point: string,
  value: string,
  when: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => ({ id, point, when, value, because: '测试用的理由', ...extra });

export async function failureOf(promise: Promise<unknown>): Promise<UiProError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UiProError) return error;
    throw error;
  }
  throw new Error('expected the promise to reject with a UiProError');
}
