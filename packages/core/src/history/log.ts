import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ErrorCodes, ioError, UiProError } from '../errors';
import { readFileIfExistsSync } from '../fs/files';
import type { Project } from '../project/project';
import { parseWithSchema } from '../schema/codec';
import { Sha256Schema } from '../schema/common';

export const CHANGE_SOURCES = ['cli', 'studio', 'assistant', 'mcp'] as const;
export type ChangeSource = (typeof CHANGE_SOURCES)[number];

export const HistoryEntrySchema = z.strictObject({
  version: z.number().int().positive(),
  time: z.string(),
  source: z.enum(CHANGE_SOURCES),
  message: z.string(),
  ops: z.array(z.unknown()),
  /** Project-relative posix path -> content hashes before and after; `null` means no file. */
  docs: z.record(
    z.string(),
    z.strictObject({ before: Sha256Schema.nullable(), after: Sha256Schema.nullable() }),
  ),
  revertOf: z.number().int().positive().optional(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export function historyPaths(project: Project) {
  const dir = join(project.root, 'history');
  return { dir, log: join(dir, 'log.jsonl'), blobs: join(dir, 'blobs') };
}

export function readLog(project: Project): HistoryEntry[] {
  const bytes = readFileIfExistsSync(historyPaths(project).log);
  if (bytes === null) return [];
  const entries: HistoryEntry[] = [];
  bytes
    .toString('utf8')
    .split('\n')
    .forEach((line, index) => {
      if (line.trim() === '') return;
      const label = `history/log.jsonl:${index + 1}`;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch (cause) {
        throw new UiProError(ErrorCodes.docInvalid, `JSON 语法错误：${label}`, { cause });
      }
      entries.push(parseWithSchema(HistoryEntrySchema, raw, label));
    });
  return entries;
}

export async function appendLog(project: Project, entry: HistoryEntry): Promise<void> {
  const { dir, log } = historyPaths(project);
  try {
    await mkdir(dir, { recursive: true });
    await appendFile(log, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    throw ioError('追加历史记录', log, error);
  }
}
