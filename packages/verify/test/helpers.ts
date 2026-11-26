import type { Project } from '@ui-pro/core';
import {
  type AssetInit,
  createFixture,
  type Fixture,
  type FixtureInit,
  type NodeInit,
  paintedPng,
  type Rgba,
} from '../../renderer/test/fixtures';
import { type GateId, type GateResult, verifyScreen } from '../src';

export {
  type AssetInit,
  createFixture,
  type Fixture,
  type FixtureInit,
  type NodeInit,
  paintedPng,
  pixelAt,
  type Rgba,
  rawPng,
  solidPng,
  useTempDirs,
} from '../../renderer/test/fixtures';

/** Runs one gate and returns its result. */
export async function runGate(project: Project, screen: string, gate: GateId): Promise<GateResult> {
  const report = await verifyScreen(project, screen, { gates: [gate] });
  const result = report.gates[0];
  if (!result) throw new Error(`门禁 ${gate} 没有结果`);
  return result;
}

export const NAVY: Rgba = [34, 51, 85, 255];

/** The button's pixels: a red-to-dark horizontal gradient, so a copy of it correlates. */
export const gradient = (x: number, width = 80): Rgba => {
  const t = Math.min(1, x / width);
  return [Math.round(255 - 90 * t), Math.round(60 - 40 * t), Math.round(60 - 40 * t), 255];
};

export type Painter = (x: number, y: number) => Rgba;

/** A navy screen (200 x 120 unless `size`) with a gradient button (80 x 40 at 20, 20 unless `buttonRect`). */
export interface SceneOptions {
  size?: [number, number];
  buttonRect?: [number, number, number, number];
  /** What the background asset holds under the button; the default is navy (properly filled). */
  background?: Painter;
  /** Paints the reference image; the default is navy with the gradient button on it. */
  reference?: Painter;
  /** What the button asset holds. */
  button?: Painter;
  /** What the manifest says is only approximately right about the button asset. */
  buttonApproximations?: string[];
  /** The holes the manifest records for the background asset; the button kept by default. */
  backgroundHoles?: AssetInit['holes'];
  /** Extra decisions on the button node. */
  buttonDecisions?: NonNullable<NodeInit['decisions']>;
  nodes?: NodeInit[];
  assets?: AssetInit[];
  patch?: FixtureInit['patch'];
  mock?: unknown;
  fonts?: Record<string, string>;
}

export async function scene(
  makeDir: () => Promise<string>,
  options: SceneOptions = {},
): Promise<Fixture> {
  const [width, height] = options.size ?? [200, 120];
  const [bx, by, bw, bh] = options.buttonRect ?? [20, 20, 80, 40];
  const inButton = (x: number, y: number): boolean =>
    x >= bx && x < bx + bw && y >= by && y < by + bh;
  const reference =
    options.reference ??
    ((x: number, y: number): Rgba => (inButton(x, y) ? gradient(x - bx, bw) : NAVY));
  const background = options.background ?? (() => NAVY);
  const button = options.button ?? ((x: number) => gradient(x, bw));
  return createFixture(makeDir, {
    width,
    height,
    source: await paintedPng(width, height, reference),
    nodes: [
      { id: 'bg', type: 'image', rect: [0, 0, width, height], asset: 'bg' },
      {
        id: 'btn',
        type: 'button',
        rect: [bx, by, bw, bh],
        asset: 'btn',
        ...(options.buttonDecisions ? { decisions: options.buttonDecisions } : {}),
      },
      ...(options.nodes ?? []),
    ],
    assets: [
      {
        name: 'bg',
        png: await paintedPng(width, height, background),
        // What the default rules decide for a button on its background (and the no-drift check
        // compares the manifest with): the button's original pixels are kept.
        holes: options.backgroundHoles ?? [
          { node: 'btn', handling: 'kept', region: [bx, by, bw, bh] },
        ],
      },
      {
        name: 'btn',
        png: await paintedPng(bw, bh, button),
        ...(options.buttonApproximations ? { approximations: options.buttonApproximations } : {}),
      },
      ...(options.assets ?? []),
    ],
    ...(options.patch ? { patch: options.patch } : {}),
    ...(options.mock !== undefined ? { mock: options.mock } : {}),
    ...(options.fonts ? { fonts: options.fonts } : {}),
  });
}
