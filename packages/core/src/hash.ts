import { createHash } from 'node:crypto';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Hash of a file's content, or `null` for a file that does not exist. */
export function sha256OrNull(data: Uint8Array | null): string | null {
  return data === null ? null : sha256Hex(data);
}
