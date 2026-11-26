import { writeFile } from 'node:fs/promises';
import { referenceImagePath, resolveInside } from '@ui-pro/core';
import { openRenderSession } from '../src';
import { createFixture, type Fixture, type NodeInit, paintedPng, type Rgba } from './fixtures';

/** A hand-written shop screen: 1080 x 1920, 30 nodes, 5 assets (three shared by several nodes). */
export const MEDIUM_SIZE: [number, number] = [1080, 1920];
export const MEDIUM_NODE_COUNT = 30;

const CARDS = 6;

/** Nodes of the screen, parents first; the background is the first. */
export function mediumNodes(): NodeInit[] {
  const nodes: NodeInit[] = [
    { id: 'bg', type: 'image', rect: [0, 0, 1080, 1920], asset: 'bg' },
    { id: 'header', type: 'image', rect: [0, 0, 1080, 200], asset: 'header' },
    {
      id: 'title',
      type: 'text',
      rect: [60, 60, 600, 80],
      text: { content: 'Shop', size: 56, color: '#ffffff', kind: 'label' },
    },
    { id: 'coin', type: 'image', rect: [700, 52, 96, 96], asset: 'thumb' },
    {
      id: 'coins',
      type: 'text',
      rect: [820, 66, 200, 70],
      text: { content: '1250', size: 48, color: '#ffe680', kind: 'value' },
    },
  ];
  for (let i = 0; i < CARDS; i++) {
    const top = 260 + i * 240;
    nodes.push(
      { id: `card${i}`, type: 'image', rect: [60, top, 960, 200], asset: 'card' },
      { id: `thumb${i}`, type: 'image', rect: [90, top + 52, 96, 96], asset: 'thumb' },
      {
        id: `name${i}`,
        type: 'text',
        rect: [220, top + 60, 480, 80],
        text: { content: `Gold pack ${i + 1}`, size: 44, color: '#ffffff', kind: 'label' },
      },
      {
        id: `price${i}`,
        type: 'text',
        rect: [740, top + 60, 200, 80],
        text: { content: `${(i + 1) * 100 - 1}`, size: 44, color: '#ffe680', kind: 'value' },
      },
    );
  }
  nodes.push({ id: 'buy', type: 'button', rect: [300, 1740, 480, 120], asset: 'btn' });
  return nodes;
}

const lerp = (from: number, to: number, t: number): number => Math.round(from + (to - from) * t);

/**
 * The medium screen, built the way a build commits it. The reference image is the screen drawn
 * by the renderer itself, so fidelity has nothing to complain about and the measurements are
 * those of the gates, not of a defect.
 */
export async function mediumScreen(makeDir: () => Promise<string>): Promise<Fixture> {
  const [width, height] = MEDIUM_SIZE;
  const bg = (_x: number, y: number): Rgba => [
    lerp(20, 40, y / height),
    lerp(30, 60, y / height),
    lerp(70, 120, y / height),
    255,
  ];
  const header = (_x: number, y: number): Rgba => [
    lerp(30, 20, y / 200),
    40,
    lerp(110, 90, y / 200),
    255,
  ];
  const card = (_x: number, y: number): Rgba => [
    lerp(70, 60, y / 200),
    lerp(80, 70, y / 200),
    130,
    255,
  ];
  const thumb = (x: number, y: number): Rgba => {
    const dx = x - 48;
    const dy = y - 48;
    return dx * dx + dy * dy <= 46 * 46 ? [255, lerp(200, 140, y / 96), 40, 255] : [0, 0, 0, 0];
  };
  const button = (x: number, y: number): Rgba => [
    lerp(230, 190, y / 120),
    lerp(70, 40, y / 120),
    lerp(60, 50, x / 480),
    255,
  ];

  const fixture = await createFixture(makeDir, {
    width,
    height,
    nodes: mediumNodes(),
    assets: [
      {
        name: 'bg',
        png: await paintedPng(width, height, bg),
      },
      { name: 'header', png: await paintedPng(1080, 200, header) },
      {
        name: 'card',
        png: await paintedPng(960, 200, card),
        uses: Array.from({ length: CARDS }, (_, i) => `card${i}`),
      },
      {
        name: 'thumb',
        png: await paintedPng(96, 96, thumb),
        uses: ['coin', ...Array.from({ length: CARDS }, (_, i) => `thumb${i}`)],
      },
      { name: 'btn', png: await paintedPng(480, 120, button), uses: ['buy'] },
    ],
  });

  const session = await openRenderSession(fixture.project, fixture.screen);
  const frame = await session.render({ scale: 1 });
  session.dispose();
  const reference = resolveInside(fixture.project.root, referenceImagePath(session.doc));
  await writeFile(reference, frame.png);
  return fixture;
}
