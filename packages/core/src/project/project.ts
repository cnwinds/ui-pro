import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { ErrorCodes, ioError, UiProError } from '../errors';
import { writeFileAtomic } from '../fs/atomic';
import { readFileIfExists } from '../fs/files';
import { PROJECT_DIRS, PROJECT_FILES, SCRATCH_DIR, toPosix } from '../paths';
import {
  DEFAULT_DESIGN,
  type DesignSize,
  type ProjectConfig,
  ProjectConfigSchema,
} from '../schema/project';
import { glossaryCodec, INITIAL_PROJECT_RULES, projectConfigCodec } from './codecs';

export interface Project {
  /** Absolute project directory (native separators). */
  readonly root: string;
  /** Snapshot of `ui-pro.yaml` taken when the project was opened. */
  readonly config: ProjectConfig;
}

export interface CreateProjectOptions {
  name?: string;
  design?: DesignSize;
  engine?: ProjectConfig['engine'];
  egress?: ProjectConfig['egress'];
}

function isProjectDir(dir: string): boolean {
  return existsSync(join(dir, PROJECT_FILES.config));
}

/** Nearest directory at or above `startDir` that contains `ui-pro.yaml`. */
export function findProjectRoot(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    if (isProjectDir(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function notFound(where: string, explicit: boolean): UiProError {
  return new UiProError(
    ErrorCodes.projectNotFound,
    explicit
      ? `${toPosix(where)} 不是 ui-pro 工程（缺少 ui-pro.yaml）`
      : '当前目录及其上级都不是 ui-pro 工程',
    { hint: '先运行 ui-pro init 创建工程，或用 --project 指定工程目录' },
  );
}

export function loadProject(root: string): Project {
  const path = join(root, PROJECT_FILES.config);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw ioError('读取工程配置', path, error);
  }
  return { root, config: projectConfigCodec.parse(text, PROJECT_FILES.config) };
}

/** Opens `dir` when given, otherwise the project found by walking up from `cwd`. */
export function openProject(dir: string | undefined, cwd: string): Project {
  if (dir !== undefined) {
    const root = resolve(cwd, dir);
    if (!isProjectDir(root)) throw notFound(root, true);
    return loadProject(root);
  }
  const root = findProjectRoot(cwd);
  if (root === undefined) throw notFound(cwd, false);
  return loadProject(root);
}

async function ensureGitignore(root: string): Promise<void> {
  const path = join(root, PROJECT_FILES.gitignore);
  const entry = `${SCRATCH_DIR}/`;
  const existing = (await readFileIfExists(path))?.toString('utf8');
  if (existing === undefined) {
    await writeFileAtomic(path, `${entry}\n`);
  } else if (!existing.split(/\r?\n/).includes(entry)) {
    const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
    await writeFileAtomic(path, `${existing}${separator}${entry}\n`);
  }
}

export async function createProject(
  dir: string,
  options: CreateProjectOptions = {},
): Promise<Project> {
  const root = resolve(dir);
  if (existsSync(root) && !statSync(root).isDirectory()) {
    throw new UiProError(ErrorCodes.io, `${toPosix(root)} 已存在且不是目录`);
  }
  if (isProjectDir(root)) {
    throw new UiProError(ErrorCodes.projectExists, `${toPosix(root)} 已经是 ui-pro 工程`, {
      hint: '要新增界面，请在工程内运行 ui-pro init --screen <name> --source <file>',
    });
  }

  const config = ProjectConfigSchema.parse({
    format: 'ui-pro/project',
    version: 1,
    name: options.name ?? basename(root),
    design: options.design ?? DEFAULT_DESIGN,
    engine: options.engine ?? 'godot',
    egress: options.egress ?? 'cloud',
  });
  const glossary = { format: 'ui-pro/glossary' as const, version: 1 as const, concepts: [] };

  for (const sub of [...PROJECT_DIRS, SCRATCH_DIR])
    await mkdir(join(root, sub), { recursive: true });
  await writeFileAtomic(join(root, PROJECT_FILES.glossary), glossaryCodec.serialize(glossary));
  await writeFileAtomic(join(root, PROJECT_FILES.projectRules), INITIAL_PROJECT_RULES);
  await ensureGitignore(root);
  // Written last: its presence is what makes the directory a project.
  await writeFileAtomic(join(root, PROJECT_FILES.config), projectConfigCodec.serialize(config));
  return { root, config };
}
