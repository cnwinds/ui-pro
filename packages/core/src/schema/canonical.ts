import { z } from 'zod';

const UNKNOWN = z.unknown();

export interface CanonicalOptions {
  /** Record schemas whose key order is meaningful and must be kept as given. */
  preserveOrder?: ReadonlySet<z.ZodType>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema;
  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable ||
    current instanceof z.ZodDefault
  ) {
    current = current.unwrap() as z.ZodType;
  }
  return current;
}

function sortedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort();
}

/**
 * Rewrites `value` into canonical form so equal documents serialize to equal bytes:
 * object members follow the schema's declaration order, free-form maps are key-sorted,
 * `undefined` members are dropped. Members the schema does not know about are kept (sorted)
 * after the declared ones, so nothing is silently lost.
 */
export function canonicalize(
  schema: z.ZodType,
  value: unknown,
  options: CanonicalOptions = {},
): unknown {
  const inner = unwrap(schema);

  if (Array.isArray(value)) {
    const element = inner instanceof z.ZodArray ? (inner.element as z.ZodType) : UNKNOWN;
    return value.map((item) => canonicalize(element, item, options));
  }
  if (!isObject(value)) return value;

  const result: Record<string, unknown> = {};
  const assign = (key: string, member: z.ZodType) => {
    const entry = value[key];
    if (entry !== undefined) result[key] = canonicalize(member, entry, options);
  };

  if (inner instanceof z.ZodObject) {
    const shape = inner.shape as Record<string, z.ZodType>;
    for (const [key, member] of Object.entries(shape)) assign(key, member);
    for (const key of sortedKeys(value)) if (!(key in shape)) assign(key, UNKNOWN);
  } else {
    const member = inner instanceof z.ZodRecord ? (inner.valueType as z.ZodType) : UNKNOWN;
    const keys = options.preserveOrder?.has(inner) ? Object.keys(value) : sortedKeys(value);
    for (const key of keys) assign(key, member);
  }
  return result;
}
