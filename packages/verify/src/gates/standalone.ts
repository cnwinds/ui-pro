import { composeSheet, type SheetCell } from '@ui-pro/renderer';
import { deltaERgb } from '../color';
import type { GateContext } from '../context';
import { type Raster, resizeRaster } from '../raster';
import type { GateProblem } from '../types';
import { type GateRun, gateResult, listNodes, round } from './types';

/** Alpha from which a pixel is body, and below which it is air (the engine's usual cut-off). */
export const SOLID_ALPHA = 128;

/** A pixel this opaque no longer carries a fringe: its colour is the asset's own. */
const OPAQUE_ALPHA = 248;

/** Edge pixels fainter than this are not seen on any ground, whatever their colour. */
export const FRINGE_ALPHA_MIN = 16;

/**
 * Fringe: ΔE2000 between an edge pixel's colour and the average of the solid pixels next to it. An
 * antialiased edge keeps its object's colour (ΔE under 10, from shading); one cut from another
 * background keeps that background's colour, which is 40 or more away for a white halo round a
 * dark shape. 25 sits between the two with room.
 */
export const FRINGE_DELTA_E = 25;

/** Fringe: the share of edge pixels with the wrong colour that makes the edge visibly dirty. */
export const FRINGE_RATIO = 0.25;

/** Fringe: fewest wrong-coloured edge pixels worth reporting; fewer is rounding noise on tiny icons. */
export const FRINGE_MIN_PIXELS = 12;

/** Residue: a stray piece touching the file's edge, at least this many pixels (a 2 x 3 speck is noise). */
export const RESIDUE_MIN_PIXELS = 6;

/** Residue: pieces up to this share of the main body's area are strays; bigger ones are parts. */
export const RESIDUE_MAX_SHARE = 0.3;

/** Alpha holes: the smallest transparent pocket inside the body worth a look (a single pixel is antialiasing). */
export const HOLE_MIN_PIXELS = 2;

/** Alpha holes: the biggest pocket still counted as a mistake; larger ones are shapes (a ring, a frame). */
export const HOLE_MAX_PIXELS = 48;

/** Alpha holes: and no more than this share of the body, so a small icon's counter is not a hole. */
export const HOLE_MAX_SHARE = 0.01;

/** Assets shown in the picture besides the failing ones. */
const SHEET_EXTRA_ASSETS = 12;

/** Longest side of an asset in the picture; bigger ones are shrunk to fit. */
const SHEET_ASSET_SIDE = 200;

const DARK = '#1b1b24';
const LIGHT = '#f2f2f2';

/** Largest asset the checks scan; the rest are too big for this kind of defect to hide in. */
const MAX_SCAN_PIXELS = 4_000_000;

interface Finding {
  fringe?: { count: number; wrong: number };
  residue?: { count: number; area: number };
  holes?: { count: number; area: number };
}

function alphaAt(raster: Raster, x: number, y: number): number {
  return raster.data[(y * raster.width + x) * 4 + 3] ?? 0;
}

/**
 * Edge pixels (translucent, not faint) whose colour is not the colour of the body beside them.
 */
function findFringe(raster: Raster): Finding['fringe'] {
  const { width, height, data } = raster;
  let edge = 0;
  let wrong = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const alpha = data[at + 3] ?? 0;
      if (alpha < FRINGE_ALPHA_MIN || alpha >= OPAQUE_ALPHA) continue;
      // Average the solid pixels in the nearest ring that has any, 1 to 3 pixels out.
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let radius = 1; radius <= 3 && n === 0; radius++) {
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const other = (ny * width + nx) * 4;
            if ((data[other + 3] ?? 0) < OPAQUE_ALPHA) continue;
            r += data[other] ?? 0;
            g += data[other + 1] ?? 0;
            b += data[other + 2] ?? 0;
            n++;
          }
        }
      }
      if (n === 0) continue;
      edge++;
      const gap = deltaERgb(
        data[at] ?? 0,
        data[at + 1] ?? 0,
        data[at + 2] ?? 0,
        Math.round(r / n),
        Math.round(g / n),
        Math.round(b / n),
      );
      if (gap > FRINGE_DELTA_E) wrong++;
    }
  }
  return wrong >= FRINGE_MIN_PIXELS && wrong / edge >= FRINGE_RATIO
    ? { count: edge, wrong }
    : undefined;
}

/** Labels connected regions of pixels for which `inside` holds; returns each one's size and whether it touches the border. */
function components(
  raster: Raster,
  inside: (x: number, y: number) => boolean,
  eight: boolean,
): { area: number; border: boolean }[] {
  const { width, height } = raster;
  const seen = new Uint8Array(width * height);
  const found: { area: number; border: boolean }[] = [];
  const stack: number[] = [];
  const steps = eight
    ? [-1, -1, 0, -1, 1, -1, -1, 0, 1, 0, -1, 1, 0, 1, 1, 1]
    : [0, -1, -1, 0, 1, 0, 0, 1];
  for (let start = 0; start < width * height; start++) {
    if (seen[start] || !inside(start % width, Math.floor(start / width))) continue;
    let area = 0;
    let border = false;
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const at = stack.pop() as number;
      const x = at % width;
      const y = (at - x) / width;
      area++;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) border = true;
      for (let i = 0; i < steps.length; i += 2) {
        const nx = x + (steps[i] ?? 0);
        const ny = y + (steps[i + 1] ?? 0);
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (seen[next] || !inside(nx, ny)) continue;
        seen[next] = 1;
        stack.push(next);
      }
    }
    found.push({ area, border });
  }
  return found;
}

function analyze(raster: Raster): Finding {
  const finding: Finding = {};
  const fringe = findFringe(raster);
  if (fringe) finding.fringe = fringe;

  const bodies = components(raster, (x, y) => alphaAt(raster, x, y) >= SOLID_ALPHA, true);
  const largest = Math.max(0, ...bodies.map((body) => body.area));
  const strays = bodies.filter(
    (body) =>
      body.border &&
      body.area >= RESIDUE_MIN_PIXELS &&
      body.area < largest * RESIDUE_MAX_SHARE &&
      body.area !== largest,
  );
  if (strays.length > 0) {
    finding.residue = { count: strays.length, area: strays.reduce((sum, s) => sum + s.area, 0) };
  }

  const body = bodies.reduce((sum, piece) => sum + piece.area, 0);
  const pockets = components(raster, (x, y) => alphaAt(raster, x, y) < SOLID_ALPHA, false).filter(
    (air) =>
      !air.border &&
      air.area >= HOLE_MIN_PIXELS &&
      air.area <= HOLE_MAX_PIXELS &&
      air.area <= body * HOLE_MAX_SHARE,
  );
  if (pockets.length > 0) {
    finding.holes = { count: pockets.length, area: pockets.reduce((sum, p) => sum + p.area, 0) };
  }
  return finding;
}

async function shrunk(raster: Raster): Promise<Raster> {
  const longest = Math.max(raster.width, raster.height);
  if (longest <= SHEET_ASSET_SIDE) return raster;
  const factor = SHEET_ASSET_SIDE / longest;
  return resizeRaster(
    raster,
    Math.max(1, Math.round(raster.width * factor)),
    Math.max(1, Math.round(raster.height * factor)),
  );
}

/**
 * 独立可用: every built asset has to work on its own, on any ground the engine puts it on. Looks
 * for three defects in the decoded alpha: a colour fringe on the antialiased edge (the asset was
 * cut with its old background still in the edge pixels), residue (a piece of the neighbour
 * touching the file's edge) and pinholes (small transparent pockets inside the body). Assets are
 * shown on a dark and a light ground, failing ones first.
 */
export async function runStandaloneGate(ctx: GateContext): Promise<GateRun> {
  const problems: GateProblem[] = [];
  const warnings: string[] = [];
  const failing: { name: string; raster: Raster }[] = [];
  const passing: { name: string; raster: Raster }[] = [];
  let scanned = 0;
  let skipped = 0;

  for (const record of ctx.manifest.assets) {
    const raster = await ctx.asset(record.name);
    const nodes = record.uses.map((use) => use.node);
    if (!raster) {
      // The resources gate reports a missing or unreadable file.
      skipped++;
      continue;
    }
    if (raster.width * raster.height > MAX_SCAN_PIXELS) {
      skipped++;
      warnings.push(
        `资产 ${record.name} 有 ${raster.width}×${raster.height} 像素，太大，不逐像素检查`,
      );
      continue;
    }
    scanned++;
    const finding = analyze(raster);
    const use = listNodes(nodes, 3);
    const add = (message: string, fix: string, metrics: Record<string, number>) => {
      problems.push({ ...(nodes[0] ? { node: nodes[0] } : {}), message, fix, metrics });
    };
    if (finding.fringe) {
      add(
        `资产 ${record.name}（用于 ${use}）的半透明边缘带着旧背景的颜色：${finding.fringe.wrong} 个边缘像素的颜色与旁边实体像素差距大，换个底色就会露出杂边`,
        `重新抠这个资产的边缘，去掉边缘像素里残留的底色；然后重新运行 ui-pro build`,
        { edgePixels: finding.fringe.count, wrong: finding.fringe.wrong },
      );
    }
    if (finding.residue) {
      add(
        `资产 ${record.name}（用于 ${use}）有 ${finding.residue.count} 块贴着文件边缘的残留（共 ${finding.residue.area} 像素），像是相邻元素的碎片`,
        `把残留抹掉：收紧这个节点的矩形，或在源图里标出排除区；然后重新运行 ui-pro build`,
        { pieces: finding.residue.count, area: finding.residue.area },
      );
    }
    if (finding.holes) {
      add(
        `资产 ${record.name}（用于 ${use}）的实体里有 ${finding.holes.count} 个小透明孔（共 ${finding.holes.area} 像素）`,
        `抠图时把高光或浅色误当成背景了；检查这个资产的抠图结果，补上孔洞后重新运行 ui-pro build`,
        { holes: finding.holes.count, area: finding.holes.area },
      );
    }
    (finding.fringe || finding.residue || finding.holes ? failing : passing).push({
      name: record.name,
      raster,
    });
  }

  const views: string[] = [];
  const shown = [...failing, ...passing.slice(0, Math.max(0, SHEET_EXTRA_ASSETS - failing.length))];
  if (shown.length > 0) {
    const cells: SheetCell[] = [];
    for (const { name, raster } of shown) {
      const image = await shrunk(raster);
      const bad = failing.some((entry) => entry.name === name);
      cells.push({ label: `${name}${bad ? '（有问题）' : ''}`, image, backdrop: DARK });
      cells.push({ label: '浅底', image, backdrop: LIGHT });
    }
    const sheet = composeSheet(cells, { columns: 6, gap: 6 });
    views.push(await ctx.writeView('standalone.png', sheet.png));
  }
  const view = views[0];
  if (view) for (const problem of problems) problem.view = view;

  const extra = scanned - shown.length;
  if (extra > 0) {
    warnings.push(`图里只放了 ${shown.length} 个资产（先放有问题的），其余 ${extra} 个通过了检查`);
  }

  return {
    result: gateResult('standalone', {
      metrics: {
        assets: ctx.manifest.assets.length,
        scanned,
        skipped,
        failed: failing.length,
        passRate: scanned === 0 ? 1 : round(1 - failing.length / scanned),
      },
      problems,
      warnings,
      views,
    }),
  };
}
