import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorCodes, UiProError } from '../errors';
import { writeFileAtomic } from '../fs/atomic';
import { readFileIfExists } from '../fs/files';
import { sha256Hex } from '../hash';
import type { Project } from '../project/project';
import { historyPaths } from './log';

function blobPath(project: Project, sha256: string): string {
  return join(historyPaths(project).blobs, sha256);
}

/** Stores content addressed by its hash and returns the hash. Existing blobs are left alone. */
export async function storeBlob(project: Project, content: Uint8Array): Promise<string> {
  const sha256 = sha256Hex(content);
  const path = blobPath(project, sha256);
  const exists = await access(path).then(
    () => true,
    () => false,
  );
  if (!exists) await writeFileAtomic(path, content);
  return sha256;
}

export async function readBlob(project: Project, sha256: string): Promise<Uint8Array> {
  const content = await readFileIfExists(blobPath(project, sha256));
  if (content === null) {
    throw new UiProError(ErrorCodes.io, `历史内容缺失：${sha256}`, {
      hint: '历史目录 history/blobs 被改动或不完整，无法还原该版本',
    });
  }
  return content;
}
