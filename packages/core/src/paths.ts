import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ErrorCodes, UiProError } from './errors';

/** Absolute path with forward slashes, the form used in every CLI output. */
export function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/** Resolves a project-relative posix path against `root`; refuses to leave the project. */
export function resolveInside(root: string, relPath: string): string {
  const absolute = resolve(root, ...relPath.split('/'));
  const fromRoot = relative(root, absolute);
  const escapes = fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
  if (fromRoot === '' || escapes) {
    throw new UiProError(ErrorCodes.invariant, `路径越出项目目录：${relPath}`);
  }
  return absolute;
}

export function toRelativePosix(root: string, absolute: string): string {
  return toPosix(relative(root, absolute));
}

export const PROJECT_FILES = {
  config: 'ui-pro.yaml',
  glossary: 'glossary.yaml',
  projectRules: 'rules/project.yaml',
  gitignore: '.gitignore',
  lock: 'ui-pro.lock',
  /** Append-only record of every image sent to a cloud service (DESIGN §6.6 constraint 8). */
  egress: 'history/egress.jsonl',
} as const;

export const PROJECT_DIRS = ['kit', 'rules', 'screens', 'resources', 'export', 'history'] as const;

/** Runtime scratch directory (look images, lock, selection); never versioned. */
export const SCRATCH_DIR = '.ui-pro';

export const SCREEN_FILES = {
  doc: 'screen.uir.json',
  behavior: 'behavior.yaml',
  rules: 'rules.yaml',
  mock: 'mock.json',
  candidates: 'evidence/candidates.json',
  assets: 'assets/manifest.json',
} as const;

/** Locked model outputs under a screen's `assets/`; builds add to it and never delete from it. */
export const GENERATED_DIR = 'gen';

export function screenRelDir(screen: string): string {
  return `screens/${screen}`;
}

export function screenRelPath(screen: string, file: keyof typeof SCREEN_FILES): string {
  return `${screenRelDir(screen)}/${SCREEN_FILES[file]}`;
}

export function scratchPath(root: string, ...segments: string[]): string {
  return join(root, SCRATCH_DIR, ...segments);
}
