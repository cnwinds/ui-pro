import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AssetRecord,
  assetRelPath,
  listHistory,
  readAssetManifest,
  readLock,
  sha256Hex,
  undo,
} from '@ui-pro/core';
import { PerceptionErrorCodes } from '@ui-pro/perception';
import { describe, expect, it } from 'vitest';
import { decodePng } from '../src/raster';
import {
  type BuildFixture,
  buildFixture,
  FAKE_CLOUD,
  failureOf,
  fakeOps,
  snapshotTree,
  useTempDirs,
} from './support';

const makeDir = useTempDirs();

const exception = (target: string, point: string, value: string) => ({
  op: 'exception.add',
  target,
  point,
  value,
  because: '测试需要这个取值',
});

const manifestOf = (fixture: BuildFixture) => {
  const manifest = readAssetManifest(fixture.project, 'main');
  if (manifest === null) throw new Error('没有资产清单');
  return manifest;
};

const recordOf = (fixture: BuildFixture, name: string): AssetRecord => {
  const record = manifestOf(fixture).assets.find((asset) => asset.name === name);
  if (record === undefined) throw new Error(`没有资产 ${name}`);
  return record;
};

const fileOf = (fixture: BuildFixture, record: AssetRecord) =>
  readFileSync(join(fixture.project.root, ...assetRelPath('main', record.file).split('/')));

describe('build: a flat screen', () => {
  it('writes the manifest, the files and the node bindings as one version', async () => {
    const fixture = await buildFixture(makeDir);
    const before = listHistory(fixture.project).length;

    const report = await fixture.run();

    expect(report.screen).toBe('main');
    expect(report.version).toBe(before + 1);
    expect(listHistory(fixture.project)).toHaveLength(before + 1);
    const manifest = manifestOf(fixture);
    expect(report.assets).toBe(manifest.assets.length);
    expect(manifest.assets.map((asset) => asset.name)).toEqual([
      'img_bg',
      'img_panel',
      'img_star',
      'btn_ok',
      'btn_ok_disabled',
      'btn_ok_pressed',
      'btn_a',
      'btn_a_pressed',
      'btn_c',
      'bar_bar',
      'img_bar_fill',
    ]);
    for (const record of manifest.assets) {
      expect(sha256Hex(fileOf(fixture, record))).toBe(record.sha256);
      expect(record.atlas).toBe('main');
    }
    expect(manifest.sourceSha256).toBe(fixture.load().source.sha256);
    expect(manifest.inputsSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('binds each node to its asset, states and nine-slice margins', async () => {
    const fixture = await buildFixture(makeDir);

    await fixture.run();

    const { nodes } = fixture.load();
    expect(nodes.bg?.asset).toBe('img_bg');
    expect(nodes.panel?.asset).toBe('img_panel');
    expect(nodes.panel?.nineSlice).toEqual([6, 6, 6, 6]);
    expect(nodes.bg?.nineSlice).toBeUndefined();
    expect(nodes.btn_ok?.states?.pressed?.asset).toBe('btn_ok_pressed');
    expect(nodes.btn_ok?.states?.disabled?.asset).toBe('btn_ok_disabled');
    // Two nodes that look the same share one picture.
    expect(nodes.btn_a?.asset).toBe('btn_a');
    expect(nodes.btn_b?.asset).toBe('btn_a');
    expect(nodes.btn_a?.states?.pressed?.asset).toBe('btn_a_pressed');
    // The text has no asset: the engine draws it.
    expect(nodes.title?.asset).toBeUndefined();
  });

  it('records where each asset came from and which holes it has', async () => {
    const fixture = await buildFixture(makeDir);

    await fixture.run();

    const panel = recordOf(fixture, 'img_panel');
    expect(panel.size).toEqual([14, 14]);
    expect(panel.nineSlice).toEqual([6, 6, 6, 6]);
    expect(panel.holes.map((hole) => [hole.node, hole.handling])).toEqual([
      ['star', 'filled'],
      ['title', 'stripped'],
    ]);
    expect(panel.steps.map((step) => step.step)).toEqual([
      'extract',
      'fill',
      'text-strip',
      'nine-slice',
      'tidy',
    ]);
    const bg = recordOf(fixture, 'img_bg');
    expect(bg.holes.map((hole) => hole.node)).toContain('ex_1');
    expect(bg.steps[0]).toMatchObject({ step: 'extract', method: 'crop' });
    const shared = recordOf(fixture, 'btn_a');
    expect(shared.uses.map((use) => use.node)).toEqual(['btn_a', 'btn_b']);
    expect(shared.steps.map((step) => step.step)).toContain('dedupe');
    const pressed = recordOf(fixture, 'btn_ok_pressed');
    expect(pressed.origin).toBe('derived');
    expect(pressed.uses).toEqual([{ node: 'btn_ok', state: 'pressed' }]);
    expect(pressed.steps.map((step) => step.step)).toEqual(['state']);
  });

  it('fills the text style it measured into the text nodes', async () => {
    const fixture = await buildFixture(makeDir);

    await fixture.run();

    expect(fixture.load().nodes.title?.text).toEqual({
      content: '标题',
      size: 19,
      color: '#1a1a1a',
    });
  });

  it('answers with a report of what was done', async () => {
    const fixture = await buildFixture(makeDir);

    const report = await fixture.run();

    expect(report.reused).toBe(0);
    expect(report.generated).toEqual({ local: 5, cloud: 0 });
    expect(report.ask).toEqual([]);
    expect(report.warnings).toEqual([
      '没有云端图像模型，设置 DASHSCOPE_API_KEY 后运行 ui-pro build --final 换成终稿',
    ]);
    expect(report.approximations).toEqual([
      expect.objectContaining({
        node: 'bar',
        message: expect.stringMatching(/^occlusion\.fill：/),
      }),
    ]);
    expect(report.views).toHaveLength(1);
    expect(report.views[0]).toMatch(/\.ui-pro\/build\/main\/sheet\.png$/);
    const sheet = await decodePng(readFileSync(report.views[0] ?? ''));
    expect(sheet.width).toBeGreaterThan(300);
  });

  it('undoes as one version', async () => {
    const fixture = await buildFixture(makeDir);
    const before = await snapshotTree(fixture.project.root);
    const docBefore = fixture.load();

    await fixture.run();
    await undo(fixture.project);

    expect(readAssetManifest(fixture.project, 'main')).toBeNull();
    expect(fixture.load()).toEqual(docBefore);
    expect(readLock(fixture.project).generated).toEqual({});
    const after = await snapshotTree(fixture.project.root);
    const stripped = (tree: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(tree).filter(
          ([path]) => !path.startsWith('history/') && !path.startsWith('.ui-pro/'),
        ),
      );
    expect(stripped(after)).toEqual(stripped(before));
  });

  it('makes no new version when nothing changed, and reuses every locked output', async () => {
    const fixture = await buildFixture(makeDir);
    await fixture.run();
    const versions = listHistory(fixture.project).length;
    const before = await snapshotTree(fixture.project.root);

    const again = await fixture.run();

    expect(again.version).toBeUndefined();
    expect(listHistory(fixture.project)).toHaveLength(versions);
    expect(again.reused).toBe(5);
    expect(again.generated).toEqual({ local: 0, cloud: 0 });
    const after = await snapshotTree(fixture.project.root);
    const changed = Object.keys(after).filter((path) => after[path] !== before[path]);
    expect(changed).toEqual([]);
  });

  it('keeps the inputs hash of the manifest equal to the current one after the build', async () => {
    const fixture = await buildFixture(makeDir);

    const report = await fixture.run();

    expect(report.warnings.some((warning) => warning.includes('输入哈希'))).toBe(false);
  });
});

describe('build: locked outputs', () => {
  it('names the node and the step when --locked needs an output the lock does not have', async () => {
    const fixture = await buildFixture(makeDir);
    const before = await snapshotTree(fixture.project.root);

    const error = await failureOf(fixture.run({ locked: true }));

    expect(error.code).toBe(PerceptionErrorCodes.notLocked);
    expect(error.message).toContain('#bg');
    expect(error.message).toContain('补全');
    expect(error.details).toMatchObject({ screen: 'main', node: 'bg', step: '补全' });
    expect(await snapshotTree(fixture.project.root)).toEqual(before);
  });

  it('reproduces a locked build without any new model run', async () => {
    const fixture = await buildFixture(makeDir);
    await fixture.run();

    const report = await fixture.run({ locked: true });

    expect(report.generated).toEqual({ local: 0, cloud: 0 });
    expect(report.reused).toBe(5);
    expect(report.version).toBeUndefined();
  });

  it('fails a locked build once a decision asks for something that was never locked', async () => {
    const fixture = await buildFixture(makeDir);
    await fixture.run();
    await fixture.apply([exception('#star', 'occlusion.fill', 'none')]);

    const error = await failureOf(fixture.run({ locked: true }));

    expect(error.code).toBe(PerceptionErrorCodes.notLocked);
    expect(error.details).toMatchObject({ step: '补全' });
  });

  it('does not accept --locked together with --regenerate', async () => {
    const fixture = await buildFixture(makeDir);

    const error = await failureOf(fixture.run({ locked: true, regenerate: '#panel' }));

    expect(error.code).toBe('E_USAGE');
  });
});

describe('build: --regenerate', () => {
  const lockedFiles = (fixture: BuildFixture) =>
    Object.values(readLock(fixture.project).generated).map((entry) => entry.file);

  it('makes only the matched nodes again and keeps the old outputs', async () => {
    const fixture = await buildFixture(makeDir);
    await fixture.run();
    const first = readLock(fixture.project);
    const oldFiles = lockedFiles(fixture);
    fixture.deps.now = () => '2027-02-02T00:00:00.000Z';
    fixture.retweak(1);

    const report = await fixture.run({ regenerate: '#panel' });

    expect(report.generated).toEqual({ local: 2, cloud: 0 });
    expect(report.reused).toBe(3);
    const second = readLock(fixture.project);
    const replaced = Object.keys(second.generated).filter(
      (key) => second.generated[key]?.at !== first.generated[key]?.at,
    );
    expect(replaced).toHaveLength(2);
    for (const key of Object.keys(first.generated)) {
      if (replaced.includes(key)) {
        expect(second.generated[key]?.file).toMatch(/-r2\.png$/);
      } else {
        expect(second.generated[key]).toEqual(first.generated[key]);
      }
    }
    for (const file of oldFiles) {
      expect(readFileSync(join(fixture.project.root, ...file.split('/'))).length).toBeGreaterThan(
        0,
      );
    }
  });

  it('also remakes what a hole node was part of', async () => {
    const fixture = await buildFixture(makeDir);
    await fixture.run();

    const star = await fixture.run({ regenerate: '#star' });
    const title = await fixture.run({ regenerate: '#title' });
    const star2 = await fixture.run({ regenerate: '#btn_ok' });

    // The star is a filled hole of the panel and the background; the title a stripped one.
    expect(star.generated.local).toBe(2);
    expect(title.generated.local).toBe(2);
    // The button leaves no model output behind.
    expect(star2.generated.local).toBe(0);
  });

  it('says so when the selector matches nothing on the screen', async () => {
    const fixture = await buildFixture(makeDir);

    const error = await failureOf(fixture.run({ regenerate: '#nope' }));

    expect(error.code).toBe('E_SELECTOR_EMPTY');
  });
});

describe('build: --dry-run', () => {
  it('computes the whole build and writes nothing', async () => {
    const fixture = await buildFixture(makeDir);
    const before = await snapshotTree(fixture.project.root);

    const report = await fixture.run({ dryRun: true });

    expect(report.version).toBeUndefined();
    expect(report.assets).toBe(11);
    expect(report.views).toEqual([]);
    expect(report.generated.local).toBe(5);
    expect(await snapshotTree(fixture.project.root)).toEqual(before);
  });

  it('does not use the cloud and says so', async () => {
    const fixture = await buildFixture(makeDir);
    fixture.deps.createCloudImageModel = () => FAKE_CLOUD;
    const clouds: unknown[] = [];
    fixture.deps.createPixelOps = (context) => {
      clouds.push(context.cloud);
      return fakeOps(context, fixture.calls);
    };

    const report = await fixture.run({ dryRun: true });

    expect(clouds.every((cloud) => cloud === null)).toBe(true);
    expect(report.warnings).toContain(
      '预演不调用云端图像模型，补全和放大只用本地方法；实际终稿的像素会不同',
    );
  });
});
