import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  builtinOps,
  createCoreRegistry,
  defineOp,
  describeOps,
  ErrorCodes,
  getOp,
  listOps,
  opJsonSchema,
  registerOp,
  suggestOps,
} from '../src';
import { failureOfSync } from './helpers';

describe('error codes', () => {
  it('are unique, E_-prefixed strings', () => {
    const codes = Object.values(ErrorCodes);

    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^E_[A-Z_]+$/);
  });
});

describe('op catalogue', () => {
  it('lists every built-in op with its family and a Chinese summary', () => {
    const ops = describeOps(createCoreRegistry());

    expect(ops.map((op) => op.name)).toEqual([
      'node.add',
      'node.set',
      'node.split',
      'node.merge',
      'node.move',
      'node.remove',
      'node.rename',
      'concept.define',
      'component.extract',
      'pin.set',
      'pin.clear',
      'layout.set',
      'state.set',
      'bind.set',
    ]);
    expect(ops.map((op) => op.name)).toEqual(builtinOps.map((op) => op.name));
    for (const op of ops) {
      expect(op.summary, op.name).toMatch(/[\u4e00-\u9fff]/);
      expect(['structure', 'measure', 'rules', 'presentation']).toContain(op.family);
    }
  });

  it('describes each op input as JSON Schema', () => {
    const registry = createCoreRegistry();

    for (const { name } of describeOps(registry)) {
      const schema = opJsonSchema(registry, name);
      const properties = schema.properties as Record<string, { const?: string }>;

      expect(schema.type, name).toBe('object');
      expect(properties.op?.const, name).toBe(name);
      expect(() => JSON.stringify(schema), name).not.toThrow();
    }
  });

  it('marks the required fields and forbids unknown ones', () => {
    const schema = opJsonSchema(createCoreRegistry(), 'node.rename');

    expect(schema.required).toEqual(['op', 'target', 'id']);
    expect(schema.additionalProperties).toBe(false);
  });

  it('rejects an unknown op, suggesting the ops of the same family', () => {
    const registry = createCoreRegistry();

    const error = failureOfSync(() => opJsonSchema(registry, 'node.explode'));

    expect(error.code).toBe(ErrorCodes.opUnknown);
    expect(error.hint).toContain('node.add');
    expect(error.hint).not.toContain('pin.set');
    expect(suggestOps(registry, 'bogus')).toHaveLength(builtinOps.length);
  });
});

describe('the default registry', () => {
  it('accepts ops from other packages', () => {
    const op = defineOp({
      name: 'test.global',
      family: 'rules',
      summary: '测试用操作',
      schema: z.strictObject({ op: z.literal('test.global') }),
      apply() {},
    });

    registerOp(op);
    registerOp(op);

    expect(getOp('test.global')).toBe(op);
    expect(listOps().map((candidate) => candidate.name)).toContain('test.global');
    expect(getOp('test.absent')).toBeUndefined();
  });
});
