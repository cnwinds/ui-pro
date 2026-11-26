import {
  type AssetManifest,
  ErrorCodes,
  type Project,
  type Rect,
  type ScreenDoc,
  UiProError,
} from '@ui-pro/core';
import type { DrawList, RenderOptions, RenderSession, Viewport } from './types';

export type * from './types';

const notYet = (what: string) =>
  new UiProError(ErrorCodes.notImplemented, `${what}尚未实现（第 3 批工单 08）`);

/**
 * Lays the screen out in `viewport` from each node's `rect` and `anchor` (relative to its
 * parent), with the same semantics as the Godot adapter's anchors. Design pixels.
 */
export function layoutScreen(_doc: ScreenDoc, _viewport: Viewport): Map<string, Rect> {
  throw notYet('布局');
}

/** The frame's draw list: pure, no I/O, so Studio can build the same list in the browser. */
export function buildDrawList(
  _doc: ScreenDoc,
  _manifest: AssetManifest | null,
  _fonts: Readonly<Record<string, string>>,
  _options: RenderOptions & { mock: unknown },
): DrawList {
  throw notYet('绘制清单');
}

/** Loads the screen's assets and fonts, ready to render frames with the reference renderer. */
export async function openRenderSession(
  _project: Project,
  _screen: string,
): Promise<RenderSession> {
  throw notYet('参考渲染器');
}
