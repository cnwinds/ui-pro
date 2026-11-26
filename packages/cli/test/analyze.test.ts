import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AnalysisReport,
  addScreen,
  createProject,
  loadScreen,
  openProject,
  readCandidates,
} from '@ui-pro/core';
import { analyzePsdScreen } from '@ui-pro/psd';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { type Cli, cliIn, dataOf, snapshotTree, useTempDirs } from './helpers';

vi.mock('@ui-pro/psd', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ui-pro/psd')>()),
  analyzePsdScreen: vi.fn(),
}));

const makeDir = useTempDirs();

const SCREEN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">
  <rect width="480" height="360" fill="#f3e3c8"/>
  <rect x="30" y="30" width="420" height="300" rx="20" fill="#7a4b2a"/>
  <rect x="60" y="230" width="150" height="60" rx="14" fill="#e08a1e" stroke="#4a2410" stroke-width="3"/>
  <rect x="270" y="230" width="150" height="60" rx="14" fill="#3b7dd8" stroke="#4a2410" stroke-width="3"/>
  <text x="60" y="110" font-family="Arial, sans-serif" font-size="34" font-weight="bold" fill="#fff6e0">ATK</text>
  <text x="300" y="110" font-family="Arial, sans-serif" font-size="34" font-weight="bold" fill="#fff6e0">3,260</text>
  <text x="76" y="270" font-family="Arial, sans-serif" font-size="26" font-weight="bold" fill="#fff">Upgrade</text>
</svg>`;

interface Fixture {
  dir: string;
  cli: Cli;
}

function reopen(dir: string) {
  return openProject(dir, dir);
}

async function flatProject(): Promise<Fixture> {
  const root = await makeDir();
  const dir = join(root, 'proj');
  const project = await createProject(dir, { name: 'demo' });
  const png = join(root, 'ui.png');
  await writeFile(png, await sharp(Buffer.from(SCREEN_SVG)).png().toBuffer());
  await addScreen(project, { name: 'main', source: png });
  return { dir, cli: cliIn(dir) };
}

async function psdProject(): Promise<Fixture> {
  const root = await makeDir();
  const dir = join(root, 'proj');
  const project = await createProject(dir, { name: 'demo' });
  const header = Buffer.alloc(26);
  header.write('8BPS', 0, 'latin1');
  header.writeUInt16BE(1, 4);
  header.writeUInt32BE(1920, 14);
  header.writeUInt32BE(1080, 18);
  const psd = join(root, 'ui.psd');
  await writeFile(psd, header);
  await addScreen(project, { name: 'main', source: psd });
  return { dir, cli: cliIn(dir) };
}

describe('ui-pro analyze', () => {
  it('analyzes a flat screen into one version, and undo takes evidence and draft back', async () => {
    const { dir, cli } = await flatProject();

    const envelope = await cli.ok(['analyze']);

    const report = dataOf<AnalysisReport>(envelope);
    expect(report).toMatchObject({ screen: 'main', kind: 'flat', version: 2 });
    expect(report.candidates).toBeGreaterThan(3);
    expect(report.nodes).toBeGreaterThan(0);
    expect(envelope.summary).toContain('v2');
    expect(envelope.views?.length).toBeGreaterThan(0);
    for (const view of envelope.views ?? []) expect(existsSync(view)).toBe(true);
    expect(envelope.next?.join('\n')).toContain('ui-pro look');

    const texts = Object.values(loadScreen(reopen(dir), 'main').nodes)
      .filter((node) => node.type === 'text')
      .map((node) => node.text?.content);
    expect(texts).toEqual(expect.arrayContaining(['ATK', '3,260']));
    const values = Object.values(loadScreen(reopen(dir), 'main').nodes)
      .filter((node) => node.text?.kind === 'value')
      .map((node) => node.text?.content);
    expect(values).toEqual(['3,260']);

    const listed = dataOf<{ items: { version: number; message: string }[] }>(
      await cli.ok(['history', 'list']),
    );
    expect(listed.items.map((item) => [item.version, item.message])).toEqual([
      [1, '新增界面 main'],
      [2, '分析拍平图：main'],
    ]);

    const undone = await cli.ok(['history', 'undo']);
    expect(dataOf<{ revertOf: number }>(undone).revertOf).toBe(2);
    const reopened = reopen(dir);
    expect(readCandidates(reopened, 'main')).toBeNull();
    expect(Object.keys(loadScreen(reopened, 'main').nodes)).toEqual(['root']);
  }, 90_000);

  it('refuses to analyze a screen that already has nodes, and says how to start over', async () => {
    const { cli } = await flatProject();
    await cli.ok(['analyze']);

    const { code, error } = await cli.fail(['analyze']);

    expect(error.code).toBe('E_ALREADY_ANALYZED');
    expect(error.hint).toContain('history undo');
    expect(code).not.toBe(0);
  }, 90_000);

  it('writes nothing on a dry run, and reports what a real run would do', async () => {
    const { dir, cli } = await flatProject();
    const before = await snapshotTree(dir);

    const envelope = await cli.ok(['analyze', '--dry-run']);

    expect(await snapshotTree(dir)).toEqual(before);
    const report = dataOf<AnalysisReport>(envelope);
    expect(report.version).toBeUndefined();
    expect(report.views).toEqual([]);
    expect(report.candidates).toBeGreaterThan(3);
    expect(envelope.summary).toContain('预演');
    // Still free to analyze for real afterwards.
    expect(dataOf<AnalysisReport>(await cli.ok(['analyze'])).version).toBe(2);
  }, 90_000);

  it('does not implement --update yet', async () => {
    const { cli } = await flatProject();

    const { error } = await cli.fail(['analyze', '--update']);

    expect(error.code).toBe('E_NOT_IMPLEMENTED');
  });

  it('hands a PSD screen to the PSD analysis, with the options passed on', async () => {
    const { cli } = await psdProject();
    const report: AnalysisReport = {
      screen: 'main',
      kind: 'psd',
      grade: 'A',
      precheck: { upscale: 1, risks: [] },
      candidates: 5,
      clusters: 1,
      nodes: 4,
      version: 2,
      warnings: ['有一条提醒'],
      ask: [],
      views: [],
    };
    vi.mocked(analyzePsdScreen).mockResolvedValueOnce(report);

    const envelope = await cli.ok(['analyze', '--allow-degraded']);

    expect(vi.mocked(analyzePsdScreen)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(analyzePsdScreen).mock.calls[0]?.[2]).toMatchObject({
      allowDegraded: true,
      dryRun: false,
    });
    expect(envelope.summary).toContain('输入等级 A');
    expect(envelope.warnings).toEqual(['有一条提醒']);
    expect(dataOf<AnalysisReport>(envelope).kind).toBe('psd');
  });
});
