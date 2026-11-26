import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GlobalFonts } from '@napi-rs/canvas';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { openRenderSession } from '../src';
import { createFixture, paintedPng, pixelAt, type Rgba, solidPng, useTempDirs } from './fixtures';

const makeDir = useTempDirs();

const RED: Rgba = [255, 0, 0, 255];
const CLEAR: Rgba = [0, 0, 0, 0];

describe('openRenderSession', () => {
  it('draws an asset where its node is and nothing elsewhere', async () => {
    const fx = await createFixture(makeDir, {
      width: 100,
      height: 200,
      nodes: [{ id: 'box', type: 'image', rect: [10, 20, 40, 30], asset: 'box' }],
      assets: [{ name: 'box', png: await solidPng(8, 8, RED) }],
    });
    const session = await openRenderSession(fx.project, fx.screen);
    const frame = await session.render();

    expect([frame.width, frame.height]).toEqual([100, 200]);
    expect(pixelAt(frame, 10, 20)).toEqual(RED);
    expect(pixelAt(frame, 49, 49)).toEqual(RED);
    expect(pixelAt(frame, 50, 49)).toEqual(CLEAR);
    expect(pixelAt(frame, 5, 5)).toEqual(CLEAR);
    expect(frame.rects.get('box')).toEqual([10, 20, 40, 30]);
    expect(frame.list.ops.map((op) => op.node)).toEqual(['box']);
    session.dispose();
  });

  it('fills the background behind everything when asked', async () => {
    const fx = await createFixture(makeDir, { width: 20, height: 20 });
    const session = await openRenderSession(fx.project, fx.screen);
    const frame = await session.render({ background: '#102030' });
    expect(pixelAt(frame, 3, 3)).toEqual([16, 32, 48, 255]);
    session.dispose();
  });

  it('renders at the reference size by default: 1 / screen.scale', async () => {
    const fx = await createFixture(makeDir, {
      width: 200,
      height: 400,
      sourceSize: [100, 200],
      nodes: [{ id: 'box', type: 'image', rect: [20, 40, 100, 80], asset: 'box' }],
      assets: [{ name: 'box', png: await solidPng(10, 10, RED) }],
    });
    expect(fx.project.config.design.width).toBe(200);
    const session = await openRenderSession(fx.project, fx.screen);

    const reference = await session.render();
    expect([reference.width, reference.height]).toEqual([100, 200]);
    expect(pixelAt(reference, 10, 20)).toEqual(RED);
    expect(pixelAt(reference, 9, 19)).toEqual(CLEAR);
    expect(pixelAt(reference, 59, 59)).toEqual(RED);
    expect(pixelAt(reference, 60, 59)).toEqual(CLEAR);

    const design = await session.render({ scale: 1 });
    expect([design.width, design.height]).toEqual([200, 400]);
    expect(pixelAt(design, 20, 40)).toEqual(RED);

    const bigger = await session.render({ scale: 2 });
    expect([bigger.width, bigger.height]).toEqual([400, 800]);
    expect(bigger.list.width).toBe(200);
    session.dispose();
  });

  it('lays out in a viewport and sizes the frame to it', async () => {
    const fx = await createFixture(makeDir, {
      width: 100,
      height: 200,
      nodes: [
        {
          id: 'btn',
          type: 'image',
          rect: [60, 160, 30, 30],
          asset: 'btn',
          anchor: { h: 'right', v: 'bottom' },
        },
      ],
      assets: [{ name: 'btn', png: await solidPng(4, 4, RED) }],
    });
    const session = await openRenderSession(fx.project, fx.screen);
    const frame = await session.render({ viewport: { width: 150, height: 300 } });
    expect([frame.width, frame.height]).toEqual([150, 300]);
    expect(frame.rects.get('btn')).toEqual([110, 260, 30, 30]);
    expect(pixelAt(frame, 125, 275)).toEqual(RED);
    expect(pixelAt(frame, 75, 175)).toEqual(CLEAR);
    session.dispose();
  });

  it('keeps the four corners of a nine-slice at their size and stretches the rest', async () => {
    // 12x12 file, 3-pixel margins: corners red, green, blue, yellow; edges and middle grey.
    const paint = (x: number, y: number): Rgba => {
      const left = x < 3;
      const right = x >= 9;
      const top = y < 3;
      const bottom = y >= 9;
      if (top && left) return [255, 0, 0, 255];
      if (top && right) return [0, 255, 0, 255];
      if (bottom && left) return [0, 0, 255, 255];
      if (bottom && right) return [255, 255, 0, 255];
      return [90, 90, 90, 255];
    };
    const fx = await createFixture(makeDir, {
      width: 100,
      height: 100,
      nodes: [
        {
          id: 'frame',
          type: 'image',
          rect: [10, 10, 60, 40],
          asset: 'frame',
          nineSlice: [3, 3, 3, 3],
        },
      ],
      assets: [{ name: 'frame', png: await paintedPng(12, 12, paint), nineSlice: [3, 3, 3, 3] }],
    });
    const session = await openRenderSession(fx.project, fx.screen);
    const frame = await session.render();

    // 3x3 corners at the destination's corners: [10,10] .. [69,49].
    expect(pixelAt(frame, 10, 10)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(frame, 12, 12)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(frame, 13, 13)).toEqual([90, 90, 90, 255]);
    expect(pixelAt(frame, 69, 10)).toEqual([0, 255, 0, 255]);
    expect(pixelAt(frame, 67, 12)).toEqual([0, 255, 0, 255]);
    expect(pixelAt(frame, 66, 13)).toEqual([90, 90, 90, 255]);
    expect(pixelAt(frame, 10, 49)).toEqual([0, 0, 255, 255]);
    expect(pixelAt(frame, 12, 47)).toEqual([0, 0, 255, 255]);
    expect(pixelAt(frame, 69, 49)).toEqual([255, 255, 0, 255]);
    expect(pixelAt(frame, 67, 47)).toEqual([255, 255, 0, 255]);
    expect(pixelAt(frame, 40, 30)).toEqual([90, 90, 90, 255]);
    session.dispose();
  });

  it('keeps the corner size in design pixels when the frame is scaled', async () => {
    const paint = (x: number, y: number): Rgba => (x < 4 && y < 4 ? RED : [90, 90, 90, 255]);
    const fx = await createFixture(makeDir, {
      width: 100,
      height: 100,
      nodes: [
        {
          id: 'frame',
          type: 'image',
          rect: [0, 0, 80, 60],
          asset: 'frame',
          nineSlice: [4, 4, 4, 4],
        },
      ],
      assets: [{ name: 'frame', png: await paintedPng(16, 16, paint), nineSlice: [4, 4, 4, 4] }],
    });
    const session = await openRenderSession(fx.project, fx.screen);
    const frame = await session.render({ scale: 2 });
    expect(pixelAt(frame, 7, 7)).toEqual(RED);
    expect(pixelAt(frame, 8, 8)).toEqual([90, 90, 90, 255]);
    session.dispose();
  });

  it('multiplies a tint into RGB and leaves transparency alone', async () => {
    const png = await paintedPng(8, 8, (x) => (x < 4 ? [200, 200, 200, 255] : [200, 200, 200, 0]));
    const fx = await createFixture(makeDir, {
      width: 20,
      height: 20,
      nodes: [{ id: 'gem', type: 'image', rect: [0, 0, 8, 8], asset: 'gem', tint: '#ff8000' }],
      assets: [{ name: 'gem', png }],
    });
    const session = await openRenderSession(fx.project, fx.screen);
    const frame = await session.render();
    const [r, g, b, a] = pixelAt(frame, 1, 4);
    expect([r, b, a]).toEqual([200, 0, 255]);
    expect(Math.abs(g - 100)).toBeLessThanOrEqual(1);
    expect(pixelAt(frame, 6, 4)[3]).toBe(0);
    session.dispose();
  });

  it('draws stroked text with pixels of the stroke colour around the fill', async () => {
    const fx = await createFixture(makeDir, {
      width: 200,
      height: 100,
      nodes: [
        {
          id: 'title',
          type: 'text',
          rect: [0, 0, 200, 100],
          text: {
            content: 'WWW',
            size: 60,
            color: '#ffffff',
            stroke: { color: '#ff0000', width: 4 },
          },
        },
      ],
    });
    const session = await openRenderSession(fx.project, fx.screen);
    const frame = await session.render();
    let stroke = 0;
    let fill = 0;
    for (let i = 0; i < frame.data.length; i += 4) {
      const [r, g, b, a] = [
        frame.data[i] ?? 0,
        frame.data[i + 1] ?? 0,
        frame.data[i + 2] ?? 0,
        frame.data[i + 3] ?? 0,
      ];
      if (a > 250 && r > 240 && g < 20 && b < 20) stroke++;
      if (a > 250 && r > 240 && g > 240 && b > 240) fill++;
    }
    expect(stroke).toBeGreaterThan(200);
    expect(fill).toBeGreaterThan(200);
    session.dispose();
  });

  it('draws a labelled box for a node that has no asset, with or without a manifest', async () => {
    const fx = await createFixture(makeDir, {
      width: 100,
      height: 100,
      nodes: [{ id: 'hero', type: 'image', rect: [10, 10, 60, 60] }],
    });
    const session = await openRenderSession(fx.project, fx.screen);
    expect(session.manifest).toBeNull();
    const frame = await session.render();
    expect(frame.list.ops.map((op) => op.kind)).toEqual(['placeholder']);
    expect(frame.list.warnings).toEqual(['1 个节点还没有资产，画占位框：#hero']);
    const [r, g, b, a] = pixelAt(frame, 10, 40);
    expect(a).toBeGreaterThan(200);
    expect([r, g, b]).toEqual([255, 0, 255]);
    session.dispose();
  });

  it('draws only the nodes asked for, on a transparent ground', async () => {
    const fx = await createFixture(makeDir, {
      width: 100,
      height: 100,
      nodes: [
        { id: 'a', type: 'image', rect: [0, 0, 20, 20], asset: 'a' },
        { id: 'b', type: 'image', rect: [50, 50, 20, 20], asset: 'b' },
      ],
      assets: [
        { name: 'a', png: await solidPng(4, 4, RED) },
        { name: 'b', png: await solidPng(4, 4, [0, 0, 255, 255]) },
      ],
    });
    const session = await openRenderSession(fx.project, fx.screen);
    const only = await session.renderNodes(['b'], { background: '#ffffff' });
    expect(only.list.ops.map((op) => op.node)).toEqual(['b']);
    expect(pixelAt(only, 5, 5)).toEqual(CLEAR);
    expect(pixelAt(only, 55, 55)).toEqual([0, 0, 255, 255]);
    session.dispose();
  });

  it('renders the same pixels each time and keeps frames independent of later ones', async () => {
    const fx = await createFixture(makeDir, {
      width: 60,
      height: 60,
      nodes: [
        { id: 'a', type: 'image', rect: [0, 0, 30, 30], asset: 'a' },
        { id: 'b', type: 'image', rect: [30, 30, 30, 30], asset: 'b' },
      ],
      assets: [
        { name: 'a', png: await solidPng(4, 4, RED) },
        { name: 'b', png: await solidPng(4, 4, [0, 0, 255, 255]) },
      ],
    });
    const session = await openRenderSession(fx.project, fx.screen);
    const first = await session.render();
    const hidden = await session.render({ hidden: ['b'] });
    const again = await session.render();
    expect(pixelAt(hidden, 45, 45)).toEqual(CLEAR);
    expect(pixelAt(first, 45, 45)).toEqual([0, 0, 255, 255]);
    expect(Buffer.from(first.data).equals(Buffer.from(again.data))).toBe(true);
    session.dispose();
  });

  it('encodes the PNG on demand, to the same pixels', async () => {
    const fx = await createFixture(makeDir, {
      width: 30,
      height: 20,
      nodes: [{ id: 'a', type: 'image', rect: [0, 0, 30, 20], asset: 'a' }],
      assets: [{ name: 'a', png: await solidPng(4, 4, RED) }],
    });
    const session = await openRenderSession(fx.project, fx.screen);
    const frame = await session.render();
    const decoded = await sharp(Buffer.from(frame.png)).raw().toBuffer({ resolveWithObject: true });
    expect([decoded.info.width, decoded.info.height]).toEqual([30, 20]);
    expect(Array.from(decoded.data.subarray(0, 4))).toEqual(RED);
    session.dispose();
  });

  it('measures text wider when it is longer or bigger', async () => {
    const fx = await createFixture(makeDir, { width: 20, height: 20 });
    const session = await openRenderSession(fx.project, fx.screen);
    const font = { family: 'sans-serif', size: 20 };
    const short = session.measureText(font, 'WW');
    expect(short).toBeGreaterThan(0);
    expect(session.measureText(font, 'WWWW')).toBeGreaterThan(short * 1.8);
    expect(session.measureText({ ...font, size: 40 }, 'WW')).toBeGreaterThan(short * 1.8);
    session.dispose();
  });

  it('refuses to render after dispose', async () => {
    const fx = await createFixture(makeDir, { width: 20, height: 20 });
    const session = await openRenderSession(fx.project, fx.screen);
    session.dispose();
    await expect(session.render()).rejects.toThrow('渲染会话已经关闭');
  });

  describe('fonts', () => {
    it('warns about a project font whose file is missing, and falls back', async () => {
      const fx = await createFixture(makeDir, {
        width: 100,
        height: 40,
        fonts: { Title: 'resources/fonts/missing.ttf' },
        nodes: [
          { id: 't', type: 'text', rect: [0, 0, 100, 40], text: { content: 'Hi', font: 'Title' } },
        ],
      });
      const session = await openRenderSession(fx.project, fx.screen);
      const frame = await session.render();
      expect(frame.list.warnings.some((line) => line.includes('missing.ttf'))).toBe(true);
      expect(frame.list.ops).toHaveLength(1);
      session.dispose();
    });

    const SYSTEM_FONT = 'C:/Windows/Fonts/arial.ttf';
    it.skipIf(!existsSync(SYSTEM_FONT))(
      'registers a project font file under the name it is listed by',
      async () => {
        const fx = await createFixture(makeDir, {
          width: 100,
          height: 40,
          fonts: { 'Test Display': 'resources/fonts/display.ttf' },
          nodes: [
            {
              id: 't',
              type: 'text',
              rect: [0, 0, 100, 40],
              text: { content: 'Hi', font: 'Test Display' },
            },
          ],
          patch: () => {
            // Placed before the session opens, below.
          },
        });
        const target = join(fx.project.root, 'resources', 'fonts', 'display.ttf');
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(SYSTEM_FONT, target);

        const session = await openRenderSession(fx.project, fx.screen);
        const frame = await session.render();
        expect(GlobalFonts.families.some((entry) => entry.family === 'Test Display')).toBe(true);
        expect(frame.list.warnings).toEqual([]);
        session.dispose();
      },
    );
  });
});
