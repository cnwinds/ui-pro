import { describe, expect, it, vi } from 'vitest';
import { treeProject, useTempDirs } from './helpers';

vi.mock('@ui-pro/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ui-pro/core')>()),
  listHistory: () => {
    throw new TypeError('kaboom');
  },
}));

const makeDir = useTempDirs();

describe('an unexpected exception', () => {
  it('becomes E_INTERNAL with exit code 3 and no stack', async () => {
    const { cli } = await treeProject(makeDir);

    const { code, error } = await cli.fail(['history', 'list']);

    expect(code).toBe(3);
    expect(error.code).toBe('E_INTERNAL');
    expect(error.message).toBe('内部错误：kaboom');
    expect(error.hint).toContain('--debug');
    expect(error.details).toBeUndefined();
  });

  it('carries its stack when --debug is set', async () => {
    const { cli } = await treeProject(makeDir);

    const { code, error } = await cli.fail(['--debug', 'history', 'list']);

    expect(code).toBe(3);
    expect(error.details).toMatchObject({ stack: expect.stringContaining('kaboom') });
  });
});
