import { InvalidArgumentError } from 'commander';

/** Commander argument parser for an integer of at least `min`. */
export function integerParser(min: number): (value: string) => number {
  return (value) => {
    if (!/^-?\d+$/.test(value)) throw new InvalidArgumentError('需要整数');
    const parsed = Number(value);
    if (parsed < min) throw new InvalidArgumentError(`不能小于 ${min}`);
    return parsed;
  };
}
