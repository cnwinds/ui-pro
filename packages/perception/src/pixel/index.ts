import type { ImageModelConfig } from '@ui-pro/core';
import { createDashScopeModel, DASHSCOPE_KEY_VARIABLE, type DashScopeOptions } from './dashscope';
import type { CloudImageModel } from './types';

export type { ModelStoreOptions } from '../models/store';
export { createModelStore } from '../models/store';
export type { DashScopeOptions } from './dashscope';
export type { PixelOpsOptions } from './ops';
export { createPixelOps } from './ops';
export type { ModelRunner } from './runner';

/**
 * The cloud image model the project config names, or `null` when the provider is `none` or its
 * key is missing from `env` (`DASHSCOPE_API_KEY`). Keys are never read from project files.
 * `options` is for tests: a fake `fetch`, no waiting between polls.
 */
export function createCloudImageModel(
  config: ImageModelConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: DashScopeOptions = {},
): CloudImageModel | null {
  if (config.provider !== 'dashscope') return null;
  const key = env[DASHSCOPE_KEY_VARIABLE]?.trim();
  if (!key) return null;
  return createDashScopeModel(key, config.endpoint, options);
}
