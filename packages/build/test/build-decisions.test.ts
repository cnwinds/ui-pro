import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AssetRecord, PROJECT_FILES, readAssetManifest, UiProError } from '@ui-pro/core';
import { PerceptionErrorCodes } from '@ui-pro/perception';
import { checkRules, readRuleInputs } from '@ui-pro/rules';
import { describe, expect, it } from 'vitest';
import { BuildErrorCodes } from '../src';
import {
  type BuildFixture,
  buildFixture,
  FAKE_CLOUD,
  failureOf,
  fakeOps,
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

const qualities = (fixture: BuildFixture) =>
  new Set(fixture.calls.filter((call) => call.step === 'fill').map((call) => call.quality));

/** Wraps the fake ops so the cloud model each build was given is recorded. */
function watchClouds(fixture: BuildFixture): unknown[] {
  const clouds: unknown[] = [];
  fixture.deps.createPixelOps = (context) => {
    clouds.push(context.cloud);
    return fakeOps(context, fixture.calls);
  };
  return clouds;
}

describe('build: what it needs first', () => {
  it('asks for an analysis when the screen has no evidence', async () => {
    const fixture = await buildFixture(makeDir, { analyzed: false });

    const error = await failureOf(fixture.run());

    expect(error.code).toBe(BuildErrorCodes.notAnalyzed);
    expect(error.hint).toContain('ui-pro analyze');
  });

  it('lists the nodes whose decisions are missing', async () => {
    const fixture = await buildFixture(makeDir);
    await fixture.tamper((doc) => {
      const panel = doc.nodes.panel;
      if (panel) panel.decisions = {};
    });

    const error = await failureOf(fixture.run());

    expect(error.code).toBe(BuildErrorCodes.decisions);
    expect(error.message).toContain('#panel');
    expect(error.hint).toContain('ui-pro rules why');
    expect(error.hint).toContain('rule.recompute');
    expect(error.details).toMatchObject({
      problems: [expect.objectContaining({ kind: 'missing', node: 'panel' })],
    });
  });

  it('refuses decisions that are ambiguous', async () => {
    const fixture = await buildFixture(makeDir);
    await writeFile(
      join(fixture.project.root, PROJECT_FILES.projectRules),
      [
        'format: ui-pro/rules',
        'version: 1',
        'rules:',
        '  - { id: a.tint, point: variant.mode, when: { type: button }, value: tint, because: 测试 }',
        '  - { id: a.assets, point: variant.mode, when: { type: button }, value: variant-assets, because: 测试 }',
        '',
      ].join('\n'),
    );
    await fixture.apply([{ op: 'rule.recompute' }]);

    const error = await failureOf(fixture.run());

    expect(error.code).toBe(BuildErrorCodes.decisions);
    expect(error.message).toContain('variant.mode');
  });
});

describe('build: draft and final', () => {
  it('goes draft without a cloud image model and says how to get a final', async () => {
    const fixture = await buildFixture(makeDir);

    const report = await fixture.run();

    expect(report.warnings).toContain(
      '没有云端图像模型，设置 DASHSCOPE_API_KEY 后运行 ui-pro build --final 换成终稿',
    );
    expect(qualities(fixture)).toEqual(new Set(['draft']));
  });

  it('refuses --final when no cloud image model can be used', async () => {
    const fixture = await buildFixture(makeDir);

    const error = await failureOf(fixture.run({ quality: 'final' }));

    expect(error.code).toBe(BuildErrorCodes.noCloud);
    expect(error.message).toContain('DASHSCOPE_API_KEY');
    expect(error.hint).toContain('--draft');
  });

  it('goes final by default once a cloud image model is available', async () => {
    const fixture = await buildFixture(makeDir);
    fixture.deps.createCloudImageModel = () => FAKE_CLOUD;
    const clouds = watchClouds(fixture);

    const report = await fixture.run();

    expect(clouds).toEqual([FAKE_CLOUD]);
    expect(report.warnings).toEqual([]);
    expect(qualities(fixture)).toEqual(new Set(['final']));
  });

  it('keeps to local models under --draft even with a cloud model', async () => {
    const fixture = await buildFixture(makeDir);
    fixture.deps.createCloudImageModel = () => FAKE_CLOUD;
    const clouds = watchClouds(fixture);

    const report = await fixture.run({ quality: 'draft' });

    expect(clouds).toEqual([null]);
    expect(report.warnings).toEqual([]);
  });

  it('never asks for a cloud model when the project keeps everything local', async () => {
    const fixture = await buildFixture(makeDir, { egress: 'local' });
    let asked = 0;
    fixture.deps.createCloudImageModel = () => {
      asked++;
      return FAKE_CLOUD;
    };

    const draft = await fixture.run();
    const error = await failureOf(fixture.run({ quality: 'final' }));

    expect(asked).toBe(0);
    expect(draft.warnings).toHaveLength(1);
    expect(error.code).toBe(BuildErrorCodes.noCloud);
    expect(error.message).toContain('local');
  });

  it('carries on with local methods and asks when the cloud budget runs out', async () => {
    const fixture = await buildFixture(makeDir);
    fixture.deps.createCloudImageModel = () => FAKE_CLOUD;
    fixture.deps.createPixelOps = (context) => {
      const local = fakeOps(context, fixture.calls);
      if (context.cloud === null) return local;
      return {
        ...local,
        fill: () =>
          Promise.reject(
            new UiProError(PerceptionErrorCodes.imageBudget, '界面 main 的云端图像调用已达上限'),
          ),
      };
    };

    const report = await fixture.run();

    expect(report.assets).toBe(11);
    expect(report.ask).toEqual([
      expect.objectContaining({
        id: 'build.image-budget',
        options: ['提高上限', '保持现状'],
        default: '保持现状',
      }),
    ]);
    expect(report.warnings.some((warning) => warning.includes('上限'))).toBe(true);
    expect(qualities(fixture)).toEqual(new Set(['draft']));
  });
});

describe('build: variants and states', () => {
  const tintAll = (fixture: BuildFixture) =>
    fixture.apply(
      ['btn_a', 'btn_b', 'btn_c'].map((node) => exception(`#${node}`, 'variant.mode', 'tint')),
    );

  it('shares one picture between the same shape in different colours when the decision is tint', async () => {
    const fixture = await buildFixture(makeDir);
    await tintAll(fixture);

    await fixture.run();

    const { nodes } = fixture.load();
    expect(nodes.btn_a?.asset).toBe('btn_a');
    expect(nodes.btn_b?.asset).toBe('btn_a');
    expect(nodes.btn_c?.asset).toBe('btn_a');
    expect(nodes.btn_a?.tint).toBe('#ffffff');
    expect(nodes.btn_b?.tint).toBe('#ffffff');
    const channels = [1, 3, 5].map((at) =>
      Number.parseInt(nodes.btn_c?.tint?.slice(at, at + 2) ?? '', 16),
    );
    for (const channel of channels) expect(Math.abs(channel - 128)).toBeLessThanOrEqual(2);
    expect(manifestOf(fixture).assets.some((asset) => asset.name === 'btn_c')).toBe(false);
    expect(
      recordOf(fixture, 'btn_a').uses.map((use) => [use.node, use.tint !== undefined]),
    ).toEqual([
      ['btn_a', true],
      ['btn_b', true],
      ['btn_c', true],
    ]);
  });

  it('keeps variants as separate assets when the decision is variant-assets', async () => {
    const fixture = await buildFixture(makeDir);

    await fixture.run();

    const { nodes } = fixture.load();
    expect(nodes.btn_c?.asset).toBe('btn_c');
    expect(nodes.btn_c?.tint).toBeUndefined();
    expect(nodes.btn_a?.tint).toBeUndefined();
  });

  it('makes a variant its own asset, with the reason, when it cannot be a tint of the master', async () => {
    const fixture = await buildFixture(makeDir);
    await tintAll(fixture);
    await fixture.edit((doc) => {
      const node = doc.nodes.btn_c;
      if (node) node.rect = [240, 450, 60, 40];
    });

    const report = await fixture.run();

    expect(fixture.load().nodes.btn_c?.asset).toBe('btn_c');
    expect(fixture.load().nodes.btn_c?.tint).toBeUndefined();
    expect(
      report.approximations.some(
        (entry) => entry.node === 'btn_c' && entry.message.startsWith('variant.mode：'),
      ),
    ).toBe(true);
  });

  it('uses the normal picture for a state marked placeholder and records it', async () => {
    const fixture = await buildFixture(makeDir);
    await fixture.apply([exception('#btn_ok', 'state.source', 'placeholder')]);

    const report = await fixture.run();

    const { nodes } = fixture.load();
    expect(nodes.btn_ok?.states?.pressed?.asset).toBe('btn_ok');
    expect(manifestOf(fixture).assets.map((asset) => asset.name)).not.toContain('btn_ok_pressed');
    const normal = recordOf(fixture, 'btn_ok');
    expect(normal.uses.map((use) => use.state)).toHaveLength(3);
    expect(
      normal.uses
        .filter((use) => use.state !== undefined)
        .map((use) => use.state)
        .sort(),
    ).toEqual(['disabled', 'pressed']);
    expect(normal.approximations.every((note) => note.startsWith('state.source：'))).toBe(true);
    expect(report.approximations.filter((entry) => entry.node === 'btn_ok')).toHaveLength(2);
  });

  it('derives a generated state and notes that generation comes in M2', async () => {
    const fixture = await buildFixture(makeDir);
    await fixture.apply([exception('#btn_ok', 'state.source', 'generate')]);

    const report = await fixture.run();

    expect(fixture.load().nodes.btn_ok?.states?.pressed?.asset).toBe('btn_ok_pressed');
    const messages = report.approximations
      .filter((entry) => entry.node === 'btn_ok')
      .map((entry) => entry.message);
    expect(messages).toHaveLength(2);
    expect(messages.every((message) => message.includes('M2'))).toBe(true);
  });

  it('falls back to the normal picture for a state it has no recipe for', async () => {
    const fixture = await buildFixture(makeDir);
    await fixture.apply([{ op: 'state.set', target: '#btn_ok', state: 'selected', set: {} }]);

    const report = await fixture.run();

    expect(fixture.load().nodes.btn_ok?.states?.selected?.asset).toBe('btn_ok');
    expect(
      report.approximations.some(
        (entry) => entry.node === 'btn_ok' && entry.message.includes('没有推导方法'),
      ),
    ).toBe(true);
  });
});

describe('build: after the decisions change', () => {
  it('clears what an earlier build bound to a node that no longer draws an asset', async () => {
    const fixture = await buildFixture(makeDir);
    await fixture.run();
    expect(fixture.load().nodes.star?.asset).toBe('img_star');
    await fixture.apply([exception('#star', 'attach.split', 'baked')]);

    await fixture.run();

    expect(fixture.load().nodes.star?.asset).toBeUndefined();
    expect(manifestOf(fixture).assets.map((asset) => asset.name)).not.toContain('img_star');
    expect(recordOf(fixture, 'img_panel').holes.map((hole) => hole.node)).toEqual(['title']);
  });

  it('drops the picture of a state the node no longer declares', async () => {
    const fixture = await buildFixture(makeDir);
    await fixture.run();
    await fixture.apply([{ op: 'state.set', target: '#btn_ok', state: 'disabled', set: null }]);

    await fixture.run();

    expect(Object.keys(fixture.load().nodes.btn_ok?.states ?? {})).toEqual(['pressed']);
    expect(manifestOf(fixture).assets.map((asset) => asset.name)).not.toContain('btn_ok_disabled');
  });
});

describe('build: and the no-drift check', () => {
  const driftOf = (fixture: BuildFixture) => {
    const item = checkRules(readRuleInputs(fixture.project)).items.find(
      (entry) => entry.id === 'no-drift',
    );
    if (item === undefined) throw new Error('没有 无漂移 项');
    return item;
  };

  it('is skipped before the first build and passes after it, warning only about approximations', async () => {
    const fixture = await buildFixture(makeDir);
    expect(driftOf(fixture).status).toBe('skipped');

    const report = await fixture.run();

    const item = driftOf(fixture);
    expect(item).toMatchObject({ status: 'pass', problems: [] });
    expect(item.warnings).toHaveLength(1);
    expect(item.warnings[0]).toContain('近似项');
    expect(item.warnings[0]).toContain('occlusion.fill');
    expect(report.approximations.map((entry) => entry.message)).toEqual([
      expect.stringContaining('occlusion.fill'),
    ]);
  });

  it('passes when tint instances share one asset, and when one of them cannot', async () => {
    const fixture = await buildFixture(makeDir);
    await fixture.apply(
      ['btn_a', 'btn_b', 'btn_c'].map((node) => exception(`#${node}`, 'variant.mode', 'tint')),
    );
    await fixture.run();
    expect(driftOf(fixture)).toMatchObject({ status: 'pass', problems: [] });

    await fixture.edit((doc) => {
      const node = doc.nodes.btn_c;
      if (node) node.rect = [240, 450, 60, 40];
    });
    await fixture.run();

    const item = driftOf(fixture);
    expect(item).toMatchObject({ status: 'pass', problems: [] });
    expect(item.warnings.some((warning) => warning.includes('variant.mode'))).toBe(true);
  });

  it('passes when no instance of a tint cluster can share, because each says why', async () => {
    const fixture = await buildFixture(makeDir);
    await fixture.apply(
      ['btn_a', 'btn_b', 'btn_c'].map((node) => exception(`#${node}`, 'variant.mode', 'tint')),
    );
    await fixture.edit((doc) => {
      const rects: Record<string, [number, number, number, number]> = {
        btn_a: [30, 450, 90, 40],
        btn_b: [135, 450, 60, 40],
        btn_c: [240, 450, 40, 40],
      };
      for (const [id, rect] of Object.entries(rects)) {
        const node = doc.nodes[id];
        if (node) node.rect = rect;
      }
    });

    await fixture.run();

    const item = driftOf(fixture);
    expect(item).toMatchObject({ status: 'pass', problems: [] });
    expect(item.warnings.filter((warning) => warning.includes('variant.mode'))).toHaveLength(3);
  });

  it('fails when a decision changes after the build, and passes once it is built again', async () => {
    const fixture = await buildFixture(makeDir);
    await fixture.run();
    await fixture.apply([exception('#star', 'attach.split', 'baked')]);

    const stale = driftOf(fixture);

    expect(stale.status).toBe('fail');
    expect(stale.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'unexpected-asset', node: 'star', point: 'attach.split' }),
        // The star's hole in the panel and the background is now one nobody asks for.
        expect.objectContaining({ kind: 'holes', node: 'panel', point: 'occlusion.fill' }),
      ]),
    );

    await fixture.run();
    expect(driftOf(fixture)).toMatchObject({ status: 'pass', problems: [] });
  });
});

describe('build: a source smaller than the design', () => {
  it('raises every asset to the design density through the upscale step', async () => {
    const fixture = await buildFixture(makeDir, { designWidth: 720 });

    await fixture.run();

    expect(fixture.calls.some((call) => call.step === 'upscale')).toBe(true);
    const star = recordOf(fixture, 'img_star');
    expect(star.size).toEqual([96, 96]);
    expect(star.steps.map((step) => step.step)).toContain('upscale');
    expect(recordOf(fixture, 'btn_ok').size).toEqual([160, 72]);
    expect(fixture.load().nodes.panel?.nineSlice).toEqual([12, 12, 12, 12]);
  });
});
