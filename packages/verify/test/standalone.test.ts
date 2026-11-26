import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { paintedPng, type Rgba, runGate, scene, useTempDirs } from './helpers';

const makeDir = useTempDirs();

const DARK: Rgba = [30, 30, 40, 255];

/** A 48 x 48 disc; its antialiased edge ring keeps `edge` as its colour. */
const disc =
  (edge: [number, number, number]) =>
  (x: number, y: number): Rgba => {
    const distance = Math.hypot(x + 0.5 - 24, y + 0.5 - 24);
    if (distance <= 18) return DARK;
    if (distance <= 19.5) return [edge[0], edge[1], edge[2], 128];
    return [0, 0, 0, 0];
  };

async function withAsset(
  name: string,
  width: number,
  height: number,
  pixel: (x: number, y: number) => Rgba,
) {
  return scene(makeDir, {
    nodes: [{ id: name, type: 'image', rect: [140, 10, width, height], asset: name }],
    assets: [{ name, png: await paintedPng(width, height, pixel) }],
  });
}

describe('独立可用', () => {
  it('干净的资产通过，并出一张深浅两种底上的对照图', async () => {
    const { project, screen } = await withAsset('disc', 48, 48, disc([30, 30, 40]));
    const result = await runGate(project, screen, 'standalone');

    expect(result.status).toBe('pass');
    expect(result.problems).toEqual([]);
    expect(result.metrics.assets).toBe(3);
    expect(result.views).toHaveLength(1);
    expect(result.views[0]).toMatch(/standalone\.png$/);
    expect((await readFile(result.views[0] as string)).length).toBeGreaterThan(100);
  });

  it('带白边的资产（深色圆盘，边缘像素是白色）被查出，问题指向用它的节点', async () => {
    const { project, screen } = await withAsset('disc', 48, 48, disc([255, 255, 255]));
    const result = await runGate(project, screen, 'standalone');

    expect(result.status).toBe('fail');
    expect(result.problems).toHaveLength(1);
    const [problem] = result.problems;
    expect(problem?.node).toBe('disc');
    expect(problem?.message).toContain('资产 disc');
    expect(problem?.message).toContain('半透明边缘带着旧背景的颜色');
    expect(problem?.metrics?.wrong).toBeGreaterThan(12);
    expect(problem?.view).toMatch(/standalone\.png$/);
  });

  it('贴着文件边缘、与主体不连通的碎块是相邻元素的残留', async () => {
    const body = (x: number, y: number): Rgba =>
      x >= 8 && x < 56 && y >= 6 && y < 26
        ? DARK
        : x < 4 && y >= 14 && y < 18
          ? DARK
          : [0, 0, 0, 0];
    const { project, screen } = await withAsset('panel', 64, 32, body);
    const result = await runGate(project, screen, 'standalone');

    expect(result.status).toBe('fail');
    expect(result.problems.map((problem) => problem.message).join('\n')).toContain(
      '贴着文件边缘的残留',
    );
  });

  it('不贴边的独立小块（比如装饰火花）不算残留', async () => {
    const body = (x: number, y: number): Rgba =>
      x >= 8 && x < 56 && y >= 6 && y < 26
        ? DARK
        : x >= 58 && x < 62 && y >= 14 && y < 18
          ? DARK
          : [0, 0, 0, 0];
    const { project, screen } = await withAsset('panel', 64, 32, body);
    const result = await runGate(project, screen, 'standalone');
    expect(result.status).toBe('pass');
  });

  it('主体内部意外的透明小孔被查出', async () => {
    const plate = (x: number, y: number): Rgba =>
      x >= 30 && x < 32 && y >= 14 && y < 16 ? [0, 0, 0, 0] : DARK;
    const { project, screen } = await withAsset('plate', 64, 32, plate);
    const result = await runGate(project, screen, 'standalone');

    expect(result.status).toBe('fail');
    expect(result.problems[0]?.message).toContain('小透明孔');
  });

  it('环形的大孔是形状，不是破洞', async () => {
    const ring = (x: number, y: number): Rgba => {
      const distance = Math.hypot(x + 0.5 - 24, y + 0.5 - 24);
      return distance <= 20 && distance >= 10 ? DARK : [0, 0, 0, 0];
    };
    const { project, screen } = await withAsset('ring', 48, 48, ring);
    const result = await runGate(project, screen, 'standalone');
    expect(result.status).toBe('pass');
  });
});
