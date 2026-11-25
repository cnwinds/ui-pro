import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isUiProError } from '@ui-pro/core';
import { describe, expect, it } from 'vitest';
import {
  checkGodotVersion,
  errorLines,
  findGodotExecutable,
  isSupportedVersion,
  locateGodot,
  parseGodotVersion,
} from '../src';
import { useTempDirs } from './helpers';

const makeDir = useTempDirs();

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isUiProError(error)) return error;
    throw error;
  }
  throw new Error('expected a UiProError');
}

describe('godot version', () => {
  it('reads major and minor from the first line of --version', () => {
    expect(parseGodotVersion('4.6.1.stable.official.14d19694e\n')).toEqual({
      version: '4.6.1.stable.official.14d19694e',
      major: 4,
      minor: 6,
    });
  });

  it('rejects output that is not a Godot version', () => {
    expect(parseGodotVersion('v24.1.0')).toBeUndefined();
    expect(parseGodotVersion('')).toBeUndefined();
  });

  it.each([
    [4, 6, true],
    [4, 7, true],
    [5, 0, true],
    [4, 5, false],
    [3, 9, false],
  ])('%i.%i supported: %s', (major, minor, supported) => {
    expect(isSupportedVersion(major, minor)).toBe(supported);
  });

  it('refuses a Godot older than 4.6 with E_GODOT_VERSION', () => {
    try {
      checkGodotVersion('D:/godot.exe', '4.5.2.stable.official.abc');
      expect.fail('should have thrown');
    } catch (error) {
      expect(isUiProError(error) && error.code).toBe('E_GODOT_VERSION');
      expect(isUiProError(error) && error.message).toBe(
        'Godot 版本过低：4.5.2.stable.official.abc，需要 4.6 及以上',
      );
    }
  });

  it('accepts 4.6 and newer', () => {
    expect(checkGodotVersion('D:/godot.exe', '4.7.2.stable.official.abc')).toMatchObject({
      executable: 'D:/godot.exe',
      major: 4,
      minor: 7,
    });
  });
});

describe('finding Godot', () => {
  it('reports E_GODOT_NOT_FOUND with the ways to set it when nothing is configured', async () => {
    const error = await failure(locateGodot({ PATH: '' }));

    expect(error.code).toBe('E_GODOT_NOT_FOUND');
    expect(error.message).toContain('UI_PRO_GODOT');
    expect(error.hint).toContain('UI_PRO_GODOT');
    expect(error.hint).toContain('PATH');
  });

  it('does not fall back to PATH when UI_PRO_GODOT points at a missing file', async () => {
    const dir = await makeDir();
    const name = process.platform === 'win32' ? 'godot.exe' : 'godot';
    await writeFile(join(dir, name), '');

    const env = { UI_PRO_GODOT: join(dir, 'missing.exe'), PATH: dir };
    const error = await failure(locateGodot(env));

    expect(findGodotExecutable(env)).toBeUndefined();
    expect(error.code).toBe('E_GODOT_NOT_FOUND');
    expect(error.message).toContain('指向的文件不存在');
  });

  it('prefers UI_PRO_GODOT over PATH', async () => {
    const dir = await makeDir();
    const configured = join(dir, 'custom-godot');
    await writeFile(configured, '');

    expect(findGodotExecutable({ UI_PRO_GODOT: configured, PATH: '' })).toBe(configured);
  });

  it.each(['godot', 'godot4'])('finds %s on PATH', async (name) => {
    const dir = await makeDir();
    const bin = join(dir, 'bin');
    await mkdir(bin);
    const file = join(bin, process.platform === 'win32' ? `${name}.exe` : name);
    await writeFile(file, '');

    expect(findGodotExecutable({ PATH: bin })).toBe(file);
  });

  it('rejects a program that is not Godot', async () => {
    const error = await failure(locateGodot({ UI_PRO_GODOT: process.execPath }));

    expect(error.code).toBe('E_GODOT_NOT_FOUND');
    expect(error.message).toContain('不像是 Godot');
  });
});

describe('errorLines', () => {
  it('keeps ERROR lines with their indented continuation', () => {
    const output = [
      'Godot Engine v4.6.1.stable.official.14d19694e',
      'ERROR: Failed loading resource: res://a.tscn.',
      '   at: _load (core/io/resource_loader.cpp:343)',
      '   GDScript backtrace (most recent call first):',
      '       [0] _build (res://addons/ui_pro/builder.gd:82)',
      'WARNING: something harmless',
      'SCRIPT ERROR: Parse Error: Expected expression.',
      '   at: GDScript::reload (res://x.gd:3)',
    ].join('\n');

    expect(errorLines(output)).toEqual([
      'ERROR: Failed loading resource: res://a.tscn.',
      '   at: _load (core/io/resource_loader.cpp:343)',
      '   GDScript backtrace (most recent call first):',
      '       [0] _build (res://addons/ui_pro/builder.gd:82)',
      'SCRIPT ERROR: Parse Error: Expected expression.',
      '   at: GDScript::reload (res://x.gd:3)',
    ]);
  });

  it('ignores the leak reports Godot prints at exit', () => {
    const output = [
      'WARNING: 2 RIDs of type "CanvasItem" were leaked.',
      '   at: _free_rids (servers/rendering/renderer_canvas_cull.cpp:2692)',
      "ERROR: 1 RID allocations of type 'PN13RendererDummy14TextureStorage12DummyTextureE' were leaked at exit.",
      'WARNING: ObjectDB instances leaked at exit (run with --verbose for details).',
      '   at: cleanup (core/object/object.cpp:2641)',
      'ERROR: 1 resources still in use at exit (run with --verbose for details).',
      '   at: clear (core/io/resource.cpp:810)',
    ].join('\n');

    expect(errorLines(output)).toEqual([]);
  });

  it('is empty for a clean run', () => {
    expect(errorLines('Godot Engine v4.6.1\n\nshot=0 size=(438, 652)\n')).toEqual([]);
  });
});
