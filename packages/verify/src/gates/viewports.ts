import type { Viewport } from '@ui-pro/renderer';

/**
 * Target aspect ratios (width : height) for a portrait screen: 9:16 is the classic phone, 9:19.5
 * and 9:20 are the tall phones with a notch and a bottom bar, 3:4 is a tablet. A landscape screen
 * gets the reciprocals.
 */
export const PORTRAIT_RATIOS: readonly {
  label: string;
  width: number;
  height: number;
  notch: boolean;
}[] = [
  { label: '9:16', width: 9, height: 16, notch: false },
  { label: '9:19.5', width: 9, height: 19.5, notch: true },
  { label: '9:20', width: 9, height: 20, notch: true },
  { label: '3:4', width: 3, height: 4, notch: false },
];

/** Two ratios closer than this are the same screen (the design's own ratio is not repeated). */
const SAME_RATIO = 0.005;

/** Notch (or side cut-out) inset at a short side of 1080 design pixels: 132 px, about 44 pt at 3x. */
export const NOTCH_INSET = 132;

/** Bottom home-bar inset at a short side of 1080 design pixels: 63 px, about 21 pt at 3x. */
export const HOME_BAR_INSET = 63;

/** What the insets are stated for; other screens scale in proportion to their short side. */
export const INSET_REFERENCE_SIDE = 1080;

export interface ViewportCase {
  /** `9:19.5`, or `20:9` for landscape. */
  label: string;
  viewport: Viewport;
}

/**
 * The viewports the adaptation gate lays a screen out in. A target narrower than the design keeps
 * the design's width and grows taller; a wider one keeps the height and grows wider; this is what
 * Godot's `canvas_items` stretch with `expand` does. The design's own viewport is the baseline,
 * not a case.
 */
export function viewportMatrix(size: readonly [number, number]): ViewportCase[] {
  const [width, height] = size;
  const portrait = height >= width;
  const designRatio = width / height;
  const unit = Math.min(width, height) / INSET_REFERENCE_SIDE;
  const cases: ViewportCase[] = [];
  for (const entry of PORTRAIT_RATIOS) {
    const ratio = portrait ? entry.width / entry.height : entry.height / entry.width;
    if (Math.abs(ratio - designRatio) < SAME_RATIO) continue;
    const viewport: Viewport =
      ratio < designRatio
        ? { width, height: Math.round(width / ratio) }
        : { width: Math.round(height * ratio), height };
    if (entry.notch) {
      const notch = NOTCH_INSET * unit;
      const bar = HOME_BAR_INSET * unit;
      viewport.safeArea = portrait ? [0, notch, 0, bar] : [notch, 0, notch, bar];
    }
    cases.push({
      label: portrait ? entry.label : `${entry.height}:${entry.width}`,
      viewport,
    });
  }
  return cases;
}
