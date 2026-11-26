import { describe, expect, it } from 'vitest';
import { registerBuild } from '../src';
import { buildFixture, failureOf, newRegistry, useTempDirs } from './support';

const makeDir = useTempDirs();

const assign = (target: string, fields: Record<string, unknown>) => ({
  op: 'asset.assign',
  target,
  ...fields,
});

describe('asset.assign', () => {
  it('is registered once and may be registered again', () => {
    const registry = newRegistry();

    expect(() => registerBuild(registry)).not.toThrow();
    expect(registry.getOp('asset.assign')?.family).toBe('build');
  });

  it('refuses to bind before the screen has a manifest', async () => {
    const fixture = await buildFixture(makeDir);

    const error = await failureOf(fixture.apply([assign('#star', { asset: 'img_star' })]));

    expect(error.message).toContain('还没有资产清单');
  });

  it('refuses a name the manifest does not have, and lists what it has', async () => {
    const fixture = await buildFixture(makeDir);
    await fixture.run();

    const error = await failureOf(fixture.apply([assign('#star', { asset: 'nope' })]));

    expect(error.message).toContain('资产清单里没有资产 nope');
    expect(error.hint).toContain('img_star');
  });

  it('rebinds and clears the asset of a node', async () => {
    const fixture = await buildFixture(makeDir);
    await fixture.run();
    expect(fixture.load().nodes.star?.asset).toBe('img_star');

    await fixture.apply([assign('#star', { asset: null })]);
    expect(fixture.load().nodes.star?.asset).toBeUndefined();

    await fixture.apply([assign('#star', { asset: 'img_star' })]);
    expect(fixture.load().nodes.star?.asset).toBe('img_star');
  });

  it('sets and clears the tint', async () => {
    const fixture = await buildFixture(makeDir);
    await fixture.run();

    await fixture.apply([assign('#star', { tint: '#80ccff' })]);
    expect(fixture.load().nodes.star?.tint).toBe('#80ccff');

    await fixture.apply([assign('#star', { tint: null })]);
    expect(fixture.load().nodes.star?.tint).toBeUndefined();
  });

  it('accepts a nine-slice only when it equals the margins the asset records', async () => {
    const fixture = await buildFixture(makeDir);
    await fixture.run();

    const error = await failureOf(
      fixture.apply([assign('#panel', { asset: 'img_panel', nineSlice: [1, 1, 1, 1] })]),
    );
    expect(error.message).toContain('九宫边距');
    expect(error.hint).toContain('6, 6, 6, 6');

    await fixture.apply([assign('#panel', { asset: 'img_panel', nineSlice: [6, 6, 6, 6] })]);
    expect(fixture.load().nodes.panel?.nineSlice).toEqual([6, 6, 6, 6]);

    await fixture.apply([assign('#panel', { nineSlice: null })]);
    expect(fixture.load().nodes.panel?.nineSlice).toBeUndefined();
  });

  it('binds assets to the states a node declares, and nothing else', async () => {
    const fixture = await buildFixture(makeDir);
    await fixture.run();

    const error = await failureOf(
      fixture.apply([assign('#btn_ok', { states: [{ state: 'hover', asset: 'btn_ok_pressed' }] })]),
    );
    expect(error.message).toContain('没有声明状态 hover');

    await fixture.apply([
      assign('#btn_ok', { states: [{ state: 'pressed', asset: 'btn_ok_disabled' }] }),
    ]);
    expect(fixture.load().nodes.btn_ok?.states?.pressed?.asset).toBe('btn_ok_disabled');

    await fixture.apply([assign('#btn_ok', { states: [{ state: 'pressed', asset: null }] })]);
    expect(fixture.load().nodes.btn_ok?.states?.pressed).toEqual({});
  });

  it('fills only the text style fields that are still empty', async () => {
    const fixture = await buildFixture(makeDir);

    await fixture.apply([assign('#title', { text: { size: 20, color: '#112233' } })]);
    await fixture.apply([
      assign('#title', {
        text: { size: 99, color: '#ffffff', stroke: { color: '#000000', width: 2 } },
      }),
    ]);

    expect(fixture.load().nodes.title?.text).toEqual({
      content: '标题',
      size: 20,
      color: '#112233',
      stroke: { color: '#000000', width: 2 },
    });
  });

  it('refuses text style for a node that has no text', async () => {
    const fixture = await buildFixture(makeDir);

    const error = await failureOf(fixture.apply([assign('#star', { text: { size: 20 } })]));

    expect(error.message).toContain('没有 text');
  });

  it('wants at least one field', async () => {
    const fixture = await buildFixture(makeDir);

    const error = await failureOf(fixture.apply([assign('#star', {})]));

    expect(error.message).toContain('至少要给出');
  });

  it('refuses fields it does not know', async () => {
    const fixture = await buildFixture(makeDir);

    const error = await failureOf(fixture.apply([assign('#star', { tint: '#ffffff', size: 3 })]));

    expect(error.message).toMatch(/size|未知|多余/);
  });
});
