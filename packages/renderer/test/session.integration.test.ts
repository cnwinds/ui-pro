import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { screenRelDir } from '@ui-pro/core';
import { describe, expect, it } from 'vitest';
import { openRenderSession } from '../src';
import { pixelAt, useTempDirs } from './fixtures';
import { MEDIUM_NODE_COUNT, mediumNodes, mediumScreen } from './medium';

const makeDir = useTempDirs();

const FRAMES = 300;
const WARM_UP = 30;

/** Resident memory in megabytes: Skia's surfaces and images live outside the JS heap. */
const residentMb = (): number => process.memoryUsage().rss / 1024 / 1024;

describe('渲染会话连续渲染（显隐测试的用法）', () => {
  it(`中等界面（${MEDIUM_NODE_COUNT} 个节点）连续渲染 ${FRAMES} 帧：不再读也不再解码资产，内存不增长`, async () => {
    expect(mediumNodes()).toHaveLength(MEDIUM_NODE_COUNT);
    const fixture = await mediumScreen(makeDir);
    const session = await openRenderSession(fixture.project, fixture.screen);

    // The session holds every decoded asset: with the files gone, a frame that read or decoded
    // anything again would draw placeholders (and warn).
    rmSync(join(fixture.project.root, ...screenRelDir(fixture.screen).split('/'), 'assets'), {
      recursive: true,
      force: true,
    });

    const hideable = mediumNodes()
      .filter((node) => node.id !== 'bg')
      .map((node) => node.id);
    const render = (index: number) =>
      session.render({ hidden: [hideable[index % hideable.length] ?? 'buy'], scale: 1 });

    for (let index = 0; index < WARM_UP; index++) await render(index);
    const memoryBefore = residentMb();

    const started = performance.now();
    let last = await render(WARM_UP);
    for (let index = WARM_UP + 1; index < FRAMES; index++) last = await render(index);
    const elapsed = performance.now() - started;
    const memoryAfter = residentMb();

    const perFrame = elapsed / (FRAMES - WARM_UP);
    console.info(
      `[renderer] ${FRAMES - WARM_UP} 帧 ${elapsed.toFixed(0)} ms，单帧 ${perFrame.toFixed(1)} ms；` +
        `常驻内存 ${memoryBefore.toFixed(0)} → ${memoryAfter.toFixed(0)} MB`,
    );

    // The last frame still has the background drawn from the in-memory image.
    expect(last.list.warnings.filter((warning) => !warning.includes('没有指定字体'))).toEqual([]);
    expect(pixelAt(last, 5, 1900)[3]).toBe(255);
    // Without the event-loop turn per frame this grows by 8 MB a frame (2 GB over the run).
    expect(memoryAfter - memoryBefore).toBeLessThan(64);
    // Generous: ~100 ms a frame on the slowest machine we run on; the measured value is far lower.
    expect(perFrame).toBeLessThan(250);
    session.dispose();
  }, 120_000);
});
