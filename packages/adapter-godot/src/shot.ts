import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { toPosix, UiProError } from '@ui-pro/core';
import sharp from 'sharp';
import { GodotErrorCodes } from './errors';
import { assertCleanRun, type GodotInstall, runGodot } from './godot';

/** A small window: the scene is drawn into an off-screen viewport of the design size. */
const WINDOW_SIZE = '320x240';

export interface ShotOptions {
  install: GodotInstall;
  /** Absolute path of the Godot project. */
  project: string;
  /** `res://` path of the scene. */
  scene: string;
  /** Absolute path of the PNG to write. */
  out: string;
  width: number;
  height: number;
  timeoutMs: number;
}

/**
 * Runs the scene once with a window and saves what it rendered. Headless mode does not render,
 * so this is the one step that opens a window, briefly.
 */
export async function takeShot(options: ShotOptions): Promise<{ ms: number }> {
  await mkdir(dirname(options.out), { recursive: true });
  await rm(options.out, { force: true });
  const { run, errors } = await runGodot(
    options.install,
    'shot',
    [
      '--resolution',
      WINDOW_SIZE,
      '--position',
      '0,0',
      '--path',
      options.project,
      '--script',
      'res://addons/ui_pro/shot.gd',
      '--',
      options.scene,
      options.out,
      String(options.width),
      String(options.height),
    ],
    options.timeoutMs,
  );
  assertCleanRun('shot', run, errors);
  if (!existsSync(options.out)) {
    throw new UiProError(GodotErrorCodes.run, `Godot 截图失败：没有生成 ${toPosix(options.out)}`, {
      details: { step: 'shot', output: `${run.stdout}\n${run.stderr}`.trim().slice(-1500) },
    });
  }
  return { ms: run.ms };
}

async function rgbPixels(
  image: string | Uint8Array,
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp(image)
    .flatten({ background: '#000000' })
    .removeAlpha()
    .resize(width, height, { fit: 'fill' })
    .raw()
    .toBuffer();
}

/** Mean absolute difference per RGB channel between two images, 0 (identical) to 1. */
export async function meanAbsDiff(
  a: string | Uint8Array,
  b: string | Uint8Array,
  width: number,
  height: number,
): Promise<number> {
  const [first, second] = await Promise.all([
    rgbPixels(a, width, height),
    rgbPixels(b, width, height),
  ]);
  let sum = 0;
  for (let i = 0; i < first.length; i++) sum += Math.abs((first[i] ?? 0) - (second[i] ?? 0));
  return sum / (first.length * 255);
}
