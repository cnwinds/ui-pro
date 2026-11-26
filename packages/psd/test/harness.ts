import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addScreen, createProject, type Project, type ProjectConfig } from '@ui-pro/core';
import { afterEach } from 'vitest';
import { setRendererFactory } from '../src';
import { EmbeddedRenderer } from '../src/embedded-renderer';
import { DESIGN } from './fixtures';

/** Cleans up every directory the returned factory creates under the OS temp dir. */
export function useTempDirs(): () => Promise<string> {
  const created: string[] = [];
  afterEach(async () => {
    setRendererFactory(undefined);
    await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ui-pro-psd-test-'));
    created.push(dir);
    return dir;
  };
}

export interface PsdProject {
  dir: string;
  project: Project;
  screen: string;
  /** The PSD as it lies outside the project. */
  file: string;
}

export async function psdProject(
  makeDir: () => Promise<string>,
  bytes: Uint8Array,
  options: { egress?: ProjectConfig['egress']; name?: string } = {},
): Promise<PsdProject> {
  const root = await makeDir();
  const dir = join(root, 'proj');
  const project = await createProject(dir, {
    name: 'demo',
    design: DESIGN,
    egress: options.egress,
  });
  const file = join(root, 'ui.psd');
  await writeFile(file, bytes);
  await addScreen(project, { name: options.name ?? 'main', source: file });
  return { dir, project, screen: options.name ?? 'main', file };
}

/** Makes the analysis use the pixels stored in the file instead of Photopea; returns the renderer. */
export function useEmbeddedRenderer(): { renderers: EmbeddedRenderer[]; units(): number } {
  const renderers: EmbeddedRenderer[] = [];
  setRendererFactory(() => {
    const renderer = new EmbeddedRenderer();
    renderers.push(renderer);
    return renderer;
  });
  return { renderers, units: () => renderers.reduce((sum, r) => sum + r.renderedUnits, 0) };
}

/** Relative posix path -> sha256 of every file under `root`. */
export async function snapshotTree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else {
        const bytes = await readFile(join(dir, entry.name));
        result[rel] = createHash('sha256').update(bytes).digest('hex');
      }
    }
  }
  await walk(root, '');
  return result;
}
