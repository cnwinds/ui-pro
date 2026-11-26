import { readFile } from 'node:fs/promises';
import { openRenderSession } from '@ui-pro/renderer';
import { describe, expect, it } from 'vitest';
import { verifyScreen } from '../src';
import { FILL_ASK_AREA_RATIO } from '../src/gates/hide';
import {
  gradient,
  NAVY,
  type NodeInit,
  type Painter,
  type Rgba,
  runGate,
  scene,
  useTempDirs,
} from './helpers';

const makeDir = useTempDirs();

/** Dynamic text on the background, away from the button. */
const TEXT: NodeInit = {
  id: 'title',
  type: 'text',
  rect: [20, 80, 120, 24],
  text: { content: 'HELLO', size: 20, color: '#ffffff' },
};

/** What the reference renderer draws for the scene: a reference image that includes the text. */
async function renderedReference(): Promise<Painter> {
  const { project, screen } = await scene(makeDir, { nodes: [TEXT] });
  const session = await openRenderSession(project, screen);
  const frame = await session.render();
  session.dispose();
  return (x, y): Rgba => {
    const at = (y * frame.width + x) * 4;
    return [
      frame.data[at] ?? 0,
      frame.data[at + 1] ?? 0,
      frame.data[at + 2] ?? 0,
      frame.data[at + 3] ?? 0,
    ];
  };
}

describe('显隐测试', () => {
  it('宿主资产补全过：隐藏按钮后露出的是与周围连续的背景，通过', async () => {
    const { project, screen } = await scene(makeDir);
    const result = await runGate(project, screen, 'hide');

    expect(result.status).toBe('pass');
    expect(result.problems).toEqual([]);
    expect(result.metrics.checks).toBe(1);
    expect(result.metrics.ghosts).toBe(0);
    expect(result.metrics.seams).toBe(0);
    expect(result.metrics.frames).toBeGreaterThanOrEqual(2);
  });

  it('宿主资产没有补全、还留着遮挡物的像素：查出残影和接缝', async () => {
    const { project, screen } = await scene(makeDir, {
      // The background keeps the button's own pixels under it.
      background: (x, y): Rgba =>
        x >= 20 && x < 100 && y >= 20 && y < 60 ? gradient(x - 20) : NAVY,
    });
    const result = await runGate(project, screen, 'hide');

    expect(result.status).toBe('fail');
    const ghost = result.problems.find((problem) => problem.message.includes('残影'));
    expect(ghost?.node).toBe('bg');
    expect(ghost?.message).toContain('隐藏 #btn 后');
    expect(ghost?.view).toMatch(/hide-bg-btn\.png$/);
    expect(result.metrics.ghosts).toBe(1);
    expect(result.metrics.seams).toBe(1);
    expect((await readFile(ghost?.view as string)).length).toBeGreaterThan(100);
  });

  it('残留的是一块平色（没有纹理，谈不上残影）时，查出的是接缝', async () => {
    const { project, screen } = await scene(makeDir, {
      background: (x, y): Rgba =>
        x >= 20 && x < 100 && y >= 20 && y < 60 ? [200, 40, 40, 255] : NAVY,
    });
    const result = await runGate(project, screen, 'hide');

    expect(result.status).toBe('fail');
    expect(result.metrics.ghosts).toBe(0);
    expect(result.metrics.seams).toBe(1);
    expect(result.problems[0]?.message).toContain('接不上');
  });

  it('occlusion.fill 为 none 的遮挡物按决定保留像素，不测', async () => {
    const { project, screen } = await scene(makeDir, {
      background: (x, y): Rgba =>
        x >= 20 && x < 100 && y >= 20 && y < 60 ? gradient(x - 20) : NAVY,
      buttonDecisions: { 'occlusion.fill': { value: 'none', by: 'exception' } },
    });
    const result = await runGate(project, screen, 'hide');

    expect(result.status).toBe('pass');
    expect(result.metrics.checks).toBe(0);
  });

  it('剥离过文字的宿主通过；文字还留在资产里时查出残影', async () => {
    const reference = await renderedReference();
    const clean = await scene(makeDir, { nodes: [TEXT], reference });
    const baked = await scene(makeDir, {
      nodes: [TEXT],
      reference,
      // The background asset is the reference itself: button and glyphs both still in it.
      background: reference,
    });

    const passed = await runGate(clean.project, clean.screen, 'hide');
    const failed = await runGate(baked.project, baked.screen, 'hide');

    expect(passed.status).toBe('pass');
    expect(passed.metrics.checks).toBe(2);
    expect(failed.status).toBe('fail');
    const messages = failed.problems.map((problem) => problem.message);
    expect(messages.some((message) => message.includes('隐藏 #title 后'))).toBe(true);
    expect(messages.some((message) => message.includes('隐藏 #btn 后'))).toBe(true);
  });

  it('补全的面积超过界面的 5% 时在 ask 里请用户确认，附对比图；小面积不问', async () => {
    const big = await scene(makeDir); // the 80 x 40 button is 13% of 200 x 120
    const small = await scene(makeDir, { buttonRect: [20, 20, 16, 10] });

    const asked = await verifyScreen(big.project, big.screen, { gates: ['hide'] });
    const quiet = await verifyScreen(small.project, small.screen, { gates: ['hide'] });

    expect(asked.ask.map((question) => question.id)).toEqual(['hide.fill.total']);
    expect(asked.ask[0]?.options).toEqual(['确认', '重做']);
    expect(asked.ask[0]?.question).toContain(`${FILL_ASK_AREA_RATIO * 100}%`);
    expect(quiet.ask).toEqual([]);
  });

  it('单块补全超过设计像素阈值时，单独为它提问并附对比图', async () => {
    const { project, screen } = await scene(makeDir, {
      size: [600, 400],
      buttonRect: [50, 50, 250, 200],
    });
    const report = await verifyScreen(project, screen, { gates: ['hide'] });

    const block = report.ask.find((question) => question.id === 'hide.fill.bg.btn');
    expect(block).toBeDefined();
    expect(block?.question).toMatch(/hide-fill-bg-btn\.png/);
    expect(report.views.some((view) => view.endsWith('hide-fill-bg-btn.png'))).toBe(true);
  });

  it('PSD 源文件的图层本来就是分开的：跳过并说明原因', async () => {
    const { project, screen } = await scene(makeDir, {
      patch: (doc) => {
        doc.source.kind = 'psd';
      },
    });
    const result = await runGate(project, screen, 'hide');
    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('PSD');
  });
});
