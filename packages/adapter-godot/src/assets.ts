import type { ScreenDoc, UINode } from '@ui-pro/core';
import sharp from 'sharp';
import { wantsAsset } from './plan';

export interface ExportAsset {
  /** PNG at design resolution: one texel per design pixel of the node's box. */
  png: Uint8Array;
  /** The pixels are a stand-in, not an asset built for the node. */
  approximate?: boolean;
}

/** Where the export gets a node's texture; `undefined` means the node has none. */
export type AssetSource = (
  node: UINode,
) => Promise<ExportAsset | undefined> | ExportAsset | undefined;

/**
 * Stand-in assets: the node's box cut out of the reference image and scaled to design pixels.
 * A parent's crop also holds its children's pixels; they sit where the children draw, so the
 * scene still looks like the reference.
 */
export async function referenceCropSource(
  doc: ScreenDoc,
  reference: Uint8Array,
): Promise<AssetSource> {
  const { data, info } = await sharp(reference)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return async (node) => {
    if (!wantsAsset(node)) return undefined;
    const [x, y, w, h] = node.rect;
    const left = Math.max(0, Math.floor(x / doc.scale));
    const top = Math.max(0, Math.floor(y / doc.scale));
    const right = Math.min(info.width, Math.ceil((x + w) / doc.scale));
    const bottom = Math.min(info.height, Math.ceil((y + h) / doc.scale));
    if (right <= left || bottom <= top) return undefined;
    const png = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
      .extract({ left, top, width: right - left, height: bottom - top })
      .resize(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), { fit: 'fill' })
      .png()
      .toBuffer();
    return { png, approximate: true };
  };
}
