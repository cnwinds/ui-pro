import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { BATCHES_FAIL, MAX_ASSET_SIDE } from '../src/gates/budget';
import { extremeOf, lengthenedOf } from '../src/gates/text';
import { type NodeInit, paintedPng, runGate, scene, useTempDirs } from './helpers';

const makeDir = useTempDirs();

/** A neighbour right of the text box, to be hit when the text grows. */
const NEIGHBOUR: NodeInit = {
  id: 'neighbour',
  type: 'image',
  rect: [46, 80, 40, 24],
  asset: 'btn',
};

describe('文本变体', () => {
  it('极值：数字位数补到极值，格式不变', () => {
    expect(extremeOf('Lv.5')).toBe('Lv.999');
    expect(extremeOf('12')).toBe('999');
    expect(extremeOf('1,234')).toBe('9,999,999');
    expect(extremeOf('12345')).toBe('9999999');
    expect(extremeOf('99,999,999')).toBe('99,999,999');
    expect(extremeOf('第 3 关')).toBe('第 999 关');
    expect(extremeOf('开始')).toBeUndefined();
  });

  it('加长文案：长度加 40%，混入全角字符', () => {
    expect(lengthenedOf('Start')).toBe('StartＷｉ');
    expect(lengthenedOf('开始游戏吧')).toHaveLength(7);
    expect(lengthenedOf('A')).toHaveLength(2);
  });
});

describe('文本', () => {
  it('框够宽时通过', async () => {
    const { project, screen } = await scene(makeDir, {
      nodes: [
        {
          id: 'gold',
          type: 'text',
          rect: [20, 80, 160, 24],
          text: { content: '12', kind: 'value' },
        },
        {
          id: 'label',
          type: 'text',
          rect: [20, 100, 160, 16],
          text: { content: 'Go', kind: 'label' },
        },
      ],
    });
    const result = await runGate(project, screen, 'text');

    expect(result.problems).toEqual([]);
    expect(result.status).toBe('pass');
    expect(result.metrics.measured).toBe(2);
  });

  it('短框里的数值在极值下溢出，压到邻居：失败，附对比图', async () => {
    const { project, screen } = await scene(makeDir, {
      nodes: [
        {
          id: 'gold',
          type: 'text',
          rect: [20, 80, 26, 24],
          text: { content: '12', kind: 'value' },
        },
        NEIGHBOUR,
      ],
    });
    const result = await runGate(project, screen, 'text');

    expect(result.status).toBe('fail');
    const [problem] = result.problems;
    expect(problem?.node).toBe('gold');
    expect(problem?.message).toContain('极值（999）');
    expect(problem?.message).toContain('压到了 #neighbour');
    expect(problem?.view).toMatch(/text-gold-extreme\.png$/);
    expect((await readFile(problem?.view as string)).length).toBeGreaterThan(100);
  });

  it('绑定到数字的文字也按数值处理', async () => {
    const { project, screen } = await scene(makeDir, {
      nodes: [
        {
          id: 'gold',
          type: 'text',
          rect: [20, 80, 30, 24],
          text: { content: '0' },
          bind: { text: { path: 'player.gold' } },
        },
        NEIGHBOUR,
      ],
      mock: { player: { gold: 1234 } },
    });
    const result = await runGate(project, screen, 'text');

    expect(result.status).toBe('fail');
    expect(result.problems[0]?.message).toContain('极值（9999999）');
  });

  it('只溢出到空白处（背景承载它）：警告，不失败', async () => {
    const { project, screen } = await scene(makeDir, {
      nodes: [
        {
          id: 'gold',
          type: 'text',
          rect: [20, 80, 26, 24],
          text: { content: '12', kind: 'value' },
        },
      ],
    });
    const result = await runGate(project, screen, 'text');

    expect(result.status).toBe('pass');
    expect(
      result.warnings.some((warning) => warning.includes('极值') && warning.includes('#gold')),
    ).toBe(true);
  });

  it('加长文案：标签溢出到邻居上时失败；溢出出画面也失败', async () => {
    const hit = await scene(makeDir, {
      nodes: [
        {
          id: 'label',
          type: 'text',
          rect: [20, 80, 26, 24],
          text: { content: 'Go', kind: 'label' },
        },
        NEIGHBOUR,
      ],
    });
    const offscreen = await scene(makeDir, {
      nodes: [
        {
          id: 'label',
          type: 'text',
          rect: [0, 80, 20, 24],
          text: { content: 'Go', kind: 'label' },
        },
      ],
    });

    const failed = await runGate(hit.project, hit.screen, 'text');
    const off = await runGate(offscreen.project, offscreen.screen, 'text');

    expect(failed.problems[0]?.message).toContain('加长文案');
    expect(failed.problems[0]?.message).toContain('压到了 #neighbour');
    expect(off.status).toBe('fail');
    expect(off.problems[0]?.message).toContain('超出了画面');
  });
});

describe('性能预算', () => {
  it('干净的界面通过，报出各项数字', async () => {
    const { project, screen } = await scene(makeDir);
    const result = await runGate(project, screen, 'budget');

    expect(result.status).toBe('pass');
    expect(result.metrics).toMatchObject({
      assets: 2,
      longestSide: 200,
      batches: 2,
      translucent: 0,
    });
    expect(result.metrics.textureMiB).toBeGreaterThan(0);
  });

  it('长边超过上限的贴图失败，问题指向用它的节点', async () => {
    const { project, screen } = await scene(makeDir, {
      nodes: [{ id: 'banner', type: 'image', rect: [0, 100, 200, 4], asset: 'banner' }],
      assets: [
        { name: 'banner', png: await paintedPng(MAX_ASSET_SIDE + 4, 4, () => [9, 9, 9, 255]) },
      ],
    });
    const result = await runGate(project, screen, 'budget');

    expect(result.status).toBe('fail');
    expect(result.problems[0]?.node).toBe('banner');
    expect(result.problems[0]?.message).toContain(`长边超过 ${MAX_ASSET_SIDE}`);
  });

  it('纹理总内存超限失败', async () => {
    // Three 2048 x 2048 textures are 48 MiB as RGBA.
    const big = await paintedPng(2048, 2048, () => [9, 9, 9, 255]);
    const { project, screen } = await scene(makeDir, {
      nodes: ['a', 'b', 'c'].map((name) => ({
        id: name,
        type: 'image' as const,
        rect: [0, 0, 20, 20] as [number, number, number, number],
        asset: `big_${name}`,
      })),
      assets: ['a', 'b', 'c'].map((name) => ({ name: `big_${name}`, png: big, uses: [name] })),
    });
    const result = await runGate(project, screen, 'budget');

    expect(result.status).toBe('fail');
    expect(result.problems.some((problem) => problem.message.includes('纹理占 48'))).toBe(true);
  });

  it('绘制批次按相邻两次换贴图估算，超过上限失败', async () => {
    const count = BATCHES_FAIL + 10;
    const { project, screen } = await scene(makeDir, {
      nodes: Array.from({ length: count }, (_, i) => ({
        id: `n${i}`,
        type: 'image' as const,
        rect: [0, 0, 4, 4] as [number, number, number, number],
        asset: i % 2 === 0 ? 'bg' : 'btn',
      })),
    });
    const result = await runGate(project, screen, 'budget');

    expect(result.status).toBe('fail');
    expect(result.metrics.batches).toBeGreaterThan(BATCHES_FAIL);
    expect(result.problems[0]?.message).toContain('绘制批次');
  });

  it('同一图集的相邻资产算一个批次', async () => {
    const png = await paintedPng(8, 8, () => [9, 9, 9, 255]);
    const { project, screen } = await scene(makeDir, {
      nodes: [
        { id: 'a', type: 'image', rect: [0, 0, 8, 8], asset: 'one' },
        { id: 'b', type: 'image', rect: [8, 0, 8, 8], asset: 'two' },
      ],
      assets: [
        { name: 'one', png, atlas: 'icons' },
        { name: 'two', png, atlas: 'icons' },
      ],
    });
    const result = await runGate(project, screen, 'budget');
    expect(result.metrics.batches).toBe(3); // bg, btn, icons (once)
  });

  it('大面积半透明叠层：一层整屏警告，两层整屏失败', async () => {
    const glow = await paintedPng(200, 120, () => [255, 255, 255, 128]);
    const layer = (id: string) => ({
      id,
      type: 'image' as const,
      rect: [0, 0, 200, 120] as [number, number, number, number],
      asset: 'glow',
    });
    const one = await scene(makeDir, {
      nodes: [layer('g1')],
      assets: [{ name: 'glow', png: glow, uses: ['g1'] }],
    });
    const two = await scene(makeDir, {
      nodes: [layer('g1'), layer('g2')],
      assets: [{ name: 'glow', png: glow, uses: ['g1', 'g2'] }],
    });

    const warned = await runGate(one.project, one.screen, 'budget');
    const failed = await runGate(two.project, two.screen, 'budget');

    expect(warned.status).toBe('pass');
    expect(
      warned.warnings.some((warning) => warning.includes('半透明像素覆盖了界面面积的 100%')),
    ).toBe(true);
    expect(failed.status).toBe('fail');
    expect(failed.problems[0]?.message).toContain('半透明像素覆盖了界面面积的 200%');
  });
});
