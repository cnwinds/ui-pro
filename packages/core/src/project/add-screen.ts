import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { ErrorCodes, UiProError } from '../errors';
import { withProjectLock } from '../fs/lock';
import { commitVersion, type FileWrite } from '../history/commit';
import type { ChangeSource } from '../history/log';
import { SCREEN_FILES, screenRelDir, screenRelPath } from '../paths';
import { ScreenNameSchema } from '../schema/common';
import type { ScreenDoc } from '../schema/screen';
import { serializeScreen } from '../screen/serialize';
import { createScreenDoc } from '../screen/tree';
import { INITIAL_BEHAVIOR, INITIAL_MOCK, INITIAL_SCREEN_RULES } from './codecs';
import type { Project } from './project';
import { inspectSource } from './source';

export interface AddScreenInput {
  name: string;
  /** Path to a flat image, a `.psd`, or a delivery package directory. */
  source: string;
}

export interface AddScreenResult {
  screen: ScreenDoc;
  version: number;
  /** Project-relative paths written, sorted. */
  files: string[];
}

const text = (content: string): Uint8Array => Buffer.from(content, 'utf8');

/**
 * Creates `screens/<name>/` from a source and records it as a history version.
 * The scale maps source pixels to the project's design resolution by width.
 */
export async function addScreen(
  project: Project,
  input: AddScreenInput,
  options: { source?: ChangeSource } = {},
): Promise<AddScreenResult> {
  const nameCheck = ScreenNameSchema.safeParse(input.name);
  if (!nameCheck.success) {
    throw new UiProError(ErrorCodes.nameInvalid, `界面名不合法：${input.name}`, {
      hint: '界面名以小写字母开头，只含小写字母、数字、下划线和连字符，最长 64 个字符',
    });
  }
  const name = nameCheck.data;
  const sourcePath = resolve(input.source);
  const inspected = await inspectSource(sourcePath);

  const scale = project.config.design.width / inspected.width;
  const screen = createScreenDoc({
    name,
    source: {
      kind: inspected.kind,
      file: `source/${inspected.entry}`,
      width: inspected.width,
      height: inspected.height,
      sha256: inspected.sha256,
    },
    scale,
    size: [Math.round(inspected.width * scale), Math.round(inspected.height * scale)],
  });

  const dir = screenRelDir(name);
  const writes: FileWrite[] = [
    { path: screenRelPath(name, 'doc'), content: text(serializeScreen(screen)) },
    { path: `${dir}/${SCREEN_FILES.behavior}`, content: text(INITIAL_BEHAVIOR) },
    { path: `${dir}/${SCREEN_FILES.rules}`, content: text(INITIAL_SCREEN_RULES) },
    { path: `${dir}/${SCREEN_FILES.mock}`, content: text(INITIAL_MOCK) },
    ...inspected.files.map((file) => ({
      path: `${dir}/source/${file.path}`,
      content: file.content,
    })),
  ];

  return withProjectLock(project.root, async () => {
    if (existsSync(join(project.root, dir, SCREEN_FILES.doc))) {
      throw new UiProError(ErrorCodes.screenExists, `界面 ${name} 已存在`, {
        hint: '换一个界面名，或先用 ui-pro history undo 撤销它',
      });
    }
    const entry = await commitVersion(project, {
      writes,
      source: options.source ?? 'cli',
      message: `新增界面 ${name}`,
      ops: [{ op: 'screen.add', name, source: basename(sourcePath) }],
    });
    if (!entry) throw new UiProError(ErrorCodes.invariant, `新增界面 ${name} 没有写入任何文件`);
    for (const sub of ['evidence', 'assets']) {
      await mkdir(join(project.root, dir, sub), { recursive: true });
    }
    return { screen, version: entry.version, files: Object.keys(entry.docs) };
  });
}
