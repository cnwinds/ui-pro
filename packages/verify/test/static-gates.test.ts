import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  addScreen,
  applyOps,
  attachChild,
  createCoreRegistry,
  loadScreen,
  lockCodec,
  newNode,
  screenRelPath,
  serializeScreen,
  sha256Hex,
} from '@ui-pro/core';
import { registerRules } from '@ui-pro/rules';
import { describe, expect, it } from 'vitest';
import { MIN_TOUCH_SIZE_AT_REFERENCE } from '../src/gates/structure';
import { paintedPng, runGate, scene, solidPng, useTempDirs } from './helpers';

const makeDir = useTempDirs();

describe('规则一致', () => {
  it('决定都过期（还没按规则算）时失败，fix 指向 rule.recompute', async () => {
    const { project, screen } = await scene(makeDir);
    const result = await runGate(project, screen, 'rules');

    expect(result.status).toBe('fail');
    const first = result.problems[0];
    expect(first?.message).toContain('完备：');
    expect(first?.node).toBeDefined();
    expect(first?.fix).toContain('rule.recompute');
    expect(result.metrics.failed).toBeGreaterThanOrEqual(1);
  });

  it('按现行规则重算之后通过；没有实现的检查是警告', async () => {
    const { project, screen } = await scene(makeDir);
    const registry = createCoreRegistry();
    registerRules(registry);
    await applyOps(project, [{ op: 'rule.recompute' }], { screen, registry });

    const result = await runGate(project, screen, 'rules');

    expect(result.problems).toEqual([]);
    expect(result.status).toBe('pass');
    expect(result.metrics.checks).toBeGreaterThanOrEqual(5);
  });

  it('别的界面的规则问题不算这个界面的', async () => {
    const { project, screen, root } = await scene(makeDir);
    const registry = createCoreRegistry();
    registerRules(registry);
    await applyOps(project, [{ op: 'rule.recompute' }], { screen, registry });
    // A second screen whose node has no decisions.
    await writeFile(join(root, 'other.png'), await solidPng(200, 120, [9, 9, 9, 255]));
    await addScreen(project, { name: 'other', source: join(root, 'other.png') });
    const other = loadScreen(project, 'other');
    other.nodes.stray = newNode({
      id: 'stray',
      type: 'button',
      rect: [0, 0, 20, 20],
      parent: other.root,
    });
    attachChild(other, other.root, 'stray');
    await writeFile(
      join(project.root, ...screenRelPath('other', 'doc').split('/')),
      serializeScreen(other),
    );

    const result = await runGate(project, screen, 'rules');
    expect(result.problems).toEqual([]);
    expect(result.status).toBe('pass');
  });
});

describe('结构', () => {
  it('干净的界面通过', async () => {
    const { project, screen } = await scene(makeDir);
    const result = await runGate(project, screen, 'structure');
    expect(result.problems).toEqual([]);
    expect(result.status).toBe('pass');
  });

  it('引用不完整：资产不在清单里、状态资产、组件、绑定路径', async () => {
    const { project, screen } = await scene(makeDir, {
      nodes: [
        { id: 'a', type: 'image', rect: [150, 10, 20, 20], asset: 'nope' },
        {
          id: 'b',
          type: 'button',
          rect: [150, 40, 20, 20],
          asset: 'btn',
          states: { pressed: { asset: 'nope_pressed' } },
        },
        {
          id: 'c',
          type: 'text',
          rect: [150, 70, 40, 16],
          text: { content: '0' },
          bind: { text: { path: 'player.gold' } },
        },
        { id: 'd', type: 'instance', rect: [150, 90, 20, 20], instanceOf: 'Missing' },
      ],
      mock: { player: { name: 'x' } },
    });
    const result = await runGate(project, screen, 'structure');
    const text = result.problems
      .map((problem) => `${problem.node ?? '-'}：${problem.message}`)
      .join('\n');

    expect(result.status).toBe('fail');
    expect(text).toContain('a：节点 #a 的资产 nope 不在资产清单里');
    expect(text).toContain('b：节点 #b 状态 pressed 的资产 nope_pressed 不在资产清单里');
    expect(text).toContain('c：节点 #c 的绑定 text 指向 player.gold，mock.json 里没有这个值');
    expect(text).toContain('d：节点 #d 引用了不存在的组件 Missing');
  });

  it('绑定的路径在 mock 里有值时通过', async () => {
    const { project, screen } = await scene(makeDir, {
      nodes: [
        {
          id: 'c',
          type: 'text',
          rect: [150, 70, 40, 16],
          text: { content: '0' },
          bind: { text: { path: 'player.gold' } },
        },
      ],
      mock: { player: { gold: 12 } },
    });
    const result = await runGate(project, screen, 'structure');
    expect(result.problems).toEqual([]);
  });

  it('子节点大部分在父节点之外时失败；父节点是滚动区时不管', async () => {
    const { project, screen } = await scene(makeDir, {
      nodes: [
        { id: 'panel', type: 'container', rect: [120, 10, 60, 60] },
        { id: 'stray', type: 'image', rect: [10, 90, 20, 20], parent: 'panel', asset: 'btn' },
        { id: 'view', type: 'scroll', rect: [120, 80, 60, 30] },
        { id: 'row', type: 'image', rect: [10, 90, 20, 20], parent: 'view', asset: 'btn' },
      ],
    });
    const result = await runGate(project, screen, 'structure');
    const stray = result.problems.filter((problem) => problem.node === 'stray');

    expect(stray).toHaveLength(1);
    expect(stray[0]?.message).toContain('在父节点 #panel 之外');
    expect(result.problems.some((problem) => problem.node === 'row')).toBe(false);
  });

  it('可交互节点热区只有可见区域那么小：失败；padded 通过', async () => {
    // Below the minimum at a design 200 px wide, which is 16.3 px.
    const small = Math.floor(MIN_TOUCH_SIZE_AT_REFERENCE * (200 / 1080)) - 4;
    const tiny = await scene(makeDir, { buttonRect: [20, 20, small, small] });
    const padded = await scene(makeDir, {
      buttonRect: [20, 20, small, small],
      buttonDecisions: { 'hit.area': { value: 'padded', by: 'exception' } },
    });

    const failed = await runGate(tiny.project, tiny.screen, 'structure');
    const passed = await runGate(padded.project, padded.screen, 'structure');

    expect(failed.status).toBe('fail');
    expect(failed.problems[0]?.node).toBe('btn');
    expect(failed.problems[0]?.message).toContain('最小触控尺寸');
    expect(passed.problems).toEqual([]);
  });

  it('画资产的节点还没有资产时失败', async () => {
    const { project, screen } = await scene(makeDir, {
      nodes: [{ id: 'empty', type: 'image', rect: [150, 10, 20, 20] }],
    });
    const result = await runGate(project, screen, 'structure');
    expect(result.problems.some((problem) => problem.message.includes('还没有资产：#empty'))).toBe(
      true,
    );
  });
});

describe('资源', () => {
  it('文件齐全、哈希一致时通过，并说明没有资源槽', async () => {
    const { project, screen } = await scene(makeDir);
    const result = await runGate(project, screen, 'resources');

    expect(result.status).toBe('pass');
    expect(result.reason).toBe('没有资源槽需要检查（M1 还没有资源槽）');
    expect(result.metrics.assets).toBe(2);
  });

  it('资产文件被改过、被删掉、尺寸不符都能查出', async () => {
    const { project, screen } = await scene(makeDir);
    const dir = join(project.root, 'screens', screen, 'assets');
    await writeFile(join(dir, 'bg.png'), await paintedPng(200, 120, () => [1, 2, 3, 255]));
    await writeFile(join(dir, 'btn.png'), await paintedPng(10, 10, () => [1, 2, 3, 255]));

    const result = await runGate(project, screen, 'resources');
    const text = result.problems.map((problem) => problem.message).join('\n');

    expect(result.status).toBe('fail');
    expect(text).toContain('资产 bg 的文件 bg.png 与清单记的哈希不一致');
    expect(text).toContain('资产 btn 的文件是 10×10，清单记的是 80×40');

    await rm(join(dir, 'bg.png'));
    const missing = await runGate(project, screen, 'resources');
    expect(missing.problems.map((problem) => problem.message).join('\n')).toContain(
      '资产 bg 的文件 bg.png 不存在',
    );
  });

  it('字体文件不存在时失败', async () => {
    const { project, screen } = await scene(makeDir, { fonts: { sans: 'fonts/missing.ttf' } });
    const result = await runGate(project, screen, 'resources');
    expect(result.status).toBe('fail');
    expect(result.problems[0]?.message).toContain('字体 sans 的文件 fonts/missing.ttf 不存在');
  });

  it('锁文件里的模型输出缺失或被改过时失败，存在且哈希一致时通过', async () => {
    const { project, screen } = await scene(makeDir);
    const file = `screens/${screen}/assets/gen/out.png`;
    const bytes = await solidPng(4, 4, [1, 2, 3, 255]);
    const lock = (sha256: string) =>
      lockCodec.serialize({
        format: 'ui-pro/lock',
        version: 1,
        tool: '0.0.0',
        models: {},
        generated: {
          [sha256Hex('request')]: {
            file,
            sha256,
            by: 'local:lama',
            at: '2026-01-01T00:00:00Z',
            alternatives: [],
          },
        },
      });
    const lockPath = join(project.root, 'ui-pro.lock');
    const outPath = join(project.root, ...file.split('/'));

    await writeFile(lockPath, lock(sha256Hex(bytes)));
    const missing = await runGate(project, screen, 'resources');
    expect(missing.problems[0]?.message).toContain(`模型输出 ${file}`);
    expect(missing.problems[0]?.message).toContain('不存在');

    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, bytes);
    expect((await runGate(project, screen, 'resources')).status).toBe('pass');

    await writeFile(outPath, await solidPng(4, 4, [9, 9, 9, 255]));
    const changed = await runGate(project, screen, 'resources');
    expect(changed.problems[0]?.message).toContain('与锁定的哈希不一致');
  });
});
