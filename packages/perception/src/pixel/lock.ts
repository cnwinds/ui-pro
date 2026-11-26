import { UiProError } from '@ui-pro/core';
import { PerceptionErrorCodes } from '../errors';
import { MODEL_CATALOG } from '../models/catalog';
import { decodeBytes, sha256Hex } from './raster';
import type { ModelName, PixelContext, RequestLabel, RgbaImage } from './types';

type Primitive = string | number | boolean | null | undefined;
type Params = { [key: string]: Primitive | Primitive[] | Params };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The key a model output is locked under: a hash of the operation, the model, the parameters and
 * the pixels (with their sizes) that go in. The same request is the same key on every machine.
 */
export function requestKey(
  operation: string,
  model: string,
  params: Params,
  inputs: readonly { width: number; height: number; data: Uint8Array }[],
): string {
  const header = canonical({
    version: 1,
    operation,
    model,
    params,
    inputs: inputs.map(({ width, height }) => [width, height]),
  });
  return sha256Hex(new TextEncoder().encode(header), ...inputs.map((input) => input.data));
}

/** Model identity for the key of a local model: its name and the start of its file hash. */
export function localModelId(name: ModelName): string {
  return `local:${name}@${MODEL_CATALOG[name].sha256.slice(0, 12)}`;
}

/** The `by` field of a locked output made by a local model. */
export const lockedByLocal = (name: ModelName) => `local:${name}`;

/** The method name a locked output stands for: `local:lama` -> `lama`, `cloud:a/b` -> `a/b`. */
export function methodOfLock(by: string): string {
  return by.replace(/^(local|cloud):/, '');
}

export const tierOfLock = (by: string): 'local' | 'cloud' =>
  by.startsWith('cloud:') ? 'cloud' : 'local';

/** `E_NOT_LOCKED`: `build --locked` reached a model call whose output is not locked. */
export function notLockedError(label: RequestLabel, what: string): UiProError {
  return new UiProError(
    PerceptionErrorCodes.notLocked,
    `界面 ${label.screen} 的节点 ${label.node}：${what}需要调用模型，但没有锁定的输出，而当前要求只使用已锁定的输出`,
    {
      hint: '去掉 --locked 重新构建一次，让模型输出锁定下来，再提交锁文件和 gen/ 里的文件',
      details: { screen: label.screen, node: label.node, step: what },
    },
  );
}

/**
 * A locked output read back as an image of the expected size, or undefined when none is locked
 * (or the locked file is not a picture of that size, which a changed request could not produce).
 */
export async function readLocked(
  context: PixelContext,
  key: string,
  expected: { width: number; height: number },
): Promise<{ image: RgbaImage; by: string } | undefined> {
  const hit = await context.store.get(key);
  if (!hit) return undefined;
  try {
    const image = await decodeBytes(hit.png);
    if (image.width !== expected.width || image.height !== expected.height) return undefined;
    return { image, by: hit.by };
  } catch {
    return undefined;
  }
}
