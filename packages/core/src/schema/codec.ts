import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { z } from 'zod';
import { ErrorCodes, UiProError } from '../errors';
import { formatJson } from '../json';
import { type CanonicalOptions, canonicalize } from './canonical';

export interface Codec<T> {
  /** `label` names the document in error messages (normally its project-relative path). */
  parse(text: string, label: string): T;
  serialize(value: T): string;
}

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join('.');
    return path === '' ? issue.message : `${path}: ${issue.message}`;
  });
}

export function parseWithSchema<S extends z.ZodType>(
  schema: S,
  raw: unknown,
  label: string,
): z.infer<S> {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const issues = formatIssues(result.error);
  throw new UiProError(ErrorCodes.docInvalid, `文档格式不正确：${label}\n${issues.join('\n')}`, {
    details: { label, issues },
  });
}

/** Drops the UTF-8 byte order mark that Windows PowerShell 5 and old editors write. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseJsonText(text: string, label: string): unknown {
  try {
    return JSON.parse(stripBom(text));
  } catch (cause) {
    throw new UiProError(ErrorCodes.docInvalid, `JSON 语法错误：${label}`, { cause });
  }
}

function parseYamlText(text: string, label: string): unknown {
  try {
    return parseYaml(text);
  } catch (cause) {
    throw new UiProError(ErrorCodes.docInvalid, `YAML 语法错误：${label}`, { cause });
  }
}

export function jsonCodec<S extends z.ZodType>(
  schema: S,
  options?: CanonicalOptions,
): Codec<z.infer<S>> {
  return {
    parse: (text, label) => parseWithSchema(schema, parseJsonText(text, label), label),
    serialize: (value) => formatJson(canonicalize(schema, value, options)),
  };
}

export function yamlCodec<S extends z.ZodType>(schema: S): Codec<z.infer<S>> {
  return {
    parse: (text, label) => parseWithSchema(schema, parseYamlText(text, label), label),
    serialize: (value) => stringifyYaml(canonicalize(schema, value), { indent: 2, lineWidth: 0 }),
  };
}
