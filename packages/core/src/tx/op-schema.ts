import { z } from 'zod';
import { ErrorCodes, UiProError } from '../errors';
import type { Registry } from './registry';
import type { OpFamily } from './types';

export interface OpSummary {
  name: string;
  family: OpFamily;
  summary: string;
}

export function describeOps(registry: Registry): OpSummary[] {
  return registry.listOps().map(({ name, family, summary }) => ({ name, family, summary }));
}

/** Names closest to a mistyped op name: same `family.` prefix first, then all names. */
export function suggestOps(registry: Registry, name: string): string[] {
  const names = registry.listOps().map((op) => op.name);
  const prefix = name.split('.')[0] ?? '';
  const related = names.filter((candidate) => candidate.startsWith(`${prefix}.`));
  return related.length > 0 ? related : names;
}

export function unknownOpError(registry: Registry, name: string): UiProError {
  return new UiProError(ErrorCodes.opUnknown, `未知的操作：${name}`, {
    hint: `可用操作：${suggestOps(registry, name).join('、')}；ui-pro schema 列出全部`,
    details: { op: name },
  });
}

/** JSON Schema (draft 2020-12) describing the op's input. */
export function opJsonSchema(registry: Registry, name: string): Record<string, unknown> {
  const definition = registry.getOp(name);
  if (!definition) throw unknownOpError(registry, name);
  return z.toJSONSchema(definition.schema, { unrepresentable: 'any' });
}
