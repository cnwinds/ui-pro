import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorCodes, ioError, UiProError } from '../errors';
import { isNodeError, readFileIfExistsSync } from '../fs/files';
import type { FileWrite } from '../history/commit';
import {
  GENERATED_DIR,
  PROJECT_FILES,
  SCREEN_FILES,
  screenRelDir,
  screenRelPath,
  toRelativePosix,
} from '../paths';
import {
  type AssetManifest,
  AssetManifestSchema,
  type LockDoc,
  LockDocSchema,
} from '../schema/assets';
import { parseWithSchema } from '../schema/codec';
import { assetManifestCodec, lockCodec } from './codecs';
import type { Project } from './project';
import { assertScreenName, loadScreen } from './screens';

const ASSETS_DIR = 'assets';
const MANIFEST_NAME = SCREEN_FILES.assets.slice(ASSETS_DIR.length + 1);
const ASSET_PATH_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

export interface AssetFile {
  /** Posix path relative to the screen's `assets/` directory. */
  path: string;
  content: Uint8Array;
}

/** One build's result for a screen, committed in the same version as the ops that bind it. */
export interface AssetUpdate {
  manifest: AssetManifest;
  /** Every asset file the manifest names outside `gen/`; replaces all such files on disk. */
  files: readonly AssetFile[];
  /** New locked model outputs, all under `gen/`. Existing ones stay; builds never delete them. */
  generated?: readonly AssetFile[];
}

/** Project-relative path of a file in the screen's `assets/` directory. */
export function assetRelPath(screen: string, path: string): string {
  return `${screenRelDir(screen)}/${ASSETS_DIR}/${path}`;
}

/** The screen's asset manifest, or `null` before the first build. */
export function readAssetManifest(project: Project, screen: string): AssetManifest | null {
  const path = screenRelPath(assertScreenName(project, screen), 'assets');
  const bytes = readFileIfExistsSync(join(project.root, ...path.split('/')));
  return bytes === null ? null : assetManifestCodec.parse(bytes.toString('utf8'), path);
}

/** The asset file's bytes, or `null` when it is missing. */
export function readAssetFile(project: Project, screen: string, path: string): Uint8Array | null {
  const rel = assetRelPath(assertScreenName(project, screen), path);
  return readFileIfExistsSync(join(project.root, ...rel.split('/')));
}

const EMPTY_LOCK = (tool: string): LockDoc => ({
  format: 'ui-pro/lock',
  version: 1,
  tool,
  models: {},
  generated: {},
});

/** `ui-pro.lock`, or an empty lock stamped with `tool` when the project has none yet. */
export function readLock(project: Project, tool = '0.0.0'): LockDoc {
  const bytes = readFileIfExistsSync(join(project.root, PROJECT_FILES.lock));
  return bytes === null
    ? EMPTY_LOCK(tool)
    : lockCodec.parse(bytes.toString('utf8'), PROJECT_FILES.lock);
}

function invalidAssets(screen: string, message: string): UiProError {
  return new UiProError(ErrorCodes.invariant, `界面 ${screen} 的资产不合法：${message}`);
}

function isGenerated(path: string): boolean {
  return path.startsWith(`${GENERATED_DIR}/`);
}

/**
 * Validates a build result against its screen: the manifest schema, that it describes this screen
 * and its current source, file paths, and that every file a record names is among the files.
 */
export function checkAssets(project: Project, screen: string, update: AssetUpdate): AssetManifest {
  const label = screenRelPath(assertScreenName(project, screen), 'assets');
  const manifest = parseWithSchema(AssetManifestSchema, update.manifest, label);
  if (manifest.screen !== screen) {
    throw invalidAssets(screen, `清单写的是界面 ${manifest.screen}`);
  }
  const source = loadScreen(project, screen).source;
  if (manifest.sourceSha256 !== source.sha256) {
    throw invalidAssets(screen, `sourceSha256 与源文件 ${source.file} 的哈希不一致`);
  }
  const files = new Set<string>();
  const add = (path: string, generated: boolean) => {
    if (!ASSET_PATH_PATTERN.test(path) || path === MANIFEST_NAME) {
      throw invalidAssets(screen, `文件路径 ${path} 不可用`);
    }
    if (isGenerated(path) !== generated) {
      throw invalidAssets(
        screen,
        generated
          ? `模型输出 ${path} 必须放在 ${GENERATED_DIR}/ 下`
          : `资产文件 ${path} 不能放在 ${GENERATED_DIR}/ 下`,
      );
    }
    if (files.has(path)) throw invalidAssets(screen, `文件 ${path} 重复`);
    files.add(path);
  };
  for (const file of update.files) add(file.path, false);
  for (const file of update.generated ?? []) add(file.path, true);
  for (const asset of manifest.assets) {
    if (!files.has(asset.file)) {
      throw invalidAssets(screen, `资产 ${asset.name} 的文件 ${asset.file} 不在随附文件里`);
    }
  }
  return manifest;
}

/**
 * Validates a new lock: every locked output must exist, on disk or among the generated files
 * committed with it (`pending`, project-relative paths).
 */
export function checkLock(project: Project, lock: LockDoc, pending: ReadonlySet<string>): LockDoc {
  const parsed = parseWithSchema(LockDocSchema, lock, PROJECT_FILES.lock);
  for (const [key, entry] of Object.entries(parsed.generated)) {
    for (const file of [entry.file, ...entry.alternatives.map((alternative) => alternative.file)]) {
      const exists =
        pending.has(file) || readFileIfExistsSync(join(project.root, ...file.split('/'))) !== null;
      if (!exists) {
        throw new UiProError(
          ErrorCodes.invariant,
          `锁文件不合法：${key} 指向的模型输出 ${file} 不存在`,
        );
      }
    }
  }
  return parsed;
}

async function listAssetFiles(root: string, dir: string): Promise<string[]> {
  const absolute = join(root, ...dir.split('/'));
  try {
    const entries = await readdir(absolute, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => toRelativePosix(absolute, join(entry.parentPath, entry.name)));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    throw ioError('读取资产目录', absolute, error);
  }
}

/** The writes that replace the screen's built assets and add its new locked model outputs. */
export async function assetWrites(
  project: Project,
  screen: string,
  manifest: AssetManifest,
  update: AssetUpdate,
): Promise<FileWrite[]> {
  const writes: FileWrite[] = [
    {
      path: screenRelPath(screen, 'assets'),
      content: Buffer.from(assetManifestCodec.serialize(manifest), 'utf8'),
    },
    ...update.files.map((file) => ({
      path: assetRelPath(screen, file.path),
      content: file.content,
    })),
    ...(update.generated ?? []).map((file) => ({
      path: assetRelPath(screen, file.path),
      content: file.content,
    })),
  ];
  const kept = new Set(writes.map((write) => write.path));
  const dir = `${screenRelDir(screen)}/${ASSETS_DIR}`;
  for (const existing of await listAssetFiles(project.root, dir)) {
    const path = `${dir}/${existing}`;
    if (!isGenerated(existing) && !kept.has(path)) writes.push({ path, content: null });
  }
  return writes;
}

export function lockWrite(lock: LockDoc): FileWrite {
  return { path: PROJECT_FILES.lock, content: Buffer.from(lockCodec.serialize(lock), 'utf8') };
}
