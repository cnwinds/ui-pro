import { type Project, scratchPath, UiProError } from '@ui-pro/core';
import { PsdErrorCodes } from './errors';
import { PhotopeaRenderer } from './photopea';
import type { LayerRenderer } from './renderer';

export interface RendererContext {
  project?: Project;
  /** Directory whose `.ui-pro/` holds scratch data such as the browser profile. */
  scratchRoot: string;
}

export type RendererFactory = (context: RendererContext) => LayerRenderer;

let override: RendererFactory | undefined;

/**
 * Replaces the renderer `analyzePsdScreen` and `ui-pro psd lint` use, which is Photopea by
 * default. A test seam: `analyzePsdScreen`'s signature leaves no room to pass a renderer.
 */
export function setRendererFactory(factory: RendererFactory | undefined): void {
  override = factory;
}

export function createRenderer(context: RendererContext): LayerRenderer {
  if (override !== undefined) return override(context);
  return new PhotopeaRenderer({ profileDir: scratchPath(context.scratchRoot, 'photopea-profile') });
}

/** Refuses a renderer that needs the network when the project keeps data local. */
export function assertEgressAllows(renderer: LayerRenderer, project?: Project): void {
  if (project?.config.egress !== 'local' || !renderer.capabilities.network) return;
  throw new UiProError(
    PsdErrorCodes.egress,
    '项目的外发档位是 local，不使用在线版 Photopea：它需要联网，是否会上传数据尚未抓包确认',
    {
      hint: '把 ui-pro.yaml 里的 egress 改成 hybrid 或 cloud 后重试；或者改交交付包（由 Photoshop 渲染，暂未支持）',
    },
  );
}
