import { readAssetManifest } from '@ui-pro/core';
import { describe, expect, it } from 'vitest';
import { buildInputsSha256 } from '../src';
import { buildFixture, useTempDirs } from './support';

const makeDir = useTempDirs();

const hashOf = (fixture: Awaited<ReturnType<typeof buildFixture>>) =>
  buildInputsSha256(fixture.project, 'main');

describe('buildInputsSha256', () => {
  it('is a sha256 that stays the same while nothing changes', async () => {
    const fixture = await buildFixture(makeDir);

    expect(hashOf(fixture)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOf(fixture)).toBe(hashOf(fixture));
  });

  it('equals the one the manifest recorded, because the build writes nothing it reads', async () => {
    const fixture = await buildFixture(makeDir);
    const before = hashOf(fixture);

    await fixture.run();

    expect(hashOf(fixture)).toBe(before);
    expect(readAssetManifest(fixture.project, 'main')?.inputsSha256).toBe(before);
  });

  it('stays the same through a rebuild with different pixels, since the inputs are the same', async () => {
    const fixture = await buildFixture(makeDir);
    await fixture.run();
    const first = hashOf(fixture);

    fixture.retweak(2);
    await fixture.run({ regenerate: '#panel' });

    expect(hashOf(fixture)).toBe(first);
  });

  it('changes with a node rectangle', async () => {
    const fixture = await buildFixture(makeDir);
    const before = hashOf(fixture);

    await fixture.apply([{ op: 'node.set', target: '#star', set: { rect: [52, 150, 48, 48] } }]);

    expect(hashOf(fixture)).not.toBe(before);
  });

  it('changes with a decision', async () => {
    const fixture = await buildFixture(makeDir);
    const before = hashOf(fixture);

    await fixture.apply([
      {
        op: 'exception.add',
        target: '#star',
        point: 'occlusion.fill',
        value: 'none',
        because: '测试需要这个取值',
      },
    ]);

    expect(hashOf(fixture)).not.toBe(before);
  });

  it('changes with the states a node declares and with exclusions', async () => {
    const fixture = await buildFixture(makeDir);
    const before = hashOf(fixture);

    await fixture.apply([{ op: 'state.set', target: '#btn_ok', state: 'hover', set: {} }]);
    const withState = hashOf(fixture);
    await fixture.apply([{ op: 'exclusion.add', rect: [0, 600, 40, 40], because: '角标' }]);

    expect(withState).not.toBe(before);
    expect(hashOf(fixture)).not.toBe(withState);
  });

  it('does not change with text content, which no asset depends on', async () => {
    const fixture = await buildFixture(makeDir);
    const before = hashOf(fixture);

    await fixture.apply([
      { op: 'node.set', target: '#title', set: { text: { content: '另一个标题' } } },
    ]);

    expect(hashOf(fixture)).toBe(before);
  });

  it('does not change with what the build writes into the nodes', async () => {
    const fixture = await buildFixture(makeDir);
    await fixture.run();
    const built = hashOf(fixture);

    await fixture.apply([
      { op: 'asset.assign', target: '#star', tint: '#808080' },
      { op: 'asset.assign', target: '#btn_ok', states: [{ state: 'pressed', asset: null }] },
    ]);

    expect(hashOf(fixture)).toBe(built);
  });
});
