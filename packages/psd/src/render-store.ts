import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Rect, UiProError, writeFileAtomic } from '@ui-pro/core';
import { PsdErrorCodes } from './errors';
import { alphaExtent, cropImage, encodePng } from './image';
import type { PsdDocument } from './model';
import type { LayerRenderer, RenderStats, RenderUnit } from './renderer';

/** A unit's render cropped to the pixels that are not fully transparent. */
export interface StoredRender {
  id: number;
  /** Source pixels; `null` when the render is entirely transparent. */
  box: Rect | null;
  png: Buffer | null;
}

export interface RenderCache {
  /** Directory the cache lives in: `<dir>/<psd sha256>/<renderer>/<layer id>.{png,json}`. */
  dir: string;
  /** Store new renders; off for dry runs, which must not write anything. */
  write: boolean;
}

export interface RenderOutcome {
  stored: Map<number, StoredRender>;
  /** Units the renderer produced in this run; the others came from the cache. */
  rendered: number;
  cached: number;
  /** Absent when every unit came from the cache. */
  stats?: RenderStats;
}

function isBox(value: unknown): value is Rect {
  return Array.isArray(value) && value.length === 4 && value.every((n) => Number.isInteger(n));
}

async function readEntry(dir: string, id: number): Promise<StoredRender | undefined> {
  try {
    const meta: unknown = JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8'));
    const box = typeof meta === 'object' && meta !== null && 'box' in meta ? meta.box : undefined;
    if (box === null) return { id, box: null, png: null };
    if (!isBox(box)) return undefined;
    return { id, box, png: await readFile(join(dir, `${id}.png`)) };
  } catch {
    return undefined;
  }
}

/** The PNG goes first: an entry exists only once its `.json` does. */
async function writeEntry(dir: string, entry: StoredRender): Promise<void> {
  await mkdir(dir, { recursive: true });
  if (entry.png !== null) await writeFileAtomic(join(dir, `${entry.id}.png`), entry.png);
  await writeFileAtomic(join(dir, `${entry.id}.json`), JSON.stringify({ box: entry.box }));
}

/**
 * Gets every unit's render, from the cache when it has it and from `renderer` otherwise. A render
 * depends only on the PSD's bytes and the renderer, so the cache key is the PSD hash.
 */
export async function renderUnits(input: {
  document: PsdDocument;
  units: readonly RenderUnit[];
  renderer: LayerRenderer;
  cache?: RenderCache;
}): Promise<RenderOutcome> {
  const { document, units, renderer, cache } = input;
  const dir = cache === undefined ? undefined : join(cache.dir, document.sha256, renderer.name);
  const stored = new Map<number, StoredRender>();
  const missing: RenderUnit[] = [];
  for (const unit of units) {
    const entry = dir === undefined ? undefined : await readEntry(dir, unit.id);
    if (entry === undefined) missing.push(unit);
    else stored.set(unit.id, entry);
  }

  let stats: RenderStats | undefined;
  if (missing.length > 0) {
    stats = await renderer.render({
      document,
      units: missing,
      onRendered: async (unit, image) => {
        const box = alphaExtent(image);
        const png = box === null ? null : await encodePng(cropImage(image, box));
        const entry: StoredRender = { id: unit.id, box, png };
        stored.set(unit.id, entry);
        if (dir !== undefined && cache?.write) await writeEntry(dir, entry);
      },
    });
  }
  for (const unit of units) {
    if (!stored.has(unit.id)) {
      throw new UiProError(PsdErrorCodes.renderFailed, `渲染器没有返回图层 #${unit.id} 的图片`);
    }
  }
  return { stored, rendered: missing.length, cached: units.length - missing.length, stats };
}
