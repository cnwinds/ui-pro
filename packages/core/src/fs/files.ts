import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { ioError } from '../errors';

export function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

/** File contents, or `null` when the file does not exist. Other failures become `E_IO`. */
export async function readFileIfExists(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw ioError('读取文件', path, error);
  }
}

export function readFileIfExistsSync(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw ioError('读取文件', path, error);
  }
}
