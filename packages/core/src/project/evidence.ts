import { join } from 'node:path';
import { readFileIfExistsSync } from '../fs/files';
import { screenRelPath } from '../paths';
import type { CandidatesDoc } from '../schema/candidates';
import type { Rect } from '../schema/common';
import { candidatesCodec } from './codecs';
import type { Project } from './project';
import { assertScreenName } from './screens';

/** The screen's candidate evidence, or `null` before analysis has produced it. */
export function readCandidates(project: Project, screen: string): CandidatesDoc | null {
  const path = screenRelPath(assertScreenName(project, screen), 'candidates');
  const bytes = readFileIfExistsSync(join(project.root, ...path.split('/')));
  return bytes === null ? null : candidatesCodec.parse(bytes.toString('utf8'), path);
}

/** Converts a rectangle from source pixels to design-space pixels. */
export function sourceToDesign(rect: Rect, scale: number): Rect {
  const [x, y, w, h] = rect;
  return [x * scale, y * scale, w * scale, h * scale];
}

/** Rounds every component to `decimals` places, removing floating-point noise. */
export function roundRect(rect: Rect, decimals = 2): Rect {
  const factor = 10 ** decimals;
  const round = (value: number) => Math.round(value * factor) / factor;
  return [round(rect[0]), round(rect[1]), round(rect[2]), round(rect[3])];
}
