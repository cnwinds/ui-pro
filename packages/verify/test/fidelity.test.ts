import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  loadScreen,
  referenceImagePath,
  resolveInside,
  type ScreenDoc,
  screenRelPath,
  serializeScreen,
} from '@ui-pro/core';
import { openRenderSession } from '@ui-pro/renderer';
import { describe, expect, it } from 'vitest';
import { GLOBAL_DELTA_E_MAX, GLOBAL_SSIM_MIN, NODE_DELTA_E_MAX } from '../src/gates/fidelity';
import {
  gradient,
  NAVY,
  type NodeInit,
  paintedPng,
  type Rgba,
  rawPng,
  runGate,
  scene,
  useTempDirs,
} from './helpers';

const makeDir = useTempDirs();

/** The gradient button turned green: a clearly wrong colour on the one asset. */
const greenButton = (x: number): Rgba => {
  const [r, g, b] = gradient(x);
  return [Math.max(0, r - 120), Math.min(255, g + 150), b, 255];
};

describe('重组保真', () => {
  it('资产与基准图一致时通过，并写出热力图和对照图', async () => {
    const { project, screen } = await scene(makeDir);
    const result = await runGate(project, screen, 'fidelity');

    expect(result.status).toBe('pass');
    expect(result.problems).toEqual([]);
    expect(result.metrics.ssim).toBeGreaterThanOrEqual(GLOBAL_SSIM_MIN);
    expect(result.metrics.deltaE).toBeLessThanOrEqual(GLOBAL_DELTA_E_MAX);
    expect(result.metrics.nodesMeasured).toBeGreaterThanOrEqual(2);
    expect(result.views.map((view) => view.split('/').pop())).toEqual([
      'fidelity.png',
      'fidelity-compare.png',
    ]);
    for (const view of result.views) expect((await readFile(view)).length).toBeGreaterThan(100);
  });

  it('把一张资产整体偏色后失败，问题指向那个节点，并附放大对比图', async () => {
    const { project, screen } = await scene(makeDir, { button: greenButton });
    const result = await runGate(project, screen, 'fidelity');

    expect(result.status).toBe('fail');
    const problem = result.problems.find((entry) => entry.node === 'btn');
    expect(problem).toBeDefined();
    expect(problem?.message).toContain('节点 #btn 与基准图不一致');
    expect(problem?.message).toContain(`高于 ${NODE_DELTA_E_MAX}`);
    expect(problem?.view).toMatch(/fidelity-btn\.png$/);
    expect(problem?.fix).toContain('ui-pro build');
    expect(problem?.metrics?.deltaE).toBeGreaterThan(NODE_DELTA_E_MAX);
    // The background asset was not touched.
    expect(result.problems.some((entry) => entry.node === 'bg')).toBe(false);
  });

  it('底下的资产里留着被遮挡处的任意像素，不算它自己的偏差', async () => {
    // What `bg` holds under the button is a hole: the button is drawn over it.
    const { project, screen } = await scene(makeDir, {
      background: (x, y): Rgba => (x >= 20 && x < 100 && y >= 20 && y < 60 ? [0, 0, 0, 255] : NAVY),
    });
    const result = await runGate(project, screen, 'fidelity');
    expect(result.status).toBe('pass');
  });

  it('排除区不计入全局指标；同样的水印不在排除区里就计入', async () => {
    const reference = (x: number, y: number): Rgba => {
      if (x >= 150 && x < 190 && y >= 80 && y < 110) return [255, 255, 255, 255];
      return x >= 20 && x < 100 && y >= 20 && y < 60 ? gradient(x - 20) : NAVY;
    };
    const excluded = await scene(makeDir, {
      reference,
      patch: (doc) => {
        doc.exclusions = [{ id: 'ex_1', rect: [150, 80, 40, 30], because: '水印', evidence: [] }];
      },
    });
    const kept = await scene(makeDir, { reference });

    const passed = await runGate(excluded.project, excluded.screen, 'fidelity');
    const failed = await runGate(kept.project, kept.screen, 'fidelity');

    expect(passed.status).toBe('pass');
    expect(failed.status).toBe('fail');
    expect(failed.problems.find((entry) => entry.node === undefined)?.message).toContain(
      '整体与基准图不一致',
    );
    expect(failed.metrics.ssim).toBeLessThan(passed.metrics.ssim as number);
  });

  it('清单记着近似项的资产，偏差记为警告而不是失败', async () => {
    const { project, screen } = await scene(makeDir, {
      button: greenButton,
      buttonApproximations: ['按钮的渐变是近似的'],
    });
    const result = await runGate(project, screen, 'fidelity');

    expect(result.problems.some((entry) => entry.node === 'btn')).toBe(false);
    expect(
      result.warnings.some(
        (warning) => warning.includes('#btn') && warning.includes('按钮的渐变是近似的'),
      ),
    ).toBe(true);
  });

  it('没有资产的节点画占位框，记警告，不计入逐节点比对', async () => {
    const { project, screen } = await scene(makeDir, {
      nodes: [{ id: 'extra', type: 'image', rect: [150, 10, 30, 30] }],
    });
    const result = await runGate(project, screen, 'fidelity');
    expect(result.warnings.some((warning) => warning.includes('#extra'))).toBe(true);
  });

  describe('动态文字的墨迹', () => {
    const arial = 'C:/Windows/Fonts/arial.ttf';
    const TITLE: NodeInit = {
      id: 'title',
      type: 'text',
      rect: [20, 80, 120, 24],
      text: { content: 'HELLO', font: 'sans', size: 20, color: '#ffffff' },
    };

    /**
     * A screen whose reference image is what the renderer draws for it, text included; then the
     * document is changed so the text no longer matches the reference.
     */
    async function textScene(options: { font: boolean; change?: (doc: ScreenDoc) => void }) {
      const fixture = await scene(makeDir, {
        nodes: [TITLE],
        ...(options.font ? { fonts: { sans: 'fonts/arial.ttf' } } : {}),
      });
      const { project, screen } = fixture;
      if (options.font) {
        await mkdir(join(project.root, 'fonts'), { recursive: true });
        await copyFile(arial, join(project.root, 'fonts', 'arial.ttf'));
      }
      const session = await openRenderSession(project, screen);
      const frame = await session.render();
      session.dispose();
      await writeFile(
        resolveInside(project.root, referenceImagePath(loadScreen(project, screen))),
        await rawPng(frame.width, frame.height, frame.data),
      );
      if (options.change) {
        const doc = loadScreen(project, screen);
        options.change(doc);
        await writeFile(
          join(project.root, ...screenRelPath(screen, 'doc').split('/')),
          serializeScreen(doc),
        );
      }
      return fixture;
    }

    const shifted = (doc: ScreenDoc) => {
      const title = doc.nodes.title;
      if (title) title.rect = [50, 80, 120, 24];
    };

    it.skipIf(!existsSync(arial))('墨迹位置、大小、颜色都与基准图相符时通过', async () => {
      const { project, screen } = await textScene({ font: true });
      const result = await runGate(project, screen, 'fidelity');

      expect(result.problems).toEqual([]);
      expect(result.status).toBe('pass');
      expect(result.metrics.textChecked).toBe(1);
    });

    it.skipIf(!existsSync(arial))('文字位置偏离基准图：失败，指向文字节点', async () => {
      const { project, screen } = await textScene({ font: true, change: shifted });
      const result = await runGate(project, screen, 'fidelity');

      const problem = result.problems.find((entry) => entry.node === 'title');
      expect(result.status).toBe('fail');
      expect(problem?.message).toContain('文字墨迹位置或大小与基准图不符');
      expect(problem?.message).toContain('外接框交并比');
    });

    it.skipIf(!existsSync(arial))('文字颜色与基准图不同：失败', async () => {
      const { project, screen } = await textScene({
        font: true,
        change: (doc) => {
          const text = doc.nodes.title?.text;
          if (text) text.color = '#ff0000';
        },
      });
      const result = await runGate(project, screen, 'fidelity');

      expect(result.problems.find((entry) => entry.node === 'title')?.message).toContain(
        '文字主体颜色与基准图不符',
      );
    });

    it('用系统字体兜底时，同样的偏离只记警告', async () => {
      const { project, screen } = await textScene({ font: false, change: shifted });
      const result = await runGate(project, screen, 'fidelity');

      expect(result.problems.find((entry) => entry.node === 'title')).toBeUndefined();
      expect(
        result.warnings.some(
          (warning) => warning.includes('#title') && warning.includes('系统字体兜底'),
        ),
      ).toBe(true);
    });

    it('文字框里基准图与去掉文字的重组图没有差别：失败', async () => {
      // The reference has no text at all there.
      const { project, screen } = await scene(makeDir, { nodes: [TITLE] });
      const result = await runGate(project, screen, 'fidelity');

      expect(result.problems.find((entry) => entry.node === 'title')?.message).toContain(
        '没有差别',
      );
    });
  });

  it('基准图差一个像素时重采样到重组图的大小并给出警告', async () => {
    const { project, screen } = await scene(makeDir);
    const reference = resolveInside(project.root, referenceImagePath(loadScreen(project, screen)));
    await writeFile(reference, await paintedPng(201, 121, () => NAVY));

    const result = await runGate(project, screen, 'fidelity');
    expect(result.warnings.some((warning) => warning.includes('重采样'))).toBe(true);
  });
});
