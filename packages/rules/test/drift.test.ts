import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AssetManifest,
  type AssetRecord,
  expectedHoles,
  pixelOwnership,
  type ScreenDoc,
  screenRelPath,
  serializeScreen,
} from '@ui-pro/core';
import { describe, expect, it } from 'vitest';
import { type CheckItem, type CheckProblem, checkRules, readRuleInputs } from '../src';
import { emptyFixture, type Fixture, node, useTempDirs } from './helpers';

const makeDir = useTempDirs();

type Decision = [node: string, point: string, value: string];

const writeDoc = (fx: Fixture, doc: ScreenDoc): Promise<void> =>
  writeFile(
    join(fx.project.root, ...screenRelPath('main', 'doc').split('/')),
    serializeScreen(doc),
  );

/**
 * `main` with a panel that carries a title (text) and a star (independent, filled), a row of two
 * buttons (one similarity cluster), and a container; `decisions` are node exceptions on top.
 */
async function driftFixture(decisions: Decision[] = []): Promise<Fixture> {
  const fx = await emptyFixture(makeDir);
  await fx.apply(
    [
      node('panel', 'image', [100, 300, 880, 800], 'root'),
      node('title', 'text', [200, 340, 300, 60], 'panel', { text: { content: '标题' } }),
      node('star', 'image', [150, 420, 100, 100], 'panel'),
      node('btn_a', 'button', [100, 1300, 300, 120], 'root'),
      node('btn_b', 'button', [500, 1300, 300, 120], 'root'),
      node('group', 'container', [0, 0, 1080, 200], 'root'),
    ],
    { message: '种下节点' },
  );
  // The ops cannot say which nodes look alike: that is evidence, so the test writes it.
  const doc = fx.load();
  for (const id of ['btn_a', 'btn_b']) {
    const target = doc.nodes[id];
    if (target) target.cluster = 'row';
  }
  await writeDoc(fx, doc);
  const exceptions: Decision[] = [
    ['panel', 'content.split', 'separate'],
    ['star', 'decor.merge', 'separate'],
    ['star', 'attach.split', 'independent'],
    ['star', 'occlusion.fill', 'fill'],
    ...decisions,
  ];
  await fx.apply(
    exceptions.map(([target, point, value]) => ({
      op: 'exception.add',
      target: `#${target}`,
      point,
      value,
      because: '测试需要这个取值',
    })),
    { message: '种下例外' },
  );
  return fx;
}

const ZEROS = '0'.repeat(64);

/** The manifest a correct build of the screen as it is now would write. */
function manifestFor(fx: Fixture): AssetManifest {
  const doc = fx.load();
  const ownership = pixelOwnership(doc);
  const holes = expectedHoles(doc, ownership);
  const assets: AssetRecord[] = [];
  for (const [id, owned] of ownership) {
    const target = doc.nodes[id];
    if (owned.kind !== 'asset' || target === undefined) continue;
    assets.push({
      name: `a_${id}`,
      file: `a_${id}.png`,
      origin: 'crop',
      uses: [{ node: id }],
      size: [target.rect[2], target.rect[3]],
      inset: [0, 0, 0, 0],
      holes: (holes.get(id) ?? []).map((hole) => ({
        node: hole.node,
        handling: hole.handling,
        region: hole.rect,
      })),
      steps: [{ step: 'extract', method: 'test' }],
      sha256: ZEROS,
      approximations: [],
    });
  }
  return {
    format: 'ui-pro/assets',
    version: 1,
    screen: 'main',
    sourceSha256: doc.source.sha256,
    inputsSha256: ZEROS,
    assets,
  };
}

const recordOf = (manifest: AssetManifest, name: string): AssetRecord => {
  const found = manifest.assets.find((asset) => asset.name === name);
  if (found === undefined) throw new Error(`manifest has no asset ${name}`);
  return found;
};

/** Writes the manifest, then binds every node to the asset that lists it; `bind` can break that. */
async function install(
  fx: Fixture,
  manifest: AssetManifest,
  bind: (doc: ScreenDoc) => void = () => {},
): Promise<void> {
  await fx.apply([{ op: 'rule.recompute' }], {
    message: '写入资产清单',
    assets: {
      main: {
        manifest,
        files: manifest.assets.map((asset) => ({ path: asset.file, content: new Uint8Array([1]) })),
      },
    },
  });
  const doc = fx.load();
  for (const record of manifest.assets) {
    for (const use of record.uses) {
      const target = doc.nodes[use.node];
      if (target === undefined) continue;
      if (use.state === undefined) target.asset = record.name;
    }
  }
  bind(doc);
  await writeDoc(fx, doc);
}

const drift = (fx: Fixture): CheckItem => {
  const found = checkRules(readRuleInputs(fx.project)).items.find(
    (entry) => entry.id === 'no-drift',
  );
  if (found === undefined) throw new Error('no 无漂移 item');
  return found;
};

const kinds = (item: CheckItem): string[] => item.problems.map((problem) => problem.kind).sort();

const only = (item: CheckItem): CheckProblem => {
  expect(item.problems).toHaveLength(1);
  return item.problems[0] as CheckProblem;
};

describe('no-drift check', () => {
  it('is skipped, and says why, while no screen has been built', async () => {
    const fx = await driftFixture();

    const item = drift(fx);

    expect(item).toMatchObject({ id: 'no-drift', name: '无漂移', status: 'skipped', problems: [] });
    expect(item.reason).toContain('资产构建');
    expect(item.reason).toContain('ui-pro build');
  });

  it('passes on the manifest a correct build writes', async () => {
    const fx = await driftFixture();
    await install(fx, manifestFor(fx));

    const item = drift(fx);

    expect(item).toMatchObject({ status: 'pass', problems: [], warnings: [] });
  });

  it('does not make the whole report fail while it passes', async () => {
    const fx = await driftFixture();
    await install(fx, manifestFor(fx));

    expect(checkRules(readRuleInputs(fx.project)).ok).toBe(true);
  });

  it('says which screens it could not compare, when only some are built', async () => {
    const fx = await driftFixture();
    await install(fx, manifestFor(fx));

    const inputs = readRuleInputs(fx.project);
    const screens = new Map(inputs.screens);
    const main = screens.get('main');
    if (main === undefined) throw new Error('no main screen');
    screens.set('other', { ...main, assets: null });
    const item = checkRules({ ...inputs, screens }).items.find((entry) => entry.id === 'no-drift');

    expect(item?.status).toBe('pass');
    expect(item?.warnings).toEqual([expect.stringContaining('other')]);
  });

  describe('assets that are missing or that should not be there', () => {
    it('fails for a node that draws an asset but has none bound', async () => {
      const fx = await driftFixture();
      await install(fx, manifestFor(fx), (doc) => {
        const panel = doc.nodes.panel;
        if (panel) panel.asset = undefined;
      });

      const item = drift(fx);

      expect(item.status).toBe('fail');
      expect(only(item)).toMatchObject({ kind: 'missing-asset', screen: 'main', node: 'panel' });
      expect(only(item).message).toContain('main/#panel');
      expect(only(item).message).toContain('没有绑定资产');
    });

    it('fails for a node bound to an asset the manifest does not have', async () => {
      const fx = await driftFixture();
      await install(fx, manifestFor(fx), (doc) => {
        const star = doc.nodes.star;
        if (star) star.asset = 'img_gone';
      });

      const problem = only(drift(fx));

      expect(problem).toMatchObject({ kind: 'missing-asset', node: 'star' });
      expect(problem.message).toContain('img_gone');
      expect(problem.message).toContain('不在资产清单里');
    });

    it('fails for a baked node that still has an asset, and names the decision', async () => {
      const fx = await driftFixture();
      const manifest = manifestFor(fx);
      await install(fx, manifest);
      await fx.apply(
        [
          {
            op: 'exception.add',
            target: '#star',
            point: 'attach.split',
            value: 'baked',
            because: '改成烘进底板',
          },
        ],
        { message: '星星改成烘进底板' },
      );

      const item = drift(fx);

      expect(item.status).toBe('fail');
      const problem = item.problems.find((entry) => entry.kind === 'unexpected-asset');
      expect(problem).toMatchObject({ node: 'star', point: 'attach.split' });
      expect(problem?.message).toContain('#panel');
    });

    it('fails for dynamic text that has an asset', async () => {
      const fx = await driftFixture();
      const manifest = manifestFor(fx);
      manifest.assets.push({
        ...recordOf(manifest, 'a_panel'),
        name: 'a_title',
        file: 'a_title.png',
        uses: [{ node: 'title' }],
        holes: [],
      });
      await install(fx, manifest);

      const problem = only(drift(fx));

      expect(problem).toMatchObject({
        kind: 'unexpected-asset',
        node: 'title',
        point: 'text.mode',
      });
      expect(problem.message).toContain('动态文字');
    });

    it('fails for a container that has an asset', async () => {
      const fx = await driftFixture();
      const manifest = manifestFor(fx);
      manifest.assets.push({
        ...recordOf(manifest, 'a_panel'),
        name: 'a_group',
        file: 'a_group.png',
        uses: [{ node: 'group' }],
        holes: [],
      });
      await install(fx, manifest);

      const problem = only(drift(fx));

      expect(problem).toMatchObject({ kind: 'unexpected-asset', node: 'group' });
      expect(problem.message).toContain('没有像素');
    });
  });

  describe('holes', () => {
    it('fails when a hole the decisions call for was not made', async () => {
      const fx = await driftFixture();
      const manifest = manifestFor(fx);
      const panel = recordOf(manifest, 'a_panel');
      expect(panel.holes.map((hole) => `${hole.node}:${hole.handling}`).sort()).toEqual([
        'star:filled',
        'title:stripped',
      ]);
      panel.holes = panel.holes.filter((hole) => hole.node !== 'title');
      await install(fx, manifest);

      const problem = only(drift(fx));

      expect(problem).toMatchObject({ kind: 'holes', node: 'panel', point: 'occlusion.fill' });
      expect(problem.message).toContain('缺少 title：stripped');
    });

    it('fails when a hole is handled differently from what occlusion.fill says', async () => {
      const fx = await driftFixture();
      const manifest = manifestFor(fx);
      const panel = recordOf(manifest, 'a_panel');
      panel.holes = panel.holes.map((hole) =>
        hole.node === 'star' ? { ...hole, handling: 'kept' as const } : hole,
      );
      await install(fx, manifest);

      const problem = only(drift(fx));

      expect(problem.message).toContain('缺少 star：filled');
      expect(problem.message).toContain('多出 star：kept');
    });

    it('fails when an asset has a hole nothing above it calls for', async () => {
      const fx = await driftFixture();
      const manifest = manifestFor(fx);
      recordOf(manifest, 'a_btn_a').holes = [
        { node: 'star', handling: 'filled', region: [100, 1300, 10, 10] },
      ];
      await install(fx, manifest);

      const problem = only(drift(fx));

      expect(problem).toMatchObject({ kind: 'holes', node: 'btn_a' });
      expect(problem.message).toContain('多出 star：filled');
    });

    it('compares the union of the holes of every node that shares one asset', async () => {
      const fx = await driftFixture([
        ['btn_a', 'variant.mode', 'tint'],
        ['btn_b', 'variant.mode', 'tint'],
      ]);
      const manifest = manifestFor(fx);
      const shared = recordOf(manifest, 'a_btn_a');
      shared.uses = [
        { node: 'btn_a', tint: '#ffffff' },
        { node: 'btn_b', tint: '#808080' },
      ];
      manifest.assets = manifest.assets.filter((asset) => asset.name !== 'a_btn_b');
      await install(fx, manifest);

      expect(drift(fx)).toMatchObject({ status: 'pass', problems: [] });
    });

    it('fails when a PSD asset made from layers records any hole', async () => {
      const fx = await driftFixture();
      const manifest = manifestFor(fx);
      const panel = recordOf(manifest, 'a_panel');
      panel.origin = 'layer';
      await install(fx, manifest);

      const problem = only(drift(fx));

      expect(problem).toMatchObject({ kind: 'holes', node: 'panel' });
      expect(problem.message).toContain('由图层渲染而成');
      expect(problem.message).toContain('2 个');
    });

    it('passes for a PSD asset with no holes, even where a flat asset would have some', async () => {
      const fx = await driftFixture();
      const manifest = manifestFor(fx);
      const panel = recordOf(manifest, 'a_panel');
      panel.origin = 'layer';
      panel.holes = [];
      await install(fx, manifest);

      expect(drift(fx).status).toBe('pass');
    });
  });

  describe('variants', () => {
    const tintBoth: Decision[] = [
      ['btn_a', 'variant.mode', 'tint'],
      ['btn_b', 'variant.mode', 'tint'],
    ];

    it('fails for a tint instance that has an asset of its own', async () => {
      const fx = await driftFixture(tintBoth);
      await install(fx, manifestFor(fx));

      const item = drift(fx);

      expect(kinds(item)).toEqual(['tint', 'tint']);
      const problem = item.problems.find((entry) => entry.node === 'btn_b');
      expect(problem).toMatchObject({ point: 'variant.mode' });
      expect(problem?.message).toContain('只有它自己在用');
    });

    it('fails for a tint instance that shares the asset without a tint', async () => {
      const fx = await driftFixture(tintBoth);
      const manifest = manifestFor(fx);
      recordOf(manifest, 'a_btn_a').uses = [{ node: 'btn_a', tint: '#ffffff' }, { node: 'btn_b' }];
      manifest.assets = manifest.assets.filter((asset) => asset.name !== 'a_btn_b');
      await install(fx, manifest);

      const problem = only(drift(fx));

      expect(problem).toMatchObject({ kind: 'tint', node: 'btn_b' });
      expect(problem.message).toContain('没有给它乘色');
    });

    it('passes for tint instances that share one asset, each with a multiply colour', async () => {
      const fx = await driftFixture(tintBoth);
      const manifest = manifestFor(fx);
      recordOf(manifest, 'a_btn_a').uses = [
        { node: 'btn_a', tint: '#ffffff' },
        { node: 'btn_b', tint: '#808080' },
      ];
      manifest.assets = manifest.assets.filter((asset) => asset.name !== 'a_btn_b');
      await install(fx, manifest);

      expect(drift(fx)).toMatchObject({ status: 'pass', problems: [] });
    });

    it('fails for a variant-assets instance that carries a tint', async () => {
      const fx = await driftFixture([
        ['btn_a', 'variant.mode', 'variant-assets'],
        ['btn_b', 'variant.mode', 'variant-assets'],
      ]);
      const manifest = manifestFor(fx);
      recordOf(manifest, 'a_btn_b').uses = [{ node: 'btn_b', tint: '#808080' }];
      await install(fx, manifest);

      const problem = only(drift(fx));

      expect(problem).toMatchObject({ kind: 'tint', node: 'btn_b', point: 'variant.mode' });
      expect(problem.message).toContain('variant-assets');
    });

    it('leaves a tint node alone when nothing else is in its cluster', async () => {
      const fx = await driftFixture([['btn_a', 'variant.mode', 'tint']]);
      await fx.apply([{ op: 'node.remove', target: '#btn_b' }], { message: '删掉另一个按钮' });
      await install(fx, manifestFor(fx));

      expect(drift(fx)).toMatchObject({ status: 'pass', problems: [] });
    });
  });

  describe('stretch', () => {
    const nineSlice: Decision[] = [['panel', 'stretch.mode', 'nine-slice']];

    it('fails for a nine-slice node whose asset has no margins', async () => {
      const fx = await driftFixture(nineSlice);
      await install(fx, manifestFor(fx));

      const problem = only(drift(fx));

      expect(problem).toMatchObject({ kind: 'nine-slice', node: 'panel', point: 'stretch.mode' });
      expect(problem.message).toContain('nine-slice');
      expect(problem.message).toContain('a_panel');
    });

    it('fails the same way for three-slice', async () => {
      const fx = await driftFixture([['panel', 'stretch.mode', 'three-slice']]);
      await install(fx, manifestFor(fx));

      expect(only(drift(fx)).message).toContain('three-slice');
    });

    it('passes once the record has its margins', async () => {
      const fx = await driftFixture(nineSlice);
      const manifest = manifestFor(fx);
      recordOf(manifest, 'a_panel').nineSlice = [20, 20, 20, 20];
      await install(fx, manifest);

      expect(drift(fx).status).toBe('pass');
    });
  });

  describe('approximations', () => {
    it('turns a problem into a warning when the asset recorded an approximation of that point', async () => {
      const fx = await driftFixture([['panel', 'stretch.mode', 'nine-slice']]);
      const manifest = manifestFor(fx);
      recordOf(manifest, 'a_panel').approximations = [
        'stretch.mode：各边都有渐变，找不到可拉伸的中段',
      ];
      await install(fx, manifest);

      const item = drift(fx);

      expect(item.status).toBe('pass');
      expect(item.problems).toEqual([]);
      expect(item.warnings).toHaveLength(1);
      expect(item.warnings[0]).toContain('近似项');
      expect(item.warnings[0]).toContain('找不到可拉伸的中段');
    });

    it('does that for holes too, as the progress bar fill override does', async () => {
      const fx = await driftFixture([['star', 'occlusion.fill', 'none']]);
      const manifest = manifestFor(fx);
      const panel = recordOf(manifest, 'a_panel');
      panel.holes = panel.holes.map((hole) =>
        hole.node === 'star' ? { ...hole, handling: 'filled' as const } : hole,
      );
      panel.approximations = ['occlusion.fill：星星下面的部分一律补全，引擎才能缩短它'];
      await install(fx, manifest);

      const item = drift(fx);

      expect(item).toMatchObject({ status: 'pass', problems: [] });
      expect(item.warnings[0]).toContain('补全的洞与决定不符');
    });

    it('does not excuse a problem with an approximation of another decision point', async () => {
      const fx = await driftFixture([['panel', 'stretch.mode', 'nine-slice']]);
      const manifest = manifestFor(fx);
      recordOf(manifest, 'a_panel').approximations = ['occlusion.fill：某处补全得不好'];
      await install(fx, manifest);

      const item = drift(fx);

      expect(item.status).toBe('fail');
      expect(item.warnings).toEqual([]);
    });

    it('does not take a point that only shares a prefix for the same point', async () => {
      const fx = await driftFixture([['panel', 'stretch.mode', 'nine-slice']]);
      const manifest = manifestFor(fx);
      recordOf(manifest, 'a_panel').approximations = ['stretch.mode.extra：不是这个决策点'];
      await install(fx, manifest);

      expect(drift(fx).status).toBe('fail');
    });

    it('never excuses a missing asset', async () => {
      const fx = await driftFixture();
      const manifest = manifestFor(fx);
      recordOf(manifest, 'a_panel').approximations = ['content.split：随便写点什么'];
      await install(fx, manifest, (doc) => {
        const panel = doc.nodes.panel;
        if (panel) panel.asset = undefined;
      });

      expect(drift(fx).status).toBe('fail');
    });
  });

  it('reports every problem of a screen, not just the first', async () => {
    const fx = await driftFixture([['panel', 'stretch.mode', 'nine-slice']]);
    const manifest = manifestFor(fx);
    recordOf(manifest, 'a_panel').holes = [];
    await install(fx, manifest, (doc) => {
      const star = doc.nodes.star;
      if (star) star.asset = undefined;
    });

    const item = drift(fx);

    expect(kinds(item)).toEqual(['holes', 'missing-asset', 'nine-slice']);
    expect(checkRules(readRuleInputs(fx.project)).ok).toBe(false);
  });
});
