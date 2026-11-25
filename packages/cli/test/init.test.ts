import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cliIn, dataOf, treeProject, useTempDirs, writePng } from './helpers';

const makeDir = useTempDirs();

const ABSOLUTE_FORWARD_SLASH = /^(?:[A-Za-z]:)?\/[^\\]*$/;

describe('ui-pro init', () => {
  it('creates a project in the given directory', async () => {
    const cwd = await makeDir();
    const cli = cliIn(cwd);

    const envelope = await cli.ok(['init', 'game', '--name', 'Demo', '--design', '720x1280']);

    const data = dataOf<{ root: string; name: string; design: unknown; engine: string }>(envelope);
    expect(data).toMatchObject({ name: 'Demo', design: { width: 720, height: 1280 } });
    expect(data.root).toMatch(ABSOLUTE_FORWARD_SLASH);
    expect(data.root.endsWith('/game')).toBe(true);
    expect(envelope.summary).toContain('Demo');
    expect(envelope.summary).toContain('720x1280');
    expect((await stat(join(cwd, 'game', 'ui-pro.yaml'))).isFile()).toBe(true);
  });

  it('uses the working directory and its name by default', async () => {
    const cwd = join(await makeDir(), 'my-game');
    await mkdir(cwd);

    const envelope = await cliIn(cwd).ok(['init']);

    expect(dataOf<{ name: string; design: unknown }>(envelope)).toMatchObject({
      name: 'my-game',
      design: { width: 1080, height: 1920 },
    });
  });

  it('honours --project as the target directory', async () => {
    const cwd = await makeDir();

    await cliIn(cwd).ok(['--project', 'elsewhere', 'init']);

    expect((await stat(join(cwd, 'elsewhere', 'ui-pro.yaml'))).isFile()).toBe(true);
  });

  it('refuses to overwrite an existing project', async () => {
    const { dir } = await treeProject(makeDir);

    const { code, error } = await cliIn(dir).fail(['init']);

    expect(code).toBe(1);
    expect(error.code).toBe('E_PROJECT_EXISTS');
  });
});

describe('ui-pro init --screen', () => {
  it('adds a screen from a PNG as a new history version', async () => {
    const root = await makeDir();
    const cli = cliIn(root);
    await cli.ok(['init', 'game']);
    const game = cliIn(join(root, 'game'));
    await writePng(join(root, 'game', 'home.png'), 540, 960);

    const envelope = await game.ok(['init', '--screen', 'home', '--source', 'home.png']);

    expect(dataOf<Record<string, unknown>>(envelope)).toMatchObject({
      screen: 'home',
      version: 1,
      scale: 2,
      size: [1080, 1920],
      source: { width: 540, height: 960 },
    });
    expect(envelope.summary).toContain('540x960');
    expect(envelope.next?.[0]).toContain('--screen home');
    const nodes = await game.ok(['query', '*']);
    expect(dataOf<{ total: number }>(nodes).total).toBe(1);
  });

  it.each([
    ['without --source', ['init', '--screen', 'home']],
    ['--source without --screen', ['init', '--source', 'home.png']],
    ['with --name', ['init', '--screen', 'home', '--source', 'home.png', '--name', 'x']],
    ['with a directory argument', ['init', 'sub', '--screen', 'home', '--source', 'home.png']],
  ])('is a usage error %s', async (_label, args) => {
    const { cli } = await treeProject(makeDir);

    const { code, error } = await cli.fail(args);

    expect(code).toBe(2);
    expect(error.code).toBe('E_USAGE');
  });

  it('rejects a screen name that is not an identifier', async () => {
    const { dir, cli } = await treeProject(makeDir);
    await writePng(join(dir, 'x.png'), 100, 100);

    const { code, error } = await cli.fail(['init', '--screen', 'Bad Name', '--source', 'x.png']);

    expect(code).toBe(1);
    expect(error.code).toBe('E_NAME_INVALID');
  });

  it('rejects a screen that already exists', async () => {
    const { dir, cli } = await treeProject(makeDir);
    await writePng(join(dir, 'x.png'), 100, 100);

    const { error } = await cli.fail(['init', '--screen', 'main', '--source', 'x.png']);

    expect(error.code).toBe('E_SCREEN_EXISTS');
  });

  it('reports a corrupt image and, with --debug, why', async () => {
    const { dir, cli } = await treeProject(makeDir);
    await writeFile(join(dir, 'broken.png'), 'not a png');

    const quiet = await cli.run(['init', '--screen', 'broken', '--source', 'broken.png']);
    const verbose = await cli.run([
      '--debug',
      'init',
      '--screen',
      'broken',
      '--source',
      'broken.png',
    ]);

    expect(quiet.code).toBe(1);
    expect(quiet.envelope.ok).toBe(false);
    expect(quiet.stderr).toBe('');
    expect(verbose.stderr).toContain('[debug] 原因：');
    expect(await readFile(join(dir, 'ui-pro.yaml'), 'utf8')).toContain('demo');
  });

  it('fails outside a project', async () => {
    const cwd = await makeDir();
    await writePng(join(cwd, 'x.png'), 100, 100);

    const { code, error } = await cliIn(cwd).fail(['init', '--screen', 'x', '--source', 'x.png']);

    expect(code).toBe(1);
    expect(error.code).toBe('E_PROJECT_NOT_FOUND');
  });
});
