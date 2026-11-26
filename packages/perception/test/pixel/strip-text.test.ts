import type { Rect } from '@ui-pro/core';
import { describe, expect, it } from 'vitest';
import { createPixelOps } from '../../src/pixel';
import { SVG_FONT } from '../helpers';
import { fakeRunner, label, makeContext, meanAbsolute, rasterize } from './helpers';

const WIDTH = 200;
const HEIGHT = 110;
const FONT_SIZE = 46;

const defs = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#2f5d8a"/><stop offset="1" stop-color="#9fd0f0"/>
</linearGradient></defs>`;
const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${defs}${body}</svg>`;
const background = `<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#g)"/>`;

interface Style {
  fill: string;
  stroke?: { color: string; width: number };
  shadow?: { color: string; dx: number; dy: number };
}

function textElement(
  style: Style,
  dx = 0,
  dy = 0,
  color = style.fill,
  strokeColor = style.stroke?.color,
) {
  // paint-order stroke: the stroke is centred on the outline, so `width` shows outside it as width / 2.
  const stroke = style.stroke
    ? ` stroke="${strokeColor}" stroke-width="${style.stroke.width * 2}" stroke-linejoin="round" paint-order="stroke"`
    : '';
  return `<text x="${20 + dx}" y="${72 + dy}" font-family="${SVG_FONT}" font-size="${FONT_SIZE}" font-weight="bold" fill="${color}"${stroke}>Lv59</text>`;
}

function textLayers(style: Style): string {
  const shadow = style.shadow
    ? textElement(style, style.shadow.dx, style.shadow.dy, style.shadow.color, style.shadow.color)
    : '';
  return shadow + textElement(style);
}

async function scene(style: Style, backdrop = background) {
  const image = await rasterize(svg(backdrop + textLayers(style)));
  const clean = await rasterize(svg(backdrop));
  const ink = await rasterize(svg(textLayers(style)));
  let [minX, minY, maxX, maxY] = [WIDTH, HEIGHT, 0, 0];
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    if ((ink.data[i * 4 + 3] ?? 0) < 100) continue;
    const x = i % WIDTH;
    const y = Math.floor(i / WIDTH);
    [minX, minY, maxX, maxY] = [
      Math.min(minX, x),
      Math.min(minY, y),
      Math.max(maxX, x),
      Math.max(maxY, y),
    ];
  }
  // Roughly what OCR reports: the glyphs' box, a little loose.
  const box: Rect = [minX - 1, minY - 1, maxX - minX + 3, maxY - minY + 3];
  const alpha = {
    width: WIDTH,
    height: HEIGHT,
    data: Uint8Array.from({ length: WIDTH * HEIGHT }, (_, i) => ink.data[i * 4 + 3] ?? 0),
  };
  return { image, clean, box, ink: alpha };
}

function channelsNear(
  hex: string | undefined,
  want: readonly [number, number, number],
  tolerance = 14,
) {
  expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  const got = [1, 3, 5].map((at) => Number.parseInt((hex as string).slice(at, at + 2), 16));
  for (const [channel, value] of got.entries()) {
    expect(Math.abs(value - (want[channel] as number))).toBeLessThanOrEqual(tolerance);
  }
}

function ops() {
  return createPixelOps(makeContext().context, { runner: fakeRunner() });
}

function boxFlags(box: Rect) {
  const flags = new Uint8Array(WIDTH * HEIGHT);
  for (let y = box[1]; y < box[1] + box[3]; y++) {
    for (let x = box[0]; x < box[0] + box[2]; x++) flags[y * WIDTH + x] = 1;
  }
  return flags;
}

describe('stripText', () => {
  it('measures a plain text and removes it from a gradient', async () => {
    const { image, clean, box } = await scene({ fill: '#ffffff' });
    const result = await ops().stripText({ image, box, quality: 'draft', style: 'smooth', label });

    channelsNear(result.measured.color, [255, 255, 255]);
    expect(result.measured.stroke).toBeUndefined();
    expect(result.measured.shadow).toBeUndefined();
    expect(Math.abs(result.measured.size - FONT_SIZE) / FONT_SIZE).toBeLessThanOrEqual(0.15);
    expect(result.tier).toBe('analytic');
    expect(meanAbsolute(result.image, clean, boxFlags(box))).toBeLessThan(4);
  });

  it('measures colour and outline width', async () => {
    const { image, clean, box } = await scene({
      fill: '#ffd23a',
      stroke: { color: '#6b2b00', width: 3 },
    });
    const result = await ops().stripText({ image, box, quality: 'draft', style: 'smooth', label });

    channelsNear(result.measured.color, [255, 210, 58]);
    expect(result.measured.stroke).toBeDefined();
    channelsNear(result.measured.stroke?.color, [107, 43, 0]);
    expect(Math.abs((result.measured.stroke?.width ?? 0) - 3)).toBeLessThanOrEqual(1);
    expect(result.measured.shadow).toBeUndefined();
    expect(Math.abs(result.measured.size - FONT_SIZE) / FONT_SIZE).toBeLessThanOrEqual(0.15);
    expect(meanAbsolute(result.image, clean, boxFlags(box))).toBeLessThan(5);
  });

  it('measures a drop shadow', async () => {
    const { image, clean, box } = await scene({
      fill: '#ffd23a',
      stroke: { color: '#6b2b00', width: 2 },
      shadow: { color: '#101010', dx: 3, dy: 3 },
    });
    const result = await ops().stripText({ image, box, quality: 'draft', style: 'smooth', label });

    channelsNear(result.measured.color, [255, 210, 58]);
    expect(result.measured.stroke).toBeDefined();
    expect(result.measured.shadow).toBeDefined();
    channelsNear(result.measured.shadow?.color, [16, 16, 16]);
    const [dx, dy] = result.measured.shadow?.offset ?? [0, 0];
    expect(Math.abs(dx - 3)).toBeLessThanOrEqual(1);
    expect(Math.abs(dy - 3)).toBeLessThanOrEqual(1);
    expect(meanAbsolute(result.image, clean, boxFlags(box))).toBeLessThan(5);
  });

  it('uses the ink mask it is given, shadow included, and keeps pixels away from the text', async () => {
    const { image, clean, box, ink } = await scene({
      fill: '#ffffff',
      stroke: { color: '#202020', width: 2 },
      shadow: { color: '#000000', dx: 3, dy: 3 },
    });
    const result = await ops().stripText({
      image,
      box,
      ink,
      quality: 'draft',
      style: 'smooth',
      label,
    });
    expect(meanAbsolute(result.image, clean, boxFlags(box))).toBeLessThan(5);
    // Far from the text the image is the input's, byte for byte.
    const far = new Uint8Array(WIDTH * HEIGHT);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        if (x < box[0] - 8 || x > box[0] + box[2] + 8 || y < box[1] - 8 || y > box[1] + box[3] + 8)
          far[y * WIDTH + x] = 1;
      }
    }
    expect(meanAbsolute(result.image, image, far)).toBe(0);
  });

  it('takes the badge a text sits on as the background when the badge is only a few pixels larger', async () => {
    const pill = `<rect x="11" y="30" width="124" height="52" rx="20" fill="#e8672a"/>`;
    const { image, clean, box } = await scene(
      { fill: '#ffffff', stroke: { color: '#7a2d08', width: 3 } },
      background + pill,
    );
    // A model that knows what is behind the text: the badge's colour.
    const runner = fakeRunner({
      async inpaint(view, mask) {
        const out = { ...view, data: new Uint8Array(view.data) };
        for (let i = 0; i < mask.data.length; i++) {
          if ((mask.data[i] ?? 0) >= 128) out.data.set([232, 103, 42, 255], i * 4);
        }
        return out;
      },
    });
    const result = await createPixelOps(makeContext().context, { runner }).stripText({
      image,
      box,
      quality: 'draft',
      style: 'smooth',
      label,
    });

    channelsNear(result.measured.color, [255, 255, 255]);
    channelsNear(result.measured.stroke?.color, [122, 45, 8], 24);
    // The hole is the glyphs, not the badge: with the badge's colour painted in, the box looks
    // like the badge without text, and the blue around the badge is untouched.
    expect(result.tier).toBe('local');
    expect(meanAbsolute(result.image, clean, boxFlags(box))).toBeLessThan(6);
    // Just outside the badge nothing changed.
    const outside = new Uint8Array(WIDTH * HEIGHT);
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < 10; x++) outside[y * WIDTH + x] = 1;
    expect(meanAbsolute(result.image, image, outside)).toBe(0);
  });

  it('says so when the box holds no text', async () => {
    const { image, clean } = await scene({ fill: '#ffffff' });
    const result = await ops().stripText({
      image: clean,
      box: [5, 5, 40, 20],
      quality: 'draft',
      style: 'smooth',
      label,
    });
    expect(result.warnings.join('')).toMatch(/没有找到文字/);
    expect(Array.from(result.image.data)).toEqual(Array.from(clean.data));
    expect(image.width).toBe(WIDTH);
  });
});
