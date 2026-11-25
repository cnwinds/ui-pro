import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ErrorCodes, ioError, UiProError } from '../errors';
import { isNodeError, readFileIfExistsSync } from '../fs/files';
import { SCREEN_FILES, screenRelPath } from '../paths';
import { SCREEN_NAME_PATTERN } from '../schema/common';
import type { ScreenDoc } from '../schema/screen';
import { parseScreen } from '../screen/serialize';
import type { Project } from './project';

/** Names of the screens that have a `screen.uir.json`, sorted. */
export function listScreens(project: Project): string[] {
  const dir = join(project.root, 'screens');
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SCREEN_NAME_PATTERN.test(entry.name))
      .filter((entry) => existsSync(join(dir, entry.name, SCREEN_FILES.doc)))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    throw ioError('列出界面', dir, error);
  }
}

export function screenNotFoundError(project: Project, name: string): UiProError {
  const screens = listScreens(project);
  return new UiProError(ErrorCodes.screenNotFound, `没有界面 ${name}`, {
    hint:
      screens.length > 0
        ? `现有界面：${screens.join('、')}`
        : '项目里还没有界面，用 ui-pro init --screen <name> --source <file> 添加',
    details: { screens },
  });
}

/** Rejects names that are not valid screen names before they are used to build paths. */
export function assertScreenName(project: Project, name: string): string {
  if (!SCREEN_NAME_PATTERN.test(name)) throw screenNotFoundError(project, name);
  return name;
}

export function loadScreen(project: Project, name: string): ScreenDoc {
  const path = screenRelPath(assertScreenName(project, name), 'doc');
  const bytes = readFileIfExistsSync(join(project.root, ...path.split('/')));
  if (bytes === null) throw screenNotFoundError(project, name);
  return parseScreen(bytes.toString('utf8'), path);
}

/**
 * The screen a command applies to: `requested` when given (must exist), otherwise the only
 * screen when there is exactly one, otherwise `undefined`.
 */
export function defaultScreen(project: Project, requested?: string): string | undefined {
  const screens = listScreens(project);
  if (requested !== undefined) {
    if (!screens.includes(requested)) throw screenNotFoundError(project, requested);
    return requested;
  }
  return screens.length === 1 ? screens[0] : undefined;
}
