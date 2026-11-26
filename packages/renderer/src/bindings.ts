/**
 * Data bindings of `mock.json`: a dotted path into the data, with an optional format. Pure, so
 * Studio resolves the same text as the Node renderer.
 */

/** The value at a dotted path (`hero.level`, `items.0.name`), or `undefined` when there is none. */
export function lookupPath(data: unknown, path: string): unknown {
  let current: unknown = data;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current === null ? undefined : current;
}

const THOUSANDS = /^(,|#,##0)$/;

function withThousands(value: unknown): string {
  return typeof value === 'number' ? value.toLocaleString('en-US') : String(value);
}

/**
 * Formats a bound value. A format is a template where `{}` is the value and `{,}` the value with
 * thousands separators (`Lv.{}`, `ATK {,}`); a bare `,` or `#,##0` formats the whole text that
 * way. No format shows the value as it is. Returns `undefined` for a format it does not know.
 */
export function formatBinding(value: unknown, format?: string): string | undefined {
  if (format === undefined) return String(value);
  if (THOUSANDS.test(format)) return withThousands(value);
  if (!format.includes('{}') && !format.includes('{,}')) return undefined;
  return format.replaceAll('{,}', withThousands(value)).replaceAll('{}', String(value));
}

/** The text a binding shows from `data`; `undefined` when the path has no value. */
export function boundText(
  data: unknown,
  binding: { path: string; format?: string },
): string | undefined {
  const value = lookupPath(data, binding.path);
  if (value === undefined || typeof value === 'object') return undefined;
  return formatBinding(value, binding.format) ?? String(value);
}
