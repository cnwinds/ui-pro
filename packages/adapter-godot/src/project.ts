import { existsSync, statSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readFileIfExists, toPosix, UiProError, writeFileAtomic } from '@ui-pro/core';
import { GodotErrorCodes } from './errors';

export const GODOT_PROJECT_FILE = 'project.godot';

/**
 * How a new Godot project scales its window (spec 12): `canvas_items` stretches the UI with the
 * window, `expand` keeps the aspect ratio of the design size and gives the extra room to the
 * anchored nodes. The viewport matrix of the adaptation gate assumes these two.
 */
export const STRETCH_MODE = 'canvas_items';
export const STRETCH_ASPECT = 'expand';

/** The display settings of a Godot project the tool cares about; `undefined` when not set. */
export interface GodotDisplaySettings {
  width?: number;
  height?: number;
  stretchMode?: string;
  stretchAspect?: string;
}

/** Reads the `[display]` section of a `project.godot` text. */
export function parseDisplaySettings(text: string): GodotDisplaySettings {
  const values = new Map<string, string>();
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const header = /^\[([^\]]+)\]\s*$/.exec(line.trim());
    if (header) {
      section = header[1] ?? '';
      continue;
    }
    const pair = /^([\w/.]+)\s*=\s*(.*)$/.exec(line.trim());
    if (section === 'display' && pair) values.set(pair[1] ?? '', (pair[2] ?? '').trim());
  }
  const text_ = (key: string): string | undefined => values.get(key)?.replace(/^"(.*)"$/, '$1');
  const number = (key: string): number | undefined => {
    const value = Number(text_(key));
    return Number.isFinite(value) && text_(key) !== undefined ? value : undefined;
  };
  return {
    width: number('window/size/viewport_width'),
    height: number('window/size/viewport_height'),
    stretchMode: text_('window/stretch/mode'),
    stretchAspect: text_('window/stretch/aspect'),
  };
}

/** The display settings of the Godot project in `dir`, or `undefined` when it has no `project.godot`. */
export async function readDisplaySettings(dir: string): Promise<GodotDisplaySettings | undefined> {
  const text = await readFileIfExists(join(dir, GODOT_PROJECT_FILE));
  return text === null ? undefined : parseDisplaySettings(text.toString('utf8'));
}

export interface NewGodotProject {
  name: string;
  /** The design resolution; becomes the viewport size. */
  width: number;
  height: number;
}

function projectFileText(project: NewGodotProject): string {
  const name = project.name.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `; Engine configuration file.
config_version=5

[application]

config/name="${name}"
config/features=PackedStringArray("4.6", "GL Compatibility")

[display]

window/size/viewport_width=${project.width}
window/size/viewport_height=${project.height}
window/stretch/mode="${STRETCH_MODE}"
window/stretch/aspect="${STRETCH_ASPECT}"

[rendering]

renderer/rendering_method="gl_compatibility"
renderer/rendering_method.mobile="gl_compatibility"
`;
}

export interface PreparedTarget {
  /** Whether a new Godot project was created in the directory. */
  created: boolean;
  /** Project-relative paths written while creating it. */
  files: string[];
}

/**
 * Whether `dir` already is a Godot project (`existing`) or may become one (`empty`: missing or
 * empty). Anything else is refused so no foreign files end up mixed with exports. Writes nothing.
 */
export async function inspectGodotTarget(dir: string): Promise<'existing' | 'empty'> {
  if (!existsSync(dir)) return 'empty';
  if (!statSync(dir).isDirectory()) {
    throw new UiProError(GodotErrorCodes.badTarget, `${toPosix(dir)} 已存在，但不是目录`, {
      hint: '用 --to 指定一个目录',
    });
  }
  if (existsSync(join(dir, GODOT_PROJECT_FILE))) return 'existing';
  if ((await readdir(dir)).length > 0) {
    throw new UiProError(
      GodotErrorCodes.badTarget,
      `${toPosix(dir)} 不是空目录，也没有 ${GODOT_PROJECT_FILE}，不能当作 Godot 工程`,
      { hint: '换一个空目录，或指向已有的 Godot 工程（含 project.godot 的目录）' },
    );
  }
  return 'empty';
}

/**
 * Makes `dir` a usable Godot project. A missing or empty directory gets a minimal one
 * (compatibility renderer, viewport = design resolution); an existing Godot project is left
 * exactly as it is, since the tool never changes a project's settings.
 */
export async function prepareGodotProject(
  dir: string,
  init: NewGodotProject,
): Promise<PreparedTarget> {
  if ((await inspectGodotTarget(dir)) === 'existing') return { created: false, files: [] };
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(join(dir, GODOT_PROJECT_FILE), projectFileText(init));
  await writeFileAtomic(join(dir, '.gitignore'), '.godot/\n');
  return { created: true, files: [GODOT_PROJECT_FILE, '.gitignore'] };
}
