import { composeSheet, type SheetCell } from '@ui-pro/renderer';
import { cropRaster, growBox, type PixelBox, type Raster } from './raster';

/** Largest magnification of a crop: past this the pixels are just big squares. */
const MAX_ZOOM = 8;

/** A crop is magnified until its longer side is about this many pixels. */
const ZOOM_TARGET = 220;

/** Whole-number magnification that brings a crop to a size worth looking at. */
export function zoomFor(box: PixelBox): number {
  const longest = Math.max(box[2] - box[0], box[3] - box[1]);
  return Math.max(1, Math.min(MAX_ZOOM, Math.floor(ZOOM_TARGET / Math.max(1, longest))));
}

/** The box with some surroundings, so a problem is seen in its place. */
export function framed(box: PixelBox, raster: Raster, margin = 8): PixelBox {
  return growBox(box, margin, raster.width, raster.height);
}

/** A labelled strip of crops of the same box from several images, magnified together. */
export function compareSheet(
  box: PixelBox,
  images: readonly { label: string; raster: Raster }[],
  backdrop?: string,
): Uint8Array {
  const zoom = zoomFor(box);
  const cells: SheetCell[] = images.map(({ label, raster }) => ({
    label,
    image: cropRaster(raster, box),
    zoom,
    ...(backdrop ? { backdrop } : {}),
  }));
  return composeSheet(cells).png;
}

/**
 * The reference dimmed to grey with the difference painted over it: nothing where the colours
 * agree, blue for a small difference through to red for ΔE2000 of `FULL_SCALE` and more.
 */
const FULL_SCALE = 15;
const NOTICEABLE = 1;

export function heatRaster(reference: Raster, deltaE: Float32Array): Raster {
  const out = new Uint8Array(reference.data.length);
  for (let i = 0; i < deltaE.length; i++) {
    const at = i * 4;
    const gray =
      0.299 * (reference.data[at] ?? 0) +
      0.587 * (reference.data[at + 1] ?? 0) +
      0.114 * (reference.data[at + 2] ?? 0);
    const base = 40 + gray * 0.45;
    const value = Math.max(
      0,
      Math.min(1, ((deltaE[i] ?? 0) - NOTICEABLE) / (FULL_SCALE - NOTICEABLE)),
    );
    if (value === 0) {
      out[at] = out[at + 1] = out[at + 2] = base;
    } else {
      // Blue (small) to red (large), more opaque as it grows.
      const hue = (1 - value) * 240;
      const [r, g, b] = hsvToRgb(hue, 1, 1);
      const opacity = 0.4 + 0.6 * value;
      out[at] = base * (1 - opacity) + r * opacity;
      out[at + 1] = base * (1 - opacity) + g * opacity;
      out[at + 2] = base * (1 - opacity) + b * opacity;
    }
    out[at + 3] = 255;
  }
  return { width: reference.width, height: reference.height, data: out };
}

function hsvToRgb(hue: number, saturation: number, value: number): [number, number, number] {
  const c = value * saturation;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = value - c;
  const [r, g, b] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : [x, 0, c];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
