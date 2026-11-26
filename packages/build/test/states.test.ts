import { describe, expect, it } from 'vitest';
import { deriveState } from '../src/states';
import { makeImage, pixelAt } from './support';

const normal = makeImage(2, 1, (x) => (x === 0 ? [200, 100, 50, 255] : [250, 250, 250, 200]));

describe('deriveState', () => {
  it('darkens a pressed state to 80% and keeps alpha', () => {
    const derived = deriveState('pressed', normal);

    expect(derived?.method).toBe('derive-darken');
    expect(pixelAt(derived?.image ?? normal, 0, 0)).toEqual([160, 80, 40, 255]);
    expect(pixelAt(derived?.image ?? normal, 1, 0)).toEqual([200, 200, 200, 200]);
  });

  it('treats press, down and active like pressed', () => {
    for (const name of ['press', 'down', 'active']) {
      expect(deriveState(name, normal)?.method).toBe('derive-darken');
    }
  });

  it('lightens hover a little and clamps at white', () => {
    const derived = deriveState('hover', normal);

    expect(derived?.method).toBe('derive-lighten');
    expect(pixelAt(derived?.image ?? normal, 0, 0)).toEqual([216, 108, 54, 255]);
    expect(pixelAt(derived?.image ?? normal, 1, 0)).toEqual([255, 255, 255, 200]);
  });

  it('makes disabled gray and 60% as opaque', () => {
    const derived = deriveState('disabled', normal);

    expect(derived?.method).toBe('derive-desaturate');
    const [r, g, b, a] = pixelAt(derived?.image ?? normal, 0, 0);
    expect(r).toBe(g);
    expect(g).toBe(b);
    expect(a).toBe(153);
  });

  it('has no recipe for other states, and never changes the normal picture', () => {
    expect(deriveState('selected', normal)).toBeUndefined();
    deriveState('pressed', normal);
    expect(pixelAt(normal, 0, 0)).toEqual([200, 100, 50, 255]);
  });
});
