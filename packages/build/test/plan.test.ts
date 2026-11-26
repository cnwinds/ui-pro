import { describe, expect, it } from 'vitest';
import { planAssets } from '../src/plan';
import { buildFixture, useTempDirs } from './support';

const makeDir = useTempDirs();

const exception = (target: string, point: string, value: string) => ({
  op: 'exception.add',
  target,
  point,
  value,
  because: '测试需要这个取值',
});

const holesOf = (plan: ReturnType<typeof planAssets>, node: string) =>
  plan.assets.find((asset) => asset.node === node)?.holes.map((hole) => [hole.node, hole.handling]);

describe('planAssets on the synthetic screen', () => {
  it('plans an asset for every node that draws pixels, back to front', async () => {
    const fixture = await buildFixture(makeDir);

    const plan = planAssets(fixture.load());

    expect(plan.assets.map((asset) => asset.node)).toEqual([
      'bg',
      'panel',
      'star',
      'btn_ok',
      'btn_a',
      'btn_b',
      'btn_c',
      'bar',
      'bar_fill',
    ]);
    expect(plan.stale).toEqual([]);
  });

  it('plans the holes from what is drawn above, with how each is handled', async () => {
    const fixture = await buildFixture(makeDir);

    const plan = planAssets(fixture.load());

    expect(holesOf(plan, 'panel')).toEqual([
      ['star', 'filled'],
      ['title', 'stripped'],
    ]);
    expect(holesOf(plan, 'bg')).toEqual([
      ['panel', 'kept'],
      ['star', 'filled'],
      ['title', 'stripped'],
      ['btn_ok', 'kept'],
      ['btn_a', 'kept'],
      ['btn_b', 'kept'],
      ['btn_c', 'kept'],
      ['bar', 'filled'],
      ['bar_fill', 'kept'],
      ['ex_1', 'filled'],
    ]);
    expect(holesOf(plan, 'star')).toEqual([]);
  });

  it('knows a background that covers the screen, and what stretches', async () => {
    const fixture = await buildFixture(makeDir);

    const plan = planAssets(fixture.load());
    const of = (node: string) => plan.assets.find((asset) => asset.node === node);

    expect(of('bg')?.fullBleed).toBe(true);
    expect(of('panel')?.fullBleed).toBe(false);
    expect(of('panel')?.stretch).toBe('nine-slice');
    expect(of('panel')?.density).toBe('design');
    expect(of('bg')?.stretch).toBe('fixed');
    expect(of('bg')?.density).toBe('native');
  });

  it('groups repeated nodes and keeps their decisions', async () => {
    const fixture = await buildFixture(makeDir);

    const plan = planAssets(fixture.load());
    const row = plan.assets.filter((asset) => ['btn_a', 'btn_b', 'btn_c'].includes(asset.node));

    expect(row.map((asset) => asset.group)).toEqual(['cluster:row', 'cluster:row', 'cluster:row']);
    expect(row.map((asset) => asset.repeat)).toEqual(['component', 'component', 'component']);
    expect(row.map((asset) => asset.variant)).toEqual([
      'variant-assets',
      'variant-assets',
      'variant-assets',
    ]);
  });

  it('asks for a picture of every state a node declares', async () => {
    const fixture = await buildFixture(makeDir);

    const plan = planAssets(fixture.load());
    const ok = plan.assets.find((asset) => asset.node === 'btn_ok');

    expect(ok?.states.map((state) => state.name).sort()).toEqual(['disabled', 'pressed']);
    expect(ok?.stateSource).toBe('derive');
  });

  it('lets the progress track be filled under its fill and says so', async () => {
    const fixture = await buildFixture(makeDir);

    const plan = planAssets(fixture.load());
    const bar = plan.assets.find((asset) => asset.node === 'bar');

    expect(bar?.holes.map((hole) => [hole.node, hole.handling])).toEqual([['bar_fill', 'filled']]);
    expect(bar?.approximations).toHaveLength(1);
    expect(bar?.approximations[0]).toMatch(/^occlusion\.fill：/);
  });

  it('bakes a node into its host when the decision says so', async () => {
    const fixture = await buildFixture(makeDir);
    await fixture.apply([exception('#star', 'attach.split', 'baked')]);

    const plan = planAssets(fixture.load());

    expect(plan.assets.map((asset) => asset.node)).not.toContain('star');
    expect(plan.assets.find((asset) => asset.node === 'panel')?.hosted).toEqual(['star']);
    expect(holesOf(plan, 'panel')).toEqual([['title', 'stripped']]);
  });

  it('draws bitmap text as an asset and notes the bitmap font as an approximation', async () => {
    const fixture = await buildFixture(makeDir);
    await fixture.apply([
      exception('#title', 'text.mode', 'bitmap'),
      exception('#title', 'attach.split', 'independent'),
    ]);

    const bitmap = planAssets(fixture.load()).assets.find((asset) => asset.node === 'title');
    expect(bitmap?.subject).toBe('text');
    expect(bitmap?.approximations).toEqual([]);

    await fixture.apply([exception('#title', 'text.mode', 'bitmap-font')]);
    const font = planAssets(fixture.load()).assets.find((asset) => asset.node === 'title');
    expect(font?.approximations).toHaveLength(1);
    expect(font?.approximations[0]).toMatch(/^text\.mode：/);
  });

  it('keeps an asset for a node with no host and says it could not be merged', async () => {
    const fixture = await buildFixture(makeDir);
    await fixture.apply([exception('#bg', 'decor.merge', 'merge')]);

    const bg = planAssets(fixture.load()).assets.find((asset) => asset.node === 'bg');

    expect(bg).toBeDefined();
    expect(bg?.approximations.some((note) => note.startsWith('decor.merge：'))).toBe(true);
  });

  it('puts everything on the design density when the source is smaller than the design', async () => {
    const fixture = await buildFixture(makeDir, { designWidth: 720 });

    const plan = planAssets(fixture.load());

    expect(plan.assets.every((asset) => asset.density === 'design')).toBe(true);
  });

  it('lists nodes that still carry an asset the decisions no longer give them', async () => {
    const fixture = await buildFixture(makeDir);
    await fixture.run();
    await fixture.apply([exception('#star', 'attach.split', 'baked')]);

    const plan = planAssets(fixture.load());

    expect(plan.stale).toEqual(['star']);
  });
});
