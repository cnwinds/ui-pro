import { STATE_NAME_PATTERN } from '@ui-pro/core';
import type { PsdLayer } from './model';

/** A group whose name starts with `#` is not delivered; it and everything in it is skipped. */
export function isIgnored(layer: PsdLayer): boolean {
  return layer.kind === 'group' && layer.name.startsWith('#');
}

/** The raw state name of a `@状态名` layer or group, `undefined` for any other layer. */
export function stateNameOf(layer: PsdLayer): string | undefined {
  return layer.name.startsWith('@') ? layer.name.slice(1) : undefined;
}

export function isValidStateName(name: string): boolean {
  return STATE_NAME_PATTERN.test(name);
}

/** Splits `slot_equip_3` into `slot_equip` and 3; `undefined` when the name has no number. */
export function numberedName(name: string): { base: string; n: number } | undefined {
  const match = /^(.*[^_\d])_(\d+)$/.exec(name);
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { base: match[1], n: Number(match[2]) };
}
