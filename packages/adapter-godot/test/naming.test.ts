import { describe, expect, it } from 'vitest';
import { assignNodeNames, toFileStem, toPascalCase } from '../src';

describe('toPascalCase', () => {
  it.each([
    ['btn_upgrade', 'BtnUpgrade'],
    ['title', 'Title'],
    ['badge_dot', 'BadgeDot'],
    ['slot_12', 'Slot12'],
    ['character-page', 'CharacterPage'],
    ['a__b', 'AB'],
  ])('%s -> %s', (id, name) => {
    expect(toPascalCase(id)).toBe(name);
  });
});

describe('toFileStem', () => {
  it('uses lowercase underscores for file names', () => {
    expect(toFileStem('character-page')).toBe('character_page');
    expect(toFileStem('main')).toBe('main');
  });
});

describe('assignNodeNames', () => {
  it('names every id after its Pascal-case form', () => {
    const names = assignNodeNames(['btn_shop', 'title']);
    expect([...names]).toEqual([
      ['btn_shop', 'BtnShop'],
      ['title', 'Title'],
    ]);
  });

  it('keeps names unique when ids collapse to the same name', () => {
    const names = assignNodeNames(['a_1', 'a1', 'a__1']);

    expect(new Set(names.values()).size).toBe(3);
    expect(names.get('a1')).toBe('A1');
    expect(names.get('a_1')).toBe('A1_2');
    expect(names.get('a__1')).toBe('A1_3');
  });

  it('does not depend on the order the ids are given in', () => {
    expect(assignNodeNames(['a_1', 'a1'])).toEqual(assignNodeNames(['a1', 'a_1']));
  });

  it('avoids reserved names', () => {
    expect(assignNodeNames(['main'], ['Main']).get('main')).toBe('Main_2');
  });
});
