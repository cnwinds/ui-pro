import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  addScreen,
  createProject,
  listHistory,
  loadScreen,
  openProject,
  readAssetManifest,
} from '@ui-pro/core';
import { createCloudImageModel, createModelStore, createPixelOps } from '@ui-pro/perception';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOps, seedSynthetic, syntheticSource } from '../../build/test/support';
import { registerPlugins } from '../src/plugins';
import { cliIn, dataOf, snapshotTree, useTempDirs } from './helpers';

// Models and the cloud are not what this file tests: the command is. The ops are the fast fake the
// build package's own tests use, and no cloud model is ever usable, whatever the environment says.
vi.mock('@ui-pro/perception', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ui-pro/perception')>()),
  createPixelOps: vi.fn(),
  createModelStore: vi.fn(),
  createCloudImageModel: vi.fn(),
}));

const makeDir = useTempDirs();

interface BuildData {
  screen: string;
  version?: number;
  assets: number;
  reused: number;
  generated: { local: number; cloud: number };
  approximations: Array<{ node: string; message: string }>;
  warnings: string[];
  views: string[];
}

beforeEach(() => {
  vi.mocked(createPixelOps).mockImplementation((context) => fakeOps(context));
  vi.mocked(createModelStore).mockImplementation(() => ({
    path: async () => {
      throw new Error('测试里不应加载模型');
    },
    has: async () => false,
  }));
  vi.mocked(createCloudImageModel).mockImplementation(() => null);
});

/** The synthetic 360x640 screen `main`, analysed as far as a build needs. */
async function builtProject(options: { analyzed?: boolean } = {}) {
  registerPlugins();
  const root = await makeDir();
  const dir = join(root, 'proj');
  const project = await createProject(dir, { name: 'demo', design: { width: 360, height: 640 } });
  const source = join(root, 'main.png');
  await writeFile(source, await syntheticSource());
  await addScreen(project, { name: 'main', source });
  await seedSynthetic(project, undefined, options);
  return { dir, root, project, cli: cliIn(dir) };
}

/** What undo restores: everything but the history itself and the scratch pictures. */
const withoutScratch = (tree: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(tree).filter(
      ([path]) => !path.startsWith('.ui-pro/') && !path.startsWith('history/'),
    ),
  );

describe('ui-pro build', () => {
  it('is a real command that lists its options', async () => {
    const { cli } = await builtProject();

    const help = await cli.raw(['build', '--help']);

    expect(help.code).toBe(0);
    for (const option of ['--final', '--draft', '--locked', '--regenerate', '--dry-run']) {
      expect(help.stdout).toContain(option);
    }
    expect(help.stdout).not.toContain('尚未实现');
  });

  it('builds the assets into one version and answers in the documented shape', async () => {
    const { dir, cli } = await builtProject();
    const versions = listHistory(openProject(dir, dir)).length;

    const envelope = await cli.ok(['build']);

    const report = dataOf<BuildData>(envelope);
    expect(report).toMatchObject({ screen: 'main', reused: 0 });
    expect(report.assets).toBeGreaterThan(5);
    expect(report.generated.cloud).toBe(0);
    expect(report.generated.local).toBeGreaterThan(0);
    expect(report.version).toBe(versions + 1);
    expect(envelope.summary).toBe(
      `已构建界面 main：资产 ${report.assets} 个（复用锁定输出 0 次，本地模型 ${report.generated.local} 次，云端 0 次）`,
    );
    expect(envelope.warnings).toContain(
      '没有云端图像模型，设置 DASHSCOPE_API_KEY 后运行 ui-pro build --final 换成终稿',
    );
    expect(envelope.warnings?.filter((warning) => warning.startsWith('近似项 #'))).toEqual(
      report.approximations.map((entry) => `近似项 #${entry.node}：${entry.message}`),
    );
    expect(report.approximations.length).toBeGreaterThan(0);
    expect(envelope.ask).toBeUndefined();
    expect(envelope.next?.[0]).toContain('ui-pro verify');
    expect(envelope.next?.join('\n')).toContain('ui-pro history undo');

    expect(envelope.views).toHaveLength(1);
    expect(envelope.views?.[0]).toMatch(/\.ui-pro\/build\/main\/sheet\.png$/);
    expect(existsSync(envelope.views?.[0] ?? '')).toBe(true);

    const reopened = openProject(dir, dir);
    const manifest = readAssetManifest(reopened, 'main');
    expect(manifest?.assets).toHaveLength(report.assets);
    expect(loadScreen(reopened, 'main').nodes.panel?.asset).toMatch(/panel/);
  });

  it('is undone by history undo, which takes the assets and the bindings back', async () => {
    const { dir, cli } = await builtProject();
    const before = withoutScratch(await snapshotTree(dir));

    await cli.ok(['build']);
    expect(withoutScratch(await snapshotTree(dir))).not.toEqual(before);
    const undone = await cli.ok(['history', 'undo']);

    expect(dataOf<{ revertOf: number }>(undone).revertOf).toBeGreaterThan(1);
    expect(withoutScratch(await snapshotTree(dir))).toEqual(before);
  });

  it('writes nothing on a dry run, and says what a real run would do', async () => {
    const { dir, cli } = await builtProject();
    const before = await snapshotTree(dir);

    const envelope = await cli.ok(['build', '--dry-run']);

    expect(await snapshotTree(dir)).toEqual(before);
    expect(envelope.summary).toMatch(/^预演完成（未写入）：界面 main 会有资产 \d+ 个/);
    expect(dataOf<BuildData>(envelope).version).toBeUndefined();
    expect(dataOf<BuildData>(envelope).assets).toBeGreaterThan(5);
    expect(envelope.views).toBeUndefined();
    expect(envelope.next?.[0]).toContain('去掉 --dry-run');
    expect(readAssetManifest(openProject(dir, dir), 'main')).toBeNull();
  });

  it('builds nothing new the second time, and reuses the locked outputs', async () => {
    const { dir, cli } = await builtProject();
    const first = dataOf<BuildData>(await cli.ok(['build']));
    const versions = listHistory(openProject(dir, dir)).length;

    const envelope = await cli.ok(['build']);

    const again = dataOf<BuildData>(envelope);
    expect(again.version).toBeUndefined();
    expect(again).toMatchObject({ assets: first.assets, generated: { local: 0, cloud: 0 } });
    expect(again.reused).toBe(first.generated.local);
    expect(envelope.summary).toContain(`复用锁定输出 ${first.generated.local} 次，本地模型 0 次`);
    expect(envelope.summary).toContain('没有写入新版本');
    expect(envelope.next?.join('\n')).not.toContain('history undo');
    expect(listHistory(openProject(dir, dir))).toHaveLength(versions);
  });

  it('remakes only the matched nodes with --regenerate', async () => {
    const { cli } = await builtProject();
    const first = dataOf<BuildData>(await cli.ok(['build']));

    const envelope = await cli.ok(['build', '--regenerate', '#star']);

    const report = dataOf<BuildData>(envelope);
    expect(report.generated.local).toBeGreaterThan(0);
    expect(report.generated.local).toBeLessThan(first.generated.local);
    expect(report.reused).toBe(first.generated.local - report.generated.local);
  });

  it('fails a --locked build that needs an output nobody has locked, naming node and step', async () => {
    const { dir, cli } = await builtProject();
    const before = await snapshotTree(dir);

    const { code, error } = await cli.fail(['build', '--locked']);

    expect(error.code).toBe('E_NOT_LOCKED');
    expect(error.message).toMatch(/#\w+/);
    expect(error.message).toMatch(/抠取|补全|文字剥离|提升分辨率/);
    expect(code).toBe(1);
    expect(await snapshotTree(dir)).toEqual(before);
  });

  it('accepts --locked once every output is locked', async () => {
    const { cli } = await builtProject();
    await cli.ok(['build']);

    const envelope = await cli.ok(['build', '--locked']);

    expect(dataOf<BuildData>(envelope).generated).toEqual({ local: 0, cloud: 0 });
  });

  it('sends a screen without evidence to ui-pro analyze', async () => {
    const { cli } = await builtProject({ analyzed: false });

    const { code, error } = await cli.fail(['build']);

    expect(error.code).toBe('E_BUILD_NOT_ANALYZED');
    expect(error.hint).toContain('ui-pro analyze');
    expect(code).toBe(1);
  });

  it('refuses --final without a cloud model, and says what to set', async () => {
    const { dir, cli } = await builtProject();
    const before = await snapshotTree(dir);

    const { error } = await cli.fail(['build', '--final']);

    expect(error.code).toBe('E_BUILD_NO_CLOUD');
    expect(error.hint).toContain('DASHSCOPE_API_KEY');
    expect(await snapshotTree(dir)).toEqual(before);
  });

  it('exits with the usage code for options that contradict each other', async () => {
    const { cli } = await builtProject();

    const both = await cli.fail(['build', '--final', '--draft']);
    const regenerate = await cli.fail(['build', '--locked', '--regenerate', '#star']);

    expect(both.code).toBe(2);
    expect(both.error.code).toBe('E_USAGE');
    expect(regenerate.code).toBe(2);
    expect(regenerate.error.code).toBe('E_USAGE');
  });

  it('takes the screen from the global --screen', async () => {
    const { cli } = await builtProject();

    const { error } = await cli.fail(['build', '--screen', 'other']);

    expect(error.code).toBe('E_SCREEN_NOT_FOUND');
  });
});
