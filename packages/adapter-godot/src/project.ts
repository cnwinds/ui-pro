import { existsSync, statSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { toPosix, UiProError, writeFileAtomic } from '@ui-pro/core';
import { GodotErrorCodes } from './errors';

export const GODOT_PROJECT_FILE = 'project.godot';

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
