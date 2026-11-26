import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { addScreen, createProject, type Project, projectConfigCodec } from '@ui-pro/core';
import { EmbeddedRenderer, setRendererFactory } from '@ui-pro/psd';
import { afterEach, describe, expect, it } from 'vitest';
import { brokenPsd, compliantPsd, DESIGN, group, pixel, psdBytes } from '../../psd/test/fixtures';
import { cliIn, dataOf, snapshotTree, useTempDirs, writePng } from './helpers';

const makeDir = useTempDirs();

afterEach(() => setRendererFactory(undefined));

/** The renderer the tests use instead of Photopea: the layer pixels stored in the file. */
function useEmbeddedRenderer(): void {
  setRendererFactory(() => new EmbeddedRenderer());
}

interface LintData {
  file: string;
  grade: 'A' | 'B' | 'C' | null;
  canvas: { width: number; height: number };
  layers: number;
  issues: {
    severity: '必须' | '建议';
    category: 'file' | 'structure' | 'restore';
    code: string;
    layer?: string;
    message: string;
    fix: string;
  }[];
  restore: { checked: number; failed: number; skipped?: string; renderer?: string };
  unchecked: string[];
}

interface PsdSetup {
  root: string;
  dir: string;
  project: Project;
  /** The PSD lying next to the project. */
  file: string;
  cli: ReturnType<typeof cliIn>;
}

async function psdProject(bytes: Uint8Array): Promise<PsdSetup> {
  const root = await makeDir();
  const dir = join(root, 'proj');
  const project = await createProject(dir, { name: 'demo', design: DESIGN });
  const file = join(root, 'ui.psd');
  await writeFile(file, bytes);
  await addScreen(project, { name: 'main', source: file });
  return { root, dir, project, file, cli: cliIn(dir) };
}

async function looseFile(name: string, bytes: Uint8Array) {
  const dir = await makeDir();
  await writeFile(join(dir, name), bytes);
  return { dir, cli: cliIn(dir) };
}

describe('ui-pro psd lint', () => {
  it('is registered as a real command', async () => {
    const { cli } = await looseFile('x.psd', compliantPsd());
    const help = await cli.raw(['psd', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('lint');
    expect(help.stdout).not.toContain('尚未实现');
  });

  it('lists every problem of a file outside any project, with fixes, and succeeds', async () => {
    useEmbeddedRenderer();
    const { dir, cli } = await looseFile('broken.psd', brokenPsd());
    const envelope = await cli.ok(['psd', 'lint', 'broken.psd']);
    const data = dataOf<LintData>(envelope);

    expect(data).toMatchObject({ file: 'broken.psd', grade: 'C' });
    expect(envelope.summary).toContain('输入等级 C');
    expect(envelope.summary).toContain('必须修改');
    const byCode = new Map(data.issues.map((issue) => [issue.code, issue]));
    expect(byCode.get('no-composite')).toMatchObject({ severity: '必须', category: 'file' });
    expect(byCode.get('group-prefix')).toMatchObject({
      severity: '必须',
      category: 'structure',
      layer: 'Group 1',
    });
    for (const issue of data.issues) {
      expect(issue.message).toMatch(/\S/);
      expect(issue.fix).toMatch(/\S/);
    }
    expect(data.unchecked.join('\n')).toContain('粒度');
    // Without a project there is no design resolution to compare the canvas with.
    expect(byCode.has('canvas-size')).toBe(false);
    expect(data.unchecked.join('\n')).toContain('画布尺寸');

    const checklist = join(dir, '.ui-pro', 'psd-lint', 'broken.md');
    expect(envelope.views).toEqual([checklist.replaceAll('\\', '/')]);
    expect(await readFile(checklist, 'utf8')).toContain('## 必须修改');
    expect(envelope.next?.[0]).toContain('ui-pro psd lint');
  });

  it('grades a compliant file A and has nothing to ask for', async () => {
    useEmbeddedRenderer();
    const { dir, cli } = await psdProject(compliantPsd());
    const envelope = await cli.ok(['psd', 'lint', '../ui.psd']);
    expect(dataOf<LintData>(envelope)).toMatchObject({
      grade: 'A',
      issues: [],
      restore: { failed: 0, renderer: 'embedded' },
    });
    expect(envelope.summary).toContain('输入等级 A，必须修改 0 项，建议修改 0 项');
    expect(envelope.warnings).toBeUndefined();
    expect(envelope.next).toBeUndefined();
    expect(existsSync(join(dir, '.ui-pro', 'psd-lint', 'ui.md'))).toBe(true);
  });

  it('knows the prefixes the project adds in psd.prefixes', async () => {
    useEmbeddedRenderer();
    const layers = [
      pixel('bg_main', [0, 0, 200, 320], [20, 24, 40, 255]),
      group('cell_one', [pixel('base', [10, 10, 40, 20], [40, 120, 220, 255])]),
    ];
    const { cli, dir, root } = await psdProject(psdBytes(layers, DESIGN));
    const file = join(root, 'ui.psd');
    const codes = async () =>
      dataOf<LintData>(await cli.ok(['psd', 'lint', file])).issues.map((issue) => issue.code);
    expect(await codes()).toEqual(['group-prefix']);

    const configPath = join(dir, 'ui-pro.yaml');
    const config = projectConfigCodec.parse(await readFile(configPath, 'utf8'), 'ui-pro.yaml');
    config.psd = { prefixes: { cell_: 'container:list-item' } };
    await writeFile(configPath, projectConfigCodec.serialize(config));
    expect(await codes()).toEqual([]);
  });

  it('checks the source of the current screen when no file is given', async () => {
    useEmbeddedRenderer();
    const { cli } = await psdProject(brokenPsd());
    const data = dataOf<LintData>(await cli.ok(['psd', 'lint']));
    expect(data.file).toBe('ui.psd');
    expect(data.grade).toBe('C');
    // In a project the canvas is compared with the design resolution.
    expect(data.issues.map((issue) => issue.code)).toContain('canvas-size');
  });

  it('does not render with --no-render and says the grade is open', async () => {
    const { cli } = await looseFile('ui.psd', compliantPsd());
    const envelope = await cli.ok(['psd', 'lint', 'ui.psd', '--no-render']);
    expect(dataOf<LintData>(envelope)).toMatchObject({ grade: null, restore: { checked: 0 } });
    expect(envelope.summary).toContain('待定');
    expect(envelope.warnings?.join('\n')).toContain('还原没有核对');
  });

  it('does not hide a renderer failure it does not know', async () => {
    const { cli } = await looseFile('ui.psd', compliantPsd());
    setRendererFactory(() => ({
      name: 'broken',
      capabilities: { network: false },
      render: () => Promise.reject(new Error('boom')),
      close: async () => {},
    }));
    const failing = await cli.fail(['psd', 'lint', 'ui.psd']);
    // An unexpected renderer failure is not hidden: only the documented ones are skipped.
    expect(failing.error.code).toBe('E_INTERNAL');
  });

  it('fails with a pointer when the file is missing, unreadable, or not given', async () => {
    const { dir, cli } = await looseFile('junk.psd', new TextEncoder().encode('nope'));
    expect((await cli.fail(['psd', 'lint', 'missing.psd'])).error.code).toBe('E_IO');
    const unreadable = await cli.fail(['psd', 'lint', 'junk.psd']);
    expect(unreadable).toMatchObject({ code: 1, error: { code: 'E_PSD_UNREADABLE' } });
    expect(unreadable.error.hint).toBeDefined();
    expect((await cli.fail(['psd', 'lint'])).error.code).toBe('E_PROJECT_NOT_FOUND');

    const project = await createProject(join(dir, 'flatproj'), { name: 'flat', design: DESIGN });
    await writePng(join(dir, 'flat.png'), DESIGN.width, DESIGN.height);
    await addScreen(project, { name: 'main', source: join(dir, 'flat.png') });
    const flat = await cliIn(join(dir, 'flatproj')).fail(['psd', 'lint']);
    expect(flat.error.code).toBe('E_PSD_SOURCE');
  });
});

describe('ui-pro analyze on a PSD screen', () => {
  it('analyzes a compliant file into one version and reports the grade', async () => {
    useEmbeddedRenderer();
    const { cli } = await psdProject(compliantPsd());
    const envelope = await cli.ok(['analyze']);
    expect(
      dataOf<{ grade: string; candidates: number; nodes: number; version: number }>(envelope),
    ).toMatchObject({
      grade: 'A',
      candidates: 13,
      nodes: 7,
      version: 2,
    });
    expect(envelope.summary).toContain('输入等级 A');
    expect(envelope.ask?.map((question) => question.id)).toEqual(['psd.badge-role']);
    expect(envelope.views?.[0]).toMatch(/evidence\/composite\.png$/);
    const history = await cli.ok(['history', 'list']);
    expect(JSON.stringify(history.data)).toContain('分析 PSD');
    await cli.ok(['history', 'undo']);
    expect(JSON.stringify((await cli.ok(['history', 'list'])).data)).toContain('撤销');
  });

  it('refuses a file below grade A and puts the fix list in the error', async () => {
    useEmbeddedRenderer();
    const { cli, dir } = await psdProject(brokenPsd());
    const before = await snapshotTree(join(dir, 'screens'));
    const failure = await cli.fail(['analyze']);
    expect(failure.error.code).toBe('E_PSD_GRADE');
    const details = failure.error.details as { grade: string; fixList: string[] };
    expect(details.grade).toBe('C');
    expect(details.fixList.length).toBeGreaterThan(0);
    expect(failure.error.hint).toContain('--allow-degraded');
    expect(await snapshotTree(join(dir, 'screens'))).toEqual(before);
  });

  it('goes ahead with --allow-degraded and warns', async () => {
    useEmbeddedRenderer();
    const { cli } = await psdProject(brokenPsd());
    const envelope = await cli.ok(['analyze', '--allow-degraded']);
    expect(dataOf<{ grade: string }>(envelope).grade).toBe('C');
    expect(envelope.warnings?.join('\n')).toContain('Group 1');
  });

  it('writes nothing with --dry-run', async () => {
    useEmbeddedRenderer();
    const { cli, dir } = await psdProject(compliantPsd());
    const before = await snapshotTree(dir);
    const envelope = await cli.ok(['analyze', '--dry-run']);
    expect(envelope.summary).toContain('预演完成');
    expect(await snapshotTree(dir)).toEqual(before);
  });

  it('says so when a project keeps data local and Photopea is the renderer', async () => {
    const root = await makeDir();
    const dir = join(root, 'proj');
    const project = await createProject(dir, { name: 'demo', design: DESIGN, egress: 'local' });
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'ui.psd'), compliantPsd());
    await addScreen(project, { name: 'main', source: join(root, 'ui.psd') });
    const failure = await cliIn(dir).fail(['analyze']);
    expect(failure.error.code).toBe('E_PSD_EGRESS');
  });
});
