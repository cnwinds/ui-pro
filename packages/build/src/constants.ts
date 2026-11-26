/**
 * Thresholds of the asset build. They are constants rather than options so that a build is
 * reproducible: the same inputs always make the same decisions about what is "close enough".
 */

/** Margin around an element's box taken into the working image, as a share of its larger side. */
export const CROP_MARGIN_RATIO = 0.1;
/** Bounds of that margin in source pixels, so tiny icons still see their surroundings. */
export const CROP_MARGIN_MIN = 3;
export const CROP_MARGIN_MAX = 24;

/** Share of the screen a node must cover, in both directions, to count as a full-bleed background. */
export const FULL_BLEED_RATIO = 0.98;

/** What the occluder's alpha is grown by to make the fill region, in source pixels (1–2). */
export const HOLE_GROW = 2;
/** The same for exclusion rectangles: they are exact, a pixel of slack is enough. */
export const EXCLUSION_GROW = 1;
/** Alpha at or above which a pixel counts as part of an element when masks are made. */
export const MASK_ALPHA = 16;
/** Alpha at or above which a pixel counts as inside when trimming transparent margins. */
export const TRIM_ALPHA = 1;
/** A hole this much covered by the fill region needs no separate text strip. */
export const STRIP_COVERED = 0.95;

/** Transparent pixels within this many pixels of an opaque one get its colour (no dark fringes). */
export const BLEED_RADIUS = 2;

/** Largest difference between two columns (or rows) still counted as the same, per channel. */
export const NINE_SLICE_TOLERANCE = 3;
/** A stretchable band narrower than this is not worth cutting out. */
export const NINE_SLICE_MIN_BAND = 4;
/** Width of the band left in the texture: the band is the same everywhere, two pixels are plenty. */
export const NINE_SLICE_KEEP = 2;
/** Structural similarity the stretched texture must reach against the original. */
export const NINE_SLICE_MIN_SSIM = 0.95;

/** Mean difference (0–255, four channels) below which two renders are the same picture. */
export const IDENTICAL_DIFF = 0.5;
/** Perceptual hash distance (of 64 bits) within which two instances may be the same artwork. */
export const PHASH_MAX_DISTANCE = 12;
/** Structural similarity above which near-identical instances may share the master's picture. */
export const NEAR_SSIM = 0.95;
/** Rects, file sizes and insets of instances that share a master may differ by this much. */
export const SHARE_SIZE_TOLERANCE = 0.04;
export const SHARE_INSET_TOLERANCE = 3;

/** Mean per-channel error (0–255) of a fitted multiply colour above which it is not used. */
export const TINT_MAX_ERROR = 6;
/** The fitted multiply colour is clamped to this range, a darker one is no tint but a new picture. */
export const TINT_MIN_FACTOR = 0.15;

/** Structural similarity of an upscale scaled back down below which detail was rewritten. */
export const UPSCALE_MIN_FIDELITY = 0.9;

/** Recipes of `state.source: derive`. */
export const PRESSED_BRIGHTNESS = 0.8;
export const HOVER_BRIGHTNESS = 1.08;
export const DISABLED_ALPHA = 0.6;

/** Fallback text size, as a share of the box height, when the strip could not measure one. */
export const TEXT_SIZE_RATIO = 0.8;

/** Asset sheet layout, in pixels. */
export const SHEET_COLUMNS = 6;
export const SHEET_CELL = 168;
export const SHEET_PAD = 12;
export const SHEET_LABEL_HEIGHT = 36;

/** Stamped into a new `ui-pro.lock`; the version of this package, which has no release yet. */
export const TOOL_VERSION = '0.0.0';
export const SHEET_CHECKER = 8;
