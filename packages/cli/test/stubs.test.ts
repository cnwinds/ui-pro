import { describe, expect, it } from 'vitest';
import { treeProject, useTempDirs } from './helpers';

const makeDir = useTempDirs();

describe('commands reserved for later iterations', () => {
  it.each([
    ['doctor'],
    ['analyze'],
    ['look'],
    ['snap'],
    ['build'],
    ['verify'],
    ['export'],
    ['psd', 'lint'],
    ['rules', 'list'],
    ['rules', 'why'],
    ['rules', 'check'],
    ['rules', 'lint'],
  ])('ui-pro %s fails with E_NOT_IMPLEMENTED', async (...path) => {
    const { cli } = await treeProject(makeDir);

    const { code, error } = await cli.fail(path);

    expect(code).toBe(1);
    expect(error.code).toBe('E_NOT_IMPLEMENTED');
    expect(error.message).toBe(`ui-pro ${path.join(' ')} 尚未实现`);
    expect(error.details).toEqual({ command: path.join(' ') });
  });

  it('accept the arguments their real versions will take', async () => {
    const { cli } = await treeProject(makeDir);

    const { error } = await cli.fail(['look', '#title', '--zoom', '2', 'extra']);

    expect(error.code).toBe('E_NOT_IMPLEMENTED');
  });

  it('are listed in --help as not implemented', async () => {
    const { cli } = await treeProject(makeDir);

    const { stdout } = await cli.raw(['--help']);

    expect(stdout).toMatch(/doctor\s.*（尚未实现）/);
  });
});
