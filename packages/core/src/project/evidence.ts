import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorCodes, ioError, UiProError } from '../errors';
import { isNodeError, readFileIfExistsSync } from '../fs/files';
import type { FileWrite } from '../history/commit';
import { SCREEN_FILES, screenRelDir, screenRelPath, toRelativePosix } from '../paths';
import { type CandidatesDoc, CandidatesDocSchema } from '../schema/candidates';
import { parseWithSchema } from '../schema/codec';
import type { Rect } from '../schema/common';
import { candidatesCodec } from './codecs';
import type { Project } from './project';
import { assertScreenName, loadScreen } from './screens';

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

export interface EvidenceFile {
  /** Posix path relative to the screen's `evidence/` directory. */
  path: string;
  content: Uint8Array;
}

/** A complete replacement of one screen's evidence directory. */
export interface EvidenceUpdate {
  candidates: CandidatesDoc;
  /** Files the candidates refer to (masks, layer renders). */
  files?: readonly EvidenceFile[];
}

const EVIDENCE_DIR = 'evidence';
const CANDIDATES_NAME = SCREEN_FILES.candidates.slice(EVIDENCE_DIR.length + 1);
const EVIDENCE_PATH_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

function invalidEvidence(screen: string, message: string): UiProError {
  return new UiProError(ErrorCodes.invariant, `界面 ${screen} 的证据不合法：${message}`);
}

/**
 * Validates an evidence update against its screen and returns the parsed candidates: the schema,
 * the source hash (evidence must describe the screen's current source file), file paths, and that
 * every mask a candidate names is among the files.
 */
export function checkEvidence(
  project: Project,
  screen: string,
  update: EvidenceUpdate,
): CandidatesDoc {
  const label = screenRelPath(assertScreenName(project, screen), 'candidates');
  const candidates = parseWithSchema(CandidatesDocSchema, update.candidates, label);
  const source = loadScreen(project, screen).source;
  if (candidates.sourceSha256 !== source.sha256) {
    throw invalidEvidence(screen, `sourceSha256 与源文件 ${source.file} 的哈希不一致`);
  }
  const files = new Set<string>();
  for (const file of update.files ?? []) {
    if (!EVIDENCE_PATH_PATTERN.test(file.path) || file.path === CANDIDATES_NAME) {
      throw invalidEvidence(screen, `文件路径 ${file.path} 不可用`);
    }
    if (files.has(file.path)) throw invalidEvidence(screen, `文件 ${file.path} 重复`);
    files.add(file.path);
  }
  for (const candidate of candidates.candidates) {
    if (candidate.mask !== undefined && !files.has(candidate.mask)) {
      throw invalidEvidence(
        screen,
        `候选 ${candidate.id} 的 mask ${candidate.mask} 不在随附文件里`,
      );
    }
  }
  return candidates;
}

async function listEvidenceFiles(root: string, dir: string): Promise<string[]> {
  const absolute = join(root, ...dir.split('/'));
  try {
    const entries = await readdir(absolute, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => toRelativePosix(absolute, join(entry.parentPath, entry.name)));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    throw ioError('读取证据目录', absolute, error);
  }
}

/** The writes that replace the screen's evidence directory with `candidates` and `files`. */
export async function evidenceWrites(
  project: Project,
  screen: string,
  candidates: CandidatesDoc,
  files: readonly EvidenceFile[] = [],
): Promise<FileWrite[]> {
  const dir = `${screenRelDir(screen)}/${EVIDENCE_DIR}`;
  const writes: FileWrite[] = [
    {
      path: screenRelPath(screen, 'candidates'),
      content: Buffer.from(candidatesCodec.serialize(candidates), 'utf8'),
    },
    ...files.map((file) => ({ path: `${dir}/${file.path}`, content: file.content })),
  ];
  const kept = new Set(writes.map((write) => write.path));
  for (const existing of await listEvidenceFiles(project.root, dir)) {
    const path = `${dir}/${existing}`;
    if (!kept.has(path)) writes.push({ path, content: null });
  }
  return writes;
}
