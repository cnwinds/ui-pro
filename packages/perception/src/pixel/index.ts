import { ErrorCodes, type ImageModelConfig, UiProError } from '@ui-pro/core';
import type { CloudImageModel, ModelStore, PixelContext, PixelOps } from './types';

const notYet = (what: string) =>
  new UiProError(ErrorCodes.notImplemented, `${what}尚未实现（第 3 批工单 07）`);

/** The pixel steps of the asset build, over local models and the optional cloud image model. */
export function createPixelOps(_context: PixelContext): PixelOps {
  throw notYet('像素能力');
}

export interface ModelStoreOptions {
  /** Cache directory; defaults to `%LOCALAPPDATA%\ui-pro\models` (or `~/.cache/ui-pro/models`). */
  dir?: string;
  onProgress?: (message: string) => void;
}

/** Local model files shared by every project on the machine. */
export function createModelStore(_options: ModelStoreOptions = {}): ModelStore {
  throw notYet('本地模型下载');
}

/**
 * The cloud image model the project config names, or `null` when the provider is `none` or its
 * key is missing from `env` (`DASHSCOPE_API_KEY`). Keys are never read from project files.
 */
export function createCloudImageModel(
  _config: ImageModelConfig,
  _env: NodeJS.ProcessEnv = process.env,
): CloudImageModel | null {
  throw notYet('云端图像模型');
}
