import { describe, expect, it } from 'vitest';
import { EmbeddedRenderer, parsePsd, planRenderUnits } from '../src';
import type { RgbaImage } from '../src/image';
import { renderUnits } from '../src/render-store';
import {
  MAX_DIFF_RATIO,
  MAX_UNEXPLAINED_RATIO,
  PIXEL_TOLERANCE,
  recompose,
  toImage,
  verify,
} from '../src/verify';
import { compliantLayers, DESIGN, group, pixel, psdBytes } from './fixtures';

async function setup(layers = compliantLayers()) {
  const document = parsePsd(psdBytes(layers, DESIGN));
  const units = planRenderUnits(document);
  const { stored } = await renderUnits({ document, units, renderer: new EmbeddedRenderer() });
  const composition = await recompose(document.width, document.height, units, stored);
  const composite = document.composite;
  if (composite === null) throw new Error('fixture has no composite');
  return {
    document,
    units,
    composition,
    composite: { ...composite, data: composite.data.slice() },
  };
}

/** Adds `delta` to the red channel of a block of the composite. */
function tamper(image: RgbaImage, [x, y, w, h]: [number, number, number, number], delta: number) {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      const at = (row * image.width + col) * 4;
      image.data[at] = Math.min(255, (image.data[at] ?? 0) + delta);
    }
  }
}

describe('verify', () => {
  it('passes every layer when the recomposition equals the composite', async () => {
    const { composition, composite } = await setup();
    const result = verify(composite, composition);
    expect(result.checks.every((check) => check.pass)).toBe(true);
    expect(result.checks.every((check) => check.maxDelta === 0)).toBe(true);
    expect(result.unexplained).toMatchObject({ pixels: 0, pass: true });
  });

  it('reproduces the composite exactly as a straight-alpha image', async () => {
    const { composition, composite, document } = await setup();
    const image = toImage(document.width, document.height, composition);
    expect(Buffer.from(image.data).equals(Buffer.from(composite.data))).toBe(true);
  });

  it('measures every layer on the pixels it is topmost on', async () => {
    const { composition, composite, document } = await setup();
    const areas = new Map(
      verify(composite, composition).checks.map((check) => [check.id, check.area]),
    );
    // The canvas is covered by bg_main except where later layers lie on top of it.
    const total = [...areas.values()].reduce((sum, area) => sum + area, 0);
    expect(total).toBe(document.width * document.height);
    const byName = new Map(document.layers.map((layer) => [layer.name, layer.id]));
    expect(areas.get(byName.get('bg_main') ?? -1)).toBeLessThan(DESIGN.width * DESIGN.height);
  });

  it('blames the topmost layer where the picture is wrong, with its metrics', async () => {
    const { composition, composite, document } = await setup();
    tamper(composite, [20, 240, 60, 40], 90); // the left half of btn_upgrade/base
    const result = verify(composite, composition);
    const base = document.layers.find((layer) => layer.name === 'btn_upgrade')?.children?.[0];
    const failed = result.checks.filter((check) => !check.pass);
    expect(failed.map((check) => check.id)).toEqual([base?.id]);
    expect(failed[0]).toMatchObject({ maxDelta: 90, diffPixels: 60 * 40 });
    // The badge lies over the right edge of the base, so the base owns a little less than its box.
    expect(failed[0]?.area).toBe(120 * 40 - 10 * 8);
    expect(failed[0]?.diffRatio).toBeCloseTo(2400 / (failed[0]?.area ?? 1), 10);
  });

  it('tolerates rounding differences up to the documented tolerance', async () => {
    const small = await setup();
    tamper(small.composite, [20, 240, 100, 40], PIXEL_TOLERANCE);
    expect(verify(small.composite, small.composition).checks.every((c) => c.pass)).toBe(true);

    const large = await setup();
    tamper(large.composite, [20, 240, 100, 40], PIXEL_TOLERANCE + 1);
    expect(verify(large.composite, large.composition).checks.filter((c) => !c.pass)).toHaveLength(
      1,
    );
  });

  it('lets a few wrong pixels pass but not a visible share of the layer', async () => {
    const { composition, composite } = await setup();
    const area = 120 * 40 - 10 * 8; // what the base owns, see above
    const few = Math.floor(area * MAX_DIFF_RATIO);
    tamper(composite, [20, 240, few, 1], 100);
    expect(verify(composite, composition).checks.every((check) => check.pass)).toBe(true);
    tamper(composite, [20, 241, 1, 1], 100);
    expect(verify(composite, composition).checks.filter((check) => !check.pass)).toHaveLength(1);
  });

  it('reports pixels no layer explains', async () => {
    const { composition, composite } = await setup([
      pixel('bg_main', [0, 0, 100, 100], [20, 24, 40, 255]),
    ]);
    const outside = Math.ceil(DESIGN.width * DESIGN.height * MAX_UNEXPLAINED_RATIO) + 1;
    for (let x = 0; x < outside; x++) {
      composite.data.set([0, 0, 0, 100], (150 * composite.width + 100 + x) * 4);
    }
    const { unexplained } = verify(composite, composition);
    expect(unexplained).toMatchObject({ pixels: outside, pass: false, maxDelta: 100 });
  });
});

describe('planRenderUnits', () => {
  it('folds clipped layers into their base and skips what the composite does not show', () => {
    const layers = [
      pixel('bg_main', [0, 0, 200, 320], [20, 24, 40, 255]),
      group('btn_ok', [
        pixel('base', [10, 10, 40, 20], [40, 120, 220, 255]),
        pixel('glow', [10, 10, 40, 20], [255, 255, 255, 255], { clipping: true }),
        pixel('@pressed', [10, 10, 40, 20], [20, 70, 150, 255], { hidden: true }),
      ]),
      group('#notes', [pixel('draft', [0, 0, 20, 20], [1, 1, 1, 255], { hidden: true })], {
        hidden: true,
      }),
      group('#shown', [pixel('mark', [0, 0, 20, 20], [1, 1, 1, 255])]),
    ];
    const document = parsePsd(psdBytes(layers, DESIGN));
    const id = (name: string) => {
      const found = [...flat(document.layers)].find((layer) => layer.name === name);
      if (found === undefined) throw new Error(name);
      return found.id;
    };
    const units = planRenderUnits(document);
    expect(units.map((unit) => unit.id)).toEqual([
      id('bg_main'),
      id('base'),
      id('@pressed'),
      id('mark'),
    ]);
    expect(units.find((unit) => unit.id === id('base'))).toMatchObject({
      show: [id('base'), id('glow')],
      visible: true,
      ignored: false,
    });
    expect(units.find((unit) => unit.id === id('@pressed'))).toMatchObject({ visible: false });
    expect(units.find((unit) => unit.id === id('mark'))).toMatchObject({ ignored: true });
  });
});

function* flat(
  layers: readonly { name: string; id: number; children?: readonly never[] | unknown[] }[],
): Generator<{ name: string; id: number }> {
  for (const layer of layers) {
    yield layer;
    if (layer.children) yield* flat(layer.children as typeof layers);
  }
}
