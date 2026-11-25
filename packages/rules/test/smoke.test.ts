import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';

describe('rules dependencies', () => {
  it('parses YAML and validates it with zod', () => {
    const schema = z.strictObject({ version: z.literal(1), rules: z.array(z.string()) });
    const parsed = schema.parse(parse('version: 1\nrules:\n  - badge-top-right\n'));

    expect(parsed.rules).toEqual(['badge-top-right']);
  });
});
