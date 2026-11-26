import { defaultRegistry, listHistory, loadScreen, readAssetManifest } from '@ui-pro/core';
import { analyzePsdScreen } from '@ui-pro/psd';
import { registerRules } from '@ui-pro/rules';
import { describe, expect, it } from 'vitest';
import { compliantPsd, group, pixel, psdBytes } from '../../psd/test/fixtures';
import { psdProject, useEmbeddedRenderer, useTempDirs } from '../../psd/test/harness';
import { type BuildDeps, buildScreen, registerBuild } from '../src';
import { type Call, FIXED_NOW, fakeOps } from './support';

registerRules(defaultRegistry);
registerBuild(defaultRegistry);

const makeDir = useTempDirs();

function depsFor(calls: Call[]): BuildDeps {
  return {
    createPixelOps: (context) => fakeOps(context, calls),
    createModelStore: () => ({
      path: async () => {
        throw new Error('测试里不应加载模型');
      },
      has: async () => false,
    }),
    createCloudImageModel: () => null,
    env: {},
    now: () => FIXED_NOW,
    registry: defaultRegistry,
  };
}

async function analyzed(bytes: Uint8Array, options: { allowDegraded?: boolean } = {}) {
  useEmbeddedRenderer();
  const fixture = await psdProject(makeDir, bytes);
  await analyzePsdScreen(fixture.project, fixture.screen, options);
  const calls: Call[] = [];
  return {
    ...fixture,
    calls,
    build: (buildOptions = {}) =>
      buildScreen(fixture.project, fixture.screen, buildOptions, depsFor(calls)),
  };
}

describe('buildScreen on a PSD', () => {
  it('renders the layers instead of extracting and filling: no pixel step runs', async () => {
    const { project, calls, build } = await analyzed(compliantPsd());

    const report = await build();

    expect(calls).toEqual([]);
    expect(report.assets).toBe(4);
    expect(report.generated).toEqual({ local: 0, cloud: 0 });
    const manifest = readAssetManifest(project, 'main');
    expect(manifest?.assets.map((asset) => asset.name).sort()).toEqual([
      'btn_upgrade',
      'btn_upgrade_pressed',
      'img_badge_dot',
      'img_bg_main',
    ]);
    for (const asset of manifest?.assets ?? []) {
      expect(asset.origin).toBe('layer');
      expect(asset.holes).toEqual([]);
      expect(asset.steps.map((step) => step.step)).toEqual(['tidy']);
      expect(asset.steps[0]?.method).toBe('layer-render');
    }
  });

  it('cuts every asset to the node rectangle, since the layer drew what is beneath', async () => {
    const { project, build } = await analyzed(compliantPsd());

    await build();

    const manifest = readAssetManifest(project, 'main');
    const sizes = Object.fromEntries(
      manifest?.assets.map((asset) => [asset.name, asset.size]) ?? [],
    );
    expect(sizes).toEqual({
      img_bg_main: [200, 320],
      btn_upgrade: [120, 40],
      btn_upgrade_pressed: [120, 40],
      img_badge_dot: [12, 12],
    });
  });

  it('turns a hidden @state layer into the picture of that state', async () => {
    const { project, build } = await analyzed(compliantPsd());

    await build();

    const doc = loadScreen(project, 'main');
    expect(doc.nodes.btn_upgrade?.asset).toBe('btn_upgrade');
    expect(doc.nodes.btn_upgrade?.states?.pressed).toMatchObject({
      asset: 'btn_upgrade_pressed',
      source: 'drawn',
    });
    const pressed = readAssetManifest(project, 'main')?.assets.find(
      (asset) => asset.name === 'btn_upgrade_pressed',
    );
    expect(pressed?.uses).toEqual([{ node: 'btn_upgrade', state: 'pressed' }]);
    expect(pressed?.steps[0]?.detail).toContain('@pressed');
  });

  it('keeps the same decision notes as a flat source for a background without a host', async () => {
    const { build } = await analyzed(compliantPsd());

    const report = await build();

    expect(report.approximations).toEqual([
      { node: 'bg_main', message: expect.stringContaining('decor.merge') },
    ]);
  });

  it('does not upscale at scale 1 and builds nothing new the second time', async () => {
    const { project, calls, build } = await analyzed(compliantPsd());
    await build();
    const versions = listHistory(project).length;

    const again = await build();

    expect(calls.filter((call) => call.step === 'upscale')).toEqual([]);
    expect(again.version).toBeUndefined();
    expect(listHistory(project)).toHaveLength(versions);
  });

  it('upscales the layer renders only when the canvas is smaller than the design', async () => {
    const layers = [
      pixel('bg_main', [0, 0, 100, 160], [20, 24, 40, 255]),
      group('btn_upgrade', [
        pixel('base', [10, 120, 60, 20], [40, 120, 220, 255]),
        pixel('@pressed', [10, 120, 60, 20], [20, 70, 150, 255], { hidden: true }),
      ]),
    ];
    const { project, calls, build } = await analyzed(
      psdBytes(layers, { width: 100, height: 160 }),
      { allowDegraded: true },
    );
    expect(loadScreen(project, 'main').scale).toBe(2);

    await build();

    const manifest = readAssetManifest(project, 'main');
    expect(calls.filter((call) => call.step !== 'upscale')).toEqual([]);
    expect(calls.map((call) => call.node).sort()).toEqual([
      'bg_main',
      'btn_upgrade',
      'btn_upgrade',
    ]);
    const sizes = Object.fromEntries(
      manifest?.assets.map((asset) => [asset.name, asset.size]) ?? [],
    );
    expect(sizes).toMatchObject({ img_bg_main: [200, 320], btn_upgrade: [120, 40] });
    for (const asset of manifest?.assets ?? []) {
      expect(asset.steps.map((step) => step.step)).toEqual(['upscale', 'tidy']);
      expect(asset.holes).toEqual([]);
    }
  });
});
