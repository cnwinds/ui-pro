import { mkdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { commandModules } from '../src';
import { cliIn, treeProject, useTempDirs } from './helpers';

const makeDir = useTempDirs();

describe('command line envelope', () => {
  it('prints one success envelope and exits 0', async () => {
    const { cli } = await treeProject(makeDir);

    const { code, envelope, stderr } = await cli.run(['history', 'list']);

    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(envelope).toMatchObject({ ok: true, summary: '共 2 个版本' });
  });

  it('omits empty optional fields', async () => {
    const { cli } = await treeProject(makeDir);

    const { envelope } = await cli.run(['history', 'list']);

    expect(Object.keys(envelope)).toEqual(['ok', 'summary', 'data']);
  });

  it('turns an expected failure into an error envelope and exit 1', async () => {
    const dir = await makeDir();

    const { code, error } = await cliIn(dir).fail(['query', '#x']);

    expect(code).toBe(1);
    expect(error.code).toBe('E_PROJECT_NOT_FOUND');
    expect(error.message).toMatch(/[\u4e00-\u9fff]/);
    expect(error.hint).toBeDefined();
  });

  it('reports the same failure as plain text with --format text', async () => {
    const dir = await makeDir();

    const { code, stdout } = await cliIn(dir).raw(['--format', 'text', 'query', '#x']);

    expect(code).toBe(1);
    expect(stdout.startsWith('错误 [E_PROJECT_NOT_FOUND]：')).toBe(true);
    expect(stdout).toContain('提示：');
    expect(stdout.startsWith('{')).toBe(false);
  });

  it('reports a success as plain text with --format text', async () => {
    const { cli } = await treeProject(makeDir);

    const { code, stdout } = await cli.raw(['history', 'undo', '--format', 'text']);

    expect(code).toBe(0);
    expect(stdout.split('\n')[0]).toBe('已撤销 v2，生成 v3');
    expect(stdout).toContain('下一步：ui-pro history redo');
  });

  it('accepts global options on either side of the command', async () => {
    const { dir, cli } = await treeProject(makeDir);
    const elsewhere = cliIn(await makeDir());

    const before = await elsewhere.ok(['--project', dir, 'history', 'list']);
    const after = await elsewhere.ok(['history', 'list', '--project', dir]);

    expect(before.data).toEqual(after.data);
    expect(before.data).toEqual((await cli.ok(['history', 'list'])).data);
  });

  it('finds the project from a subdirectory of it', async () => {
    const { dir } = await treeProject(makeDir);
    const nested = `${dir}/evidence`;
    await mkdir(nested, { recursive: true });

    const envelope = await cliIn(nested).ok(['history', 'list']);

    expect(envelope.summary).toBe('共 2 个版本');
  });
});

describe('usage errors', () => {
  it.each([
    ['an unknown command', ['frobnicate']],
    ['an unknown option', ['history', 'list', '--bogus']],
    ['a missing argument', ['query']],
    ['an invalid --format', ['--format', 'xml', 'history', 'list']],
    ['an invalid number', ['query', '*', '--limit', '0']],
    ['a non-numeric number', ['history', 'show', 'abc']],
    ['a bad design size', ['init', '--design', '0x10']],
    ['an unknown engine', ['init', '--engine', 'unity3']],
    ['history without a subcommand', ['history']],
    ['rules without a subcommand', ['rules']],
    ['no command at all', []],
  ])('exit 2 for %s', async (_label, args) => {
    const { cli } = await treeProject(makeDir);

    const { code, error } = await cli.fail(args);

    expect(code).toBe(2);
    expect(error.code).toBe('E_USAGE');
    expect(error.message).toMatch(/[\u4e00-\u9fff]/);
    expect(error.hint).toBeDefined();
  });

  it('names the offending option', async () => {
    const { cli } = await treeProject(makeDir);

    const { error } = await cli.fail(['history', 'list', '--bogus']);

    expect(error.message).toContain('--bogus');
  });

  it('rejects an unknown query field and lists the valid ones', async () => {
    const { cli } = await treeProject(makeDir);

    const { code, error } = await cli.fail(['query', '*', '--fields', 'id,bogus']);

    expect(code).toBe(2);
    expect(error.message).toContain('bogus');
    expect(error.hint).toContain('rect');
  });
});

describe('help', () => {
  it('prints help as text and exits 0 without an envelope', async () => {
    const dir = await makeDir();

    const { code, stdout } = await cliIn(dir).raw(['--help']);

    expect(code).toBe(0);
    expect(stdout).toContain('Usage: ui-pro');
    for (const module of commandModules) expect(stdout).toContain(module.name);
    expect(stdout).toContain('--project');
  });

  it('prints help for one command', async () => {
    const dir = await makeDir();

    const { code, stdout } = await cliIn(dir).raw(['query', '--help']);

    expect(code).toBe(0);
    expect(stdout).toContain('--fields');
    expect(stdout).toContain('--tree');
  });
});

describe('command modules', () => {
  it('have unique names and cover the whole command surface', () => {
    const names = commandModules.map((module) => module.name);

    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        'init',
        'doctor',
        'analyze',
        'look',
        'snap',
        'psd',
        'query',
        'apply',
        'rules',
        'build',
        'verify',
        'export',
        'history',
        'schema',
      ]),
    );
  });
});
