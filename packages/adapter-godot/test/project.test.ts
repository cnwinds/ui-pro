import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isUiProError } from '@ui-pro/core';
import { describe, expect, it } from 'vitest';
import { inspectGodotTarget, prepareGodotProject, readDisplaySettings } from '../src';
import { useTempDirs } from './helpers';

const makeDir = useTempDirs();
const init = { name: 'demo', width: 1080, height: 1920 };

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return isUiProError(error) ? error.code : undefined;
  }
  return undefined;
}

describe('prepareGodotProject', () => {
  it('creates a minimal project in a directory that does not exist yet', async () => {
    const dir = join(await makeDir(), 'game', 'godot');

    const prepared = await prepareGodotProject(dir, init);

    expect(prepared).toEqual({ created: true, files: ['project.godot', '.gitignore'] });
    const text = await readFile(join(dir, 'project.godot'), 'utf8');
    expect(text).toContain('config_version=5');
    expect(text).toContain('config/name="demo"');
    expect(text).toContain('window/size/viewport_width=1080');
    expect(text).toContain('window/size/viewport_height=1920');
    expect(text).toContain('renderer/rendering_method="gl_compatibility"');
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('.godot/\n');
  });

  it('scales the window of a new project with canvas_items and expand', async () => {
    const dir = join(await makeDir(), 'godot');

    await prepareGodotProject(dir, init);

    expect(await readDisplaySettings(dir)).toEqual({
      width: 1080,
      height: 1920,
      stretchMode: 'canvas_items',
      stretchAspect: 'expand',
    });
  });

  it('does not change the display settings of an existing project', async () => {
    const dir = await makeDir();
    const text = '[display]\n\nwindow/size/viewport_width=720\n';
    await writeFile(join(dir, 'project.godot'), `config_version=5\n\n${text}`);

    await prepareGodotProject(dir, init);

    expect(await readFile(join(dir, 'project.godot'), 'utf8')).toBe(`config_version=5\n\n${text}`);
    expect(await readDisplaySettings(dir)).toEqual({
      width: 720,
      height: undefined,
      stretchMode: undefined,
      stretchAspect: undefined,
    });
  });

  it('creates a project in an empty directory', async () => {
    const dir = await makeDir();

    expect((await prepareGodotProject(dir, init)).created).toBe(true);
    expect((await readdir(dir)).sort()).toEqual(['.gitignore', 'project.godot']);
  });

  it('escapes quotes in the project name', async () => {
    const dir = await makeDir();

    await prepareGodotProject(dir, { ...init, name: 'say "hi"' });

    expect(await readFile(join(dir, 'project.godot'), 'utf8')).toContain(
      'config/name="say \\"hi\\""',
    );
  });

  it('leaves an existing Godot project exactly as it is', async () => {
    const dir = await makeDir();
    const original = 'config_version=5\n\n[display]\nwindow/size/viewport_width=720\n';
    await writeFile(join(dir, 'project.godot'), original);

    const prepared = await prepareGodotProject(dir, init);

    expect(prepared).toEqual({ created: false, files: [] });
    expect(await readFile(join(dir, 'project.godot'), 'utf8')).toBe(original);
    expect(await readdir(dir)).toEqual(['project.godot']);
  });

  it('refuses a non-empty directory without project.godot and writes nothing', async () => {
    const dir = await makeDir();
    await writeFile(join(dir, 'notes.txt'), 'mine');

    expect(await codeOf(prepareGodotProject(dir, init))).toBe('E_GODOT_BAD_TARGET');
    expect(await readdir(dir)).toEqual(['notes.txt']);
  });

  it('refuses a path that is a file', async () => {
    const dir = await makeDir();
    const file = join(dir, 'file');
    await writeFile(file, '');

    expect(await codeOf(prepareGodotProject(file, init))).toBe('E_GODOT_BAD_TARGET');
  });
});

describe('inspectGodotTarget', () => {
  it('tells an existing project from an empty target without writing', async () => {
    const root = await makeDir();
    const project = join(root, 'p');
    await mkdir(project);
    await writeFile(join(project, 'project.godot'), '');

    expect(await inspectGodotTarget(project)).toBe('existing');
    expect(await inspectGodotTarget(join(root, 'new'))).toBe('empty');
    expect(await readdir(root)).toEqual(['p']);
  });
});
