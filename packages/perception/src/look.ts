import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  type Candidate,
  loadScreen,
  type Project,
  preOrder,
  projectSelectorEnv,
  type Rect,
  readCandidates,
  referenceImagePath,
  resolveInside,
  resolveSelector,
  roundRect,
  type ScreenDoc,
  scratchPath,
  sourceToDesign,
  toPosix,
  UiProError,
} from '@ui-pro/core';
import sharp from 'sharp';
import { PerceptionErrorCodes } from './errors';
import { clipToImage, intersectionArea, unionBox } from './geometry';
import { LABEL_HEIGHT, placeLabels } from './labels';

export interface LookOptions {
  /** Draw the draft's nodes; default true. */
  nodes?: boolean;
  /** Draw the candidates; default true. */
  candidates?: boolean;
  /** Enlargement of the picture; chosen to fit when absent. */
  zoom?: number;
  /** Add zoomed pictures of dense areas to the overview; default true. */
  zones?: boolean;
}

/** One framed thing in a look picture: what its label stands for and where it is. */
export interface LookEntry {
  label: string;
  /** Node id, or candidate id such as `cand#47`. */
  id: string;
  kind: 'node' | 'candidate';
  /** Where a candidate came from (`cv`, `ocr`, `layer`, …); absent for nodes. */
  source?: string;
  /** Source-image pixels. */
  bbox: Rect;
  /** Design pixels. */
  design: Rect;
}

export interface LookImage {
  /** Absolute path, forward slashes. */
  path: string;
  kind: 'overview' | 'zone' | 'target';
  /** The part of the source image shown, in source pixels. */
  region: Rect;
  zoom: number;
  /** Labels drawn in the picture, as keys of the result's legend. */
  labels: string[];
}

export interface LookResult {
  images: LookImage[];
  /** Label -> what it stands for, for every label in any of the images. */
  legend: Record<string, LookEntry>;
}

const OVERVIEW_TARGET_SIDE = 1800;
const TARGET_SIDE = 900;
const MAX_ZOOM = 12;
const DENSE_BOXES = 30;
const ZONE_MIN_SIDE = 260;
const ZONE_OVERLAP = 24;
const MAX_ZONES = 12;
const MIN_ZONE_BOXES = 3;
const TARGET_MARGIN = 24;

const COLORS = {
  node: '#00b341',
  cv: '#ff6a00',
  ocr: '#1e6bff',
  layer: '#b000e0',
  other: '#e0007a',
  target: '#ff1744',
} as const;

function colorOf(entry: LookEntry): string {
  if (entry.kind === 'node') return COLORS.node;
  if (entry.source === 'cv' || entry.source === 'seg') return COLORS.cv;
  if (entry.source === 'ocr') return COLORS.ocr;
  if (entry.source === 'layer') return COLORS.layer;
  return COLORS.other;
}

/** `cand#47` is drawn as `47`, `layer#12` as `L12`; node ids stay as they are. */
export function labelFor(id: string): string {
  const [prefix, number] = id.split('#');
  if (number === undefined) return id;
  return prefix === 'cand' ? number : `${prefix === 'layer' ? 'L' : (prefix ?? '')}${number}`;
}

interface Scene {
  doc: ScreenDoc;
  base: Buffer;
  width: number;
  height: number;
  entries: LookEntry[];
}

function candidateEntry(candidate: Candidate, scale: number): LookEntry {
  return {
    label: labelFor(candidate.id),
    id: candidate.id,
    kind: 'candidate',
    source: candidate.source,
    bbox: roundRect(candidate.bbox),
    design: roundRect(sourceToDesign(candidate.bbox, scale)),
  };
}

async function loadScene(project: Project, screen: string, options: LookOptions): Promise<Scene> {
  const doc = loadScreen(project, screen);
  const path = resolveInside(project.root, referenceImagePath(doc));
  let base: Buffer;
  try {
    base = await readFile(path);
  } catch (cause) {
    throw new UiProError(
      PerceptionErrorCodes.referenceMissing,
      `读不到界面 ${screen} 的基准图：${toPosix(path)}`,
      {
        hint: 'PSD 界面需要先 ui-pro analyze 才有基准图；图片界面请检查源文件是否还在',
        details: { cause: cause instanceof Error ? cause.message : String(cause) },
      },
    );
  }
  const meta = await sharp(base).metadata();
  const entries: LookEntry[] = [];
  if (options.nodes !== false) {
    for (const id of preOrder(doc)) {
      const node = doc.nodes[id];
      if (!node || id === doc.root) continue;
      const [x, y, w, h] = node.rect;
      entries.push({
        label: id,
        id,
        kind: 'node',
        bbox: roundRect([x / doc.scale, y / doc.scale, w / doc.scale, h / doc.scale]),
        design: roundRect(node.rect),
      });
    }
  }
  if (options.candidates !== false) {
    for (const candidate of readCandidates(project, screen)?.candidates ?? []) {
      entries.push(candidateEntry(candidate, doc.scale));
    }
  }
  return {
    doc,
    base,
    width: meta.width ?? doc.source.width,
    height: meta.height ?? doc.source.height,
    entries,
  };
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface Drawn {
  entry: LookEntry;
  /** Frame in output pixels. */
  box: Rect;
  highlighted: boolean;
}

function overlay(size: readonly [number, number], drawn: readonly Drawn[]): string {
  const placements = placeLabels(
    drawn.map((item) => ({ label: item.entry.label, box: item.box })),
    size,
  );
  const frames: string[] = [];
  const labels: string[] = [];
  drawn.forEach((item, index) => {
    const [x, y, w, h] = item.box;
    const color = item.highlighted ? COLORS.target : colorOf(item.entry);
    const stroke = item.highlighted ? 3 : 1.6;
    frames.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#fff" stroke-opacity="0.85" stroke-width="${stroke + 2.4}"/>`,
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${color}" stroke-width="${stroke}"/>`,
    );
    const placement = placements[index];
    if (!placement) return;
    const [lx, ly, lw] = placement.rect;
    if (placement.detached) {
      labels.push(
        `<line x1="${lx + lw / 2}" y1="${ly + LABEL_HEIGHT / 2}" x2="${x + w / 2}" y2="${y + h / 2}" stroke="${color}" stroke-width="1" stroke-dasharray="3 2"/>`,
      );
    }
    labels.push(
      `<rect x="${lx}" y="${ly}" width="${lw}" height="${LABEL_HEIGHT}" rx="2" fill="${color}" stroke="#fff" stroke-width="1"/>`,
      `<text x="${lx + 3}" y="${ly + LABEL_HEIGHT - 3.5}" font-family="Arial, Helvetica, sans-serif" font-size="12" font-weight="bold" fill="#fff">${escapeXml(item.entry.label)}</text>`,
    );
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size[0]}" height="${size[1]}">${frames.join('')}${labels.join('')}</svg>`;
}

/** Cuts `region` out of the source picture, enlarges it, and frames the entries inside it. */
async function renderRegion(
  scene: Scene,
  region: Rect,
  zoom: number,
  highlighted: ReadonlySet<string>,
): Promise<{ png: Buffer; shown: LookEntry[] }> {
  const [left, top, width, height] = region;
  const size: [number, number] = [Math.round(width * zoom), Math.round(height * zoom)];
  const shown = scene.entries.filter((entry) => intersectionArea(entry.bbox, region) > 0);
  const drawn: Drawn[] = shown.map((entry) => {
    const [x, y, w, h] = entry.bbox;
    const x0 = Math.max(0, (x - left) * zoom);
    const y0 = Math.max(0, (y - top) * zoom);
    const x1 = Math.min(size[0], (x + w - left) * zoom);
    const y1 = Math.min(size[1], (y + h - top) * zoom);
    return {
      entry,
      box: [x0, y0, x1 - x0, y1 - y0] as Rect,
      highlighted: highlighted.has(entry.label),
    };
  });
  // Frames of the targets are drawn last so that nothing hides them.
  drawn.sort((a, b) => Number(a.highlighted) - Number(b.highlighted));
  const png = await sharp(scene.base)
    .flatten({ background: '#ffffff' })
    .extract({ left, top, width, height })
    .resize(size[0], size[1], { kernel: 'lanczos3' })
    .composite([{ input: Buffer.from(overlay(size, drawn)) }])
    .png()
    .toBuffer();
  return { png, shown: drawn.map((item) => item.entry) };
}

async function writeLook(project: Project, name: string, png: Buffer): Promise<string> {
  const dir = scratchPath(project.root, 'look');
  await mkdir(dir, { recursive: true });
  const path = scratchPath(project.root, 'look', name);
  await writeFile(path, png);
  return toPosix(path);
}

function fitZoom(side: number, wanted: number): number {
  return Math.min(MAX_ZOOM, Math.max(1, Math.round(wanted / side)));
}

function checkZoom(zoom: number | undefined): void {
  if (zoom !== undefined && !(zoom > 0 && zoom <= MAX_ZOOM)) {
    throw new UiProError(PerceptionErrorCodes.lookTarget, `放大倍数 ${zoom} 不可用`, {
      hint: `放大倍数要大于 0、不超过 ${MAX_ZOOM}`,
    });
  }
}

/** Zones that cover the picture, a few per axis, each overlapping its neighbours a little. */
export function planZones(width: number, height: number): Rect[] {
  const side = Math.max(ZONE_MIN_SIDE, Math.sqrt((width * height) / (MAX_ZONES - 2)));
  const columns = Math.max(1, Math.round(width / side));
  const rows = Math.max(1, Math.round(height / side));
  const zones: Rect[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x0 = (column * width) / columns;
      const x1 = ((column + 1) * width) / columns;
      const y0 = (row * height) / rows;
      const y1 = ((row + 1) * height) / rows;
      zones.push(
        clipToImage(
          [
            x0 - ZONE_OVERLAP / 2,
            y0 - ZONE_OVERLAP / 2,
            x1 - x0 + ZONE_OVERLAP,
            y1 - y0 + ZONE_OVERLAP,
          ],
          width,
          height,
        ),
      );
    }
  }
  return zones;
}

function collect(result: LookResult, image: LookImage, shown: readonly LookEntry[]): void {
  result.images.push(image);
  for (const entry of shown) result.legend[entry.label] = entry;
}

/**
 * The whole screen with frames and labels, plus zoomed pictures of its busy parts when there are
 * many frames: small things such as a red dot are only visible in those.
 */
export async function lookOverview(
  project: Project,
  screen: string,
  options: LookOptions = {},
): Promise<LookResult> {
  checkZoom(options.zoom);
  const scene = await loadScene(project, screen, options);
  const result: LookResult = { images: [], legend: {} };
  const whole: Rect = [0, 0, scene.width, scene.height];
  const zoom = options.zoom ?? fitZoom(Math.max(scene.width, scene.height), OVERVIEW_TARGET_SIDE);
  const overview = await renderRegion(scene, whole, zoom, new Set());
  const overviewPath = await writeLook(project, `${screen}-overview.png`, overview.png);
  collect(
    result,
    {
      path: overviewPath,
      kind: 'overview',
      region: whole,
      zoom,
      labels: overview.shown.map((entry) => entry.label),
    },
    overview.shown,
  );

  if (options.zones === false || scene.entries.length < DENSE_BOXES) return result;
  let index = 0;
  for (const zone of planZones(scene.width, scene.height)) {
    const inside = scene.entries.filter((entry) => intersectionArea(entry.bbox, zone) > 0);
    if (inside.length < MIN_ZONE_BOXES) continue;
    index++;
    const zoneZoom = options.zoom ?? fitZoom(Math.max(zone[2], zone[3]), TARGET_SIDE);
    const rendered = await renderRegion(scene, zone, zoneZoom, new Set());
    const path = await writeLook(project, `${screen}-zone-${index}.png`, rendered.png);
    collect(
      result,
      {
        path,
        kind: 'zone',
        region: zone,
        zoom: zoneZoom,
        labels: rendered.shown.map((entry) => entry.label),
      },
      rendered.shown,
    );
  }
  return result;
}

const CANDIDATE_TARGET = /^(cand|layer)#\d+$/;

function targetEntries(
  project: Project,
  scene: Scene,
  screen: string,
  target: string,
): LookEntry[] {
  if (CANDIDATE_TARGET.test(target)) {
    const doc = readCandidates(project, screen);
    if (doc === null) {
      throw new UiProError(
        PerceptionErrorCodes.lookNoEvidence,
        `界面 ${screen} 还没有候选，看不了 ${target}`,
        { hint: '先运行 ui-pro analyze' },
      );
    }
    const candidate = doc.candidates.find((item) => item.id === target);
    if (!candidate) {
      throw new UiProError(
        PerceptionErrorCodes.lookTarget,
        `界面 ${screen} 没有候选 ${target}（共 ${doc.candidates.length} 个）`,
        { hint: '用 ui-pro look 看概览，图上的编号就是候选编号' },
      );
    }
    return [candidateEntry(candidate, scene.doc.scale)];
  }
  const refs = resolveSelector(target, projectSelectorEnv(project, screen)).filter(
    (ref) => ref.screen === screen,
  );
  const found = refs
    .map((ref) => scene.doc.nodes[ref.id])
    .filter((node) => node !== undefined)
    .map((node) => {
      const [x, y, w, h] = node.rect;
      const entry: LookEntry = {
        label: node.id,
        id: node.id,
        kind: 'node',
        bbox: roundRect([
          x / scene.doc.scale,
          y / scene.doc.scale,
          w / scene.doc.scale,
          h / scene.doc.scale,
        ]),
        design: roundRect(node.rect),
      };
      return entry;
    });
  if (found.length === 0) {
    throw new UiProError(PerceptionErrorCodes.lookTarget, `选择器没有匹配到节点：${target}`, {
      hint: '选择器形如 #node_id、text[text=攻击]；候选用 cand#<编号>',
    });
  }
  return found;
}

/**
 * A zoomed picture of the target (a selector's nodes, or `cand#<n>`) with surrounding context;
 * the other frames in view are drawn too, the target's in red.
 */
export async function lookTarget(
  project: Project,
  screen: string,
  target: string,
  options: LookOptions = {},
): Promise<LookResult> {
  checkZoom(options.zoom);
  const scene = await loadScene(project, screen, options);
  const targets = targetEntries(project, scene, screen, target);
  const framed = unionBox(targets.map((entry) => entry.bbox));
  const margin = Math.max(TARGET_MARGIN, Math.round(Math.max(framed[2], framed[3]) * 0.5));
  const region = clipToImage(
    [framed[0] - margin, framed[1] - margin, framed[2] + 2 * margin, framed[3] + 2 * margin],
    scene.width,
    scene.height,
  );
  if (region[2] === 0 || region[3] === 0) {
    throw new UiProError(PerceptionErrorCodes.lookTarget, `目标 ${target} 在图片范围之外`);
  }
  for (const entry of targets) {
    if (!scene.entries.some((other) => other.id === entry.id && other.kind === entry.kind)) {
      scene.entries.push(entry);
    }
  }
  const zoom = options.zoom ?? fitZoom(Math.max(region[2], region[3]), TARGET_SIDE);
  const highlighted = new Set(targets.map((entry) => entry.label));
  const rendered = await renderRegion(scene, region, zoom, highlighted);
  const name =
    targets.length === 1
      ? `${screen}-view-${targets[0]?.label}.png`
      : `${screen}-view-${createHash('sha1').update(target).digest('hex').slice(0, 8)}.png`;
  const path = await writeLook(project, name, rendered.png);
  const result: LookResult = { images: [], legend: {} };
  collect(
    result,
    { path, kind: 'target', region, zoom, labels: rendered.shown.map((entry) => entry.label) },
    rendered.shown,
  );
  return result;
}
