const INLINE_ARRAY_WIDTH = 80;

type Scalar = string | number | boolean | null | undefined;

function isScalar(value: unknown): value is Scalar {
  return value === null || value === undefined || typeof value !== 'object';
}

function renderScalar(value: Scalar): string {
  return JSON.stringify(value) ?? 'null';
}

function render(value: unknown, depth: number): string {
  if (isScalar(value)) return renderScalar(value);
  const indent = '  '.repeat(depth + 1);
  const closing = '  '.repeat(depth);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every(isScalar)) {
      const inline = `[${value.map(renderScalar).join(', ')}]`;
      if (closing.length + inline.length <= INLINE_ARRAY_WIDTH) return inline;
    }
    const items = value.map((item) => `${indent}${render(item, depth + 1)}`);
    return `[\n${items.join(',\n')}\n${closing}]`;
  }

  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  if (entries.length === 0) return '{}';
  const lines = entries.map(
    ([key, entry]) => `${indent}${JSON.stringify(key)}: ${render(entry, depth + 1)}`,
  );
  return `{\n${lines.join(',\n')}\n${closing}}`;
}

/**
 * Deterministic JSON text: 2-space indent, object keys in insertion order, `undefined` members
 * dropped, short scalar arrays kept on one line, trailing newline.
 */
export function formatJson(value: unknown): string {
  return `${render(value, 0)}\n`;
}
