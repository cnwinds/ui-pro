import { ASSET_NAME_PATTERN } from '@ui-pro/core';
import { describe, expect, it } from 'vitest';
import { NameAllocator, semanticOf } from '../src/naming';

const TEMPLATE = '{prefix}_{semantic}_{index}';

describe('semanticOf', () => {
  it('drops the type prefix the node id already has', () => {
    expect(semanticOf('btn_upgrade', 'button')).toBe('upgrade');
    expect(semanticOf('img_bg', 'image')).toBe('bg');
    expect(semanticOf('button_ok', 'button')).toBe('ok');
  });

  it('keeps ids that do not start with the prefix, or are the prefix', () => {
    expect(semanticOf('badge_dot', 'image')).toBe('badge_dot');
    expect(semanticOf('btn', 'button')).toBe('btn');
  });
});

describe('NameAllocator', () => {
  it('gives the first name without an index and the next ones 2, 3', () => {
    const names = new NameAllocator();

    expect(names.forNode(TEMPLATE, 'btn_upgrade', 'button')).toBe('btn_upgrade');
    expect(names.forNode(TEMPLATE, 'btn_upgrade', 'button')).toBe('btn_upgrade_2');
    expect(names.forNode(TEMPLATE, 'btn_upgrade', 'button')).toBe('btn_upgrade_3');
  });

  it('expands the type prefix of each primitive', () => {
    const names = new NameAllocator();

    expect(names.forNode(TEMPLATE, 'hp', 'progress')).toBe('bar_hp');
    expect(names.forNode(TEMPLATE, 'coin', 'image')).toBe('img_coin');
  });

  it('numbers names of a template that has no {index} too', () => {
    const names = new NameAllocator();

    expect(names.forNode('{semantic}', 'coin', 'image')).toBe('coin');
    expect(names.forNode('{semantic}', 'coin', 'image')).toBe('coin_2');
  });

  it('names a state after the asset it belongs to', () => {
    const names = new NameAllocator();
    const base = names.forNode(TEMPLATE, 'btn_ok', 'button');

    expect(names.forState(base, 'pressed')).toBe('btn_ok_pressed');
    expect(names.forState(base, 'pressed')).toBe('btn_ok_pressed_2');
  });

  it('never repeats a name even when a state name collides with an asset name', () => {
    const names = new NameAllocator();
    expect(names.forNode('{semantic}', 'btn_ok_pressed', 'image')).toBe('btn_ok_pressed');

    const state = names.forState('btn_ok', 'pressed');
    const again = names.forNode('{semantic}', 'btn_ok_pressed', 'image');

    expect(state).toBe('btn_ok_pressed_2');
    expect(new Set(['btn_ok_pressed', state, again]).size).toBe(3);
  });

  it('turns anything a template produces into a valid asset name', () => {
    const names = new NameAllocator();

    const odd = names.forNode('Hero {semantic}!', 'x', 'image');
    const long = names.forNode(TEMPLATE, 'a'.repeat(200), 'image');
    const empty = names.forNode('{index}', 'x', 'image');

    for (const name of [odd, long, empty]) {
      expect(name).toMatch(ASSET_NAME_PATTERN);
      expect(name.length).toBeLessThanOrEqual(96);
    }
    expect(odd).toBe('hero_x');
  });
});
