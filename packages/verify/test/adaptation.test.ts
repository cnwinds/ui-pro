import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { HOME_BAR_INSET, NOTCH_INSET, viewportMatrix } from '../src/gates/viewports';
import { type NodeInit, runGate, scene, useTempDirs } from './helpers';

const makeDir = useTempDirs();

/** Three buttons along the top of a 200 x 120 screen: left, centre and right. */
const buttons = (right: NodeInit['anchor']): NodeInit[] => [
  { id: 'mid', type: 'button', rect: [110, 70, 30, 30], anchor: { h: 'center', v: 'top' } },
  { id: 'edge', type: 'button', rect: [150, 70, 40, 30], anchor: right },
];

describe('视口矩阵', () => {
  it('竖屏界面取 9:16、9:19.5、9:20、3:4，与基准相同的不重复', () => {
    const labels = viewportMatrix([1080, 1920]).map((entry) => entry.label);
    expect(labels).toEqual(['9:19.5', '9:20', '3:4']); // 9:16 is the design's own ratio
    expect(viewportMatrix([1080, 2400]).map((entry) => entry.label)).toEqual([
      '9:16',
      '9:19.5',
      '3:4',
    ]);
  });

  it('横屏取倒数；比基准更窄长时宽度不变，更宽时高度不变', () => {
    const landscape = viewportMatrix([1920, 1080]);
    expect(landscape.map((entry) => entry.label)).toEqual(['19.5:9', '20:9', '4:3']);
    const [wide, wider, narrow] = landscape.map((entry) => entry.viewport);
    expect(wide).toMatchObject({ height: 1080, width: Math.round(1080 * (19.5 / 9)) });
    expect(wider).toMatchObject({ height: 1080, width: 2400 });
    expect(narrow).toEqual({ width: 1920, height: 1440 });
  });

  it('9:19.5 和 9:20 带安全区，按短边换算', () => {
    const [tall] = viewportMatrix([540, 960]);
    expect(tall?.viewport.safeArea).toEqual([0, NOTCH_INSET / 2, 0, HOME_BAR_INSET / 2]);
    const landscape = viewportMatrix([960, 540]).find((entry) => entry.label === '19.5:9');
    expect(landscape?.viewport.safeArea).toEqual([
      NOTCH_INSET / 2,
      0,
      NOTCH_INSET / 2,
      HOME_BAR_INSET / 2,
    ]);
  });
});

describe('适配', () => {
  it('贴右的按钮锚到右边：在变宽的视口里与居中的按钮不重叠，通过', async () => {
    const { project, screen } = await scene(makeDir, {
      buttonRect: [10, 20, 30, 30],
      nodes: buttons({ h: 'right', v: 'top' }),
    });
    const result = await runGate(project, screen, 'adaptation');

    expect(result.problems).toEqual([]);
    expect(result.status).toBe('pass');
    expect(result.views).toEqual([]);
    expect(result.metrics.viewports).toBe(4);
  });

  it('把贴右的按钮错锚成 top-left：居中的按钮向右移、压到它身上，被查出并出图', async () => {
    const { project, screen } = await scene(makeDir, {
      buttonRect: [10, 20, 30, 30],
      nodes: buttons({ h: 'left', v: 'top' }),
    });
    const result = await runGate(project, screen, 'adaptation');

    expect(result.status).toBe('fail');
    const problem = result.problems[0];
    expect(problem?.message).toMatch(
      /视口 (16:9|19\.5:9|20:9)（\d+×120）里 1 对可交互或文字节点新出现重叠：#mid 与 #edge/,
    );
    expect(problem?.fix).toContain('layout.anchor');
    expect(problem?.view).toMatch(/adaptation-.*\.png$/);
    expect(result.views.length).toBeGreaterThanOrEqual(1);
    expect((await readFile(problem?.view as string)).length).toBeGreaterThan(100);
    expect(result.metrics.overlaps).toBeGreaterThanOrEqual(1);
  });

  it('设计尺寸下就重叠的两个节点不算新增', async () => {
    const { project, screen } = await scene(makeDir, {
      buttonRect: [10, 20, 30, 30],
      nodes: [
        { id: 'mid', type: 'button', rect: [150, 70, 30, 30], anchor: { h: 'left', v: 'top' } },
        { id: 'edge', type: 'button', rect: [160, 70, 30, 30], anchor: { h: 'left', v: 'top' } },
      ],
    });
    const result = await runGate(project, screen, 'adaptation');
    expect(result.problems).toEqual([]);
  });

  it('安全区里的可交互元素和文字只是警告', async () => {
    const { project, screen } = await scene(makeDir, {
      // 14 px from the left edge: inside the notch inset (14.7 px at this screen's size).
      buttonRect: [4, 40, 20, 20],
    });
    const result = await runGate(project, screen, 'adaptation');

    expect(result.status).toBe('pass');
    expect(
      result.warnings.some((warning) => warning.includes('安全区里有 1 个可交互元素或文字：#btn')),
    ).toBe(true);
  });
});
